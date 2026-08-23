import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// CANCEL-GRAPH-ROLLUP — a cancel is a terminal acceptance and must roll the graph.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :311-334 — ONE terminal entry point (commitTaskTerminalAndAdvanceGraph).
//     :522-538 — on_dependency_failure ∈ {block, cancel}: `block` derives the hold
//                from predecessor status (retry recovers); `cancel` is an explicit
//                terminal cascade.
//
//   THE DEFECT this file pins (pre-fix behaviour, reproduced by reverting the
//   `commitTaskTerminalAndAdvanceGraph({ ... status: 'cancelled' ... })` call in
//   cancelTask back to an inline `entry.status = 'cancelled'`):
//
//     cancelTask wrote the queue row terminal INLINE, bypassing the choke point.
//     The backing graph node therefore stayed `declared`/`materialized` forever and
//     `classifyGraphRollup` — which returns null while ANY worker node is unsettled —
//     could never roll the graph. Measured pre-fix on a one-node graph:
//         queue='cancelled', node='declared', graph='active', outputs=0
//     versus the failure path on the same fixture:
//         queue='failed',    node='failed',   graph='failed',  outputs=1
//
//     The user-visible consequence is workspace cleanup: `cleanupOnGraphFailure`
//     (mesh-graph-workspace-saga.ts) fires on `graph.status === 'failed' |
//     'cancelled' | 'compensation_required'`, so a cancelled branch's workspace was
//     STRUCTURALLY unreachable for collection — the saga never terminated.
//
//   OVER-CORRECTION GUARDS (the reason this file is not just one assertion): making
//   cancel roll the graph must NOT make it advance downstream work. Two invariants
//   are pinned below — `block` still lets a retry recover dependents, and `cancel`
//   still terminalizes them — because a cancel that wrongly RELEASES successors is a
//   far worse defect than the one being fixed.

const testTmpDir = path.join(tmpdir(), `adhdev-cancel-rollup-${randomUUID().slice(0, 8)}`);
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

import * as graphRunner from '../../src/mesh/mesh-graph-transition-runner.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    cancelTask,
    enqueueTask,
    getQueue,
    updateTaskStatus,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { MeshTaskGraphEdgeRow, MeshTaskGraphNodeRow } from '../../src/mesh/mesh-graph-types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MESH_SRC_DIR = path.resolve(HERE, '../../src/mesh');

function meshId(tag: string): string {
    return `mesh_cancelrollup_${tag}_${randomUUID().slice(0, 8)}`;
}

function nowIso(): string {
    return new Date().toISOString();
}

function cleanup(id: string) {
    __clearMeshQueueForTests(id);
    __resetMeshRuntimeStoreForTests();
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

/**
 * A --requires--> B over two real queue rows. `graphPolicy` is the GRAPH's own
 * policy (graph.policyJson), which is the axis the runner's cascade reads; the
 * queue-side sibling cascade reads mesh config, mocked separately per test.
 */
function buildTwoNodeGraph(mesh: string, opts?: { graphPolicy?: 'block' | 'cancel' }) {
    const taskA = enqueue(mesh, 'do A');
    const taskB = enqueue(mesh, 'do B', { dependsOn: [taskA.id] });
    const gs = MeshRuntimeStore.getInstance().graphStore();
    const graphId = randomUUID();
    const nodeA = randomUUID();
    const nodeB = randomUUID();
    const now = nowIso();
    gs.insertGraph({
        graphId, meshId: mesh, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: 'active', taskCount: 2, gateCount: 0, workspaceCount: 0, dependencyEdgeCount: 1,
        policyJson: JSON.stringify(opts?.graphPolicy ? { on_dependency_failure: opts.graphPolicy } : {}),
        createdAt: now, updatedAt: now,
    });
    const nodeRow = (nodeId: string, ref: string, queueTaskId: string, message: string): MeshTaskGraphNodeRow => ({
        graphId, nodeId, meshId: mesh, ref, kind: 'worker_task', queueTaskId,
        state: 'declared', baseSpecJson: JSON.stringify({ message }), materializationVersion: 0,
        createdAt: now, updatedAt: now,
    });
    gs.insertNode(nodeRow(nodeA, 'a', taskA.id, 'do A'));
    gs.insertNode(nodeRow(nodeB, 'b', taskB.id, 'do B'));
    const edge: MeshTaskGraphEdgeRow = {
        graphId, meshId: mesh, fromNodeId: nodeA, toNodeId: nodeB,
        kind: 'requires', omitOnSkip: false, createdAt: now,
    };
    gs.insertEdge(edge);
    return { graphId, nodeA, nodeB, taskA, taskB };
}

/** Single-node graph — the minimal fixture for the rollup itself. */
function buildOneNodeGraph(mesh: string) {
    const taskA = enqueue(mesh, 'do A');
    const gs = MeshRuntimeStore.getInstance().graphStore();
    const graphId = randomUUID();
    const nodeA = randomUUID();
    const now = nowIso();
    gs.insertGraph({
        graphId, meshId: mesh, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: 'active', taskCount: 1, gateCount: 0, workspaceCount: 0, dependencyEdgeCount: 0,
        policyJson: '{}', createdAt: now, updatedAt: now,
    });
    gs.insertNode({
        graphId, nodeId: nodeA, meshId: mesh, ref: 'a', kind: 'worker_task', queueTaskId: taskA.id,
        state: 'declared', baseSpecJson: JSON.stringify({ message: 'do A' }), materializationVersion: 0,
        createdAt: now, updatedAt: now,
    });
    return { graphId, nodeA, taskA };
}

const node = (graphId: string, nodeId: string) =>
    MeshRuntimeStore.getInstance().graphStore().listNodes(graphId).find(n => n.nodeId === nodeId)!;
const graphStatus = (graphId: string) =>
    MeshRuntimeStore.getInstance().graphStore().getGraph(graphId)?.status;

// ── 1. THE DEFECT: cancel rolls node + graph, exactly like failure ────────────

describe('cancelTask rolls the graph (injection guard)', () => {
    it('a cancelled task settles its graph node and rolls the graph to cancelled', () => {
        const id = meshId('rolls');
        try {
            const { graphId, nodeA, taskA } = buildOneNodeGraph(id);
            // Pre-state: nothing settled.
            expect(node(graphId, nodeA).state).toBe('declared');
            expect(graphStatus(graphId)).toBe('active');

            const cancelled = cancelTask(id, taskA.id, { reason: 'operator_cancel' });

            expect(cancelled?.status).toBe('cancelled');
            // ★ Reverting cancelTask to an inline `entry.status = 'cancelled'` turns
            //   these three into 'declared' / 'active' / 0 — the pre-fix measurement.
            expect(node(graphId, nodeA).state).toBe('cancelled');
            expect(graphStatus(graphId)).toBe('cancelled');
            expect(MeshRuntimeStore.getInstance().graphStore().getLatestOutput(taskA.id)?.version).toBe(1);
        } finally {
            cleanup(id);
        }
    });

    it('cancel reaches the graph through the SAME choke point as completion/failure', () => {
        const id = meshId('chokepoint');
        try {
            const { taskA } = buildOneNodeGraph(id);
            const spy = vi.spyOn(graphRunner, 'commitTaskTerminalAndAdvanceGraph');
            cancelTask(id, taskA.id, { reason: 'operator_cancel' });
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy.mock.calls[0][0]).toMatchObject({
                meshId: id, taskId: taskA.id, status: 'cancelled', source: 'cancellation',
                reason: 'operator_cancel',
            });
        } finally {
            cleanup(id);
        }
    });

    it('the failure path is untouched — same rollup, unchanged provenance', () => {
        const id = meshId('failure_parity');
        try {
            const { graphId, nodeA, taskA } = buildOneNodeGraph(id);
            const spy = vi.spyOn(graphRunner, 'commitTaskTerminalAndAdvanceGraph');
            updateTaskStatus(id, taskA.id, 'failed');
            expect(node(graphId, nodeA).state).toBe('failed');
            expect(graphStatus(graphId)).toBe('failed');
            // Failure still routes with its own source — the fix added a caller, it
            // did not rewrite the existing ones.
            expect(spy.mock.calls[0][0]).toMatchObject({ status: 'failed', source: 'stall_reconcile' });
        } finally {
            cleanup(id);
        }
    });

    it('cancelling a task with no backing graph node still works (legacy path)', () => {
        const id = meshId('legacy');
        try {
            const task = enqueue(id, 'ungraphed work');
            const cancelled = cancelTask(id, task.id, { reason: 'operator_cancel' });
            expect(cancelled?.status).toBe('cancelled');
            expect(getQueue(id).find(t => t.id === task.id)?.status).toBe('cancelled');
        } finally {
            cleanup(id);
        }
    });
});

// ── 2. CANCEL BOOKKEEPING SURVIVES the choke point ────────────────────────────

describe('cancel-specific bookkeeping is preserved through the choke point', () => {
    it('cancelledAt / cancelReason / cleared assignment / bumped nonce all persist', () => {
        const id = meshId('bookkeeping');
        try {
            const { taskA } = buildOneNodeGraph(id);
            const before = getQueue(id).find(t => t.id === taskA.id)!;
            MeshRuntimeStore.getInstance().updateQueueEntry({
                ...before, status: 'assigned', assignedNodeId: 'node_main',
                assignedSessionId: 'sess-cancel', assignedProviderType: 'claude',
                dispatchNonce: 3, updatedAt: nowIso(),
            } as any);

            const cancelled = cancelTask(id, taskA.id, { reason: 'operator_cancel' });

            // The runner re-reads and re-writes the row; none of the cancel's own
            // fields may be clobbered by that flip.
            expect(cancelled?.status).toBe('cancelled');
            expect(cancelled?.cancelledAt).toBeTruthy();
            expect(cancelled?.cancelReason).toBe('operator_cancel');
            expect(cancelled?.assignedSessionId).toBeUndefined();
            expect(cancelled?.assignedNodeId).toBeUndefined();
            expect(cancelled?.assignedProviderType).toBeUndefined();
            expect(cancelled?.dispatchNonce).toBe(4);

            // And they are PERSISTED, not just present on the returned object.
            const persisted = getQueue(id).find(t => t.id === taskA.id)!;
            expect(persisted.status).toBe('cancelled');
            expect(persisted.cancelReason).toBe('operator_cancel');
            expect(persisted.assignedSessionId).toBeUndefined();
        } finally {
            cleanup(id);
        }
    });

    it('the prior assignment is still surfaced so the caller can stop the live worker', async () => {
        const id = meshId('prior_assignment');
        try {
            const { taskA } = buildOneNodeGraph(id);
            const before = getQueue(id).find(t => t.id === taskA.id)!;
            MeshRuntimeStore.getInstance().updateQueueEntry({
                ...before, status: 'assigned', assignedNodeId: 'node_main',
                assignedSessionId: 'sess-live', assignedProviderType: 'claude', updatedAt: nowIso(),
            } as any);

            cancelTask(id, taskA.id, { reason: 'operator_cancel' });

            const { takeCancelledTaskAssignment } = await import('../../src/mesh/mesh-work-queue.js');
            expect(takeCancelledTaskAssignment(id, taskA.id)).toEqual({
                sessionId: 'sess-live', nodeId: 'node_main', providerType: 'claude',
            });
        } finally {
            cleanup(id);
        }
    });
});

// ── 3. OVER-CORRECTION GUARDS: cancel must not advance downstream work ────────

describe('over-correction guards — cancel settles, it does not release successors', () => {
    it('under `block`, a cancel leaves the dependent PENDING and a retry recovers it', () => {
        const id = meshId('block_recovers');
        try {
            // Default policy is `block` on both axes (graph policyJson empty, mesh
            // config absent → resolveDependencyFailurePolicy falls back to 'block').
            meshConfigMocks.getMesh.mockReturnValue({ policy: {} } as any);
            const { graphId, nodeA, nodeB, taskA, taskB } = buildTwoNodeGraph(id, { graphPolicy: 'block' });

            cancelTask(id, taskA.id, { reason: 'operator_cancel' });

            // A settles; B is NOT cancelled and NOT materialized — it just waits.
            expect(node(graphId, nodeA).state).toBe('cancelled');
            expect(node(graphId, nodeB).state).toBe('declared');
            expect(getQueue(id).find(t => t.id === taskB.id)?.status).toBe('pending');
            // Under `block` a non-terminal dependent leaves the graph unrolled — the
            // retry can still recover, so the graph must NOT be declared cancelled.
            expect(graphStatus(graphId)).toBe('active');

            // ★ THE RECOVERY INVARIANT: retrying the cancelled predecessor releases B
            //   exactly as it would have before this change.
            updateTaskStatus(id, taskA.id, 'completed', { force: true } as any);
            expect(node(graphId, nodeA).state).toBe('completed');
            expect(getQueue(id).find(t => t.id === taskB.id)?.status).toBe('pending');
            expect(node(graphId, nodeB).state).not.toBe('cancelled');
        } finally {
            cleanup(id);
        }
    });

    it('under `cancel`, a cancel still terminalizes the dependent subtree', () => {
        const id = meshId('cancel_cascades');
        try {
            meshConfigMocks.getMesh.mockReturnValue({ policy: { onDependencyFailure: 'cancel' } } as any);
            const { graphId, nodeA, nodeB, taskA, taskB } = buildTwoNodeGraph(id, { graphPolicy: 'cancel' });

            cancelTask(id, taskA.id, { reason: 'operator_cancel' });

            expect(node(graphId, nodeA).state).toBe('cancelled');
            // ★ THE CASCADE INVARIANT: `cancel` still closes the branch, both on the
            //   graph node and on its queue placeholder.
            expect(node(graphId, nodeB).state).toBe('cancelled');
            expect(getQueue(id).find(t => t.id === taskB.id)?.status).toBe('cancelled');
            // Everything settled → the graph rolls, which is what makes the workspace
            // saga's cleanupOnGraphFailure reachable at all.
            expect(graphStatus(graphId)).toBe('cancelled');
        } finally {
            cleanup(id);
        }
    });

    it('cancel never materializes a downstream node (a cancel is not a completion)', () => {
        const id = meshId('no_materialize');
        try {
            meshConfigMocks.getMesh.mockReturnValue({ policy: {} } as any);
            const { graphId, nodeB, taskA, taskB } = buildTwoNodeGraph(id, { graphPolicy: 'block' });
            const beforeVersion = node(graphId, nodeB).materializationVersion;

            cancelTask(id, taskA.id, { reason: 'operator_cancel' });

            // The materialization frontier is walked ONLY for `completed` (runner
            // step 5). A cancel must never hand downstream work its inputs.
            expect(node(graphId, nodeB).materializationVersion).toBe(beforeVersion);
            expect(node(graphId, nodeB).state).toBe('declared');
            expect(MeshRuntimeStore.getInstance().graphStore().getLatestOutput(taskB.id)).toBeFalsy();
        } finally {
            cleanup(id);
        }
    });
});

// ── 4. STRUCTURAL PIN: cancel may not regrow an inline terminal write ─────────

describe('structural pin — cancelTask has no inline terminal write', () => {
    it('cancelTask delegates its terminal flip instead of assigning entry.status', () => {
        const src = fs.readFileSync(path.join(MESH_SRC_DIR, 'mesh-work-queue.ts'), 'utf8');
        const fn = src.slice(src.indexOf('export function cancelTask'));
        const body = fn.slice(0, fn.indexOf('\n}\n'));
        // The choke-point call is present...
        expect(body).toMatch(/commitTaskTerminalAndAdvanceGraph\(\{/);
        // ...and the inline write that bypassed the graph is gone. Restoring
        // `entry.status = 'cancelled'` here reintroduces the stuck-graph defect.
        expect(body).not.toMatch(/entry\.status\s*=\s*'cancelled'/);
    });
});
