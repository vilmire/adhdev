import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// GRAPH-ORCHESTRATION Phase D — delayed workspace_ref saga + compensation.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :441-478  delayed workspace_ref (not a clone vertex)
//     :479-512  saga + owned-resource compensation
//     :993      git/FS and SQLite are NOT one transaction
//     :994-995  never delete dirty/ahead/stashed/session-bound/unowned/ambiguous
//
//   Clone is injected through WorkspaceSagaPorts — never modelled as an
//   agent task. Fault hooks reproduce crash-after-clone and
//   crash-after-identity-persist. Compensation is pinned per refusal.

const testTmpDir = path.join(tmpdir(), `adhdev-graph-ws-saga-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');
const realGitRoots: string[] = [];

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
    commitTaskTerminalAndAdvanceGraph,
    graphMaterializationBlockReason,
    rematerializePendingGraphNodesForWorkspace,
    __resetMeshGraphTransitionRunnerForTests,
} from '../../src/mesh/mesh-graph-transition-runner.js';
import {
    declareWorkspaceIntents,
    runWorkspaceSagaTick,
    recoverExpiredWorkspaceSagas,
    compensateWorkspaceIntent,
    setWorkspaceBaseRevision,
} from '../../src/mesh/mesh-graph-workspace-saga.js';
import { WorkspaceSagaPermanentError, type WorkspaceSagaPorts } from '../../src/mesh/mesh-graph-workspace-ports.js';
import { buildMeshGraphViews } from '../../src/mesh/mesh-graph-view.js';
import { classifyWorkspaceCompensationSafety } from '../../src/mesh/mesh-graph-workspace-safety.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    enqueueTask,
    getQueue,
    taskDependenciesSatisfied,
    updateTaskStatus,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { MeshTaskGraphNodeRow } from '../../src/mesh/mesh-graph-types.js';
import type { WorkspaceInspectReport } from '../../src/mesh/mesh-graph-workspace-safety.js';

function meshId(tag: string): string {
    return `mesh_graphd_${tag}_${randomUUID().slice(0, 8)}`;
}

function nowIso(): string {
    return new Date().toISOString();
}

function cleanup(id: string) {
    __clearMeshQueueForTests(id);
    __resetMeshRuntimeStoreForTests();
    __resetMeshGraphTransitionRunnerForTests();
    meshConfigMocks.getMesh.mockReset();
    for (const root of realGitRoots.splice(0)) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
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
    inspectOverride?: (tree: FakeTree | undefined) => Partial<WorkspaceInspectReport>;
    sessions?: { sessionIds: string[]; unknown?: boolean };
    assigned?: string[];
    failClone?: Error;
    failFinalize?: Error;
    /** Base revision the source node resolves to; undefined = underivable (default). */
    derivedBaseRevision?: string;
}): { ports: WorkspaceSagaPorts; clones: number; removes: number; trees: Map<string, FakeTree> } {
    const trees = new Map<string, FakeTree>();
    let clones = 0;
    let removes = 0;
    const ports: WorkspaceSagaPorts = {
        nowMs: () => Date.now(),
        resolveBaseRevision: async () => opts?.derivedBaseRevision,
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
            const base: WorkspaceInspectReport = tree && !tree.removed
                ? {
                    pathExists: true,
                    observedOwnerTag: tree.ownerTag,
                    dirty: tree.dirty,
                    ahead: tree.ahead,
                    stashed: tree.stashed,
                    sessionBound: false,
                }
                : { pathExists: false, dirty: false, ahead: false, stashed: false, sessionBound: false };
            return { ...base, ...(opts?.inspectOverride?.(tree) ?? {}) };
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

function seedGraphWithWorkspace(mesh: string, opts?: { blockTask?: boolean; workspaceRef?: string; baseRevision?: string }) {
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
    if (opts?.blockTask !== false) {
        const entry = getQueue(mesh).find(t => t.id === task.id)!;
        MeshRuntimeStore.getInstance().updateQueueEntry({
            ...entry, blockedReason: graphMaterializationBlockReason(nodeId, 0), updatedAt: now,
        } as any);
    }
    declareWorkspaceIntents({
        graphId, meshId: mesh,
        workspaces: [{
            ref: workspaceRef,
            source_node_id: 'local-base',
            purpose: 'codex-deadlock-fix',
            base_revision: opts?.baseRevision ?? 'main',
            cleanup_on_graph_failure: true,
        }],
    });
    return { graphId, nodeId, task, workspaceRef };
}

function statusById(mesh: string): Map<string, string> {
    return new Map(getQueue(mesh).map(t => [t.id, t.status] as const));
}

// ── 1. Delayed binding ───────────────────────────────────────────────────────

describe('delayed workspace_ref binding (design :441-478)', () => {
    it('keeps an unresolved workspace task unclaimable via the unchanged predicate', () => {
        const id = meshId('unresolved');
        try {
            const { task } = seedGraphWithWorkspace(id);
            const entry = getQueue(id).find(t => t.id === task.id)!;
            expect(entry.targetNodeId).toBeUndefined();
            expect(entry.blockedReason).toMatch(/^graph_materialization_pending:/);
            expect(taskDependenciesSatisfied(entry, statusById(id))).toBe(false);
        } finally {
            cleanup(id);
        }
    });

    it('does not model clone as a queue task — no extra agent rows are inserted', async () => {
        const id = meshId('no_clone_task');
        try {
            seedGraphWithWorkspace(id);
            const fake = createFakePorts();
            await runWorkspaceSagaTick(id, fake.ports);
            expect(getQueue(id)).toHaveLength(1);
            expect(fake.clones).toBe(1);
        } finally {
            cleanup(id);
        }
    });

    it('binds targetNodeId + worktree affinity once the saga is ready', async () => {
        const id = meshId('bind');
        try {
            const { graphId, task, workspaceRef } = seedGraphWithWorkspace(id);
            const fake = createFakePorts();
            const tick = await runWorkspaceSagaTick(id, fake.ports);
            expect(tick.steps[0]?.sagaState).toBe('ready');
            const intent = MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!;
            expect(intent.sagaState).toBe('ready');
            expect(intent.createdNodeId).toBe(`node_ws_${workspaceRef}`);
            const entry = getQueue(id).find(t => t.id === task.id)!;
            expect(entry.targetNodeId).toBe(intent.createdNodeId);
            expect(entry.requiredTags?.some(t => t.startsWith('worktree='))).toBe(true);
            expect(entry.blockedReason).toBeUndefined();
            expect(taskDependenciesSatisfied(entry, statusById(id))).toBe(true);
            expect(MeshRuntimeStore.getInstance().graphStore().getGraph(graphId)!.status).toBe('active');
        } finally {
            cleanup(id);
        }
    });

    it('stays declared when the base revision is not yet known (design :509-511)', async () => {
        const id = meshId('no_base');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id, { baseRevision: undefined });
            MeshRuntimeStore.getInstance().graphStore().patchWorkspaceIntent(
                graphId, workspaceRef, { baseRevision: null }, nowIso(),
            );
            const fake = createFakePorts();
            const tick = await runWorkspaceSagaTick(id, fake.ports);
            expect(tick.steps[0]?.action).toBe('skipped_no_base');
            expect(fake.clones).toBe(0);
            expect(MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!.sagaState).toBe('declared');
            setWorkspaceBaseRevision(graphId, workspaceRef, 'main');
            await runWorkspaceSagaTick(id, fake.ports);
            expect(fake.clones).toBe(1);
            expect(MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!.sagaState).toBe('ready');
        } finally {
            cleanup(id);
        }
    });

    // The defect this pins: a declaration that omitted base_revision parked in
    // 'declared' FOREVER. The branch returned skipped_no_base without writing,
    // logging or erroring, and the reconcile tick re-entered it every few seconds;
    // the one designed escape (setWorkspaceBaseRevision, exercised above) has no
    // production caller, so nothing ever supplied the missing revision.
    it('derives the base revision from the source node instead of parking in declared forever', async () => {
        const id = meshId('derive_base');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id, { baseRevision: undefined });
            MeshRuntimeStore.getInstance().graphStore().patchWorkspaceIntent(
                graphId, workspaceRef, { baseRevision: null }, nowIso(),
            );
            const fake = createFakePorts({ derivedBaseRevision: 'main' });
            const tick = await runWorkspaceSagaTick(id, fake.ports);

            // One tick — no operator call in between — leaves 'declared' behind.
            expect(tick.steps[0]?.action).not.toBe('skipped_no_base');
            expect(tick.steps[0]?.sagaState).toBe('ready');
            expect(fake.clones).toBe(1);

            // The derived revision is PERSISTED, not merely used in-flight: the
            // ahead-probe that compensation safety depends on re-reads it later.
            const intent = MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!;
            expect(intent.baseRevision).toBe('main');
            expect(intent.sagaState).toBe('ready');
        } finally {
            cleanup(id);
        }
    });

    it('passes the derived revision to the clone rather than cloning from an unknown base', async () => {
        const id = meshId('derive_base_clone_arg');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id, { baseRevision: undefined });
            MeshRuntimeStore.getInstance().graphStore().patchWorkspaceIntent(
                graphId, workspaceRef, { baseRevision: null }, nowIso(),
            );
            const seen: Array<string | undefined> = [];
            const fake = createFakePorts({ derivedBaseRevision: 'release/v2' });
            const ports: WorkspaceSagaPorts = {
                ...fake.ports,
                createWorktree: req => { seen.push(req.baseRevision); return fake.ports.createWorktree(req); },
            };
            await runWorkspaceSagaTick(id, ports);
            expect(seen).toEqual(['release/v2']);
        } finally {
            cleanup(id);
        }
    });

    it('stays declared — the pre-existing safe behaviour — when the source node yields no revision', async () => {
        const id = meshId('derive_base_unresolvable');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id, { baseRevision: undefined });
            MeshRuntimeStore.getInstance().graphStore().patchWorkspaceIntent(
                graphId, workspaceRef, { baseRevision: null }, nowIso(),
            );
            // derivedBaseRevision omitted → the port resolves to undefined.
            const fake = createFakePorts();
            const tick = await runWorkspaceSagaTick(id, fake.ports);
            expect(tick.steps[0]?.action).toBe('skipped_no_base');
            expect(fake.clones).toBe(0);
            expect(MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!.sagaState).toBe('declared');
        } finally {
            cleanup(id);
        }
    });

    it('a throwing resolveBaseRevision degrades to declared, never to a clone from an unknown base', async () => {
        const id = meshId('derive_base_throws');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id, { baseRevision: undefined });
            MeshRuntimeStore.getInstance().graphStore().patchWorkspaceIntent(
                graphId, workspaceRef, { baseRevision: null }, nowIso(),
            );
            const fake = createFakePorts();
            const ports: WorkspaceSagaPorts = {
                ...fake.ports,
                resolveBaseRevision: async () => { throw new Error('git is unreachable'); },
            };
            const tick = await runWorkspaceSagaTick(id, ports);
            expect(tick.steps[0]?.action).toBe('skipped_no_base');
            expect(fake.clones).toBe(0);
            expect(MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!.sagaState).toBe('declared');
        } finally {
            cleanup(id);
        }
    });

    it('never re-derives over a base revision that was declared explicitly', async () => {
        const id = meshId('derive_base_no_override');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id, { baseRevision: 'main' });
            let derivations = 0;
            const fake = createFakePorts({ derivedBaseRevision: 'some-other-branch' });
            const ports: WorkspaceSagaPorts = {
                ...fake.ports,
                resolveBaseRevision: async () => { derivations += 1; return 'some-other-branch'; },
            };
            await runWorkspaceSagaTick(id, ports);
            expect(derivations).toBe(0);
            expect(MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!.baseRevision).toBe('main');
        } finally {
            cleanup(id);
        }
    });

    // The paired half of the fix: when derivation genuinely cannot resolve, the
    // saga still stays declared — but the stall must stop being SILENT. Before
    // this, a graph parked here looked alive while making no progress at all, with
    // nothing written, logged, or surfaced anywhere a coordinator would look.
    it('mesh_graph_view names a base-less declared workspace as a required coordinator action', async () => {
        const id = meshId('view_declared_no_base');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id, { baseRevision: undefined });
            MeshRuntimeStore.getInstance().graphStore().patchWorkspaceIntent(
                graphId, workspaceRef, { baseRevision: null }, nowIso(),
            );
            await runWorkspaceSagaTick(id, createFakePorts().ports);

            const view = buildMeshGraphViews(id, { graphId })[0]!;
            const action = view.nextCoordinatorAction?.find(a => a.kind === 'workspace_declared_no_base');
            expect(action).toBeDefined();
            expect(action!.workspaceRef).toBe(workspaceRef);
            // Actionable, not just present: it must name the source node it tried and
            // say what the operator has to do.
            expect(action!.detail).toContain('local-base');
            expect(action!.detail).toMatch(/base_revision/);
        } finally {
            cleanup(id);
        }
    });

    it('raises no such action once a base revision exists', async () => {
        const id = meshId('view_no_action_when_based');
        try {
            const { graphId } = seedGraphWithWorkspace(id, { baseRevision: 'main' });
            await runWorkspaceSagaTick(id, createFakePorts().ports);
            const view = buildMeshGraphViews(id, { graphId })[0]!;
            expect(view.nextCoordinatorAction?.some(a => a.kind === 'workspace_declared_no_base')).toBeFalsy();
        } finally {
            cleanup(id);
        }
    });

    it('B terminal path does not materialize a downstream node whose workspace_ref is unresolved', () => {
        const id = meshId('runner_defer');
        try {
            const taskA = enqueue(id, 'investigate');
            const taskB = enqueue(id, 'fix — waiting on workspace');
            const gs = MeshRuntimeStore.getInstance().graphStore();
            const graphId = randomUUID();
            const nodeA = randomUUID();
            const nodeB = randomUUID();
            const now = nowIso();
            gs.insertGraph({
                graphId, meshId: id, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
                status: 'active', taskCount: 2, gateCount: 0, workspaceCount: 1, dependencyEdgeCount: 1,
                policyJson: '{}', createdAt: now, updatedAt: now,
            });
            gs.insertNode({
                graphId, nodeId: nodeA, meshId: id, ref: 'a', kind: 'worker_task', queueTaskId: taskA.id,
                state: 'declared', baseSpecJson: JSON.stringify({ message: 'investigate' }),
                materializationVersion: 0, createdAt: now, updatedAt: now,
            });
            gs.insertNode({
                graphId, nodeId: nodeB, meshId: id, ref: 'b', kind: 'worker_task', queueTaskId: taskB.id,
                state: 'declared',
                baseSpecJson: JSON.stringify({ message: 'fix', workspace_ref: 'fix_workspace' }),
                materializationVersion: 0, createdAt: now, updatedAt: now,
            });
            gs.insertEdge({
                graphId, meshId: id, fromNodeId: nodeA, toNodeId: nodeB, kind: 'requires',
                omitOnSkip: false, createdAt: now,
            });
            MeshRuntimeStore.getInstance().updateQueueEntry({
                ...getQueue(id).find(t => t.id === taskB.id)!,
                blockedReason: graphMaterializationBlockReason(nodeB, 0), updatedAt: now,
            } as any);
            declareWorkspaceIntents({
                graphId, meshId: id,
                workspaces: [{ ref: 'fix_workspace', source_node_id: 'local-base', base_revision: 'main' }],
            });

            updateTaskStatus(id, taskA.id, 'completed');
            const nodeBRow = gs.getNode(graphId, nodeB)!;
            expect(nodeBRow.state).not.toBe('materialized');
            const entryB = getQueue(id).find(t => t.id === taskB.id)!;
            expect(entryB.targetNodeId).toBeUndefined();
            expect(entryB.blockedReason).toMatch(/^graph_materialization_pending:/);
            expect(taskDependenciesSatisfied(entryB, statusById(id))).toBe(false);
        } finally {
            cleanup(id);
        }
    });
});

// ── 2. Crash recovery ────────────────────────────────────────────────────────

describe('crash recovery (design :493-507)', () => {
    it('resumes after clone success + identity persist when finalize/enqueue crashes — no second clone', async () => {
        const id = meshId('crash_finalize');
        try {
            const { graphId, task, workspaceRef } = seedGraphWithWorkspace(id);
            const fake = createFakePorts();
            const crashed = await runWorkspaceSagaTick(id, fake.ports, {
                afterPersistCreatedIdentity: () => { throw new Error('injected_crash_after_identity'); },
            });
            expect(crashed.steps[0]?.error).toMatch(/injected_crash_after_identity/);
            expect(fake.clones).toBe(1);
            const mid = MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!;
            expect(mid.sagaState).toBe('preparing');
            expect(mid.createdNodeId).toBeTruthy();
            expect(mid.createdWorktreePath).toBeTruthy();
            // Task is still unbound — enqueue/finalize did not land.
            expect(getQueue(id).find(t => t.id === task.id)!.targetNodeId).toBeUndefined();

            // Restart reconciler: same DB, expired-or-same lease, resume.
            const recovered = await recoverExpiredWorkspaceSagas(id, fake.ports);
            expect(recovered.steps.some(s => s.action === 'resumed_owned_worktree' || s.sagaState === 'ready')).toBe(true);
            expect(fake.clones).toBe(1);
            const ready = MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!;
            expect(ready.sagaState).toBe('ready');
            expect(getQueue(id).find(t => t.id === task.id)!.targetNodeId).toBe(ready.createdNodeId);
        } finally {
            cleanup(id);
        }
    });

    it('resumes from the owned worktree when the process dies after clone and BEFORE identity persist', async () => {
        const id = meshId('crash_before_persist');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id);
            const fake = createFakePorts();
            const crashed = await runWorkspaceSagaTick(id, fake.ports, {
                afterCloneSuccess: () => { throw new Error('injected_crash_after_clone'); },
            });
            expect(crashed.steps[0]?.error).toMatch(/injected_crash_after_clone/);
            expect(fake.clones).toBe(1);
            const mid = MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!;
            expect(mid.sagaState).toBe('preparing');
            expect(mid.createdNodeId).toBeUndefined();

            const recovered = await recoverExpiredWorkspaceSagas(id, fake.ports);
            expect(fake.clones).toBe(1);
            expect(recovered.steps[0]?.action).toBe('resumed_owned_worktree');
            expect(MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!.sagaState).toBe('ready');
        } finally {
            cleanup(id);
        }
    });

    it('takes over an expired lease with a higher fencing generation', async () => {
        const id = meshId('lease_takeover');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id);
            const fake = createFakePorts();
            const crashed = await runWorkspaceSagaTick(id, fake.ports, {
                afterPersistCreatedIdentity: () => { throw new Error('die_holding_lease'); },
            });
            expect(crashed.steps[0]?.error).toMatch(/die_holding_lease/);
            const held = MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!;
            const heldGen = held.leaseGeneration;
            expect(held.leaseOwner).toBe('workspace-saga');
            // Simulate process death: lease expires, in-memory worker is gone.
            MeshRuntimeStore.getInstance().graphStore().patchWorkspaceIntent(
                graphId, workspaceRef, { leaseExpiresAt: '2000-01-01T00:00:00.000Z' }, nowIso(),
            );
            await recoverExpiredWorkspaceSagas(id, fake.ports);
            const after = MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!;
            expect(after.sagaState).toBe('ready');
            expect(after.leaseGeneration).toBeGreaterThan(heldGen);
        } finally {
            cleanup(id);
        }
    });

    it('compensates a clean owned worktree when finalize is permanently invalid', async () => {
        const id = meshId('perm_finalize');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id);
            const fake = createFakePorts();
            const step = await runWorkspaceSagaTick(id, fake.ports, {
                beforeFinalizeReady: () => {
                    throw new WorkspaceSagaPermanentError('identity_conflict', 'conflicting node now owns the identity');
                },
            });
            expect(step.steps[0]?.action).toBe('compensated');
            expect(fake.removes).toBe(1);
            expect(fake.trees.get(workspaceRef)!.removed).toBe(true);
            expect(MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!.sagaState).toBe('compensated');
        } finally {
            cleanup(id);
        }
    });
});

// ── 3. Compensation must not delete protected worktrees ──────────────────────

describe('compensation refusals (design :994-995)', () => {
    const cases: Array<{ name: string; override: Partial<WorkspaceInspectReport> | ((tree: FakeTree) => void); refusal: string; sessions?: { sessionIds: string[]; unknown?: boolean } }> = [
        { name: 'dirty', override: tree => { tree!.dirty = true; }, refusal: 'dirty' },
        { name: 'ahead', override: tree => { tree!.ahead = true; }, refusal: 'ahead' },
        { name: 'stashed', override: tree => { tree!.stashed = true; }, refusal: 'stashed' },
        { name: 'session-bound', override: {}, refusal: 'session_bound', sessions: { sessionIds: ['sess-live'], unknown: false } },
        { name: 'unowned', override: { observedOwnerTag: 'someone-else' }, refusal: 'unowned' },
        { name: 'ambiguous', override: { ambiguous: true, ambiguityReason: 'two checkouts' }, refusal: 'ambiguous' },
    ];

    for (const c of cases) {
        it(`does not delete a ${c.name} worktree and marks compensation_required`, async () => {
            const id = meshId(`refuse_${c.name}`);
            try {
                const { graphId, workspaceRef, task } = seedGraphWithWorkspace(id);
                const fake = createFakePorts({
                    inspectOverride: tree => typeof c.override === 'function' ? {} : c.override,
                    sessions: c.sessions,
                });
                if (typeof c.override === 'function') {
                    // Prepare first so the tree exists, then mutate it dirty/ahead/stashed.
                    await runWorkspaceSagaTick(id, fake.ports);
                    c.override(fake.trees.get(workspaceRef)!);
                    const step = await compensateWorkspaceIntent(graphId, workspaceRef, fake.ports, 'graph_failed');
                    expect(step.action).toBe('compensation_required');
                    expect(step.refusals).toContain(c.refusal);
                    expect(fake.trees.get(workspaceRef)!.removed).toBe(false);
                } else {
                    const step = await runWorkspaceSagaTick(id, fake.ports, {
                        beforeFinalizeReady: () => {
                            throw new WorkspaceSagaPermanentError('identity_conflict', 'force compensate');
                        },
                    });
                    expect(step.steps[0]?.action).toBe('compensation_required');
                    expect(step.steps[0]?.refusals).toContain(c.refusal);
                    expect(fake.trees.get(workspaceRef)?.removed).not.toBe(true);
                }
                const intent = MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!;
                expect(intent.sagaState).toBe('compensation_required');
                expect(MeshRuntimeStore.getInstance().graphStore().getGraph(graphId)!.status).toBe('compensation_required');
                const entry = getQueue(id).find(t => t.id === task.id)!;
                expect(taskDependenciesSatisfied(entry, statusById(id))).toBe(false);
            } finally {
                cleanup(id);
            }
        });
    }

    it('compensation is idempotent — a second call does not invent a delete', async () => {
        const id = meshId('comp_idem');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id);
            const fake = createFakePorts();
            await runWorkspaceSagaTick(id, fake.ports);
            fake.trees.get(workspaceRef)!.dirty = true;
            const first = await compensateWorkspaceIntent(graphId, workspaceRef, fake.ports);
            const second = await compensateWorkspaceIntent(graphId, workspaceRef, fake.ports);
            expect(first.action).toBe('compensation_required');
            expect(second.sagaState).toBe('compensation_required');
            expect(fake.trees.get(workspaceRef)!.removed).toBe(false);
        } finally {
            cleanup(id);
        }
    });

    it('deletes only a clean owned worktree via the requireClean path', async () => {
        const id = meshId('comp_clean');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id);
            const fake = createFakePorts();
            await runWorkspaceSagaTick(id, fake.ports);
            const step = await compensateWorkspaceIntent(graphId, workspaceRef, fake.ports, 'graph_failed');
            expect(step.action).toBe('compensated');
            expect(fake.trees.get(workspaceRef)!.removed).toBe(true);
        } finally {
            cleanup(id);
        }
    });
});

// ── 4. Transaction boundary ──────────────────────────────────────────────────

describe('transaction boundary (design :993)', () => {
    it('never runs git/filesystem ports inside a SQLite transaction', async () => {
        const id = meshId('no_io_in_tx');
        try {
            seedGraphWithWorkspace(id);
            const store = MeshRuntimeStore.getInstance();
            let txDepth = 0;
            const inner = store.transaction.bind(store);
            vi.spyOn(store, 'transaction').mockImplementation((fn: () => unknown) => {
                txDepth += 1;
                try { return inner(fn); } finally { txDepth -= 1; }
            });
            const seen: string[] = [];
            const fake = createFakePorts();
            const wrap = <K extends keyof WorkspaceSagaPorts>(key: K) => {
                const orig = fake.ports[key] as any;
                (fake.ports as any)[key] = async (...args: unknown[]) => {
                    if (txDepth > 0) seen.push(`${key}@tx${txDepth}`);
                    return orig(...args);
                };
            };
            wrap('createWorktree');
            wrap('findOwnedWorktree');
            wrap('inspectWorktree');
            wrap('removeWorktree');
            await runWorkspaceSagaTick(id, fake.ports);
            expect(seen).toEqual([]);
        } finally {
            cleanup(id);
        }
    });
});

// ── 5. Real-git dirty worktree must survive compensation ─────────────────────

describe('real-git compensation pin', () => {
    function initRepo(): { repo: string; worktree: string } {
        const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'adhdev-gws-repo-')));
        realGitRoots.push(repo);
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 'ADHDev Test'], { cwd: repo });
        fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
        execFileSync('git', ['add', 'README.md'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });
        const worktree = path.join(repo, '.worktrees', 'fix');
        fs.mkdirSync(path.dirname(worktree), { recursive: true });
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'graph-fix', worktree, 'main'], { cwd: repo });
        return { repo, worktree };
    }

    it('does not delete a dirty real worktree during compensation', async () => {
        const id = meshId('real_dirty');
        const { worktree } = initRepo();
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id);
            const fake = createFakePorts();
            await runWorkspaceSagaTick(id, fake.ports);
            const intent = MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!;
            // Point the intent at the REAL dirty checkout and stamp the saga owner tag.
            execFileSync('git', ['config', 'adhdev.workspaceOwner', intent.ownerTag!], { cwd: worktree });
            fs.writeFileSync(path.join(worktree, 'WIP.md'), 'uncommitted work that must survive\n');
            MeshRuntimeStore.getInstance().graphStore().patchWorkspaceIntent(
                graphId, workspaceRef, { createdWorktreePath: worktree }, nowIso(),
            );

            const { createDefaultWorkspaceSagaPorts } = await import('../../src/mesh/mesh-graph-workspace-ports.js');
            meshConfigMocks.getMesh.mockReturnValue({
                id, name: 'test', nodes: [{ id: 'local-base', workspace: path.dirname(worktree), repoRoot: path.dirname(worktree) }],
            });
            // Use default inspect (real git) + a remove port that would delete if asked.
            const defaults = createDefaultWorkspaceSagaPorts();
            let removeCalled = false;
            const ports: WorkspaceSagaPorts = {
                ...defaults,
                nowMs: () => Date.now(),
                listLiveSessionsOnNode: async () => ({ sessionIds: [], unknown: false }),
                listAssignedTasksOnNode: async () => [],
                removeWorktree: async req => {
                    removeCalled = true;
                    return defaults.removeWorktree(req);
                },
            };
            const step = await compensateWorkspaceIntent(graphId, workspaceRef, ports, 'graph_failed');
            expect(step.action).toBe('compensation_required');
            expect(step.refusals).toContain('dirty');
            expect(removeCalled).toBe(false);
            expect(fs.existsSync(worktree)).toBe(true);
            expect(fs.existsSync(path.join(worktree, 'WIP.md'))).toBe(true);
        } finally {
            cleanup(id);
        }
    });
});

// ── 6. Classifier injection guard (must go red if dirty check is removed) ────

describe('injection guard — dirty refusal is load-bearing', () => {
    it('classifyWorkspaceCompensationSafety refuses dirty; a missing dirty check would admit delete', () => {
        const dirty = classifyWorkspaceCompensationSafety({
            expectedOwnerTag: 't',
            inspect: { pathExists: true, observedOwnerTag: 't', dirty: true, ahead: false, stashed: false, sessionBound: false },
        });
        expect(dirty.deletable).toBe(false);
        expect(dirty.refusals).toContain('dirty');
        const clean = classifyWorkspaceCompensationSafety({
            expectedOwnerTag: 't',
            inspect: { pathExists: true, observedOwnerTag: 't', dirty: false, ahead: false, stashed: false, sessionBound: false },
        });
        expect(clean.deletable).toBe(true);
    });
});

// Keep rematerialize imported so a future tree-shake/lint does not drop the
// activation integration from the test module graph.
void rematerializePendingGraphNodesForWorkspace;
void commitTaskTerminalAndAdvanceGraph;
