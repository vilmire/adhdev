/**
 * ASKUSERQUESTION-NOT-APPROVAL / REMOTE-ANSWER-PICKER-PARSE: pins the exact
 * classification runStatusTransitionTick's isQuestionPicker computes.
 *
 * interactivePrompt=null is the state a parse failure leaves behind (the
 * daemon-side TUI/spec parser could not turn the captured screen into a
 * structured InteractivePrompt — see fsm-evaluator-claude-checkbox-picker.test
 * and interactive-prompt.test's footer-drift-fallback coverage for the parser
 * side of this same bug). This test pins the CONSEQUENCE one layer up: with no
 * captured prompt, a picker-kind modal must still fall back to waiting_approval
 * (there is nothing else it CAN classify as), and — the fix's target state —
 * once a prompt IS captured, the identical picker-kind modal classifies as
 * waiting_choice instead.
 */

import { describe, expect, it } from 'vitest';
import { runStatusTransitionTick, type StatusTransitionHost } from '../../../src/providers/completion/status-transition.js';
import type { ProviderModule } from '../../../src/providers/contracts.js';
import type { InteractivePrompt } from '../../../src/providers/types/interactive-prompt.js';

const PROVIDER: ProviderModule = {
    type: 'claude-cli',
    name: 'Claude Code',
    category: 'cli',
} as ProviderModule;

const SAMPLE_PROMPT: InteractivePrompt = {
    promptId: 'q1',
    origin: 'cli',
    providerType: 'claude-cli',
    createdAt: 0,
    questions: [{
        questionId: 'q1',
        question: 'Pick as many as apply',
        multiSelect: true,
        options: [{ label: 'Alpha' }, { label: 'Beta' }],
    }],
};

function makeHost(opts: {
    rawStatus: string;
    activeInteractivePrompt: InteractivePrompt | null;
    activeModalKind: 'picker' | 'approval' | null;
}): { host: StatusTransitionHost & Record<string, unknown>; pushed: unknown[] } {
    const pushed: unknown[] = [];
    const host: StatusTransitionHost & Record<string, unknown> = {
        type: 'claude-cli',
        instanceId: 'inst-1',
        workingDir: '/work/adhdev',
        provider: PROVIDER,
        adapter: {
            getStatus: () => ({
                status: opts.rawStatus,
                activeInteractivePrompt: opts.activeInteractivePrompt,
                activeModal: opts.activeModalKind
                    ? { kind: opts.activeModalKind, message: 'Pick as many as apply', buttons: ['Alpha', 'Beta'] }
                    : null,
            }),
            getPartialResponse: () => '',
            getScriptParsedStatus: () => null,
        },
        monitor: { check: () => [] } as any,
        providerSessionId: undefined,

        lastStatus: 'busy',
        generatingStartedAt: 1,
        generatingDebounceTimer: null,
        generatingDebouncePending: null,
        completedDebounceTimer: null,
        completedDebouncePending: null,
        busyEpoch: 0,
        autoApproveBusy: false,
        suppressIdleHistoryReplay: false,
        lastApprovalEventFingerprint: '',
        lastInteractivePromptEventKey: '',
        startupGraceCollapseAt: null,
        agentReadyEmitted: true,
        errorMessage: undefined,
        errorReason: undefined,
        lastCompletionSummary: null,

        stabilizeFlappingApprovalStatus: (adapterStatus: any) => adapterStatus,
        promoteProviderSessionId: () => {},
        maybeAutoApproveStatus: () => false,
        hasAdapterPendingResponse: () => true,
        fsmTraceOn: () => false,
        recordFsmTransitionTrace: () => {},
        completionTraceOn: () => false,
        recordCompletionGateTrace: () => {},
        pushEvent: (event: unknown) => { pushed.push(event); },
        appendRuntimeSystemMessage: () => {},
        completingTurnTaskId: () => undefined,
        isAutonomousMeshSession: () => false,
        isMeshWorkerSession: () => false,
        meshTraceCtx: () => ({}),
        completionFinalAssistantEvidence: () => ({ source: 'unavailable', messages: [] }) as any,
        completionHasFinalAssistantMessage: () => false,
        hasEmittedGenuineCompletionForCurrentEpoch: () => false,
        emitGeneratingCompleted: () => {},
        markCurrentTurnStartupGraceCollapseSatisfied: () => {},
        maybeSynthesizeStartupGraceCollapse: () => false,
        scheduleCompletedDebounceFlush: () => {},
        emitAgentReadyOnce: () => {},
        applyProviderResponse: () => {},
    };
    return { host, pushed };
}

describe('runStatusTransitionTick — question-picker vs approval classification', () => {
    it('interactivePrompt=null + rawStatus=waiting_approval + activeModalKind=picker → stays waiting_approval (parse-failure fallback, the bug)', () => {
        const { host, pushed } = makeHost({
            rawStatus: 'waiting_approval',
            activeInteractivePrompt: null,
            activeModalKind: 'picker',
        });

        runStatusTransitionTick(host);

        expect(host.lastStatus).toBe('waiting_approval');
        expect(pushed.some((e: any) => e.event === 'agent:waiting_approval')).toBe(true);
        expect(pushed.some((e: any) => e.event === 'agent:waiting_choice')).toBe(false);
    });

    it('interactivePrompt=<captured> + rawStatus=waiting_approval + activeModalKind=picker → reclassifies to waiting_choice (the fix)', () => {
        const { host, pushed } = makeHost({
            rawStatus: 'waiting_approval',
            activeInteractivePrompt: SAMPLE_PROMPT,
            activeModalKind: 'picker',
        });

        runStatusTransitionTick(host);

        expect(host.lastStatus).toBe('waiting_choice');
        expect(pushed.some((e: any) => e.event === 'agent:waiting_approval')).toBe(false);
        expect(pushed.some((e: any) => e.event === 'agent:waiting_choice')).toBe(true);
    });

    it('interactivePrompt=<captured> but activeModalKind=approval (genuine consent) → approval still wins (mutual exclusion holds)', () => {
        const { host, pushed } = makeHost({
            rawStatus: 'waiting_approval',
            activeInteractivePrompt: SAMPLE_PROMPT,
            activeModalKind: 'approval',
        });

        runStatusTransitionTick(host);

        expect(host.lastStatus).toBe('waiting_approval');
        expect(pushed.some((e: any) => e.event === 'agent:waiting_approval')).toBe(true);
    });
});
