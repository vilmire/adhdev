import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// D3(c) — dashboard-callable gate verbs (docs/design/2026-09-25-graph-orchestration-simplification.md).
//
//   Pinned:
//     (1) the four commands are registered with sources EXACTLY ipc · standalone ·
//         p2p — never `mesh` (a peer daemon may not operate this daemon's gates)
//         and never ws/api/ext;
//     (2) release is ONE step for an operator (claim-as-operator + fenced release),
//         idempotent per gate (same outcome replays as duplicate, a different
//         outcome is a conflict), and refuses a LIVE foreign lease;
//     (3) abandon requires a reason; extend reopens an expired-hold gate;
//     (4) claim honours deadline_seconds.

const testTmpDir = path.join(tmpdir(), `adhdev-gate-cmds-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');
vi.hoisted(() => {
    const os = require('node:os') as typeof import('node:os');
    const p = require('node:path') as typeof import('node:path');
    process.env.ADHDEV_CONFIG_DIR = p.join(os.tmpdir(), `adhdev-gate-cmds-env-${process.pid}`, '.adhdev');
});

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
    getMesh: vi.fn(() => ({ nodes: [] })),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
    getDifficultyBrains: vi.fn(() => undefined),
}));

import {
    meshGraphGateCommandHandlers,
    meshGraphGateCommandSpecs,
    MESH_GATE_OPERATOR_SESSION_ID,
} from '../../src/commands/med-family/mesh-graph-gate-commands.js';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { claimMeshGraphGate, sweepMeshGraphGateTimeouts } from '../../src/mesh/mesh-graph-gates.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

const ctx: any = { deps: {} };
const VERBS = ['mesh_graph_gate_claim', 'mesh_graph_gate_release', 'mesh_graph_gate_abandon', 'mesh_graph_gate_extend'];

function meshId(tag: string): string {
    return `mesh_gatecmd_${tag}_${randomUUID().slice(0, 8)}`;
}

function seedAwaitingGate(mesh: string, opts: { deadlineAt?: string } = {}): { graphId: string; gateId: string } {
    const gs = MeshRuntimeStore.getInstance().graphStore();
    const graphId = randomUUID();
    const nodeId = randomUUID();
    const gateId = randomUUID();
    const now = new Date().toISOString();
    gs.insertGraph({
        graphId, meshId: mesh, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: 'waiting_gate', taskCount: 0, gateCount: 1, workspaceCount: 0,
        dependencyEdgeCount: 0, policyJson: '{}', createdAt: now, updatedAt: now,
    });
    gs.insertNode({
        graphId, nodeId, meshId: mesh, ref: 'approve', kind: 'coordinator_gate',
        state: 'awaiting_coordinator', baseSpecJson: '{}', materializationVersion: 0, createdAt: now, updatedAt: now,
    });
    gs.insertGate({
        gateId, graphId, nodeId, meshId: mesh, ref: 'approve', state: 'awaiting_coordinator', action: 'approval',
        leaseGeneration: 0, onTimeout: 'hold', ...(opts.deadlineAt ? { deadlineAt: opts.deadlineAt } : {}),
        createdAt: now, updatedAt: now,
    });
    return { graphId, gateId };
}

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    vi.clearAllMocks();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('D3(c) gate verbs — registration & authorization', () => {
    it('registers the four verbs with sources exactly ipc · standalone · p2p (no mesh relay)', () => {
        expect(Object.keys(meshGraphGateCommandHandlers).sort()).toEqual([...VERBS].sort());
        const registry = getDaemonCommandRegistry();
        for (const name of VERBS) {
            const spec = registry.get(name);
            expect(spec, name).toBeDefined();
            expect([...(spec!.sources ?? [])].sort(), name).toEqual(['ipc', 'p2p', 'standalone']);
            expect(spec!.sources, name).not.toContain('mesh');
        }
        expect(meshGraphGateCommandSpecs.map(s => s.name).sort()).toEqual([...VERBS].sort());
    });
});

describe('D3(c) gate verbs — behaviour', () => {
    it('release is one step for an operator and idempotent per gate', async () => {
        const mesh = meshId('release');
        const { gateId } = seedAwaitingGate(mesh);
        const res: any = await meshGraphGateCommandHandlers.mesh_graph_gate_release(ctx, {
            mesh_id: mesh, gate_id: gateId, outcome: 'passed', evidence: 'owner checked screenshots',
        });
        expect(res).toMatchObject({ success: true, released: true, duplicate: false });
        const gate = MeshRuntimeStore.getInstance().graphStore().getGate(gateId)!;
        expect(gate.state).toBe('released');
        expect(gate.leaseOwnerSessionId).toBe(MESH_GATE_OPERATOR_SESSION_ID);

        const replay: any = await meshGraphGateCommandHandlers.mesh_graph_gate_release(ctx, {
            mesh_id: mesh, gate_id: gateId, outcome: 'passed', evidence: 'owner checked screenshots',
        });
        expect(replay).toMatchObject({ success: true, released: true, duplicate: true });

        const conflict: any = await meshGraphGateCommandHandlers.mesh_graph_gate_release(ctx, {
            mesh_id: mesh, gate_id: gateId, outcome: 'rejected',
        });
        expect(conflict).toMatchObject({ success: false, code: 'gate_release_conflict' });
    });

    it('release refuses a LIVE foreign lease (the coordinator may be mid-action)', async () => {
        const mesh = meshId('held');
        const { gateId } = seedAwaitingGate(mesh);
        expect(claimMeshGraphGate({ meshId: mesh, gateId, coordinatorSessionId: 'coord-live' }).claimed).toBe(true);
        const res: any = await meshGraphGateCommandHandlers.mesh_graph_gate_release(ctx, {
            mesh_id: mesh, gate_id: gateId, outcome: 'passed',
        });
        expect(res).toMatchObject({ success: false, code: 'gate_lease_held', released: false });
        expect(MeshRuntimeStore.getInstance().graphStore().getGate(gateId)!.state).toBe('claimed');
    });

    it('abandon requires a reason and closes the gate', async () => {
        const mesh = meshId('abandon');
        const { gateId } = seedAwaitingGate(mesh);
        const missing: any = await meshGraphGateCommandHandlers.mesh_graph_gate_abandon(ctx, { mesh_id: mesh, gate_id: gateId });
        expect(missing).toMatchObject({ success: false, code: 'bad_request' });
        const res: any = await meshGraphGateCommandHandlers.mesh_graph_gate_abandon(ctx, { mesh_id: mesh, gate_id: gateId, reason: 'obsolete' });
        expect(res).toMatchObject({ success: true, abandoned: true });
        expect(MeshRuntimeStore.getInstance().graphStore().getGate(gateId)!.state).toBe('cancelled');
    });

    it('extend reopens an expired-hold gate; claim honours deadline_seconds', async () => {
        const mesh = meshId('extend');
        const { gateId } = seedAwaitingGate(mesh, { deadlineAt: new Date(Date.now() - 1000).toISOString() });
        sweepMeshGraphGateTimeouts(mesh);
        expect(MeshRuntimeStore.getInstance().graphStore().getGate(gateId)!.state).toBe('expired');

        const ext: any = await meshGraphGateCommandHandlers.mesh_graph_gate_extend(ctx, { mesh_id: mesh, gate_id: gateId, extend_seconds: 86400 });
        expect(ext).toMatchObject({ success: true, extended: true, reopened: true, gateState: 'awaiting_coordinator' });
        expect(Date.parse(ext.deadlineAt) - Date.now()).toBeGreaterThan(86_000_000);

        const claim: any = await meshGraphGateCommandHandlers.mesh_graph_gate_claim(ctx, { mesh_id: mesh, gate_id: gateId, deadline_seconds: 600 });
        expect(claim).toMatchObject({ success: true, claimed: true });
        expect(Date.parse(claim.deadlineAt) - Date.now()).toBeLessThanOrEqual(601_000);
    });

    it('every verb fails soft on missing ids', async () => {
        for (const name of VERBS) {
            const res: any = await meshGraphGateCommandHandlers[name](ctx, {});
            expect(res.success, name).toBe(false);
            expect(res.code, name).toBe('bad_request');
        }
    });
});
