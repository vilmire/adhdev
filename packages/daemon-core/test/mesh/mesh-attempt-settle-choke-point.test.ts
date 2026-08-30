import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Per-file isolated config dir → per-file mesh-runtime.db (same convention as
// mesh-turn-ledger.test.ts): this suite asserts on turn-attempt rows, so a sibling
// suite's rows must never bleed in.
const testTmpDir = join(tmpdir(), `adhdev-attempt-settle-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { enqueueTask, updateTaskStatus, cancelTask } from '../../src/mesh/mesh-work-queue.js';
import { openTurnAttempt, recordTurnStage, proposeTurnCompletion } from '../../src/mesh/mesh-turn-ledger.js';
import { reconcileUnsettledTerminalAttempts } from '../../src/mesh/mesh-reconcile-stranded-dispatch.js';

const MESH = `mesh-${randomUUID().slice(0, 8)}`;

afterEach(() => {
    MeshRuntimeStore.resetForTests();
    try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * Drive a task to the exact state the live defect was observed in: an attempt that
 * has been dispatched and is mid-turn (stage 'generating'), i.e. NOT terminal and
 * carrying no lease deadline — so no reaper would ever collect it.
 */
function dispatchedTask(sessionId = 'sess-worker', attemptIdleMs = 0): { taskId: string; attemptId: string } {
    const task = enqueueTask(MESH, 'do the thing', { difficulty: 'easy' });
    // attemptIdleMs backdates the attempt's stage writes so its own updatedAt — the
    // anchor the safety-net grace reads — lands that far in the past.
    const t0 = Date.now() - attemptIdleMs;
    const { attempt } = openTurnAttempt({
        meshId: MESH, taskId: task.id, dispatchNonce: 1, nodeId: 'nodeA', sessionId,
        coordinatorDaemonId: 'daemon_mach_x', coordinatorSessionId: 'coordSess', nowMs: t0,
    });
    for (const stage of ['delivered', 'consumed', 'generating'] as const) {
        recordTurnStage({ meshId: MESH, taskId: task.id, attemptId: attempt.attemptId, stage, sessionId, nowMs: t0 });
    }
    const live = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(MESH, task.id)!;
    expect(live.stage).toBe('generating');
    expect(live.terminalOutcome).toBeNull();
    return { taskId: task.id, attemptId: attempt.attemptId };
}

function currentAttempt(taskId: string) {
    return MeshRuntimeStore.getInstance().getCurrentTurnAttempt(MESH, taskId);
}

describe('ATTEMPT-SETTLE-CHOKE-POINT — a terminal task never leaves a live attempt', () => {
    // ── THE REGRESSION THIS SUITE EXISTS FOR ──────────────────────────────────
    // The defect recurred three times because the "terminal task ⇒ settled attempt"
    // invariant was each terminal writer's OPT-IN duty, and the tests only ever
    // asserted the TASK reached 'completed'. A test that stops at the task row
    // passes while the attempt stays stage='generating' / terminal_outcome=null
    // forever — which is precisely the live symptom (status=generating,
    // chatStatus=idle, turnStage=generating) and blocks the next dispatch with
    // session_generating_busy. So every case below asserts the ATTEMPT.

    it('settles the attempt when a completion path flips the task terminal WITHOUT proposing itself', () => {
        // This is the suppressed-completion + watchdog-synth shape: the fallback
        // completion path (mesh-events-stale reconcile / watchdog early-complete)
        // writes the task row but never calls the reducer. Before the choke point
        // this left the attempt live forever.
        const { taskId, attemptId } = dispatchedTask();

        updateTaskStatus(MESH, taskId, 'completed');

        const attempt = currentAttempt(taskId)!;
        expect(attempt.attemptId).toBe(attemptId);
        expect(attempt.terminalOutcome).toBe('completed');   // ← the assertion the old tests lacked
        expect(attempt.stage).toBe('completed');
        expect(attempt.terminalAt).toBeTruthy();
    });

    it('settles the attempt on a terminal FAILURE flip too', () => {
        const { taskId } = dispatchedTask();
        updateTaskStatus(MESH, taskId, 'failed');
        expect(currentAttempt(taskId)!.terminalOutcome).toBe('failed');
    });

    it('is idempotent with the call sites that already propose (no double-settle)', () => {
        // Three reconcile paths call reconcileTerminalViaReducer BEFORE
        // updateTaskStatus. The choke point must not fight them: the first
        // proposal commits, the choke point's is an idempotent duplicate that
        // preserves the ORIGINAL outcome, reason and terminalAt.
        const { taskId } = dispatchedTask();

        const first = proposeTurnCompletion({
            meshId: MESH, taskId, outcome: 'completed', source: 'stall_reconcile',
            sessionId: 'sess-worker', reason: 'task_completed',
        });
        expect(first.committed).toBe(true);
        const settledBy = currentAttempt(taskId)!;

        updateTaskStatus(MESH, taskId, 'completed');

        const after = currentAttempt(taskId)!;
        expect(after.terminalOutcome).toBe('completed');
        // The committed terminal is untouched — not re-stamped by the second settle.
        expect(after.terminalAt).toBe(settledBy.terminalAt);
        expect(after.terminalReason).toBe(settledBy.terminalReason);
    });

    it('never overrides an already-committed CONFLICTING terminal outcome', () => {
        // Causal authority stays with the reducer: if the attempt already committed
        // 'failed', a later task flip to 'completed' must not rewrite it.
        const { taskId } = dispatchedTask();
        proposeTurnCompletion({
            meshId: MESH, taskId, outcome: 'failed', source: 'provider_event', sessionId: 'sess-worker',
        });

        updateTaskStatus(MESH, taskId, 'completed');

        expect(currentAttempt(taskId)!.terminalOutcome).toBe('failed');
    });

    it('does not settle the attempt on a NON-terminal transition', () => {
        // A dispatch-failure requeue to 'pending' must leave the attempt live.
        const { taskId } = dispatchedTask();
        updateTaskStatus(MESH, taskId, 'pending');
        const attempt = currentAttempt(taskId)!;
        expect(attempt.terminalOutcome).toBeNull();
        expect(attempt.stage).toBe('generating');
    });

    it('does not re-settle when the row was ALREADY terminal (terminal→terminal no-op)', () => {
        const { taskId } = dispatchedTask();
        updateTaskStatus(MESH, taskId, 'completed');
        const first = currentAttempt(taskId)!;
        updateTaskStatus(MESH, taskId, 'failed');   // refused-as-conflict at the reducer
        const after = currentAttempt(taskId)!;
        expect(after.terminalOutcome).toBe('completed');
        expect(after.terminalAt).toBe(first.terminalAt);
    });

    it('cancelTask still settles its attempt as cancelled (pre-existing path unbroken)', () => {
        const { taskId } = dispatchedTask();
        cancelTask(MESH, taskId, { reason: 'operator_cancel' });
        expect(currentAttempt(taskId)!.terminalOutcome).toBe('cancelled');
    });
});

describe('unsettled-attempt safety net (backstop for writers that bypass the choke point)', () => {
    /**
     * Simulate a writer that bypasses updateTaskStatus entirely — a direct store
     * write, or a crash between the row write and the reducer proposal. This is the
     * only shape the choke point structurally cannot cover, and the reason the net
     * exists at all.
     */
    function bypassChokePointToTerminal(taskId: string, status: 'completed' | 'failed'): void {
        const store = MeshRuntimeStore.getInstance();
        const entry = store.findQueueEntryById(MESH, taskId)!;
        entry.status = status;
        store.updateQueueEntry(entry);   // writes the row WITHOUT settling the attempt
    }

    it('settles a terminal task whose attempt was left live by a bypassing writer', () => {
        const { taskId } = dispatchedTask('sess-worker', 5 * 60 * 1000);
        bypassChokePointToTerminal(taskId, 'completed');

        expect(currentAttempt(taskId)!.terminalOutcome).toBeNull();   // the leak, reproduced
        const settled = reconcileUnsettledTerminalAttempts({ id: MESH });

        expect(settled).toBe(1);
        expect(currentAttempt(taskId)!.terminalOutcome).toBe('completed');
    });

    it('respects the grace window — a just-flipped row is not pre-empted', () => {
        // A terminal flip whose reducer proposal is legitimately a few ticks behind
        // must be left alone rather than raced by the net.
        const { taskId } = dispatchedTask('sess-worker', 1_000);
        bypassChokePointToTerminal(taskId, 'completed');

        expect(reconcileUnsettledTerminalAttempts({ id: MESH })).toBe(0);
        expect(currentAttempt(taskId)!.terminalOutcome).toBeNull();
    });

    it('is a no-op in steady state — the choke point already settled everything', () => {
        // The load-bearing assertion for "this net should never fire in practice":
        // after a normal terminal flip there is nothing left for it to do, even once
        // the row is well past the grace window.
        const { taskId } = dispatchedTask('sess-worker', 10 * 60 * 1000);
        updateTaskStatus(MESH, taskId, 'completed');

        expect(reconcileUnsettledTerminalAttempts({ id: MESH })).toBe(0);
    });
});

describe('equivalence tests for N+1 SQL migration', () => {
    function bypassChokePointToTerminal(taskId: string, status: 'completed' | 'failed'): void {
        const store = MeshRuntimeStore.getInstance();
        const entry = store.findQueueEntryById(MESH, taskId)!;
        entry.status = status;
        store.updateQueueEntry(entry);
    }

    it('Case 1: attempt 행 없음 → 0건 구제', () => {
        const task = enqueueTask(MESH, 'no attempt task', { difficulty: 'easy' });
        bypassChokePointToTerminal(task.id, 'completed');
        expect(reconcileUnsettledTerminalAttempts({ id: MESH })).toBe(0);
    });

    it('Case 2: terminalOutcome 있음 → 0건', () => {
        const { taskId } = dispatchedTask('sess-worker', 65_000);
        updateTaskStatus(MESH, taskId, 'completed'); // This sets terminalOutcome
        expect(reconcileUnsettledTerminalAttempts({ id: MESH })).toBe(0);
    });

    it('Case 3: stage 가 terminal → 0건', () => {
        const { taskId, attemptId } = dispatchedTask('sess-worker', 65_000);
        // Force stage to terminal directly in DB to simulate this exact edge case
        const store = MeshRuntimeStore.getInstance();
        (store as any).db.prepare('UPDATE mesh_turn_attempts SET stage = ? WHERE attempt_id = ?').run('completed', attemptId);
        bypassChokePointToTerminal(taskId, 'completed');
        expect(reconcileUnsettledTerminalAttempts({ id: MESH })).toBe(0);
    });

    it('Case 4: 과거 seq 는 조건 맞지만 최신 seq 가 terminal → 0건 (MAX 서브쿼리 검증)', () => {
        const { taskId, attemptId } = dispatchedTask('sess-worker', 65_000); // Seq 1 is old and non-terminal
        // create a new attempt (seq 2) that IS terminal
        const store = MeshRuntimeStore.getInstance();
        const { attempt: attempt2 } = openTurnAttempt({
            meshId: MESH, taskId, dispatchNonce: 2, nodeId: 'nodeA', sessionId: 'sess-worker',
            coordinatorDaemonId: 'coord', coordinatorSessionId: 'coordSess', nowMs: Date.now() - 65_000,
        });
        proposeTurnCompletion({
            meshId: MESH, taskId, outcome: 'completed', source: 'provider_event', sessionId: 'sess-worker',
        });
        updateTaskStatus(MESH, taskId, 'completed'); // Settles attempt2
        
        // At this point seq 1 is generating, seq 2 is completed. 
        // Max subquery should only look at seq 2 and thus do nothing.
        expect(reconcileUnsettledTerminalAttempts({ id: MESH })).toBe(0);
    });

    it('Case 5: grace 미도달(30초 전) → 0건', () => {
        const { taskId } = dispatchedTask('sess-worker', 30_000);
        bypassChokePointToTerminal(taskId, 'completed');
        expect(reconcileUnsettledTerminalAttempts({ id: MESH })).toBe(0);
    });

    it('Case 6: 진짜 미정착(65초 전, 모든 조건 충족) → 구제되고 reducer 호출됨', () => {
        const { taskId } = dispatchedTask('sess-worker', 65_000);
        bypassChokePointToTerminal(taskId, 'completed');
        expect(currentAttempt(taskId)!.terminalOutcome).toBeNull();
        
        const settled = reconcileUnsettledTerminalAttempts({ id: MESH });
        expect(settled).toBe(1);
        expect(currentAttempt(taskId)!.terminalOutcome).toBe('completed');
    });
});

