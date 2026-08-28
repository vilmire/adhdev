import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// G4 — convergence evidence for coordinator gates.
//
//   Defect this pins (measured live 2026-08-24): refinery gates sat
//   awaiting_coordinator for days while the guarded commits were already on
//   origin/main — the coordinator landed the work out-of-band and never
//   released. Evidence must say so at claim/view time, and must NEVER release
//   or mutate anything itself.
//
//   Contract pinned here:
//     (1) upstream worker envelopes' artifacts.commits are probed against
//         origin/main; all-reachable yields allReachedMain:true + the hint;
//     (2) git's "not an ancestor" (exit 1) → reachedMain:false, no hint;
//         any other git failure → 'unknown', no hint, no throw;
//     (3) no upstream commits / unknown gate / no base workspace → null;
//     (4) the probe never mutates gate or graph rows.

const testTmpDir = path.join(tmpdir(), `adhdev-gate-evidence-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');
// Static imports are hoisted above any plain statement, so the env pin must be
// hoisted too or the logger's module-load config-dir resolution runs first and
// trips the test-isolation gate. vi.hoisted runs before the import chain.
vi.hoisted(() => {
    const os = require('node:os') as typeof import('node:os');
    const p = require('node:path') as typeof import('node:path');
    process.env.ADHDEV_CONFIG_DIR = p.join(os.tmpdir(), `adhdev-gate-evidence-env-${process.pid}`, '.adhdev');
});

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
}));

const meshConfig = vi.hoisted(() => ({ workspace: '/tmp/fake-mesh-base' as string | undefined }));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(() => (meshConfig.workspace ? { nodes: [{ workspace: meshConfig.workspace }] } : { nodes: [] })),
}));

const gitMock = vi.hoisted(() => ({
    // sha → 'reachable' | 'unreachable' | 'error'
    behavior: new Map<string, 'reachable' | 'unreachable' | 'error'>(),
    calls: [] as string[][],
}));
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        execFileSync: vi.fn((cmd: string, cmdArgs: string[]) => {
            gitMock.calls.push([cmd, ...cmdArgs]);
            const sha = cmdArgs[2];
            const behavior = gitMock.behavior.get(sha) ?? 'reachable';
            if (behavior === 'reachable') return Buffer.from('');
            const err: any = new Error(behavior === 'unreachable' ? 'not an ancestor' : 'boom');
            err.status = behavior === 'unreachable' ? 1 : 128;
            throw err;
        }),
    };
});

import { collectGateConvergenceEvidence } from '../../src/mesh/mesh-graph-gate-evidence.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function meshId(tag: string): string {
    return `mesh_gateev_${tag}_${randomUUID().slice(0, 8)}`;
}

function nowIso(): string {
    return new Date().toISOString();
}

/** Graph with one completed worker (envelope commits) feeding one awaiting gate. */
function buildGateGraph(mesh: string, commits: Array<{ sha: string; repo?: string }>): { gateId: string; graphId: string } {
    const gs = MeshRuntimeStore.getInstance().graphStore();
    const graphId = randomUUID();
    const workerNodeId = randomUUID();
    const gateNodeId = randomUUID();
    const gateId = randomUUID();
    const taskId = randomUUID();
    const now = nowIso();
    gs.insertGraph({
        graphId, meshId: mesh, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: 'waiting_gate', taskCount: 1, gateCount: 1, workspaceCount: 0,
        dependencyEdgeCount: 1, policyJson: '{}', createdAt: now, updatedAt: now,
    });
    gs.insertNode({
        graphId, nodeId: workerNodeId, meshId: mesh, ref: 'implement', kind: 'worker_task',
        queueTaskId: taskId, state: 'completed', baseSpecJson: JSON.stringify({ message: 'do it' }),
        materializationVersion: 0, createdAt: now, updatedAt: now,
    });
    gs.insertNode({
        graphId, nodeId: gateNodeId, meshId: mesh, ref: 'land', kind: 'coordinator_gate',
        state: 'awaiting_coordinator', baseSpecJson: '{}',
        materializationVersion: 0, createdAt: now, updatedAt: now,
    });
    gs.insertEdge({ graphId, meshId: mesh, fromNodeId: workerNodeId, toNodeId: gateNodeId, kind: 'gate', omitOnSkip: false, createdAt: now });
    gs.insertGate({
        gateId, graphId, nodeId: gateNodeId, meshId: mesh, ref: 'land',
        state: 'awaiting_coordinator', action: 'refinery', leaseGeneration: 0, onTimeout: 'hold',
        createdAt: now, updatedAt: now,
    });
    gs.insertOutput({
        taskId, version: 1, meshId: mesh, graphId, nodeId: workerNodeId, attempt: 1,
        status: 'completed',
        envelopeJson: JSON.stringify({ task_id: taskId, status: 'completed', artifacts: { commits } }),
        digest: randomUUID(), createdAt: now,
    });
    return { gateId, graphId };
}

afterEach(() => {
    gitMock.behavior.clear();
    gitMock.calls.length = 0;
    meshConfig.workspace = '/tmp/fake-mesh-base';
    __resetMeshRuntimeStoreForTests();
    vi.clearAllMocks();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('gate convergence evidence', () => {
    it('reports allReachedMain with the release hint when every upstream commit is on origin/main', async () => {
        const mesh = meshId('reached');
        const { gateId } = buildGateGraph(mesh, [{ sha: SHA_A, repo: 'oss' }, { sha: SHA_B }]);

        const evidence = await collectGateConvergenceEvidence(mesh, gateId);
        expect(evidence).not.toBeNull();
        expect(evidence!.allReachedMain).toBe(true);
        expect(evidence!.hint).toContain('RELEASE');
        expect(evidence!.commits).toHaveLength(2);
        expect(evidence!.commits[0]).toMatchObject({ sha: SHA_A, repo: 'oss', fromRef: 'implement', reachedMain: true });
        expect(evidence!.probedAgainst).toBe('local origin/main (no fetch)');
        // The probe is merge-base --is-ancestor against origin/main, run in the base workspace.
        expect(gitMock.calls[0]).toEqual(['git', 'merge-base', '--is-ancestor', SHA_A, 'origin/main']);
    });

    it('classifies exit 1 as not-reached (no hint) and other git failures as unknown (no throw)', async () => {
        const mesh = meshId('mixed');
        gitMock.behavior.set(SHA_A, 'unreachable');
        gitMock.behavior.set(SHA_B, 'error');
        const { gateId } = buildGateGraph(mesh, [{ sha: SHA_A }, { sha: SHA_B }]);

        const evidence = await collectGateConvergenceEvidence(mesh, gateId);
        expect(evidence).not.toBeNull();
        expect(evidence!.allReachedMain).toBe(false);
        expect(evidence!.hint).toBeUndefined();
        expect(evidence!.commits.find(c => c.sha === SHA_A)?.reachedMain).toBe(false);
        expect(evidence!.commits.find(c => c.sha === SHA_B)?.reachedMain).toBe('unknown');
    });

    it('returns null when there is nothing to say', async () => {
        const mesh = meshId('nothing');
        // Unknown gate.
        expect(await collectGateConvergenceEvidence(mesh, randomUUID())).toBeNull();
        // No commit artifacts in the upstream envelope.
        const { gateId } = buildGateGraph(mesh, []);
        expect(await collectGateConvergenceEvidence(mesh, gateId)).toBeNull();
        // No base workspace on the mesh.
        const mesh2 = meshId('noworkspace');
        const { gateId: gate2 } = buildGateGraph(mesh2, [{ sha: SHA_A }]);
        meshConfig.workspace = undefined;
        expect(await collectGateConvergenceEvidence(mesh2, gate2)).toBeNull();
    });

    it('never mutates the gate or graph rows', async () => {
        const mesh = meshId('readonly');
        const { gateId, graphId } = buildGateGraph(mesh, [{ sha: SHA_A }]);
        const gs = MeshRuntimeStore.getInstance().graphStore();
        const gateBefore = JSON.stringify(gs.getGate(gateId));
        const graphBefore = JSON.stringify(gs.getGraph(graphId));

        await collectGateConvergenceEvidence(mesh, gateId);

        expect(JSON.stringify(gs.getGate(gateId))).toBe(gateBefore);
        expect(JSON.stringify(gs.getGraph(graphId))).toBe(graphBefore);
    });

    it('resolves the probe branch from mesh.defaultBranch when set (master-default mesh)', async () => {
        const mesh = meshId('masterdefault');
        vi.mocked((await import('../../src/config/mesh-config.js')).getMesh).mockReturnValue({
            nodes: [{ workspace: meshConfig.workspace }],
            defaultBranch: 'master',
        } as any);
        const { gateId } = buildGateGraph(mesh, [{ sha: SHA_A }]);

        const evidence = await collectGateConvergenceEvidence(mesh, gateId);
        expect(evidence).not.toBeNull();
        expect(evidence!.probedAgainst).toBe('local origin/master (no fetch)');
        expect(gitMock.calls[0]).toEqual(['git', 'merge-base', '--is-ancestor', SHA_A, 'origin/master']);
    });
});
