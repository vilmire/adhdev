import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { LOG } from '../../src/logging/logger.js';
import {
    enqueueTask,
    getQueue,
    claimNextTask,
    updateTaskStatus,
    updateSessionTaskStatus,
    cancelTask,
    requeueTask,
    reclaimStrandedAssignedTask,
    getMeshQueueStats,
    buildMeshNodeCapabilityTags,
    nodeSatisfiesRequiredTags,
    hasPendingDependents,
    describeTaskDependencyState,
    validateMeshTaskModeRequest,
    isTaskReadonly,
    __clearMeshQueueForTests,
    __replaceMeshQueueForTests,
    __resetMeshRuntimeStoreForTests
} from '../../src/mesh/mesh-work-queue.js';
import { getLedgerDir, readLedgerEntries } from '../../src/mesh/mesh-ledger.js';

describe('Mesh Work Queue (GUPP)', () => {
    const meshId = `test_mesh_${Date.now()}`;
    const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`);

    beforeEach(() => {
        __clearMeshQueueForTests(meshId);
        if (fs.existsSync(queuePath)) {
            fs.unlinkSync(queuePath);
        }
    });

    afterEach(() => {
        __clearMeshQueueForTests(meshId);
        __resetMeshRuntimeStoreForTests();
        if (fs.existsSync(queuePath)) {
            fs.unlinkSync(queuePath);
        }
    });

    it('(3) persists sourceCoordinatorSessionId in the queue payload (round-trips; legacy omit is undefined)', () => {
        const task = enqueueTask(meshId, 'session-anchored task', { sourceCoordinatorSessionId: 'coord-A' });
        expect(task.sourceCoordinatorSessionId).to.equal('coord-A');
        // Round-trips through the SQLite payload JSON (no column migration).
        const fromQueue = getQueue(meshId).find(t => t.id === task.id);
        expect(fromQueue?.sourceCoordinatorSessionId).to.equal('coord-A');
        // Omitted → undefined (legacy / single-coordinator → daemon-level routing fallback).
        const legacy = enqueueTask(meshId, 'legacy task');
        expect(legacy.sourceCoordinatorSessionId).to.equal(undefined);
    });

    it('should enqueue tasks and list them', () => {
        const task = enqueueTask(meshId, 'test task 1');
        expect(task.status).to.equal('pending');
        expect(task.message).to.equal('test task 1');

        const queue = getQueue(meshId);
        expect(queue.length).to.equal(1);
        expect(queue[0].id).to.equal(task.id);
    });

    it('imports an existing JSON queue into MeshRuntimeStore on first read', () => {
        const now = new Date().toISOString();
        const legacyTask = {
            id: 'legacy-task-1',
            meshId,
            message: 'legacy queued task',
            status: 'pending' as const,
            createdAt: now,
            updatedAt: now,
        };
        fs.writeFileSync(queuePath, JSON.stringify([legacyTask], null, 2), 'utf-8');
        __resetMeshRuntimeStoreForTests();

        const queue = getQueue(meshId);

        expect(queue).to.have.length(1);
        expect(queue[0]).to.deep.include({
            id: 'legacy-task-1',
            message: 'legacy queued task',
            status: 'pending',
        });
    });

    it('blocks queue ownership mutations from member daemons when ownership is declared', () => {
        expect(() => enqueueTask(meshId, 'member task', { ownerRole: 'member' } as any))
            .to.throw(/Mesh Host/);

        const hostTask = enqueueTask(meshId, 'host task', { ownerRole: 'host' } as any);
        expect(hostTask.status).to.equal('pending');
        expect(getQueue(meshId)).to.have.length(1);
    });

    it('should claim the oldest pending task', () => {
        const t1 = enqueueTask(meshId, 'task 1');
        const t2 = enqueueTask(meshId, 'task 2');

        const claimed = claimNextTask(meshId, 'node1', 'session1');
        expect(claimed).to.not.be.null;
        expect(claimed?.id).to.equal(t1.id);
        expect(claimed?.status).to.equal('assigned');
        expect(claimed?.assignedNodeId).to.equal('node1');
        expect(claimed?.assignedSessionId).to.equal('session1');

        const claimed2 = claimNextTask(meshId, 'node2', 'session2');
        expect(claimed2?.id).to.equal(t2.id);
    });

    it('does not let a node/session claim another task while one is still assigned', () => {
        const t1 = enqueueTask(meshId, 'task 1');
        const t2 = enqueueTask(meshId, 'task 2');
        const t3 = enqueueTask(meshId, 'task 3');

        const first = claimNextTask(meshId, 'node1', 'session1');
        expect(first?.id).to.equal(t1.id);

        // The same session must not stack a second queued task before closing
        // the first one.
        expect(claimNextTask(meshId, 'node1', 'session1')).to.be.null;

        // A different session on the same node is still the same worker node;
        // it must not over-claim while the node has active assigned work.
        expect(claimNextTask(meshId, 'node1', 'session2')).to.be.null;

        const otherNode = claimNextTask(meshId, 'node2', 'session3');
        expect(otherNode?.id).to.equal(t2.id);

        updateSessionTaskStatus(meshId, 'session1', 'completed');
        const afterCompletion = claimNextTask(meshId, 'node1', 'session1');
        expect(afterCompletion?.id).to.equal(t3.id);
    });

    describe('C2 completion under coordinator↔worker clock skew', () => {
        it('marks the queue row completed even when the worker clock is 5min behind', () => {
            // Exact live repro: assign at coordinator updated_at = T0, then complete
            // with the worker's clock (occurredAt = T0 − 5min). Old code left it `assigned`.
            const t1 = enqueueTask(meshId, 'remote task');
            const claimed = claimNextTask(meshId, 'node1', 'session-skew');
            expect(claimed?.id).to.equal(t1.id);
            expect(claimed?.status).to.equal('assigned');

            const workerClockBehind = new Date(Date.now() - 5 * 60_000).toISOString();
            const result = updateSessionTaskStatus(meshId, 'session-skew', 'completed', { occurredAt: workerClockBehind });
            expect(result).to.not.be.null;
            expect(result?.id).to.equal(t1.id);

            const row = getQueue(meshId).find(e => e.id === t1.id);
            expect(row?.status).to.equal('completed');
        });

        it('a late completion carrying taskId=A does not complete the live B row', () => {
            const a = enqueueTask(meshId, 'task A');
            claimNextTask(meshId, 'node1', 'session1');
            updateSessionTaskStatus(meshId, 'session1', 'completed'); // close A so B can claim
            const b = enqueueTask(meshId, 'task B');
            const claimedB = claimNextTask(meshId, 'node1', 'session1');
            expect(claimedB?.id).to.equal(b.id);

            // A late event carrying taskId=A: A is no longer assigned, so the exact-id
            // match misses and must NOT silently complete B by a stale id alone — but
            // since B is the only live assigned row, session match resolves B.
            const byA = updateSessionTaskStatus(meshId, 'session1', 'completed', { taskId: a.id });
            // A is terminal; the only assigned row is B, so B is what gets resolved.
            expect(byA?.id).to.equal(b.id);
        });

        it('logs a no-match anomaly and returns null when the session has no assigned row', () => {
            const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
            // Force a stray assigned row for a different session so the anomaly branch
            // (assigned rows exist, but none for THIS session) cannot fire — instead
            // assert the clean no-row case returns null without throwing or warning.
            const result = updateSessionTaskStatus(meshId, 'ghost-session', 'completed');
            expect(result).to.be.null;
            warn.mockRestore();
        });

        it('warns when an assigned row exists for the session but lookup still fails to resolve', () => {
            // Insert an assigned row whose session matches getActiveAssignmentDetails but
            // make findAssignedBySession miss by stubbing it to null — proves the warn fires.
            const t1 = enqueueTask(meshId, 'stuck task');
            claimNextTask(meshId, 'node1', 'session-stuck');
            const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
            const findSpy = vi.spyOn(MeshRuntimeStore.getInstance(), 'findAssignedBySession').mockReturnValue(null);

            const result = updateSessionTaskStatus(meshId, 'session-stuck', 'completed', { taskId: t1.id });
            expect(result).to.be.null;
            expect(warn).toHaveBeenCalledOnce();
            expect(warn.mock.calls[0][0]).to.equal('MeshQueue');
            expect(String(warn.mock.calls[0][1])).to.contain('session-stuck');

            findSpy.mockRestore();
            warn.mockRestore();
        });
    });

    // REDRIVE-DUP: a reclaimed+re-dispatched task must bump its dispatch nonce so the
    // stale inject to the original node carries a now-lower nonce and is rejectable.
    describe('REDRIVE-DUP dispatch nonce', () => {
        it('stamps a monotonic dispatch nonce on claim', () => {
            enqueueTask(meshId, 'task 1');
            const claimed = claimNextTask(meshId, 'node1', 'session1');
            expect(claimed?.dispatchNonce).to.equal(1);
            // The nonce round-trips through the SQLite payload JSON.
            const fromQueue = getQueue(meshId).find(t => t.id === claimed?.id);
            expect(fromQueue?.dispatchNonce).to.equal(1);
        });

        it('reclaimStrandedAssignedTask bumps the nonce so a stale inject is rejectable', () => {
            const t1 = enqueueTask(meshId, 'stranded task');
            const claimed = claimNextTask(meshId, 'nodeA', 'sessionA');
            expect(claimed?.dispatchNonce).to.equal(1);
            const nonceAtDispatch = claimed!.dispatchNonce!;

            // The delivered-not-consumed watchdog reclaims it back to pending.
            const reclaimed = reclaimStrandedAssignedTask(meshId, t1.id, { reason: 'delivered_not_consumed_redrive' });
            expect(reclaimed?.status).to.equal('pending');
            // The reclaim bumped the nonce strictly above the value the original inject carried,
            // so a late generating_started echoing nonceAtDispatch is now stale (< current).
            expect(reclaimed!.dispatchNonce!).to.be.greaterThan(nonceAtDispatch);
            expect(reclaimed!.assignedNodeId).to.be.undefined;
            expect(reclaimed!.assignedSessionId).to.be.undefined;

            // Re-claiming onto a DIFFERENT node bumps the nonce again — the current value the
            // coordinator compares against is strictly greater than the stale inject's.
            const reclaimedNonce = reclaimed!.dispatchNonce!;
            const redispatched = claimNextTask(meshId, 'nodeB', 'sessionB');
            expect(redispatched?.id).to.equal(t1.id);
            expect(redispatched!.dispatchNonce!).to.be.greaterThan(reclaimedNonce);
            expect(redispatched!.dispatchNonce!).to.be.greaterThan(nonceAtDispatch);
        });

        it('preserves readonly parallelism: two DIFFERENT readonly tasks both claim on one node', () => {
            const r1 = enqueueTask(meshId, 'readonly diagnose 1', { readonly: true } as any);
            const r2 = enqueueTask(meshId, 'readonly diagnose 2', { readonly: true } as any);

            // Both readonly tasks claim concurrently on the SAME node (different sessions) —
            // the node-busy gate is bypassed for readonly work; the nonce change does not
            // touch that path.
            const c1 = claimNextTask(meshId, 'node1', 'session-ro-1', undefined, { nodeIsWorktree: false } as any);
            const c2 = claimNextTask(meshId, 'node1', 'session-ro-2', undefined, { nodeIsWorktree: false } as any);
            expect(c1).to.not.be.null;
            expect(c2).to.not.be.null;
            expect(new Set([c1!.id, c2!.id])).to.deep.equal(new Set([r1.id, r2.id]));
            // Each got its own independent nonce (both first-dispatch → 1).
            expect(c1!.dispatchNonce).to.equal(1);
            expect(c2!.dispatchNonce).to.equal(1);
        });
    });

    it('should only claim targeted tasks if node matches', () => {
        const t1 = enqueueTask(meshId, 'targeted task', { targetNodeId: 'node-target' });

        // node1 cannot claim it
        const c1 = claimNextTask(meshId, 'node1', 'session1');
        expect(c1).to.be.null;

        // node-target can claim it
        const c2 = claimNextTask(meshId, 'node-target', 'session2');
        expect(c2).to.not.be.null;
        expect(c2?.id).to.equal(t1.id);
    });

    it('only lets nodes claim tasks whose required tags are satisfied', () => {
        const gpuTask = enqueueTask(meshId, 'gpu task', {
            requiredTags: ['gpu', 'provider=codex-cli', 'gpu'],
        });
        const generalTask = enqueueTask(meshId, 'general task');

        expect(gpuTask.requiredTags).to.deep.equal(['gpu', 'provider=codex-cli']);

        const mismatch = claimNextTask(meshId, 'node-basic', 'session-basic', ['provider=codex-cli']);
        expect(mismatch?.id).to.equal(generalTask.id);

        const matched = claimNextTask(meshId, 'node-gpu', 'session-gpu', ['gpu', 'provider=codex-cli', 'os=darwin']);
        expect(matched?.id).to.equal(gpuTask.id);
        expect(matched?.assignedNodeId).to.equal('node-gpu');
    });

    it('should only claim session-targeted tasks if the runtime session matches', () => {
        const t1 = enqueueTask(meshId, 'session targeted task', {
            targetNodeId: 'node-target',
            targetSessionId: 'session-target',
        });

        // Another idle session on the same node must not steal the task.
        const c1 = claimNextTask(meshId, 'node-target', 'session-other');
        expect(c1).to.be.null;

        const c2 = claimNextTask(meshId, 'node-target', 'session-target');
        expect(c2).to.not.be.null;
        expect(c2?.id).to.equal(t1.id);
        expect(c2?.assignedSessionId).to.equal('session-target');
    });

    it('prioritizes session-targeted tasks and waits to claim broader node work until the node is idle', () => {
        const nodeTask = enqueueTask(meshId, 'node targeted task', { targetNodeId: 'node-target' });
        const sessionTask = enqueueTask(meshId, 'session targeted task', {
            targetNodeId: 'node-target',
            targetSessionId: 'session-target',
        });

        const c1 = claimNextTask(meshId, 'node-target', 'session-target');
        expect(c1?.id).to.equal(sessionTask.id);

        expect(claimNextTask(meshId, 'node-target', 'session-other')).to.be.null;

        updateSessionTaskStatus(meshId, 'session-target', 'completed');
        const c2 = claimNextTask(meshId, 'node-target', 'session-other');
        expect(c2?.id).to.equal(nodeTask.id);
    });

    it('should update task status', () => {
        const task = enqueueTask(meshId, 'status task');
        expect(task.status).to.equal('pending');

        const claimed = claimNextTask(meshId, 'node1', 'session1');
        expect(claimed?.id).to.equal(task.id);

        updateTaskStatus(meshId, task.id, 'completed');
        
        const q = getQueue(meshId);
        expect(q[0].status).to.equal('completed');
    });

    it('should update task status by session id', () => {
        const task = enqueueTask(meshId, 'session task');
        claimNextTask(meshId, 'node1', 'session1');
        
        updateSessionTaskStatus(meshId, 'session1', 'failed');
        
        const q = getQueue(meshId);
        expect(q[0].status).to.equal('failed');
    });

    it('selects the most recently dispatched task when multiple tasks are assigned to the same session', () => {
        // Simulate a rare edge case where a session somehow has multiple assigned tasks
        const t1 = enqueueTask(meshId, 'older task');
        const t2 = enqueueTask(meshId, 'newer task');

        // Manually assign both tasks to the same session (bypassing claimNextTask guard)
        // to simulate the edge case where assignment tracking drifts
        const queue = getQueue(meshId);
        const now = Date.now();
        queue[0].status = 'assigned';
        queue[0].assignedNodeId = 'node1';
        queue[0].assignedSessionId = 'session1';
        queue[0].dispatchTimestamp = new Date(now - 1000).toISOString();
        queue[0].updatedAt = new Date(now - 1000).toISOString();

        queue[1].status = 'assigned';
        queue[1].assignedNodeId = 'node1';
        queue[1].assignedSessionId = 'session1';
        queue[1].dispatchTimestamp = new Date(now).toISOString();
        queue[1].updatedAt = new Date(now).toISOString();

        __replaceMeshQueueForTests(meshId, queue);

        // Completion should target the most recently dispatched task (t2)
        const completed = updateSessionTaskStatus(meshId, 'session1', 'completed');
        expect(completed).to.not.be.null;
        expect(completed?.id).to.equal(t2.id);
        expect(completed?.status).to.equal('completed');

        // The older task should remain assigned
        const q = getQueue(meshId);
        const older = q.find((t: any) => t.id === t1.id);
        const newer = q.find((t: any) => t.id === t2.id);
        expect(older?.status).to.equal('assigned');
        expect(newer?.status).to.equal('completed');
    });

    it('falls back to updatedAt when dispatchTimestamp is missing (legacy entries)', () => {
        const t1 = enqueueTask(meshId, 'legacy task 1');
        const t2 = enqueueTask(meshId, 'legacy task 2');

        const queue = getQueue(meshId);
        const now = Date.now();
        queue[0].status = 'assigned';
        queue[0].assignedNodeId = 'node1';
        queue[0].assignedSessionId = 'session1';
        // No dispatchTimestamp — legacy entry
        queue[0].updatedAt = new Date(now - 1000).toISOString();

        queue[1].status = 'assigned';
        queue[1].assignedNodeId = 'node1';
        queue[1].assignedSessionId = 'session1';
        // No dispatchTimestamp — legacy entry
        queue[1].updatedAt = new Date(now).toISOString();

        __replaceMeshQueueForTests(meshId, queue);

        const completed = updateSessionTaskStatus(meshId, 'session1', 'completed');
        expect(completed?.id).to.equal(t2.id);

        const q = getQueue(meshId);
        expect(q.find((t: any) => t.id === t1.id)?.status).to.equal('assigned');
        expect(q.find((t: any) => t.id === t2.id)?.status).to.equal('completed');
    });

    it('C2: completes the single live assigned row even when occurredAt is before its dispatch (clock skew, not a stale event)', () => {
        // Pre-C2 this returned null (occurredAt < dispatchTimestamp), which is exactly
        // how a remote worker whose clock is behind the coordinator stranded a finished
        // task. With a single live assigned row and no contradicting taskId, the
        // completion belongs to that row — resolve it instead of dropping to null.
        const olderTask = enqueueTask(meshId, 'older task');
        const newerTask = enqueueTask(meshId, 'newer continuation task');

        const queue = getQueue(meshId);
        const now = Date.now();
        const workerClockBehind = new Date(now).toISOString();

        queue[0].status = 'completed';
        queue[0].assignedNodeId = 'node1';
        queue[0].assignedSessionId = 'session1';
        queue[0].dispatchTimestamp = new Date(now - 5000).toISOString();
        queue[0].updatedAt = new Date(now - 4000).toISOString();

        queue[1].status = 'assigned';
        queue[1].assignedNodeId = 'node1';
        queue[1].assignedSessionId = 'session1';
        queue[1].dispatchTimestamp = new Date(now + 5000).toISOString();
        queue[1].updatedAt = new Date(now + 5000).toISOString();

        __replaceMeshQueueForTests(meshId, queue);

        const completed = updateSessionTaskStatus(meshId, 'session1', 'completed', { occurredAt: workerClockBehind });
        expect(completed?.id).to.equal(newerTask.id);

        const q = getQueue(meshId);
        expect(q.find((t: any) => t.id === olderTask.id)?.status).to.equal('completed');
        expect(q.find((t: any) => t.id === newerTask.id)?.status).to.equal('completed');
    });

    it('exposes active assignment details in queue stats for status/UI surfaces', () => {
        const task = enqueueTask(meshId, 'visible active task');
        claimNextTask(meshId, 'node-active', 'session-active');

        const stats = getMeshQueueStats(meshId);

        expect(stats.total).to.equal(1);
        expect(stats.active).to.equal(1);
        expect(stats.historical).to.equal(0);
        expect(stats.pending).to.equal(0);
        expect(stats.assigned).to.equal(1);
        expect(stats.activeCounts).to.deep.equal({ pending: 0, assigned: 1 });
        expect(stats.historicalCounts).to.deep.equal({ completed: 0, failed: 0, cancelled: 0 });
        expect(stats.activeAssignments).to.deep.equal([{
            id: task.id,
            nodeId: 'node-active',
            sessionId: 'session-active',
            message: 'visible active task',
        }]);
    });

    it('releases a node/session after failed or cancelled assignments', () => {
        const failedTask = enqueueTask(meshId, 'will fail');
        const cancelledTask = enqueueTask(meshId, 'will cancel');
        const nextTask = enqueueTask(meshId, 'next task');

        expect(claimNextTask(meshId, 'node-release', 'session-release')?.id).to.equal(failedTask.id);
        updateSessionTaskStatus(meshId, 'session-release', 'failed');
        expect(claimNextTask(meshId, 'node-release', 'session-release')?.id).to.equal(cancelledTask.id);
        cancelTask(meshId, cancelledTask.id, { reason: 'operator cancelled' });
        expect(claimNextTask(meshId, 'node-release', 'session-release')?.id).to.equal(nextTask.id);
    });

    it('cancels stale queue tasks without deleting audit history', () => {
        const task = enqueueTask(meshId, 'stale pending task', {
            targetNodeId: 'node1',
            targetSessionId: 'dead-session',
        });

        const cancelled = cancelTask(meshId, task.id, { reason: 'dead session target' });

        expect(cancelled?.id).to.equal(task.id);
        expect(cancelled?.status).to.equal('cancelled');
        expect(cancelled?.cancelReason).to.equal('dead session target');
        const q = getQueue(meshId);
        expect(q).to.have.length(1);
        expect(q[0].status).to.equal('cancelled');
        expect(q[0].targetSessionId).to.equal('dead-session');
    });

    it('requeues stale assigned tasks and clears dead session ownership by default', () => {
        const task = enqueueTask(meshId, 'stale assigned task', {
            targetNodeId: 'node1',
            targetSessionId: 'dead-session',
        });
        const claimed = claimNextTask(meshId, 'node1', 'dead-session');
        expect(claimed?.id).to.equal(task.id);

        const requeued = requeueTask(meshId, task.id, { reason: 'retry on another session' });

        expect(requeued?.status).to.equal('pending');
        expect(requeued?.assignedNodeId).to.be.undefined;
        expect(requeued?.assignedSessionId).to.be.undefined;
        expect(requeued?.targetNodeId).to.equal('node1');
        expect(requeued?.targetSessionId).to.be.undefined;
        expect(requeued?.requeueReason).to.equal('retry on another session');
        const next = claimNextTask(meshId, 'node1', 'fresh-session');
        expect(next?.id).to.equal(task.id);
    });

    it('keeps historical terminal rows out of active assignment counters', () => {
        const failedTask = enqueueTask(meshId, 'failed historical task');
        claimNextTask(meshId, 'node-history', 'session-history');
        updateTaskStatus(meshId, failedTask.id, 'failed');
        const pendingTask = enqueueTask(meshId, 'pending active task');

        const stats = getMeshQueueStats(meshId);

        expect(stats.total).to.equal(2);
        expect(stats.active).to.equal(1);
        expect(stats.historical).to.equal(1);
        expect(stats.activeCounts).to.deep.equal({ pending: 1, assigned: 0 });
        expect(stats.historicalCounts).to.deep.equal({ completed: 0, failed: 1, cancelled: 0 });
        expect(stats.activeAssignments).to.deep.equal([]);
        expect(getQueue(meshId, { status: ['pending'] })).to.have.length(1);
        expect(getQueue(meshId, { status: ['pending'] })[0].id).to.equal(pendingTask.id);
    });

    it('getQueue filters by status via SQL — only returns matching entries', () => {
        const t1 = enqueueTask(meshId, 'will be assigned');
        const t2 = enqueueTask(meshId, 'pending task');
        const t3 = enqueueTask(meshId, 'will be cancelled');

        // Claim t1 (oldest pending) to make it assigned
        claimNextTask(meshId, 'node-filter', 'session-filter');
        // Cancel t3
        cancelTask(meshId, t3.id, { reason: 'test cancel' });

        // After claiming t1: t1=assigned, t2=pending, t3=cancelled
        expect(getQueue(meshId, { status: ['pending'] })).to.have.length(1);
        expect(getQueue(meshId, { status: ['pending'] })[0].id).to.equal(t2.id);

        expect(getQueue(meshId, { status: ['assigned'] })).to.have.length(1);
        expect(getQueue(meshId, { status: ['assigned'] })[0].id).to.equal(t1.id);

        expect(getQueue(meshId, { status: ['cancelled'] })).to.have.length(1);
        expect(getQueue(meshId, { status: ['cancelled'] })[0].id).to.equal(t3.id);

        expect(getQueue(meshId, { status: ['pending', 'assigned'] })).to.have.length(2);

        expect(getQueue(meshId)).to.have.length(3);
    });

    it('getMeshQueueStats uses SQL GROUP BY — counts all status buckets correctly', () => {
        enqueueTask(meshId, 'task pending');
        const assignedTask = enqueueTask(meshId, 'task to assign');
        const completedTask = enqueueTask(meshId, 'task to complete');
        const cancelledTask = enqueueTask(meshId, 'task to cancel');

        // Claim assignedTask (second oldest)
        claimNextTask(meshId, 'node-stats-a', 'session-stats-a');
        // Complete completedTask by claiming then completing via session status
        claimNextTask(meshId, 'node-stats-b', 'session-stats-b');
        updateSessionTaskStatus(meshId, 'session-stats-b', 'completed');
        // Cancel cancelledTask
        cancelTask(meshId, cancelledTask.id, { reason: 'stats test cancel' });

        const stats = getMeshQueueStats(meshId);

        expect(stats.total).to.equal(4);
        expect(stats.active).to.equal(2); // pending + assigned
        expect(stats.historical).to.equal(2); // completed + cancelled
        expect(stats.pending).to.equal(1);
        expect(stats.assigned).to.equal(1);
        expect(stats.completed).to.equal(1);
        expect(stats.cancelled).to.equal(1);
        expect(stats.failed).to.equal(0);
    });
});

describe('M1 — task dependencies + mission grouping', () => {
    const meshId = `test_mesh_deps_${Date.now()}`;

    beforeEach(() => {
        __clearMeshQueueForTests(meshId);
    });

    afterEach(() => {
        __clearMeshQueueForTests(meshId);
        __resetMeshRuntimeStoreForTests();
    });

    it('claim skips a task until all dependencies are completed', () => {
        const a = enqueueTask(meshId, 'task A');
        const b = enqueueTask(meshId, 'task B', { dependsOn: [a.id] });

        // First claim must pick A (B's dependency unmet), second claim finds nothing.
        const first = claimNextTask(meshId, 'node-1', 'session-1');
        expect(first?.id).to.equal(a.id);
        const blockedClaim = claimNextTask(meshId, 'node-2', 'session-2');
        expect(blockedClaim).to.equal(null);

        // Complete A → B becomes claimable.
        updateTaskStatus(meshId, a.id, 'completed');
        const second = claimNextTask(meshId, 'node-2', 'session-2');
        expect(second?.id).to.equal(b.id);
    });

    it('dependency failure under default block policy holds dependents pending with blockedReason', () => {
        const a = enqueueTask(meshId, 'task A');
        const b = enqueueTask(meshId, 'task B', { dependsOn: [a.id] });

        updateTaskStatus(meshId, a.id, 'failed');

        const after = getQueue(meshId).find(t => t.id === b.id);
        expect(after?.status).to.equal('pending');
        expect(after?.blockedReason).to.equal(`dependency_failed:${a.id}`);

        // Blocked task is not claimable even though its dep is terminal.
        expect(claimNextTask(meshId, 'node-1', 'session-1')).to.equal(null);

        // Operator requeue clears the block.
        const requeued = requeueTask(meshId, b.id, { force: true });
        expect(requeued?.blockedReason).to.equal(undefined);
    });

    it('self-cycle and 2-node cycle enqueues are rejected with clear errors', () => {
        const idA = 'cycle-task-a';
        const idB = 'cycle-task-b';
        expect(() => enqueueTask(meshId, 'self cycle', { id: idA, dependsOn: [idA] }))
            .to.throw(/dependency_cycle_detected/);

        // A depends on (future) B, then B depending on A closes the cycle.
        enqueueTask(meshId, 'task A', { id: idA, dependsOn: [idB] });
        expect(() => enqueueTask(meshId, 'task B', { id: idB, dependsOn: [idA] }))
            .to.throw(/dependency_cycle_detected/);
    });

    it('duplicate explicit task id is rejected', () => {
        enqueueTask(meshId, 'task A', { id: 'dup-id' });
        expect(() => enqueueTask(meshId, 'task B', { id: 'dup-id' })).to.throw(/duplicate_task_id/);
    });

    it('tasks without dependsOn claim exactly as before (no regression)', () => {
        const a = enqueueTask(meshId, 'plain task');
        const claimed = claimNextTask(meshId, 'node-1', 'session-1');
        expect(claimed?.id).to.equal(a.id);
        expect(claimed?.status).to.equal('assigned');
    });

    it('missionId is persisted on the queue entry', () => {
        const task = enqueueTask(meshId, 'mission task', { missionId: 'mission-1' });
        const stored = getQueue(meshId).find(t => t.id === task.id);
        expect(stored?.missionId).to.equal('mission-1');
    });

    it('hasPendingDependents reflects waiting tasks', () => {
        const a = enqueueTask(meshId, 'task A');
        enqueueTask(meshId, 'task B', { dependsOn: [a.id] });
        expect(hasPendingDependents(meshId, a.id)).to.equal(true);
        expect(hasPendingDependents(meshId, 'unrelated')).to.equal(false);
    });

    it('describeTaskDependencyState reports unmet deps at view time', () => {
        const statusById = new Map<string, string>([['dep-1', 'completed'], ['dep-2', 'pending']]);
        const state = describeTaskDependencyState({ dependsOn: ['dep-1', 'dep-2', 'dep-missing'] }, statusById);
        expect(state.waitingOn).to.deep.equal(['dep-2', 'dep-missing']);
        expect(state.dependenciesSatisfied).to.equal(false);

        const satisfied = describeTaskDependencyState({ dependsOn: ['dep-1'] }, statusById);
        expect(satisfied.waitingOn).to.deep.equal([]);
        expect(satisfied.dependenciesSatisfied).to.equal(true);
    });

    it('session terminal failure propagates to dependents of the assigned task', () => {
        const a = enqueueTask(meshId, 'task A');
        const b = enqueueTask(meshId, 'task B', { dependsOn: [a.id] });
        const claimed = claimNextTask(meshId, 'node-1', 'session-1');
        expect(claimed?.id).to.equal(a.id);

        updateSessionTaskStatus(meshId, 'session-1', 'failed');

        const after = getQueue(meshId).find(t => t.id === b.id);
        expect(after?.blockedReason).to.equal(`dependency_failed:${a.id}`);
    });
});

describe('buildMeshNodeCapabilityTags — worktree tag auto-registration', () => {
    it('non-worktree node does not expose worktree tag', () => {
        const tags = buildMeshNodeCapabilityTags({ isLocalWorktree: false, worktreeBranch: 'fix-foo' }, 'claude-cli');
        expect(tags.some((t: string) => t.startsWith('worktree='))).toBe(false);
    });

    it('worktree node with branch exposes worktree=<branch> tag', () => {
        const tags = buildMeshNodeCapabilityTags({ isLocalWorktree: true, worktreeBranch: 'fix-mesh-foo' }, 'claude-cli');
        expect(tags).toContain('worktree=fix-mesh-foo');
    });

    it('worktree node without branch does not expose worktree tag', () => {
        const tags = buildMeshNodeCapabilityTags({ isLocalWorktree: true, worktreeBranch: undefined }, 'claude-cli');
        expect(tags.some((t: string) => t.startsWith('worktree='))).toBe(false);
    });

    it('required_tags worktree= matches worktree node but not main node', () => {
        const worktreeTags = buildMeshNodeCapabilityTags({ isLocalWorktree: true, worktreeBranch: 'fix-mesh-bar' }, 'claude-cli');
        const mainTags = buildMeshNodeCapabilityTags({ isLocalWorktree: false }, 'claude-cli');

        expect(nodeSatisfiesRequiredTags(['worktree=fix-mesh-bar'], worktreeTags)).toBe(true);
        expect(nodeSatisfiesRequiredTags(['worktree=fix-mesh-bar'], mainTags)).toBe(false);
    });

    it('claimNextTask with required_tags worktree= is claimed only by matching worktree session', () => {
        const meshId = `test-worktree-claim-${Date.now()}`;
        // Enqueue a task targeted at the worktree node
        enqueueTask(meshId, 'fix task', { requiredTags: ['worktree=fix-branch'] });

        // Main node (no worktree tag) should NOT claim it
        const mainTags = buildMeshNodeCapabilityTags({ isLocalWorktree: false }, 'claude-cli');
        const mainClaim = claimNextTask(meshId, 'node-main', 'sess-main', mainTags);
        expect(mainClaim).toBeNull();

        // Worktree node with matching branch SHOULD claim it
        const worktreeTags = buildMeshNodeCapabilityTags({ isLocalWorktree: true, worktreeBranch: 'fix-branch' }, 'claude-cli');
        const worktreeClaim = claimNextTask(meshId, 'node-worktree', 'sess-worktree', worktreeTags);
        expect(worktreeClaim).not.toBeNull();
        expect(worktreeClaim!.message).toBe('fix task');
    });
});

describe('buildMeshNodeCapabilityTags — per-node platform/arch (not coordinator)', () => {
    it('emits the NODE platform/arch from userOverrides (e.g. a win32 member on a darwin coordinator)', () => {
        const tags = buildMeshNodeCapabilityTags(
            { userOverrides: { platform: 'win32', arch: 'x64' }, policy: { providerPriority: ['claude-cli'] } },
            'claude-cli',
        );
        expect(tags).toContain('os=win32');
        expect(tags).toContain('arch=x64');
        // The coordinator's own process.platform must NOT leak through.
        expect(tags).not.toContain(`os=${process.platform}`);
    });

    it('falls back to process.platform/process.arch when the node has no override (local/worktree node)', () => {
        const tags = buildMeshNodeCapabilityTags(
            { policy: { providerPriority: ['claude-cli'] } },
            'claude-cli',
        );
        expect(tags).toContain(`os=${process.platform}`);
        expect(tags).toContain(`arch=${process.arch}`);
    });

    it('an empty/blank userOverrides platform still falls back to process.platform', () => {
        const tags = buildMeshNodeCapabilityTags(
            { userOverrides: { platform: '  ' }, policy: { providerPriority: ['claude-cli'] } },
            'claude-cli',
        );
        expect(tags).toContain(`os=${process.platform}`);
    });

    it('required_tags os= hard-routes a win32-only task onto the win32 member, not the darwin coordinator', () => {
        const winMemberTags = buildMeshNodeCapabilityTags(
            { userOverrides: { platform: 'win32', arch: 'x64' } },
            'claude-cli',
        );
        const localCoordinatorTags = buildMeshNodeCapabilityTags(
            { userOverrides: { platform: 'darwin', arch: 'arm64' } },
            'claude-cli',
        );
        expect(nodeSatisfiesRequiredTags(['os=win32'], winMemberTags)).toBe(true);
        expect(nodeSatisfiesRequiredTags(['os=win32'], localCoordinatorTags)).toBe(false);
    });
});

describe('buildMeshNodeCapabilityTags — live reportedPlatform/reportedArch self-heal', () => {
    it('uses the live reportedPlatform when userOverrides is empty (the real bug: stamp was never persisted to userOverrides)', () => {
        // Persistent node a coordinator reads from meshes.json: operator never set
        // an override, but the daemon owning the workspace self-reported win32 on
        // its last direct git probe. Without the reported* fallback this would
        // mislabel the node as the coordinator's own os.
        const tags = buildMeshNodeCapabilityTags(
            { userOverrides: {}, reportedPlatform: 'win32', reportedArch: 'x64', policy: { providerPriority: ['claude-cli'] } },
            'claude-cli',
        );
        expect(tags).toContain('os=win32');
        expect(tags).toContain('arch=x64');
        // The coordinator's own process.platform must NOT leak through.
        expect(tags).not.toContain(`os=${process.platform}`);
    });

    it('falls back to process.platform when neither userOverrides nor reported* is present', () => {
        const tags = buildMeshNodeCapabilityTags(
            { userOverrides: {}, policy: { providerPriority: ['claude-cli'] } },
            'claude-cli',
        );
        expect(tags).toContain(`os=${process.platform}`);
        expect(tags).toContain(`arch=${process.arch}`);
    });

    it('preserves an explicit operator userOverrides over the live reported* value', () => {
        // Operator intent (userOverrides) outranks auto-detected reported* truth.
        const tags = buildMeshNodeCapabilityTags(
            {
                userOverrides: { platform: 'linux', arch: 'arm64' },
                reportedPlatform: 'win32',
                reportedArch: 'x64',
                policy: { providerPriority: ['claude-cli'] },
            },
            'claude-cli',
        );
        expect(tags).toContain('os=linux');
        expect(tags).toContain('arch=arm64');
        expect(tags).not.toContain('os=win32');
        expect(tags).not.toContain('arch=x64');
    });

    it('a blank reportedPlatform falls through to process.platform', () => {
        const tags = buildMeshNodeCapabilityTags(
            { userOverrides: {}, reportedPlatform: '  ', policy: { providerPriority: ['claude-cli'] } },
            'claude-cli',
        );
        expect(tags).toContain(`os=${process.platform}`);
    });

    it('required_tags os=win32 hard-routes onto a node known win32 only via reported* (no userOverrides)', () => {
        const winMemberTags = buildMeshNodeCapabilityTags(
            { userOverrides: {}, reportedPlatform: 'win32', reportedArch: 'x64' },
            'claude-cli',
        );
        expect(nodeSatisfiesRequiredTags(['os=win32'], winMemberTags)).toBe(true);
    });
});

describe('buildMeshNodeCapabilityTags — no role= advertising (role affinity removed)', () => {
    const node = (slots: Array<{ provider: string; maxParallel?: number }>) => ({
        policy: { providerPriority: slots.map(s => s.provider), slots },
    });

    it('never advertises a role= tag, even when capped slots are declared', () => {
        const tags = buildMeshNodeCapabilityTags(
            node([{ provider: 'claude-cli', maxParallel: 2 }, { provider: 'codex-cli', maxParallel: 1 }]),
            'claude-cli',
        );
        expect(tags.some(t => t.startsWith('role='))).toBe(false);
    });

    it('still advertises operator capability tags, os/arch/provider/converge tags', () => {
        const tags = buildMeshNodeCapabilityTags(
            { capabilities: ['gpu', 'secrets'], policy: { providerPriority: ['claude-cli'] } },
            'claude-cli',
        );
        expect(tags).toContain('gpu');
        expect(tags).toContain('secrets');
        expect(tags).toContain('provider=claude-cli');
        expect(tags).toContain('converge=fast_forward');
        expect(tags.some(t => t.startsWith('role='))).toBe(false);
    });
});

describe('required_tags hard routing — unmatched tasks stay pending, matching node claims', () => {
    it('a task whose required_tags no node satisfies stays pending (claim returns null)', () => {
        const meshId = `test-hard-pending-${Date.now()}`;
        enqueueTask(meshId, 'gpu-only work', { requiredTags: ['gpu'] });

        // A node WITHOUT the required tag cannot claim — task stays pending (hard, no fallback).
        const nonMatchingTags = buildMeshNodeCapabilityTags(
            { capabilities: ['cpu'], policy: { providerPriority: ['claude-cli'] } }, 'claude-cli');
        expect(nonMatchingTags).not.toContain('gpu');
        expect(claimNextTask(meshId, 'node-cpu', 'sess-cpu', nonMatchingTags)).toBeNull();

        // The task is still pending after the failed claim attempt.
        expect(getQueue(meshId, { status: ['pending'] })).toHaveLength(1);
        expect(getQueue(meshId, { status: ['assigned'] })).toHaveLength(0);
    });

    it('only a node advertising all required_tags claims the task', () => {
        const meshId = `test-hard-match-${Date.now()}`;
        enqueueTask(meshId, 'gpu-only work', { requiredTags: ['gpu'] });

        // Non-matching node first — must not claim.
        const cpuTags = buildMeshNodeCapabilityTags(
            { capabilities: ['cpu'], policy: { providerPriority: ['claude-cli'] } }, 'claude-cli');
        expect(claimNextTask(meshId, 'node-cpu', 'sess-cpu', cpuTags)).toBeNull();

        // Matching node — claims it.
        const gpuTags = buildMeshNodeCapabilityTags(
            { capabilities: ['gpu'], policy: { providerPriority: ['claude-cli'] } }, 'claude-cli');
        expect(gpuTags).toContain('gpu');
        const claim = claimNextTask(meshId, 'node-gpu', 'sess-gpu', gpuTags);
        expect(claim).not.toBeNull();
        expect(claim!.message).toBe('gpu-only work');
        expect(getQueue(meshId, { status: ['pending'] })).toHaveLength(0);
    });

    it('a task with no required_tags is claimable by any node', () => {
        const meshId = `test-hard-noreq-${Date.now()}`;
        enqueueTask(meshId, 'anything', {});
        const tags = buildMeshNodeCapabilityTags(
            { capabilities: ['cpu'], policy: { providerPriority: ['claude-cli'] } }, 'claude-cli');
        const claim = claimNextTask(meshId, 'node-a', 'sess-a', tags);
        expect(claim).not.toBeNull();
    });
});

describe('validateMeshTaskModeRequest — live_debug_readonly git guardrail', () => {
    const expectAllowed = (message: string) => {
        const result = validateMeshTaskModeRequest('live_debug_readonly', message);
        expect(result.violations).not.toContain('git_mutation');
        expect(result.valid).toBe(true);
    };
    const expectGitMutation = (message: string) => {
        const result = validateMeshTaskModeRequest('live_debug_readonly', message);
        expect(result.violations).toContain('git_mutation');
        expect(result.valid).toBe(false);
    };

    describe('allows read-only git diagnostics', () => {
        const readOnly = [
            'git stash list',
            "git stash show --stat 'stash@{0}'",
            'git stash show',
            'git status -sb',
            'git diff --stat',
            'git log --oneline -20',
            'git show HEAD',
            'git rev-parse HEAD',
            'git branch --list',
            'git branch -l',
            'git submodule status',
            'git checkout-index -a --prefix=/tmp/dump/',
            'run git stash list then git diff --stat to inspect the working tree',
        ];
        for (const msg of readOnly) {
            it(`allows: ${msg}`, () => expectAllowed(msg));
        }
    });

    describe('still blocks real git mutations', () => {
        const mutations = [
            'git stash pop',
            'git stash drop',
            'git stash apply',
            'git stash push',
            'git stash', // bare stash defaults to push
            'git stash clear',
            'git checkout main',
            'git checkout -- src/file.ts',
            'git switch feature',
            'git reset --hard',
            'git restore .',
            'git clean -fd',
            'git submodule update --init --recursive',
            'git rebase main',
            'git merge origin/main',
            'git commit -m "x"',
            'git add -A',
            'git push origin main',
            'git rm file.ts',
            'git mv a b',
            'first run git status, then git reset --hard to recover',
        ];
        for (const msg of mutations) {
            it(`blocks: ${msg}`, () => expectGitMutation(msg));
        }
    });

    it('does not block non-git "push" prose (e.g. push notification)', () => {
        // bare "push" word is no longer a git_mutation trigger
        const result = validateMeshTaskModeRequest('live_debug_readonly', 'inspect the push notification queue');
        expect(result.violations).not.toContain('git_mutation');
    });
});

// QUEUE-NODE-SERIALIZATION: the single classifier + its boolean axis.
describe('isTaskReadonly — single read-only classifier', () => {
    it('is true for the legacy live_debug_readonly enum', () => {
        expect(isTaskReadonly({ taskMode: 'live_debug_readonly' })).toBe(true);
    });
    it('is true for the explicit readonly boolean regardless of taskMode', () => {
        expect(isTaskReadonly({ readonly: true })).toBe(true);
        expect(isTaskReadonly({ readonly: true, taskMode: 'code_change' })).toBe(true);
        expect(isTaskReadonly({ readonly: true, taskMode: 'validation' })).toBe(true);
    });
    it('is false for write task modes without the readonly flag', () => {
        expect(isTaskReadonly({ taskMode: 'code_change' })).toBe(false);
        expect(isTaskReadonly({ taskMode: 'validation' })).toBe(false);
        expect(isTaskReadonly({ taskMode: 'convergence' })).toBe(false);
        expect(isTaskReadonly({})).toBe(false);
        expect(isTaskReadonly(null)).toBe(false);
        expect(isTaskReadonly(undefined)).toBe(false);
        // Only an explicit `true` flips the axis (not any truthy/coerced value).
        expect(isTaskReadonly({ readonly: false, taskMode: 'code_change' })).toBe(false);
    });
});

// QUEUE-NODE-SERIALIZATION: the write guardrail is generalized to the readonly axis —
// a task flagged read-only via the BOOLEAN (no live_debug_readonly enum) must reject
// the same write/deploy/push commands.
describe('validateMeshTaskModeRequest — readonly:true boolean axis guardrail', () => {
    it('rejects a write/deploy command on a readonly:true task even with a non-readonly taskMode', () => {
        const result = validateMeshTaskModeRequest('validation', 'now run wrangler deploy to ship it', true);
        expect(result.valid).toBe(false);
        expect(result.violations).toContain('deploy_or_version_bump');
    });
    it('rejects a git push on a readonly:true task with no taskMode at all', () => {
        const result = validateMeshTaskModeRequest(undefined, 'git push origin main', true);
        expect(result.valid).toBe(false);
        expect(result.violations).toContain('git_mutation');
    });
    it('allows inspection-only work on a readonly:true task', () => {
        const result = validateMeshTaskModeRequest('validation', 'git status -sb and read the logs', true);
        expect(result.valid).toBe(true);
        expect(result.violations).toHaveLength(0);
    });
    it('does NOT guard a write command when readonly is not set (write task is unrestricted here)', () => {
        const result = validateMeshTaskModeRequest('code_change', 'run wrangler deploy to ship it');
        expect(result.valid).toBe(true);
    });
});

describe('validateMeshTaskModeRequest — prose/negation vs command context', () => {
    const expectClean = (message: string) => {
        const result = validateMeshTaskModeRequest('live_debug_readonly', message);
        expect(result.violations).toEqual([]);
        expect(result.valid).toBe(true);
    };
    const expectViolation = (message: string, label: string) => {
        const result = validateMeshTaskModeRequest('live_debug_readonly', message);
        expect(result.violations).toContain(label);
        expect(result.valid).toBe(false);
    };

    describe('read-only investigation prose is allowed (no false positive)', () => {
        const allowed = [
            'READ-ONLY. grep/read만. git reset 하지 마세요',
            'no deploy, read-only',
            'just grep and read — do not modify or patch anything',
            'inspect the diff but do not commit; never push',
            'this is a patch review, only read the patch file and report findings',
            'we will not run npm install here, only inspect node_modules',
            '절대 git push 금지 — 그냥 로그만 보세요',
            'avoid rm -rf; just list the dist directory',
            'do not edit any source file, only read them',
            'no longer deploy from this node, read-only audit',
        ];
        for (const msg of allowed) {
            it(`allows: ${msg}`, () => expectClean(msg));
        }
    });

    describe('real command-context mutations are still blocked', () => {
        it('blocks line-start git reset --hard', () => {
            expectViolation('git reset --hard', 'git_mutation');
        });
        it('blocks fenced code block git commit', () => {
            expectViolation('run this:\n```\ngit commit -m x\n```', 'git_mutation');
        });
        it('blocks shell-prompt npm publish', () => {
            expectViolation('$ npm publish', 'deploy_or_version_bump');
        });
        it('blocks rm -rf dist at line start', () => {
            expectViolation('rm -rf dist', 'destructive_shell');
        });
        it('blocks inline-backtick mutation command', () => {
            expectViolation('then run `git push origin main`', 'git_mutation');
        });
        it('blocks npm install in a fenced block', () => {
            expectViolation('```\nnpm install\n```', 'package_install');
        });
    });

    describe('negation suppresses even backtick/code mentions', () => {
        it('allows negated inline-backtick command (do not run `npm publish`)', () => {
            expectClean('do not run `npm publish`');
        });
        it('allows Korean-negated inline-backtick git reset', () => {
            expectClean('`git reset --hard` 하지 마세요');
        });
    });

    describe('prose mentions without command form are ignored', () => {
        it('ignores mid-sentence "patch" prose mention', () => {
            expectClean('please review the patch and summarize what it modifies');
        });
        it('ignores mid-sentence "deploy" prose mention', () => {
            expectClean('explain how the deploy pipeline works without changing anything');
        });
    });

    describe('file-path segments do not trip the guard (false-positive fix)', () => {
        // A keyword appearing as a path component (build/Release, dist/release/)
        // is a directory name, not a deploy/version-bump command.
        const pathCases = [
            'inspect the build/Release directory and list its contents',
            'read-only: list files under dist/release/',
            'check packages/release-notes/CHANGELOG.md for the latest entry',
            'grep the path build\\Release\\bin on this windows node',
            'list everything in ./out/release and report sizes',
        ];
        for (const msg of pathCases) {
            it(`allows path: ${msg}`, () => expectClean(msg));
        }
    });

    describe('quoted commit-message citations do not trip the guard (false-positive fix)', () => {
        // Quoting a commit message that mentions version-bump/release/deploy is a
        // citation, not an instruction to run it.
        const quotedCases = [
            'inspect the commit titled "chore: oss 포인터 bump — version-bump to rc.360" and summarize the diff (read-only)',
            "find the commit whose message is 'release v1.2.3' and report its sha",
            'the log line says “deploy preview all 4 pkgs” — just read it, do not act',
            'locate the commit 「npm publish @next」 in git log and report only',
        ];
        for (const msg of quotedCases) {
            it(`allows quoted: ${msg}`, () => expectClean(msg));
        }
    });

    describe('GUARDRAIL-I18N-FP: keyword glued to a non-ASCII letter is prose, not a command', () => {
        // The forbidden-keyword regexes use `\b`, which excludes an ASCII-letter
        // suffix ("deployed" never matches `\bdeploy\b`) but fires a boundary
        // between a Latin letter and a CJK letter — so "deploy된" (Korean passive
        // "deployed") used to match and, with the CJK suffix glued on, left the
        // bare keyword at line-start, which read as a command. English passed,
        // Korean was rejected: the exact i18n asymmetry of this defect. A keyword
        // fused to any Unicode letter is now treated as word-internal prose.
        const allowedGlued = [
            'deploy된 워커의 상태만 확인해줘',
            'release된 버전 확인',
            'version-bump된 커밋 확인',
            '현재 deploy된 워커 확인',
            'release한 결과만 읽기전용으로 확인',
            'npm publish된 패키지 메타데이터만 조회',
            // node-datachannel build artifact path with a glued Korean particle.
            'node_modules/node-datachannel/build/Release/foo.node가 있는지 확인',
        ];
        for (const msg of allowedGlued) {
            it(`allows glued-suffix prose: ${msg}`, () => expectClean(msg));
        }

        it('keeps allowing the English mid-sentence equivalent', () => {
            expectClean('inspect the deployed worker status only');
        });

        it('still blocks a genuine Korean-context deploy command', () => {
            // The keyword is followed by whitespace (a real token boundary), so the
            // glued-suffix guard does not apply — this is a real invocation.
            expectViolation('npm run deploy 실행해줘', 'deploy_or_version_bump');
            expectViolation('wrangler deploy 해줘', 'deploy_or_version_bump');
        });
    });

    describe('genuine deploy/version-bump instructions are STILL blocked after the fix', () => {
        it('blocks line-start version-bump script invocation', () => {
            expectViolation('./scripts/version-bump.sh patch', 'deploy_or_version_bump');
        });
        it('blocks shell-prompt npm publish (real command)', () => {
            expectViolation('$ npm publish', 'deploy_or_version_bump');
        });
        it('blocks fenced wrangler deploy', () => {
            expectViolation('run:\n```\nwrangler deploy\n```', 'deploy_or_version_bump');
        });
        it('blocks line-start npm version bump', () => {
            expectViolation('npm version patch', 'deploy_or_version_bump');
        });
    });
});

describe('reclaimStrandedAssignedTask (Bug B)', () => {
    const meshId = `test_reclaim_${Date.now()}`;
    beforeEach(() => { __clearMeshQueueForTests(meshId); });
    afterEach(() => { __clearMeshQueueForTests(meshId); __resetMeshRuntimeStoreForTests(); });

    it('returns an assigned row to pending, clears ownership, and records a task_reclaimed ledger entry', () => {
        enqueueTask(meshId, 'work', { targetNodeId: 'n' });
        const claimed = claimNextTask(meshId, 'n', 'sess-x', [], { providerType: 'claude-cli' })!;
        expect(claimed.status).toBe('assigned');

        const result = reclaimStrandedAssignedTask(meshId, claimed.id, { reason: 'assigned_stranded_dispatch_unconfirmed', ageMs: 999_000 });
        expect(result).not.toBeNull();
        expect(result!.status).toBe('pending');
        expect(result!.assignedNodeId).toBeUndefined();
        expect(result!.assignedSessionId).toBeUndefined();
        expect(result!.assignedProviderType).toBeUndefined();
        expect(result!.dispatchTimestamp).toBeUndefined();
        expect(result!.strandedReclaimCount).toBe(1);

        const reclaimed = readLedgerEntries(meshId).filter(e => e.kind === 'task_reclaimed');
        expect(reclaimed).toHaveLength(1);
        expect((reclaimed[0].payload as any).taskId).toBe(claimed.id);
        expect((reclaimed[0].payload as any).reclaimCount).toBe(1);
        expect((reclaimed[0].payload as any).ageMs).toBe(999_000);
    });

    it('is a no-op on a non-assigned (pending) row — never resurrects a terminal/idle row', () => {
        const entry = enqueueTask(meshId, 'work');
        expect(reclaimStrandedAssignedTask(meshId, entry.id, {})).toBeNull();
        expect(getQueue(meshId)[0].status).toBe('pending');
    });

    it('is bounded: after MAX_STRANDED_RECLAIMS reclaims the task is failed, not requeued forever', () => {
        enqueueTask(meshId, 'work', { targetNodeId: 'n' });
        let outcome: any = null;
        // Each iteration: claim (→ assigned) then reclaim. The 4th reclaim crosses the
        // cap (MAX_STRANDED_RECLAIMS=3) and fails the task instead of cycling.
        for (let i = 0; i < 4; i++) {
            const c = claimNextTask(meshId, 'n', `sess-${i}`, [])!;
            expect(c.status).toBe('assigned');
            outcome = reclaimStrandedAssignedTask(meshId, c.id, { reason: 'test' });
        }
        expect(outcome.status).toBe('failed');
        expect(outcome.strandedReclaimCount).toBe(4);
        expect(String(outcome.cancelReason)).toContain('stranded_dispatch_unrecovered');
    });
});
