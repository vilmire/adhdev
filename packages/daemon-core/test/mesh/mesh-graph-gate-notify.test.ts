import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// GRAPH-GATE-NOTIFY — the gate-open/lease-expired outbox rows must page the
// coordinator instead of being silently marked delivered.
//
//   Defect this pins (measured live 2026-08-24): `graph_gate_awaiting` was
//   written to the outbox but the drain handled only `queue_wake`, so an opened
//   gate produced NO push whatsoever. With Monitor rules forbidding
//   mesh_graph_view polling, 7 gates sat awaiting_coordinator for 3 days — two
//   of them for work that had already landed on main.
//
//   Contract pinned here:
//     (1) draining a `graph_gate_awaiting` / `graph_gate_lease_expired` row
//         invokes the registered gate-notify handler with the parsed payload;
//     (2) the row is marked delivered exactly once (no re-fire on next drain);
//     (3) a malformed payload or missing handler never throws and never wedges
//         the row;
//     (4) the pendingCoordinatorEvents fingerprint anchors on gateId
//         (metadataEvent.taskId), so two different gates never collapse into
//         one dedup slot while undrained.

const testTmpDir = path.join(tmpdir(), `adhdev-gate-notify-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
}));

import {
    drainMeshGraphOutbox,
    registerMeshGraphGateNotifyHandler,
    __resetMeshGraphTransitionRunnerForTests,
    type MeshGraphGateNotification,
} from '../../src/mesh/mesh-graph-transition-runner.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { newMeshGraphOutboxId } from '../../src/mesh/mesh-graph-types.js';
import { buildPendingEventFingerprint } from '../../src/mesh/mesh-events-pending.js';

function meshId(tag: string): string {
    return `mesh_gatenotify_${tag}_${randomUUID().slice(0, 8)}`;
}

function insertGateOutboxRow(mesh: string, kind: string, payload: unknown): string {
    const gs = MeshRuntimeStore.getInstance().graphStore();
    const id = newMeshGraphOutboxId();
    const now = new Date().toISOString();
    gs.insertOutboxEvent({
        id,
        meshId: mesh,
        kind,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
        status: 'pending',
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
    });
    return id;
}

afterEach(() => {
    __resetMeshGraphTransitionRunnerForTests();
    __resetMeshRuntimeStoreForTests();
    vi.restoreAllMocks();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('mesh graph gate notify', () => {
    it('pages the registered handler for graph_gate_awaiting with the parsed payload', () => {
        const mesh = meshId('awaiting');
        const notifications: MeshGraphGateNotification[] = [];
        registerMeshGraphGateNotifyHandler(n => { notifications.push(n); });

        const graphId = randomUUID();
        const gateId = randomUUID();
        insertGateOutboxRow(mesh, 'graph_gate_awaiting', {
            graphId, gateId, nodeId: randomUUID(),
            ref: 'land', action: 'refinery',
            instructions: 'Land after verifying patch equivalence.',
            deadlineAt: '2026-08-25T00:00:00.000Z',
        });

        const drained = drainMeshGraphOutbox(mesh);
        expect(drained).toBe(1);
        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toMatchObject({
            kind: 'graph_gate_awaiting',
            meshId: mesh,
            graphId,
            gateId,
            ref: 'land',
            action: 'refinery',
            instructions: 'Land after verifying patch equivalence.',
            deadlineAt: '2026-08-25T00:00:00.000Z',
        });

        // Delivered exactly once — a second drain must not re-fire the page.
        expect(drainMeshGraphOutbox(mesh)).toBe(0);
        expect(notifications).toHaveLength(1);
    });

    it('pages graph_gate_lease_expired the same way', () => {
        const mesh = meshId('lease');
        const notifications: MeshGraphGateNotification[] = [];
        registerMeshGraphGateNotifyHandler(n => { notifications.push(n); });

        const gateId = randomUUID();
        insertGateOutboxRow(mesh, 'graph_gate_lease_expired', { graphId: randomUUID(), gateId, action: 'deploy' });

        expect(drainMeshGraphOutbox(mesh)).toBe(1);
        expect(notifications).toHaveLength(1);
        expect(notifications[0].kind).toBe('graph_gate_lease_expired');
        expect(notifications[0].gateId).toBe(gateId);
    });

    it('marks a malformed-payload gate row delivered without throwing or paging', () => {
        const mesh = meshId('malformed');
        const notifications: MeshGraphGateNotification[] = [];
        registerMeshGraphGateNotifyHandler(n => { notifications.push(n); });

        insertGateOutboxRow(mesh, 'graph_gate_awaiting', 'not-json{');
        insertGateOutboxRow(mesh, 'graph_gate_awaiting', { ref: 'no-ids-at-all' });

        expect(drainMeshGraphOutbox(mesh)).toBe(2);
        expect(notifications).toHaveLength(0);
        expect(drainMeshGraphOutbox(mesh)).toBe(0);
    });

    it('drains gate rows without a registered handler (no throw, no wedge)', () => {
        const mesh = meshId('nohandler');
        insertGateOutboxRow(mesh, 'graph_gate_awaiting', { graphId: randomUUID(), gateId: randomUUID() });
        expect(drainMeshGraphOutbox(mesh)).toBe(1);
        expect(drainMeshGraphOutbox(mesh)).toBe(0);
    });

    it('fingerprints gate pages per gateId, never per mesh', () => {
        const mesh = meshId('fingerprint');
        const pageFor = (gateId: string) => ({
            event: 'mesh:graph_gate_awaiting',
            meshId: mesh,
            nodeLabel: 'land',
            metadataEvent: { source: 'mesh_graph_outbox', taskId: gateId, gateId },
            queuedAt: Date.now(),
        });
        const a = buildPendingEventFingerprint(pageFor('gate-a') as any);
        const b = buildPendingEventFingerprint(pageFor('gate-b') as any);
        expect(a).not.toBe(b);
        // Same gate paged twice while undrained collapses to one slot.
        expect(buildPendingEventFingerprint(pageFor('gate-a') as any)).toBe(a);
    });
});
