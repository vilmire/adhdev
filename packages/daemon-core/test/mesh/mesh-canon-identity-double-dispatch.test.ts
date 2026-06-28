import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    enqueueTask,
    getQueue,
    claimNextTask,
    requeueTask,
    updateSessionTaskStatus,
    cancelTask,
    reclaimStrandedAssignedTask,
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
} from '../../src/mesh/mesh-work-queue.js';
import {
    beginTaskDispatchInFlight,
    endTaskDispatchInFlight,
    isTaskDispatchInFlight,
    __resetTaskDispatchInFlightForTests,
} from '../../src/mesh/mesh-task-inflight.js';

// CANON-IDENTITY double-dispatch regression suite.
//
// Root cause: the same task ran in two sessions because (1) the coordinator/daemon
// id was dedup-compared in two interchangeable forms, and (2) an operator requeue
// reopened a task whose worker was still generating, letting a second session claim
// it. This file exercises the comparator (B) at the SQL claim layer and the
// single-flight requeue guard (C).

const MACH = 'mach_1b46842a15d3409d96ad33e767a916dd';

describe('CANON-IDENTITY — cross-form node dedup at the claim layer (B)', () => {
    const meshId = `canon_dedup_${Date.now()}`;
    beforeEach(() => { __clearMeshQueueForTests(meshId); });
    afterEach(() => { __clearMeshQueueForTests(meshId); __resetMeshRuntimeStoreForTests(); });

    it('a node assigned under daemon_mach_ form is seen BUSY when re-checked under bare mach_ form (one write per node)', () => {
        enqueueTask(meshId, 'task 1');
        enqueueTask(meshId, 'task 2');

        // First write claim stamps the node in the cloud `daemon_mach_` form.
        const c1 = claimNextTask(meshId, `daemon_${MACH}`, 'sessA', [], { providerType: 'claude-cli' });
        expect(c1).not.toBeNull();
        expect(c1?.assignedNodeId).toBe(`daemon_${MACH}`);

        // The SAME physical node, re-checked under the bare `mach_` form, must register
        // as busy — a second write task must NOT double-claim it. A raw `=== ?` on a
        // single form would miss the daemon_-form assigned row and let this through.
        const c2 = claimNextTask(meshId, MACH, 'sessB', [], { providerType: 'claude-cli' });
        expect(c2).toBeNull();

        expect(getQueue(meshId, { status: ['assigned'] })).toHaveLength(1);
        expect(getQueue(meshId, { status: ['pending'] })).toHaveLength(1);
    });

    it('a node-pinned task stamped daemon_mach_ is claimable by the same node arriving bare mach_', () => {
        const t = enqueueTask(meshId, 'pinned', { targetNodeId: `daemon_${MACH}` });
        // The claiming session presents the bare form — it must still resolve the pin.
        const claimed = claimNextTask(meshId, MACH, 'sessA', [], { providerType: 'claude-cli' });
        expect(claimed?.id).toBe(t.id);
    });
});

describe('CANON-IDENTITY — single-flight requeue guard (C)', () => {
    const meshId = `canon_inflight_${Date.now()}`;
    beforeEach(() => { __clearMeshQueueForTests(meshId); __resetTaskDispatchInFlightForTests(); });
    afterEach(() => {
        __clearMeshQueueForTests(meshId);
        __resetMeshRuntimeStoreForTests();
        __resetTaskDispatchInFlightForTests();
    });

    it('refuses to requeue an in-flight (dispatched/generating) task — closes the requeue-while-generating double-dispatch', () => {
        const t = enqueueTask(meshId, 'work');
        const claimed = claimNextTask(meshId, 'node1', 'sessA');
        expect(claimed?.status).toBe('assigned');

        // tryAssignQueueTask marks the task in-flight the moment it hands it to a transport.
        beginTaskDispatchInFlight(meshId, t.id);

        // Operator requeue WHILE the worker is still generating → refused (no-op): the row
        // stays `assigned` so no second session can claim it.
        const refused = requeueTask(meshId, t.id, { reason: 'retry' });
        expect(refused?.status).toBe('assigned');
        expect(getQueue(meshId).find(x => x.id === t.id)?.status).toBe('assigned');
        expect(refused?.requeueCount ?? 0).toBe(0); // never bumped — the requeue did not run

        // force=true is the explicit operator override → it DOES reopen the task.
        const forced = requeueTask(meshId, t.id, { reason: 'force override', force: true });
        expect(forced?.status).toBe('pending');
        expect(isTaskDispatchInFlight(meshId, t.id)).toBe(false);
    });

    it('a stale assigned task (claimed but never dispatched → not in-flight) still requeues by default (no regression)', () => {
        const t = enqueueTask(meshId, 'work');
        // Claimed but the dispatch never began (dead session) — NOT in-flight.
        claimNextTask(meshId, 'node1', 'dead-session');
        const requeued = requeueTask(meshId, t.id, { reason: 'retry on another session' });
        expect(requeued?.status).toBe('pending');
        expect(requeued?.assignedSessionId).toBeUndefined();
        // A fresh session can now claim the reopened task.
        expect(claimNextTask(meshId, 'node1', 'fresh-session')?.id).toBe(t.id);
    });

    it('a terminal completion clears the in-flight mark so a later requeue is allowed', () => {
        const t = enqueueTask(meshId, 'work');
        claimNextTask(meshId, 'node1', 'sessA');
        beginTaskDispatchInFlight(meshId, t.id);
        expect(isTaskDispatchInFlight(meshId, t.id)).toBe(true);

        // Worker finishes → terminal transition clears the single-flight window.
        updateSessionTaskStatus(meshId, 'sessA', 'completed');
        expect(isTaskDispatchInFlight(meshId, t.id)).toBe(false);
        expect(getQueue(meshId).find(x => x.id === t.id)?.status).toBe('completed');
    });

    it('cancel clears the in-flight mark', () => {
        const t = enqueueTask(meshId, 'work');
        claimNextTask(meshId, 'node1', 'sessA');
        beginTaskDispatchInFlight(meshId, t.id);
        cancelTask(meshId, t.id, { reason: 'operator cancel' });
        expect(isTaskDispatchInFlight(meshId, t.id)).toBe(false);
    });

    it('reclaiming a stranded assigned row clears the in-flight mark', () => {
        const t = enqueueTask(meshId, 'work', { targetNodeId: 'n' });
        claimNextTask(meshId, 'n', 'sessA', [], { providerType: 'claude-cli' });
        beginTaskDispatchInFlight(meshId, t.id);
        reclaimStrandedAssignedTask(meshId, t.id, { reason: 'assigned_stranded_dispatch_unconfirmed' });
        expect(isTaskDispatchInFlight(meshId, t.id)).toBe(false);
        expect(getQueue(meshId).find(x => x.id === t.id)?.status).toBe('pending');
    });
});

describe('mesh-task-inflight module', () => {
    beforeEach(() => { __resetTaskDispatchInFlightForTests(); });
    afterEach(() => { __resetTaskDispatchInFlightForTests(); });

    it('begin returns true once, then false for a redundant begin (a dispatch is already live)', () => {
        expect(beginTaskDispatchInFlight('m', 't')).toBe(true);
        expect(beginTaskDispatchInFlight('m', 't')).toBe(false);
        expect(isTaskDispatchInFlight('m', 't')).toBe(true);
    });

    it('end is idempotent and scoped per (mesh, task)', () => {
        beginTaskDispatchInFlight('m', 't1');
        beginTaskDispatchInFlight('m', 't2');
        endTaskDispatchInFlight('m', 't1');
        expect(isTaskDispatchInFlight('m', 't1')).toBe(false);
        expect(isTaskDispatchInFlight('m', 't2')).toBe(true);
        endTaskDispatchInFlight('m', 't1'); // no throw on a second clear
    });

    it('ignores empty mesh/task ids', () => {
        expect(beginTaskDispatchInFlight('', 't')).toBe(false);
        expect(beginTaskDispatchInFlight('m', '')).toBe(false);
        expect(isTaskDispatchInFlight('', '')).toBe(false);
    });
});
