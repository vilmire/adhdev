import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// Wave 25 — stopped downstream work is always settled AND always told.
// the 2026-09-25 graph orchestration simplification §5.
//
//   F1  every queue-side terminal writer (retry cap, dispatch-failure cap,
//       undeliverable, park retention, the queue dependency cascade) goes
//       through the graph runner: the node goes terminal with its row, the
//       failure policy applies, and the gate auto-close runs. Before, the row
//       flipped alone and the graph sat `active` forever.
//   F2  under `on_dependency_failure: cancel` the cascade crosses gates: a gate
//       whose upstream failed can never open, so it is abandoned
//       (`upstream_failed`) and what it guards is cancelled, recursively.
//       `block` leaves everything for the coordinator.
//   N   the coordinator is told, once, with ids/refs/codes and the next tools:
//       (a) graph_dependency_blocked  (b) graph_dependency_cancelled
//       (c) graph_stalled (housekeeping) — through the same notice row a
//       PTY-hosted and an MCP-only coordinator both read.

const testTmpDir = path.join(tmpdir(), `adhdev-graph-stop-${randomUUID().slice(0, 8)}`);
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
const meshConfig = vi.hoisted(() => ({ policy: undefined as Record<string, unknown> | undefined }));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(() => (meshConfig.policy ? { id: 'm', policy: meshConfig.policy } : undefined)),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
    getDifficultyBrains: vi.fn(() => undefined),
}));

import {
    drainMeshGraphOutbox,
    registerMeshGraphGateNotifyHandler,
    registerMeshGraphStopNotifyHandler,
    __resetMeshGraphTransitionRunnerForTests,
} from '../../src/mesh/mesh-graph-transition-runner.js';
import { commitMeshGraphPlan } from '../../src/mesh/mesh-graph-plan.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    __writeTaskStatusForTests,
    cancelTask,
    enqueueTask,
    failRetentionExpiredParkedTask,
    getQueueEntryById,
    requeueTask,
} from '../../src/mesh/mesh-work-queue.js';
import { meshRuntimeTxnHost } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    parseGraphStopOutbox,
    reasonCodeOf,
    renderGraphStopNotice,
    type MeshGraphStopNotice,
} from '../../src/mesh/mesh-graph-stop-notice.js';
import { detectGraphStall, sweepMeshGraphStalls } from '../../src/mesh/mesh-graph-stall.js';
import { sweepMeshGraphGateTimeouts } from '../../src/mesh/mesh-graph-gates.js';
import { sweepMeshGraphStaleness } from '../../src/mesh/mesh-graph-staleness.js';
import { bindMeshNoticeRuntime, createCoordinatorNotifier, createTurnDeliverCounters, createTurnDeliverHandler, readCoordinatorNotices, type CoordinatorNotice, type TurnDeliverDeps } from '../../src/mesh/turn-ledger/deliver.js';
import { T0, fakePublisher, ledgerOn, memDb } from '../turn-ledger/ledger-harness.js';

/** Never allowed in any notice: task message text and operator free text. */
const SECRET = 'SECRET-7c1e-task-body-never-in-a-notice';

let currentMesh: string | undefined;
afterEach(() => {
    if (currentMesh) __clearMeshQueueForTests(currentMesh);
    currentMesh = undefined;
    meshConfig.policy = undefined;
    bindMeshNoticeRuntime(null);
    __resetMeshRuntimeStoreForTests();
    __resetMeshGraphTransitionRunnerForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function gs() {
    return MeshRuntimeStore.getInstance().graphStore();
}

function newMesh(tag: string): string {
    currentMesh = `mesh_stop_${tag}_${randomUUID().slice(0, 8)}`;
    return currentMesh;
}

const task = (ref: string, extra: Record<string, unknown> = {}) =>
    ({ ref, message: `${SECRET} ${ref}`, taskMode: 'code_change', difficulty: 'medium', ...extra } as any);

function plan(mesh: string, tasks: any[], gates: any[] = [], policy?: 'cancel' | 'block') {
    const r = commitMeshGraphPlan({ meshId: mesh, tasks, gates, ...(policy ? { onDependencyFailure: policy } : {}) });
    const byRef = (ref: string) => {
        const i = tasks.findIndex(t => t.ref === ref);
        return { taskId: r.tasks[i].id, nodeId: r.nodeIdByIndex[i] };
    };
    const gate = (ref: string) => r.gates.find(g => g.ref === ref)!;
    return { graphId: r.graphId, byRef, gate };
}

function outboxOf(mesh: string, graphId: string, kind: string) {
    return gs().listOutboxEvents(mesh, graphId).filter(e => e.kind === kind);
}

/** A notice runtime that dedupes on eventId like the turn_events PK does. */
function captureNotices(): CoordinatorNotice[] {
    const seen = new Set<string>();
    const out: CoordinatorNotice[] = [];
    bindMeshNoticeRuntime({
        notify(notice: CoordinatorNotice) {
            const id = notice.eventId ?? `${notice.event}:${out.length}`;
            if (seen.has(id)) return { eventId: id, queued: false };
            seen.add(id);
            out.push(notice);
            return { eventId: id, queued: true };
        },
        retract: () => 0,
    } as any);
    return out;
}

// ── F1 ────────────────────────────────────────────────────────────────────────

describe('F1 — queue-side terminal writers go through the graph runner', () => {
    it('retry-cap exhaustion (also failTaskAsUndeliverable, maxRetries:0) fails the NODE, applies the cancel cascade, and rolls the graph', () => {
        const mesh = newMesh('retrycap');
        const g = plan(mesh, [task('x'), task('d', { dependsOn: ['x'] })], [], 'cancel');
        const failed = requeueTask(mesh, g.byRef('x').taskId, { maxRetries: 0, reason: 'undeliverable' });
        expect(failed?.status).toBe('failed');
        expect(failed?.cancelReason).toMatch(/^max_retries_exceeded/);
        expect(gs().getNode(g.graphId, g.byRef('x').nodeId)!.state).toBe('failed');
        expect(gs().getNode(g.graphId, g.byRef('d').nodeId)!.state).toBe('cancelled');
        expect(gs().getGraph(g.graphId)!.status).toBe('failed');
    });

    it('dispatch-failure-cap exhaustion fails the node too', () => {
        const mesh = newMesh('dispatchcap');
        const g = plan(mesh, [task('x')]);
        const store = MeshRuntimeStore.getInstance();
        const row = store.findQueueEntryById(mesh, g.byRef('x').taskId)!;
        row.dispatchFailureCount = 5;
        store.updateQueueEntry(row);
        const failed = requeueTask(mesh, g.byRef('x').taskId, { dispatchFailure: true });
        expect(failed?.status).toBe('failed');
        expect(failed?.cancelReason).toMatch(/^dispatch_never_started/);
        expect(gs().getNode(g.graphId, g.byRef('x').nodeId)!.state).toBe('failed');
        expect(gs().getGraph(g.graphId)!.status).toBe('failed');
    });

    it('park-retention expiry fails the node too', () => {
        const mesh = newMesh('park');
        const g = plan(mesh, [task('x')]);
        const store = MeshRuntimeStore.getInstance();
        const row = store.findQueueEntryById(mesh, g.byRef('x').taskId)!;
        row.parked = { reason: 'target_session_gone', parkedAt: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString(), targetSessionId: 's-gone' } as any;
        store.updateQueueEntry(row);
        const failed = failRetentionExpiredParkedTask(mesh, g.byRef('x').taskId);
        expect(failed?.status).toBe('failed');
        expect(gs().getNode(g.graphId, g.byRef('x').nodeId)!.state).toBe('failed');
        expect(gs().getNode(g.graphId, g.byRef('x').nodeId)!.failureReason).toMatch(/^parked_task_retention_expired/);
    });

    it('the queue dependency cascade (mesh policy cancel) cancels the dependent NODE with its row, even under graph policy block', () => {
        const mesh = newMesh('qcascade');
        meshConfig.policy = { onDependencyFailure: 'cancel' };
        const g = plan(mesh, [task('x'), task('d', { dependsOn: ['x'] })]); // graph policy: block
        requeueTask(mesh, g.byRef('x').taskId, { maxRetries: 0 });
        const d = MeshRuntimeStore.getInstance().findQueueEntryById(mesh, g.byRef('d').taskId)!;
        expect(d.status).toBe('cancelled');
        expect(d.cancelReason).toBe(`dependency_failed:${g.byRef('x').taskId}`);
        // ★ before F1 the node stayed `blocked` under a cancelled row
        expect(gs().getNode(g.graphId, g.byRef('d').nodeId)!.state).toBe('cancelled');
        expect(gs().getGraph(g.graphId)!.status).not.toBe('active');
    });
});

// ── F2 ────────────────────────────────────────────────────────────────────────

describe('F2 — under `cancel`, a failure cascade crosses gates', () => {
    it('a never-opened gate whose upstream failed is abandoned (upstream_failed) and the task it guards is cancelled', () => {
        const mesh = newMesh('f2');
        const g = plan(mesh, [task('x'), task('d', { gated_by: ['g1'] })], [{ ref: 'g1', action: 'approval', depends_on: ['x'] }], 'cancel');
        __writeTaskStatusForTests(mesh, g.byRef('x').taskId, 'failed');
        const gate = gs().getGate(g.gate('g1').gateId)!;
        expect(gate.state).toBe('cancelled');
        expect(gs().getNode(g.graphId, gate.nodeId)!.failureReason).toBe(`coordinator_gate_abandoned:${gate.gateId}:upstream_failed`);
        expect(gs().getNode(g.graphId, g.byRef('d').nodeId)!.state).toBe('cancelled');
        expect(MeshRuntimeStore.getInstance().findQueueEntryById(mesh, g.byRef('d').taskId)!.status).toBe('cancelled');
        expect(gs().getGraph(g.graphId)!.status).toBe('failed');
    });

    it('recursively: x → g1 → d → g2 → e all close', () => {
        const mesh = newMesh('f2rec');
        const g = plan(mesh, [
            task('x'),
            task('d', { gated_by: ['g1'] }),
            task('e', { gated_by: ['g2'] }),
        ], [
            { ref: 'g1', action: 'approval', depends_on: ['x'] },
            { ref: 'g2', action: 'refinery', depends_on: ['d'] },
        ], 'cancel');
        __writeTaskStatusForTests(mesh, g.byRef('x').taskId, 'failed');
        expect(gs().getGate(g.gate('g1').gateId)!.state).toBe('cancelled');
        expect(gs().getGate(g.gate('g2').gateId)!.state).toBe('cancelled');
        expect(gs().getNode(g.graphId, g.byRef('d').nodeId)!.state).toBe('cancelled');
        expect(gs().getNode(g.graphId, g.byRef('e').nodeId)!.state).toBe('cancelled');
        expect(gs().getGraph(g.graphId)!.status).toBe('failed');
        // Exactly one rollup row — the gate abandon's rollup and the runner's never double.
        expect(outboxOf(mesh, g.graphId, 'graph_failed')).toHaveLength(1);
    });

    it('under `block` the gate and its task are left for the coordinator', () => {
        const mesh = newMesh('f2block');
        const g = plan(mesh, [task('x'), task('d', { gated_by: ['g1'] })], [{ ref: 'g1', action: 'approval', depends_on: ['x'] }]);
        __writeTaskStatusForTests(mesh, g.byRef('x').taskId, 'failed');
        expect(gs().getGate(g.gate('g1').gateId)!.state).toBe('declared');
        expect(gs().getNode(g.graphId, g.byRef('d').nodeId)!.state).not.toBe('cancelled');
    });
});

// ── N ─────────────────────────────────────────────────────────────────────────

/** Record every stop notice the drain pages (register BEFORE the terminal: its own commit drains). */
function recordStops(): MeshGraphStopNotice[] {
    const got: MeshGraphStopNotice[] = [];
    registerMeshGraphStopNotifyHandler(n => { got.push(n); });
    return got;
}

describe('N(a) — block policy: a failure that leaves downstream blocked', () => {
    it('writes ONE graph_dependency_blocked row naming the failure, the blocked steps and gates, and pages it once', () => {
        const mesh = newMesh('na');
        const g = plan(mesh, [task('x'), task('d', { dependsOn: ['x'] }), task('e', { gated_by: ['g1'] })],
            [{ ref: 'g1', action: 'approval', depends_on: ['x'] }]);
        const paged = recordStops();
        requeueTask(mesh, g.byRef('x').taskId, { maxRetries: 0, reason: SECRET });
        const rows = outboxOf(mesh, g.graphId, 'graph_dependency_blocked');
        expect(rows).toHaveLength(1);
        const notice = parseGraphStopOutbox(rows[0].kind, mesh, rows[0].payload)!;
        expect(notice.kind).toBe('graph_dependency_blocked');
        if (notice.kind !== 'graph_dependency_blocked') throw new Error('kind');
        expect(notice.root).toMatchObject({ ref: 'x', taskId: g.byRef('x').taskId, outcome: 'failed', reasonCode: 'max_retries_exceeded' });
        expect(notice.blocked.map(b => b.ref).sort()).toEqual(['d', 'g1']);
        expect(notice.blocked.find(b => b.ref === 'g1')).toMatchObject({ kind: 'coordinator_gate', gateId: g.gate('g1').gateId });

        const rendered = renderGraphStopNotice(notice);
        expect(rendered.event).toBe('mesh:graph_dependency_blocked');
        expect(rendered.eventId).toBe(`graph:graph_dependency_blocked:${g.graphId}:${g.byRef('x').nodeId}:${notice.generation}`);
        expect(rendered.coordinatorMessage).toContain(`mesh_queue_requeue(task_id='${g.byRef('x').taskId}', force=true)`);
        expect(rendered.coordinatorMessage).toContain(`mesh_queue_cancel(task_id=…) for '${g.byRef('d').taskId}'`);
        expect(rendered.coordinatorMessage).toContain(`mesh_graph_gate(action="abandon", gate_id=…) for '${g.gate('g1').gateId}'`);
        expect(rendered.coordinatorMessage).toContain(`mesh_graph_node_patch(node='d', graph_id='${g.graphId}')`);
        expect(JSON.stringify(rendered)).not.toContain(SECRET);

        // Graph-backed tasks are told by the graph notice only — never a queue-chain one too.
        expect(gs().listOutboxEventsByKinds(mesh, ['queue_dependency_blocked', 'queue_dependency_cancelled'])).toHaveLength(0);
        // Paged by the commit's own drain, exactly once; a re-drain pages nothing.
        expect(paged).toHaveLength(1);
        drainMeshGraphOutbox(mesh);
        expect(paged).toHaveLength(1);
        expect(rows[0].status).toBe('delivered');
    });

    it('a plain cancel under block, or a failure with nothing downstream, writes no blocked notice', () => {
        const mesh = newMesh('nanone');
        const g = plan(mesh, [task('x'), task('d', { dependsOn: ['x'] }), task('solo')]);
        cancelTask(mesh, g.byRef('x').taskId, { reason: SECRET });
        requeueTask(mesh, g.byRef('solo').taskId, { maxRetries: 0 });
        expect(outboxOf(mesh, g.graphId, 'graph_dependency_blocked')).toHaveLength(0);
    });
});

describe('N(b) — cancel policy: a failure that cancelled downstream work', () => {
    it('writes ONE graph_dependency_cancelled row listing the cancelled steps, abandoned gates and the root failure', () => {
        const mesh = newMesh('nb');
        const g = plan(mesh, [task('x'), task('d', { dependsOn: ['x'] }), task('e', { gated_by: ['g1'] })],
            [{ ref: 'g1', action: 'approval', depends_on: ['x'] }], 'cancel');
        const paged = recordStops();
        __writeTaskStatusForTests(mesh, g.byRef('x').taskId, 'failed');
        const rows = outboxOf(mesh, g.graphId, 'graph_dependency_cancelled');
        expect(rows).toHaveLength(1);
        const notice = parseGraphStopOutbox(rows[0].kind, mesh, rows[0].payload)!;
        if (notice.kind !== 'graph_dependency_cancelled') throw new Error('kind');
        expect(notice.root).toMatchObject({ ref: 'x', outcome: 'failed', reasonCode: 'task_status_terminal' });
        expect(notice.cancelled.map(c => c.ref).sort()).toEqual(['d', 'e']);
        expect(notice.abandonedGates).toEqual([{ gateId: g.gate('g1').gateId, ref: 'g1', reason: 'upstream_failed' }]);
        const rendered = renderGraphStopNotice(notice);
        expect(rendered.coordinatorMessage).toContain('2 downstream step(s) were cancelled');
        expect(rendered.coordinatorMessage).toContain("1 gate(s) abandoned: 'g1' (upstream_failed)");
        expect(JSON.stringify(rendered)).not.toContain(SECRET);
        expect(paged).toHaveLength(1);
        // A replayed terminal is fenced before any notice is written.
        __writeTaskStatusForTests(mesh, g.byRef('x').taskId, 'failed');
        expect(outboxOf(mesh, g.graphId, 'graph_dependency_cancelled')).toHaveLength(1);
    });

    it('an operator cancel reason never reaches the notice (reason code collapses to operator_cancel)', () => {
        const mesh = newMesh('nbop');
        const g = plan(mesh, [task('x'), task('d', { dependsOn: ['x'] })], [], 'cancel');
        cancelTask(mesh, g.byRef('x').taskId, { reason: `${SECRET}: because` });
        const rows = outboxOf(mesh, g.graphId, 'graph_dependency_cancelled');
        expect(rows).toHaveLength(1);
        expect(rows[0].payload).not.toContain(SECRET);
        expect(JSON.parse(rows[0].payload).root.reasonCode).toBe('operator_cancel');
    });
});

describe('N(c) — a graph that is active but cannot move', () => {
    it('pages ONCE per stuck configuration; a runnable or running graph never pages', () => {
        const mesh = newMesh('nc');
        const notices = captureNotices();
        // block policy; the coordinator cancels x → d waits forever, and no (a)
        // notice covers it (a cancel is not a failure).
        const g = plan(mesh, [task('x'), task('d', { dependsOn: ['x'] })]);
        expect(detectGraphStall(mesh, g.graphId)).toBeNull(); // x is runnable
        cancelTask(mesh, g.byRef('x').taskId);
        const first = sweepMeshGraphStalls(mesh);
        expect(first).toMatchObject({ stalledGraphs: 1, noticesQueued: 1 });
        expect(sweepMeshGraphStalls(mesh)).toMatchObject({ stalledGraphs: 1, noticesQueued: 0 });
        expect(notices).toHaveLength(1);
        expect(notices[0].event).toBe('mesh:graph_stalled');
        expect(notices[0].coordinatorMessage).toContain(`mesh_queue_requeue(task_id=…, force=true) for '${g.byRef('x').taskId}'`);
        expect(notices[0].coordinatorMessage).toContain(`mesh_queue_cancel(task_id=…) for '${g.byRef('d').taskId}'`);
        expect(JSON.stringify(notices[0])).not.toContain(SECRET);
    });

    it('is suppressed when the stuck work is already explained by a paged blocked notice', () => {
        const mesh = newMesh('ncexpl');
        const notices = captureNotices();
        const g = plan(mesh, [task('x'), task('d', { dependsOn: ['x'] })]);
        requeueTask(mesh, g.byRef('x').taskId, { maxRetries: 0 }); // failed → (a) row written
        expect(outboxOf(mesh, g.graphId, 'graph_dependency_blocked')).toHaveLength(1);
        expect(sweepMeshGraphStalls(mesh).stalledGraphs).toBe(0);
        expect(notices).toHaveLength(0);
    });

    it('names a materialization-error block with the patch tool', () => {
        const mesh = newMesh('ncmat');
        captureNotices();
        const g = plan(mesh, [task('x')]);
        const store = MeshRuntimeStore.getInstance();
        const row = store.findQueueEntryById(mesh, g.byRef('x').taskId)!;
        row.blockedReason = 'materialization_error:required_input_missing:/result/x';
        store.updateQueueEntry(row);
        gs().updateNodeState(g.graphId, g.byRef('x').nodeId, 'blocked', new Date().toISOString());
        const stall = detectGraphStall(mesh, g.graphId)!;
        expect(stall.stuck[0]).toMatchObject({ ref: 'x', reasonCode: 'materialization_error' });
        expect(renderGraphStopNotice(stall).coordinatorMessage).toContain(`mesh_graph_node_patch(node=…, graph_id='${g.graphId}')`);
    });
});

describe('N delivery — one notice row serves a PTY-hosted AND an MCP-only coordinator', () => {
    function deliverFixture() {
        const db = memDb();
        const publisher = fakePublisher('w-dc');
        const clock = { now: T0 };
        const ledger = ledgerOn(db, { publisher, now: () => clock.now, selfDaemonId: 'dc' });
        const calls: any[] = [];
        const deps: TurnDeliverDeps = {
            ledger,
            selfDaemonIds: () => ['dc'],
            port: { async submit(msg: any) { calls.push(msg); return { kind: 'delivered' } as any; } },
            coordinators: () => [{ sessionId: 'coord', idle: true, modalParked: false }],
            waiter: { wait: async () => 'edge' as const, wake: () => {} } as any,
            now: () => clock.now,
            counters: createTurnDeliverCounters(),
        };
        const notifier = createCoordinatorNotifier({ ledger, selfDaemonIds: () => ['dc'], now: () => clock.now });
        return { ledger, publisher, deps, calls, notifier };
    }

    const notice: MeshGraphStopNotice = {
        kind: 'graph_dependency_blocked', meshId: 'm1', graphId: 'g-1234567890', generation: 1,
        root: { nodeId: 'n-x', ref: 'x', taskId: 't-x', outcome: 'failed', reasonCode: 'max_retries_exceeded' },
        blocked: [{ nodeId: 'n-d', ref: 'd', kind: 'worker_task', taskId: 't-d' }],
    };

    it('PTY: the deliver cursor injects the rendered text; the same eventId never queues twice', async () => {
        const f = deliverFixture();
        const r = renderGraphStopNotice(notice);
        const n = { meshId: 'm1', event: r.event, nodeLabel: r.nodeLabel, eventId: r.eventId, metadataEvent: r.metadataEvent, coordinatorMessage: r.coordinatorMessage };
        expect(f.notifier.notify(n).queued).toBe(true);
        expect(f.notifier.notify(n).queued).toBe(false);
        await f.ledger.flushPublish();
        const e = f.publisher.entries.find(x => x.entry.k === 'turn.notify')!;
        // The topic entry carries no text — only the local row does.
        expect(JSON.stringify(e.entry)).not.toContain('blocked waiting on it');
        const res = await createTurnDeliverHandler(f.deps)({ meshId: e.meshId, writer: e.writer, seq: e.seq, kind: e.entry.k, payload: e.entry, own: true } as any, new AbortController().signal);
        expect(res).toMatchObject({ outcome: 'delivered' });
        expect(f.calls[0].input.textFallback).toContain(r.coordinatorMessage);
    });

    it('MCP-only: get_pending_mesh_events (readCoordinatorNotices) returns the same text', async () => {
        const f = deliverFixture();
        const r = renderGraphStopNotice(notice);
        f.notifier.notify({ meshId: 'm1', event: r.event, nodeLabel: r.nodeLabel, eventId: r.eventId, metadataEvent: r.metadataEvent, coordinatorMessage: r.coordinatorMessage });
        await f.ledger.flushPublish();
        const read = readCoordinatorNotices(f.deps, 'm1');
        expect(read).toHaveLength(1);
        expect(JSON.stringify(read[0])).toContain('mesh_queue_requeue');
    });
});

// ── Graph terminal ⇒ no open gate survives ────────────────────────────────────

describe('a graph that goes terminal closes every still-open gate (graph_terminal), without an extra page', () => {
    it('a fail_graph deadline expiry closes the other open gates — awaiting and never-opened — and pages only the expiry', () => {
        const mesh = newMesh('failgraph');
        const g = plan(mesh, [task('x'), task('d', { gated_by: ['g1', 'g2'] }), task('e', { gated_by: ['g3'] })], [
            { ref: 'g1', action: 'deploy', deadline_seconds: 60, on_timeout: 'fail_graph' },
            { ref: 'g2', action: 'approval', deadline_seconds: 3600 },
            { ref: 'g3', action: 'refinery', depends_on: ['x'] },
        ]);
        expect(gs().getGate(g.gate('g2').gateId)!.state).toBe('awaiting_coordinator');
        expect(gs().getGate(g.gate('g3').gateId)!.state).toBe('declared');
        drainMeshGraphOutbox(mesh); // the commit-time `awaiting` pages are not what this test counts
        const gatePages: string[] = [];
        registerMeshGraphGateNotifyHandler(n => { gatePages.push(`${n.kind}:${n.ref}`); });
        const stops = recordStops();
        const notices = captureNotices();

        const sweep = sweepMeshGraphGateTimeouts(mesh, Date.now() + 5 * 60_000);
        expect(sweep.expiredGateIds).toEqual([g.gate('g1').gateId]);
        expect(gs().getGraph(g.graphId)!.status).toBe('failed');
        // The gate whose policy fired keeps `expired` (its policy is the record).
        expect(gs().getGate(g.gate('g1').gateId)!.state).toBe('expired');
        for (const ref of ['g2', 'g3']) {
            const gate = gs().getGate(g.gate(ref).gateId)!;
            expect(gate.state).toBe('cancelled');
            expect(gs().getNode(g.graphId, gate.nodeId)!.failureReason).toBe(`coordinator_gate_abandoned:${gate.gateId}:graph_terminal`);
        }
        // Exactly one page: the deadline expiry. No stop notice, no abandon page.
        expect(gatePages).toEqual(['graph_gate_deadline_expired:g1']);
        expect(stops).toHaveLength(0);
        // …and nothing keeps paging afterwards (no stale gate reminder either).
        expect(sweepMeshGraphStaleness(mesh, { nowMs: Date.now() + 10 * 24 * 3_600_000, staleThresholdMs: 3_600_000, reminderWindowMs: 3_600_000 }).remindersQueued).toBe(0);
        expect(notices).toHaveLength(0);
    });

    it('closing the gates never re-rolls the status the terminal path decided (fail_graph stays failed)', () => {
        // Only gated work: the graph_terminal abandons cancel `d`, after which a
        // re-roll would compute `cancelled` and overwrite fail_graph's `failed`.
        const mesh = newMesh('noreroll');
        const g = plan(mesh, [task('d', { gated_by: ['g1', 'g2'] })], [
            { ref: 'g1', action: 'deploy', deadline_seconds: 60, on_timeout: 'fail_graph' },
            { ref: 'g2', action: 'approval', deadline_seconds: 3600 },
        ]);
        sweepMeshGraphGateTimeouts(mesh, Date.now() + 5 * 60_000);
        expect(gs().getNode(g.graphId, g.byRef('d').nodeId)!.state).toBe('cancelled');
        expect(gs().getGraph(g.graphId)!.status).toBe('failed');
        expect(outboxOf(mesh, g.graphId, 'graph_cancelled')).toHaveLength(0);
    });

    it('a rollup past an expired-hold gate with nothing behind it closes that gate too', () => {
        const mesh = newMesh('rollupexp');
        const g = plan(mesh, [task('a'), task('b')], [{ ref: 'g1', action: 'approval', depends_on: ['a'], deadline_seconds: 60 }]);
        __writeTaskStatusForTests(mesh, g.byRef('a').taskId, 'completed');
        sweepMeshGraphGateTimeouts(mesh, Date.now() + 5 * 60_000);
        expect(gs().getGate(g.gate('g1').gateId)!.state).toBe('expired'); // hold
        __writeTaskStatusForTests(mesh, g.byRef('b').taskId, 'completed');
        expect(['completed', 'cancelled']).toContain(gs().getGraph(g.graphId)!.status);
        const gate = gs().getGate(g.gate('g1').gateId)!;
        expect(gate.state).toBe('cancelled');
        expect(gs().getNode(g.graphId, gate.nodeId)!.failureReason).toBe(`coordinator_gate_abandoned:${gate.gateId}:graph_terminal`);
        expect(gs().listOutboxEvents(mesh, g.graphId).filter(e => e.kind.startsWith('graph_') && /^graph_(completed|failed|cancelled)$/.test(e.kind))).toHaveLength(1);
    });
});

// ── Queue-level depends_on chains (the D1 default path — no graph rows) ──────

/** root ← e ← f, via mesh_enqueue_task-style queue rows. */
function queueChain(mesh: string) {
    const opts = { taskMode: 'code_change', difficulty: 'medium' } as any;
    const root = enqueueTask(mesh, `${SECRET} root`, opts);
    const e = enqueueTask(mesh, `${SECRET} e`, { ...opts, dependsOn: [root.id] });
    const f = enqueueTask(mesh, `${SECRET} f`, { ...opts, dependsOn: [e.id] });
    return { root, e, f };
}

function queueRows(mesh: string, kind: string) {
    return gs().listOutboxEventsByKinds(mesh, [kind]);
}

describe('queue chains — the default block policy is kept, and made visible', () => {
    it('★ live shape: cancelling a chain root pages ONCE "N tasks still wait on the task you cancelled"; dependents stay pending', () => {
        const mesh = newMesh('qcancel');
        const q = queueChain(mesh);
        const paged = recordStops();
        cancelTask(mesh, q.root.id, { reason: `${SECRET}: no longer needed` });

        // block (default) is preserved: nothing is cancelled silently.
        expect(getQueueEntryById(mesh, q.e.id)!.status).toBe('pending');
        expect(getQueueEntryById(mesh, q.f.id)!.status).toBe('pending');
        const rows = queueRows(mesh, 'queue_dependency_blocked');
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('delivered');
        expect(rows[0].payload).not.toContain(SECRET);
        expect(paged).toHaveLength(1);
        const n = paged[0];
        if (n.kind !== 'queue_dependency_blocked') throw new Error('kind');
        expect(n.root).toEqual({ taskId: q.root.id, outcome: 'cancelled', reasonCode: 'operator_cancel' });
        expect(n.waiting).toEqual([{ taskId: q.e.id }, { taskId: q.f.id, via: q.e.id }]);
        const r = renderGraphStopNotice(n);
        expect(r.event).toBe('mesh:queue_dependency_blocked');
        expect(r.coordinatorMessage.startsWith(`2 task(s) still wait on the task you cancelled, ${q.root.id.slice(0, 8)} (task_id ${q.root.id})`)).toBe(true);
        expect(r.coordinatorMessage).toContain(`mesh_queue_cancel(task_id=…) for '${q.e.id}', '${q.f.id}'`);
        expect(r.coordinatorMessage).toContain(`mesh_queue_requeue(task_id='${q.root.id}', force=true)`);
        expect(JSON.stringify(r)).not.toContain(SECRET);
        // Nothing left for the stall sweep: the notice covers this chain.
        const notices = captureNotices();
        expect(sweepMeshGraphStalls(mesh).stalledQueueChains).toBe(0);
        expect(notices).toHaveLength(0);
    });

    it('a failed root names its reason code and the retry', () => {
        const mesh = newMesh('qfail');
        const q = queueChain(mesh);
        requeueTask(mesh, q.root.id, { maxRetries: 0 });
        const n = parseGraphStopOutbox('queue_dependency_blocked', mesh, queueRows(mesh, 'queue_dependency_blocked')[0].payload)!;
        const r = renderGraphStopNotice(n);
        expect(r.coordinatorMessage).toContain(`Queue task ${q.root.id.slice(0, 8)} (task_id ${q.root.id}) failed (reason: max_retries_exceeded) and 2 task(s) still wait on it`);
        expect(r.coordinatorMessage).toContain(`retry it with mesh_queue_requeue(task_id='${q.root.id}', force=true)`);
    });

    it('the ledger path (meshRuntimeTxnHost.graphAdvance) carries its machine reason code', () => {
        const mesh = newMesh('qledger');
        const q = queueChain(mesh);
        const now = Date.now();
        MeshRuntimeStore.getInstance().transaction(() => meshRuntimeTxnHost.graphAdvance(
            { kind: 'graph_advance', meshId: mesh, taskId: q.root.id, outcome: 'failed' } as any,
            { nowMs: now, attempt: { sessionId: 's1', attemptId: 'a1', attemptNo: 0, terminal: { reason: 'reclaim_budget_exhausted', at: now } } } as any,
        ));
        const payload = JSON.parse(queueRows(mesh, 'queue_dependency_blocked')[0].payload);
        expect(payload.root.reasonCode).toBe('reclaim_budget_exhausted');
    });

    it('under mesh policy cancel: ONE queue_dependency_cancelled notice lists the cascade', () => {
        const mesh = newMesh('qcascade2');
        meshConfig.policy = { onDependencyFailure: 'cancel' };
        const q = queueChain(mesh);
        const paged = recordStops();
        requeueTask(mesh, q.root.id, { maxRetries: 0 });
        expect(getQueueEntryById(mesh, q.f.id)!.status).toBe('cancelled');
        expect(queueRows(mesh, 'queue_dependency_blocked')).toHaveLength(0);
        expect(paged).toHaveLength(1);
        const n = paged[0];
        if (n.kind !== 'queue_dependency_cancelled') throw new Error('kind');
        expect(n.cancelled).toEqual([{ taskId: q.e.id }, { taskId: q.f.id, via: q.e.id }]);
        expect(renderGraphStopNotice(n).coordinatorMessage).toContain('Under on_dependency_failure=cancel, 2 dependent task(s) were cancelled');
    });

    it('stall sweep: a chain behind a dead task with NO notice pages once (dedupe by root + fingerprint)', () => {
        const mesh = newMesh('qstall');
        const q = queueChain(mesh);
        // A root that went terminal without the notice (pre-upgrade / bypass).
        const store = MeshRuntimeStore.getInstance();
        const root = store.findQueueEntryById(mesh, q.root.id)!;
        root.status = 'failed';
        store.updateQueueEntry(root);
        const notices = captureNotices();
        expect(sweepMeshGraphStalls(mesh)).toMatchObject({ stalledQueueChains: 1, noticesQueued: 1 });
        expect(sweepMeshGraphStalls(mesh)).toMatchObject({ stalledQueueChains: 1, noticesQueued: 0 });
        expect(notices).toHaveLength(1);
        expect(notices[0].event).toBe('mesh:queue_chain_stalled');
        expect(notices[0].coordinatorMessage.startsWith(`2 pending queue task(s) can never start: they wait (depends_on) on ${q.root.id.slice(0, 8)} (task_id ${q.root.id}), which ended failed (reason: task_failed)`)).toBe(true);
        expect(JSON.stringify(notices[0])).not.toContain(SECRET);
    });
});

describe('reason codes never carry free text', () => {
    it('keeps a leading machine code and drops everything else', () => {
        expect(reasonCodeOf('max_retries_exceeded: requeued 2 time(s), limit is 1')).toBe('max_retries_exceeded');
        expect(reasonCodeOf('dependency_failed:abc')).toBe('dependency_failed');
        expect(reasonCodeOf('reclaim_budget_exhausted')).toBe('reclaim_budget_exhausted');
        expect(reasonCodeOf("workspace 'ws' is failed and can never become ready")).toBe('unspecified');
        expect(reasonCodeOf(`${SECRET} free text`)).toBe('unspecified');
        expect(reasonCodeOf(undefined)).toBe('unspecified');
        // The real live operator reason (2026-09-25): a dashed/cased token is text, not a code.
        expect(reasonCodeOf('live-check: cancel behind open gate')).toBe('unspecified');
        expect(reasonCodeOf('Operator: stop it')).toBe('unspecified');
    });
});
