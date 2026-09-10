import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ENTER-LOSS layer ③ — requeueDrainedPendingEventById, the row-id twin of the
// STRICT-ROUTE-HOLD requeueDrainedPendingEventByFingerprint. Same semantics:
// flip the EXISTING drained row back to drained=0 IN PLACE (never a re-insert —
// the UNIQUE (mesh_id, fingerprint) index stays occupied by the very row being
// flipped, so no duplicate can be created), preserve queued_at, clear
// drained_at/drained_by. This is the durable-undrain half of the boot-time
// composer-residue recovery: the sweep identifies a stranded notification by
// its drained ledger row id and returns exactly that row to the queue so the
// NORMAL redelivery path delivers it again.

const testTmpDir = join(tmpdir(), `adhdev-undrain-id-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_1b46842a15d3409d96ad33e767a916dd' }),
    getMachineId: () => 'mach_1b46842a15d3409d96ad33e767a916dd',
    getMachineNickname: () => null,
}));

import {
    queuePendingMeshCoordinatorEvent,
    drainPendingMeshCoordinatorEvents,
    __clearMeshPendingEventsForTests,
    type PendingMeshCoordinatorEvent,
} from '../../src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

const CORE = 'mach_1b46842a15d3409d96ad33e767a916dd';

function makeNotification(meshId: string, over: Partial<PendingMeshCoordinatorEvent> = {}): PendingMeshCoordinatorEvent {
    return {
        event: 'mesh:task_completed',
        meshId,
        nodeLabel: "Node 'node_worker'",
        nodeId: 'node_worker',
        targetCoordinatorDaemonId: CORE,
        metadataEvent: {
            nodeId: 'node_worker',
            sessionId: 'worker-session-1',
            taskId: 'task-undrain-1',
            timestamp: 1785432141368,
        },
        coordinatorMessage: '[System] Delegated worker task completed on node moltbot: all tests green. '.repeat(3),
        queuedAt: Date.now() - 120_000,
        ...over,
    };
}

describe('requeueDrainedPendingEventById (ENTER-LOSS ③ undrain recovery)', () => {
    beforeEach(() => {
        MeshRuntimeStore.resetForTests();
    });

    afterEach(() => {
        MeshRuntimeStore.resetForTests();
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('flips a drained row back to the queue by row id, and the normal drain redelivers it', () => {
        const meshId = `mesh-undrain-${randomUUID().slice(0, 8)}`;
        const event = makeNotification(meshId);
        expect(queuePendingMeshCoordinatorEvent(event)).toBe(true);

        // Drain it — the consume-before-submit state the incident exploits.
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(1);
        const store = MeshRuntimeStore.getInstance();
        const drainedRows = store.recentDrainedPendingEventPayloads(Date.now() - 60_000);
        const row = drainedRows.find(r => r.meshId === meshId);
        expect(row).toBeDefined();

        // The sweep's flow: identify by row id from the drained payload list → undrain.
        expect(store.requeueDrainedPendingEventById(row!.id)).toBe(true);

        // Row is back in the queue: visible to peek, drained flag off, drainer cleared,
        // queued_at PRESERVED (age keeps measuring from the original enqueue).
        const audit = store.recentDrainedPendingEvents(meshId).find(r => r.id === row!.id);
        expect(audit).toMatchObject({ drained: false, drainedBy: null, drainedAt: null });
        expect(audit!.queuedAt).toBe(event.queuedAt);

        // Normal redelivery path picks it up again — the actual recovery.
        const redelivered = drainPendingMeshCoordinatorEvents(meshId, CORE);
        expect(redelivered).toHaveLength(1);
        expect(redelivered[0].coordinatorMessage).toBe(event.coordinatorMessage);

        __clearMeshPendingEventsForTests(meshId);
    });

    it('never re-inserts: undrain leaves exactly one row for the fingerprint', () => {
        const meshId = `mesh-undrain-${randomUUID().slice(0, 8)}`;
        expect(queuePendingMeshCoordinatorEvent(makeNotification(meshId))).toBe(true);
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(1);
        const store = MeshRuntimeStore.getInstance();
        const row = store.recentDrainedPendingEventPayloads(Date.now() - 60_000).find(r => r.meshId === meshId)!;
        expect(store.requeueDrainedPendingEventById(row.id)).toBe(true);
        expect(store.recentDrainedPendingEvents(meshId)).toHaveLength(1);
        __clearMeshPendingEventsForTests(meshId);
    });

    it('returns false for an undrained row, an unknown id, and an empty id', () => {
        const meshId = `mesh-undrain-${randomUUID().slice(0, 8)}`;
        expect(queuePendingMeshCoordinatorEvent(makeNotification(meshId))).toBe(true);
        const store = MeshRuntimeStore.getInstance();
        const queued = store.peekPendingEvents(meshId, CORE);
        expect(queued).toHaveLength(1);

        // Still drained=0 → nothing to undrain.
        expect(store.requeueDrainedPendingEventById(queued[0].id)).toBe(false);
        expect(store.requeueDrainedPendingEventById('no-such-row')).toBe(false);
        expect(store.requeueDrainedPendingEventById('')).toBe(false);
        __clearMeshPendingEventsForTests(meshId);
    });
});
