import { describe, expect, it, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { computeMeshTaskStats, computeMeshMissionStats } from '../../src/mesh/mesh-task-stats.js';
import { appendLedgerEntry } from '../../src/mesh/mesh-ledger.js';
import { enqueueTask, claimNextTask, updateTaskStatus, requeueTask, __clearMeshQueueForTests } from '../../src/mesh/mesh-work-queue.js';
import { __clearMeshLedgerForTests } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

describe('M7 — operational stats (time/attempts)', () => {
    const meshId = `stats-mesh-${randomUUID().slice(0, 8)}`;

    afterEach(() => {
        __clearMeshQueueForTests(meshId);
        __clearMeshLedgerForTests(meshId);
        MeshRuntimeStore.resetForTests();
    });

    function dispatchAndComplete(taskId: string, dispatchedAt: string, terminalAt: string, kind: 'task_completed' | 'task_failed' = 'task_completed') {
        // Inject ledger evidence with controlled timestamps via direct store append
        // (appendLedgerEntry stamps its own time, so write rows directly).
        const store = MeshRuntimeStore.getInstance();
        store.appendLedgerEntry({
            id: randomUUID(), meshId, timestamp: dispatchedAt, kind: 'task_dispatched',
            sessionId: 'session-1', payload: { taskId, source: 'queue' },
        });
        store.appendLedgerEntry({
            id: randomUUID(), meshId, timestamp: terminalAt, kind,
            sessionId: 'session-1', payload: { taskId },
        });
    }

    it('derives duration and dispatch count from an injected event sequence', () => {
        const task = enqueueTask(meshId, 'measured task', { difficulty: 'medium' });
        claimNextTask(meshId, 'node-1', 'session-1');
        updateTaskStatus(meshId, task.id, 'completed');
        dispatchAndComplete(task.id, '2026-06-10T10:00:00.000Z', '2026-06-10T10:03:14.000Z');

        const [stats] = computeMeshTaskStats(meshId, { taskIds: [task.id] });
        expect(stats.durationMs).toBe(194_000); // 3m 14s
        expect(stats.dispatchCount).toBe(1);
        expect(stats.terminalKind).toBe('task_completed');
        expect(stats.incompleteEvidence).toBeUndefined();
    });

    it('counts retries from the queue row', () => {
        const task = enqueueTask(meshId, 'retried task', { difficulty: 'medium' });
        claimNextTask(meshId, 'node-1', 'session-1');
        requeueTask(meshId, task.id, { force: true });
        claimNextTask(meshId, 'node-1', 'session-1');
        requeueTask(meshId, task.id, { force: true });

        const [stats] = computeMeshTaskStats(meshId, { taskIds: [task.id] });
        expect(stats.requeueCount).toBe(2);
    });

    it('flags incomplete evidence instead of estimating when ledger events are missing', () => {
        const task = enqueueTask(meshId, 'evidence-less task', { difficulty: 'medium' });
        claimNextTask(meshId, 'node-1', 'session-1');
        updateTaskStatus(meshId, task.id, 'completed');
        // No ledger entries injected — terminal status without dispatch/terminal evidence.

        const [stats] = computeMeshTaskStats(meshId, { taskIds: [task.id] });
        expect(stats.incompleteEvidence).toBe(true);
        expect(stats.durationMs).toBe(null);
    });

    it('rolls up mission stats with wall clock and excludes incomplete tasks from sums', () => {
        const missionId = 'mission-stats-1';
        const a = enqueueTask(meshId, 'task A', { missionId,
    difficulty: 'medium',
});
        const b = enqueueTask(meshId, 'task B', { missionId,
    difficulty: 'medium',
});
        const c = enqueueTask(meshId, 'task C (incomplete evidence)', { missionId,
    difficulty: 'medium',
});
        for (const task of [a, b, c]) {
            claimNextTask(meshId, 'node-1', 'session-1');
            updateTaskStatus(meshId, task.id, 'completed');
        }
        dispatchAndComplete(a.id, '2026-06-10T10:00:00.000Z', '2026-06-10T10:10:00.000Z');
        dispatchAndComplete(b.id, '2026-06-10T10:05:00.000Z', '2026-06-10T10:20:00.000Z');
        // c gets no ledger evidence.

        const mission = computeMeshMissionStats(meshId, missionId);
        expect(mission.taskCount).toBe(3);
        expect(mission.completed).toBe(3);
        expect(mission.totalDurationMs).toBe(10 * 60_000 + 15 * 60_000);
        expect(mission.wallClockMs).toBe(20 * 60_000); // 10:00 → 10:20
        expect(mission.incompleteTaskIds).toEqual([c.id]);
    });
});
