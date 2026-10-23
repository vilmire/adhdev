// Shared host fixture for runStatusTransitionTick picker tests (classification + relay regression).
import type { StatusTransitionHost } from '../../../src/providers/completion/status-transition.js';
import type { ProviderModule } from '../../../src/providers/contracts.js';
import type { InteractivePrompt } from '../../../src/providers/types/interactive-prompt.js';

export const PROVIDER: ProviderModule = {
    type: 'claude-cli',
    name: 'Claude Code',
    category: 'cli',
} as ProviderModule;

export const SAMPLE_PROMPT: InteractivePrompt = {
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

export function makeHost(opts: {
    rawStatus: string;
    activeInteractivePrompt: InteractivePrompt | null;
    activeModalKind: 'picker' | 'approval' | null;
    modalMessage?: string;
}): { host: StatusTransitionHost & Record<string, unknown>; pushed: unknown[]; opts: typeof opts } {
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
                    ? { kind: opts.activeModalKind, message: opts.modalMessage ?? 'Pick as many as apply', buttons: ['Alpha', 'Beta'] }
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
    return { host, pushed, opts };
}

