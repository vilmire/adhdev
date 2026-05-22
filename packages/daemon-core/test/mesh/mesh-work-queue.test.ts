import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    enqueueTask,
    getQueue,
    claimNextTask,
    updateTaskStatus,
    updateSessionTaskStatus,
    cancelTask,
    requeueTask,
    getMeshQueueStats
} from '../../src/mesh/mesh-work-queue.js';
import { getLedgerDir } from '../../src/mesh/mesh-ledger.js';

describe('Mesh Work Queue (GUPP)', () => {
    const meshId = `test_mesh_${Date.now()}`;
    const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`);

    beforeEach(() => {
        if (fs.existsSync(queuePath)) {
            fs.unlinkSync(queuePath);
        }
    });

    afterEach(() => {
        if (fs.existsSync(queuePath)) {
            fs.unlinkSync(queuePath);
        }
    });

    it('should enqueue tasks and list them', () => {
        const task = enqueueTask(meshId, 'test task 1');
        expect(task.status).to.equal('pending');
        expect(task.message).to.equal('test task 1');

        const queue = getQueue(meshId);
        expect(queue.length).to.equal(1);
        expect(queue[0].id).to.equal(task.id);
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
        const queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
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

        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));

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

        const queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
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

        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));

        const completed = updateSessionTaskStatus(meshId, 'session1', 'completed');
        expect(completed?.id).to.equal(t2.id);

        const q = getQueue(meshId);
        expect(q.find((t: any) => t.id === t1.id)?.status).to.equal('assigned');
        expect(q.find((t: any) => t.id === t2.id)?.status).to.equal('completed');
    });

    it('does not complete a newer continuation task when the completion happened before that task was dispatched', () => {
        const olderTask = enqueueTask(meshId, 'older task');
        const newerTask = enqueueTask(meshId, 'newer continuation task');

        const queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
        const now = Date.now();
        const staleCompletionAt = new Date(now).toISOString();

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

        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));

        const completed = updateSessionTaskStatus(meshId, 'session1', 'completed', { occurredAt: staleCompletionAt });
        expect(completed).to.be.null;

        const q = getQueue(meshId);
        expect(q.find((t: any) => t.id === olderTask.id)?.status).to.equal('completed');
        expect(q.find((t: any) => t.id === newerTask.id)?.status).to.equal('assigned');
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
});
