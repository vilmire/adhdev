import { describe, expect, it, vi } from 'vitest';
import { meshEventsHandlers } from '../../src/commands/high-family/mesh-events.js';

// RC.20 STALE-PROMPT-ANSWER VISIBILITY (coordinator-facing boundary).
//
// After a daemon restart the rebound worker re-captures its parked picker under
// a content-stable promptId. A coordinator still holding the PRE-RESTART id must
// get a VISIBLE rejection from mesh_answer_question — not the old success:true +
// daemon-log-only drop, which left it believing the question was answered while
// the picker stayed parked. The rejection names the active promptId so the
// caller can re-answer, and NOTHING is applied or defaulted.

const HELD_PROMPT = {
    promptId: 'ask-user-tui-deadbeef',
    origin: 'cli',
    providerType: 'claude-cli',
    createdAt: 1,
    questions: [{ questionId: 'q1', question: 'Pick a track', multiSelect: false, options: [{ label: 'ALPHA' }, { label: 'BETA' }] }],
};

function makeCtx(heldPrompt: unknown) {
    const sendEvent = vi.fn();
    const instance = {
        getState: () => ({
            activeChat: { activeInteractivePrompt: heldPrompt },
            activeInteractivePrompt: heldPrompt,
        }),
    };
    const ctx = {
        deps: {
            instanceManager: {
                getInstance: () => instance,
                sendEvent,
            },
        },
    } as any;
    return { ctx, sendEvent };
}

describe('interactive_prompt_response handler — stale promptId rejection (rc.20)', () => {
    it('rejects an answer against a stale (pre-restart) promptId WITHOUT delivering it, naming the active promptId', async () => {
        const { ctx, sendEvent } = makeCtx(HELD_PROMPT);
        const result = await meshEventsHandlers.interactive_prompt_response(ctx, {
            targetSessionId: 'sessW',
            response: {
                promptId: 'ask-user-oldsession-1722100000000',
                answers: [{ select: 2 }],
            },
        });

        expect(result.success).toBe(false);
        expect(result.waitingChoice).toBe(true);
        expect(result.promptId).toBe('ask-user-tui-deadbeef');
        expect(result.stalePromptId).toBe('ask-user-oldsession-1722100000000');
        expect(String(result.error)).toContain('ask-user-tui-deadbeef');
        // Fail closed: the answer NEVER reaches the instance.
        expect(sendEvent).not.toHaveBeenCalled();
    });

    it('delivers an answer against the active promptId (friendly array form forwarded raw)', async () => {
        const { ctx, sendEvent } = makeCtx(HELD_PROMPT);
        const result = await meshEventsHandlers.interactive_prompt_response(ctx, {
            targetSessionId: 'sessW',
            response: {
                promptId: 'ask-user-tui-deadbeef',
                answers: [{ select: 'BETA' }],
            },
        });

        expect(result.success).toBe(true);
        expect(sendEvent).toHaveBeenCalledTimes(1);
        expect(sendEvent.mock.calls[0][0]).toBe('sessW');
        expect(sendEvent.mock.calls[0][1]).toBe('interactive_prompt_response');
        expect(sendEvent.mock.calls[0][2].answers).toEqual([{ select: 'BETA' }]);
    });

    it('delivers the strict keyed form against the active promptId (dashboard local answers)', async () => {
        const { ctx, sendEvent } = makeCtx(HELD_PROMPT);
        const result = await meshEventsHandlers.interactive_prompt_response(ctx, {
            targetSessionId: 'sessW',
            response: {
                promptId: 'ask-user-tui-deadbeef',
                answers: { q1: { selectedLabels: ['BETA'] } },
            },
        });

        expect(result.success).toBe(true);
        expect(sendEvent).toHaveBeenCalledTimes(1);
        expect(sendEvent.mock.calls[0][2].answers.q1.selectedLabels).toEqual(['BETA']);
    });

    it('stays lenient when the session holds NO prompt (legacy/idempotent path unchanged)', async () => {
        const { ctx, sendEvent } = makeCtx(null);
        const result = await meshEventsHandlers.interactive_prompt_response(ctx, {
            targetSessionId: 'sessW',
            response: {
                promptId: 'ask-user-tui-deadbeef',
                answers: { q1: { selectedLabels: ['BETA'] } },
            },
        });

        expect(result.success).toBe(true);
        expect(sendEvent).toHaveBeenCalledTimes(1);
    });
});
