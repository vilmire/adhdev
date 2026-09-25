import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// D6 — graphUsage counters (docs/design/2026-09-25-graph-orchestration-simplification.md).
// Computed from the graph/queue tables over a 7-day window, cached ≥ 60 s.

const testTmpDir = path.join(tmpdir(), `adhdev-graph-usage-${randomUUID().slice(0, 8)}`);
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
    getDifficultyBrains: vi.fn(() => undefined),
}));

import {
    computeMeshGraphUsage,
    GRAPH_USAGE_CACHE_TTL_MS,
    __resetMeshGraphUsageCacheForTests,
} from '../../src/mesh/mesh-graph-usage.js';
import { MESH_GATE_AUTO_ABANDON_REASON } from '../../src/mesh/mesh-graph-gates.js';
import { __resetMeshRuntimeStoreForTests, enqueueTask } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    __resetMeshGraphUsageCacheForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const DAY = 86_400_000;

function gs() {
    return MeshRuntimeStore.getInstance().graphStore();
}

function graph(mesh: string, tasks: number, gates: number, createdAtMs: number): string {
    const graphId = randomUUID();
    const at = new Date(createdAtMs).toISOString();
    gs().insertGraph({
        graphId, meshId: mesh, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: 'active', taskCount: tasks, gateCount: gates, workspaceCount: 0, dependencyEdgeCount: 0,
        policyJson: '{}', createdAt: at, updatedAt: at,
    });
    return graphId;
}

describe('D6 computeMeshGraphUsage', () => {
    it('counts graphs/p50/expired/auto-abandoned/enqueue_task chains over the 7-day window', () => {
        const mesh = `mesh_usage_${randomUUID().slice(0, 8)}`;
        const now = Date.now();
        graph(mesh, 1, 0, now - DAY);          // size 1
        graph(mesh, 2, 0, now - 2 * DAY);      // size 2
        const g3 = graph(mesh, 4, 1, now - 3 * DAY); // size 5
        graph(mesh, 9, 0, now - 30 * DAY);     // outside the window

        const at = new Date(now).toISOString();
        // one expired gate, one auto-abandoned gate node, one manual abandon (not counted)
        const mkGate = (state: 'expired' | 'cancelled', failureReason?: string) => {
            const nodeId = randomUUID();
            gs().insertNode({
                graphId: g3, nodeId, meshId: mesh, ref: `g_${nodeId.slice(0, 4)}`, kind: 'coordinator_gate', state,
                baseSpecJson: '{}', materializationVersion: 0, createdAt: at, updatedAt: at,
                ...(failureReason ? { failureReason } : {}),
            });
            gs().insertGate({
                gateId: randomUUID(), graphId: g3, nodeId, meshId: mesh, state, action: 'approval',
                leaseGeneration: 0, onTimeout: 'hold', createdAt: at, updatedAt: at,
            });
        };
        mkGate('expired');
        mkGate('cancelled', `coordinator_gate_abandoned:x:${MESH_GATE_AUTO_ABANDON_REASON}`);
        mkGate('cancelled', 'coordinator_gate_abandoned:y:operator said so');

        // enqueue_task chain: B depends on A, neither is a graph node.
        const a = enqueueTask(mesh, 'A', { taskMode: 'code_change', difficulty: 'easy' } as any);
        enqueueTask(mesh, 'B', { taskMode: 'code_change', difficulty: 'easy', dependsOn: [a.id] } as any);
        enqueueTask(mesh, 'C', { taskMode: 'code_change', difficulty: 'easy' } as any);
        // A batch-graph worker whose queue row carries the requires projection
        // as dependsOn is NOT an enqueue_task chain.
        const d = enqueueTask(mesh, 'D', { taskMode: 'code_change', difficulty: 'easy', dependsOn: [a.id] } as any);
        gs().insertNode({
            graphId: g3, nodeId: randomUUID(), meshId: mesh, ref: 'd', kind: 'worker_task', queueTaskId: d.id,
            state: 'declared', baseSpecJson: '{}', materializationVersion: 0, createdAt: at, updatedAt: at,
        });

        const usage = computeMeshGraphUsage(mesh, now);
        expect(usage).toMatchObject({
            graphsLast7d: 3,
            nodesPerGraphP50: 2,
            gatesExpired: 1,
            gatesAutoAbandoned: 1,
            depsChainedViaEnqueueTask: 1,
            windowDays: 7,
        });
    });

    it('is cached for at least 60 s per mesh', () => {
        const mesh = `mesh_usage_cache_${randomUUID().slice(0, 8)}`;
        const now = Date.now();
        expect(computeMeshGraphUsage(mesh, now).graphsLast7d).toBe(0);
        graph(mesh, 1, 0, now);
        expect(computeMeshGraphUsage(mesh, now + GRAPH_USAGE_CACHE_TTL_MS - 1).graphsLast7d).toBe(0);
        expect(computeMeshGraphUsage(mesh, now + GRAPH_USAGE_CACHE_TTL_MS).graphsLast7d).toBe(1);
    });
});
