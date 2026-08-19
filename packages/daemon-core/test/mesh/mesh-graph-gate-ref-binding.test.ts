import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// GRAPH-ORCHESTRATION — gate ref binding deadlock (G-phase defect #2).
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     P3 — "Gate outcome drives `run_if` and conditional skip". Referencing a
//          gate ref from `run_if` / `inputs_from` is the DESIGNED usage.
//     :288-292 (plan) — a gate ref may never become an ordinary `requires`
//          dependency: that is the C2 side-step the gate edge exists to forbid.
//     :402-405 — the `gate` edge is the ONE carrier of gate ordering.
//     :338, :417-419 — a RELEASED gate exposes its outcome as an upstream
//          output so downstream bindings can select `/gate_outcome`, `/result`.
//
// THE DEFECT: `commitMeshGraphPlan` auto-wired a `conditional` (run_if) or
// `requires` (inputs_from) edge from ANY source ref — including a GATE ref.
// `settleDownstreamNode` requires every non-gate incoming edge's source to be
// `completed`, but a released gate node terminates at `released`. The
// downstream node therefore deferred forever: a silent deadlock with no error.
//
// The same graph written as a release-time patch worked, so the behaviour split
// silently on spelling alone.

const testTmpDir = path.join(tmpdir(), `adhdev-graph-gateref-${randomUUID().slice(0, 8)}`);
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

import { commitMeshGraphPlan } from '../../src/mesh/mesh-graph-plan.js';
import {
    claimMeshGraphGate,
    coordinatorGateBlockReason,
    releaseMeshGraphGate,
} from '../../src/mesh/mesh-graph-gates.js';
import { __resetMeshGraphTransitionRunnerForTests } from '../../src/mesh/mesh-graph-transition-runner.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    getQueue,
    updateTaskStatus,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

function meshId(tag: string): string {
    return `mesh_gateref_${tag}_${randomUUID().slice(0, 8)}`;
}

function gs() {
    return MeshRuntimeStore.getInstance().graphStore();
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

/**
 * Commit A --requires--> G(gate) --gate--> B through the REAL plan path, with B
 * additionally BINDING the gate ref from `run_if` / `inputs_from`. This is the
 * spelling that deadlocked; the hand-built graphs in mesh-graph-gates.test.ts
 * never exercised it because they wire their edges by hand.
 */
function planGateRefGraph(mesh: string, bSpec: Record<string, unknown>) {
    const result = commitMeshGraphPlan({
        meshId: mesh,
        tasks: [
            { ref: 'a', message: 'do A', taskMode: 'code_change', difficulty: 'medium' } as any,
            {
                ref: 'b',
                message: 'do B',
                taskMode: 'code_change',
                difficulty: 'medium',
                gated_by: ['land'],
                ...bSpec,
            } as any,
        ],
        gates: [{ ref: 'land', action: 'refinery', depends_on: ['a'], instructions: 'Land it.' }],
    });
    const gate = result.gates.find(g => g.ref === 'land')!;
    return {
        graphId: result.graphId,
        gateId: gate.gateId,
        nodeG: gate.nodeId,
        nodeA: result.nodeIdByIndex[0],
        nodeB: result.nodeIdByIndex[1],
        taskA: result.tasks[0],
        taskB: result.tasks[1],
    };
}

function openClaimRelease(
    id: string,
    g: ReturnType<typeof planGateRefGraph>,
    outcome: 'passed' | 'failed',
    result?: Record<string, unknown>,
) {
    updateTaskStatus(id, g.taskA.id, 'completed');
    expect(gs().getGate(g.gateId)!.state).toBe('awaiting_coordinator');
    const claim = claimMeshGraphGate({ meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-coord' });
    expect(claim.claimed).toBe(true);
    return releaseMeshGraphGate({
        meshId: id, gateId: g.gateId,
        fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
        idempotencyKey: `rel-${outcome}`, outcome, result,
    });
}

// ── The deadlock, at the plan-commit surface ──────────────────────────────────

describe('gate ref binding through commitMeshGraphPlan — the deadlock', () => {
    it('★ a `run_if` reading the gate ref does NOT wire an unsatisfiable edge, and the released gate drives it', () => {
        const id = meshId('runif');
        try {
            const g = planGateRefGraph(id, {
                run_if: { from: 'land', select: '/gate_outcome', op: 'eq', value: 'passed' },
            });

            // ★ THE FIX, pinned at the edge level: the only incoming edge from the
            // GATE node is the `gate` edge. Before the fix a second `conditional`
            // edge G→B existed, and settleDownstreamNode required its source to be
            // `completed` — which a released gate never is.
            const fromGate = gs().listEdges(g.graphId).filter(e => e.fromNodeId === g.nodeG && e.toNodeId === g.nodeB);
            expect(fromGate.map(e => e.kind)).toEqual(['gate']);

            openClaimRelease(id, g, 'passed');

            // Deadlock resolved: B materialized instead of deferring forever.
            expect(gs().getNode(g.graphId, g.nodeB)!.state).toBe('materialized');
            const entryB = getQueue(id).find(t => t.id === g.taskB.id)!;
            expect(entryB.status).toBe('pending');
            expect(entryB.blockedReason).toBeUndefined();
        } finally {
            cleanup(id);
        }
    });

    it('★ an `inputs_from` binding the gate ref materializes with the release evidence bound', () => {
        const id = meshId('inputs');
        try {
            const g = planGateRefGraph(id, {
                inputs_from: [{ from: 'land', select: '/result/landed_sha', as: 'landed_sha', required: true }],
            });

            // Exactly ONE gate edge: `gated_by` and the binding name the same gate
            // and must not each emit their own.
            const fromGate = gs().listEdges(g.graphId).filter(e => e.fromNodeId === g.nodeG && e.toNodeId === g.nodeB);
            expect(fromGate.map(e => e.kind)).toEqual(['gate']);

            openClaimRelease(id, g, 'passed', { landed_sha: 'deadbeef' });

            expect(gs().getNode(g.graphId, g.nodeB)!.state).toBe('materialized');
            const entryB = getQueue(id).find(t => t.id === g.taskB.id)!;
            expect(entryB.status).toBe('pending');
            expect(entryB.blockedReason).toBeUndefined();
            // C1 binding semantics survive: evidence is appended, marked untrusted.
            expect(entryB.message).toContain('deadbeef');
            expect(entryB.message).toMatch(/trust="untrusted"/);
            expect(entryB.message).toMatch(/source_ref="land"/);
        } finally {
            cleanup(id);
        }
    });

    it('★ gate outcome still DRIVES the condition — a failed release skips downstream (design P3)', () => {
        const id = meshId('drives');
        try {
            const g = planGateRefGraph(id, {
                run_if: { from: 'land', select: '/gate_outcome', op: 'eq', value: 'passed' },
            });
            openClaimRelease(id, g, 'failed');

            // Skipped, NOT completed and NOT materialized (C3: skip ≠ failure, and a
            // skip must never look like a satisfied dependency).
            const nodeB = gs().getNode(g.graphId, g.nodeB)!;
            expect(nodeB.state).toBe('skipped');
            expect(nodeB.skipReason).toMatch(/^run_if_false:/);
            expect(getQueue(id).find(t => t.id === g.taskB.id)!.status).toBe('cancelled');
        } finally {
            cleanup(id);
        }
    });
});

// ── C2 contracts that must survive the fix ───────────────────────────────────

describe('C2 contracts hold for gate-ref-binding graphs', () => {
    it('an UNRELEASED gate still stops the downstream node (no auto-release, no side-step)', () => {
        const id = meshId('c2_stop');
        try {
            const g = planGateRefGraph(id, {
                run_if: { from: 'land', select: '/gate_outcome', op: 'eq', value: 'passed' },
            });
            // Upstream A completes → the gate OPENS, but is never released.
            updateTaskStatus(id, g.taskA.id, 'completed');

            expect(gs().getGate(g.gateId)!.state).toBe('awaiting_coordinator');
            const entryB = getQueue(id).find(t => t.id === g.taskB.id)!;
            expect(entryB.status).toBe('pending');
            expect(entryB.blockedReason).toBe(coordinatorGateBlockReason(g.gateId));
            expect(gs().getNode(g.graphId, g.nodeB)!.state).toBe('blocked');
        } finally {
            cleanup(id);
        }
    });

    it('a gate ref in `depends_on` is still REJECTED — the fix does not open that door', () => {
        const id = meshId('c2_depends');
        try {
            expect(() => commitMeshGraphPlan({
                meshId: id,
                tasks: [
                    { ref: 'a', message: 'do A', taskMode: 'code_change', difficulty: 'medium' } as any,
                    { ref: 'b', message: 'do B', taskMode: 'code_change', difficulty: 'medium', dependsOn: ['land'] } as any,
                ],
                gates: [{ ref: 'land', action: 'refinery', depends_on: ['a'] }],
            })).toThrow(/gate_ref_in_depends_on/);
        } finally {
            cleanup(id);
        }
    });

    it('★ binding a gate ref WITHOUT `gated_by` still implies the gate edge (no read-before-release)', () => {
        const id = meshId('implied_gate');
        try {
            // Same graph as the deadlock cases, minus `gated_by`. Dropping the
            // unsatisfiable edge must not leave the node with NO gate ordering —
            // it would then materialize immediately and evaluate `run_if` against
            // an outcome the release has not committed yet.
            const result = commitMeshGraphPlan({
                meshId: id,
                tasks: [
                    { ref: 'a', message: 'do A', taskMode: 'code_change', difficulty: 'medium' } as any,
                    {
                        ref: 'b', message: 'do B', taskMode: 'code_change', difficulty: 'medium',
                        run_if: { from: 'land', select: '/gate_outcome', op: 'eq', value: 'passed' },
                    } as any,
                ],
                gates: [{ ref: 'land', action: 'refinery', depends_on: ['a'] }],
            });
            const gate = result.gates.find(g => g.ref === 'land')!;
            const nodeB = result.nodeIdByIndex[1];
            const fromGate = gs().listEdges(result.graphId).filter(e => e.fromNodeId === gate.nodeId && e.toNodeId === nodeB);
            expect(fromGate.map(e => e.kind)).toEqual(['gate']);

            // And it behaves like a gate: the unreleased gate stops the node.
            updateTaskStatus(id, result.tasks[0].id, 'completed');
            const entryB = getQueue(id).find(t => t.id === result.tasks[1].id)!;
            expect(entryB.blockedReason).toBe(coordinatorGateBlockReason(gate.gateId));
            expect(gs().getNode(result.graphId, nodeB)!.state).toBe('blocked');
        } finally {
            cleanup(id);
        }
    });

    it('worker-ref bindings are untouched — a task ref in run_if still wires a conditional edge', () => {
        const id = meshId('worker_edge');
        try {
            const result = commitMeshGraphPlan({
                meshId: id,
                tasks: [
                    { ref: 'a', message: 'do A', taskMode: 'code_change', difficulty: 'medium' } as any,
                    {
                        ref: 'b', message: 'do B', taskMode: 'code_change', difficulty: 'medium',
                        run_if: { from: 'a', select: '/status', op: 'eq', value: 'ok' },
                    } as any,
                ],
            });
            const nodeA = result.nodeIdByIndex[0];
            const nodeB = result.nodeIdByIndex[1];
            const edges = gs().listEdges(result.graphId).filter(e => e.fromNodeId === nodeA && e.toNodeId === nodeB);
            expect(edges.map(e => e.kind)).toEqual(['conditional']);
        } finally {
            cleanup(id);
        }
    });
});
