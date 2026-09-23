import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// GRAPH-ORCHESTRATION Phase D — a workspace saga that reached a TERMINAL state
// (`failed` / `compensated` / `compensation_required`) must not leave the nodes
// that named it parked forever.
//
// The defect this file pins: `resolveWorkspaceRefForMaterialize` collapsed every
// `sagaState !== 'ready'` into the single `unresolved` verdict, which
// `settleDownstreamNode` reads as "keep waiting". A workspace that can NEVER
// become ready is indistinguishable from one that is still preparing, so the
// downstream node re-defers on every tick, forever — observed live as an
// `inputs_from` node stuck `pending` after its worktree was lost.
//
// ★ These tests assert the PROPERTY — "a node whose workspace is permanently
// dead reaches a terminal node state within a bounded number of settle
// attempts" — not the proxy "the function returns a particular string". The
// bounded-attempts loop is what makes "permanently deferred" falsifiable: a
// proxy assertion on the return value would still pass if the consumer ignored
// the new verdict.

const testTmpDir = path.join(tmpdir(), `adhdev-graph-ws-terminal-${randomUUID().slice(0, 8)}`);
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

// Records what the sweep queues. A recording spy only — it seeds nothing and
// stabilizes no identity, so it cannot mask the behaviour under test.
const queuedEvents = vi.hoisted(() => ({ events: [] as any[] }));
vi.mock('../../src/mesh/turn-ledger/deliver.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/mesh/turn-ledger/deliver.js')>();
    return {
        ...actual,
        notifyMeshCoordinator: vi.fn((event: any) => {
            queuedEvents.events.push(event);
            return true;
        }),
    };
});

import {
    graphMaterializationBlockReason,
    settleDownstreamNode,
    __resetMeshGraphTransitionRunnerForTests,
} from '../../src/mesh/mesh-graph-transition-runner.js';
import { sweepMeshGraphStaleness } from '../../src/mesh/mesh-graph-staleness.js';
import {
    declareWorkspaceIntents,
    runWorkspaceSagaTick,
} from '../../src/mesh/mesh-graph-workspace-saga.js';
import type { WorkspaceSagaPorts } from '../../src/mesh/mesh-graph-workspace-ports.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    enqueueTask,
    getQueue,
    taskDependenciesSatisfied,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { MeshGraphWorkspaceSagaState, MeshTaskGraphNodeRow } from '../../src/mesh/mesh-graph-types.js';

/** Node states from which a node can never advance on its own. */
const TERMINAL_NODE_STATES = ['completed', 'failed', 'cancelled', 'skipped'] as const;

/** How many settle attempts a permanently-dead workspace may consume. */
const SETTLE_ATTEMPT_BUDGET = 5;

function meshId(tag: string): string {
    return `mesh_wsterm_${tag}_${randomUUID().slice(0, 8)}`;
}

function nowIso(): string {
    return new Date().toISOString();
}

function cleanup(id: string) {
    __clearMeshQueueForTests(id);
    __resetMeshRuntimeStoreForTests();
    __resetMeshGraphTransitionRunnerForTests();
    meshConfigMocks.getMesh.mockReset();
    queuedEvents.events.length = 0;
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

function enqueue(mesh: string, message: string) {
    return enqueueTask(mesh, message, { taskMode: 'code_change', difficulty: 'medium' } as any);
}

/**
 * Ports that always fail the clone — the shortest route to a `failed` intent.
 * `removeWorktree` reports success so the compensation variants below can reach
 * `compensated` without inventing a real tree.
 */
function createFakePorts(opts?: {
    failClone?: Error;
    dirty?: boolean;
    pathExists?: boolean;
}): WorkspaceSagaPorts {
    const trees = new Map<string, { nodeId: string; worktreePath: string; ownerTag: string; removed: boolean }>();
    return {
        nowMs: () => Date.now(),
        resolveBaseRevision: async () => undefined,
        createWorktree: async req => {
            if (opts?.failClone) throw opts.failClone;
            const tree = {
                nodeId: `node_ws_${req.workspaceRef}`,
                worktreePath: req.desiredPath || `/tmp/fake-ws/${req.graphId}/${req.workspaceRef}`,
                ownerTag: req.ownerTag,
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
            if (!tree || tree.removed) {
                return { pathExists: false, dirty: false, ahead: false, stashed: false, sessionBound: false };
            }
            return {
                pathExists: opts?.pathExists ?? true,
                observedOwnerTag: tree.ownerTag,
                dirty: opts?.dirty === true,
                ahead: false,
                stashed: false,
                sessionBound: false,
            };
        },
        removeWorktree: async req => {
            const tree = [...trees.values()].find(t => t.worktreePath === req.worktreePath);
            if (tree) tree.removed = true;
            return { removed: true };
        },
        listLiveSessionsOnNode: async () => ({ sessionIds: [], unknown: false }),
        listAssignedTasksOnNode: async () => [],
        registerNode: async () => true,
        unregisterNode: async () => true,
    };
}

/**
 * One worker node (`fix`) naming one workspace_ref, already held by the graph
 * materialization block the production commit path applies. No upstream edges,
 * so `settleDownstreamNode` reaches the workspace step immediately — the
 * workspace is the ONLY thing standing between this node and materialization.
 */
function seedGraphWithWorkspace(mesh: string) {
    const workspaceRef = 'fix_workspace';
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
    const entry = getQueue(mesh).find(t => t.id === task.id)!;
    MeshRuntimeStore.getInstance().updateQueueEntry({
        ...entry, blockedReason: graphMaterializationBlockReason(nodeId, 0), updatedAt: now,
    } as any);
    declareWorkspaceIntents({
        graphId, meshId: mesh,
        workspaces: [{
            ref: workspaceRef,
            source_node_id: 'local-base',
            purpose: 'terminal-saga-fix',
            base_revision: 'main',
            cleanup_on_graph_failure: true,
        }],
    });
    return { graphId, nodeId, task, workspaceRef };
}

/**
 * Drive the real production settle path repeatedly, exactly as the reconcile
 * loop would, and report how the node ended up.
 *
 * This is the property harness: "permanently deferred" means the node is STILL
 * non-terminal after every attempt in the budget. A fix that merely renames the
 * binding verdict without changing what the consumer does would leave
 * `attemptsUsed === budget` and `terminal === false`, and fail here.
 */
function settleUntilTerminal(graphId: string, nodeId: string, meshIdValue: string): {
    terminal: boolean;
    finalState: string;
    attemptsUsed: number;
    outcomes: string[];
} {
    const store = MeshRuntimeStore.getInstance();
    const outcomes: string[] = [];
    let attemptsUsed = 0;
    for (let i = 0; i < SETTLE_ATTEMPT_BUDGET; i++) {
        attemptsUsed += 1;
        const gs = store.graphStore();
        const nodes = gs.listNodes(graphId);
        const edges = gs.listEdges(graphId);
        const byId = new Map(nodes.map(n => [n.nodeId, n]));
        const target = gs.getNode(graphId, nodeId)!;
        const outcome = settleDownstreamNode(store, target, edges, byId, nowIso());
        outcomes.push(outcome.kind === 'error' ? `error:${outcome.blockedReason}` : outcome.kind);
        const state = store.graphStore().getNode(graphId, nodeId)!.state;
        if ((TERMINAL_NODE_STATES as readonly string[]).includes(state)) {
            return { terminal: true, finalState: state, attemptsUsed, outcomes };
        }
    }
    return {
        terminal: false,
        finalState: store.graphStore().getNode(graphId, nodeId)!.state,
        attemptsUsed,
        outcomes,
    };
}

/** Force an intent into a terminal saga state without running the whole saga. */
function forceIntentState(graphId: string, workspaceRef: string, sagaState: MeshGraphWorkspaceSagaState, opts?: {
    createdNodeId?: string;
    lastError?: string;
}) {
    const store = MeshRuntimeStore.getInstance();
    store.transaction(() => {
        store.graphStore().patchWorkspaceIntent(graphId, workspaceRef, {
            sagaState,
            ...(opts?.createdNodeId ? { createdNodeId: opts.createdNodeId } : {}),
            ...(opts?.lastError ? { lastError: opts.lastError } : {}),
        }, nowIso());
    });
}

// ── The property: terminal saga ⇒ bounded, terminal node ─────────────────────

describe('a terminal workspace saga does not park its nodes forever', () => {
    const terminalStates: MeshGraphWorkspaceSagaState[] = ['failed', 'compensated', 'compensation_required'];

    for (const sagaState of terminalStates) {
        it(`a node whose workspace saga is '${sagaState}' reaches a terminal node state within ${SETTLE_ATTEMPT_BUDGET} settle attempts`, () => {
            const id = meshId(`term_${sagaState}`);
            try {
                const { graphId, nodeId, workspaceRef, task } = seedGraphWithWorkspace(id);
                forceIntentState(graphId, workspaceRef, sagaState, {
                    lastError: `${sagaState}: the worktree can never become ready`,
                });

                const outcome = settleUntilTerminal(graphId, nodeId, id);

                // ★ THE PROPERTY. Before the fix this is false and
                // attemptsUsed === SETTLE_ATTEMPT_BUDGET with every outcome
                // 'deferred' — the node defers forever.
                expect(outcome.terminal,
                    `node stayed '${outcome.finalState}' after ${outcome.attemptsUsed} settle attempts `
                    + `(outcomes: ${outcome.outcomes.join(', ')}) — a '${sagaState}' workspace can never become `
                    + 'ready, so deferring again is deferring forever').toBe(true);
                expect(outcome.finalState).toBe('failed');

                // The queue placeholder must not stay claimable-pending either:
                // a task waiting on a dead worktree is dead work, not queued work.
                const entry = getQueue(id).find(t => t.id === task.id)!;
                expect(entry.status).toBe('cancelled');
                expect(taskDependenciesSatisfied(entry, new Map(getQueue(id).map(t => [t.id, t.status])))).toBe(false);
            } finally {
                cleanup(id);
            }
        });
    }

    it('the failure reason names the workspace and its saga state — not a generic materialization error', () => {
        const id = meshId('reason');
        try {
            const { graphId, nodeId, workspaceRef, task } = seedGraphWithWorkspace(id);
            forceIntentState(graphId, workspaceRef, 'compensation_required', {
                createdNodeId: 'node_ws_fix_workspace',
                lastError: JSON.stringify({ code: 'compensation_required', refusals: ['dirty'] }),
            });

            settleUntilTerminal(graphId, nodeId, id);

            const node = MeshRuntimeStore.getInstance().graphStore().getNode(graphId, nodeId)!;
            // An operator reading this must be able to tell WHICH workspace died
            // and HOW, without cross-referencing the intent table by hand.
            expect(node.failureReason).toContain(workspaceRef);
            expect(node.failureReason).toContain('compensation_required');
            const entry = getQueue(id).find(t => t.id === task.id)!;
            expect(entry.blockedReason).toContain('workspace_');
        } finally {
            cleanup(id);
        }
    });

    it('a still-preparing workspace is NOT failed — the fix must not swallow the legitimate wait', () => {
        const id = meshId('preparing');
        try {
            const { graphId, nodeId, workspaceRef, task } = seedGraphWithWorkspace(id);
            forceIntentState(graphId, workspaceRef, 'preparing');

            const outcome = settleUntilTerminal(graphId, nodeId, id);

            // The over-correction guard: 'preparing' can still become ready, so
            // the node MUST keep deferring. If this goes red, the fix turned a
            // normal wait into a spurious failure.
            expect(outcome.terminal).toBe(false);
            expect(outcome.outcomes.every(o => o === 'deferred')).toBe(true);
            expect(MeshRuntimeStore.getInstance().graphStore().getNode(graphId, nodeId)!.state).toBe('blocked');
            const entry = getQueue(id).find(t => t.id === task.id)!;
            expect(entry.status).toBe('pending');
            expect(entry.blockedReason).toMatch(/^graph_materialization_pending:/);
        } finally {
            cleanup(id);
        }
    });

    it('a declared workspace with no base revision keeps deferring — declared is not terminal', () => {
        const id = meshId('declared');
        try {
            const { graphId, nodeId, workspaceRef } = seedGraphWithWorkspace(id);
            forceIntentState(graphId, workspaceRef, 'declared');

            const outcome = settleUntilTerminal(graphId, nodeId, id);

            expect(outcome.terminal).toBe(false);
            expect(MeshRuntimeStore.getInstance().graphStore().getNode(graphId, nodeId)!.state).toBe('blocked');
        } finally {
            cleanup(id);
        }
    });
});

// ── G3 staleness sweep: is the reminder actionable? ─────────────────────────

describe('staleness sweep names the dead workspace and how to fix it', () => {
    it('a stale graph with a dead workspace gets remediation, not just "inspect it"', () => {
        const id = meshId('stale_advice');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id);
            const store = MeshRuntimeStore.getInstance();
            // The sweep only considers active/waiting_gate graphs.
            const longAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
            store.transaction(() => {
                store.graphStore().updateGraphStatus(graphId, 'active', longAgo);
            });
            forceIntentState(graphId, workspaceRef, 'compensation_required', {
                lastError: JSON.stringify({ code: 'compensation_required', refusals: ['dirty'] }),
            });

            const result = sweepMeshGraphStaleness(id, { nowMs: Date.now() });
            expect(result.staleGraphs).toBe(1);
            expect(result.remindersQueued).toBe(1);

            const queued = queuedEvents.events
                .filter(e => e.event === 'mesh:graph_stale');
            expect(queued).toHaveLength(1);
            const message = String(queued[0]?.coordinatorMessage ?? '');

            // ★ The property: the reminder must let a coordinator ACT. Before
            // this change it said only "Inspect with mesh_graph_view" — which
            // cannot revive a worktree — and never mentioned the workspace at all.
            expect(message).toContain(workspaceRef);
            expect(message).toContain('compensation_required');
            expect(message).toMatch(/remove it manually|re-enqueue/);
            // And it must say the affected tasks are already dead, so the
            // coordinator does not sit waiting for them.
            expect(message).toContain('will not recover on their own');
            expect(queued[0]?.metadataEvent?.deadWorkspaceRefs).toEqual([workspaceRef]);
        } finally {
            cleanup(id);
        }
    });

    it('a stale graph with only healthy workspaces gets no dead-workspace noise', () => {
        const id = meshId('stale_clean');
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(id);
            const store = MeshRuntimeStore.getInstance();
            const longAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
            store.transaction(() => {
                store.graphStore().updateGraphStatus(graphId, 'active', longAgo);
            });
            forceIntentState(graphId, workspaceRef, 'preparing');

            sweepMeshGraphStaleness(id, { nowMs: Date.now() });
            const queued = queuedEvents.events
                .filter(e => e.event === 'mesh:graph_stale');
            const message = String(queued[0]?.coordinatorMessage ?? '');
            // Over-correction guard: a preparing workspace is not dead.
            expect(message).not.toContain('Dead workspaces');
            expect(queued[0]?.metadataEvent?.deadWorkspaceRefs).toEqual([]);
        } finally {
            cleanup(id);
        }
    });
});

// ── End-to-end through the real saga, not a forced intent row ────────────────

describe('end-to-end: a clone failure terminates the downstream node', () => {
    it('a failing clone leaves the node failed rather than pending forever', async () => {
        const id = meshId('e2e_clone_fail');
        try {
            const { graphId, nodeId, workspaceRef, task } = seedGraphWithWorkspace(id);
            const ports = createFakePorts({ failClone: new Error('disk full: clone refused') });

            // The real saga drives the intent to `failed` — no hand-written row.
            const tick = await runWorkspaceSagaTick(id, ports);
            expect(tick.steps[0]?.sagaState).toBe('failed');
            expect(MeshRuntimeStore.getInstance().graphStore()
                .getWorkspaceIntent(graphId, workspaceRef)!.sagaState).toBe('failed');

            const outcome = settleUntilTerminal(graphId, nodeId, id);

            expect(outcome.terminal,
                `node stayed '${outcome.finalState}' after a REAL clone failure `
                + `(outcomes: ${outcome.outcomes.join(', ')})`).toBe(true);
            expect(outcome.finalState).toBe('failed');
            const entry = getQueue(id).find(t => t.id === task.id)!;
            expect(entry.status).toBe('cancelled');
        } finally {
            cleanup(id);
        }
    });
});
