// SIBLING-DISPATCH-ORPHAN regression suite.
//
// A direct dispatch is TWO things: a QUEUE entry (recordDirectDispatchTask) and — since
// C-W8 — its open `mesh_direct` turn-ledger attempt (formerly a `mesh_direct_dispatches`
// row). Every queue-row abandonment path (cancelTask, requeueTask incl. its
// dispatch-failure branch, the ledger reclaim) used to touch only the queue row, orphaning
// the dispatch forever (measured live at 12 days old), and buildMeshActiveWork excludes
// CANCELLED queue rows from its dedupe set, so the orphan surfaced as its own NON-TERMINAL
// activeWork row. These tests pin BOTH halves — the dispatch must leave the active set
// (its attempt is cancelled on the ledger), and it must not surface as live active work.
// The row's ABSENCE is asserted rather than any one status string.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    recordDirectDispatchTask,
    cancelTask,
    requeueTask,
    requeueTaskForLedgerReclaim,
    getQueue,
    getActiveDirectDispatches,
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
} from '../../src/mesh/mesh-work-queue.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';
import type { TurnLedger } from '../../src/mesh/turn-ledger/ledger.js';
import { confirmTestWriterQuiescence, wipeTurnTablesForTests } from './helpers/mesh-turn-ledger-fixture.js';
import { fakePublisher } from '../turn-ledger/ledger-harness.js';
import { buildMeshActiveWork } from '../../src/mesh/mesh-active-work.js';
import { readLocalRecords } from '../../src/mesh/mesh-local-records.js';
import { getLedgerDir } from '../../src/mesh/mesh-ledger-paths.js';

describe('SIBLING-DISPATCH-ORPHAN: abandoning a queue row terminalizes its direct-dispatch sibling', () => {
    const meshId = `test_mesh_sdo_${Date.now()}`;
    const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`);
    const nodeId = 'node_worker';
    // Unique per case: the store FILE survives __resetMeshRuntimeStoreForTests, and the
    // ledger allows ≤1 open attempt per session, so a shared id would couple the cases.
    let caseNo = 0;
    let sessionId = 'sess-worker-0';

    let ledger: TurnLedger;

    const reset = () => {
        __clearMeshQueueForTests(meshId);
        if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath);
    };

    beforeEach(() => {
        caseNo += 1;
        sessionId = `sess-worker-${caseNo}`;
        reset();
        wipeTurnTablesForTests();
        // A fresh store per case (the open attempts outlive __clearMeshQueueForTests), and
        // the ledger this process's queue-side cancel reaches through the active slot.
        __resetMeshRuntimeStoreForTests();
        ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', publisher: fakePublisher() });
        setActiveTurnLedger(ledger);
    });
    afterEach(() => {
        setActiveTurnLedger(null);
        reset();
        __resetMeshRuntimeStoreForTests();
    });

    const evidence = (taskId: string, body: Record<string, unknown>) => ({
        eventId: `${taskId}:${String(body.kind)}`, at: Date.now(), source: 'dispatch', sessionId, observedBy: 'dc',
        attemptRef: { attemptId: `mesh_direct:${taskId}`, generation: 0 }, ...body,
    }) as any;

    /**
     * Reproduce the live shape: a direct dispatch whose worker STARTED the turn (the
     * old 'acked' status that had no sweeper). The attempt is opened and driven on the
     * real ledger. Returns the task id.
     */
    const dispatchAndAck = (taskId: string): string => {
        recordDirectDispatchTask(meshId, 'run the canary probes', {
            id: taskId,
            assignedNodeId: nodeId,
            assignedSessionId: sessionId,
            difficulty: 'medium',
            attemptId: `mesh_direct:${taskId}`,
        });
        ledger.observe({
            eventId: taskId, at: Date.now(), source: 'dispatch', sessionId, taskId, observedBy: 'dc',
            kind: 'dispatch_accepted', scope: 'mesh_direct', messageId: taskId, meshId, nodeId, providerType: 'kimi-cli',
        } as any);
        ledger.observe(evidence(taskId, { kind: 'delivered', messageId: taskId, outcome: 'delivered', via: 'local' }));
        ledger.observe(evidence(taskId, { kind: 'turn_started', retro: false, source: 'fsm_edge' }));
        const active = getActiveDirectDispatches(meshId).find(d => d.taskId === taskId);
        expect(active?.status).toBe('acked');
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
            ledgerEntries: readLocalRecords(meshId),
            nodes: [{ id: nodeId, sessions: [{ id: sessionId, status: 'generating' }] } as any],
        } as any);
        return activeWork.filter(r => r.taskId === taskId);
    };

    const cancelConfirmed = async (taskId: string) => {
        cancelTask(meshId, taskId, { reason: 'operator_cancel' });
        expect(getQueue(meshId).find(t => t.id === taskId)?.status).toBe('assigned');
        expect(ledger.getAttempt(`mesh_direct:${taskId}`)).toMatchObject({ state: 'stopping', generation: 0, terminal: null });
        expect(renderActiveWork(taskId)).toHaveLength(1);
        await confirmTestWriterQuiescence(ledger);
    };
    const requeueConfirmed = async (taskId: string, options: Parameters<typeof requeueTask>[2]) => {
        // The direct writer has no safe immediate requeue handoff. First refuse
        // the mutation, then use the supported explicit cancel/checkpoint/requeue.
        expect(() => requeueTask(meshId, taskId, options)).toThrow('writer_checkpoint_pending');
        expect(getQueue(meshId).find(t => t.id === taskId)?.status).toBe('assigned');
        await cancelConfirmed(taskId);
        return requeueTask(meshId, taskId, options);
    };
    const assertOneNativeCommit = (taskId: string) => {
        const committed = MeshRuntimeStore.getInstance().db.prepare("SELECT payload_json FROM turn_events WHERE attempt_id = ? AND kind = 'committed'").all(`mesh_direct:${taskId}`) as Array<{payload_json: string}>;
        expect(committed).toHaveLength(1);
        expect(ledger.getAttempt(`mesh_direct:${taskId}`)?.terminal).toMatchObject({ outcome: 'cancelled', reason: 'operator_cancel' });
        expect(readLocalRecords(meshId).filter(e => e.kind === 'sibling_dispatch_terminalized' && e.taskId === taskId)).toHaveLength(0);
    };

    it('cancelTask: an ACKED sibling dispatch row leaves the active set (no orphan)', async () => {
        const taskId = dispatchAndAck('task-cancel-1');

        await cancelConfirmed(taskId);

        expect(getQueue(meshId).find(t => t.id === taskId)?.status).toBe('cancelled');
        // The reducer-owned native commit removes the direct attempt from active work.
        expect(getActiveDirectDispatches(meshId).map(d => d.taskId)).not.toContain(taskId);
    });

    it('cancelTask: the cancelled task is NOT rendered as live active work', async () => {
        const taskId = dispatchAndAck('task-cancel-2');

        await cancelConfirmed(taskId);

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

    it('cancelTask: records exactly one native commit naming the operator reason', async () => {
        const taskId = dispatchAndAck('task-cancel-3');

        await cancelConfirmed(taskId);

        assertOneNativeCommit(taskId);
    });

    it('requeueTask: an ACKED sibling dispatch row leaves the active set (no orphan)', async () => {
        const taskId = dispatchAndAck('task-requeue-1');

        // force: the row is in-flight by construction (that is the case that orphans), and the
        // single-flight guard would otherwise no-op the requeue.
        await requeueConfirmed(taskId, { reason: 'operator_requeue', force: true });

        expect(getQueue(meshId).find(t => t.id === taskId)?.status).toBe('pending');
        // Only the explicit retry after native confirmation may expose a pending row.
        expect(getActiveDirectDispatches(meshId).map(d => d.taskId)).not.toContain(taskId);
    });

    it('requeueTask: the requeued task renders only its queue row, never a second direct row', async () => {
        const taskId = dispatchAndAck('task-requeue-2');

        await requeueConfirmed(taskId, { reason: 'operator_requeue', force: true });

        // A requeued task legitimately shows as `pending` from its QUEUE row. What must not
        // survive is a SECOND row sourced from the abandoned dispatch — one task rendering as
        // two units of active work, which is what inflates the coordinator's counts.
        const rendered = renderActiveWork(taskId);
        expect(rendered).toHaveLength(1);
        expect(rendered[0].source).toBe('queue');
        expect(rendered[0].status).toBe('pending');
    });

    it('requeueTask: records the native cancellation before the explicit requeue', async () => {
        const taskId = dispatchAndAck('task-requeue-3');

        await requeueConfirmed(taskId, { reason: 'operator_requeue', force: true });

        assertOneNativeCommit(taskId);
    });

    it('requeueTask (dispatchFailure branch): refuses the live writer and succeeds only after its native checkpoint', async () => {
        const taskId = dispatchAndAck('task-dispatchfail-1');

        await requeueConfirmed(taskId, { reason: 'transport_reject', dispatchFailure: true, force: false });

        expect(getActiveDirectDispatches(meshId).map(d => d.taskId)).not.toContain(taskId);
        assertOneNativeCommit(taskId);
    });

    it('the ledger reclaim (requeueTaskForLedgerReclaim) never resurrects a natively confirmed terminal sibling', async () => {
        const taskId = dispatchAndAck('task-stranded-1');
        // recordDirectDispatchTask leaves the queue row 'assigned', which is what the
        // ledger's reclaim effect (H1/H2r/R31) requeues.
        expect(getQueue(meshId).find(t => t.id === taskId)?.status).toBe('assigned');

        await cancelConfirmed(taskId);
        requeueTaskForLedgerReclaim(meshId, taskId, 'H1_await_delivery', new Date().toISOString());
        expect(getQueue(meshId).find(t => t.id === taskId)?.status).toBe('cancelled');

        expect(getActiveDirectDispatches(meshId).map(d => d.taskId)).not.toContain(taskId);
        assertOneNativeCommit(taskId);
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
        expect(readLocalRecords(meshId).filter(e =>
            e.kind === 'sibling_dispatch_terminalized' && (e.payload as any)?.taskId === 'task-nodispatch-1',
        )).toHaveLength(0);
    });

    it('a dispatch that already reached a terminal outcome is left alone (no double-record)', async () => {
        const taskId = dispatchAndAck('task-already-terminal-1');
        ledger.observe(evidence(taskId, { kind: 'cancel', reason: 'operator_cancel', source: 'operator' }));
        await confirmTestWriterQuiescence(ledger);
        expect(getActiveDirectDispatches(meshId).find(d => d.taskId === taskId)).toBeUndefined();

        cancelTask(meshId, taskId, { reason: 'operator_cancel' });

        // Already out of the active set by its own path — no second cancel, no audit entry.
        // The attempt keeps the outcome its own cancel wrote — the queue cancel did not re-close it.
        expect(ledger.getAttempt(`mesh_direct:${taskId}`)?.terminal?.reason).toBe('operator_cancel');
        expect(readLocalRecords(meshId).filter(e =>
            e.kind === 'sibling_dispatch_terminalized' && (e.payload as any)?.taskId === taskId,
        )).toHaveLength(0);
    });

    it('the direct writer cannot be hidden by bookkeeping: it remains active until native quiescence', async () => {
        const taskId = dispatchAndAck('task-cleanup-1');
        await cancelConfirmed(taskId);
        const attempt = ledger.getAttempt(`mesh_direct:${taskId}`);
        expect(attempt?.terminal).toMatchObject({ outcome: 'cancelled', reason: 'operator_cancel' });
        assertOneNativeCommit(taskId);
    });
});
