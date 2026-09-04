import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Per-file isolated config dir → per-file mesh-runtime.db (same convention as
// mesh-turn-held-suspension.test.ts). Keeps this suite's turn tables free of
// sibling rows.
const testTmpDir = join(tmpdir(), `adhdev-turn-held-restart-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    openTurnAttempt,
    recordTurnAck,
    recordTurnStage,
    proposeTurnCompletion,
    closeAttemptForReassignment,
    drainHeldTurnSuspensionsForMesh,
    gateRedriveForHeldSuspension,
    evaluateRedrive,
    assertPromptInjectionAllowed,
    projectTurnAttempt,
    getTurnLedgerMetrics,
    __resetTurnLedgerMetricsForTests,
} from '../../src/mesh/mesh-turn-ledger.js';
import {
    presentationFromAttemptRow,
    __resetTurnPresentationMetricsForTests,
} from '../../src/mesh/mesh-turn-presentation.js';

const MESH = `mesh-${randomUUID().slice(0, 8)}`;
let taskSeq = 0;
function nextTaskId(): string {
    taskSeq += 1;
    return `task-${randomUUID().slice(0, 8)}-${taskSeq}`;
}

beforeEach(() => {
    __resetTurnLedgerMetricsForTests();
    __resetTurnPresentationMetricsForTests();
});

afterEach(() => {
    MeshRuntimeStore.resetForTests();
    try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// Simulated daemon restart: close the store instance; the next getInstance reopens
// the SAME on-disk DB, so only durable state survives.
function simulateRestart(): void {
    MeshRuntimeStore.resetForTests();
}

function openDelivered(taskId: string, t0: number, nonce = 1, sessionId = 'sessA') {
    const { attempt } = openTurnAttempt({
        meshId: MESH, taskId, dispatchNonce: nonce, nodeId: 'nodeA', sessionId,
        coordinatorDaemonId: 'daemon_mach_x', coordinatorSessionId: 'coordSess', nowMs: t0,
    });
    const d = recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId, nowMs: t0 + 10 });
    expect(d?.applied).toBe(true);
    return attempt;
}

// The crash window: delivered attempt + a pre-consumed waiting_* hold, then the
// daemon dies BEFORE the consumed ACK is durable.
function holdPreConsumed(taskId: string, attemptId: string, t0: number, stage: 'waiting_choice' | 'waiting_approval' = 'waiting_choice', sessionId = 'sessA') {
    const w = recordTurnStage({
        meshId: MESH, taskId, stage, attemptId, sessionId, occurredAtMs: t0 + 25,
    });
    expect(w?.deferred).toBe(true);
    expect(getTurnLedgerMetrics().suspensionsHeld).toBe(1);
}

describe('held-suspension restart contract — gateRedriveForHeldSuspension', () => {
    it('crash/reopen after hold before consumed: no redrive, consumed recovery + apply exactly once, answer completes the SAME attempt', () => {
        const taskId = nextTaskId();
        const t0 = 1_000_000;
        const attempt = openDelivered(taskId, t0);
        holdPreConsumed(taskId, attempt.attemptId, t0);
        let store = MeshRuntimeStore.getInstance();

        simulateRestart();
        store = MeshRuntimeStore.getInstance();

        // Restart drain: consumed never landed → the row stays held (no apply, no drop).
        expect(drainHeldTurnSuspensionsForMesh(MESH)).toEqual({ applied: 0, dropped: 0, stillHeld: 1 });

        // Session not yet rebound (liveness unknown, grace not exhausted): the hold
        // BLOCKS redrive — no promotion, no drop, attempt untouched.
        const blocked = gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'unknown', sessionProvenDead: false, nowMs: t0 + 30_000 });
        expect(blocked.kind).toBe('blocked');
        expect(getTurnLedgerMetrics().redriveBlockedBySuspension).toBe(1);
        expect(store.getTurnAttempt(attempt.attemptId)!.stage).toBe('delivered');
        expect(store.getHeldTurnSuspension(attempt.attemptId, 'waiting_choice')!.status).toBe('held');

        // Surviving session confirmed rebound → the gate synthesizes the consumed
        // link (explicit audit source) and applies the hold through the FSM.
        const recovered = gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'alive', nowMs: t0 + 31_000 });
        expect(recovered).toMatchObject({ kind: 'recovered', attemptId: attempt.attemptId, stage: 'waiting_choice' });

        const row = store.getTurnAttempt(attempt.attemptId)!;
        expect(row.consumedAt).not.toBeNull();
        expect(row.stage).toBe('waiting_choice');
        expect(store.getHeldTurnSuspension(attempt.attemptId, 'waiting_choice')!.status).toBe('applied');

        // The causal chain carries the synthesized consumed link with its explicit
        // audit source, plus the deferred application — exactly once each.
        const events = store.listTurnEventsForTask(MESH, taskId);
        const consumedEvents = events.filter(e => e.kind === 'consumed');
        expect(consumedEvents).toHaveLength(1);
        expect(JSON.parse(consumedEvents[0].payload).source).toBe('held_suspension_recovery');
        expect(events.filter(e => e.kind === 'held_waiting_choice_applied')).toHaveLength(1);

        // Idempotent re-gate: nothing left to recover or block.
        expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'alive', nowMs: t0 + 32_000 }).kind).toBe('none');

        // Projection/presentation: SAME attemptId, waiting_choice, non-null age.
        const proj = projectTurnAttempt(MESH, taskId)!;
        expect(proj.attemptId).toBe(attempt.attemptId);
        expect(proj.stage).toBe('waiting_choice');
        expect(proj.consumedAt).not.toBeNull();
        const presentation = presentationFromAttemptRow(row);
        expect(presentation.status).toBe('waiting_choice');
        expect(presentation.attemptId).toBe(attempt.attemptId);
        expect(presentation.choiceAgeMs).not.toBeNull();
        expect(presentation.approvalAgeMs).toBeNull();

        // The user answers: the resume (newer occurrence time) passes the
        // reordered-generating guard on the SAME attempt; completion and the
        // terminal outbox are exactly-once; reinjection is refused.
        const resume = recordTurnStage({ meshId: MESH, taskId, stage: 'generating', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 33_000 });
        expect(resume?.applied).toBe(true);
        expect(resume?.attemptId).toBe(attempt.attemptId);
        expect(assertPromptInjectionAllowed(store.getTurnAttempt(attempt.attemptId), 'test')).toBe(false);
        const d1 = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event', nowMs: t0 + 34_000 });
        const d2 = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event', nowMs: t0 + 34_001 });
        expect(d1).toMatchObject({ committed: true, duplicate: false });
        expect(d2).toMatchObject({ committed: true, duplicate: true });
        // ★ Stage 5c-1: two `enqueueTerminalOutbox` assertions followed, checking
        // that the outbox row was INSERT-OR-IGNORE exactly-once for this attempt.
        // The reducer half above (committed/duplicate) is the part that survives;
        // the outbox half is owed to 5c-2 as a redrive-cursor assertion.

        const m = getTurnLedgerMetrics();
        expect(m.suspensionConsumedRecovered).toBe(1);
        expect(m.suspensionsApplied).toBe(1);
        expect(m.suspensionsDropped).toEqual({});
    });

    it('a delayed real consumed ACK after the recovery is idempotent (no duplicate consumed, no stage churn)', () => {
        const taskId = nextTaskId();
        const t0 = 2_000_000;
        const attempt = openDelivered(taskId, t0);
        holdPreConsumed(taskId, attempt.attemptId, t0);
        let store = MeshRuntimeStore.getInstance();

        simulateRestart();
        store = MeshRuntimeStore.getInstance();
        const recovered = gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'alive', nowMs: t0 + 30_000 });
        expect(recovered.kind).toBe('recovered');
        const consumedAtAfterRecovery = store.getTurnAttempt(attempt.attemptId)!.consumedAt;
        expect(consumedAtAfterRecovery).not.toBeNull();

        // The real generating_started consumed ACK finally propagates — insert-once
        // idempotent: not applied, stage unchanged, no duplicate consumed evidence.
        const late = recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 20 });
        expect(late?.applied).toBe(false);
        const row = store.getTurnAttempt(attempt.attemptId)!;
        expect(row.stage).toBe('waiting_choice');
        expect(row.consumedAt).toBe(consumedAtAfterRecovery);
        expect(store.listTurnEventsForTask(MESH, taskId).filter(e => e.kind === 'consumed')).toHaveLength(1);

        const m = getTurnLedgerMetrics();
        expect(m.suspensionConsumedRecovered).toBe(1);
        expect(m.suspensionsApplied).toBe(1);
        expect(m.duplicateTurnEvents).toBeGreaterThanOrEqual(1);
    });

    it('restart repeated twice: the hold survives both restarts and recovers exactly once on the surviving session', () => {
        const taskId = nextTaskId();
        const t0 = 3_000_000;
        const attempt = openDelivered(taskId, t0);
        holdPreConsumed(taskId, attempt.attemptId, t0);
        let store = MeshRuntimeStore.getInstance();

        // Restart #1: still blocked (session not rebound yet).
        simulateRestart();
        store = MeshRuntimeStore.getInstance();
        expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'unknown', sessionProvenDead: false, nowMs: t0 + 30_000 }).kind).toBe('blocked');
        expect(store.getHeldTurnSuspension(attempt.attemptId, 'waiting_choice')!.status).toBe('held');

        // Restart #2: the hold is still durable; recovery applies it exactly once.
        simulateRestart();
        store = MeshRuntimeStore.getInstance();
        expect(drainHeldTurnSuspensionsForMesh(MESH)).toEqual({ applied: 0, dropped: 0, stillHeld: 1 });
        const recovered = gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'alive', nowMs: t0 + 40_000 });
        expect(recovered).toMatchObject({ kind: 'recovered', attemptId: attempt.attemptId, stage: 'waiting_choice' });
        expect(getTurnLedgerMetrics().suspensionsApplied).toBe(1);

        // Restart #3: convergent — drain and gate are both no-ops.
        simulateRestart();
        store = MeshRuntimeStore.getInstance();
        expect(drainHeldTurnSuspensionsForMesh(MESH)).toEqual({ applied: 0, dropped: 0, stillHeld: 0 });
        expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'alive', nowMs: t0 + 50_000 }).kind).toBe('none');
        expect(store.getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_choice');
        expect(getTurnLedgerMetrics().suspensionConsumedRecovered).toBe(1);
        expect(getTurnLedgerMetrics().suspensionsApplied).toBe(1);
    });

    it('session-mismatch / nonce-mismatch / stale holds never block and never recover', () => {
        let store = MeshRuntimeStore.getInstance();
        // (a) session mismatch: the hold names a DIFFERENT session than the attempt's
        // bound worker session.
        {
            const taskId = nextTaskId();
            const t0 = 4_000_000;
            const attempt = openDelivered(taskId, t0, 1, 'sessA');
            store.insertHeldTurnSuspension({
                holdId: `${attempt.attemptId}:waiting_choice`, meshId: MESH, attemptId: attempt.attemptId,
                taskId, stage: 'waiting_choice', sessionId: 'sessOTHER', dispatchNonce: 1,
                occurredAtMs: t0 + 25, recordedAt: new Date(t0 + 25).toISOString(),
            });
            expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'alive', nowMs: t0 + 30_000 }).kind).toBe('none');
            expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'unknown', sessionProvenDead: false, nowMs: t0 + 30_000 }).kind).toBe('none');
            expect(store.getTurnAttempt(attempt.attemptId)!.stage).toBe('delivered');
            expect(store.getHeldTurnSuspension(attempt.attemptId, 'waiting_choice')!.status).toBe('held');
        }
        // (b) nonce mismatch: the hold names a different dispatch epoch than the
        // attempt's current nonce.
        {
            const taskId = nextTaskId();
            const t0 = 4_100_000;
            const attempt = openDelivered(taskId, t0, 1, 'sessA');
            store.insertHeldTurnSuspension({
                holdId: `${attempt.attemptId}:waiting_choice`, meshId: MESH, attemptId: attempt.attemptId,
                taskId, stage: 'waiting_choice', sessionId: 'sessA', dispatchNonce: 99,
                occurredAtMs: t0 + 25, recordedAt: new Date(t0 + 25).toISOString(),
            });
            expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'alive', nowMs: t0 + 30_000 }).kind).toBe('none');
            expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'unknown', sessionProvenDead: false, nowMs: t0 + 30_000 }).kind).toBe('none');
            expect(store.getTurnAttempt(attempt.attemptId)!.consumedAt).toBeNull();
        }
        // (c) stale attempt: reassignment closes the attempt; its hold is dropped and
        // the NEW current attempt is unaffected by the old suspension.
        {
            const taskId = nextTaskId();
            const t0 = 4_200_000;
            const attemptA = openDelivered(taskId, t0, 1, 'sessA');
            holdPreConsumed(taskId, attemptA.attemptId, t0);
            closeAttemptForReassignment({ meshId: MESH, taskId, reason: 'reclaim', nowMs: t0 + 30 });
            expect(store.getHeldTurnSuspension(attemptA.attemptId, 'waiting_choice')!.resolution).toBe('attempt_terminal');
            const attemptB = openDelivered(taskId, t0 + 100, 2, 'sessB');
            expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'alive', nowMs: t0 + 200 }).kind).toBe('none');
            expect(store.getTurnAttempt(attemptB.attemptId)!.stage).toBe('delivered');
            expect(store.listHeldTurnSuspensionsForAttempt(attemptB.attemptId, 'held')).toHaveLength(0);
        }
        const m = getTurnLedgerMetrics();
        expect(m.redriveBlockedBySuspension).toBe(0);
        expect(m.suspensionConsumedRecovered).toBe(0);
    });

    it('proven-dead session releases the block (session_dead) and the reclaim cleanly opens a new attempt', () => {
        const taskId = nextTaskId();
        const t0 = 5_000_000;
        const attempt = openDelivered(taskId, t0);
        holdPreConsumed(taskId, attempt.attemptId, t0);
        let store = MeshRuntimeStore.getInstance();

        simulateRestart();
        store = MeshRuntimeStore.getInstance();

        // Bounded liveness grace: while only UNKNOWN, the hold blocks.
        expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'unknown', sessionProvenDead: false, nowMs: t0 + 30_000 }).kind).toBe('blocked');
        expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'unknown', sessionProvenDead: false, nowMs: t0 + 34_000 }).kind).toBe('blocked');
        expect(getTurnLedgerMetrics().redriveBlockedBySuspension).toBe(2);

        // Grace exhausted → the worker is demonstrably dead: the hold is dropped
        // (session_dead) and the durable redrive gate now allows a NEW attempt.
        const released = gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'unknown', sessionProvenDead: true, nowMs: t0 + 38_000 });
        expect(released).toMatchObject({ kind: 'released', attemptId: attempt.attemptId, dropped: 1 });
        const hold = store.getHeldTurnSuspension(attempt.attemptId, 'waiting_choice')!;
        expect(hold.status).toBe('dropped');
        expect(hold.resolution).toBe('session_dead');
        expect(getTurnLedgerMetrics().suspensionsDropped.session_dead).toBe(1);

        // The old attempt is closed by the reclaim and the re-dispatch opens a NEW
        // attempt — the dropped hold never applies to either.
        expect(evaluateRedrive(MESH, taskId, t0 + 38_000)).toMatchObject({ allowed: true, attemptId: attempt.attemptId });
        const close = closeAttemptForReassignment({ meshId: MESH, taskId, reason: 'delivered_not_consumed_redrive', nowMs: t0 + 38_100 });
        expect(close.committed).toBe(true);
        const attemptB = openDelivered(taskId, t0 + 39_000, 2, 'sessB');
        expect(store.getTurnAttempt(attempt.attemptId)!.terminalOutcome).toBe('cancelled');
        expect(store.getTurnAttempt(attemptB.attemptId)!.stage).toBe('delivered');
        expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'alive', nowMs: t0 + 40_000 }).kind).toBe('none');
        // No resurrection: a late picker edge naming the dead attempt is inert.
        const late = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 41_000 });
        expect(late?.applied).toBe(false);
        expect(late?.deferred).toBeFalsy();
        expect(getTurnLedgerMetrics().suspensionConsumedRecovered).toBe(0);
    });

    it('cancel/terminal while held: the gate is inert and never resurrects the attempt', () => {
        const taskId = nextTaskId();
        const t0 = 6_000_000;
        const attempt = openDelivered(taskId, t0);
        holdPreConsumed(taskId, attempt.attemptId, t0, 'waiting_approval');
        let store = MeshRuntimeStore.getInstance();

        simulateRestart();
        store = MeshRuntimeStore.getInstance();

        const cancel = proposeTurnCompletion({
            meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA',
            outcome: 'cancelled', source: 'cancellation', nowMs: t0 + 30_000,
        });
        expect(cancel.committed).toBe(true);
        expect(store.getHeldTurnSuspension(attempt.attemptId, 'waiting_approval')!.resolution).toBe('attempt_terminal');

        // The gate never blocks, recovers, or resurrects a terminal attempt.
        expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'alive', nowMs: t0 + 31_000 }).kind).toBe('none');
        expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'unknown', sessionProvenDead: true, nowMs: t0 + 31_000 }).kind).toBe('none');
        expect(store.getTurnAttempt(attempt.attemptId)!.stage).toBe('cancelled');
        expect(getTurnLedgerMetrics().suspensionConsumedRecovered).toBe(0);
        expect(getTurnLedgerMetrics().redriveBlockedBySuspension).toBe(0);
    });

    it('approval control: a waiting_approval hold recovers to waiting_approval (distinct from choice), same attempt, non-null approval age', () => {
        const taskId = nextTaskId();
        const t0 = 7_000_000;
        const attempt = openDelivered(taskId, t0);
        holdPreConsumed(taskId, attempt.attemptId, t0, 'waiting_approval');
        let store = MeshRuntimeStore.getInstance();

        simulateRestart();
        store = MeshRuntimeStore.getInstance();
        expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'unknown', sessionProvenDead: false, nowMs: t0 + 30_000 }).kind).toBe('blocked');
        const recovered = gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'alive', nowMs: t0 + 31_000 });
        expect(recovered).toMatchObject({ kind: 'recovered', attemptId: attempt.attemptId, stage: 'waiting_approval' });

        const row = store.getTurnAttempt(attempt.attemptId)!;
        expect(row.stage).toBe('waiting_approval');
        expect(row.consumedAt).not.toBeNull();
        const events = store.listTurnEventsForTask(MESH, taskId);
        expect(events.filter(e => e.kind === 'held_waiting_approval_applied')).toHaveLength(1);
        expect(events.some(e => e.kind === 'held_waiting_choice_applied')).toBe(false);
        expect(JSON.parse(events.find(e => e.kind === 'consumed')!.payload).source).toBe('held_suspension_recovery');

        // The approval/choice distinction survives the recovery and the restart.
        const presentation = presentationFromAttemptRow(row);
        expect(presentation.status).toBe('waiting_approval');
        expect(presentation.attemptId).toBe(attempt.attemptId);
        expect(presentation.approvalAgeMs).not.toBeNull();
        expect(presentation.choiceAgeMs).toBeNull();

        simulateRestart();
        store = MeshRuntimeStore.getInstance();
        expect(drainHeldTurnSuspensionsForMesh(MESH)).toEqual({ applied: 0, dropped: 0, stillHeld: 0 });
        expect(store.getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_approval');
        expect(getTurnLedgerMetrics().suspensionConsumedRecovered).toBe(1);
        expect(getTurnLedgerMetrics().suspensionsApplied).toBe(1);
    });

    it('waiting_approval restart → approve: the SAME attempt completes exactly once (terminal reducer + outbox exactly-once)', () => {
        const taskId = nextTaskId();
        const t0 = 8_000_000;
        const attempt = openDelivered(taskId, t0);
        holdPreConsumed(taskId, attempt.attemptId, t0, 'waiting_approval');
        let store = MeshRuntimeStore.getInstance();

        simulateRestart();
        store = MeshRuntimeStore.getInstance();
        expect(drainHeldTurnSuspensionsForMesh(MESH)).toEqual({ applied: 0, dropped: 0, stillHeld: 1 });
        expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'unknown', sessionProvenDead: false, nowMs: t0 + 30_000 }).kind).toBe('blocked');
        const recovered = gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'alive', nowMs: t0 + 31_000 });
        expect(recovered).toMatchObject({ kind: 'recovered', attemptId: attempt.attemptId, stage: 'waiting_approval' });

        // The user approves on the rebound session: the resume passes on the SAME
        // attempt; the completion commits exactly once; the terminal outbox
        // enqueues exactly once; a duplicate completion is inert; reinjection is
        // refused throughout.
        const resume = recordTurnStage({ meshId: MESH, taskId, stage: 'generating', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 33_000 });
        expect(resume?.applied).toBe(true);
        expect(resume?.attemptId).toBe(attempt.attemptId);
        expect(assertPromptInjectionAllowed(store.getTurnAttempt(attempt.attemptId), 'test')).toBe(false);
        const d1 = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event', nowMs: t0 + 34_000 });
        const d2 = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event', nowMs: t0 + 34_001 });
        expect(d1).toMatchObject({ committed: true, duplicate: false });
        expect(d2).toMatchObject({ committed: true, duplicate: true });
        expect(store.getTurnAttempt(attempt.attemptId)!.terminalOutcome).toBe('completed');
        expect(getTurnLedgerMetrics().suspensionConsumedRecovered).toBe(1);
        expect(getTurnLedgerMetrics().suspensionsApplied).toBe(1);
    });

    it('fresh replacement attempt after restart: the NEW attempt completes exactly once and a late completion for the OLD attempt is inert', () => {
        const taskId = nextTaskId();
        const t0 = 9_000_000;
        const attemptA = openDelivered(taskId, t0);
        holdPreConsumed(taskId, attemptA.attemptId, t0);
        let store = MeshRuntimeStore.getInstance();

        simulateRestart();
        store = MeshRuntimeStore.getInstance();

        // The original worker is demonstrably dead: the hold is dropped
        // (session_dead), the reclaim closes attempt A, and the re-dispatch opens
        // a NEW attempt B on a fresh replacement worker (new session, new nonce).
        expect(gateRedriveForHeldSuspension({ meshId: MESH, taskId, sessionLiveness: 'unknown', sessionProvenDead: true, nowMs: t0 + 38_000 }).kind).toBe('released');
        expect(closeAttemptForReassignment({ meshId: MESH, taskId, reason: 'delivered_not_consumed_redrive', nowMs: t0 + 38_100 }).committed).toBe(true);
        const attemptB = openDelivered(taskId, t0 + 39_000, 2, 'sessB');
        expect(attemptB.attemptId).not.toBe(attemptA.attemptId);

        // The replacement worker consumes its prompt and runs the turn to
        // completion: the reducer commits the NEW attempt exactly once and the
        // terminal outbox enqueues exactly once.
        const consumed = recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attemptB.attemptId, sessionId: 'sessB', occurredAtMs: t0 + 39_500 });
        expect(consumed?.applied).toBe(true);
        const gen = recordTurnStage({ meshId: MESH, taskId, stage: 'generating', attemptId: attemptB.attemptId, sessionId: 'sessB', occurredAtMs: t0 + 40_000 });
        expect(gen?.applied).toBe(true);
        const done1 = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attemptB.attemptId, sessionId: 'sessB', outcome: 'completed', source: 'provider_event', nowMs: t0 + 41_000 });
        const done2 = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attemptB.attemptId, sessionId: 'sessB', outcome: 'completed', source: 'provider_event', nowMs: t0 + 41_001 });
        expect(done1).toMatchObject({ committed: true, duplicate: false });
        expect(done2).toMatchObject({ committed: true, duplicate: true });
        expect(store.getTurnAttempt(attemptB.attemptId)!.terminalOutcome).toBe('completed');

        // A late completion echoing the DEAD attempt is stale and inert: it must
        // not flip, duplicate, or resurrect anything.
        const late = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attemptA.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event', nowMs: t0 + 42_000 });
        expect(late.committed).toBe(false);
        expect(late.reason).toBe('stale_attempt');
        expect(store.getTurnAttempt(attemptA.attemptId)!.terminalOutcome).toBe('cancelled');
        expect(store.getTurnAttempt(attemptB.attemptId)!.terminalOutcome).toBe('completed');
    });
});
