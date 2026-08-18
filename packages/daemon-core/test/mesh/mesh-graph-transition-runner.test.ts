import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// GRAPH-ORCHESTRATION Phase B — transactional terminal choke point characterization.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :311-334 — ONE entry point (commitTaskTerminalAndAdvanceGraph) performing the
//                9-step terminal/output/graph-advance/wake transaction under the
//                existing mesh queue lock; CAS key (graph_node_id,
//                materialization_version, queue_status='pending'); replayed events
//                produce no duplicate transition; assigned tasks are immutable
//                (task_already_claimed).
//     :185-191 — outbox rows join the SAME transaction; drain after commit.
//
//   Layers pinned here:
//     (1) ROUTING SPY — every genuine completion path (updateTaskStatus /
//         updateSessionTaskStatus, which carry agent:generating_completed and
//         completion-via-ready) MUST pass through the single entry point. A new
//         completion path that bypasses it drops the spy count → RED.
//     (2) REPLAY IDEMPOTENCY — the same terminal event twice yields one output
//         version, one node transition, one outbox generation.
//     (3) STRUCTURAL PIN — no mesh source file may flip a queue row to a literal
//         terminal status outside the choke point; both queue mutators must
//         delegate their terminal branch.
//     (4) SETTLE OWNERSHIP — the attempt settle (proposeTurnCompletion) happens
//         exactly once per terminal transition, inside the runner.

const testTmpDir = path.join(tmpdir(), `adhdev-graph-runner-${randomUUID().slice(0, 8)}`);
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
    commitTaskTerminalAndAdvanceGraph,
    drainMeshGraphOutbox,
    graphMaterializationBlockReason,
    patchPendingGraphNodeBaseSpec,
    registerMeshGraphQueueWakeHandler,
    __resetMeshGraphTransitionRunnerForTests,
} from '../../src/mesh/mesh-graph-transition-runner.js';
import * as turnLedger from '../../src/mesh/mesh-turn-ledger.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    enqueueTask,
    getQueue,
    updateSessionTaskStatus,
    updateTaskStatus,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { MeshTaskGraphEdgeRow, MeshTaskGraphNodeRow } from '../../src/mesh/mesh-graph-types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MESH_SRC_DIR = path.resolve(HERE, '../../src/mesh');

function meshId(tag: string): string {
    return `mesh_graphb_${tag}_${randomUUID().slice(0, 8)}`;
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

function nowIso(): string {
    return new Date().toISOString();
}

/** Hand-build a two-node worker graph (A --requires--> B) over two real queue rows. */
function buildTwoNodeGraph(mesh: string, opts?: { blockB?: boolean; bBaseSpec?: Record<string, unknown>; edgeKind?: 'requires' | 'conditional'; conditionJson?: string }) {
    const taskA = enqueue(mesh, 'do A');
    const taskB = enqueue(mesh, 'placeholder B — replaced at materialization');
    const gs = MeshRuntimeStore.getInstance().graphStore();
    const graphId = randomUUID();
    const nodeA = randomUUID();
    const nodeB = randomUUID();
    const now = nowIso();
    gs.insertGraph({
        graphId, meshId: mesh, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: 'active', taskCount: 2, gateCount: 0, workspaceCount: 0, dependencyEdgeCount: 1,
        policyJson: '{}', createdAt: now, updatedAt: now,
    });
    const nodeRow = (nodeId: string, ref: string, queueTaskId: string, message: string): MeshTaskGraphNodeRow => ({
        graphId, nodeId, meshId: mesh, ref, kind: 'worker_task', queueTaskId,
        state: 'declared', baseSpecJson: JSON.stringify({ message }), materializationVersion: 0,
        createdAt: now, updatedAt: now,
    });
    gs.insertNode(nodeRow(nodeA, 'a', taskA.id, 'do A'));
    gs.insertNode({ ...nodeRow(nodeB, 'b', taskB.id, 'do B'), ...(opts?.bBaseSpec ? { baseSpecJson: JSON.stringify(opts.bBaseSpec) } : {}) });
    const edge: MeshTaskGraphEdgeRow = {
        graphId, meshId: mesh, fromNodeId: nodeA, toNodeId: nodeB,
        kind: opts?.edgeKind ?? 'requires', omitOnSkip: false, createdAt: now,
        ...(opts?.conditionJson ? { conditionJson: opts.conditionJson } : {}),
    };
    gs.insertEdge(edge);
    if (opts?.blockB) {
        const entryB = getQueue(mesh).find(t => t.id === taskB.id)!;
        MeshRuntimeStore.getInstance().updateQueueEntry({
            ...entryB, blockedReason: graphMaterializationBlockReason(nodeB, 0), updatedAt: nowIso(),
        } as any);
    }
    return { graphId, nodeA, nodeB, taskA, taskB };
}

// ── 1. ROUTING SPY: every genuine completion path passes the choke point ─────

describe('single entry point — routing (injection guard)', () => {
    it('updateTaskStatus terminal flips route through commitTaskTerminalAndAdvanceGraph', () => {
        const id = meshId('route_update');
        try {
            const task = enqueue(id, 'work');
            const spy = vi.spyOn(graphRunner, 'commitTaskTerminalAndAdvanceGraph');
            const updated = updateTaskStatus(id, task.id, 'completed');
            expect(updated?.status).toBe('completed');
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy.mock.calls[0][0]).toMatchObject({ meshId: id, taskId: task.id, status: 'completed' });
        } finally {
            cleanup(id);
        }
    });

    it('updateSessionTaskStatus terminal flips (agent:generating_completed / completion-via-ready) route through it too', () => {
        const id = meshId('route_session');
        try {
            const task = enqueue(id, 'work');
            MeshRuntimeStore.getInstance().updateQueueEntry({
                ...getQueue(id).find(t => t.id === task.id)!,
                status: 'assigned', assignedNodeId: 'node_main', assignedSessionId: 'sess-route',
                updatedAt: nowIso(),
            } as any);
            const spy = vi.spyOn(graphRunner, 'commitTaskTerminalAndAdvanceGraph');
            const updated = updateSessionTaskStatus(id, 'sess-route', 'completed', { taskId: task.id });
            expect(updated?.status).toBe('completed');
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy.mock.calls[0][0]).toMatchObject({ meshId: id, taskId: task.id, status: 'completed', source: 'provider_event' });
        } finally {
            cleanup(id);
        }
    });
});

// ── 2. SETTLE OWNERSHIP: exactly one attempt settle per terminal transition ──

describe('settle ownership — the runner, not the callers, settles the attempt', () => {
    it('one terminal transition settles once; a replayed flip does not re-propose', () => {
        const id = meshId('settle_once');
        try {
            const task = enqueue(id, 'work');
            // Bind the task to a session so the reducer has an attempt to settle —
            // the realistic shape of every terminal flip (watchdog/redrive/native).
            MeshRuntimeStore.getInstance().updateQueueEntry({
                ...getQueue(id).find(t => t.id === task.id)!,
                status: 'assigned', assignedNodeId: 'node_main', assignedSessionId: 'sess-settle',
                updatedAt: nowIso(),
            } as any);
            const spy = vi.spyOn(turnLedger, 'proposeTurnCompletion');
            updateTaskStatus(id, task.id, 'completed');
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy.mock.calls[0][0]).toMatchObject({ meshId: id, taskId: task.id, outcome: 'completed' });

            // Replay: the row is already terminal with the same status — the fence
            // short-circuits BEFORE any reducer work (no second proposal).
            const again = updateTaskStatus(id, task.id, 'completed');
            expect(again?.status).toBe('completed');
            expect(spy).toHaveBeenCalledTimes(1);

            // The attempt converged to the same terminal outcome — row and attempt
            // cannot diverge regardless of call order.
            const attempt = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(id, task.id);
            expect(attempt?.terminalOutcome).toBe('completed');
        } finally {
            cleanup(id);
        }
    });

    it('a pre-proposal (markSessionTerminal ordering) plus the runner settle is one logical settle', () => {
        const id = meshId('settle_pre');
        try {
            const task = enqueue(id, 'work');
            MeshRuntimeStore.getInstance().updateQueueEntry({
                ...getQueue(id).find(t => t.id === task.id)!,
                status: 'assigned', assignedNodeId: 'node_main', assignedSessionId: 'sess-pre',
                updatedAt: nowIso(),
            } as any);
            // Simulate markSessionTerminal: the provider-event proposal commits FIRST.
            const first = turnLedger.proposeTurnCompletion({
                meshId: id, taskId: task.id, sessionId: 'sess-pre', outcome: 'completed', source: 'provider_event',
            });
            expect(first.committed).toBe(true);
            // The runner's settle must be the idempotent duplicate — never a conflict,
            // never a second committed outcome.
            const updated = updateSessionTaskStatus(id, 'sess-pre', 'completed', { taskId: task.id });
            expect(updated?.status).toBe('completed');
            const attempt = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(id, task.id);
            expect(attempt?.terminalOutcome).toBe('completed');
        } finally {
            cleanup(id);
        }
    });
});

// ── 3. OUTPUT PERSISTENCE: normalized envelope, same transaction ─────────────

describe('output persistence (step 2)', () => {
    it('persists one immutable output version with a stable digest', () => {
        const id = meshId('output_v1');
        try {
            const task = enqueue(id, 'work');
            updateTaskStatus(id, task.id, 'completed');
            const gs = MeshRuntimeStore.getInstance().graphStore();
            const output = gs.getLatestOutput(task.id);
            expect(output).not.toBeNull();
            expect(output!.version).toBe(1);
            expect(output!.status).toBe('completed');
            expect(output!.digest).toMatch(/^[0-9a-f]{64}$/);
            const envelope = JSON.parse(output!.envelopeJson);
            expect(envelope.task_id).toBe(task.id);
            expect(envelope.status).toBe('completed');
        } finally {
            cleanup(id);
        }
    });

    it('threads the completion envelope (final_summary / worker_result) into the stored version', () => {
        const id = meshId('output_env');
        try {
            const task = enqueue(id, 'work');
            MeshRuntimeStore.getInstance().updateQueueEntry({
                ...getQueue(id).find(t => t.id === task.id)!,
                status: 'assigned', assignedNodeId: 'node_main', assignedSessionId: 'sess-env',
                updatedAt: nowIso(),
            } as any);
            updateSessionTaskStatus(id, 'sess-env', 'completed', {
                taskId: task.id,
                envelope: { finalSummary: 'done: root cause fixed', workerResult: { rootCause: 'null deref' } },
            });
            const output = MeshRuntimeStore.getInstance().graphStore().getLatestOutput(task.id);
            const envelope = JSON.parse(output!.envelopeJson);
            expect(envelope.final_summary).toBe('done: root cause fixed');
            expect(envelope.worker_result).toEqual({ rootCause: 'null deref' });
        } finally {
            cleanup(id);
        }
    });
});

// ── 4. GRAPH ADVANCEMENT: materialization, CAS, outbox, wake ─────────────────

describe('graph advancement under the one transaction (steps 4-9)', () => {
    it('materializes the eligible downstream node, clears only the matching graph block, and wakes via the outbox', () => {
        const id = meshId('advance');
        try {
            const { graphId, nodeA, nodeB, taskA, taskB } = buildTwoNodeGraph(id, { blockB: true });
            const wake = vi.fn();
            registerMeshGraphQueueWakeHandler(wake);

            updateTaskStatus(id, taskA.id, 'completed');

            const gs = MeshRuntimeStore.getInstance().graphStore();
            // Step 4: upstream node terminal.
            expect(gs.getNode(graphId, nodeA)!.state).toBe('completed');
            // Step 6: downstream node materialized via the version CAS.
            const nodeBRow = gs.getNode(graphId, nodeB)!;
            expect(nodeBRow.state).toBe('materialized');
            expect(nodeBRow.materializationVersion).toBe(1);
            expect(nodeBRow.materializedDigest).toMatch(/^[0-9a-f]{64}$/);
            // Steps 6-7: queue row carries the identity-materialized message, the
            // requires-projection as dependsOn, and the generation-matched graph
            // block is cleared.
            const entryB = getQueue(id).find(t => t.id === taskB.id)!;
            expect(entryB.message).toBe('do B');
            expect(entryB.dependsOn).toEqual([taskA.id]);
            expect(entryB.blockedReason).toBeUndefined();
            // The unchanged predicate now passes for B (deps completed && no block).
            const statusById = new Map(getQueue(id).map(t => [t.id, t.status] as const));
            expect(statusById.get(taskA.id)).toBe('completed');
            // Step 8+9: outbox events committed and drained; the wake fired once.
            expect(wake).toHaveBeenCalledTimes(1);
            expect(wake).toHaveBeenCalledWith(id);
            expect(gs.listPendingOutboxEvents(id)).toEqual([]);
            // Graph is NOT complete yet — B is only materialized, not completed.
            expect(gs.getGraph(graphId)!.status).toBe('active');
        } finally {
            cleanup(id);
        }
    });

    it('completes the graph once every node is terminal-equivalent', () => {
        const id = meshId('rollup');
        try {
            const { graphId, taskA, taskB } = buildTwoNodeGraph(id, { blockB: true });
            updateTaskStatus(id, taskA.id, 'completed');
            updateTaskStatus(id, taskB.id, 'completed');
            const graph = MeshRuntimeStore.getInstance().graphStore().getGraph(graphId)!;
            expect(graph.status).toBe('completed');
            expect(graph.terminalAt).toBeTruthy();
        } finally {
            cleanup(id);
        }
    });

    it('REPLAY: a repeated terminal event yields no duplicate transition (CAS idempotency)', () => {
        const id = meshId('replay');
        try {
            const { graphId, nodeB, taskA, taskB } = buildTwoNodeGraph(id, { blockB: true });
            const wake = vi.fn();
            registerMeshGraphQueueWakeHandler(wake);

            const first = commitTaskTerminalAndAdvanceGraph({ meshId: id, taskId: taskA.id, status: 'completed', source: 'stall_reconcile' });
            expect(first.committed).toBe(true);
            expect(first.duplicate).toBe(false);
            expect(first.materializedNodeIds).toEqual([nodeB]);

            const replay = commitTaskTerminalAndAdvanceGraph({ meshId: id, taskId: taskA.id, status: 'completed', source: 'stall_reconcile' });
            expect(replay.committed).toBe(true);
            expect(replay.duplicate).toBe(true);
            expect(replay.materializedNodeIds).toEqual([]);

            const gs = MeshRuntimeStore.getInstance().graphStore();
            // One output version, one materialization, one wake — nothing doubled.
            expect(gs.getLatestOutput(taskA.id)!.version).toBe(1);
            expect(gs.getNode(graphId, nodeB)!.materializationVersion).toBe(1);
            expect(wake).toHaveBeenCalledTimes(1);
            expect(getQueue(id).find(t => t.id === taskB.id)!.dependsOn).toEqual([taskA.id]);
        } finally {
            cleanup(id);
        }
    });

    it('leaves non-graph blocks untouched even when their task completes upstream', () => {
        const id = meshId('nongraph_block');
        try {
            const { nodeB, taskA, taskB } = buildTwoNodeGraph(id);
            // A block the graph does NOT own must survive materialization...
            const entryB = getQueue(id).find(t => t.id === taskB.id)!;
            MeshRuntimeStore.getInstance().updateQueueEntry({
                ...entryB, blockedReason: 'dependency_failed:some-other', updatedAt: nowIso(),
            } as any);
            updateTaskStatus(id, taskA.id, 'completed');
            const after = getQueue(id).find(t => t.id === taskB.id)!;
            expect(after.blockedReason).toBe('dependency_failed:some-other');
            // ...and a STALE-generation graph block must survive too (only the exact
            // generation just advanced may clear).
            const gs = MeshRuntimeStore.getInstance().graphStore();
            expect(gs.getNode((gs.findNodeByQueueTaskId(id, taskB.id)!).graphId, nodeB)!.state).toBe('materialized');
        } finally {
            cleanup(id);
        }
    });
});

// ── 5. B BOUNDARY: conditions/bindings fail closed until phase C1 ────────────

describe('phase-B boundary — unevaluated conditions and inputs_from stay deferred', () => {
    it('a conditional edge with condition_json blocks materialization (run_if is C1)', () => {
        const id = meshId('cond_defer');
        try {
            const { graphId, nodeB, taskA, taskB } = buildTwoNodeGraph(id, {
                edgeKind: 'conditional',
                conditionJson: JSON.stringify({ all: [{ from: 'a', select: '/worker_result/decision', eq: 'fix' }] }),
            });
            updateTaskStatus(id, taskA.id, 'completed');
            const gs = MeshRuntimeStore.getInstance().graphStore();
            expect(gs.getNode(graphId, nodeB)!.state).toBe('blocked');
            const entryB = getQueue(id).find(t => t.id === taskB.id)!;
            expect(entryB.blockedReason).toBe(graphMaterializationBlockReason(nodeB, 0));
            expect(entryB.message).toBe('placeholder B — replaced at materialization');
        } finally {
            cleanup(id);
        }
    });

    it('a base spec carrying inputs_from bindings blocks materialization (binding semantics are C1)', () => {
        const id = meshId('bind_defer');
        try {
            const { graphId, nodeB, taskA, taskB } = buildTwoNodeGraph(id, {
                bBaseSpec: { message: 'do B', inputs_from: [{ from: 'a', select: '/worker_result', as: 'result', required: true }] },
            });
            updateTaskStatus(id, taskA.id, 'completed');
            const gs = MeshRuntimeStore.getInstance().graphStore();
            expect(gs.getNode(graphId, nodeB)!.state).toBe('blocked');
            expect(getQueue(id).find(t => t.id === taskB.id)!.blockedReason).toBe(graphMaterializationBlockReason(nodeB, 0));
        } finally {
            cleanup(id);
        }
    });
});

// ── 6. IMMUTABILITY: assigned tasks reject spec patches ──────────────────────

describe('task_already_claimed — an assigned task is immutable (design :334)', () => {
    it('patching a still-pending node succeeds and bumps the materialization generation', () => {
        const id = meshId('patch_ok');
        try {
            const { graphId, nodeB } = buildTwoNodeGraph(id);
            const patched = patchPendingGraphNodeBaseSpec(graphId, nodeB, JSON.stringify({ message: 'do B v2' }));
            expect(patched.materializationVersion).toBe(1);
            expect(JSON.parse(patched.baseSpecJson).message).toBe('do B v2');
        } finally {
            cleanup(id);
        }
    });

    it('patching after the queue task was assigned fails with task_already_claimed', () => {
        const id = meshId('patch_claimed');
        try {
            const { graphId, nodeB, taskB } = buildTwoNodeGraph(id);
            MeshRuntimeStore.getInstance().updateQueueEntry({
                ...getQueue(id).find(t => t.id === taskB.id)!,
                status: 'assigned', assignedNodeId: 'node_main', assignedSessionId: 'sess-claim',
                updatedAt: nowIso(),
            } as any);
            expect(() => patchPendingGraphNodeBaseSpec(graphId, nodeB, JSON.stringify({ message: 'too late' })))
                .toThrowError(/task_already_claimed/);
        } finally {
            cleanup(id);
        }
    });
});

// ── 7. STRUCTURAL PINS: no completion path may bypass the choke point ────────

describe('structural pins — the choke point cannot be silently bypassed', () => {
    const read = (rel: string) => fs.readFileSync(path.join(MESH_SRC_DIR, rel), 'utf8');

    it('both queue status mutators delegate their terminal branch to the runner', () => {
        const src = read('mesh-work-queue.ts');
        const delegations = src.match(/commitTaskTerminalAndAdvanceGraph\(\{/g) ?? [];
        // Exactly two call sites: updateTaskStatus and updateSessionTaskStatus.
        expect(delegations.length).toBe(2);
    });

    it('no mesh source file flips a queue row to a literal terminal status outside the runner', () => {
        // A NEW completion path that writes 'completed' directly (the pre-B bug class)
        // must fail here. The runner itself assigns from the typed parameter only.
        // Queue-entry variables are entry/dependent/queueEntry/task — other `.status`
        // fields (refine-gate summaries, bootstrap state) are not queue rows.
        const queueStatusAssign = /\b(entry|dependent|queueEntry|task)\.status\s*=\s*'(completed|failed|cancelled)'/;
        const offenders: string[] = [];
        for (const file of fs.readdirSync(MESH_SRC_DIR).filter(f => f.endsWith('.ts'))) {
            if (queueStatusAssign.test(read(file))) offenders.push(file);
        }
        // The ONLY permitted writer is mesh-work-queue.ts, hosting the documented
        // legacy failure/cancel writers (cancelTask, dependency cascade, requeue-cap
        // auto-fail, zombie sweep — phase-B NON-GOALS with no completion envelope).
        expect(offenders).toEqual(['mesh-work-queue.ts']);
        // ...and even there, no literal 'completed' write may ever appear: every
        // genuine completion routes through the choke point.
        expect(read('mesh-work-queue.ts')).not.toMatch(/\b(entry|dependent|queueEntry|task)\.status\s*=\s*'completed'/);
    });

    it('the native completion path hands its envelope to the choke point', () => {
        const src = read('mesh-event-forwarding.ts');
        // markSessionTerminal → updateSessionTaskStatus(..., outcome, { ... envelope: {...} })
        expect(src).toMatch(/updateSessionTaskStatus\(args\.meshId, sessionId, outcome, \{[\s\S]*?envelope:\s*\{/);
    });

    it('the queue wake handler is registered from event forwarding, never from dispatch code', () => {
        expect(read('mesh-event-forwarding.ts')).toContain('registerMeshGraphQueueWakeHandler(');
        // The runner must not import the dispatcher (design :92-96 — the graph engine
        // finishes by committing queue state and scheduling the ordinary trigger).
        const runnerImports = read('mesh-graph-transition-runner.ts')
            .split('\n')
            .filter(line => /^import\b/.test(line));
        expect(runnerImports.join('\n')).not.toMatch(/mesh-queue-assignment|mesh-event-forwarding/);
    });
});
