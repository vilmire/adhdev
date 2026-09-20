// ---------------------------------------------------------------------------
// THE DEFECT THESE TESTS PIN (2026-09-20)
// ---------------------------------------------------------------------------
// Measured live: 6 `terminal admission declined (transcript_growing)` suppressions
// in one day, each logging "bounded content-free retry armed", and ZERO retries
// ever delivering. Two independent sessions took the identical shape:
//
//   9c62c762 (cursor-cli, base)      05:45:57  newest bubble 5867ms old → lost
//   d26e1244 (cursor-cli, worktree)  05:48:14  newest bubble 5680ms old → lost
//
// The coordinator's queue row said `completed` (the worker's tool report landed)
// while the turn ledger had terminalAt=null — so `mesh_task_history` reported
// completed+incompleteEvidence and the coordinator waited forever on a worker
// that had already finished.
//
// Three root causes, one per test group below:
//   1. TTL expiry deleted the hold and delivered NOTHING (silent permanent loss).
//   2. The 5s TTL could not outlast the 8s quiet window it was waiting for, so
//      expiry was the GUARANTEED outcome for the shape that armed the hold.
//   3. The drain re-checked live-pending, which is false by construction for a
//      transcript_growing decline, so the retry fired instantly back into the
//      same veto.
//
// ★These tests assert DELIVERY — that a completion actually reaches the inject
// path — never that a retry helper "was called". The proxy-metric version of
// this assertion is precisely what let the defect ship.
// ---------------------------------------------------------------------------
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
    holdCompletionForLiveStateRetry,
    setCompletionHoldObserver,
    __completionHoldTimingContract,
    __drainHeldLiveStateCompletionsForTests,
    __resetHeldLiveStateCompletionsForTests,
    type CompletionHoldOutcome,
} from '../../src/mesh/mesh-completion-live-gate.js';
import { TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS } from '../../src/mesh/mesh-terminal-admission.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

const NOW = 1_800_000_000_000;

/** The measured live shape: the decline landed when the tail was 5867ms old. */
const MEASURED_BUBBLE_AGE_MS = 5_867;

type Delivered = { metadataEvent: Record<string, unknown> };

/**
 * A session shaped exactly like the two lost ones: NO modal, NO adapter-pending,
 * NO trailing tool — the transcript is merely still moving. `live.pending` is
 * false here by construction; that is why re-checking it was the wrong question.
 */
function sessionWithTail(newestActivityAtMs: () => number | undefined) {
    return {
        getLiveTurnPendingEvidence: () => ({ pending: false }),
        getTerminalAdmissionObservations: () => {
            const newest = newestActivityAtMs();
            return newest === undefined ? {} : { newestActivityAtMs: newest };
        },
    };
}

function armHold(opts: {
    instance: unknown;
    delivered: Delivered[];
    waitingOn?: 'live_pending' | 'transcript_quiet';
    nowMs?: number;
    metadataEvent?: Record<string, unknown>;
}): boolean {
    const components = { instanceManager: { getInstance: () => opts.instance } };
    return holdCompletionForLiveStateRetry(
        components,
        {
            meshId: 'mesh-1',
            nodeLabel: 'node-1',
            metadataEvent: opts.metadataEvent ?? {
                taskId: 'task-1',
                attemptId: 'attempt-1',
                dispatchNonce: 7,
                timestamp: NOW,
                providerType: 'cursor-cli',
            },
        },
        'session-1',
        opts.nowMs ?? NOW,
        (_c, a) => { opts.delivered.push({ metadataEvent: a.metadataEvent }); },
        opts.waitingOn ?? 'transcript_quiet',
    );
}

let restoreAttemptLookup: (() => void) | null = null;

function stubOpenAttempt(): void {
    const store = MeshRuntimeStore.getInstance() as unknown as Record<string, unknown>;
    const original = store.getCurrentTurnAttempt;
    store.getCurrentTurnAttempt = () => ({
        attemptId: 'attempt-1',
        taskId: 'task-1',
        sessionId: 'session-1',
        dispatchNonce: 7,
        terminalOutcome: null,
        stage: 'finalizing',
    });
    restoreAttemptLookup = () => { store.getCurrentTurnAttempt = original; };
}

beforeEach(() => {
    __resetHeldLiveStateCompletionsForTests();
    setCompletionHoldObserver(null);
    stubOpenAttempt();
});

afterEach(() => {
    restoreAttemptLookup?.();
    restoreAttemptLookup = null;
    __resetHeldLiveStateCompletionsForTests();
    setCompletionHoldObserver(null);
});

describe('(1) an armed hold ALWAYS resumes — the permanent-loss defect', () => {
    it('★CORE: a tail that NEVER goes quiet still delivers when the bound expires (was: silent drop)', () => {
        const delivered: Delivered[] = [];
        // A pathologically busy tail: the newest bubble is always "just now", so
        // the quiet window never opens. Before the fix this delivered nothing, ever.
        const instance = sessionWithTail(() => currentNow);
        let currentNow = NOW;
        expect(armHold({ instance, delivered })).toBe(true);

        const { transcriptQuietTtlMs } = __completionHoldTimingContract();
        for (let t = 250; t <= transcriptQuietTtlMs + 1_000; t += 250) {
            currentNow = NOW + t;
            __drainHeldLiveStateCompletionsForTests(currentNow);
        }

        expect(delivered).toHaveLength(1);
        const diagnostic = delivered[0].metadataEvent.completionDiagnostic as Record<string, unknown>;
        expect(diagnostic.holdExpired).toBe(true);
        expect(diagnostic.holdWaitedOn).toBe('transcript_quiet');
    });

    it('★CORE: the measured 5867ms-old-tail case delivers once the tail goes quiet — WITHOUT waiting for the bound', () => {
        const delivered: Delivered[] = [];
        // The live shape: at arm time the newest bubble is 5867ms old (inside the
        // 8s window → declined), and the tail then stops moving.
        const frozenNewest = NOW - MEASURED_BUBBLE_AGE_MS;
        const instance = sessionWithTail(() => frozenNewest);
        expect(armHold({ instance, delivered })).toBe(true);

        // Not yet quiet: 5867 + 1000 = 6867ms < 8000ms window.
        __drainHeldLiveStateCompletionsForTests(NOW + 1_000);
        expect(delivered).toHaveLength(0);

        // Now quiet: the tail has aged past the window. This fires WELL before the
        // bound, so the release is the condition clearing, not the ceiling.
        __drainHeldLiveStateCompletionsForTests(NOW + 2_500);
        expect(delivered).toHaveLength(1);
        const diagnostic = delivered[0].metadataEvent.completionDiagnostic as Record<string, unknown>;
        expect(diagnostic.holdExpired).toBeUndefined();
        expect(diagnostic.source).toBe('mid_turn_live_state_retry');
    });

    it('the delivered retry carries the original dispatch identity, and no content', () => {
        const delivered: Delivered[] = [];
        const instance = sessionWithTail(() => NOW - 60_000);
        armHold({ instance, delivered });
        __drainHeldLiveStateCompletionsForTests(NOW + 250);

        const md = delivered[0].metadataEvent;
        expect(md).toMatchObject({
            taskId: 'task-1',
            attemptId: 'attempt-1',
            dispatchNonce: 7,
            targetSessionId: 'session-1',
            providerType: 'cursor-cli',
        });
        // Content boundary: the hold re-delivers identity only, never transcript text.
        expect(md.finalSummary).toBeUndefined();
        expect(md.modalMessage).toBeUndefined();
        expect(JSON.stringify(md)).not.toContain('transcriptEvidence');
    });
});

describe('(2) the bound must outlast the window it waits on', () => {
    it('★the transcript-quiet hold TTL is strictly GREATER than the quiet window', () => {
        const { transcriptQuietTtlMs, transcriptQuietReleaseMs } = __completionHoldTimingContract();
        // The original 5s-TTL / 8s-window pairing made expiry unavoidable for the
        // exact shape that armed the hold. If this ever inverts again, every
        // transcript_growing decline becomes a guaranteed bound-expiry release.
        expect(transcriptQuietTtlMs).toBeGreaterThan(transcriptQuietReleaseMs);
        expect(transcriptQuietTtlMs).toBeGreaterThan(MEASURED_BUBBLE_AGE_MS);
    });

    it('★the hold\'s release window stays pinned to the admission rule it mirrors', () => {
        // Two constants in two modules answering the same question. If the
        // admission window moves and this one does not, the hold waits for a
        // condition the gate no longer uses.
        expect(__completionHoldTimingContract().transcriptQuietReleaseMs)
            .toBe(TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS);
    });
});

describe('(3) the drain re-checks the reason the completion was DECLINED', () => {
    it('★a transcript_quiet hold does NOT fire while the tail is still moving', () => {
        const delivered: Delivered[] = [];
        let newest = NOW - MEASURED_BUBBLE_AGE_MS;
        const instance = sessionWithTail(() => newest);
        armHold({ instance, delivered });

        // The old drain asked "is live evidence pending?" → false → fired at the
        // first 250ms tick, straight back into the veto that armed it.
        __drainHeldLiveStateCompletionsForTests(NOW + 250);
        expect(delivered).toHaveLength(0);

        // The tail keeps moving — still no delivery.
        newest = NOW + 1_000;
        __drainHeldLiveStateCompletionsForTests(NOW + 1_250);
        expect(delivered).toHaveLength(0);
    });

    it('a live_pending hold still re-checks live evidence (no regression)', () => {
        const delivered: Delivered[] = [];
        let pending = true;
        const instance = {
            getLiveTurnPendingEvidence: () => ({ pending }),
            // A tail that would keep a transcript_quiet hold waiting forever —
            // proving this hold consults live evidence, not the tail.
            getTerminalAdmissionObservations: () => ({ newestActivityAtMs: NOW }),
        };
        armHold({ instance, delivered, waitingOn: 'live_pending' });

        __drainHeldLiveStateCompletionsForTests(NOW + 250);
        expect(delivered).toHaveLength(0);

        pending = false;
        __drainHeldLiveStateCompletionsForTests(NOW + 500);
        expect(delivered).toHaveLength(1);
    });

    it('an unobservable tail releases rather than holding forever (fail-open)', () => {
        const delivered: Delivered[] = [];
        const instance = sessionWithTail(() => undefined);
        armHold({ instance, delivered });
        __drainHeldLiveStateCompletionsForTests(NOW + 250);
        // Absence of evidence never manufactures a hold, exactly as it never
        // manufactures a veto in the admission gate.
        expect(delivered).toHaveLength(1);
    });
});

describe('(4) boundedness — the release can never loop', () => {
    it('★a completion released by an EXPIRED hold refuses to re-arm', () => {
        const delivered: Delivered[] = [];
        const instance = sessionWithTail(() => NOW);
        const rearmed = armHold({
            instance,
            delivered,
            metadataEvent: {
                taskId: 'task-1',
                attemptId: 'attempt-1',
                dispatchNonce: 7,
                timestamp: NOW,
                completionDiagnostic: { source: 'mid_turn_live_state_retry', holdExpired: true },
            },
        });
        // Without this the bound is per-hold, not per-completion: each expiry
        // release re-enters the gate, is declined again, and arms a FRESH hold
        // with a fresh TTL — unbounded, and still never notifying.
        expect(rearmed).toBe(false);
        __drainHeldLiveStateCompletionsForTests(NOW + 20_000);
        expect(delivered).toHaveLength(0);
    });

    it('a terminal/reassigned identity abandons the hold instead of delivering a stale completion', () => {
        const delivered: Delivered[] = [];
        const instance = sessionWithTail(() => NOW - 60_000);
        armHold({ instance, delivered });

        const store = MeshRuntimeStore.getInstance() as unknown as Record<string, unknown>;
        store.getCurrentTurnAttempt = () => ({
            attemptId: 'attempt-1',
            taskId: 'task-1',
            sessionId: 'session-1',
            dispatchNonce: 7,
            terminalOutcome: 'completed',
            stage: 'completed',
        });

        __drainHeldLiveStateCompletionsForTests(NOW + 250);
        // The coordinator is not waiting on THIS event — a terminal already landed.
        expect(delivered).toHaveLength(0);
    });
});

describe('(5) the log cannot lie — every arm reports its own fate', () => {
    it('★an expiring hold emits an outcome (the silent drop is what hid the defect)', () => {
        const outcomes: CompletionHoldOutcome[] = [];
        setCompletionHoldObserver((r) => { outcomes.push(r.outcome); });

        const delivered: Delivered[] = [];
        let currentNow = NOW;
        const instance = sessionWithTail(() => currentNow);
        armHold({ instance, delivered });

        const { transcriptQuietTtlMs } = __completionHoldTimingContract();
        for (let t = 250; t <= transcriptQuietTtlMs + 1_000; t += 250) {
            currentNow = NOW + t;
            __drainHeldLiveStateCompletionsForTests(currentNow);
        }
        expect(outcomes).toEqual(['released_hold_expired']);
    });

    it('a condition-cleared release and an abandonment are distinguishable in the report', () => {
        const reports: Array<{ outcome: CompletionHoldOutcome; heldForMs: number }> = [];
        setCompletionHoldObserver((r) => { reports.push({ outcome: r.outcome, heldForMs: r.heldForMs }); });

        const delivered: Delivered[] = [];
        armHold({ instance: sessionWithTail(() => NOW - 60_000), delivered });
        __drainHeldLiveStateCompletionsForTests(NOW + 250);

        expect(reports).toHaveLength(1);
        expect(reports[0].outcome).toBe('released_condition_cleared');
        expect(reports[0].heldForMs).toBe(250);
    });

    it('a missing session is reported as abandoned, not silently forgotten', () => {
        const outcomes: CompletionHoldOutcome[] = [];
        setCompletionHoldObserver((r) => { outcomes.push(r.outcome); });

        const delivered: Delivered[] = [];
        const components = { instanceManager: { getInstance: () => undefined } };
        holdCompletionForLiveStateRetry(
            components,
            {
                meshId: 'mesh-1',
                nodeLabel: 'node-1',
                metadataEvent: { taskId: 'task-1', attemptId: 'attempt-1', dispatchNonce: 7, timestamp: NOW },
            },
            'session-1',
            NOW,
            (_c, a) => { delivered.push({ metadataEvent: a.metadataEvent }); },
            'transcript_quiet',
        );
        __drainHeldLiveStateCompletionsForTests(NOW + 250);
        expect(outcomes).toEqual(['abandoned_session_gone']);
        expect(delivered).toHaveLength(0);
    });
});
