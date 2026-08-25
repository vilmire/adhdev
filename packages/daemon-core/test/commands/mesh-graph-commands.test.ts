import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// G5 — dashboard-transport surface for the graph control plane.
//
//   The graph projection and gate verbs existed only as coordinator MCP tools;
//   these commands expose the SAME engine over sendDaemonCommand so a human
//   can finally see and operate gates. Pinned here:
//     (1) mesh_graph_overview returns the projection for a seeded graph;
//     (2) claim → release round-trips through the real engine (lease
//         generation + fencing token enforced; releasing with a wrong token
//         fails with a machine-readable code, not a throw);
//     (3) abandon settles an awaiting gate and reports abandoned:true;
//     (4) every handler fails soft ({success:false}) on missing args.

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

    it('claim → release round-trips through the fenced engine', async () => {
        const mesh = meshId('roundtrip');
        const { gateId } = seedGateGraph(mesh);

        const claim: any = await meshGraphCommandHandlers.mesh_gate_claim(ctx, { meshId: mesh, gateId });
        expect(claim.success).toBe(true);
        expect(claim.claimed).toBe(true);
        expect(typeof claim.fencingToken).toBe('string');
        expect(typeof claim.leaseGeneration).toBe('number');

        // Wrong fencing token is rejected with a code, never a throw.
        const badRelease: any = await meshGraphCommandHandlers.mesh_gate_release(ctx, {
            meshId: mesh, gateId, leaseGeneration: claim.leaseGeneration, fencingToken: 'not-the-token', outcome: 'passed',
        });
        expect(badRelease.success).toBe(false);
        expect(typeof badRelease.code).toBe('string');

        const release: any = await meshGraphCommandHandlers.mesh_gate_release(ctx, {
            meshId: mesh, gateId, leaseGeneration: claim.leaseGeneration, fencingToken: claim.fencingToken,
            outcome: 'passed', evidence: 'screenshots verified',
        });
        expect(release.success).toBe(true);
        expect(release.released).toBe(true);

        const gate = MeshRuntimeStore.getInstance().graphStore().getGate(gateId);
        expect(gate?.state).toBe('released');
    });

    it('mesh_gate_abandon settles an awaiting gate', async () => {
        const mesh = meshId('abandon');
        const { gateId } = seedGateGraph(mesh);
        const res: any = await meshGraphCommandHandlers.mesh_gate_abandon(ctx, { meshId: mesh, gateId, reason: 'work is dead' });
        expect(res.success).toBe(true);
        expect(res.abandoned).toBe(true);
        expect(MeshRuntimeStore.getInstance().graphStore().getGate(gateId)?.state).toBe('cancelled');
    });

    it('fails soft on missing args', async () => {
        for (const name of ['mesh_graph_overview', 'mesh_gate_claim', 'mesh_gate_release', 'mesh_gate_abandon'] as const) {
            const res: any = await meshGraphCommandHandlers[name](ctx, {});
            expect(res.success).toBe(false);
            expect(typeof res.error).toBe('string');
        }
    });
});
