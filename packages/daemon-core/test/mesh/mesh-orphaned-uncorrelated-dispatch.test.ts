/**
 * ORPHANED-UNCORRELATED-DISPATCH (live: task 14147d9b, preview mesh, 2026-10-06).
 *
 * A `mesh_send_task` aimed at a session that already held an open mesh attempt
 * had its `dispatch_accepted` REFUSED by the turn ledger. turn_observe answered
 * `ledger_not_owner`, mcp-server read that as "ledger unavailable", sent anyway
 * and materialised an `assigned` queue row with NO attemptId. Reclaim is
 * turn-ledger-only, so the row stayed `assigned` for days and blocked write
 * autolaunch on its node (`node_has_active_assignment`).
 *
 *   (a) the refusal now has its own code — session_busy_with_task, naming the
 *       attempt in the way — distinct from "no ledger" (turn_ledger_unavailable);
 *   (b) housekeeping fails an attempt-less assigned row whose session is not live
 *       once it is 30 min old (orphaned_uncorrelated_dispatch), and never touches
 *       a row with an attempt or a row whose session is live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

const testTmpDir = path.join(tmpdir(), `adhdev-orphaned-dispatch-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(() => undefined),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    getQueue,
    requeueTask,
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
} from '../../src/mesh/mesh-work-queue.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedgerForIpc, turnLedgerIpcHandlers } from '../../src/commands/low-family/turn-ledger-ipc.js';
import { classifySessionBusyWithTask } from '../../src/mesh/mesh-session-busy-dispatch.js';
import {
    ORPHANED_UNCORRELATED_DISPATCH_REASON,
    STALE_ASSIGNED_QUEUE_MS,
    resolveAssignedSessionLiveness,
    sweepOrphanedUncorrelatedDispatches,
    type AssignedSessionLiveness,
} from '../../src/mesh/mesh-orphaned-dispatch-sweep.js';
import { readLocalRecords } from '../../src/mesh/mesh-local-records.js';
import { createTurnScheduler } from '../../src/mesh/turn-ledger/scheduler.js';
import { MeshNodeGitStateStore } from '../../src/mesh/mesh-node-git-state.js';
import { nodeHasActiveWriteAssignment } from '../../src/mesh/mesh-scheduling-fitness.js';
import { fakePublisher } from '../turn-ledger/ledger-harness.js';
import { drainPendingMeshCoordinatorEvents } from '../helpers/pending-notices.js';

const NODE = 'node_worker';

afterEach(() => {
    setActiveTurnLedgerForIpc(null);
    __resetMeshRuntimeStoreForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ─── (a) refused vs unavailable ─────────────────────────────────────────────

describe('(a) turn_observe distinguishes a refused dispatch from an unavailable ledger', () => {
    const meshId = 'mesh_orphan_a';
    const observe = (taskId: string, sessionId: string) => turnLedgerIpcHandlers.turn_observe({ deps: { statusInstanceId: 'dc' } } as any, {
        v: 1,
        evidence: {
            eventId: taskId, at: Date.now(), source: 'dispatch', sessionId, taskId, observedBy: 'dc',
            kind: 'dispatch_accepted', scope: 'mesh_direct', messageId: taskId, meshId, nodeId: NODE,
        },
    }) as Promise<any>;

    beforeEach(() => { __resetMeshRuntimeStoreForTests(); });

    it('REFUSED: a second dispatch onto a session holding an open attempt answers session_busy_with_task naming that attempt', async () => {
        const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', publisher: fakePublisher() });
        setActiveTurnLedgerForIpc(ledger);
        const session = `sess_${randomUUID().slice(0, 8)}`;
        const firstTask = randomUUID();
        const first = await observe(firstTask, session);
        expect(first.success).toBe(true);

        const second = await observe(randomUUID(), session);
        expect(second.success).toBe(false);
        // Was `ledger_not_owner` — indistinguishable from "this daemon is not the owner".
        expect(second.code).toBe('session_busy_with_task');
        const busy = classifySessionBusyWithTask(second.error);
        expect(busy).toEqual({ currentTaskId: firstTask, currentAttemptId: first.attemptRef.attemptId });
    });

    it('UNAVAILABLE: no armed ledger answers turn_ledger_unavailable, never session_busy_with_task', async () => {
        setActiveTurnLedgerForIpc(null);
        const res = await observe(randomUUID(), `sess_${randomUUID().slice(0, 8)}`);
        expect(res.success).toBe(false);
        expect(res.code).toBe('turn_ledger_unavailable');
    });

    it('a dispatch onto a free session still opens its attempt', async () => {
        setActiveTurnLedgerForIpc(createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', publisher: fakePublisher() }));
        const res = await observe(randomUUID(), `sess_${randomUUID().slice(0, 8)}`);
        expect(res.success).toBe(true);
        expect(res.attemptRef.attemptId).toBeTruthy();
    });
});

// ─── (b) the housekeeping sweep ─────────────────────────────────────────────

describe('(b) attempt-less assigned rows are reclaimed by housekeeping', () => {
    let meshId: string;
    const NOW = Date.now();

    beforeEach(() => {
        meshId = `mesh_orphan_b_${randomUUID().slice(0, 8)}`;
        __resetMeshRuntimeStoreForTests();
        __clearMeshQueueForTests(meshId);
        drainPendingMeshCoordinatorEvents();
    });

    /** Insert the row directly so its age (updatedAt) is controllable — the shape mcp-server's direct dispatch writes. */
    function assignedRow(opts: { ageMs: number; sessionId: string; attemptId?: string }): string {
        const id = randomUUID();
        const at = new Date(NOW - opts.ageMs).toISOString();
        MeshRuntimeStore.getInstance().insertQueueEntry({
            id, meshId, message: 'direct work', status: 'assigned', difficulty: 'medium',
            targetNodeId: NODE, assignedNodeId: NODE, targetSessionId: opts.sessionId, assignedSessionId: opts.sessionId,
            ...(opts.attemptId ? { attemptId: opts.attemptId } : {}),
            dispatchTimestamp: at, createdAt: at, updatedAt: at,
        } as any);
        expect(getQueue(meshId).find((t) => t.id === id)?.updatedAt).toBe(at);
        return id;
    }

    const status = (id: string) => getQueue(meshId).find((t) => t.id === id);
    const sweep = (liveness: (row: any) => AssignedSessionLiveness, now = NOW) =>
        sweepOrphanedUncorrelatedDispatches(meshId, { now, liveness });

    it('fails an orphan row once it is older than the threshold — with one ledger entry and one coordinator notice', () => {
        const orphan = assignedRow({ ageMs: STALE_ASSIGNED_QUEUE_MS + 60_000, sessionId: 'sess_gone' });

        const failed = sweep(() => 'not_live');
        expect(failed.map((r) => r.id)).toEqual([orphan]);
        expect(status(orphan)?.status).toBe('failed');
        expect(status(orphan)?.cancelReason).toBe(ORPHANED_UNCORRELATED_DISPATCH_REASON);

        const records = readLocalRecords(meshId, { kind: ['task_failed'] }).filter((r) => r.taskId === orphan);
        expect(records).toHaveLength(1);
        expect((records[0].payload as any).reason).toBe(ORPHANED_UNCORRELATED_DISPATCH_REASON);

        const notices = drainPendingMeshCoordinatorEvents(meshId).filter((n) => n.metadataEvent?.taskId === orphan);
        expect(notices).toHaveLength(1);
        expect(notices[0].metadataEvent.reason).toBe(ORPHANED_UNCORRELATED_DISPATCH_REASON);

        // Idempotent: a second pass finds nothing and pages nobody.
        expect(sweep(() => 'not_live')).toEqual([]);
        expect(readLocalRecords(meshId, { kind: ['task_failed'] }).filter((r) => r.taskId === orphan)).toHaveLength(1);
        expect(drainPendingMeshCoordinatorEvents(meshId)).toHaveLength(0);
    });

    it('leaves the same row alone before the threshold', () => {
        const young = assignedRow({ ageMs: STALE_ASSIGNED_QUEUE_MS - 60_000, sessionId: 'sess_gone' });
        expect(sweep(() => 'not_live')).toEqual([]);
        expect(status(young)?.status).toBe('assigned');
    });

    it('a dangling attempt reference is recoverable and releases the node gate without losing the task', () => {
        const owned = assignedRow({ ageMs: STALE_ASSIGNED_QUEUE_MS * 4, sessionId: 'sess_gone', attemptId: 'mesh_direct:owned' });
        const liveness = vi.fn(() => 'not_live' as const);
        const store = MeshRuntimeStore.getInstance();
        const before = status(owned)!;
        before.dependsOn = ['prerequisite'];
        before.requeueCount = 1;
        store.updateQueueEntry(before);
        // Updating the row refreshes updatedAt; age from that persisted write.
        const sweepAt = Date.parse(status(owned)!.updatedAt) + STALE_ASSIGNED_QUEUE_MS + 1000;
        expect(nodeHasActiveWriteAssignment(meshId, NODE)).toBe(true);
        expect(sweep(liveness, sweepAt).map((r) => r.id)).toEqual([owned]);
        expect(nodeHasActiveWriteAssignment(meshId, NODE)).toBe(false);
        expect(status(owned)).toMatchObject({ id: owned, status: 'failed', message: 'direct work', dependsOn: ['prerequisite'], requeueCount: 1 });
        // Automatic passes cannot reopen this row or loop around the retry cap.
        expect(sweep(liveness)).toEqual([]);
        expect(requeueTask(meshId, owned)?.cancelReason).toContain('max_retries_exceeded');
        expect(requeueTask(meshId, owned, { force: true })).toMatchObject({ id: owned, status: 'pending', message: 'direct work', dependsOn: ['prerequisite'], requeueCount: 2 });
    });

    it('an open attempt stays ledger-owned and gets a forced probe when its session is gone', () => {
        const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'test-machine', publisher: fakePublisher() });
        const id = assignedRow({ ageMs: STALE_ASSIGNED_QUEUE_MS * 4, sessionId: 'sess_gone' });
        const opened = ledger.observe({
            eventId: 'open', at: NOW - STALE_ASSIGNED_QUEUE_MS * 4, source: 'dispatch',
            sessionId: 'sess_gone', taskId: id, observedBy: 'test-machine', kind: 'dispatch_accepted',
            scope: 'mesh_queue', messageId: id, meshId, nodeId: NODE,
        });
        const attemptId = opened.attempt!.attemptId;
        const row = status(id)!;
        row.attemptId = attemptId;
        MeshRuntimeStore.getInstance().updateQueueEntry(row);
        const sweepAt = Date.parse(status(id)!.updatedAt) + STALE_ASSIGNED_QUEUE_MS + 1000;
        const requestProbe = vi.fn();
        expect(sweepOrphanedUncorrelatedDispatches(meshId, { now: sweepAt, liveness: () => 'not_live', requestProbe })).toEqual([]);
        expect(requestProbe).toHaveBeenCalledWith(attemptId);
        expect(status(id)?.status).toBe('assigned');
        requestProbe.mockClear();
        sweepOrphanedUncorrelatedDispatches(meshId, { now: sweepAt, liveness: () => 'live', requestProbe });
        expect(requestProbe).not.toHaveBeenCalled();
    });

    it('a confirmed dead correlated worker is reclaimed through the ledger and releases the node write gate', async () => {
        let now = NOW;
        const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'test-machine', publisher: fakePublisher(), now: () => now });
        const id = assignedRow({ ageMs: STALE_ASSIGNED_QUEUE_MS + 1000, sessionId: 'sess_gone' });
        const opened = ledger.observe({ eventId: 'correlated-open', at: NOW, source: 'dispatch',
            sessionId: 'sess_gone', taskId: id, observedBy: 'test-machine', kind: 'dispatch_accepted',
            scope: 'mesh_queue', messageId: id, meshId, nodeId: NODE });
        const attemptId = opened.attempt!.attemptId;
        const base = { at: NOW, sessionId: 'sess_gone', observedBy: 'test-machine', attemptRef: { attemptId, generation: 0 } };
        ledger.observe({ ...base, eventId: 'delivered', source: 'input_service', kind: 'delivered', messageId: id, outcome: 'delivered', via: 'local' });
        ledger.observe({ ...base, eventId: 'started', source: 'fsm_edge', kind: 'turn_started', retro: false });
        const row = status(id)!;
        row.attemptId = attemptId;
        MeshRuntimeStore.getInstance().updateQueueEntry(row);
        now += STALE_ASSIGNED_QUEUE_MS + 1000;
        const scheduler = createTurnScheduler({ ledger, now: () => now,
            probe: { locate: () => ({ kind: 'local' }), reader: { read: async () => ({ presence: 'absent' }) } } });
        sweepOrphanedUncorrelatedDispatches(meshId, { now, liveness: () => 'not_live', requestProbe: (id) => scheduler.requestProbe(id) });
        await scheduler.tick();
        expect(status(id)).toMatchObject({ id, status: 'pending', message: 'direct work', requeueReason: 'session_dead' });
        expect(ledger.getAttempt(attemptId)).toMatchObject({ generation: 1, reclaimCount: 1 });
        expect(nodeHasActiveWriteAssignment(meshId, NODE)).toBe(false);
        scheduler.stop();
    });

    it('never touches a row whose session is live, or whose liveness is unknown', () => {
        const live = assignedRow({ ageMs: STALE_ASSIGNED_QUEUE_MS * 4, sessionId: 'sess_live', attemptId: 'dangling-but-live' });
        const unknown = assignedRow({ ageMs: STALE_ASSIGNED_QUEUE_MS * 4, sessionId: 'sess_unknown' });
        const failed = sweep((row) => (row.assignedSessionId === 'sess_live' ? 'live' : 'unknown'));
        expect(failed).toEqual([]);
        expect(status(live)?.status).toBe('assigned');
        expect(status(unknown)?.status).toBe('assigned');
        expect(nodeHasActiveWriteAssignment(meshId, NODE)).toBe(true);
    });

    describe('resolveAssignedSessionLiveness (local node)', () => {
        const mesh = { id: 'm', nodes: [{ id: NODE, workspace: '/repo' }] };
        const components = (sessionIds: string[]) => ({
            instanceManager: {
                getByCategory: () => sessionIds.map((sid) => ({ getState: () => ({ instanceId: sid, status: 'idle' }) })),
                getInstance: () => undefined,
            },
        }) as any;
        const row = (sessionId: string) => ({
            id: 't', meshId: 'm', message: 'x', status: 'assigned', assignedNodeId: NODE, assignedSessionId: sessionId,
            createdAt: new Date(NOW - STALE_ASSIGNED_QUEUE_MS * 2).toISOString(), updatedAt: new Date(NOW - STALE_ASSIGNED_QUEUE_MS * 2).toISOString(),
        }) as any;

        it('a session absent from the local node is not live', () => {
            expect(resolveAssignedSessionLiveness(components([]), 'm', mesh, row('sess_gone'))).toBe('not_live');
        });
        it('a session present on the local node is live', () => {
            expect(resolveAssignedSessionLiveness(components(['sess_here']), 'm', mesh, row('sess_here'))).toBe('live');
        });
        it('a failed local list is unknown and a registry worker stays protected', () => {
            const c = components([]);
            c.instanceManager.getByCategory = () => { throw new Error('list unavailable'); };
            expect(resolveAssignedSessionLiveness(c, 'm', mesh, row('sess_gone'))).toBe('unknown');
            c.sessionRegistry = { has: () => true };
            expect(resolveAssignedSessionLiveness(c, 'm', mesh, row('sess_here'))).toBe('live');
        });
        it('a fresh complete empty member push proves absence; truncated or missing pushes do not', () => {
            const store = new MeshNodeGitStateStore();
            const c = { ...components([]), router: { meshNodeGitState: store } };
            const remoteMesh = { id: 'm', nodes: [{ id: NODE, workspace: '/repo', daemonId: 'remote-daemon', machineId: 'remote-daemon' }] };
            const push = (sessions: any[], sessionsTruncated = false) => store.recordRuntimeObservation({
                meshId: 'm', nodeId: NODE, workspace: '/repo', source: 'member_push', daemonId: 'remote-daemon',
                runtime: { schemaVersion: 1, daemonId: 'remote-daemon', sessions, sessionsTruncated },
            });
            push([]);
            expect(resolveAssignedSessionLiveness(c, 'm', remoteMesh, row('sess_gone'))).toBe('not_live');
            push([], true);
            expect(resolveAssignedSessionLiveness(c, 'm', remoteMesh, row('sess_gone'))).toBe('unknown');
            push([{ id: 'sess_here' }]);
            expect(resolveAssignedSessionLiveness(c, 'm', remoteMesh, row('sess_here'))).toBe('live');
        });
        it('a remote node with no held runtime is unknown (never convicted)', () => {
            const remoteMesh = { id: 'm', nodes: [{ id: NODE, workspace: '/repo', daemonId: 'remote-daemon', machineId: 'remote-daemon' }] };
            expect(resolveAssignedSessionLiveness(components([]), 'm', remoteMesh, row('sess_far'))).toBe('unknown');
        });
    });
});
