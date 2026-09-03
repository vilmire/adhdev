import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Same per-file isolated config dir convention as mesh-turn-ledger.test.ts —
// a dedicated mesh-runtime.db keeps this suite's outbox rows free of sibling
// suites' rows.
const testTmpDir = join(tmpdir(), `adhdev-turn-outbox-diag-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { openTurnAttempt, enqueueTerminalOutbox, drainTurnOutbox, __resetTurnLedgerMetricsForTests } from '../../src/mesh/mesh-turn-ledger.js';
import { readTurnOutboxDiagnostics } from '../../src/mesh/mesh-turn-outbox-diagnostics.js';

const MESH = `mesh-${randomUUID().slice(0, 8)}`;
let taskSeq = 0;
function nextTaskId(): string {
    taskSeq += 1;
    return `task-${randomUUID().slice(0, 8)}-${taskSeq}`;
}

beforeEach(() => {
    __resetTurnLedgerMetricsForTests();
});

afterEach(() => {
    MeshRuntimeStore.resetForTests();
    try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('turn outbox diagnostics — the missing read (Stage 5, 5a-1)', () => {
    it('reports null/empty when no outbox rows exist', () => {
        const diag = readTurnOutboxDiagnostics();
        expect(diag.oldestPendingAgeMs).toBeNull();
        expect(diag.byStatus).toEqual({});
        expect(diag.backlogPending).toBe(0);
    });

    it('surfaces a pending row backlog age and count', () => {
        const taskId = nextTaskId();
        const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: 'sessA' });
        const enqueuedAt = Date.now() - 5_000;
        enqueueTerminalOutbox({
            meshId: MESH,
            taskId,
            attemptId: attempt.attemptId,
            outcome: 'completed',
            payload: { event: 'agent:generating_completed', sessionId: 'sessA' },
            nowMs: enqueuedAt,
        });

        const diag = readTurnOutboxDiagnostics(enqueuedAt + 5_000);
        expect(diag.oldestPendingAgeMs).toBeGreaterThanOrEqual(5_000);
        expect(diag.byStatus.pending).toBe(1);
        expect(diag.backlogPending).toBe(1);
    });

    it('reflects delivered/failed status transitions, not just pending', async () => {
        const deliveredTask = nextTaskId();
        const { attempt: deliveredAttempt } = openTurnAttempt({ meshId: MESH, taskId: deliveredTask, dispatchNonce: 1, sessionId: 'sessA' });
        enqueueTerminalOutbox({ meshId: MESH, taskId: deliveredTask, attemptId: deliveredAttempt.attemptId, outcome: 'completed', payload: {} });

        const failedTask = nextTaskId();
        const { attempt: failedAttempt } = openTurnAttempt({ meshId: MESH, taskId: failedTask, dispatchNonce: 1, sessionId: 'sessB' });
        enqueueTerminalOutbox({ meshId: MESH, taskId: failedTask, attemptId: failedAttempt.attemptId, outcome: 'failed', payload: {} });

        await drainTurnOutbox(async (row) => {
            if (row.taskId === failedTask) throw new Error('permanent');
        }, { maxAttempts: 1 });

        const diag = readTurnOutboxDiagnostics();
        expect(diag.byStatus.delivered).toBe(1);
        expect(diag.byStatus.failed).toBe(1);
        expect(diag.backlogPending).toBe(0);
        // The failed row is no longer pending, so it must not still age into
        // oldestPendingAgeMs — that field tracks the redrive backstop's live
        // backlog, not its terminal history.
        expect(diag.oldestPendingAgeMs).toBeNull();
    });

    /**
     * ★Red/green injection (gate checklist ①). Reverting `readTurnOutboxDiagnostics`
     * to call `getTurnLedgerMetrics()` and discard the outbox fields (i.e.
     * undoing 5a-1's whole point — computing without exposing) turns this red:
     * `backlogPending` would silently read 0 with a live pending row.
     */
    it('red/green: backlogPending tracks the live pending count, not a stale snapshot', () => {
        const taskId = nextTaskId();
        const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: 'sessA' });
        expect(readTurnOutboxDiagnostics().backlogPending).toBe(0);
        enqueueTerminalOutbox({ meshId: MESH, taskId, attemptId: attempt.attemptId, outcome: 'completed', payload: {} });
        expect(readTurnOutboxDiagnostics().backlogPending).toBe(1);
    });
});
