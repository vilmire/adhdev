import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// Regression: mesh_enqueue_batch with 2+ declared workspaces collapsed every
// workspace of a graph onto ONE prepared node id.
//
// derivePreparedNodeId() sliced the whole idempotency key to 48 chars:
//     'node_gws_' + `graph-ws-clone:${graphId}:${workspaceRef}`.slice(0, 48)
// but 'graph_ws_clone_' (15) + a UUID graphId (36) + a separator already spans
// 52 chars, so the cut landed mid-UUID and the workspaceRef never reached the
// id. N workspaces produced N worktrees on N distinct branches
// (deriveWorkspaceBranchIdentity keeps them apart) yet registered under one id
// — addNode() deduped the rest as re-registrations, and every task pinned to a
// dropped node stranded as `no_node_satisfies_required_tags`. Live incident
// 2026-08-26 stranded 7 tasks; the standing workaround was one workspace per
// batch.
//
// These tests drive the REAL derivation. The existing saga suite's fake ports
// mint their own `node_ws_${ref}` ids, which is exactly why the collision
// shipped undetected — a fake that is injective by construction cannot observe
// a non-injective derivation.

const testTmpDir = path.join(tmpdir(), `adhdev-graph-ws-multi-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
}));

const meshConfigMocks = vi.hoisted(() => ({
    getMesh: vi.fn(),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
    addNode: vi.fn(),
    updateNode: vi.fn(),
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: meshConfigMocks.getMesh,
    getMeshByRepo: meshConfigMocks.getMeshByRepo,
    listMeshes: meshConfigMocks.listMeshes,
    addNode: meshConfigMocks.addNode,
    updateNode: meshConfigMocks.updateNode,
}));

import { __resetMeshGraphTransitionRunnerForTests, graphMaterializationBlockReason } from '../../src/mesh/mesh-graph-transition-runner.js';
import { declareWorkspaceIntents, runWorkspaceSagaTick } from '../../src/mesh/mesh-graph-workspace-saga.js';
import { derivePreparedNodeId, type WorkspaceSagaPorts } from '../../src/mesh/mesh-graph-workspace-ports.js';
import { deriveWorkspaceBranchIdentity } from '../../src/mesh/mesh-graph-workspace-identity.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    enqueueTask,
    getQueue,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { MeshTaskGraphNodeRow } from '../../src/mesh/mesh-graph-types.js';

function meshId(tag: string): string {
    return `mesh_gwsmulti_${tag}_${randomUUID().slice(0, 8)}`;
}

function nowIso(): string {
    return new Date().toISOString();
}

function cleanup(id: string) {
    __clearMeshQueueForTests(id);
    __resetMeshRuntimeStoreForTests();
    __resetMeshGraphTransitionRunnerForTests();
    meshConfigMocks.getMesh.mockReset();
    meshConfigMocks.addNode.mockReset();
    meshConfigMocks.updateNode.mockReset();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

/**
 * Ports that mint node ids through the REAL derivation, and model membership
 * the way addNode() actually behaves: an id that is already registered is a
 * re-registration (a patch), not a second node. That is the seam where the
 * collision turned into a lost node.
 */
function createDerivingPorts() {
    const registered = new Map<string, { nodeId: string; worktreePath: string; branchIdentity: string }>();
    const worktreePaths = new Set<string>();
    const branches = new Set<string>();
    const ports: WorkspaceSagaPorts = {
        nowMs: () => Date.now(),
        resolveBaseRevision: async () => 'main',
        createWorktree: async req => {
            const nodeId = derivePreparedNodeId(req.graphId, req.workspaceRef);
            const worktreePath = req.desiredPath || `/tmp/fake-ws/${req.graphId}/${req.workspaceRef}`;
            worktreePaths.add(worktreePath);
            branches.add(req.branchIdentity);
            return { nodeId, worktreePath, ownerTag: req.ownerTag };
        },
        findOwnedWorktree: async () => null,
        inspectWorktree: async () => ({ pathExists: false, dirty: false, ahead: false, stashed: false, sessionBound: false }),
        removeWorktree: async () => ({ removed: true }),
        listLiveSessionsOnNode: async () => ({ sessionIds: [], unknown: false }),
        listAssignedTasksOnNode: async () => [],
        registerNode: async req => {
            // addNode() semantics: a duplicate id patches the existing entry.
            registered.set(req.nodeId, {
                nodeId: req.nodeId,
                worktreePath: req.worktreePath,
                branchIdentity: req.branchIdentity,
            });
            return true;
        },
        unregisterNode: async req => registered.delete(req.nodeId),
    };
    return { ports, registered, worktreePaths, branches };
}

/** Seed one graph declaring N workspaces, each with its own worker task. */
function seedGraphWithWorkspaces(mesh: string, refs: string[]) {
    const gs = MeshRuntimeStore.getInstance().graphStore();
    const graphId = randomUUID();
    const now = nowIso();
    gs.insertGraph({
        graphId, meshId: mesh, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: 'preparing', taskCount: refs.length, gateCount: 0, workspaceCount: refs.length,
        dependencyEdgeCount: 0, policyJson: '{}', createdAt: now, updatedAt: now,
    });

    const tasksByRef = new Map<string, string>();
    refs.forEach((ref, i) => {
        const task = enqueueTask(mesh, `task for ${ref}`, { taskMode: 'code_change', difficulty: 'medium' } as any);
        const nodeId = randomUUID();
        const nodeRow: MeshTaskGraphNodeRow = {
            graphId, nodeId, meshId: mesh, ref: `t${i}`, kind: 'worker_task', queueTaskId: task.id,
            state: 'declared',
            baseSpecJson: JSON.stringify({ message: `task for ${ref}`, workspace_ref: ref }),
            materializationVersion: 0, createdAt: now, updatedAt: now,
        };
        gs.insertNode(nodeRow);
        const entry = getQueue(mesh).find(t => t.id === task.id)!;
        MeshRuntimeStore.getInstance().updateQueueEntry({
            ...entry, blockedReason: graphMaterializationBlockReason(nodeId, 0), updatedAt: now,
        } as any);
        tasksByRef.set(ref, task.id);
    });

    declareWorkspaceIntents({
        graphId, meshId: mesh,
        workspaces: refs.map(ref => ({
            ref,
            source_node_id: 'local-base',
            base_revision: 'main',
            cleanup_on_graph_failure: true,
        })),
    });
    return { graphId, tasksByRef };
}

describe('multi-workspace batch → one prepared node per workspace', () => {
    it('derives a distinct node id per workspace of the same graph', () => {
        const graphId = randomUUID();
        const ids = ['ws-alpha', 'ws-beta', 'ws-gamma'].map(ref => derivePreparedNodeId(graphId, ref));
        expect(new Set(ids).size).toBe(3);
    });

    it('keeps ids distinct when long workspace refs share a leading prefix', () => {
        const graphId = randomUUID();
        const shared = 'workspace-for-the-very-long-refactor-effort';
        const a = derivePreparedNodeId(graphId, `${shared}-alpha`);
        const b = derivePreparedNodeId(graphId, `${shared}-beta`);
        expect(a).not.toBe(b);
    });

    it('is deterministic — the same graph+workspace always derives the same id', () => {
        const graphId = randomUUID();
        expect(derivePreparedNodeId(graphId, 'ws-alpha')).toBe(derivePreparedNodeId(graphId, 'ws-alpha'));
    });

    it('separates workspaces of different graphs', () => {
        expect(derivePreparedNodeId(randomUUID(), 'ws')).not.toBe(derivePreparedNodeId(randomUUID(), 'ws'));
    });

    // ── The defect as it was actually observed ───────────────────────────────
    it('registers N nodes for N declared workspaces and pins each task to its own', async () => {
        const id = meshId('two_ws');
        try {
            const refs = ['ws-alpha', 'ws-beta'];
            const { graphId, tasksByRef } = seedGraphWithWorkspaces(id, refs);
            const fake = createDerivingPorts();

            await runWorkspaceSagaTick(id, fake.ports);

            const gs = MeshRuntimeStore.getInstance().graphStore();
            const intents = refs.map(ref => gs.getWorkspaceIntent(graphId, ref)!);
            for (const intent of intents) expect(intent.sagaState).toBe('ready');

            // Pre-fix this was 1: both workspaces derived the same id, so the
            // second registerNode() patched the first entry instead of adding.
            expect(fake.registered.size).toBe(2);
            const createdIds = intents.map(i => i.createdNodeId);
            expect(new Set(createdIds).size).toBe(2);
            for (const nodeId of createdIds) expect(fake.registered.has(nodeId!)).toBe(true);

            // Each node keeps its own worktree + branch — the resources were
            // always distinct; only the identity collapsed.
            expect(fake.worktreePaths.size).toBe(2);
            expect(fake.branches.size).toBe(2);

            // Every task lands on the node for ITS workspace. Pre-fix the
            // second task pinned to an id that no longer named a live node →
            // no_node_satisfies_required_tags.
            for (const ref of refs) {
                const entry = getQueue(id).find(t => t.id === tasksByRef.get(ref))!;
                const intent = gs.getWorkspaceIntent(graphId, ref)!;
                expect(entry.targetNodeId).toBe(intent.createdNodeId);
                expect(entry.blockedReason).toBeUndefined();
                expect(fake.registered.has(entry.targetNodeId!)).toBe(true);
            }
        } finally {
            cleanup(id);
        }
    });

    it('scales past two — five declared workspaces yield five nodes', async () => {
        const id = meshId('five_ws');
        try {
            const refs = ['ws-a', 'ws-b', 'ws-c', 'ws-d', 'ws-e'];
            const { graphId } = seedGraphWithWorkspaces(id, refs);
            const fake = createDerivingPorts();

            await runWorkspaceSagaTick(id, fake.ports);

            expect(fake.registered.size).toBe(5);
            const gs = MeshRuntimeStore.getInstance().graphStore();
            const ids = refs.map(ref => gs.getWorkspaceIntent(graphId, ref)!.createdNodeId);
            expect(new Set(ids).size).toBe(5);
        } finally {
            cleanup(id);
        }
    });

    // ── Single-workspace regression guard ────────────────────────────────────
    it('single-workspace batches still prepare exactly one node', async () => {
        const id = meshId('one_ws');
        try {
            const { graphId, tasksByRef } = seedGraphWithWorkspaces(id, ['solo_workspace']);
            const fake = createDerivingPorts();

            await runWorkspaceSagaTick(id, fake.ports);

            expect(fake.registered.size).toBe(1);
            const gs = MeshRuntimeStore.getInstance().graphStore();
            const intent = gs.getWorkspaceIntent(graphId, 'solo_workspace')!;
            expect(intent.sagaState).toBe('ready');
            const entry = getQueue(id).find(t => t.id === tasksByRef.get('solo_workspace'))!;
            expect(entry.targetNodeId).toBe(intent.createdNodeId);
            expect(entry.blockedReason).toBeUndefined();
        } finally {
            cleanup(id);
        }
    });

    it('derived ids stay shell/id safe and bounded', () => {
        const graphId = randomUUID();
        for (const ref of ['ws-alpha', 'feature/deep nested ref', 'ws.with.dots', 'ws_underscore']) {
            const nodeId = derivePreparedNodeId(graphId, ref);
            expect(nodeId).toMatch(/^node_gws_[A-Za-z0-9_]+$/);
            expect(nodeId.length).toBeLessThanOrEqual(64);
        }
    });

    it('a workspace ref that sanitizes to nothing still derives a usable id', () => {
        const graphId = randomUUID();
        const a = derivePreparedNodeId(graphId, '///');
        const b = derivePreparedNodeId(graphId, '***');
        expect(a).toMatch(/^node_gws_[A-Za-z0-9_]+$/);
        // Distinct raw refs stay distinct even when both sanitize to the same stem.
        expect(a).not.toBe(b);
    });

    it('node id and branch identity agree on the graph stem', () => {
        const graphId = randomUUID();
        const branch = deriveWorkspaceBranchIdentity(graphId, 'ws-alpha');
        const nodeId = derivePreparedNodeId(graphId, 'ws-alpha');
        const stem = graphId.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 8);
        expect(branch).toContain(stem);
        expect(nodeId).toContain(stem.replace(/-/g, '_'));
    });
});
