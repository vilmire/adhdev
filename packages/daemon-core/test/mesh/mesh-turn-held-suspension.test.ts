import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Per-file isolated config dir → per-file mesh-runtime.db (same convention as
// mesh-turn-ledger.test.ts). Keeps this suite's turn tables free of sibling rows.
const testTmpDir = join(tmpdir(), `adhdev-turn-held-suspension-test-${randomUUID().slice(0, 8)}`);
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
    assertPromptInjectionAllowed,
    projectTurnAttempt,
    getTurnLedgerMetrics,
    __resetTurnLedgerMetricsForTests,
} from '../../src/mesh/mesh-turn-ledger.js';
import {
    presentationFromAttemptRow,
    turnStageToSurfaceStatus,
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

describe('held suspensions — waiting_choice before consumed (the fast-picker race)', () => {
    it('holds the pre-consumed waiting_choice, then consumed drains it through the FSM with the full causal chain', () => {
        const taskId = nextTaskId();
        const t0 = 1_000_000;
        const attempt = openDelivered(taskId, t0);
        const genTs = t0 + 20;    // generating_started occurrence time (processed AFTER the picker edge)
        const choiceTs = t0 + 25; // picker appears after turn start, arrives BEFORE consumed is durable

        // Raced arrival: waiting_choice while the attempt is still delivered.
        const w = recordTurnStage({
            meshId: MESH, taskId, stage: 'waiting_choice', attemptId: attempt.attemptId,
            sessionId: 'sessA', occurredAtMs: choiceTs,
        });
        expect(w?.deferred).toBe(true);
        expect(w?.applied).toBe(false);
        expect(w?.stage).toBe('delivered'); // consumed NOT skipped — no causal jump

        // Consumed lands (generating_started processed late): the SAME transaction
        // drains the hold through the FSM.
        const c = recordTurnAck({
            meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId,
            sessionId: 'sessA', occurredAtMs: genTs,
        });
        expect(c?.applied).toBe(true);

        const store = MeshRuntimeStore.getInstance();
        const afterConsumed = store.getTurnAttempt(attempt.attemptId)!;
        expect(afterConsumed.consumedAt).not.toBeNull();
        expect(afterConsumed.stage).toBe('waiting_choice');

        // The paired generating echo (same generating_started event, OLDER occurrence
        // time than the picker) must not regress the parked picker.
        const g = recordTurnStage({
            meshId: MESH, taskId, stage: 'generating', attemptId: attempt.attemptId,
            sessionId: 'sessA', occurredAtMs: genTs,
        });
        expect(g?.applied).toBe(false);
        expect(store.getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_choice');

        // The persisted causal chain shows consumed AND the deferred application.
        const kinds = store.listTurnEventsForTask(MESH, taskId).map(e => e.kind);
        expect(kinds).toContain('accepted');
        expect(kinds).toContain('delivered');
        expect(kinds).toContain('consumed');
        expect(kinds).toContain('waiting_choice');
        expect(kinds).toContain('held_waiting_choice_applied');

        // Projection: waiting_choice + consumed link + SAME attemptId on every surface
        // (read_chat / session_status / mesh_status / active_work all derive from this row).
        const proj = projectTurnAttempt(MESH, taskId)!;
        expect(proj.attemptId).toBe(attempt.attemptId);
        expect(proj.stage).toBe('waiting_choice');
        expect(proj.consumedAt).not.toBeNull();
        expect(proj.deliveredAt).not.toBeNull();

        const presentation = presentationFromAttemptRow(store.getTurnAttempt(attempt.attemptId)!);
        expect(presentation.authority).toBe('turn_reducer');
        expect(presentation.status).toBe('waiting_choice');
        expect(presentation.stage).toBe('waiting_choice');
        expect(presentation.attemptId).toBe(attempt.attemptId);
        expect(presentation.choiceAgeMs).not.toBeNull();
        expect(presentation.choiceAgeMs!).toBeGreaterThanOrEqual(0);
        expect(presentation.approvalAgeMs).toBeNull();
        expect(turnStageToSurfaceStatus('waiting_choice')).toBe('waiting_choice');

        // Typed, content-free counters.
        const m = getTurnLedgerMetrics();
        expect(m.suspensionsHeld).toBe(1);
        expect(m.suspensionsApplied).toBe(1);
        expect(m.reorderedGeneratingSuppressed).toBe(1);
        expect(m.suspensionsDropped).toEqual({});
    });

    it('waiting_approval before consumed gets the equivalent ordering-tolerant control', () => {
        const taskId = nextTaskId();
        const t0 = 2_000_000;
        const attempt = openDelivered(taskId, t0);
        const genTs = t0 + 20;
        const approvalTs = t0 + 25;

        const w = recordTurnStage({
            meshId: MESH, taskId, stage: 'waiting_approval', attemptId: attempt.attemptId,
            sessionId: 'sessA', occurredAtMs: approvalTs,
        });
        expect(w?.deferred).toBe(true);

        recordTurnAck({
            meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId,
            sessionId: 'sessA', occurredAtMs: genTs,
        });
        const store = MeshRuntimeStore.getInstance();
        expect(store.getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_approval');

        // The approval/choice distinction is preserved — a choice drain never flips
        // an approval into the wrong inbox and vice versa.
        const presentation = presentationFromAttemptRow(store.getTurnAttempt(attempt.attemptId)!);
        expect(presentation.status).toBe('waiting_approval');
        expect(presentation.approvalAgeMs).not.toBeNull();
        expect(presentation.choiceAgeMs).toBeNull();

        const kinds = store.listTurnEventsForTask(MESH, taskId).map(e => e.kind);
        expect(kinds).toContain('held_waiting_approval_applied');
        expect(kinds).not.toContain('held_waiting_choice_applied');
    });

    it('duplicate suspension and duplicate consumed are idempotent', () => {
        const taskId = nextTaskId();
        const t0 = 3_000_000;
        const attempt = openDelivered(taskId, t0);
        const genTs = t0 + 20;
        const choiceTs = t0 + 25;

        const w1 = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: choiceTs });
        const w2 = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: choiceTs });
        expect(w1?.deferred).toBe(true);
        expect(w2?.deferred).toBe(true);
        expect(getTurnLedgerMetrics().suspensionsHeld).toBe(1); // insert-once hold

        const c1 = recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: genTs });
        const c2 = recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: genTs });
        expect(c1?.applied).toBe(true);
        expect(c2?.applied).toBe(false);

        const store = MeshRuntimeStore.getInstance();
        expect(store.getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_choice');
        expect(getTurnLedgerMetrics().suspensionsApplied).toBe(1); // drained exactly once

        // A duplicate picker edge after the drain is absorbed without duplicating the apply.
        recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: choiceTs });
        expect(getTurnLedgerMetrics().suspensionsApplied).toBe(1);
        expect(store.getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_choice');
    });

    it('crash/reopen after the hold but before consumed: the restart drain waits, then the live consumed drains exactly once', () => {
        const taskId = nextTaskId();
        const t0 = 4_000_000;
        const attempt = openDelivered(taskId, t0);
        const genTs = t0 + 20;
        const choiceTs = t0 + 25;

        recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: choiceTs });
        expect(getTurnLedgerMetrics().suspensionsHeld).toBe(1);

        simulateRestart();

        // Restart reconcile drain: consumed not durable yet → stays held, nothing applied.
        const preDrain = drainHeldTurnSuspensionsForMesh(MESH);
        expect(preDrain.applied).toBe(0);
        expect(preDrain.dropped).toBe(0);
        expect(preDrain.stillHeld).toBe(1);

        // The live consumed ACK lands after the restart → drains the durable hold once.
        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: genTs });
        expect(MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_choice');
        expect(getTurnLedgerMetrics().suspensionsApplied).toBe(1);

        // A second restart + drain is a no-op (exactly-once application, no reinjection/redrive).
        simulateRestart();
        const postDrain = drainHeldTurnSuspensionsForMesh(MESH);
        expect(postDrain.applied).toBe(0);
        expect(postDrain.dropped).toBe(0);
        expect(postDrain.stillHeld).toBe(0);
        expect(MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_choice');
        expect(getTurnLedgerMetrics().suspensionsApplied).toBe(1);
    });

    it('restart after a drained hold: the reconcile drain is convergent (no duplicate apply, no stage churn)', () => {
        const taskId = nextTaskId();
        const t0 = 5_000_000;
        const attempt = openDelivered(taskId, t0);
        const genTs = t0 + 20;
        const choiceTs = t0 + 25;

        recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: choiceTs });
        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: genTs });
        // The consumed commit drains the hold atomically in the same process.
        expect(MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_choice');

        // Even after a restart the drain is convergent (no duplicate apply).
        simulateRestart();
        const drain = drainHeldTurnSuspensionsForMesh(MESH);
        expect(drain.applied).toBe(0);
        expect(drain.stillHeld).toBe(0);
        expect(MeshRuntimeStore.getInstance().getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_choice');
    });

    it('a hold on a stale (reassigned) attempt is dropped and can never affect the new assignee', () => {
        const taskId = nextTaskId();
        const t0 = 6_000_000;
        const attemptA = openDelivered(taskId, t0, 1, 'sessA');

        const w = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', attemptId: attemptA.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 25 });
        expect(w?.deferred).toBe(true);

        // Reassignment closes attempt A (cancelled) → its held suspension is dropped.
        const close = closeAttemptForReassignment({ meshId: MESH, taskId, reason: 'reclaim', nowMs: t0 + 30 });
        expect(close.committed).toBe(true);
        const store = MeshRuntimeStore.getInstance();
        const holdA = store.getHeldTurnSuspension(attemptA.attemptId, 'waiting_choice')!;
        expect(holdA.status).toBe('dropped');
        expect(holdA.resolution).toBe('attempt_terminal');
        expect(getTurnLedgerMetrics().suspensionsDropped.attempt_terminal).toBe(1);

        // New dispatch → new attempt B on a new epoch/session.
        const attemptB = openDelivered(taskId, t0 + 100, 2, 'sessB');

        // A late picker edge naming the OLD attempt is stale: recorded-but-rejected,
        // no new hold, and attempt B is untouched.
        const staleW = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', attemptId: attemptA.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 120 });
        expect(staleW?.staleAttempt).toBe(true);
        expect(staleW?.deferred).toBeFalsy();
        expect(store.listHeldTurnSuspensionsForAttempt(attemptB.attemptId, 'held')).toHaveLength(0);
        expect(store.getTurnAttempt(attemptB.attemptId)!.stage).toBe('delivered');

        // Attempt B drives its own lifecycle normally and reaches the picker.
        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attemptB.attemptId, sessionId: 'sessB', occurredAtMs: t0 + 130 });
        recordTurnStage({ meshId: MESH, taskId, stage: 'generating', attemptId: attemptB.attemptId, sessionId: 'sessB', occurredAtMs: t0 + 131 });
        const bChoice = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', attemptId: attemptB.attemptId, sessionId: 'sessB', occurredAtMs: t0 + 140 });
        expect(bChoice?.applied).toBe(true);
        const proj = projectTurnAttempt(MESH, taskId)!;
        expect(proj.attemptId).toBe(attemptB.attemptId);
        expect(proj.stage).toBe('waiting_choice');
        // Attempt A's hold never applied.
        expect(store.getHeldTurnSuspension(attemptA.attemptId, 'waiting_choice')!.status).toBe('dropped');
    });

    it('terminal / cancel while held: the hold is dropped and the attempt never resurrects', () => {
        // (a) completed while held
        {
            const taskId = nextTaskId();
            const t0 = 7_000_000;
            const attempt = openDelivered(taskId, t0);
            recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 25 });
            const decision = proposeTurnCompletion({
                meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA',
                outcome: 'completed', source: 'provider_event', nowMs: t0 + 30,
            });
            expect(decision.committed).toBe(true);
            const store = MeshRuntimeStore.getInstance();
            expect(store.getHeldTurnSuspension(attempt.attemptId, 'waiting_choice')!.status).toBe('dropped');
            expect(store.getHeldTurnSuspension(attempt.attemptId, 'waiting_choice')!.resolution).toBe('attempt_terminal');
            // No resurrection: drains and late edges stay inert.
            expect(drainHeldTurnSuspensionsForMesh(MESH).applied).toBe(0);
            const late = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 40 });
            expect(late?.applied).toBe(false);
            expect(late?.deferred).toBeFalsy();
            expect(store.getTurnAttempt(attempt.attemptId)!.stage).toBe('completed');
        }
        // (b) cancelled while held
        {
            const taskId = nextTaskId();
            const t0 = 7_100_000;
            const attempt = openDelivered(taskId, t0);
            recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_approval', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 25 });
            const decision = proposeTurnCompletion({
                meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA',
                outcome: 'cancelled', source: 'cancellation', nowMs: t0 + 30,
            });
            expect(decision.committed).toBe(true);
            const store = MeshRuntimeStore.getInstance();
            expect(store.getHeldTurnSuspension(attempt.attemptId, 'waiting_approval')!.status).toBe('dropped');
            expect(drainHeldTurnSuspensionsForMesh(MESH).applied).toBe(0);
            expect(store.getTurnAttempt(attempt.attemptId)!.stage).toBe('cancelled');
        }
    });

    it('answer around the drain boundary: same attempt resumes, no duplicate prompt/completion/outbox', () => {
        const taskId = nextTaskId();
        const t0 = 8_000_000;
        const attempt = openDelivered(taskId, t0);
        const genTs = t0 + 20;
        const choiceTs = t0 + 25;

        recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: choiceTs });
        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: genTs });
        const store = MeshRuntimeStore.getInstance();
        expect(store.getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_choice');

        // The picker answer arrives: a genuine resume carries a NEWER occurrence time
        // and passes the reordered-generating guard on the SAME attempt.
        const resume = recordTurnStage({ meshId: MESH, taskId, stage: 'generating', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 60 });
        expect(resume?.applied).toBe(true);
        expect(resume?.attemptId).toBe(attempt.attemptId);
        expect(store.getTurnAttempt(attempt.attemptId)!.stage).toBe('generating');

        // No duplicate prompt injection is ever permitted for this attempt.
        expect(assertPromptInjectionAllowed(store.getTurnAttempt(attempt.attemptId), 'test')).toBe(false);

        // Completion is exactly-once, and the terminal outbox enqueue is exactly-once.
        const d1 = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event', nowMs: t0 + 70 });
        const d2 = proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event', nowMs: t0 + 71 });
        expect(d1).toMatchObject({ committed: true, duplicate: false });
        expect(d2).toMatchObject({ committed: true, duplicate: true });
        // ★ Stage 5c-2 settles the 5c-1 marker that stood here. Two
        // `enqueueTerminalOutbox` assertions followed, checking the outbox row was
        // INSERT-OR-IGNORE exactly-once for this attempt. The reducer half above
        // (committed/duplicate) survives and is asserted; the delivery half is NOT
        // restated here, deliberately — the redrive leg has no per-attempt cursor
        // to assert against. It is keyed by PROJECTED LEDGER ENTRY, so "the
        // terminal is delivered exactly once" is no longer a property this
        // attempt-scoped suite can observe. It is asserted where it now lives:
        // test/mesh/mesh-terminal-redrive-restart.test.ts.
    });

    it('normal in-order path is unchanged: direct suspension, no hold, no defer', () => {
        const taskId = nextTaskId();
        const t0 = 9_000_000;
        const attempt = openDelivered(taskId, t0);

        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 20 });
        const g = recordTurnStage({ meshId: MESH, taskId, stage: 'generating', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 20 });
        expect(g?.applied).toBe(true);
        const w = recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 30 });
        expect(w?.applied).toBe(true);
        expect(w?.deferred).toBeFalsy();

        const store = MeshRuntimeStore.getInstance();
        expect(store.getTurnAttempt(attempt.attemptId)!.stage).toBe('waiting_choice');
        expect(store.listHeldTurnSuspensionsForAttempt(attempt.attemptId)).toHaveLength(0);

        // Resume and finish as before.
        expect(recordTurnStage({ meshId: MESH, taskId, stage: 'generating', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 40 })?.applied).toBe(true);
        expect(recordTurnStage({ meshId: MESH, taskId, stage: 'finalizing', attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 50 })?.applied).toBe(true);
        expect(proposeTurnCompletion({ meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: 'sessA', outcome: 'completed', source: 'provider_event', nowMs: t0 + 60 }).committed).toBe(true);

        const m = getTurnLedgerMetrics();
        expect(m.suspensionsHeld).toBe(0);
        expect(m.suspensionsApplied).toBe(0);
        expect(m.reorderedGeneratingSuppressed).toBe(0);
    });

    it('observability stays content-free and bounded: hold rows carry ids/stages only, counters survive the log cap', () => {
        const store = MeshRuntimeStore.getInstance();
        // Drive well past the 200-key first-occurrence log cap: counters remain exact
        // and nothing content-bearing is persisted.
        const n = 210;
        for (let i = 0; i < n; i += 1) {
            const taskId = nextTaskId();
            const t0 = 10_000_000 + i * 1000;
            const attempt = openDelivered(taskId, t0);
            recordTurnStage({
                meshId: MESH, taskId, stage: i % 2 === 0 ? 'waiting_choice' : 'waiting_approval',
                attemptId: attempt.attemptId, sessionId: 'sessA', occurredAtMs: t0 + 25,
            });
        }
        const m = getTurnLedgerMetrics();
        expect(m.suspensionsHeld).toBe(n);
        for (const [key, value] of Object.entries(m.suspensionsDropped)) {
            expect(typeof key).toBe('string');
            expect(typeof value).toBe('number');
        }
        // Held rows are content-free: ids, stage, session, epoch, timestamps only.
        const held = store.listHeldTurnSuspensionsForMesh(MESH, 'held');
        expect(held).toHaveLength(n);
        for (const row of held) {
            expect(Object.keys(row).sort()).toEqual([
                'attemptId', 'dispatchNonce', 'holdId', 'meshId', 'occurredAtMs',
                'recordedAt', 'resolution', 'resolvedAt', 'sessionId', 'stage', 'status', 'taskId',
            ]);
            expect(['waiting_choice', 'waiting_approval']).toContain(row.stage);
        }
    });

    it('regression loop: the exact live fast-picker ordering never loses the picker (12/12)', () => {
        const store = MeshRuntimeStore.getInstance();
        const iterations = 12;
        for (let i = 0; i < iterations; i += 1) {
            const taskId = nextTaskId();
            const t0 = 11_000_000 + i * 10_000;
            const sessionId = `sess${i}`;
            const attempt = openDelivered(taskId, t0, 1, sessionId);
            const genTs = t0 + 20;
            // Live jitter: the picker edge lands 1–40ms after turn start but is
            // PROCESSED before the consumed write (the gate-blocking race).
            const suspendTs = genTs + 1 + (i % 40);
            const stage = i % 3 === 2 ? 'waiting_approval' : 'waiting_choice';

            const w = recordTurnStage({ meshId: MESH, taskId, stage, attemptId: attempt.attemptId, sessionId, occurredAtMs: suspendTs });
            expect(w?.deferred).toBe(true);

            recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId, occurredAtMs: genTs });
            recordTurnStage({ meshId: MESH, taskId, stage: 'generating', attemptId: attempt.attemptId, sessionId, occurredAtMs: genTs });

            const row = store.getTurnAttempt(attempt.attemptId)!;
            expect(row.stage).toBe(stage);
            expect(row.consumedAt).not.toBeNull();
            const proj = projectTurnAttempt(MESH, taskId)!;
            expect(proj.stage).toBe(stage);
            expect(proj.attemptId).toBe(attempt.attemptId);
            const presentation = presentationFromAttemptRow(row);
            expect(presentation.attemptId).toBe(attempt.attemptId);
            expect(stage === 'waiting_choice' ? presentation.choiceAgeMs : presentation.approvalAgeMs).not.toBeNull();
        }
        const m = getTurnLedgerMetrics();
        expect(m.suspensionsHeld).toBe(iterations);
        expect(m.suspensionsApplied).toBe(iterations);
        expect(m.reorderedGeneratingSuppressed).toBe(iterations);
        expect(m.suspensionsDropped).toEqual({});
    });
});
