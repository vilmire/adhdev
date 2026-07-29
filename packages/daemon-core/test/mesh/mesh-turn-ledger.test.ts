import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Per-file isolated config dir → per-file mesh-runtime.db (same convention as
// mesh-runtime-store.test.ts). setup-env already isolates ADHDEV_CONFIG_DIR, but a
// dedicated dir keeps this suite's turn tables free of sibling-suite rows.
const testTmpDir = join(tmpdir(), `adhdev-turn-ledger-test-${randomUUID().slice(0, 8)}`);
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
    ensureLegacyTurnAttempt,
    resolveAttemptForTask,
    recordTurnAck,
    recordTurnStage,
    proposeTurnCompletion,
    closeAttemptForReassignment,
    evaluateRedrive,
    markAttemptRedriven,
    classifyNonceEcho,
    reconstructActiveAttempts,
    enqueueTerminalOutbox,
    drainTurnOutbox,
    isPromptInjectionAllowed,
    assertPromptInjectionAllowed,
    canTransitionTurnStage,
    projectTurnAttempt,
    getTurnLedgerMetrics,
    runSessionEvidenceCollection,
    runSessionDestructiveAction,
    __resetSessionOrderChainsForTests,
    __resetTurnLedgerMetricsForTests,
    MAX_REDRIVES_PER_ATTEMPT,
} from '../../src/mesh/mesh-turn-ledger.js';

const MESH = `mesh-${randomUUID().slice(0, 8)}`;
let taskSeq = 0;
function nextTaskId(): string {
    taskSeq += 1;
    return `task-${randomUUID().slice(0, 8)}-${taskSeq}`;
}

function resetStore(): void {
    MeshRuntimeStore.resetForTests();
}

beforeEach(() => {
    __resetTurnLedgerMetricsForTests();
    __resetSessionOrderChainsForTests();
});

afterEach(() => {
    resetStore();
    try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// Simulated daemon restart: close the store instance; the next getInstance reopens
// the SAME on-disk DB, so only durable state survives.
function simulateRestart(): void {
    MeshRuntimeStore.resetForTests();
}

describe('turn ledger — causal stage FSM', () => {
    it('happy path accepted→delivered→consumed→generating→finalizing→completed; repeated/reordered events idempotent', () => {
        const taskId = nextTaskId();
        const t0 = 1_000_000;
        const { attempt, opened } = openTurnAttempt({
            meshId: MESH, taskId, dispatchNonce: 1, nodeId: 'nodeA', sessionId: 'sessA',
            coordinatorDaemonId: 'daemon_mach_x', coordinatorSessionId: 'coordSess', nowMs: t0,
        });
        expect(opened).toBe(true);
        expect(attempt.stage).toBe('accepted');

        // Idempotent re-open (crash between claim and attempt write): same (task, seq).
        const reopen = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: 'sessA', nowMs: t0 + 1 });
        expect(reopen.opened).toBe(false);
        expect(reopen.attempt.attemptId).toBe(attempt.attemptId);

        // delivered
        const d1 = recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId: 'sessA', nowMs: t0 + 10 });
        expect(d1?.applied).toBe(true);
        expect(d1?.stage).toBe('delivered');
        // repeated delivered → idempotent no-op
        const d2 = recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId: 'sessA', nowMs: t0 + 11 });
        expect(d2?.applied).toBe(false);
        expect(d2?.stage).toBe('delivered');

        // consumed
        const c1 = recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId: 'sessA', nowMs: t0 + 20 });
        expect(c1?.applied).toBe(true);
        // REORDERED lower-rank ACK (delivered arrives after consumed) → recorded, no regression
        const dLate = recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId: 'sessA', nowMs: t0 + 21 });
        expect(dLate?.stage).toBe('consumed');
        expect(dLate?.applied).toBe(false);

        // generating → finalizing → completed
        const g = recordTurnStage({ meshId: MESH, taskId, stage: 'generating', attemptId: attempt.attemptId, sessionId: 'sessA', nowMs: t0 + 30 });
        expect(g?.applied).toBe(true);
        const f = recordTurnStage({ meshId: MESH, taskId, stage: 'finalizing', attemptId: attempt.attemptId, sessionId: 'sessA', nowMs: t0 + 40 });
        expect(f?.applied).toBe(true);

        const decision = proposeTurnCompletion({
            meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA',
            outcome: 'completed', source: 'provider_event', nowMs: t0 + 50,
        });
        expect(decision).toMatchObject({ committed: true, attemptId: attempt.attemptId, outcome: 'completed', duplicate: false });

        const after = MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!;
        expect(after.stage).toBe('completed');
        expect(after.terminalOutcome).toBe('completed');
        expect(after.acceptedAt).toBeTruthy();
        expect(after.deliveredAt).toBeTruthy();
        expect(after.consumedAt).toBeTruthy();

        // ACK latency observability was fed (accepted→delivered, delivered→consumed).
        const m = getTurnLedgerMetrics();
        expect(m.ackLatencyCount).toBe(2);
        expect(m.ackLatencyTotalMs).toBe(20);
        expect(m.completionProposalsCommitted).toBe(1);
        expect(m.duplicateTurnEvents).toBeGreaterThanOrEqual(2); // repeated delivered + reordered delivered
    });

    it('transition whitelist: generating cannot precede consumed; terminal never regresses', () => {
        expect(canTransitionTurnStage('accepted', 'delivered')).toBe(true);
        expect(canTransitionTurnStage('delivered', 'accepted')).toBe(false);
        expect(canTransitionTurnStage('accepted', 'generating')).toBe(false);
        expect(canTransitionTurnStage('delivered', 'generating')).toBe(false);
        expect(canTransitionTurnStage('consumed', 'generating')).toBe(true);
        expect(canTransitionTurnStage('generating', 'waiting_approval')).toBe(true);
        expect(canTransitionTurnStage('waiting_approval', 'generating')).toBe(true);
        expect(canTransitionTurnStage('waiting_choice', 'finalizing')).toBe(true);
        expect(canTransitionTurnStage('finalizing', 'completed')).toBe(true);
        expect(canTransitionTurnStage('completed', 'generating')).toBe(false);
        expect(canTransitionTurnStage('cancelled', 'accepted')).toBe(false);

        const taskId = nextTaskId();
        const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: 'sessA' });
        // generating directly from accepted → not applied
        const g = recordTurnStage({ meshId: MESH, taskId, stage: 'generating', attemptId: attempt.attemptId, sessionId: 'sessA' });
        expect(g?.applied).toBe(false);
        expect(MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!.stage).toBe('accepted');
    });
});

describe('turn ledger — crash/restart recovery', () => {
    it('reconstructs the same attempt after a restart at every delivery boundary, without duplicate prompt injection', () => {
        const taskId = nextTaskId();
        const t0 = 2_000_000;
        const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 3, sessionId: 'sessA', nowMs: t0 });

        // ── restart after accepted ──
        simulateRestart();
        let active = reconstructActiveAttempts(MESH);
        expect(active).toHaveLength(1);
        expect(active[0]).toMatchObject({ attemptId: attempt.attemptId, taskId, stage: 'accepted' });
        // accepted → injection still allowed (prompt never reached the provider)
        expect(isPromptInjectionAllowed(MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId))).toBe(true);

        recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId: 'sessA', nowMs: t0 + 10 });

        // ── restart after delivered ──
        simulateRestart();
        active = reconstructActiveAttempts(MESH);
        expect(active).toHaveLength(1);
        expect(active[0].stage).toBe('delivered');
        expect(isPromptInjectionAllowed(MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId))).toBe(true);

        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId: 'sessA', nowMs: t0 + 20 });

        // ── restart after consumed: NEVER re-inject ──
        simulateRestart();
        active = reconstructActiveAttempts(MESH);
        expect(active).toHaveLength(1);
        expect(active[0].stage).toBe('consumed');
        const recovered = MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId);
        expect(assertPromptInjectionAllowed(recovered, 'test')).toBe(false);
        expect(getTurnLedgerMetrics().duplicatePromptPrevented).toBe(1);

        // ── restart after terminal: nothing active, completion not re-committed ──
        proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event', nowMs: t0 + 30 });
        simulateRestart();
        active = reconstructActiveAttempts(MESH);
        expect(active).toHaveLength(0);
        const replay = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event', nowMs: t0 + 40 });
        expect(replay).toMatchObject({ committed: true, duplicate: true });
    });
});

describe('turn ledger — redrive rules', () => {
    it('delivered-not-consumed may redrive once under the same attempt; a consumed attempt never redrives', () => {
        const taskId = nextTaskId();
        const t0 = 3_000_000;
        openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: 'sessA', nowMs: t0 });
        recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', sessionId: 'sessA', nowMs: t0 + 10 });

        // First evaluation: allowed (no lease, no redrive yet, evidence says not consumed).
        const eval1 = evaluateRedrive(MESH, taskId, t0 + 20);
        expect(eval1.allowed).toBe(true);
        markAttemptRedriven({ meshId: MESH, taskId, leaseDurationMs: 60_000, nowMs: t0 + 20 });

        // Second redrive of the SAME attempt: budget exhausted — durable across restart.
        simulateRestart();
        const eval2 = evaluateRedrive(MESH, taskId, t0 + 30);
        expect(eval2).toMatchObject({ allowed: false, reason: 'redrive_budget_exhausted' });
        expect(MAX_REDRIVES_PER_ATTEMPT).toBe(1);

        // A consumed attempt NEVER redrives.
        const task2 = nextTaskId();
        openTurnAttempt({ meshId: MESH, taskId: task2, dispatchNonce: 1, sessionId: 'sessB', nowMs: t0 });
        recordTurnAck({ meshId: MESH, taskId: task2, kind: 'delivered', sessionId: 'sessB', nowMs: t0 + 1 });
        recordTurnAck({ meshId: MESH, taskId: task2, kind: 'consumed', sessionId: 'sessB', nowMs: t0 + 2 });
        expect(evaluateRedrive(MESH, task2, t0 + 3)).toMatchObject({ allowed: false, reason: 'already_consumed' });

        // A terminal attempt NEVER redrives.
        proposeTurnCompletion({ meshId: MESH, taskId: task2, sessionId: 'sessB', outcome: 'completed', source: 'provider_event', nowMs: t0 + 4 });
        expect(evaluateRedrive(MESH, task2, t0 + 5)).toMatchObject({ allowed: false, reason: 'attempt_terminal' });
    });
});

describe('turn ledger — reclaim/reassign attempt identity', () => {
    it('reclaim closes the old attempt; re-dispatch opens a new one; late old-attempt events are rejected and inert', () => {
        const taskId = nextTaskId();
        const t0 = 4_000_000;
        const old = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: 'sessOLD', nowMs: t0 }).attempt;
        recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', attemptId: old.attemptId, sessionId: 'sessOLD', nowMs: t0 + 1 });

        // Reclaim → old attempt terminal (cancelled/reassigned), task continues.
        const close = closeAttemptForReassignment({ meshId: MESH, taskId, reason: 'delivered_not_consumed_redrive', nowMs: t0 + 2 });
        expect(close).toMatchObject({ committed: true, outcome: 'cancelled', duplicate: false });

        // Re-dispatch under the bumped nonce → NEW attempt identity.
        const fresh = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 2, sessionId: 'sessNEW', nowMs: t0 + 3 });
        expect(fresh.opened).toBe(true);
        expect(fresh.attempt.attemptId).not.toBe(old.attemptId);

        // Late old-attempt ACK: recorded, but rejected/inert — the new attempt is untouched.
        const staleAck = recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: old.attemptId, sessionId: 'sessOLD', nowMs: t0 + 4 });
        expect(staleAck?.staleAttempt).toBe(true);
        expect(staleAck?.applied).toBe(false);
        expect(MeshRuntimeStore.getInstance().getTurnAttempt(fresh.attempt.attemptId)!.stage).toBe('accepted');

        // Late old-attempt generating/approval events: recorded stale, no mutation.
        const staleGen = recordTurnStage({ meshId: MESH, taskId, stage: 'generating', attemptId: old.attemptId, sessionId: 'sessOLD', nowMs: t0 + 5 });
        expect(staleGen?.staleAttempt).toBe(true);
        const staleApproval = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_approval', attemptId: old.attemptId, sessionId: 'sessOLD', nowMs: t0 + 6 });
        expect(staleApproval?.staleAttempt).toBe(true);

        // Late old-attempt completion: rejected with a typed, observable reason.
        const staleCompletion = proposeTurnCompletion({
            meshId: MESH, taskId, attemptId: old.attemptId, sessionId: 'sessOLD',
            outcome: 'completed', source: 'provider_event', nowMs: t0 + 7,
        });
        expect(staleCompletion).toMatchObject({ committed: false, reason: 'stale_attempt' });
        const metrics = getTurnLedgerMetrics();
        expect(metrics.completionProposalsRejected.stale_attempt).toBe(1);
        expect(metrics.staleAttemptEvents).toBeGreaterThanOrEqual(4);
        // The new attempt is unaffected by every late event above.
        expect(MeshRuntimeStore.getInstance().getTurnAttempt(fresh.attempt.attemptId)!.stage).toBe('accepted');
        expect(MeshRuntimeStore.getInstance().getTurnAttempt(fresh.attempt.attemptId)!.terminalOutcome).toBeNull();
    });

    it('same-session resumption echoing a pre-reclaim nonce does NOT kill the current assignee', () => {
        const taskId = nextTaskId();
        // Dispatch under nonce 1 to sessA; reclaim bumps to 2; re-dispatch SAME session.
        openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: 'sessA' });
        closeAttemptForReassignment({ meshId: MESH, taskId, reason: 'assigned_stranded_dispatch_unconfirmed' });
        const current = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 2, sessionId: 'sessA' }).attempt;

        // The resumed worker echoes nonce 1 (< current 2) — from the CURRENT assignee session.
        const compat = classifyNonceEcho({ meshId: MESH, taskId, sessionId: 'sessA', nonce: 1, currentNonce: 2 });
        expect(compat).toBe('same_session_compat');
        expect(getTurnLedgerMetrics().sameSessionStaleNonceCompatAccepted).toBe(1);

        // The SAME stale nonce echoed by a DIFFERENT session is a genuinely stale dispatch.
        const stale = classifyNonceEcho({ meshId: MESH, taskId, sessionId: 'sessOTHER', nonce: 1, currentNonce: 2 });
        expect(stale).toBe('stale');

        // Absent nonce / fresh nonce → current (backward safe).
        expect(classifyNonceEcho({ meshId: MESH, taskId, sessionId: 'sessOTHER', nonce: undefined, currentNonce: 2 })).toBe('current');
        expect(classifyNonceEcho({ meshId: MESH, taskId, sessionId: 'sessOTHER', nonce: 2, currentNonce: 2 })).toBe('current');
        void current;
    });
});

describe('turn ledger — exactly-once completion', () => {
    it('two concurrent completion proposals commit exactly one terminal; the loser reason is observable', () => {
        const taskId = nextTaskId();
        const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: 'sessA' });
        recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', sessionId: 'sessA' });
        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', sessionId: 'sessA' });
        recordTurnStage({ meshId: MESH, taskId, stage: 'generating', sessionId: 'sessA' });

        // Provider event and stall reconciliation race to complete the same attempt.
        const first = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event' });
        const second = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'failed', source: 'stall_reconcile' });
        expect(first).toMatchObject({ committed: true, outcome: 'completed', duplicate: false });
        expect(second).toMatchObject({ committed: false, reason: 'already_terminal', existingOutcome: 'completed' });

        const row = MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!;
        expect(row.terminalOutcome).toBe('completed');
        expect(getTurnLedgerMetrics().completionProposalsRejected.already_terminal).toBe(1);

        // Same-outcome replay is an idempotent duplicate, not a rejection.
        const replay = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'transcript' });
        expect(replay).toMatchObject({ committed: true, duplicate: true });
    });

    it('rejects wrong-session and wrong-epoch proposals (causality validation)', () => {
        const taskId = nextTaskId();
        const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 5, sessionId: 'sessA' });
        const wrongSession = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessEVIL', outcome: 'completed', source: 'provider_event' });
        expect(wrongSession).toMatchObject({ committed: false, reason: 'session_mismatch' });
        const wrongEpoch = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, outcome: 'completed', source: 'provider_event', epoch: 4 });
        expect(wrongEpoch).toMatchObject({ committed: false, reason: 'epoch_mismatch' });
        // Session authority wins over a lagging epoch (same-session resumption).
        const resumed = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event', epoch: 4 });
        expect(resumed).toMatchObject({ committed: true, outcome: 'completed' });
    });
});

describe('turn ledger — approval/choice are suspended, never completion', () => {
    it('waiting_approval / waiting_choice never complete; resume continues the SAME attempt', () => {
        const taskId = nextTaskId();
        const t0 = 5_000_000;
        const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: 'sessA', nowMs: t0 });
        recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', sessionId: 'sessA', nowMs: t0 + 1 });
        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', sessionId: 'sessA', nowMs: t0 + 2 });
        recordTurnStage({ meshId: MESH, taskId, stage: 'generating', sessionId: 'sessA', nowMs: t0 + 3 });

        const wa = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_approval', sessionId: 'sessA', nowMs: t0 + 4 });
        expect(wa?.applied).toBe(true);
        let row = MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!;
        expect(row.stage).toBe('waiting_approval');
        expect(row.terminalOutcome).toBeNull();

        const wc = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', sessionId: 'sessA', nowMs: t0 + 5 });
        expect(wc?.applied).toBe(true);
        row = MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!;
        expect(row.stage).toBe('waiting_choice');
        expect(row.terminalOutcome).toBeNull();

        // Resume: SAME attempt, no new prompt, back to generating.
        const resume = recordTurnStage({ meshId: MESH, taskId, stage: 'generating', sessionId: 'sessA', nowMs: t0 + 6 });
        expect(resume?.applied).toBe(true);
        row = MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!;
        expect(row.stage).toBe('generating');
        expect(row.attemptId).toBe(attempt.attemptId);
        expect(isPromptInjectionAllowed(row)).toBe(false); // consumed earlier — resume never re-injects

        // Only an explicit proposal completes.
        const decision = proposeTurnCompletion({ meshId: MESH, taskId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event', nowMs: t0 + 7 });
        expect(decision.committed).toBe(true);
    });
});

describe('turn ledger — evidence/stop ordering (6ms race)', () => {
    it('a destructive stop requested mid-read executes strictly after the evidence read resolves', async () => {
        const order: string[] = [];
        let releaseRead!: () => void;
        // The transcript evidence read is IN FLIGHT (the historical 6ms window)…
        const gate = new Promise<void>((resolve) => {
            releaseRead = () => { order.push('evidence_read'); resolve(); };
        });
        const read = runSessionEvidenceCollection('sessRACE', () => gate);
        // …when the stale-worker teardown is issued against the same session.
        const stop = runSessionDestructiveAction('sessRACE', () => {
            order.push('teardown');
        });
        // The read resolves AFTER the stop was requested — ordering must still hold.
        releaseRead();
        await Promise.all([read, stop]);
        expect(order).toEqual(['evidence_read', 'teardown']);

        // A reducer decision chained between them keeps the full causal order.
        const order2: string[] = [];
        let release2!: () => void;
        const gate2 = new Promise<string>((resolve) => {
            release2 = () => { order2.push('read'); resolve('evidence'); };
        });
        const read2 = runSessionEvidenceCollection('sessRACE2', () => gate2);
        const decided = read2.then((ev) => { order2.push(`decide:${ev}`); });
        const stop2 = runSessionDestructiveAction('sessRACE2', () => { order2.push('stop'); });
        release2();
        await Promise.all([read2, decided, stop2]);
        expect(order2).toEqual(['read', 'decide:evidence', 'stop']);
    });
});

describe('turn ledger — durable outbox / restart delivery', () => {
    it('enqueue is exactly-once; a restart with a pending outbox row delivers exactly one coordinator completion', async () => {
        const taskId = nextTaskId();
        const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: 'sessA' });
        proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event' });

        const enq1 = enqueueTerminalOutbox({ meshId: MESH, taskId, attemptId: attempt.attemptId, outcome: 'completed', payload: { event: 'agent:generating_completed', sessionId: 'sessA' } });
        expect(enq1).toBe(true);
        // Re-enqueue (crash replay) — INSERT OR IGNORE, exactly one row.
        const enq2 = enqueueTerminalOutbox({ meshId: MESH, taskId, attemptId: attempt.attemptId, outcome: 'completed', payload: { event: 'agent:generating_completed', sessionId: 'sessA' } });
        expect(enq2).toBe(false);

        // Fault injection: the first delivery attempt fails AFTER the commit → rescheduled, not lost.
        const failDrain = await drainTurnOutbox(async () => { throw new Error('transport down'); }, { backoffMs: () => 0 });
        expect(failDrain).toMatchObject({ delivered: 0, failed: 0, rescheduled: 1 });

        // ── daemon restart with the row still pending ──
        simulateRestart();
        const deliveries: string[] = [];
        const drain = await drainTurnOutbox(async (row) => { deliveries.push(row.id); }, { nowMs: Date.now() + 1 });
        expect(drain).toMatchObject({ delivered: 1, failed: 0, rescheduled: 0 });
        expect(deliveries).toEqual([`${attempt.attemptId}:terminal`]);

        // A later drain (any tick) finds nothing due — exactly one delivery.
        const again = await drainTurnOutbox(async (row) => { deliveries.push(row.id); });
        expect(again).toMatchObject({ delivered: 0, failed: 0, rescheduled: 0 });
        expect(deliveries).toHaveLength(1);
        const metrics = getTurnLedgerMetrics();
        expect(metrics.outboxByStatus.delivered).toBe(1);
    });

    it('outbox rows that exhaust their retry budget park as failed (observable, never silent)', async () => {
        const taskId = nextTaskId();
        const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: 'sessA' });
        enqueueTerminalOutbox({ meshId: MESH, taskId, attemptId: attempt.attemptId, outcome: 'failed', payload: {} });
        const result = await drainTurnOutbox(async () => { throw new Error('permanent'); }, { maxAttempts: 1 });
        expect(result).toMatchObject({ delivered: 0, failed: 1, rescheduled: 0 });
        expect(getTurnLedgerMetrics().outboxByStatus.failed).toBe(1);
    });
});

describe('turn ledger — cancellation at every stage', () => {
    const stages: Array<{ name: string; advance: (taskId: string) => void }> = [
        { name: 'accepted', advance: () => { /* open state */ } },
        { name: 'delivered', advance: (taskId) => recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', sessionId: 'sessA' }) },
        { name: 'consumed', advance: (taskId) => { recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', sessionId: 'sessA' }); recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', sessionId: 'sessA' }); } },
        { name: 'generating', advance: (taskId) => { recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', sessionId: 'sessA' }); recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', sessionId: 'sessA' }); recordTurnStage({ meshId: MESH, taskId, stage: 'generating', sessionId: 'sessA' }); } },
        { name: 'finalizing', advance: (taskId) => { recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', sessionId: 'sessA' }); recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', sessionId: 'sessA' }); recordTurnStage({ meshId: MESH, taskId, stage: 'finalizing', sessionId: 'sessA' }); } },
    ];
    for (const { name, advance } of stages) {
        it(`cancel at ${name}: commits cancelled, later completion is rejected, no resurrection`, () => {
            const taskId = nextTaskId();
            const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: 'sessA' });
            advance(taskId);
            expect(MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!.stage).toBe(name);

            const cancel = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, outcome: 'cancelled', source: 'cancellation', reason: 'operator_cancel' });
            expect(cancel).toMatchObject({ committed: true, outcome: 'cancelled', duplicate: false });

            // No later resurrection: a racing worker completion is rejected.
            const late = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event' });
            expect(late).toMatchObject({ committed: false, reason: 'already_terminal', existingOutcome: 'cancelled' });
            // Stage writes after terminal are inert.
            const ack = recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId: 'sessA' });
            expect(ack?.applied).toBe(false);
            const row = MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!;
            expect(row.stage).toBe('cancelled');
            expect(row.terminalOutcome).toBe('cancelled');
        });
    }
});

describe('turn ledger — legacy compatibility / migration', () => {
    it('a pre-Stage-5 task (no attempt) gets a deterministic legacy attempt — without fabricating evidence', () => {
        const taskId = nextTaskId();
        // First touch via a provider-envelope-shaped ACK that carries no attemptId.
        const ack1 = recordTurnAck({
            meshId: MESH, taskId, kind: 'delivered', sessionId: 'sessLEGACY',
            legacy: { dispatchNonce: 2, nodeId: 'nodeA', providerType: 'kimi-cli' },
        });
        expect(ack1).not.toBeNull();
        const attemptId = ack1!.attemptId;
        expect(attemptId).toBe(`legacy-${taskId}-2`);
        // Idempotent: the same lazy migration resolves the SAME row every time.
        const again = ensureLegacyTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 2, sessionId: 'sessLEGACY' });
        expect(again.attemptId).toBe(attemptId);
        // The delivered ACK was genuinely recorded (not fabricated at migration time):
        // migration opened at 'accepted'; the ACK advanced it exactly once.
        const row = MeshRuntimeStore.getInstance().getTurnAttempt(attemptId)!;
        expect(row.stage).toBe('delivered');
        expect(row.consumedAt).toBeNull(); // no consumed/completed evidence was ever fabricated
        expect(row.terminalOutcome).toBeNull();
    });

    it('legacy provider envelope (no attemptId, no nonce) still correlates and completes exactly once', () => {
        const taskId = nextTaskId();
        // Legacy worker: events carry taskId + sessionId only.
        recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', sessionId: 'sessLEGACY' });
        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', sessionId: 'sessLEGACY' });
        const decision = proposeTurnCompletion({ meshId: MESH, taskId, sessionId: 'sessLEGACY', outcome: 'completed', source: 'provider_event' });
        expect(decision.committed).toBe(true);
        const replay = proposeTurnCompletion({ meshId: MESH, taskId, sessionId: 'sessLEGACY', outcome: 'completed', source: 'transcript' });
        expect(replay).toMatchObject({ committed: true, duplicate: true });
    });

    it('resolveAttemptForTask never cross-correlates an attemptId from another task/mesh', () => {
        const taskA = nextTaskId();
        const taskB = nextTaskId();
        const a = openTurnAttempt({ meshId: MESH, taskId: taskA, dispatchNonce: 1 }).attempt;
        // attemptId of A presented for task B → not resolved to A.
        const resolved = resolveAttemptForTask(MESH, taskB, { attemptId: a.attemptId });
        expect(resolved?.attemptId).not.toBe(a.attemptId);
        const resolvedOtherMesh = resolveAttemptForTask(`mesh-other-${randomUUID().slice(0, 6)}`, taskA, { attemptId: a.attemptId });
        expect(resolvedOtherMesh).toBeNull();
    });
});

describe('turn ledger — Stage 6 projection boundary', () => {
    it('projectTurnAttempt exposes the causal stage incl. finalizing for the next stage', () => {
        const taskId = nextTaskId();
        const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 7, sessionId: 'sessA', providerType: 'kimi-cli', coordinatorDaemonId: 'daemon_mach_x' });
        recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', sessionId: 'sessA' });
        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', sessionId: 'sessA' });
        recordTurnStage({ meshId: MESH, taskId, stage: 'generating', sessionId: 'sessA' });
        recordTurnStage({ meshId: MESH, taskId, stage: 'finalizing', sessionId: 'sessA' });
        const proj = projectTurnAttempt(MESH, taskId);
        expect(proj).toMatchObject({
            attemptId: attempt.attemptId,
            taskId,
            attemptSeq: 7,
            stage: 'finalizing',
            terminalOutcome: null,
            sessionId: 'sessA',
            providerType: 'kimi-cli',
            coordinatorDaemonId: 'daemon_mach_x',
            dispatchNonce: 7,
        });
        expect(proj?.acceptedAt).toBeTruthy();
        expect(proj?.deliveredAt).toBeTruthy();
        expect(proj?.consumedAt).toBeTruthy();
        // Unknown task → null (no fabrication).
        expect(projectTurnAttempt(MESH, 'task-does-not-exist')).toBeNull();
    });
});

describe('turn ledger — session-binding guard (terminal-stale-approval-projection)', () => {
    // A progress event is only evidence about an attempt when it comes from the session the
    // attempt is BOUND to. A late waiting_approval from an OLD (pre-redrive) session — no
    // attemptId on the event, so it resolves to the CURRENT attempt — must never pin that
    // attempt to waiting_approval: the new session exposes no such modal (mesh_approve →
    // "Not in approval state") yet every projection would read awaiting_approval.
    it('a waiting_approval from a DIFFERENT session than the attempt binding is audit-only — the stage never moves', () => {
        const taskId = nextTaskId();
        const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 2, sessionId: 'sessNEW', nowMs: 1_000 });
        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId: 'sessNEW', nowMs: 1_010 });

        const late = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_approval', sessionId: 'sessOLD', nowMs: 1_020 });
        expect(late?.applied).toBe(false);
        expect(late?.staleAttempt).toBe(true);
        expect(MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!.stage).toBe('consumed');

        // Control: the BOUND session's genuine approval still suspends the attempt.
        const genuine = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_approval', sessionId: 'sessNEW', nowMs: 1_030 });
        expect(genuine?.applied).toBe(true);
        expect(MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_approval');
    });

    it('a mismatched-session suspension is never HELD either (pre-consumed fast-picker race)', () => {
        const taskId = nextTaskId();
        const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 2, sessionId: 'sessNEW', nowMs: 1_000 });
        recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId: 'sessNEW', nowMs: 1_010 });

        // Pre-consumed attempt + approval from the OLD session → must not create a held
        // suspension that a later consumed ACK would drain into the new attempt.
        const late = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_approval', sessionId: 'sessOLD', nowMs: 1_020 });
        expect(late?.staleAttempt).toBe(true);
        expect(late?.deferred).not.toBe(true);
        expect(MeshRuntimeStore.getInstance().listHeldTurnSuspensionsForAttempt(attempt.attemptId, 'held')).toHaveLength(0);

        // Control: the bound session's pre-consumed approval still holds + drains.
        const held = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_approval', sessionId: 'sessNEW', nowMs: 1_030 });
        expect(held?.deferred).toBe(true);
        expect(MeshRuntimeStore.getInstance().listHeldTurnSuspensionsForAttempt(attempt.attemptId, 'held')).toHaveLength(1);
        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId: 'sessNEW', nowMs: 1_040 });
        expect(MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_approval');
    });

    it('a session-less event keeps legacy behavior (guard only fires when BOTH session ids are known)', () => {
        const taskId = nextTaskId();
        const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: 'sessA', nowMs: 1_000 });
        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId: 'sessA', nowMs: 1_010 });
        const noSession = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_approval', nowMs: 1_020 });
        expect(noSession?.applied).toBe(true);
        expect(MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_approval');
    });
});
