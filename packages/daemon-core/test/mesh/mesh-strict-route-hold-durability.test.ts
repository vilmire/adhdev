import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// STRICT-ROUTE-HOLD-DURABILITY (rc.33) — regression suite.
//
// The defect: a strict-routed completion whose originating coordinator session is not
// currently live is HELD by re-queuing it (bounded by STRICT_SESSION_MATCH_TTL_MS).
// That hold used to go through the normal persist path, which CANNOT re-queue an
// already-drained event — three independent suppressors reject it:
//
//   1. idx_mesh_pending_events_fingerprint is UNIQUE on (mesh_id, fingerprint) with NO
//      `drained` qualifier, and insertPendingEvent uses INSERT OR IGNORE → the "fresh
//      undrained copy" is silently discarded.
//   2. hasPendingEventFingerprint filters `drained = 0`, so it never sees the drained
//      original and reports no duplicate → the caller believes the re-queue succeeded.
//   3. The v2 eventId is already in drainedEventIdsForMesh(), so routeV2EventsForDrainer
//      would skip any copy that did land as already-delivered.
//
// The hold therefore only ever worked in-memory. A daemon restart inside the 60s TTL
// lost the completion permanently — observed live as task ec6c901a: exactly ONE row
// (drained=1) and ZERO lines in the JSONL mirror, followed 911s later by a
// delivered-no-turn deadline reclaim that re-dispatched an already-finished task.

const testTmpDir = join(tmpdir(), `adhdev-strict-hold-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_1b46842a15d3409d96ad33e767a916dd' }),
}));

import {
    queuePendingMeshCoordinatorEvent,
    requeueDrainedPendingMeshCoordinatorEvent,
    drainPendingMeshCoordinatorEvents,
    buildPendingEventFingerprint,
    __clearMeshPendingEventsForTests,
    type PendingMeshCoordinatorEvent,
} from '../../src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

const CORE = 'mach_1b46842a15d3409d96ad33e767a916dd';

function makeHeldCompletion(meshId: string, over: Partial<PendingMeshCoordinatorEvent> = {}): PendingMeshCoordinatorEvent {
    return {
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'node_worker'",
        nodeId: 'node_worker',
        // targetCoordinatorSessionId is what makes this event strict-routed: it must be
        // delivered ONLY to that coordinator session, never broadcast to a sibling.
        targetCoordinatorSessionId: 'coord-session-b13bb365',
        targetCoordinatorDaemonId: CORE,
        metadataEvent: {
            nodeId: 'node_worker',
            sessionId: 'worker-session-1',
            taskId: 'ec6c901a-17f5-48bb-95c9-df6e07e83735',
            timestamp: 1785432141368,
            finalSummary: 'worker finished the task',
        },
        coordinatorMessage: 'Worker completed the task',
        queuedAt: Date.now(),
        ...over,
    };
}

/** Simulate a daemon restart: close the store + drop the singleton, keeping the DB file. */
function simulateDaemonRestart(): void {
    MeshRuntimeStore.resetForTests();
}

describe('strict-route hold durability (rc.33)', () => {
    beforeEach(() => {
        MeshRuntimeStore.resetForTests();
    });

    afterEach(() => {
        MeshRuntimeStore.resetForTests();
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('REGRESSION: a held completion survives a process restart and is re-drained', () => {
        const meshId = `mesh-restart-${randomUUID().slice(0, 8)}`;
        const event = makeHeldCompletion(meshId);

        // 1. The worker's completion is queued and drained by the reconcile loop.
        expect(queuePendingMeshCoordinatorEvent(event)).toBe(true);
        const drained = drainPendingMeshCoordinatorEvents(meshId, CORE);
        expect(drained).toHaveLength(1);

        // 2. Its coordinator session is not live → strict-route HOLD (re-queue).
        expect(requeueDrainedPendingMeshCoordinatorEvent(drained[0])).toBe(true);

        // 3. The daemon restarts INSIDE the 60s TTL — the exact window that lost ec6c901a.
        simulateDaemonRestart();

        // 4. After the restart the held completion must still be deliverable. Before this
        //    fix the re-queue wrote nothing durable, so this drain came back EMPTY and the
        //    completion was gone forever.
        const afterRestart = drainPendingMeshCoordinatorEvents(meshId, CORE);
        expect(afterRestart).toHaveLength(1);
        expect(afterRestart[0].event).toBe('agent:generating_completed');
        expect(afterRestart[0].metadataEvent?.taskId).toBe('ec6c901a-17f5-48bb-95c9-df6e07e83735');
        // The worker's summary — the payload whose loss the owner actually feels — survived.
        expect(afterRestart[0].metadataEvent?.finalSummary).toBe('worker finished the task');

        __clearMeshPendingEventsForTests(meshId);
    });

    it('proves the old path was a silent no-op: re-queuing a drained event via the normal persist path writes nothing', () => {
        const meshId = `mesh-oldpath-${randomUUID().slice(0, 8)}`;
        const event = makeHeldCompletion(meshId);

        queuePendingMeshCoordinatorEvent(event);
        const drained = drainPendingMeshCoordinatorEvents(meshId, CORE);
        expect(drained).toHaveLength(1);

        // The OLD hold implementation. It returns true (the caller believed the hold
        // worked) because the drained=0 dedup probe cannot see the drained original...
        expect(queuePendingMeshCoordinatorEvent(drained[0])).toBe(true);

        // ...but the UNIQUE (mesh_id, fingerprint) index + INSERT OR IGNORE discarded it:
        // no undrained row exists, so nothing survives a restart. This is the defect.
        const store = MeshRuntimeStore.getInstance();
        expect(store.pendingEventCount(meshId)).toBe(0);

        simulateDaemonRestart();
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(0);

        __clearMeshPendingEventsForTests(meshId);
    });

    it('never creates a duplicate row: the fingerprint stays unique across repeated holds', () => {
        const meshId = `mesh-nodupe-${randomUUID().slice(0, 8)}`;
        const event = makeHeldCompletion(meshId);
        const fingerprint = buildPendingEventFingerprint(event);

        queuePendingMeshCoordinatorEvent(event);

        // Hold → re-drain → hold again, several times over, as a coordinator that stays
        // away across many reconcile ticks would produce.
        for (let i = 0; i < 3; i++) {
            const drained = drainPendingMeshCoordinatorEvents(meshId, CORE);
            expect(drained).toHaveLength(1);
            expect(requeueDrainedPendingMeshCoordinatorEvent(drained[0])).toBe(true);
        }

        // Exactly ONE row carries this fingerprint — the hold reuses the row rather than
        // accumulating copies, so a repeatedly-held event can never fan out into duplicate
        // completion notifications.
        const store = MeshRuntimeStore.getInstance();
        const rowCount = (store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db
            .prepare('SELECT COUNT(*) as c FROM mesh_pending_events WHERE mesh_id = ? AND fingerprint = ?')
            .get(meshId, fingerprint) as { c: number };
        expect(rowCount.c).toBe(1);
        expect(store.pendingEventCount(meshId)).toBe(1);

        __clearMeshPendingEventsForTests(meshId);
    });

    it('a held event is delivered exactly once when its coordinator returns', () => {
        const meshId = `mesh-once-${randomUUID().slice(0, 8)}`;
        const event = makeHeldCompletion(meshId);

        queuePendingMeshCoordinatorEvent(event);
        const first = drainPendingMeshCoordinatorEvents(meshId, CORE);
        expect(first).toHaveLength(1);
        requeueDrainedPendingMeshCoordinatorEvent(first[0]);

        // The coordinator returns and the event is delivered.
        const delivered = drainPendingMeshCoordinatorEvents(meshId, CORE);
        expect(delivered).toHaveLength(1);

        // No further drain re-surfaces it — dedup is intact, so the coordinator is not
        // notified twice about the same completion.
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(0);
        simulateDaemonRestart();
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(0);

        __clearMeshPendingEventsForTests(meshId);
    });

    it('preserves queuedAt so a held event still ages out (the TTL cannot be refreshed)', () => {
        const meshId = `mesh-ttl-${randomUUID().slice(0, 8)}`;
        // Queued 59s ago — still inside the 60s strict TTL, but only just.
        const originalQueuedAt = Date.now() - 59_000;
        const event = makeHeldCompletion(meshId, { queuedAt: originalQueuedAt });

        queuePendingMeshCoordinatorEvent(event);
        const drained = drainPendingMeshCoordinatorEvents(meshId, CORE);
        requeueDrainedPendingMeshCoordinatorEvent(drained[0]);

        simulateDaemonRestart();

        // queuedAt is carried through the hold + restart unchanged. If the re-queue reset
        // it, the TTL would restart on every tick and a held event could never expire —
        // wedging the queue forever. The age must keep advancing toward expiry.
        const afterRestart = drainPendingMeshCoordinatorEvents(meshId, CORE);
        expect(afterRestart).toHaveLength(1);
        expect(afterRestart[0].queuedAt).toBe(originalQueuedAt);

        __clearMeshPendingEventsForTests(meshId);
    });

    it('does not resurrect an unrelated already-drained event (only the held one returns)', () => {
        const meshId = `mesh-scope-${randomUUID().slice(0, 8)}`;
        const held = makeHeldCompletion(meshId, {
            metadataEvent: { nodeId: 'node_worker', sessionId: 's1', taskId: 'task-held', timestamp: 1 },
        });
        const unrelated = makeHeldCompletion(meshId, {
            metadataEvent: { nodeId: 'node_worker', sessionId: 's2', taskId: 'task-unrelated', timestamp: 2 },
        });

        queuePendingMeshCoordinatorEvent(held);
        queuePendingMeshCoordinatorEvent(unrelated);
        const drained = drainPendingMeshCoordinatorEvents(meshId, CORE);
        expect(drained).toHaveLength(2);

        // Hold ONLY the one whose coordinator session is away.
        const heldDrained = drained.find(e => e.metadataEvent?.taskId === 'task-held')!;
        requeueDrainedPendingMeshCoordinatorEvent(heldDrained);

        simulateDaemonRestart();

        // The already-delivered unrelated completion stays consumed — the undrain is
        // fingerprint-scoped, so it cannot resurrect a neighbouring drained event into a
        // duplicate notification.
        const afterRestart = drainPendingMeshCoordinatorEvents(meshId, CORE);
        expect(afterRestart).toHaveLength(1);
        expect(afterRestart[0].metadataEvent?.taskId).toBe('task-held');

        __clearMeshPendingEventsForTests(meshId);
    });
});
