import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

// GRAPH-ORCHESTRATION Phase C3 — derived failure + public policy
// (design docs/design/2026-08-18-graph-orchestration-full.md :513-565, :336-369).
//
// Pins:
//   1. `block` (default) does NOT write dependency_failed:* — views derive it.
//   2. Predecessor fail→retry→success unblocks the dependent without requeueing it.
//   3. `cancel` terminally cascades and is not revived by predecessor retry.
//   4. Skip (run_if) and failure propagate as DISTINCT public states.
//   5. dependsOn is never stripped on failure (M-TERMINAL-ADMISSION-GATE).
//   6. Invalid on_dependency_failure fails validation instead of becoming block.
//   7. Legacy dependency_failed:<taskId> markers migrate; other blocks stay.

const testTmpDir = join(tmpdir(), `adhdev-graph-c3-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

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
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    claimNextTask,
    describeTaskDependencyState,
    enqueueTask,
    getQueue,
    requeueTask,
    updateTaskStatus,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { __resetMeshGraphTransitionRunnerForTests } from '../../src/mesh/mesh-graph-transition-runner.js';
import {
    applyGraphCancelCascade,
    classifyGraphRollup,
    deriveDependencyFailures,
    isGraphSkipPlaceholder,
    isLegacyDependencyFailedBlock,
    MESH_ON_DEPENDENCY_FAILURE_PUBLIC_TEXT,
    MeshGraphPolicyError,
    migrateLegacyDependencyFailedQueueBlocks,
    parseGraphPolicy,
    parseLegacyDependencyFailedPredecessor,
    parseOnDependencyFailurePolicy,
    projectGraphPublicPolicy,
    serializeGraphPolicy,
} from '../../src/mesh/mesh-graph-derived-failure.js';
import { mergeAndNormalizePolicy, DEFAULT_MESH_POLICY } from '../../src/repo-mesh-types.js';
import type { MeshTaskGraphEdgeRow, MeshTaskGraphNodeRow } from '../../src/mesh/mesh-graph-types.js';

function meshId(tag: string): string {
    return `mesh_graphc3_${tag}_${randomUUID().slice(0, 8)}`;
}

function nowIso(): string {
    return new Date().toISOString();
}

function enqueue(mesh: string, message: string, opts: Record<string, unknown> = {}) {
    return enqueueTask(mesh, message, { taskMode: 'code_change', difficulty: 'medium', ...opts } as any);
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

function buildTwoNodeGraph(mesh: string, opts?: {
    policy?: 'block' | 'cancel';
    bRunIf?: Record<string, unknown>;
    bDependsOn?: boolean;
}) {
    const taskA = enqueue(mesh, 'do A');
    const taskB = enqueue(mesh, 'placeholder B', opts?.bDependsOn === false ? {} : { dependsOn: [taskA.id] });
    const gs = MeshRuntimeStore.getInstance().graphStore();
    const graphId = randomUUID();
    const nodeA = randomUUID();
    const nodeB = randomUUID();
    const now = nowIso();
    gs.insertGraph({
        graphId, meshId: mesh, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: 'active', taskCount: 2, gateCount: 0, workspaceCount: 0, dependencyEdgeCount: 1,
        policyJson: serializeGraphPolicy({ on_dependency_failure: opts?.policy ?? 'block' }),
        createdAt: now, updatedAt: now,
    });
    const node = (nodeId: string, ref: string, queueTaskId: string, message: string, extra?: Record<string, unknown>): MeshTaskGraphNodeRow => ({
        graphId, nodeId, meshId: mesh, ref, kind: 'worker_task', queueTaskId,
        state: 'declared', baseSpecJson: JSON.stringify({ message, ...extra }),
        materializationVersion: 0, createdAt: now, updatedAt: now,
    });
    gs.insertNode(node(nodeA, 'a', taskA.id, 'do A'));
    gs.insertNode(node(nodeB, 'b', taskB.id, 'do B', opts?.bRunIf));
    const edge: MeshTaskGraphEdgeRow = {
        graphId, meshId: mesh, fromNodeId: nodeA, toNodeId: nodeB,
        kind: opts?.bRunIf?.run_if ? 'conditional' : 'requires',
        omitOnSkip: false, createdAt: now,
        ...(opts?.bRunIf?.run_if ? { conditionJson: JSON.stringify(opts.bRunIf.run_if) } : {}),
    };
    gs.insertEdge(edge);
    return { graphId, nodeA, nodeB, taskA, taskB };
}

// ── Policy parse / public text ───────────────────────────────────────────────

describe('C3 policy parse + public contract (design :541-559)', () => {
    it('defaults missing values to block and accepts cancel', () => {
        expect(parseOnDependencyFailurePolicy(undefined)).toBe('block');
        expect(parseOnDependencyFailurePolicy(null)).toBe('block');
        expect(parseOnDependencyFailurePolicy('block')).toBe('block');
        expect(parseOnDependencyFailurePolicy('cancel')).toBe('cancel');
        expect(parseGraphPolicy('{}')).toEqual({ on_dependency_failure: 'block' });
        expect(parseGraphPolicy('{"on_dependency_failure":"cancel"}')).toEqual({ on_dependency_failure: 'cancel' });
    });

    it('rejects invalid values instead of silently becoming block', () => {
        expect(() => parseOnDependencyFailurePolicy('nuke')).toThrow(MeshGraphPolicyError);
        expect(() => parseOnDependencyFailurePolicy('cancel_all')).toThrow(/invalid_on_dependency_failure/);
        expect(() => parseOnDependencyFailurePolicy(1)).toThrow(MeshGraphPolicyError);
        expect(() => mergeAndNormalizePolicy(DEFAULT_MESH_POLICY, { onDependencyFailure: 'explode' as any }))
            .toThrow(/invalid_on_dependency_failure/);
        const cancelled = mergeAndNormalizePolicy(DEFAULT_MESH_POLICY, { onDependencyFailure: 'cancel' });
        expect(cancelled.onDependencyFailure).toBe('cancel');
        const blocked = mergeAndNormalizePolicy(DEFAULT_MESH_POLICY, { onDependencyFailure: 'block' });
        expect(blocked.onDependencyFailure).toBeUndefined();
    });

    it('exposes the exact public policy text', () => {
        expect(MESH_ON_DEPENDENCY_FAILURE_PUBLIC_TEXT).toContain('`block` (default)');
        expect(MESH_ON_DEPENDENCY_FAILURE_PUBLIC_TEXT).toContain('`cancel` terminally cancels');
        expect(MESH_ON_DEPENDENCY_FAILURE_PUBLIC_TEXT).toContain('not revived by predecessor retry');
    });

    it('projectGraphPublicPolicy fails closed to block on corrupt JSON and surfaces the error', () => {
        const view = projectGraphPublicPolicy('{"on_dependency_failure":"explode"}');
        expect(view.on_dependency_failure).toBe('block');
        expect(view.policyInvalid).toMatch(/invalid_on_dependency_failure/);
    });
});

// ── Derived view vs skip ─────────────────────────────────────────────────────

describe('C3 derived dependencyFailures vs skip (design :522-527, :356-369)', () => {
    it('lists failed/cancelled predecessors and excludes skip placeholders', () => {
        const statusById = new Map<string, string>([
            ['fail', 'failed'],
            ['cancel', 'cancelled'],
            ['skip', 'cancelled'],
            ['ok', 'completed'],
            ['pend', 'pending'],
        ]);
        const meta = new Map([
            ['fail', { status: 'failed' as const }],
            ['cancel', { status: 'cancelled' as const, cancelReason: 'operator_cancel' }],
            ['skip', { status: 'cancelled' as const, blockedReason: 'graph_skipped:run_if_false:x' }],
        ]);
        const failures = deriveDependencyFailures(
            ['fail', 'cancel', 'skip', 'ok', 'pend'],
            statusById,
            meta,
        );
        expect(failures.map(f => f.taskId)).toEqual(['fail', 'cancel']);
        expect(isGraphSkipPlaceholder(meta.get('skip'))).toBe(true);
        expect(isGraphSkipPlaceholder({ status: 'failed' })).toBe(false);
    });
});

// ── Queue-level block / cancel ───────────────────────────────────────────────

describe('C3 queue derived failure (design :522-538)', () => {
    it('block: does not write blockedReason; retry+complete unblocks without requeueing the dependent', () => {
        const id = meshId('block_retry');
        try {
            const a = enqueue(id, 'A');
            const b = enqueue(id, 'B', { dependsOn: [a.id] });
            updateTaskStatus(id, a.id, 'failed');
            const afterFail = getQueue(id).find(t => t.id === b.id)!;
            expect(afterFail.status).toBe('pending');
            expect(afterFail.blockedReason).toBeUndefined();
            expect(afterFail.dependsOn).toEqual([a.id]);
            expect(claimNextTask(id, 'n1', 's1')).toBeNull();

            requeueTask(id, a.id, { force: true });
            expect(getQueue(id).find(t => t.id === b.id)!.blockedReason).toBeUndefined();
            expect(claimNextTask(id, 'n1', 's1')?.id).toBe(a.id);
            updateTaskStatus(id, a.id, 'completed');
            expect(claimNextTask(id, 'n2', 's2')?.id).toBe(b.id);
        } finally {
            cleanup(id);
        }
    });

    it('cancel: cascades and is not revived by predecessor retry', () => {
        const id = meshId('cancel_sticky');
        try {
            meshConfigMocks.getMesh.mockReturnValue({ policy: { onDependencyFailure: 'cancel' } });
            const a = enqueue(id, 'A');
            const b = enqueue(id, 'B', { dependsOn: [a.id] });
            const c = enqueue(id, 'C', { dependsOn: [b.id] });
            updateTaskStatus(id, a.id, 'failed');
            expect(getQueue(id).find(t => t.id === b.id)!.status).toBe('cancelled');
            expect(getQueue(id).find(t => t.id === c.id)!.status).toBe('cancelled');
            expect(getQueue(id).find(t => t.id === b.id)!.cancelReason).toBe(`dependency_failed:${a.id}`);
            expect(getQueue(id).find(t => t.id === b.id)!.dependsOn).toEqual([a.id]);

            requeueTask(id, a.id, { force: true });
            updateTaskStatus(id, a.id, 'completed');
            expect(getQueue(id).find(t => t.id === b.id)!.status).toBe('cancelled');
            expect(claimNextTask(id, 'n1', 's1')).toBeNull();
        } finally {
            cleanup(id);
        }
    });
});

// ── Graph-level skip vs failure ──────────────────────────────────────────────

describe('C3 graph skip vs failure are distinct (design :356-369 vs :522-538)', () => {
    it('a failed predecessor leaves the dependent pending (not skipped) under block', () => {
        const id = meshId('fail_not_skip');
        try {
            const g = buildTwoNodeGraph(id, { policy: 'block' });
            updateTaskStatus(id, g.taskA.id, 'failed', { reason: 'worker_crash' } as any);
            const gs = MeshRuntimeStore.getInstance().graphStore();
            expect(gs.getNode(g.graphId, g.nodeA)!.state).toBe('failed');
            expect(gs.getNode(g.graphId, g.nodeB)!.state).toBe('declared');
            expect(gs.getNode(g.graphId, g.nodeB)!.skipReason).toBeUndefined();
            const entryB = getQueue(id).find(t => t.id === g.taskB.id)!;
            expect(entryB.status).toBe('pending');
            expect(entryB.blockedReason).toBeUndefined();
            expect(entryB.dependsOn).toEqual([g.taskA.id]);
            expect(gs.getGraph(g.graphId)!.status).toBe('active');
            const view = describeTaskDependencyState(
                entryB,
                new Map(getQueue(id).map(t => [t.id, t.status])),
                new Map(getQueue(id).map(t => [t.id, t] as const)),
            );
            expect(view.dependencyFailures).toEqual([{ taskId: g.taskA.id, status: 'failed' }]);
            expect(isGraphSkipPlaceholder(entryB)).toBe(false);
        } finally {
            cleanup(id);
        }
    });

    it('a false run_if skips the dependent and does not list it as a dependencyFailure', () => {
        const id = meshId('skip_not_fail');
        try {
            const g = buildTwoNodeGraph(id, {
                policy: 'block',
                bRunIf: { run_if: { from: 'a', select: '/worker_result/decision', op: 'eq', value: 'needs_fix' } },
            });
            updateTaskStatus(id, g.taskA.id, 'completed', {
                envelope: { workerResult: { decision: 'no_action' } },
            } as any);
            const gs = MeshRuntimeStore.getInstance().graphStore();
            const nodeB = gs.getNode(g.graphId, g.nodeB)!;
            expect(nodeB.state).toBe('skipped');
            expect(nodeB.skipReason).toMatch(/^run_if_false:/);
            const entryB = getQueue(id).find(t => t.id === g.taskB.id)!;
            expect(entryB.status).toBe('cancelled');
            expect(isGraphSkipPlaceholder(entryB)).toBe(true);
            expect(gs.getGraph(g.graphId)!.status).toBe('completed');

            const c = enqueue(id, 'C', { dependsOn: [g.taskB.id] });
            const view = describeTaskDependencyState(
                c,
                new Map(getQueue(id).map(t => [t.id, t.status])),
                new Map(getQueue(id).map(t => [t.id, t] as const)),
            );
            expect(view.waitingOn).toEqual([g.taskB.id]);
            expect(view.dependencyFailures).toEqual([]);
        } finally {
            cleanup(id);
        }
    });

    it('cancel policy marks graph dependents cancelled, not skipped, and rolls the graph up', () => {
        const id = meshId('graph_cancel');
        try {
            const g = buildTwoNodeGraph(id, { policy: 'cancel' });
            updateTaskStatus(id, g.taskA.id, 'failed');
            const gs = MeshRuntimeStore.getInstance().graphStore();
            expect(gs.getNode(g.graphId, g.nodeB)!.state).toBe('cancelled');
            expect(gs.getNode(g.graphId, g.nodeB)!.skipReason).toBeUndefined();
            expect(gs.getNode(g.graphId, g.nodeB)!.failureReason).toMatch(/^dependency_failed:/);
            const entryB = getQueue(id).find(t => t.id === g.taskB.id)!;
            expect(entryB.status).toBe('cancelled');
            expect(entryB.dependsOn).toEqual([g.taskA.id]);
            expect(isGraphSkipPlaceholder(entryB)).toBe(false);
            expect(gs.getGraph(g.graphId)!.status).toBe('failed');
        } finally {
            cleanup(id);
        }
    });
});

// ── Rollup + cancel helper ───────────────────────────────────────────────────

describe('C3 graph rollup + cancel cascade helpers', () => {
    it('classifyGraphRollup distinguishes completed / failed / cancelled and leaves block graphs active', () => {
        const base = (state: MeshTaskGraphNodeRow['state'], kind: MeshTaskGraphNodeRow['kind'] = 'worker_task'): MeshTaskGraphNodeRow => ({
            graphId: 'g', nodeId: randomUUID(), meshId: 'm', kind, state,
            baseSpecJson: '{}', materializationVersion: 0, createdAt: nowIso(), updatedAt: nowIso(),
        });
        expect(classifyGraphRollup([base('completed'), base('skipped')])).toBe('completed');
        expect(classifyGraphRollup([base('completed'), base('failed'), base('declared')])).toBeNull();
        expect(classifyGraphRollup([base('completed'), base('failed')])).toBe('failed');
        expect(classifyGraphRollup([base('completed'), base('cancelled')])).toBe('cancelled');
        expect(classifyGraphRollup([
            base('completed'),
            base('awaiting_coordinator', 'coordinator_gate'),
        ])).toBeNull();
    });

    it('applyGraphCancelCascade skips already-skipped nodes and does not touch gates', () => {
        const cancelled: string[] = [];
        const origin: MeshTaskGraphNodeRow = {
            graphId: 'g', nodeId: 'n1', meshId: 'm', ref: 'a', kind: 'worker_task',
            queueTaskId: 't1', state: 'failed', baseSpecJson: '{}',
            materializationVersion: 0, createdAt: nowIso(), updatedAt: nowIso(),
        };
        const skipped: MeshTaskGraphNodeRow = {
            ...origin, nodeId: 'n2', ref: 'b', queueTaskId: 't2', state: 'skipped',
        };
        const gate: MeshTaskGraphNodeRow = {
            ...origin, nodeId: 'n3', ref: 'gate', kind: 'coordinator_gate', queueTaskId: undefined, state: 'declared',
        };
        const pending: MeshTaskGraphNodeRow = {
            ...origin, nodeId: 'n4', ref: 'c', queueTaskId: 't4', state: 'declared',
        };
        const store = {
            findQueueEntryById: () => ({ id: 't4', status: 'pending', dependsOn: ['t1'] }),
        };
        const result = applyGraphCancelCascade(
            store,
            [origin, skipped, gate, pending],
            [
                { graphId: 'g', meshId: 'm', fromNodeId: 'n1', toNodeId: 'n2', kind: 'requires', omitOnSkip: false, createdAt: nowIso() },
                { graphId: 'g', meshId: 'm', fromNodeId: 'n1', toNodeId: 'n3', kind: 'gate', omitOnSkip: false, createdAt: nowIso() },
                { graphId: 'g', meshId: 'm', fromNodeId: 'n1', toNodeId: 'n4', kind: 'requires', omitOnSkip: false, createdAt: nowIso() },
            ],
            origin,
            nowIso(),
            (node) => { cancelled.push(node.nodeId); },
        );
        expect(result.cancelledNodeIds).toEqual(['n4']);
        expect(result.cancelledTaskIds).toEqual(['t4']);
        expect(cancelled).toEqual(['n4']);
    });
});

// ── Legacy blockedReason migration ───────────────────────────────────────────

describe('C3 legacy dependency_failed migration (design :561-564)', () => {
    it('parses only the exact dependency_failed:<taskId> format', () => {
        expect(parseLegacyDependencyFailedPredecessor('dependency_failed:abc')).toBe('abc');
        expect(isLegacyDependencyFailedBlock('dependency_failed:abc')).toBe(true);
        expect(parseLegacyDependencyFailedPredecessor('graph_skipped:x')).toBeNull();
        expect(parseLegacyDependencyFailedPredecessor('materialization_error:input_too_large')).toBeNull();
        expect(parseLegacyDependencyFailedPredecessor('graph_materialization_pending:n:0')).toBeNull();
        expect(parseLegacyDependencyFailedPredecessor('quarantine:manual')).toBeNull();
        expect(parseLegacyDependencyFailedPredecessor('dependency_failed:')).toBeNull();
    });

    it('clears matching queue markers and leaves every other block alone', () => {
        const id = meshId('migrate');
        try {
            const a = enqueue(id, 'A');
            const b = enqueue(id, 'B', { dependsOn: [a.id] });
            const c = enqueue(id, 'C');
            const store = MeshRuntimeStore.getInstance();
            const entryB = getQueue(id).find(t => t.id === b.id)!;
            const entryC = getQueue(id).find(t => t.id === c.id)!;
            store.updateQueueEntry({ ...entryB, blockedReason: `dependency_failed:${a.id}`, updatedAt: nowIso() } as any);
            store.updateQueueEntry({ ...entryC, blockedReason: 'quarantine:manual', updatedAt: nowIso() } as any);

            const db = (store as any).db;
            const cleared = migrateLegacyDependencyFailedQueueBlocks(db);
            expect(cleared.some(row => row.taskId === b.id && row.predecessorId === a.id)).toBe(true);
            expect(getQueue(id).find(t => t.id === b.id)!.blockedReason).toBeUndefined();
            expect(getQueue(id).find(t => t.id === c.id)!.blockedReason).toBe('quarantine:manual');
            const view = describeTaskDependencyState(
                getQueue(id).find(t => t.id === b.id)!,
                new Map([[a.id, 'failed'], [b.id, 'pending']]),
                new Map([[a.id, { status: 'failed' as const }]]),
            );
            expect(view.dependencyFailures).toEqual([{ taskId: a.id, status: 'failed' }]);
        } finally {
            cleanup(id);
        }
    });
});
