/**
 * AGY-STATE-EMISSION (M-MESH-INFRA-0829): detectStatusTransition must emit
 * agent:ready on the first genuine FSM idle, and must NOT emit
 * generating_started for a boot-phase generating blip (antigravity signing_in).
 *
 * The SpecCliAdapter boot-hold (cli-adapter-boot-status-hold.test.ts) is the
 * primary prevention; this suite injects the frames that hold would produce
 * (and the poison frames it used to produce) into the real
 * detectStatusTransition path.
 */
import { describe, expect, it } from 'vitest';
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js';

function makeInstance(): { instance: any; events: any[]; setFrame: (frame: { status: string; fsmReadySeen?: boolean }) => void } {
    const events: any[] = [];
    const instance = Object.create(CliProviderInstance.prototype) as any;
    let frame: { status: string; fsmReadySeen?: boolean } = { status: 'starting' };

    instance.type = 'antigravity-cli';
    instance.instanceId = 'e55126a4-test';
    instance.provider = { name: 'Antigravity CLI', type: 'antigravity-cli', settings: {}, nativeHistory: {} };
    instance.workingDir = '/repo/worktree';
    instance.providerSessionId = 'psess-agy-1';
    instance.settings = { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-agy-1', meshNodeId: 'node-1' };
    instance.lastStatus = 'starting';
    instance.generatingStartedAt = 0;
    instance.generatingDebouncePending = null;
    instance.generatingDebounceTimer = null;
    instance.completedDebouncePending = null;
    instance.completedDebounceTimer = null;
    instance.lastApprovalEventFingerprint = '';
    instance.lastInteractivePromptEventKey = '';
    instance.autoApproveBusy = false;
    instance.agentReadyEmitted = false;
    instance.suppressIdleHistoryReplay = false;
    instance.startupGraceCollapseAt = null;
    instance.fastCollapseSynthesizedTaskId = null;
    instance.busyEpoch = 0;
    instance.startedAt = Date.now();
    instance.errorMessage = undefined;
    instance.errorReason = undefined;
    instance.lastCompletionSummary = null;
    instance.meshTaskAttachmentHistory = [];

    instance.adapter = {
        getStatus: () => ({ ...frame }),
        getPartialResponse: () => '',
        getScriptParsedStatus: () => ({ status: frame.status, messages: [] }),
        get isWaitingForResponse() { return false; },
        chatMessagesOwnedExternally: true,
    };

    instance.maybeAutoApproveStatus = () => false;
    instance.stabilizeFlappingApprovalStatus = (s: any) => s;
    instance.promoteProviderSessionId = () => {};
    instance.applyProviderResponse = () => {};
    instance.isMeshWorkerSession = () => true;
    instance.isAutonomousMeshSession = () => true;
    instance.completingTurnTaskId = () => undefined;
    instance.completionFinalAssistantEvidence = () => ({ present: false, messages: [], source: 'unavailable' });
    instance.completionHasFinalAssistantMessage = () => false;
    instance.hasAdapterPendingResponse = () => false;
    instance.fsmTraceOn = () => false;
    instance.completionTraceOn = () => false;
    instance.recordFsmTransitionTrace = () => {};
    instance.recordCompletionGateTrace = () => {};
    instance.appendRuntimeSystemMessage = () => {};
    instance.meshTraceCtx = () => ({});
    instance.markCurrentTurnStartupGraceCollapseSatisfied = () => {};
    instance.maybeSynthesizeStartupGraceCollapse = () => false;
    instance.scheduleCompletedDebounceFlush = () => {};
    instance.emitGeneratingCompleted = () => {};
    instance.detachMeshAssignment = () => {};
    instance.monitor = { check: () => [] };
    instance.context = { emitProviderEvent: (e: any) => events.push(e) };
    instance.events = [];
    instance.pushEvent = CliProviderInstance.prototype['pushEvent' as never];
    instance.emitAgentReadyOnce = CliProviderInstance.prototype['emitAgentReadyOnce' as never];
    instance.detectStatusTransition = CliProviderInstance.prototype['detectStatusTransition' as never];

    return {
        instance,
        events,
        setFrame: (next) => { frame = next; },
    };
}

describe('CliProviderInstance — FSM ready re-arm (antigravity boot)', () => {
    it('GREEN: starting-hold then genuine idle+fsmReadySeen emits agent:ready and never generating_started', () => {
        const { instance, events, setFrame } = makeInstance();

        // Adapter boot-hold: signing_in still reports starting.
        setFrame({ status: 'starting', fsmReadySeen: false });
        instance.detectStatusTransition();
        expect(instance.lastStatus).toBe('starting');
        expect(events.filter((e: any) => e.event === 'agent:ready')).toHaveLength(0);
        expect(events.filter((e: any) => e.event === 'agent:generating_started')).toHaveLength(0);

        // Prompt is up. maybeMarkReady already latched (fsmReadySeen true).
        setFrame({ status: 'idle', fsmReadySeen: true });
        instance.detectStatusTransition();

        expect(instance.lastStatus).toBe('idle');
        expect(events.filter((e: any) => e.event === 'agent:ready')).toHaveLength(1);
        expect(events.filter((e: any) => e.event === 'agent:generating_started')).toHaveLength(0);
        expect(instance.agentReadyEmitted).toBe(true);
        expect(instance.generatingStartedAt).toBe(0);
    });

    it('RED-GUARD: idle with fsmReadySeen=false does not consume the agent:ready one-shot', () => {
        const { instance, events, setFrame } = makeInstance();

        // The historical poison: initial FSM state declares status idle, adapter
        // projected it, one-shot fired before the prompt existed.
        setFrame({ status: 'idle', fsmReadySeen: false });
        instance.detectStatusTransition();

        expect(instance.lastStatus).toBe('idle');
        expect(events.filter((e: any) => e.event === 'agent:ready')).toHaveLength(0);
        expect(instance.agentReadyEmitted).toBe(false);

        // Later the prompt is drawn (idle→idle, no status change) — re-arm fires.
        setFrame({ status: 'idle', fsmReadySeen: true });
        instance.detectStatusTransition();
        expect(events.filter((e: any) => e.event === 'agent:ready')).toHaveLength(1);
    });

    it('POISON: pre-ready generating (signing_in) would arm generating_started — adapter hold exists to prevent this frame', () => {
        const { instance, events, setFrame } = makeInstance();

        // If the adapter leaked signing_in as generating AFTER projecting the
        // initial state as idle, detectStatusTransition would arm a false turn.
        setFrame({ status: 'idle', fsmReadySeen: false });
        instance.detectStatusTransition();
        setFrame({ status: 'generating', fsmReadySeen: false });
        instance.detectStatusTransition();

        expect(instance.lastStatus).toBe('generating');
        expect(instance.generatingStartedAt).toBeGreaterThan(0);
        expect(instance.generatingDebouncePending).not.toBeNull();

        // Clean up the debounce timer so the suite does not leak.
        if (instance.generatingDebounceTimer) {
            clearTimeout(instance.generatingDebounceTimer);
            instance.generatingDebounceTimer = null;
        }
        expect(events.filter((e: any) => e.event === 'agent:ready')).toHaveLength(0);
    });
});
