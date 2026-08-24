import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// G3 — graph/gate staleness reminders.
//
//   Defect this pins (measured live 2026-08-24): once the one-shot gate-open
//   page was consumed, nothing ever re-surfaced a graph that stopped advancing
//   or a gate left waiting — 49 graphs sat active for 3-5 days and 7 gates for
//   3 days with zero signal.
//
//   Contract pinned here:
//     (1) a graph stale past the threshold queues exactly one reminder whose
//         fingerprint anchor is windowed (same window → same anchor → queue-
//         layer dedup; next window → new anchor → re-page);
//     (2) fresh graphs and terminal graphs queue nothing;
//     (3) a stale graph's awaiting gates are named INSIDE the graph reminder,
//         not paged separately; a stale gate on a FRESH graph gets its own page;
//     (4) the sweep never mutates graph/gate state (reminders only).

const testTmpDir = path.join(tmpdir(), `adhdev-graph-stale-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
}));

const queued = vi.hoisted(() => ({ events: [] as any[] }));
vi.mock('../../src/mesh/mesh-events-pending.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/mesh/mesh-events-pending.js')>();
    return {
        ...actual,
        queuePendingMeshCoordinatorEvent: vi.fn((event: any) => {
            queued.events.push(event);
            return true;
        }),
    };
});

import { sweepMeshGraphStaleness } from '../../src/mesh/mesh-graph-staleness.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { MeshGraphGateRow, MeshTaskGraphNodeRow, MeshTaskGraphRow } from '../../src/mesh/mesh-graph-types.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

function meshId(tag: string): string {
    return `mesh_stale_${tag}_${randomUUID().slice(0, 8)}`;
}

function iso(ms: number): string {
    return new Date(ms).toISOString();
}

function insertGraph(mesh: string, opts: { status?: MeshTaskGraphRow['status']; updatedAtMs: number }): string {
    const gs = MeshRuntimeStore.getInstance().graphStore();
    const graphId = randomUUID();
    gs.insertGraph({
        graphId, meshId: mesh, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: opts.status ?? 'active', taskCount: 1, gateCount: 0, workspaceCount: 0,
        dependencyEdgeCount: 0, policyJson: '{}',
        createdAt: iso(opts.updatedAtMs), updatedAt: iso(opts.updatedAtMs),
    });
    return graphId;
}

function insertNode(mesh: string, graphId: string, state: MeshTaskGraphNodeRow['state']): void {
    const gs = MeshRuntimeStore.getInstance().graphStore();
    gs.insertNode({
        graphId, nodeId: randomUUID(), meshId: mesh, ref: 'w', kind: 'worker_task',
        queueTaskId: randomUUID(), state, baseSpecJson: JSON.stringify({ message: 'work' }),
        materializationVersion: 0, createdAt: iso(NOW - 3 * DAY), updatedAt: iso(NOW - 3 * DAY),
    });
}

function insertGate(mesh: string, graphId: string, opts: { state?: MeshGraphGateRow['state']; updatedAtMs: number; ref?: string }): string {
    const gs = MeshRuntimeStore.getInstance().graphStore();
    const gateId = randomUUID();
    gs.insertGate({
        gateId, graphId, nodeId: randomUUID(), meshId: mesh, ref: opts.ref ?? 'land',
        state: opts.state ?? 'awaiting_coordinator', action: 'refinery',
        instructions: 'Land after review.', leaseGeneration: 0, onTimeout: 'hold',
        createdAt: iso(opts.updatedAtMs), updatedAt: iso(opts.updatedAtMs),
    });
    return gateId;
}

afterEach(() => {
    queued.events.length = 0;
    __resetMeshRuntimeStoreForTests();
    vi.clearAllMocks();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('mesh graph staleness sweep', () => {
    it('pages a stale active graph once, with a windowed dedup anchor', () => {
        const mesh = meshId('stalegraph');
        const graphId = insertGraph(mesh, { updatedAtMs: NOW - 3 * DAY });
        insertNode(mesh, graphId, 'blocked');

        const result = sweepMeshGraphStaleness(mesh, { nowMs: NOW });
        expect(result.staleGraphs).toBe(1);
        expect(result.remindersQueued).toBe(1);
        expect(queued.events).toHaveLength(1);
        const event = queued.events[0];
        expect(event.event).toBe('mesh:graph_stale');
        expect(event.metadataEvent.graphId).toBe(graphId);
        expect(event.coordinatorMessage).toContain('mesh_graph_view');
        expect(event.coordinatorMessage).toContain('1 blocked');

        // Same window → same anchor (queue-layer dedup would collapse it).
        const anchor = event.metadataEvent.taskId;
        sweepMeshGraphStaleness(mesh, { nowMs: NOW + HOUR });
        expect(queued.events[1].metadataEvent.taskId).toBe(anchor);

        // Next window → new anchor → re-page.
        sweepMeshGraphStaleness(mesh, { nowMs: NOW + 25 * HOUR });
        expect(queued.events[2].metadataEvent.taskId).not.toBe(anchor);
    });

    it('queues nothing for fresh or terminal graphs', () => {
        const mesh = meshId('fresh');
        insertGraph(mesh, { updatedAtMs: NOW - 2 * HOUR });
        insertGraph(mesh, { status: 'completed', updatedAtMs: NOW - 10 * DAY });
        insertGraph(mesh, { status: 'cancelled', updatedAtMs: NOW - 10 * DAY });

        const result = sweepMeshGraphStaleness(mesh, { nowMs: NOW });
        expect(result).toEqual({ staleGraphs: 0, staleGates: 0, remindersQueued: 0 });
        expect(queued.events).toHaveLength(0);
    });

    it('names awaiting gates inside the graph reminder instead of paging them twice', () => {
        const mesh = meshId('gateingraph');
        const graphId = insertGraph(mesh, { status: 'waiting_gate', updatedAtMs: NOW - 3 * DAY });
        insertGate(mesh, graphId, { updatedAtMs: NOW - 3 * DAY, ref: 'land' });

        const result = sweepMeshGraphStaleness(mesh, { nowMs: NOW });
        expect(result.staleGraphs).toBe(1);
        expect(result.staleGates).toBe(1);
        expect(result.remindersQueued).toBe(1);
        expect(queued.events).toHaveLength(1);
        expect(queued.events[0].event).toBe('mesh:graph_stale');
        expect(queued.events[0].coordinatorMessage).toContain("'land' (refinery, awaiting_coordinator)");
        expect(queued.events[0].coordinatorMessage).toContain('mesh_graph_gate_claim');
    });

    it('pages a stale gate separately when its graph looks fresh', () => {
        const mesh = meshId('freshgraphstalegate');
        const graphId = insertGraph(mesh, { status: 'waiting_gate', updatedAtMs: NOW - HOUR });
        const gateId = insertGate(mesh, graphId, { updatedAtMs: NOW - 3 * DAY });

        const result = sweepMeshGraphStaleness(mesh, { nowMs: NOW });
        expect(result.staleGraphs).toBe(0);
        expect(result.staleGates).toBe(1);
        expect(result.remindersQueued).toBe(1);
        expect(queued.events[0].event).toBe('mesh:graph_gate_stale');
        expect(queued.events[0].metadataEvent.gateId).toBe(gateId);
    });

    it('never mutates graph or gate rows', () => {
        const mesh = meshId('readonly');
        const graphId = insertGraph(mesh, { status: 'waiting_gate', updatedAtMs: NOW - 3 * DAY });
        const gateId = insertGate(mesh, graphId, { updatedAtMs: NOW - 3 * DAY });
        const gs = MeshRuntimeStore.getInstance().graphStore();
        const graphBefore = JSON.stringify(gs.getGraph(graphId));
        const gateBefore = JSON.stringify(gs.getGate(gateId));

        sweepMeshGraphStaleness(mesh, { nowMs: NOW });

        expect(JSON.stringify(gs.getGraph(graphId))).toBe(graphBefore);
        expect(JSON.stringify(gs.getGate(gateId))).toBe(gateBefore);
    });
});
