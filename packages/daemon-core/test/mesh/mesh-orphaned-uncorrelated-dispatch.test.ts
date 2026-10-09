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

    it('never touches a row WITH an attempt (the turn ledger owns it) — liveness is not even asked', () => {
        const owned = assignedRow({ ageMs: STALE_ASSIGNED_QUEUE_MS * 4, sessionId: 'sess_gone', attemptId: 'mesh_direct:owned' });
        const liveness = vi.fn(() => 'not_live' as const);
        expect(sweep(liveness)).toEqual([]);
        expect(liveness).not.toHaveBeenCalled();
        expect(status(owned)?.status).toBe('assigned');
    });

    it('never touches a row whose session is live, or whose liveness is unknown', () => {
        const live = assignedRow({ ageMs: STALE_ASSIGNED_QUEUE_MS * 4, sessionId: 'sess_live' });
        const unknown = assignedRow({ ageMs: STALE_ASSIGNED_QUEUE_MS * 4, sessionId: 'sess_unknown' });
        const failed = sweep((row) => (row.assignedSessionId === 'sess_live' ? 'live' : 'unknown'));
        expect(failed).toEqual([]);
        expect(status(live)?.status).toBe('assigned');
        expect(status(unknown)?.status).toBe('assigned');
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
        it('a remote node with no held runtime is unknown (never convicted)', () => {
            const remoteMesh = { id: 'm', nodes: [{ id: NODE, workspace: '/repo', daemonId: 'remote-daemon', machineId: 'remote-daemon' }] };
            expect(resolveAssignedSessionLiveness(components([]), 'm', remoteMesh, row('sess_far'))).toBe('unknown');
        });
    });
});
