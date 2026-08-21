// SIBLING-DISPATCH-ORPHAN regression suite.
//
// recordDirectDispatchTask materialises TWO rows for one direct dispatch: a QUEUE entry and
// a `mesh_direct_dispatches` entry. Every queue-row abandonment path (cancelTask, requeueTask
// incl. its dispatch-failure branch, reclaimStrandedAssignedTask) used to touch only the queue
// row, orphaning the dispatch row forever:
//
//   - markStaleDirectDispatches sweeps ONLY status='dispatched', so an 'acked' row (the worker
//     confirmed it started) had NO timeout sweeper at all — measured live at 12 days old; and
//   - buildMeshActiveWork excludes CANCELLED queue rows from its dedupe set (mesh-active-work.ts
//     :466/:528), so the orphan is not deduped against its sibling and is emitted as its own
//     NON-TERMINAL activeWork row for a task that is already terminal.
//
// Net effect: an abandoned task keeps rendering as live work, forever. These tests pin BOTH
// halves — the store row must leave the active set, and it must not surface as a live
// activeWork row.
//
// On the rendered STATUS specifically: the `dbStatus === 'acked' ? 'generating' : 'assigned'`
// fallback at :543 is the LAST term of an || chain, so it only shows through when neither the
// turn-reducer overlay nor a live session status is present. With a turn attempt open (the
// normal case for a dispatch that reached 'acked') the overlay wins and the orphan renders
// 'failed'/turnStage 'cancelled' instead. These tests therefore assert the row's ABSENCE
// rather than any one status string, which holds under every one of those branches.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    recordDirectDispatchTask,
    cancelTask,
    requeueTask,
    reclaimStrandedAssignedTask,
    getQueue,
    getActiveDirectDispatches,
    updateDirectDispatchStatus,
    insertDirectDispatch,
    __clearMeshQueueForTests,
    __clearDirectDispatchesForTests,
    __resetMeshRuntimeStoreForTests,
} from '../../src/mesh/mesh-work-queue.js';
import { buildMeshActiveWork } from '../../src/mesh/mesh-active-work.js';
import { getLedgerDir, readLedgerEntries } from '../../src/mesh/mesh-ledger.js';

describe('SIBLING-DISPATCH-ORPHAN: abandoning a queue row terminalizes its direct-dispatch sibling', () => {
    const meshId = `test_mesh_sdo_${Date.now()}`;
    const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`);
    const nodeId = 'node_worker';
    const sessionId = 'sess-worker-1';

    const reset = () => {
        __clearMeshQueueForTests(meshId);
        // Must clear the dispatch table too: __clearMeshQueueForTests drops only the QUEUE,
        // and the whole point of this suite is a row that outlives its queue sibling — so
        // without this, one case's orphan leaks into the next and the negative cases below
        // assert against another test's leftovers instead of their own condition.
        __clearDirectDispatchesForTests(meshId);
        if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath);
    };

    beforeEach(reset);
    afterEach(() => {
        reset();
        __resetMeshRuntimeStoreForTests();
    });

    /**
     * Reproduce the live shape: a direct dispatch that the worker ACKED (generating_started
     * landed), i.e. the exact status that has no sweeper. Returns the task id.
     */
    const dispatchAndAck = (taskId: string): string => {
        recordDirectDispatchTask(meshId, 'run the canary probes', {
            id: taskId,
            assignedNodeId: nodeId,
            assignedSessionId: sessionId,
            difficulty: 'medium',
        });
        insertDirectDispatch(meshId, {
            taskId,
            nodeId,
            sessionId,
            providerType: 'kimi',
            message: 'run the canary probes',
            via: 'mesh_send_task',
            dispatchedAt: new Date().toISOString(),
        });
        // The worker confirmed it started. 'acked' is the load-bearing status: it is the one
        // markStaleDirectDispatches does NOT sweep (it filters status='dispatched'), so before
        // this fix nothing in the system would ever collect the row.
        updateDirectDispatchStatus(meshId, sessionId, 'acked', taskId);
        expect(getActiveDirectDispatches(meshId).map(d => d.taskId)).toContain(taskId);
        return taskId;
    };

    /**
     * Render activeWork the way the coordinator surfaces do, and find this task's rows.
     *
     * The node MUST carry a live `generating` session. That is not decoration — it is the
     * condition that makes the orphan visible at all. `classifyDirectDispatch` diverts a
     * dispatch row into staleDirectWork whenever the session is missing from the live
     * records or reports no status (`isNoTransition`), so a naive fixture with an empty
     * `sessions: []` sends the orphan to the stale bucket and the assertion below passes
     * even with the fix reverted. The live-generating session is what the leak actually
     * looked like: the worker really was still running when the task was cancelled.
     */
    const renderActiveWork = (taskId: string) => {
        const { activeWork } = buildMeshActiveWork({
            meshId,
            queue: getQueue(meshId),
            directDispatches: getActiveDirectDispatches(meshId),
            ledgerEntries: readLedgerEntries(meshId),
            nodes: [{ id: nodeId, sessions: [{ id: sessionId, status: 'generating' }] } as any],
        } as any);
        return activeWork.filter(r => r.taskId === taskId);
    };

    it('cancelTask: an ACKED sibling dispatch row leaves the active set (no orphan)', () => {
        const taskId = dispatchAndAck('task-cancel-1');

        cancelTask(meshId, taskId, { reason: 'operator_cancel' });

        expect(getQueue(meshId).find(t => t.id === taskId)?.status).toBe('cancelled');
        // THE INJECTION POINT: without terminalizeSiblingDispatch this row is still here.
        expect(getActiveDirectDispatches(meshId).map(d => d.taskId)).not.toContain(taskId);
    });

    it('cancelTask: the cancelled task is NOT rendered as live active work', () => {
        const taskId = dispatchAndAck('task-cancel-2');

        cancelTask(meshId, taskId, { reason: 'operator_cancel' });

        // The live symptom, stated as what is actually observable rather than as one status
        // string: the orphan reaches activeWork as a NON-TERMINAL (`terminal: false`) row for
        // a task that is already cancelled, and every consumer of activeWork — generatingCount,
        // sessionHasActiveAssignment, routing fitness, idle reminders — reads it as live work.
        //
        // Note the rendered STATUS is not a reliable pin here: with a turn attempt present the
        // reducer overlay (turnStage 'cancelled') outranks the `acked → generating` fallback at
        // mesh-active-work.ts:543, so the orphan renders 'failed'; the bare 'generating' shape
        // is what appears when no attempt exists. Asserting the row's ABSENCE covers both.
        expect(renderActiveWork(taskId)).toHaveLength(0);
    });

    it('cancelTask: records a sibling_dispatch_terminalized audit entry naming the reason', () => {
        const taskId = dispatchAndAck('task-cancel-3');

        cancelTask(meshId, taskId, { reason: 'operator_cancel' });

        const audit = readLedgerEntries(meshId)
            .filter(e => e.kind === 'sibling_dispatch_terminalized' && (e.payload as any)?.taskId === taskId);
        expect(audit).toHaveLength(1);
        expect((audit[0].payload as any).reason).toBe('queue_task_cancelled');
        // The status the row was rescued FROM is what makes the next occurrence diagnosable.
        expect((audit[0].payload as any).dispatchStatus).toBe('acked');
    });

    it('requeueTask: an ACKED sibling dispatch row leaves the active set (no orphan)', () => {
        const taskId = dispatchAndAck('task-requeue-1');

        // force: the row is in-flight by construction (that is the case that orphans), and the
        // single-flight guard would otherwise no-op the requeue.
        requeueTask(meshId, taskId, { reason: 'operator_requeue', force: true });

        expect(getQueue(meshId).find(t => t.id === taskId)?.status).toBe('pending');
        // THE INJECTION POINT for the requeue path.
        expect(getActiveDirectDispatches(meshId).map(d => d.taskId)).not.toContain(taskId);
    });

    it('requeueTask: the requeued task renders only its queue row, never a second direct row', () => {
        const taskId = dispatchAndAck('task-requeue-2');

        requeueTask(meshId, taskId, { reason: 'operator_requeue', force: true });

        // A requeued task legitimately shows as `pending` from its QUEUE row. What must not
        // survive is a SECOND row sourced from the abandoned dispatch — one task rendering as
        // two units of active work, which is what inflates the coordinator's counts.
        const rendered = renderActiveWork(taskId);
        expect(rendered).toHaveLength(1);
        expect(rendered[0].source).toBe('queue');
        expect(rendered[0].status).toBe('pending');
    });

    it('requeueTask: records the audit entry with the requeue reason', () => {
        const taskId = dispatchAndAck('task-requeue-3');

        requeueTask(meshId, taskId, { reason: 'operator_requeue', force: true });

        const audit = readLedgerEntries(meshId)
            .filter(e => e.kind === 'sibling_dispatch_terminalized' && (e.payload as any)?.taskId === taskId);
        expect(audit).toHaveLength(1);
        expect((audit[0].payload as any).reason).toBe('queue_task_requeued');
    });

    it('requeueTask (dispatchFailure branch): terminalizes the sibling under its own reason', () => {
        const taskId = dispatchAndAck('task-dispatchfail-1');

        requeueTask(meshId, taskId, { reason: 'transport_reject', dispatchFailure: true, force: false });

        expect(getActiveDirectDispatches(meshId).map(d => d.taskId)).not.toContain(taskId);
        const audit = readLedgerEntries(meshId)
            .filter(e => e.kind === 'sibling_dispatch_terminalized' && (e.payload as any)?.taskId === taskId);
        expect(audit).toHaveLength(1);
        expect((audit[0].payload as any).reason).toBe('queue_task_dispatch_failed');
    });

    it('reclaimStrandedAssignedTask: terminalizes the sibling of the row it tears down', () => {
        const taskId = dispatchAndAck('task-stranded-1');
        // recordDirectDispatchTask leaves the queue row 'assigned', which is what the
        // stranded-reclaim watchdog acts on.
        expect(getQueue(meshId).find(t => t.id === taskId)?.status).toBe('assigned');

        reclaimStrandedAssignedTask(meshId, taskId, { reason: 'assigned_stranded_dispatch_unconfirmed' });

        expect(getActiveDirectDispatches(meshId).map(d => d.taskId)).not.toContain(taskId);
        const audit = readLedgerEntries(meshId)
            .filter(e => e.kind === 'sibling_dispatch_terminalized' && (e.payload as any)?.taskId === taskId);
        expect(audit).toHaveLength(1);
        expect((audit[0].payload as any).reason).toBe('queue_task_stranded_reclaimed');
    });

    it('cancelling a task that was never dispatched leaves no row and writes no audit noise', () => {
        // The negative half of the live finding: a pre-dispatch cancel never orphaned anything,
        // so it must not now start emitting a terminalization record for a row that never existed.
        recordDirectDispatchTask(meshId, 'never dispatched', {
            id: 'task-nodispatch-1',
            assignedNodeId: nodeId,
            assignedSessionId: sessionId,
            difficulty: 'medium',
        });

        cancelTask(meshId, 'task-nodispatch-1', { reason: 'operator_cancel' });

        expect(getActiveDirectDispatches(meshId)).toHaveLength(0);
        // Scoped to THIS task: the ledger is per-mesh and append-only, so earlier cases in
        // this file have legitimately written their own entries.
        expect(readLedgerEntries(meshId).filter(e =>
            e.kind === 'sibling_dispatch_terminalized' && (e.payload as any)?.taskId === 'task-nodispatch-1',
        )).toHaveLength(0);
    });

    it('a dispatch row that already reached a terminal status is left alone (no double-record)', () => {
        const taskId = dispatchAndAck('task-already-terminal-1');
        updateDirectDispatchStatus(meshId, sessionId, 'completed', taskId);

        cancelTask(meshId, taskId, { reason: 'operator_cancel' });

        // Already out of the active set by its own path — the flip must not rewrite a
        // 'completed' row to 'stale', and no audit entry is warranted.
        const raw = MeshRuntimeStore.getInstance()
            .getActiveDirectDispatches(meshId).find(d => d.taskId === taskId);
        expect(raw).toBeUndefined();
        expect(readLedgerEntries(meshId).filter(e =>
            e.kind === 'sibling_dispatch_terminalized' && (e.payload as any)?.taskId === taskId,
        )).toHaveLength(0);
    });
});
