import { describe, expect, it, vi } from 'vitest';
import { meshEventsHandlers } from '../../src/commands/high-family/mesh-events.js';

// SILENT-SUCCESS DEFECT (2026-08-20 live): mesh_answer_question returned
// success:true while the worker sat in awaiting_choice for ~5 minutes — the
// prompt was never submitted.
//
// Root cause: the handler did `sendEvent(...)` (fire-and-forget, returns void)
// and then `return { success: true }` UNCONDITIONALLY. Every failure that can
// occur downstream — an unknown option label (resolveInteractivePromptResponse
// THROWS), an adapter without setInteractivePromptResponse, a provider scheme
// with no answer path, a rejected key injection — was caught and written to the
// daemon log only. The coordinator trusts the return value and moves on.
//
// These tests pin the fix: the handler now awaits the instance's
// applyInteractivePromptResponse and reports what actually happened, returning
// success:false WITH the live option list when the answer cannot be applied.

const HELD_PROMPT = {
    promptId: 'ask-user-tui-deadbeef',
    origin: 'cli',
    providerType: 'claude-cli',
    createdAt: 1,
    questions: [{
        questionId: 'q1',
        question: 'Where should it go?',
        multiSelect: false,
        options: [{ label: 'Append at the end' }, { label: 'Insert at the top' }],
    }],
};

/**
 * An instance exposing the awaitable answer path, backed by a fake adapter so
 * we can assert on what actually reached the "PTY".
 */
function makeVerifiedCtx(opts: { heldPrompt?: any; injectionError?: Error } = {}) {
    const heldPrompt = 'heldPrompt' in opts ? opts.heldPrompt : HELD_PROMPT;
    const applied: any[] = [];
    const sendEvent = vi.fn();

    const instance = {
        getState: () => ({ activeInteractivePrompt: heldPrompt }),
        describeActiveInteractivePrompt: () => (heldPrompt
            ? {
                promptId: heldPrompt.promptId,
                questions: heldPrompt.questions.map((q: any) => ({
                    questionId: q.questionId,
                    question: q.question,
                    multiSelect: q.multiSelect,
                    options: q.options.map((o: any) => o.label),
                })),
            }
            : null),
        applyInteractivePromptResponse: async (data: any) => {
            if (!heldPrompt) throw new Error('No active interactive prompt for this session — nothing to answer.');
            const entries: any[] = Array.isArray(data?.answers) ? data.answers : [];
            const answers: Record<string, { selectedLabels: string[] }> = {};
            entries.forEach((entry, index) => {
                const question = heldPrompt.questions[index];
                const sel = entry.select;
                const label = typeof sel === 'number'
                    ? question.options[sel - 1]?.label
                    : question.options.find((o: any) => o.label === sel)?.label;
                // The real resolver THROWS here — that throw is exactly what
                // used to be swallowed into a success:true.
                if (!label) throw new Error(`Unknown option for ${question.questionId}: ${sel}`);
                answers[question.questionId] = { selectedLabels: [label] };
            });
            if (opts.injectionError) throw opts.injectionError;
            applied.push(answers);
            return { promptId: heldPrompt.promptId, answers };
        },
    };

    const ctx = {
        deps: { instanceManager: { getInstance: () => instance, sendEvent } },
    } as any;
    return { ctx, applied, sendEvent };
}

describe('interactive_prompt_response — verified submit (no silent success)', () => {
    it('★an unmatched option label FAILS instead of reporting success, and returns the live options', async () => {
        const { ctx, applied } = makeVerifiedCtx();
        const result = await meshEventsHandlers.interactive_prompt_response(ctx, {
            targetSessionId: 'sessW',
            response: {
                promptId: 'ask-user-tui-deadbeef',
                // Close to, but not exactly, the on-screen label.
                answers: [{ select: 'Append at end' }],
            },
        });

        expect(result.success).toBe(false);
        expect(result.submitted).toBe(false);
        expect(String(result.error)).toContain('Unknown option');
        // The coordinator gets the REAL options so it can retry correctly.
        expect(result.activePrompt.questions[0].options).toEqual(['Append at the end', 'Insert at the top']);
        expect(result.waitingChoice).toBe(true);
        expect(applied).toHaveLength(0);
    });

    it('an exact label answer succeeds and reports submitted:true with the resolved answers', async () => {
        const { ctx, applied } = makeVerifiedCtx();
        const result = await meshEventsHandlers.interactive_prompt_response(ctx, {
            targetSessionId: 'sessW',
            response: { promptId: 'ask-user-tui-deadbeef', answers: [{ select: 'Append at the end' }] },
        });

        expect(result.success).toBe(true);
        expect(result.submitted).toBe(true);
        expect(result.answers.q1.selectedLabels).toEqual(['Append at the end']);
        expect(applied).toHaveLength(1);
    });

    it('a 1-based index answer resolves to the same option as its label', async () => {
        const { ctx } = makeVerifiedCtx();
        const result = await meshEventsHandlers.interactive_prompt_response(ctx, {
            targetSessionId: 'sessW',
            response: { promptId: 'ask-user-tui-deadbeef', answers: [{ select: 1 }] },
        });

        expect(result.success).toBe(true);
        expect(result.submitted).toBe(true);
        expect(result.answers.q1.selectedLabels).toEqual(['Append at the end']);
    });

    it('★a failed key injection FAILS instead of being swallowed by void .catch(log)', async () => {
        const { ctx } = makeVerifiedCtx({ injectionError: new Error('pty write failed') });
        const result = await meshEventsHandlers.interactive_prompt_response(ctx, {
            targetSessionId: 'sessW',
            response: { promptId: 'ask-user-tui-deadbeef', answers: [{ select: 'Append at the end' }] },
        });

        expect(result.success).toBe(false);
        expect(result.submitted).toBe(false);
        expect(String(result.error)).toContain('pty write failed');
    });

    it('answering a session that holds NO prompt fails loudly rather than reporting success', async () => {
        const { ctx } = makeVerifiedCtx({ heldPrompt: null });
        const result = await meshEventsHandlers.interactive_prompt_response(ctx, {
            targetSessionId: 'sessW',
            response: { promptId: 'ask-user-tui-deadbeef', answers: [{ select: 1 }] },
        });

        expect(result.success).toBe(false);
        expect(result.submitted).toBe(false);
        expect(String(result.error)).toContain('No active interactive prompt');
    });

    it('a legacy instance without the awaitable path still delivers, but does NOT claim submitted', async () => {
        const sendEvent = vi.fn();
        const ctx = {
            deps: {
                instanceManager: {
                    getInstance: () => ({ getState: () => ({ activeInteractivePrompt: HELD_PROMPT }) }),
                    sendEvent,
                },
            },
        } as any;

        const result = await meshEventsHandlers.interactive_prompt_response(ctx, {
            targetSessionId: 'sessW',
            response: { promptId: 'ask-user-tui-deadbeef', answers: [{ select: 'Append at the end' }] },
        });

        // Back-compat: still delivered and still success:true...
        expect(result.success).toBe(true);
        expect(sendEvent).toHaveBeenCalledTimes(1);
        // ...but the response is HONEST that submission was not verified.
        expect(result.submitted).toBe(false);
        expect(String(result.note)).toContain('could not be verified');
    });
});
