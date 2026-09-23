import { describe, expect, it, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';

// Wiring-unification C-W3: own task lifecycle = this daemon's writer on the
// durable mesh_topic_index (task_dispatched) + the turn tables (terminals).
const OWN_WRITER = 'w-own';
vi.mock('../../src/seqscribe/mesh-publisher.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/seqscribe/mesh-publisher.js')>()),
    meshPublisherWriterId: () => OWN_WRITER,
}));
import { computeMeshTaskStats, computeMeshMissionStats } from '../../src/mesh/mesh-task-stats.js';
import { meshTopicIndexFor, MESH_RECORD_APPEND_KIND } from '../../src/mesh/mesh-topic-index.js';
import { enqueueTask, claimNextTask, updateTaskStatus, __writeTaskStatusForTests, requeueTask, __clearMeshQueueForTests } from '../../src/mesh/mesh-work-queue.js';
import { __clearLocalRecordsForTests } from '../../src/mesh/mesh-local-records.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

describe('M7 — operational stats (time/attempts)', () => {
    const meshId = `stats-mesh-${randomUUID().slice(0, 8)}`;

    afterEach(() => {
        __clearMeshQueueForTests(meshId);
        __clearLocalRecordsForTests(meshId);
        MeshRuntimeStore.resetForTests();
    });

    let seq = 0;
    function dispatchAndComplete(taskId: string, dispatchedAt: string, terminalAt: string, kind: 'task_completed' | 'task_failed' = 'task_completed') {
        // Seed the two own-read sources with controlled timestamps: the dispatch
        // record as indexed from this daemon's writer, the terminal as the
        // committed turn attempt.
        const store = MeshRuntimeStore.getInstance();
        const at = Date.parse(dispatchedAt);
        const id = randomUUID();
        meshTopicIndexFor(store.db).ingest({
            meshId, writer: OWN_WRITER, seq: ++seq, kind: MESH_RECORD_APPEND_KIND,
            payload: { id, timestamp: dispatchedAt, ledgerKind: 'task_dispatched', nodeId: null, sessionId: 'session-1', providerType: null, taskId,
                payload: { taskId, source: 'queue' }, v: 2, k: 'mesh.record', eventId: id, at },
        });
        const end = Date.parse(terminalAt);
        store.db.prepare(`INSERT INTO turn_attempts (attempt_id, scope, mesh_id, task_id, session_id, owner_daemon_id, state, accepted_at, terminal_outcome, terminal_reason, terminal_at, created_at, updated_at)
            VALUES (?, 'mesh_queue', ?, ?, 'session-1', 'd-self', ?, ?, ?, 'turn_end', ?, ?, ?)`)
            .run(randomUUID(), meshId, taskId, kind === 'task_completed' ? 'completed' : 'failed', at, kind === 'task_completed' ? 'completed' : 'failed', end, at, end);
    }

    it('derives duration and dispatch count from an injected event sequence', () => {
        const task = enqueueTask(meshId, 'measured task', { difficulty: 'medium' });
        claimNextTask(meshId, 'node-1', 'session-1');
        __writeTaskStatusForTests(meshId, task.id, 'completed');
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
        __writeTaskStatusForTests(meshId, task.id, 'completed');
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
            __writeTaskStatusForTests(meshId, task.id, 'completed');
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
