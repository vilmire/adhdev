/**
 * Busy-blip damper (cursor-cli live flap, 2026-10): an idle→generating frame
 * that lasts < BUSY_BLIP_DAMP_MS right after the FSM settled to idle must not
 * cancel an armed completion; a busy run that persists still does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js';
import { BUSY_BLIP_DAMP_MS } from '../../src/providers/completion/busy-blip-damper.js';

function makeInstance(): { instance: any; events: any[]; setFrame: (frame: { status: string; fsmReadySeen?: boolean }) => void } {
    const events: any[] = [];
    const instance = Object.create(CliProviderInstance.prototype) as any;
    let frame: { status: string; fsmReadySeen?: boolean } = { status: 'idle' };

    instance.type = 'cursor-cli';
    instance.instanceId = 'e55126a4-test';
    instance.provider = { name: 'Cursor Agent', type: 'cursor-cli', settings: {}, nativeHistory: {} };
    instance.workingDir = '/repo/worktree';
    instance.providerSessionId = 'psess-agy-1';
    instance.settings = { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-agy-1', meshNodeId: 'node-1' };
    instance.lastStatus = 'idle';
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


const armed = () => ({
    chatTitle: 'Cursor Agent · wt', duration: 40, timestamp: 1_700_000_040_000, firstObservedAt: 1_700_000_040_000,
    previousStatus: 'generating', turnStartedAt: 1_700_000_000_000, busyEpochAtArm: 3, lastOutputAtArm: 1_700_000_039_900,
});

afterEach(() => { vi.useRealTimers(); });

describe('busy-blip damper (idle→generating right after an armed completion)', () => {
    it('a busy blip shorter than the damp window leaves the armed completion untouched', () => {
        vi.useFakeTimers(); vi.setSystemTime(1_700_000_050_000);
        const { instance, setFrame } = makeInstance();
        instance.completedDebouncePending = armed();
        instance.generatingStartedAt = 1_700_000_000_000;
        instance.busyEpoch = 3;

        setFrame({ status: 'generating' });
        instance.detectStatusTransition();
        vi.advanceTimersByTime(BUSY_BLIP_DAMP_MS - 500);
        setFrame({ status: 'generating' });
        instance.detectStatusTransition();
        expect(instance.completedDebouncePending).not.toBeNull();
        expect(instance.busyEpoch).toBe(3);

        setFrame({ status: 'idle' });
        instance.detectStatusTransition();
        expect(instance.completedDebouncePending).not.toBeNull();
        expect(instance.lastStatus).toBe('idle');
    });

    it('a busy run that persists past the window still cancels the armed completion (real resume)', () => {
        vi.useFakeTimers(); vi.setSystemTime(1_700_000_050_000);
        const { instance, setFrame } = makeInstance();
        instance.completedDebouncePending = armed();
        instance.generatingStartedAt = 1_700_000_000_000;
        instance.busyEpoch = 3;

        setFrame({ status: 'generating' });
        instance.detectStatusTransition();
        vi.advanceTimersByTime(BUSY_BLIP_DAMP_MS + 100);
        setFrame({ status: 'generating' });
        instance.detectStatusTransition();
        expect(instance.completedDebouncePending).toBeNull();
        expect(instance.busyEpoch).toBe(4);
        expect(instance.lastStatus).toBe('generating');
    });

    it('two short blips separated by idle each restart the window (the ~3 s flap never cancels)', () => {
        vi.useFakeTimers(); vi.setSystemTime(1_700_000_050_000);
        const { instance, setFrame } = makeInstance();
        instance.completedDebouncePending = armed();
        instance.generatingStartedAt = 1_700_000_000_000;
        instance.busyEpoch = 3;
        for (let i = 0; i < 4; i += 1) {
            setFrame({ status: 'generating' });
            instance.detectStatusTransition();
            vi.advanceTimersByTime(900);
            setFrame({ status: 'idle' });
            instance.detectStatusTransition();
            vi.advanceTimersByTime(2_100);
        }
        expect(instance.completedDebouncePending).not.toBeNull();
        expect(instance.busyEpoch).toBe(3);
    });
});
