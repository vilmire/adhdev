import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// D3 — coordinator-gate lifecycle safety (docs/design/2026-09-25-graph-orchestration-simplification.md).
//
//   (a) auto-close: cancelling a task that leaves a gate's DIRECT downstream all
//       terminal closes the gate (`cancelled`, reason downstream_all_terminal)
//       through the one abandon path, in the cancel's transaction. A gate with any
//       live downstream, a terminal gate (no downstream) and a live foreign lease
//       are untouched.
//   (b) default deadline: a gate opened without `deadline_seconds` gets now+24 h
//       (env ADHDEV_GRAPH_GATE_DEFAULT_DEADLINE_S, 0 disables); a deadline expiry
//       pages the coordinator EXACTLY once (`graph_gate_deadline_expired`) and the
//       expired gate stays visible (state `expired` + age) in the mesh_status
//       summary. A lease lapse never pages this kind.
//   (c) extend: pushes the deadline from max(now, deadline) and reopens an
//       expired-hold gate; refuses terminal gates.

const testTmpDir = path.join(tmpdir(), `adhdev-gate-lifecycle-${randomUUID().slice(0, 8)}`);
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
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(() => undefined),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
    getDifficultyBrains: vi.fn(() => undefined),
}));

import {
    afterTaskTerminalCommitted,
    applyTaskTerminalInTxn,
    registerMeshGraphGateNotifyHandler,
    __resetMeshGraphTransitionRunnerForTests,
    type MeshGraphGateNotification,
} from '../../src/mesh/mesh-graph-transition-runner.js';
import { commitMeshGraphPlan } from '../../src/mesh/mesh-graph-plan.js';
import {
    abandonMeshGraphGate,
    claimMeshGraphGate,
    extendMeshGraphGateDeadline,
    MESH_GATE_AUTO_ABANDON_REASON,
    MESH_GATE_DEFAULT_DEADLINE_SECONDS,
    releaseMeshGraphGate,
    sweepMeshGraphGateTimeouts,
} from '../../src/mesh/mesh-graph-gates.js';
import type { MeshGraphGateRow, MeshTaskGraphEdgeRow, MeshTaskGraphNodeRow } from '../../src/mesh/mesh-graph-types.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    __writeTaskStatusForTests,
    cancelTask,
    enqueueTask,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { listMeshBlockedGates, __resetMeshGraphUsageCacheForTests } from '../../src/mesh/mesh-graph-usage.js';
import { meshStoreIpcHandlers } from '../../src/commands/low-family/mesh-store-ipc.js';

const ENV = 'ADHDEV_GRAPH_GATE_DEFAULT_DEADLINE_S';
const HOUR = 3_600_000;

function meshId(tag: string): string {
    return `mesh_gatelife_${tag}_${randomUUID().slice(0, 8)}`;
}

let currentMesh: string | undefined;
afterEach(() => {
    if (currentMesh) __clearMeshQueueForTests(currentMesh);
    currentMesh = undefined;
    delete process.env[ENV];
    __resetMeshRuntimeStoreForTests();
    __resetMeshGraphTransitionRunnerForTests();
    __resetMeshGraphUsageCacheForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function gs() {
    return MeshRuntimeStore.getInstance().graphStore();
}

interface BuildOpts {
    /** Downstream worker count behind the gate (0 = terminal gate). */
    downstream?: number;
    gateSpec?: Record<string, unknown>;
    onTimeout?: MeshGraphGateRow['onTimeout'];
}

/** A --requires--> G --gate--> B1..Bn over real queue rows. */
function build(mesh: string, opts: BuildOpts = {}) {
    currentMesh = mesh;
    const n = opts.downstream ?? 1;
    const enqueue = (m: string) => enqueueTask(mesh, m, { taskMode: 'code_change', difficulty: 'medium' } as any);
    const taskA = enqueue('do A');
    const downTasks = Array.from({ length: n }, (_, i) => enqueue(`placeholder B${i}`));
    const graphId = randomUUID();
    const gateId = randomUUID();
    const nodeA = randomUUID();
    const nodeG = randomUUID();
    const downNodes = downTasks.map(() => randomUUID());
    const now = new Date().toISOString();
    gs().insertGraph({
        graphId, meshId: mesh, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: 'active', taskCount: 1 + n, gateCount: 1, workspaceCount: 0, dependencyEdgeCount: 1 + n,
        policyJson: '{}', createdAt: now, updatedAt: now,
    });
    const node = (nodeId: string, ref: string, kind: MeshTaskGraphNodeRow['kind'], queueTaskId: string | undefined, spec: Record<string, unknown>): MeshTaskGraphNodeRow => ({
        graphId, nodeId, meshId: mesh, ref, kind, queueTaskId, state: 'declared',
        baseSpecJson: JSON.stringify(spec), materializationVersion: 0, createdAt: now, updatedAt: now,
    });
    const edge = (from: string, to: string, kind: MeshTaskGraphEdgeRow['kind']): MeshTaskGraphEdgeRow => ({
        graphId, meshId: mesh, fromNodeId: from, toNodeId: to, kind, omitOnSkip: false, createdAt: now,
    });
    gs().insertNode(node(nodeA, 'a', 'worker_task', taskA.id, { message: 'do A' }));
    gs().insertNode(node(nodeG, 'land', 'coordinator_gate', undefined, opts.gateSpec ?? {}));
    downTasks.forEach((t, i) => gs().insertNode(node(downNodes[i], `b${i}`, 'worker_task', t.id, { message: `do B${i}` })));
    gs().insertEdge(edge(nodeA, nodeG, 'requires'));
    downNodes.forEach(id => gs().insertEdge(edge(nodeG, id, 'gate')));
    gs().insertGate({
        gateId, graphId, nodeId: nodeG, meshId: mesh, ref: 'land', state: 'declared', action: 'approval',
        leaseGeneration: 0, onTimeout: opts.onTimeout ?? 'hold', createdAt: now, updatedAt: now,
    });
    return { graphId, gateId, nodeA, nodeG, downNodes, taskA, downTasks };
}

function open(mesh: string, g: ReturnType<typeof build>) {
    __writeTaskStatusForTests(mesh, g.taskA.id, 'completed');
    return gs().getGate(g.gateId)!;
}

// ── D3(a) ─────────────────────────────────────────────────────────────────────

describe('D3(a) — cancel auto-closes a gate whose downstream is all terminal', () => {
    it('cancelling the only downstream task abandons the gate (downstream_all_terminal) and rolls the graph', () => {
        const mesh = meshId('auto');
        const g = build(mesh);
        expect(open(mesh, g).state).toBe('awaiting_coordinator');

        cancelTask(mesh, g.downTasks[0].id, { reason: 'operator_cancel' });

        const gate = gs().getGate(g.gateId)!;
        expect(gate.state).toBe('cancelled');
        expect(gate.releaseOutcome).toBeUndefined(); // closure, never passage
        const gateNode = gs().getNode(g.graphId, g.nodeG)!;
        expect(gateNode.state).toBe('cancelled');
        expect(gateNode.failureReason).toBe(`coordinator_gate_abandoned:${g.gateId}:${MESH_GATE_AUTO_ABANDON_REASON}`);
        // The abandon's outbox row committed with the state change (same txn).
        const abandoned = gs().listOutboxEvents(mesh, g.graphId).filter(e => e.kind === 'graph_gate_abandoned');
        expect(abandoned).toHaveLength(1);
        expect(JSON.parse(abandoned[0].payload)).toMatchObject({ reason: MESH_GATE_AUTO_ABANDON_REASON, auto: true, gateId: g.gateId });
        // The graph can now settle — the whole point.
        expect(gs().getGraph(g.graphId)!.status).toBe('cancelled');
    });

    it('a gate with ANY non-terminal downstream is untouched', () => {
        const mesh = meshId('partial');
        const g = build(mesh, { downstream: 2 });
        open(mesh, g);
        cancelTask(mesh, g.downTasks[0].id);
        expect(gs().getGate(g.gateId)!.state).toBe('awaiting_coordinator');
        expect(gs().getNode(g.graphId, g.nodeG)!.state).toBe('awaiting_coordinator');
        // ...and closes once the LAST downstream goes terminal.
        cancelTask(mesh, g.downTasks[1].id);
        expect(gs().getGate(g.gateId)!.state).toBe('cancelled');
    });

    it('a terminal gate (no downstream) is never auto-closed', () => {
        const mesh = meshId('terminal');
        const g = build(mesh, { downstream: 0 });
        // Cancelling the upstream leaves the gate declared with nothing downstream.
        cancelTask(mesh, g.taskA.id);
        expect(gs().getGate(g.gateId)!.state).toBe('declared');
    });

    it('a gate under a LIVE foreign lease is left for its holder', () => {
        const mesh = meshId('lease');
        const g = build(mesh);
        open(mesh, g);
        expect(claimMeshGraphGate({ meshId: mesh, gateId: g.gateId, coordinatorSessionId: 'coord-1' }).claimed).toBe(true);
        cancelTask(mesh, g.downTasks[0].id);
        expect(gs().getGate(g.gateId)!.state).toBe('claimed');
    });

    it('a still-declared gate whose downstream was cancelled is closed too (it can guard nothing)', () => {
        const mesh = meshId('declared');
        const g = build(mesh);
        cancelTask(mesh, g.downTasks[0].id);
        expect(gs().getGate(g.gateId)!.state).toBe('cancelled');
    });
});

// ── D3(a) — every terminal writer, via the choke point (wave 24) ──────────────
//
// Wave 23 hooked only cancelTask. The auto-close now runs at the end of the
// runner's failed/cancelled advance, so the `on_dependency_failure: cancel`
// failure cascade (turn-ledger commits, incl. stranded-dispatch reclaim
// exhaustion), the operator cancel, an explicit gate abandon and a
// cancel_downstream expiry all close a gate that guards nothing any more.
// These fixtures go through the REAL plan commit (commitMeshGraphPlan), not
// hand-inserted rows, so edge kinds and node states are the production shapes.

/** x, then d (depends_on x, gated_by the given gates). */
function planCascade(mesh: string, opts: { policy?: 'cancel' | 'block'; gates?: Array<Record<string, unknown>> } = {}) {
    currentMesh = mesh;
    const gates = opts.gates ?? [{ ref: 'g1', action: 'approval', deadline_seconds: 3600 }];
    const r = commitMeshGraphPlan({
        meshId: mesh,
        ...(opts.policy ? { onDependencyFailure: opts.policy } : {}),
        tasks: [
            { ref: 'x', message: 'do x', taskMode: 'code_change', difficulty: 'medium' } as any,
            { ref: 'd', message: 'do d', taskMode: 'code_change', difficulty: 'medium', dependsOn: ['x'], gated_by: gates.map(g => g.ref) } as any,
        ],
        gates: gates as any,
    });
    const gateId = (ref: string) => r.gates.find(g => g.ref === ref)!.gateId;
    return { graphId: r.graphId, taskX: r.tasks[0], taskD: r.tasks[1], nodeX: r.nodeIdByIndex[0], nodeD: r.nodeIdByIndex[1], gateId };
}

function abandonRows(mesh: string, graphId: string) {
    return gs().listOutboxEvents(mesh, graphId).filter(e => e.kind === 'graph_gate_abandoned');
}

describe('D3(a) — gate auto-close runs at the terminal choke point for every writer', () => {
    it('★ live shape: mesh_queue_cancel (queue_cancel IPC → cancelTask) on the only gated task closes the open gate', async () => {
        // Live 2026-09-25: gate g1 (deadline 3600 s), task t1 gated_by g1,
        // mesh_queue_cancel t1 → gate stayed awaiting_coordinator.
        const mesh = meshId('ipc');
        currentMesh = mesh;
        const r = commitMeshGraphPlan({
            meshId: mesh,
            tasks: [{ ref: 't1', message: 'do t1', taskMode: 'code_change', difficulty: 'medium', gated_by: ['g1'] } as any],
            gates: [{ ref: 'g1', action: 'approval', deadline_seconds: 3600 }],
        });
        const gateId = r.gates[0].gateId;
        expect(gs().getGate(gateId)!.state).toBe('awaiting_coordinator');

        const res: any = await (meshStoreIpcHandlers as any).queue_cancel({ deps: {} } as any, { v: 1, meshId: mesh, taskId: r.tasks[0].id });
        expect(res.success).toBe(true);
        expect(res.task.status).toBe('cancelled');

        expect(gs().getNode(r.graphId, r.nodeIdByIndex[0])!.state).toBe('cancelled');
        expect(gs().getGate(gateId)!.state).toBe('cancelled');
        const kinds = gs().listOutboxEvents(mesh, r.graphId).map(e => e.kind);
        // Ordering: the node goes terminal BEFORE the gate is closed, in one commit.
        expect(kinds.indexOf('graph_node_terminal')).toBeGreaterThanOrEqual(0);
        expect(kinds.indexOf('graph_gate_abandoned')).toBeGreaterThan(kinds.indexOf('graph_node_terminal'));
        expect(abandonRows(mesh, r.graphId)).toHaveLength(1);
        // The drain after the cancel's commit delivered the abandon row.
        expect(abandonRows(mesh, r.graphId)[0].status).toBe('delivered');
        expect(gs().getGraph(r.graphId)!.status).toBe('cancelled');
    });

    it('a failure cascade (on_dependency_failure: cancel) closes the open gate over the cancelled task', () => {
        const mesh = meshId('cascade');
        const g = planCascade(mesh, { policy: 'cancel' });
        expect(gs().getGate(g.gateId('g1'))!.state).toBe('awaiting_coordinator');

        __writeTaskStatusForTests(mesh, g.taskX.id, 'failed');

        expect(gs().getNode(g.graphId, g.nodeD)!.state).toBe('cancelled');
        const gate = gs().getGate(g.gateId('g1'))!;
        expect(gate.state).toBe('cancelled');
        expect(gate.releaseOutcome).toBeUndefined();
        expect(gs().getNode(g.graphId, gate.nodeId)!.failureReason)
            .toBe(`coordinator_gate_abandoned:${gate.gateId}:${MESH_GATE_AUTO_ABANDON_REASON}`);
        const rows = abandonRows(mesh, g.graphId);
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0].payload)).toMatchObject({ reason: MESH_GATE_AUTO_ABANDON_REASON, auto: true });
        expect(gs().getGraph(g.graphId)!.status).toBe('failed');

        // Replay of the same terminal is fenced — no second abandon row.
        __writeTaskStatusForTests(mesh, g.taskX.id, 'failed');
        expect(abandonRows(mesh, g.graphId)).toHaveLength(1);
    });

    it('the turn-ledger entry point (applyTaskTerminalInTxn + afterTaskTerminalCommitted) closes it and the drain delivers the row', () => {
        const mesh = meshId('ledger');
        const g = planCascade(mesh, { policy: 'cancel' });
        MeshRuntimeStore.getInstance().transaction(() => applyTaskTerminalInTxn({
            meshId: mesh, taskId: g.taskX.id, status: 'failed', occurredAtMs: Date.now(), reason: 'reclaim_budget_exhausted',
        }));
        expect(gs().getGate(g.gateId('g1'))!.state).toBe('cancelled');
        expect(abandonRows(mesh, g.graphId)[0].status).toBe('pending');
        afterTaskTerminalCommitted(mesh, g.taskX.id);
        expect(abandonRows(mesh, g.graphId)[0].status).toBe('delivered');
    });

    it('under the default `block` policy a failure leaves the gate (and its dependent) alone', () => {
        const mesh = meshId('block');
        const g = planCascade(mesh);
        __writeTaskStatusForTests(mesh, g.taskX.id, 'failed');
        expect(gs().getNode(g.graphId, g.nodeD)!.state).not.toBe('cancelled');
        expect(gs().getGate(g.gateId('g1'))!.state).toBe('awaiting_coordinator');
        expect(abandonRows(mesh, g.graphId)).toHaveLength(0);
    });

    it('explicitly abandoning one gate closes a SIBLING gate over the same (now cancelled) task', () => {
        const mesh = meshId('sibling');
        const g = planCascade(mesh, { gates: [{ ref: 'g1', action: 'approval' }, { ref: 'g2', action: 'refinery' }] });
        expect(abandonMeshGraphGate({ meshId: mesh, gateId: g.gateId('g1'), reason: 'operator' }).abandoned).toBe(true);
        expect(gs().getNode(g.graphId, g.nodeD)!.state).toBe('cancelled');
        const g2 = gs().getGate(g.gateId('g2'))!;
        expect(g2.state).toBe('cancelled');
        expect(gs().getNode(g.graphId, g2.nodeId)!.failureReason).toContain(MESH_GATE_AUTO_ABANDON_REASON);
    });

    it('a cancel_downstream deadline expiry closes a sibling gate over the cancelled subtree in the same sweep', () => {
        const mesh = meshId('expirysib');
        const g = planCascade(mesh, { gates: [
            { ref: 'g1', action: 'approval', deadline_seconds: 60, on_timeout: 'cancel_downstream' },
            { ref: 'g2', action: 'refinery', deadline_seconds: 3600 },
        ] });
        const sweep = sweepMeshGraphGateTimeouts(mesh, Date.now() + 5 * 60_000);
        expect(sweep.expiredGateIds).toEqual([g.gateId('g1')]);
        expect(gs().getNode(g.graphId, g.nodeD)!.state).toBe('cancelled');
        expect(gs().getGate(g.gateId('g2'))!.state).toBe('cancelled');
    });

    it('F3 backstop: the housekeeping sweep closes a gate already stranded with all-terminal downstream', () => {
        const mesh = meshId('backstop');
        const g = planCascade(mesh);
        // Simulate a pre-fix stranding (or a writer that bypasses the choke
        // point): the gated task's node is terminal, the gate is still open.
        gs().updateNodeState(g.graphId, g.nodeD, 'cancelled', new Date().toISOString());
        expect(gs().getGate(g.gateId('g1'))!.state).toBe('awaiting_coordinator');

        const sweep = sweepMeshGraphGateTimeouts(mesh);
        expect(sweep.autoClosedGateIds).toEqual([g.gateId('g1')]);
        expect(sweep.expiredGateIds).toEqual([]);
        expect(gs().getGate(g.gateId('g1'))!.state).toBe('cancelled');
        expect(abandonRows(mesh, g.graphId)[0].status).toBe('delivered');
        // Idempotent: the next sweep closes nothing.
        expect(sweepMeshGraphGateTimeouts(mesh).autoClosedGateIds).toEqual([]);
    });
    // F2 (a never-opened gate whose upstream failed under `cancel`) is covered in
    // mesh-graph-stop-notices.test.ts since wave 25.
});

// ── D3(b) ─────────────────────────────────────────────────────────────────────

describe('D3(b) — default deadline, one expiry notice, visible expired state', () => {
    it('a gate opened without deadline_seconds gets now + 24 h (constant exported)', () => {
        expect(MESH_GATE_DEFAULT_DEADLINE_SECONDS).toBe(24 * 60 * 60);
        const mesh = meshId('default');
        const g = build(mesh);
        const before = Date.now();
        const gate = open(mesh, g);
        const deadline = Date.parse(gate.deadlineAt!);
        expect(deadline).toBeGreaterThanOrEqual(before + 24 * HOUR - 1000);
        expect(deadline).toBeLessThanOrEqual(Date.now() + 24 * HOUR + 1000);
        expect(gate.onTimeout).toBe('hold');
    });

    it('env override sets the default; 0 disables it; an explicit deadline_seconds always wins', () => {
        process.env[ENV] = '3600';
        const m1 = meshId('env');
        const g1 = build(m1);
        expect(Date.parse(open(m1, g1).deadlineAt!) - Date.now()).toBeLessThanOrEqual(HOUR + 1000);

        process.env[ENV] = '0';
        const m2 = meshId('off');
        const g2 = build(m2);
        expect(open(m2, g2).deadlineAt).toBeFalsy();

        process.env[ENV] = '3600';
        const m3 = meshId('explicit');
        const g3 = build(m3, { gateSpec: { deadline_seconds: 60 } });
        expect(Date.parse(open(m3, g3).deadlineAt!) - Date.now()).toBeLessThanOrEqual(61_000);
    });

    it('a deadline expiry pages the coordinator EXACTLY once, with mesh/gate/node/ref/age', () => {
        const notices: MeshGraphGateNotification[] = [];
        registerMeshGraphGateNotifyHandler(n => { notices.push(n); });
        const mesh = meshId('notice');
        const g = build(mesh);
        open(mesh, g);
        const t = Date.now() + 25 * HOUR;

        const first = sweepMeshGraphGateTimeouts(mesh, t);
        expect(first.expiredGateIds).toEqual([g.gateId]);
        sweepMeshGraphGateTimeouts(mesh, t + HOUR);
        sweepMeshGraphGateTimeouts(mesh, t + 2 * HOUR);

        const deadline = notices.filter(n => n.kind === 'graph_gate_deadline_expired');
        expect(deadline).toHaveLength(1);
        expect(deadline[0]).toMatchObject({ meshId: mesh, gateId: g.gateId, graphId: g.graphId, nodeId: g.nodeG, ref: 'land', policy: 'hold' });
        expect(deadline[0].ageMs).toBeGreaterThanOrEqual(25 * HOUR - 5000);
        // ★ never a release — elapsed time is not completion evidence.
        expect(gs().getGate(g.gateId)!.state).toBe('expired');
        expect(gs().getGate(g.gateId)!.releaseOutcome).toBeUndefined();
    });

    it('a lease lapse (no deadline passed) never pages graph_gate_deadline_expired', () => {
        const notices: MeshGraphGateNotification[] = [];
        registerMeshGraphGateNotifyHandler(n => { notices.push(n); });
        const mesh = meshId('lapse');
        const g = build(mesh);
        open(mesh, g);
        const t0 = Date.now();
        claimMeshGraphGate({ meshId: mesh, gateId: g.gateId, coordinatorSessionId: 'c1', nowMs: t0, leaseSeconds: 60 });
        const sweep = sweepMeshGraphGateTimeouts(mesh, t0 + 10 * 60_000);
        expect(sweep.expiredLeaseGateIds).toEqual([g.gateId]);
        expect(notices.filter(n => n.kind === 'graph_gate_deadline_expired')).toHaveLength(0);
    });

    it('a pre-existing open gate with no deadline is backfilled from THIS sweep (never expired retroactively)', () => {
        process.env[ENV] = '0';
        const mesh = meshId('backfill');
        const g = build(mesh);
        expect(open(mesh, g).deadlineAt).toBeFalsy();
        delete process.env[ENV];
        const t = Date.now() + 100 * HOUR; // the gate has been open "for days"
        const sweep = sweepMeshGraphGateTimeouts(mesh, t);
        expect(sweep.expiredGateIds).toEqual([]);
        expect(sweep.backfilledDeadlineGateIds).toEqual([g.gateId]);
        expect(Date.parse(gs().getGate(g.gateId)!.deadlineAt!)).toBe(t + 24 * HOUR);
    });

    it('an expired gate stays in the mesh_status blocked listing with state `expired` and age', async () => {
        const mesh = meshId('listing');
        const g = build(mesh);
        open(mesh, g);
        sweepMeshGraphGateTimeouts(mesh, Date.now() + 25 * HOUR);

        const listing = listMeshBlockedGates(mesh, Date.now() + 26 * HOUR);
        expect(listing.expiredGatesTotal).toBe(1);
        expect(listing.blockedGates[0]).toMatchObject({ gateId: g.gateId, state: 'expired', ref: 'land' });
        expect(listing.blockedGates[0].ageMs).toBeGreaterThanOrEqual(26 * HOUR - 5000);

        // The same rows ride active_work_query → activeWork.summary (mesh_status activeWorkSummary).
        const res: any = await meshStoreIpcHandlers.active_work_query({ deps: {} } as any, { v: 1, meshId: mesh, nodes: [] });
        expect(res.success).toBe(true);
        expect(res.activeWork.summary.blockedGates.map((r: any) => [r.gateId, r.state])).toEqual([[g.gateId, 'expired']]);
        expect(res.activeWork.summary.graphUsage).toMatchObject({ graphsLast7d: 1, gatesExpired: 1 });
    });
});

// ── D3(c) extend (engine) ─────────────────────────────────────────────────────

describe('D3(c) — extendMeshGraphGateDeadline', () => {
    it('reopens an expired-hold gate and pushes the deadline from now', () => {
        const mesh = meshId('extend');
        const g = build(mesh);
        open(mesh, g);
        const t = Date.now() + 25 * HOUR;
        sweepMeshGraphGateTimeouts(mesh, t);
        expect(gs().getGate(g.gateId)!.state).toBe('expired');

        const res = extendMeshGraphGateDeadline({ meshId: mesh, gateId: g.gateId, extendSeconds: 24 * 3600, nowMs: t });
        expect(res).toMatchObject({ extended: true, reopened: true });
        const gate = gs().getGate(g.gateId)!;
        expect(gate.state).toBe('awaiting_coordinator');
        expect(Date.parse(gate.deadlineAt!)).toBe(t + 24 * HOUR);
        expect(gs().getNode(g.graphId, g.nodeG)!.state).toBe('awaiting_coordinator');
        // Reopened — the next deadline pages again (a new expiry, not a replay).
        const notices: MeshGraphGateNotification[] = [];
        registerMeshGraphGateNotifyHandler(n => { notices.push(n); });
        sweepMeshGraphGateTimeouts(mesh, t + 25 * HOUR);
        expect(notices.filter(n => n.kind === 'graph_gate_deadline_expired')).toHaveLength(1);
    });

    it('extends an open gate from max(now, deadline) without changing its state', () => {
        const mesh = meshId('extend_open');
        const g = build(mesh);
        const deadline = Date.parse(open(mesh, g).deadlineAt!);
        const res = extendMeshGraphGateDeadline({ meshId: mesh, gateId: g.gateId, extendSeconds: 3600 });
        expect(res.extended).toBe(true);
        expect(Date.parse(res.deadlineAt!)).toBe(deadline + HOUR);
        expect(gs().getGate(g.gateId)!.state).toBe('awaiting_coordinator');
    });

    it('refuses terminal gates and nonsense durations', () => {
        const mesh = meshId('extend_refuse');
        const g = build(mesh);
        open(mesh, g);
        expect(extendMeshGraphGateDeadline({ meshId: mesh, gateId: g.gateId, extendSeconds: 0 }).reason).toBe('invalid_extend_seconds');
        const claim = claimMeshGraphGate({ meshId: mesh, gateId: g.gateId, coordinatorSessionId: 'c1' });
        releaseMeshGraphGate({
            meshId: mesh, gateId: g.gateId, fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
            idempotencyKey: 'k1', outcome: 'passed',
        });
        expect(extendMeshGraphGateDeadline({ meshId: mesh, gateId: g.gateId, extendSeconds: 60 }).reason).toBe('gate_terminal:released');
        expect(extendMeshGraphGateDeadline({ meshId: mesh, gateId: 'nope', extendSeconds: 60 }).reason).toBe('gate_not_found');
    });
});
