/**
 * status-transition.ts's turn-evidence producer sites (wiring-unification
 * C5/C-W5/C-W5c, phase-C-W5 brief §1 rows for status-transition.ts). Pins:
 * every site submits evidence THROUGH the port (guarded, no verdict); the
 * `waiting_approval` arm still pushes its `agent:waiting_approval`
 * provider-event ALONGSIDE the evidence (unaffected by C-W5c — only the
 * `agent:generating_completed`/`agent:stopped` COMPLETION literals were
 * deleted), while the `error`/`stopped` arms construct NO legacy wire event
 * any more — text (error message, diagnostic reason) rides
 * `envelope.finalSummary`/`envelope.notice` instead; a null port is a pure
 * no-op for the evidence path; session_error's reason classifies into the
 * closed SESSION_ERROR_REASONS enum rather than carrying the adapter's
 * free-text reason.
 */
import { describe, expect, it, vi } from 'vitest';
import { runStatusTransitionTick, type StatusTransitionHost } from '../../../src/providers/completion/status-transition.js';
import { createTurnEvidencePort } from '../../../src/providers/turn-evidence-port.js';
import type { ProviderModule } from '../../../src/providers/contracts.js';
import type { TurnEvidence } from '@adhdev/mesh-shared';

const PROVIDER: ProviderModule = { type: 'claude-cli', name: 'Claude Code', category: 'cli' } as ProviderModule;

function makeHost(opts: {
    lastStatus: string;
    rawStatus: string;
    turnEvidencePort?: ReturnType<typeof createTurnEvidencePort> | null;
    errorMessage?: string;
    errorReason?: string;
    activeInteractivePrompt?: any;
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
                activeInteractivePrompt: opts.activeInteractivePrompt ?? null,
                activeModal: opts.rawStatus === 'waiting_approval' ? { message: 'Allow?', buttons: ['Yes', 'No'] } : null,
                errorMessage: opts.errorMessage,
                errorReason: opts.errorReason,
            }),
            getScriptParsedStatus: () => null,
        },
        monitor: { check: () => [] } as any,
        providerSessionId: undefined,
        turnEvidencePort: opts.turnEvidencePort,
        currentAttemptRef: () => ({ attemptId: 'attempt_1', generation: 0 }),

        lastStatus: opts.lastStatus,
        generatingStartedAt: 0,
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
        hasAdapterPendingResponse: () => false,
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

describe('runStatusTransitionTick — turn-evidence emission', () => {
    it('idle→waiting_approval submits a suspension{modal:approval} alongside the agent:waiting_approval push', () => {
        const observed: TurnEvidence[] = [];
        const port = createTurnEvidencePort({ observe: (e) => { observed.push(e); } });
        const { host, pushed } = makeHost({ lastStatus: 'idle', rawStatus: 'waiting_approval', turnEvidencePort: port });

        runStatusTransitionTick(host);

        expect(pushed.some((e: any) => e.event === 'agent:waiting_approval')).toBe(true);
        const ev = observed.find((e) => e.kind === 'suspension') as Extract<TurnEvidence, { kind: 'suspension' }> | undefined;
        expect(ev).toBeDefined();
        expect(ev!.modal).toBe('approval');
        expect(ev!.sessionId).toBe('inst-1');
        expect(ev!.attemptRef).toEqual({ attemptId: 'attempt_1', generation: 0 });
    });

    it('generating→error submits session_error classified into the closed enum, never the free-text reason; C-W5c: no legacy agent:stopped wire literal, error text rides envelope.finalSummary/notice instead', () => {
        const observedOpts: any[] = [];
        const observed: TurnEvidence[] = [];
        const port = createTurnEvidencePort({ observe: (e, opts) => { observed.push(e); observedOpts.push(opts); } });
        const { host, pushed } = makeHost({
            lastStatus: 'generating', rawStatus: 'error', turnEvidencePort: port,
            errorMessage: 'some free-text banner the agent printed', errorReason: 'auth_failed',
        });

        runStatusTransitionTick(host);

        expect(pushed.some((e: any) => e.event === 'agent:stopped')).toBe(false);
        const idx = observed.findIndex((e) => e.kind === 'session_error');
        const ev = observed[idx] as Extract<TurnEvidence, { kind: 'session_error' }> | undefined;
        expect(ev).toBeDefined();
        expect(ev!.reason).toBe('auth_failed');
        // Content-free: no free-text field anywhere on the evidence object.
        expect(Object.values(ev as object)).not.toContain('some free-text banner the agent printed');
        // The text still reaches the coordinator — just via the LOCAL envelope
        // opt, never the deleted wire literal.
        expect(observedOpts[idx]?.envelope?.finalSummary).toBe('some free-text banner the agent printed');
        expect(observedOpts[idx]?.envelope?.notice?.errorMessage).toBe('some free-text banner the agent printed');
    });

    it('an unrecognized errorReason classifies to "unknown", never leaking the raw string', () => {
        const observed: TurnEvidence[] = [];
        const port = createTurnEvidencePort({ observe: (e) => { observed.push(e); } });
        const { host } = makeHost({
            lastStatus: 'generating', rawStatus: 'error', turnEvidencePort: port,
            errorReason: 'some_future_reason_not_in_ProviderErrorReason',
        });

        runStatusTransitionTick(host);

        const ev = observed.find((e) => e.kind === 'session_error') as Extract<TurnEvidence, { kind: 'session_error' }> | undefined;
        expect(ev!.reason).toBe('unknown');
    });

    it('generating→stopped submits process_exit{exitCode:null} (unexplained death convention); C-W5c: no legacy agent:stopped wire literal', () => {
        const observed: TurnEvidence[] = [];
        const port = createTurnEvidencePort({ observe: (e) => { observed.push(e); } });
        const { host, pushed } = makeHost({ lastStatus: 'generating', rawStatus: 'stopped', turnEvidencePort: port });

        runStatusTransitionTick(host);

        expect(pushed.some((e: any) => e.event === 'agent:stopped')).toBe(false);
        const ev = observed.find((e) => e.kind === 'process_exit') as Extract<TurnEvidence, { kind: 'process_exit' }> | undefined;
        expect(ev).toBeDefined();
        expect(ev!.exitCode).toBeNull();
    });

    it('a null turnEvidencePort is a pure no-op — runStatusTransitionTick never throws', () => {
        const { host } = makeHost({ lastStatus: 'generating', rawStatus: 'stopped', turnEvidencePort: null });
        expect(() => runStatusTransitionTick(host)).not.toThrow();
    });

    it('a throwing sink never breaks the tick', () => {
        const port = createTurnEvidencePort({ observe: () => { throw new Error('ledger unavailable'); } });
        const { host } = makeHost({ lastStatus: 'generating', rawStatus: 'stopped', turnEvidencePort: port });
        expect(() => runStatusTransitionTick(host)).not.toThrow();
    });

    it('ordering property: a sequence of evidence submitted across one turn (suspension then process_exit) has non-decreasing `at` and a CONSISTENT sessionId/attemptRef throughout', () => {
        const observed: TurnEvidence[] = [];
        const port = createTurnEvidencePort({ observe: (e) => { observed.push(e); } });

        // Turn 1: enters an approval suspension.
        const { host: h1 } = makeHost({ lastStatus: 'idle', rawStatus: 'waiting_approval', turnEvidencePort: port });
        runStatusTransitionTick(h1);
        // Turn 1, continued: the same session later dies.
        const { host: h2 } = makeHost({ lastStatus: 'generating', rawStatus: 'stopped', turnEvidencePort: port });
        runStatusTransitionTick(h2);

        expect(observed.length).toBeGreaterThanOrEqual(2);
        // Every evidence record from a single provider instance's own emission
        // order carries the SAME sessionId/attemptRef (the identity a single
        // instance can guarantee about its own observations — the cross-daemon
        // race across MULTIPLE producers is W1's turn-race.property.test.ts,
        // not this test's concern).
        for (const ev of observed) {
            expect(ev.sessionId).toBe('inst-1');
            expect(ev.attemptRef).toEqual({ attemptId: 'attempt_1', generation: 0 });
        }
        // Non-decreasing `at` across the sequence as emitted.
        for (let i = 1; i < observed.length; i++) {
            expect(observed[i].at).toBeGreaterThanOrEqual(observed[i - 1].at);
        }
    });
});
