/**
 * B2a diagnostic consistency: hold/admission predicate parity, active-count SoT,
 * stopping vs finalizing provenance, and named blockers (or explicit no-evidence).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const testTmpDir = path.join(tmpdir(), `adhdev-b2a-diag-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'b2a-diag' } as any),
    getMachineId: () => 'b2a-diag',
    getMachineNickname: () => null,
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { evaluateTaskOwnedPathsAdmission } from '../../src/mesh/mesh-runtime-store-claim.js';
import {
    __resetMeshRuntimeStoreForTests,
    enqueueTask,
    getQueueEntryById,
    getMeshQueueStats,
} from '../../src/mesh/mesh-work-queue.js';
import { recordQueueTaskHold } from '../../src/mesh/mesh-queue-hold-store.js';
import { queueHoldContext, queueTaskHoldView } from '../../src/mesh/mesh-queue-hold.js';
import { buildMeshActiveWork } from '../../src/mesh/mesh-active-work.js';
import type { MeshWorkQueueEntry } from '../../src/mesh/mesh-work-queue-types.js';

const opts = {
    providerType: 'codex-cli',
    assignedModel: 'gpt-5.4',
    allowedTaskDifficulties: ['easy', 'medium', 'difficult'] as const,
};

beforeEach(() => {
    fs.mkdirSync(testConfigDir, { recursive: true });
});

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    vi.restoreAllMocks();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function meshId(): string {
    return `mesh_b2a_${randomUUID().slice(0, 8)}`;
}

/**
 * Terminal queue status + still-stopping attempt: the physical writer remains exclusive
 * via ACTIVE_WRITER_CLAIM_SQL while status !== 'assigned' (the parallel hold filter miss).
 */
function plantStoppingTerminalHolder(mesh: string, ownedPaths: string[]): { store: MeshRuntimeStore; holder: MeshWorkQueueEntry; attemptId: string } {
    const store = MeshRuntimeStore.getInstance();
    const holder = enqueueTask(mesh, 'Holder write', {
        difficulty: 'medium',
        taskMode: 'code_change',
        ownedPaths,
    });
    expect(store.claimNextQueueTask(mesh, 'holder-node', 'holder-session', [], opts)?.id).toBe(holder.id);
    const row = store.findQueueEntryById(mesh, holder.id)!;
    const attemptId = `att-stop-${holder.id}`;
    const now = Date.now();
    store.db.prepare(
        `INSERT INTO turn_attempts (
            attempt_id, scope, mesh_id, task_id, session_id, owner_daemon_id, state,
            accepted_at, created_at, updated_at, data_json
         ) VALUES (?, 'mesh_queue', ?, ?, 'holder-session', 'b2a-diag', 'stopping', ?, ?, ?, ?)`,
    ).run(attemptId, mesh, holder.id, now, now, now, JSON.stringify({ writerStop: { confirmed: false } }));
    const terminal: MeshWorkQueueEntry = {
        ...row,
        status: 'completed',
        attemptId,
        updatedAt: new Date(now).toISOString(),
    };
    store.db.prepare(
        `UPDATE mesh_queue SET status = ?, payload = ?, updated_at = ? WHERE mesh_id = ? AND id = ?`,
    ).run('completed', JSON.stringify(terminal), terminal.updatedAt, mesh, holder.id);
    expect(store.assignedRowsMeshWide(mesh)).toHaveLength(1);
    expect(store.findQueueEntryById(mesh, holder.id)?.status).toBe('completed');
    return { store, holder: store.findQueueEntryById(mesh, holder.id)!, attemptId };
}

describe('B2a diagnostic consistency', () => {
    it('BEFORE/AFTER: owned_paths hold names the stopping-writer blocker admission already refuses', () => {
        const mesh = meshId();
        const { store, holder } = plantStoppingTerminalHolder(mesh, [
            'oss/packages/daemon-core/test/**',
        ]);
        const blocked = enqueueTask(mesh, 'Overlapping write', {
            difficulty: 'medium',
            taskMode: 'code_change',
            ownedPaths: ['oss/packages/daemon-core/test/mesh/queue.test.ts'],
        });
        const admission = evaluateTaskOwnedPathsAdmission(store, mesh, blocked);
        expect(admission.allowed).toBe(false);
        expect(admission.conflicts.map(c => c.taskId)).toContain(holder.id);

        // Projection harness: same rows admission uses (assignedRowsMeshWide) through hold context.
        const activeWriters = store.assignedRowsMeshWide(mesh).map(r => JSON.parse(r.payload) as MeshWorkQueueEntry);
        expect(activeWriters.some(w => w.id === holder.id && w.status === 'completed')).toBe(true);
        const projected = queueHoldContext(blocked, 'owned_paths_conflict', activeWriters);
        expect(projected.blockingTaskIds).toEqual([holder.id]);
        expect(projected.detail.message).not.toBe('unknown_blocker_no_evidence');

        expect(store.claimNextQueueTask(mesh, 'worker-node', 'worker-session', [], opts)).toBeNull();
        const holdAfterClaim = getQueueEntryById(mesh, blocked.id)?.hold;
        expect(holdAfterClaim?.reason).toBe('owned_paths_conflict');
        expect(holdAfterClaim?.blockingTaskIds).toEqual([holder.id]);

        recordQueueTaskHold(mesh, blocked.id, 'owned_paths_conflict');
        const afterRecord = getQueueEntryById(mesh, blocked.id)!;
        expect(afterRecord.hold?.blockingTaskIds).toEqual([holder.id]);
        const view = queueTaskHoldView(afterRecord, store.getQueueEntries(mesh))!;
        expect(view.blockingTasks.map(b => b.taskId)).toEqual([holder.id]);
    });

    it('marks unknown_blocker_no_evidence when owned_paths hold has no knowable blocker identity', () => {
        const mesh = meshId();
        const task = enqueueTask(mesh, 'Orphan held write', {
            difficulty: 'medium',
            taskMode: 'code_change',
            ownedPaths: ['src/a.ts'],
        });
        const context = queueHoldContext(task, 'owned_paths_conflict', [task], undefined);
        expect(context.blockingTaskIds).toEqual([]);
        expect(context.detail.message).toBe('unknown_blocker_no_evidence');
        recordQueueTaskHold(mesh, task.id, 'owned_paths_conflict');
        expect(getQueueEntryById(mesh, task.id)?.hold).toMatchObject({
            reason: 'owned_paths_conflict',
            blockingTaskIds: [],
            detail: { message: 'unknown_blocker_no_evidence' },
        });
    });

    it('active counts stay correlated to raw assigned workset; stopping stage is not completed/idle', () => {
        const mesh = meshId();
        const { store, holder, attemptId } = plantStoppingTerminalHolder(mesh, ['src/shared.ts']);
        // Manually assign a disjoint live row (avoid claim-path capacity interaction with the
        // stopping writer) so stats/activeWork SoT can be checked without inventing success.
        const live = enqueueTask(mesh, 'Live assigned', {
            difficulty: 'medium',
            taskMode: 'code_change',
            ownedPaths: ['docs/unrelated.md'],
        });
        const liveRow = store.findQueueEntryById(mesh, live.id)!;
        store.updateQueueEntry({
            ...liveRow,
            status: 'assigned',
            assignedNodeId: 'live-node',
            assignedSessionId: 'live-session',
            updatedAt: new Date().toISOString(),
        });

        const stats = getMeshQueueStats(mesh);
        expect(stats.activeCounts).toEqual({ pending: stats.pending, assigned: stats.assigned });
        expect(stats.assigned).toBe(1);
        expect(stats.historicalCounts.completed).toBeGreaterThanOrEqual(1);

        const built = buildMeshActiveWork({
            meshId: mesh,
            queue: store.getQueueEntries(mesh),
            nodes: [{
                id: 'live-node',
                sessions: [{ id: 'live-session', status: 'generating' }],
            }],
        });
        expect(built.activeWork.some(r => r.taskId === live.id)).toBe(true);
        expect(built.summary.totalActiveCount).toBe(built.activeWork.length);
        // Stopping exclusive writer must not be invented as a successful idle completion in statusCounts.
        expect(built.summary.statusCounts.idle ?? 0).toBe(0);
        const activeLive = built.activeWork.find(r => r.taskId === live.id)!;
        expect(['assigned', 'generating', 'awaiting_approval', 'awaiting_choice', 'finalizing', 'stopping']).toContain(activeLive.status);
        expect(store.turnStore().getAttempt(attemptId)?.state).toBe('stopping');
        expect(holder.status).toBe('completed');
        // Exclusive stopping writer still present in admission workset.
        expect(store.assignedRowsMeshWide(mesh).length).toBeGreaterThanOrEqual(1);
    });

    it('direct no-queue attempt retained; expired historical queue row is not active', () => {
        const mesh = meshId();
        const pending = enqueueTask(mesh, 'Pending only', { difficulty: 'easy' });
        const historical = enqueueTask(mesh, 'Old completed', { difficulty: 'easy' });
        const store = MeshRuntimeStore.getInstance();
        store.updateQueueEntry({
            ...store.findQueueEntryById(mesh, historical.id)!,
            status: 'completed',
            updatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
        });
        const dispatchedAt = new Date().toISOString();
        const built = buildMeshActiveWork({
            meshId: mesh,
            queue: store.getQueueEntries(mesh),
            nodes: [{
                id: 'n-direct',
                sessions: [{ id: 's-direct', status: 'generating' }],
            }],
            directDispatches: [{
                taskId: 'direct-only-1',
                meshId: mesh,
                attemptId: 'att-direct-1',
                nodeId: 'n-direct',
                sessionId: 's-direct',
                providerType: 'codex-cli',
                message: 'Direct dispatch retained',
                taskMode: 'code_change',
                via: 'local',
                status: 'acked',
                dispatchedToIdleSession: false,
                dispatchedAt,
                updatedAt: dispatchedAt,
            }],
        });
        expect(built.activeWork.some(r => r.taskId === pending.id && r.source === 'queue')).toBe(true);
        expect(built.activeWork.some(r => r.taskId === historical.id)).toBe(false);
        expect(
            [...built.activeWork, ...built.staleDirectWork].some(r => r.taskId === 'direct-only-1' && r.source === 'direct'),
        ).toBe(true);
        const stats = getMeshQueueStats(mesh);
        expect(stats.activeCounts.pending + stats.activeCounts.assigned).toBe(stats.active);
        expect(stats.historicalCounts.completed).toBeGreaterThanOrEqual(1);
    });
});
