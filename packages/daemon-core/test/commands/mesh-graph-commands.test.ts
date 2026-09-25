import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// G5 — dashboard-transport surface for the graph control plane.
//
//   The graph projection existed only as a coordinator MCP tool; these
//   commands expose the SAME engine over sendDaemonCommand so a human can
//   finally see it. Pinned here:
//     (1) mesh_graph_overview returns the projection for a seeded graph;
//     (2) every handler fails soft ({success:false}) on missing args.
//
//   ★ The gate verbs (claim/release/abandon/extend) this file used to define
//   as mesh_gate_claim/release/abandon moved to mesh-graph-gate-commands.ts
//   as mesh_graph_gate_claim/release/abandon/extend (2026-09-25,
//   graph-orchestration-simplification D3(c) — see that file's header for
//   why the old names were removed rather than kept as aliases). Their
//   round-trip/abandon coverage now lives in
//   test/commands/mesh-graph-gate-commands.test.ts.

const testTmpDir = path.join(tmpdir(), `adhdev-graph-cmds-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');
vi.hoisted(() => {
    const os = require('node:os') as typeof import('node:os');
    const p = require('node:path') as typeof import('node:path');
    process.env.ADHDEV_CONFIG_DIR = p.join(os.tmpdir(), `adhdev-graph-cmds-env-${process.pid}`, '.adhdev');
});

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => ({ machineId: 'test-machine' } as any).machineId,
    getMachineNickname: () => ({ machineId: 'test-machine' } as any).machineNickname ?? null,
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(() => ({ nodes: [] })),
}));

import { meshGraphCommandHandlers } from '../../src/commands/med-family/mesh-graph-commands.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

const ctx: any = { deps: {} };

function meshId(tag: string): string {
    return `mesh_gcmd_${tag}_${randomUUID().slice(0, 8)}`;
}

function seedGateGraph(mesh: string): { graphId: string; gateId: string } {
    const gs = MeshRuntimeStore.getInstance().graphStore();
    const graphId = randomUUID();
    const gateNodeId = randomUUID();
    const gateId = randomUUID();
    const now = new Date().toISOString();
    gs.insertGraph({
        graphId, meshId: mesh, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: 'waiting_gate', taskCount: 0, gateCount: 1, workspaceCount: 0,
        dependencyEdgeCount: 0, policyJson: '{}', createdAt: now, updatedAt: now,
    });
    gs.insertNode({
        graphId, nodeId: gateNodeId, meshId: mesh, ref: 'land', kind: 'coordinator_gate',
        state: 'awaiting_coordinator', baseSpecJson: '{}',
        materializationVersion: 0, createdAt: now, updatedAt: now,
    });
    gs.insertGate({
        gateId, graphId, nodeId: gateNodeId, meshId: mesh, ref: 'land',
        state: 'awaiting_coordinator', action: 'approval', instructions: 'Owner eyeballs the screenshots.',
        leaseGeneration: 0, onTimeout: 'hold', createdAt: now, updatedAt: now,
    });
    return { graphId, gateId };
}

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    vi.clearAllMocks();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('mesh graph dashboard commands', () => {
    it('mesh_graph_overview returns the seeded graph with its gate', async () => {
        const mesh = meshId('overview');
        const { graphId, gateId } = seedGateGraph(mesh);
        const res: any = await meshGraphCommandHandlers.mesh_graph_overview(ctx, { meshId: mesh });
        expect(res.success).toBe(true);
        expect(res.graphCount).toBe(1);
        expect(res.totalGraphCount).toBe(1);
        expect(res.graphs[0].graphId).toBe(graphId);
        expect(res.graphs[0].gates.map((g: any) => g.gateId)).toContain(gateId);
    });

    it('reports the exact total when the requested graph window is truncated', async () => {
        const mesh = meshId('overview-limit');
        for (let index = 0; index < 22; index += 1) seedGateGraph(mesh);

        const res: any = await meshGraphCommandHandlers.mesh_graph_overview(ctx, {
            meshId: mesh,
            includeTerminal: true,
            limit: 20,
        });

        expect(res.success).toBe(true);
        expect(res.graphCount).toBe(20);
        expect(res.graphs).toHaveLength(20);
        expect(res.totalGraphCount).toBe(22);
    });

    it('fails soft on missing args', async () => {
        for (const name of ['mesh_graph_overview', 'mesh_task_output'] as const) {
            const res: any = await meshGraphCommandHandlers[name](ctx, {});
            expect(res.success).toBe(false);
            expect(typeof res.error).toBe('string');
        }
    });

    // Task-detail completion info (docs/design/2026-09-02-blueprint-followups.md
    // §1) — finalSummary/providerType read path over getLatestOutput.
    describe('mesh_task_output', () => {
        it('returns output:null when the task has no persisted output', async () => {
            const mesh = meshId('output-none');
            const res: any = await meshGraphCommandHandlers.mesh_task_output(ctx, { meshId: mesh, taskId: randomUUID() });
            expect(res.success).toBe(true);
            expect(res.output).toBeNull();
        });

        it('projects finalSummary and providerType out of the latest persisted envelope', async () => {
            const mesh = meshId('output-hit');
            const taskId = randomUUID();
            const gs = MeshRuntimeStore.getInstance().graphStore();
            const now = new Date().toISOString();
            const envelope = {
                final_summary: 'Landed the fix and verified with the repro script.',
                worker_result: 'ok',
                source: { provider_type: 'claude-cli', session_id: 'sess_1' },
            };
            gs.insertOutput({
                taskId, version: 1, meshId: mesh, attempt: 1, status: 'completed',
                envelopeJson: JSON.stringify(envelope), digest: 'digest1', createdAt: now,
            });
            const res: any = await meshGraphCommandHandlers.mesh_task_output(ctx, { meshId: mesh, taskId });
            expect(res.success).toBe(true);
            expect(res.output.finalSummary).toBe(envelope.final_summary);
            expect(res.output.providerType).toBe('claude-cli');
            expect(res.output.version).toBe(1);
        });

        it('returns the latest version when a task has multiple output rows', async () => {
            const mesh = meshId('output-latest');
            const taskId = randomUUID();
            const gs = MeshRuntimeStore.getInstance().graphStore();
            const now = new Date().toISOString();
            gs.insertOutput({
                taskId, version: 1, meshId: mesh, attempt: 1, status: 'completed',
                envelopeJson: JSON.stringify({ final_summary: 'first attempt', source: {} }),
                digest: 'd1', createdAt: now,
            });
            gs.insertOutput({
                taskId, version: 2, meshId: mesh, attempt: 2, status: 'completed',
                envelopeJson: JSON.stringify({ final_summary: 'second attempt', source: { provider_type: 'codex-cli' } }),
                digest: 'd2', createdAt: now,
            });
            const res: any = await meshGraphCommandHandlers.mesh_task_output(ctx, { meshId: mesh, taskId });
            expect(res.success).toBe(true);
            expect(res.output.version).toBe(2);
            expect(res.output.finalSummary).toBe('second attempt');
            expect(res.output.providerType).toBe('codex-cli');
        });
    });
});
