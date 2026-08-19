import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// GRAPH-ORCHESTRATION Phase G — workspace saga gaps NOT pinned by
// mesh-graph-workspace-saga.test.ts.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :829  preflight/clone failure creates no worktree
//     :832-833  assigned worktree is not deleted → compensation_required
//     :835  duplicate declaration resumes the same intent
//
//   Already covered elsewhere (do not duplicate here): crash-after-clone and
//   crash-after-identity-persist resume, permanent finalize failure
//   compensating a clean owned tree, dirty/ahead/stashed/session-bound/
//   unowned/ambiguous refusals, restart lease takeover + fencing.

const testTmpDir = path.join(tmpdir(), `adhdev-graph-ws-saga-gaps-${randomUUID().slice(0, 8)}`);
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
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: meshConfigMocks.getMesh,
    getMeshByRepo: meshConfigMocks.getMeshByRepo,
    listMeshes: meshConfigMocks.listMeshes,
}));

import {
    graphMaterializationBlockReason,
    __resetMeshGraphTransitionRunnerForTests,
} from '../../src/mesh/mesh-graph-transition-runner.js';
import {
    declareWorkspaceIntents,
    runWorkspaceSagaTick,
    compensateWorkspaceIntent,
} from '../../src/mesh/mesh-graph-workspace-saga.js';
import { WorkspaceSagaPermanentError, type WorkspaceSagaPorts } from '../../src/mesh/mesh-graph-workspace-ports.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    enqueueTask,
    getQueue,
    taskDependenciesSatisfied,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { MeshTaskGraphNodeRow } from '../../src/mesh/mesh-graph-types.js';

function meshId(tag: string): string {
    return `mesh_graphg_${tag}_${randomUUID().slice(0, 8)}`;
}

function nowIso(): string {
    return new Date().toISOString();
}

function cleanup(id: string) {
    __clearMeshQueueForTests(id);
    __resetMeshRuntimeStoreForTests();
    __resetMeshGraphTransitionRunnerForTests();
    meshConfigMocks.getMesh.mockReset();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

function enqueue(mesh: string, message: string, opts: Record<string, unknown> = {}) {
    return enqueueTask(mesh, message, { taskMode: 'code_change', difficulty: 'medium', ...opts } as any);
}

interface FakeTree {
    nodeId: string;
    worktreePath: string;
    ownerTag: string;
    dirty: boolean;
    ahead: boolean;
    stashed: boolean;
    removed: boolean;
}

function createFakePorts(opts?: {
    sessions?: { sessionIds: string[]; unknown?: boolean };
    assigned?: string[];
    failClone?: Error;
}): { ports: WorkspaceSagaPorts; clones: number; removes: number; trees: Map<string, FakeTree> } {
    const trees = new Map<string, FakeTree>();
    let clones = 0;
    let removes = 0;
    const ports: WorkspaceSagaPorts = {
        nowMs: () => Date.now(),
        createWorktree: async req => {
            if (opts?.failClone) throw opts.failClone;
            clones += 1;
            const tree: FakeTree = {
                nodeId: `node_ws_${req.workspaceRef}`,
                worktreePath: req.desiredPath || `/tmp/fake-ws/${req.graphId}/${req.workspaceRef}`,
                ownerTag: req.ownerTag,
                dirty: false,
                ahead: false,
                stashed: false,
                removed: false,
            };
            trees.set(req.workspaceRef, tree);
            return { nodeId: tree.nodeId, worktreePath: tree.worktreePath, ownerTag: tree.ownerTag };
        },
        findOwnedWorktree: async req => {
            const tree = trees.get(req.workspaceRef);
            if (!tree || tree.removed) return null;
            if (req.ownerTag && tree.ownerTag !== req.ownerTag) return null;
            return { nodeId: tree.nodeId, worktreePath: tree.worktreePath, ownerTag: tree.ownerTag, alreadyExisted: true };
        },
        inspectWorktree: async req => {
            const tree = trees.get(req.workspaceRef);
            return tree && !tree.removed
                ? {
                    pathExists: true,
                    observedOwnerTag: tree.ownerTag,
                    dirty: tree.dirty,
                    ahead: tree.ahead,
                    stashed: tree.stashed,
                    sessionBound: false,
                }
                : { pathExists: false, dirty: false, ahead: false, stashed: false, sessionBound: false };
        },
        removeWorktree: async req => {
            removes += 1;
            const tree = [...trees.values()].find(t => t.worktreePath === req.worktreePath);
            if (tree) tree.removed = true;
            return { removed: true };
        },
        listLiveSessionsOnNode: async () => opts?.sessions ?? { sessionIds: [], unknown: false },
        listAssignedTasksOnNode: async () => opts?.assigned ?? [],
    };
    return {
        ports,
        get clones() { return clones; },
        get removes() { return removes; },
        trees,
    } as any;
}

function seedGraphWithWorkspace(mesh: string, opts?: { workspaceRef?: string }) {
    const workspaceRef = opts?.workspaceRef ?? 'fix_workspace';
    const task = enqueue(mesh, 'fix the bug — workspace not yet bound');
    const gs = MeshRuntimeStore.getInstance().graphStore();
    const graphId = randomUUID();
    const nodeId = randomUUID();
    const now = nowIso();
    gs.insertGraph({
        graphId, meshId: mesh, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: 'preparing', taskCount: 1, gateCount: 0, workspaceCount: 1, dependencyEdgeCount: 0,
        policyJson: '{}', createdAt: now, updatedAt: now,
    });
    const nodeRow: MeshTaskGraphNodeRow = {
        graphId, nodeId, meshId: mesh, ref: 'fix', kind: 'worker_task', queueTaskId: task.id,
        state: 'declared',
        baseSpecJson: JSON.stringify({ message: 'fix the bug', workspace_ref: workspaceRef }),
        materializationVersion: 0, createdAt: now, updatedAt: now,
    };
    gs.insertNode(nodeRow);
    // Hold the workspace-bound task with the graph materialization block, the
    // same hold the production commit path applies (saga test :191-196).
    const entry = getQueue(mesh).find(t => t.id === task.id)!;
    MeshRuntimeStore.getInstance().updateQueueEntry({
        ...entry, blockedReason: graphMaterializationBlockReason(nodeId, 0), updatedAt: now,
    } as any);
    declareWorkspaceIntents({
        graphId, meshId: mesh,
        workspaces: [{
            ref: workspaceRef,
            source_node_id: 'local-base',
            purpose: 'codex-deadlock-fix',
            base_revision: 'main',
            cleanup_on_graph_failure: true,
        }],
    });
    return { graphId, nodeId, task, workspaceRef };
}

function statusById(mesh: string): Map<string, string> {
    return new Map(getQueue(mesh).map(t => [t.id, t.status] as const));
}

// ── 1. Clone/preflight failure (design :829) ─────────────────────────────────

describe('clone/preflight failure creates no worktree (design :829)', () => {
    it('a failing clone marks the intent failed, binds nothing, and a later tick does NOT silently retry', async () => {
        const id = meshId('clone_fail');
        try {
            const { graphId, task, workspaceRef } = seedGraphWithWorkspace(id);
            const fake = createFakePorts({ failClone: new Error('disk full: clone refused') });

            const tick = await runWorkspaceSagaTick(id, fake.ports);
            expect(tick.steps).toHaveLength(1);
            expect(tick.steps[0]?.action).toBe('clone_failed');
            expect(tick.steps[0]?.sagaState).toBe('failed');
            // ZERO clones completed, ZERO removes — no worktree ever existed.
            expect(fake.clones).toBe(0);
            expect(fake.removes).toBe(0);

            // The failure is recorded on the intent for observability, with no
            // created identity and no worktree binding on the queue task.
            const intent = MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!;
            expect(intent.sagaState).toBe('failed');
            expect(intent.lastError).toMatch(/disk full: clone refused/);
            expect(intent.createdNodeId).toBeUndefined();
            expect(intent.createdWorktreePath).toBeUndefined();
            const entry = getQueue(id).find(t => t.id === task.id)!;
            expect(entry.targetNodeId).toBeUndefined();
            expect(taskDependenciesSatisfied(entry, statusById(id))).toBe(false);

            // Designed resume semantics: 'failed' is TERMINAL. Even with the
            // lease force-expired, a later tick must not silently retry the
            // clone — a non-idempotent re-clone after an operator-visible
            // failure is exactly what the terminal state exists to prevent.
            MeshRuntimeStore.getInstance().graphStore().patchWorkspaceIntent(
                graphId, workspaceRef, { leaseExpiresAt: '2000-01-01T00:00:00.000Z' }, nowIso(),
            );
            const retry = await runWorkspaceSagaTick(id, fake.ports);
            const retryStep = retry.steps.find(s => s.graphId === graphId && s.workspaceRef === workspaceRef);
            if (retryStep) expect(retryStep.action).toBe('already_terminal');
            expect(fake.clones).toBe(0);
            expect(fake.removes).toBe(0);
            expect(MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!.sagaState).toBe('failed');
        } finally {
            cleanup(id);
        }
    });

    it('a permanent preflight failure also fails the intent without inventing a compensation delete', async () => {
        const id = meshId('preflight_fail');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id);
            const fake = createFakePorts({
                failClone: new WorkspaceSagaPermanentError('preflight_failed', 'source node has no git repo'),
            });

            const tick = await runWorkspaceSagaTick(id, fake.ports);
            expect(tick.steps[0]?.action).toBe('clone_failed');
            expect(tick.steps[0]?.sagaState).toBe('failed');
            expect(fake.clones).toBe(0);
            // No worktree was ever created, so compensation must not remove
            // anything — a delete here would be destroying something the saga
            // never owned.
            expect(fake.removes).toBe(0);
            const intent = MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!;
            expect(intent.sagaState).toBe('failed');
            expect(intent.lastError).toMatch(/source node has no git repo/);
        } finally {
            cleanup(id);
        }
    });
});

// ── 2. Assigned-task worktree refused through the saga (design :832-833) ─────

describe('assigned worktree compensation refusal (design :832-833)', () => {
    it('does not delete a worktree whose created node has assigned tasks — compensation_required', async () => {
        const id = meshId('refuse_assigned');
        try {
            const { graphId, workspaceRef, task } = seedGraphWithWorkspace(id);
            const fake = createFakePorts({ assigned: ['task-live-on-created-node'] });
            // Prepare fully so the created node exists and the assigned-task
            // probe (listAssignedTasksOnNode) reports a live assignment.
            const prepared = await runWorkspaceSagaTick(id, fake.ports);
            expect(prepared.steps[0]?.sagaState).toBe('ready');
            expect(fake.clones).toBe(1);

            const step = await compensateWorkspaceIntent(graphId, workspaceRef, fake.ports, 'graph_failed');
            expect(step.action).toBe('compensation_required');
            expect(step.refusals).toContain('assigned_task');
            expect(fake.removes).toBe(0);
            expect(fake.trees.get(workspaceRef)!.removed).toBe(false);

            const gs = MeshRuntimeStore.getInstance().graphStore();
            expect(gs.getWorkspaceIntent(graphId, workspaceRef)!.sagaState).toBe('compensation_required');
            expect(gs.getGraph(graphId)!.status).toBe('compensation_required');
            // The held task must stay unclaimable — no silent unbind.
            const entry = getQueue(id).find(t => t.id === task.id)!;
            expect(taskDependenciesSatisfied(entry, statusById(id))).toBe(false);
        } finally {
            cleanup(id);
        }
    });
});

// ── 3. Duplicate declaration resumes the same intent (design :835) ───────────

describe('duplicate workspace declaration (design :835)', () => {
    it('re-declaring the same graph/workspaces returns the same rows without duplicating them', () => {
        const id = meshId('dup_declare');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id);
            const gs = MeshRuntimeStore.getInstance().graphStore();
            const seeded = gs.getWorkspaceIntent(graphId, workspaceRef)!;

            // Identical re-declaration (the enqueue retry path).
            const first = declareWorkspaceIntents({
                graphId, meshId: id,
                workspaces: [{ ref: workspaceRef, source_node_id: 'local-base', base_revision: 'main' }],
            });
            // A conflicting re-declaration (different purpose) must ALSO resume
            // the existing intent — the first declaration wins.
            const second = declareWorkspaceIntents({
                graphId, meshId: id,
                workspaces: [{ ref: workspaceRef, source_node_id: 'local-base', purpose: 'a-different-purpose', base_revision: 'main' }],
            });

            expect(first).toHaveLength(1);
            expect(second).toHaveLength(1);
            expect(gs.listWorkspaceIntents(graphId)).toHaveLength(1);
            for (const row of [first[0]!, second[0]!]) {
                expect(row.workspaceRef).toBe(seeded.workspaceRef);
                expect(row.createdAt).toBe(seeded.createdAt);
                expect(row.branchIdentity).toBe(seeded.branchIdentity);
                expect(row.leaseGeneration).toBe(seeded.leaseGeneration);
                expect(row.sagaState).toBe(seeded.sagaState);
            }

            // Partial overlap inserts ONLY the genuinely new ref.
            const third = declareWorkspaceIntents({
                graphId, meshId: id,
                workspaces: [
                    { ref: workspaceRef, source_node_id: 'local-base', base_revision: 'main' },
                    { ref: 'extra_workspace', source_node_id: 'local-base', base_revision: 'main' },
                ],
            });
            expect(third).toHaveLength(2);
            const all = gs.listWorkspaceIntents(graphId);
            expect(all).toHaveLength(2);
            expect(all.map(i => i.workspaceRef).sort()).toEqual(['extra_workspace', workspaceRef].sort());
            // The pre-existing row is still the same intent, not a re-insert.
            const resumed = all.find(i => i.workspaceRef === workspaceRef)!;
            expect(resumed.createdAt).toBe(seeded.createdAt);
            expect(resumed.branchIdentity).toBe(seeded.branchIdentity);
        } finally {
            cleanup(id);
        }
    });
});
