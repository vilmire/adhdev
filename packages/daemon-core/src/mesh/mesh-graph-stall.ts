/**
 * N(c) — a graph that is still `active` but can never move again.
 *
 * The failure notices (graph_dependency_blocked / graph_dependency_cancelled)
 * fire at the moment work is stopped. This sweep is the catch-all for the
 * states NOTHING announces: a node blocked on a materialization error, work
 * waiting behind an operator-cancelled step under `block`, a divergent row. It
 * runs on the housekeeping tick and pages ONCE per stuck configuration: the
 * notice's eventId carries a fingerprint of the stuck node states, so every
 * later sweep over the same state dedupes (turn_events PK), while a graph that
 * gets unstuck and stuck again differently pages again.
 *
 * "Can move" = any of: a worker row `assigned` (running); a worker row
 * `pending` with no block and every dependency completed (runnable — incl. a
 * parked or backed-off row, which has its own notices); a gate awaiting or
 * claimed (the coordinator's turn — paged by the gate notices); a workspace
 * saga still in progress (declared/preparing/compensating — it will settle).
 *
 * Read-only over graph state; the only side effect is notifyMeshCoordinator.
 * Only `active` graphs are checked — `waiting_gate` by definition has a gate
 * awaiting the coordinator.
 */
import { createHash } from 'crypto';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { notifyMeshCoordinator } from './turn-ledger/deliver.js';
import { taskDependenciesSatisfied } from './mesh-task-predicates.js';
import { renderGraphStopNotice, reasonCodeOf, type MeshGraphStalledNotice, type MeshGraphStopNodeRef, type MeshQueueChainStalledNotice } from './mesh-graph-stop-notice.js';
import { collectWaitingQueueDependents, queueRootReasonCode } from './mesh-queue-dependency-notice.js';
import type { MeshTaskGraphNodeRow } from './mesh-graph-types.js';

const IN_PROGRESS_SAGA_STATES = new Set(['declared', 'preparing', 'compensating']);
const DONE_NODE_STATES = new Set(['completed', 'failed', 'cancelled', 'skipped', 'released', 'expired']);
const OPEN_GATE_STATES = new Set(['awaiting_coordinator', 'claimed']);

export interface MeshGraphStallSweepResult {
    checkedGraphs: number;
    stalledGraphs: number;
    /** Queue-level depends_on chains stuck behind a failed/cancelled task (no graph rows). */
    stalledQueueChains: number;
    noticesQueued: number;
}

/** Detect a stalled graph; null when it can still move (or is already settled). */
export function detectGraphStall(meshId: string, graphId: string): MeshGraphStalledNotice | null {
    const store = MeshRuntimeStore.getInstance();
    const graphStore = store.graphStore();
    const graph = graphStore.getGraph(graphId);
    if (!graph || graph.status !== 'active') return null;

    if (graphStore.listGatesByGraph(graphId).some(g => OPEN_GATE_STATES.has(g.state))) return null;
    try {
        if (graphStore.listWorkspaceIntents(graphId).some(i => IN_PROGRESS_SAGA_STATES.has(i.sagaState))) return null;
    } catch { /* no workspace table → no saga in progress */ }

    const nodes = graphStore.listNodes(graphId);
    const workers = nodes.filter(n => n.kind === 'worker_task' && n.queueTaskId);
    const rows = new Map(workers.map(n => [n.nodeId, store.findQueueEntryById(meshId, n.queueTaskId!)]));
    const statusById = new Map<string, string>();
    for (const row of rows.values()) if (row) statusById.set(row.id, row.status);
    // Dependencies may point outside the graph (a pre-existing queue task).
    for (const row of rows.values()) {
        for (const dep of row?.dependsOn ?? []) {
            if (!statusById.has(dep)) {
                const depRow = store.findQueueEntryById(meshId, dep);
                if (depRow) statusById.set(dep, depRow.status);
            }
        }
    }
    const inGraphTaskIds = new Set(workers.map(n => n.queueTaskId!));
    for (const row of rows.values()) {
        if (!row) continue;
        if (row.status === 'assigned') return null;
        if (row.status === 'pending' && taskDependenciesSatisfied(row, statusById)) return null;
        // Waiting on a LIVE task outside this graph: that task is not ours to
        // judge (in-graph dependencies are judged by the loop itself).
        if (row.status === 'pending' && (row.dependsOn ?? []).some(d => !inGraphTaskIds.has(d)
            && (statusById.get(d) === 'pending' || statusById.get(d) === 'assigned'))) return null;
    }

    const stuckNodes = nodes.filter(n => !DONE_NODE_STATES.has(n.state));
    if (stuckNodes.length === 0) return null;

    const edges = graphStore.listEdges(graphId);
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    const deadUpstream = new Map<string, MeshTaskGraphNodeRow>();
    for (const s of stuckNodes) {
        // eslint-disable-next-line no-restricted-syntax -- GRAPH node UUIDs from one graph store — not mesh machine/daemon ids
        for (const e of edges.filter(x => x.toNodeId === s.nodeId)) {
            const src = byId.get(e.fromNodeId);
            if (src && (src.state === 'failed' || src.state === 'cancelled')) deadUpstream.set(src.nodeId, src);
        }
    }

    // "A stall with no other notice": when every stuck node sits downstream of a
    // failure that was ALREADY paged (graph_dependency_blocked/_cancelled), the
    // coordinator has the actionable notice — do not page the same event twice.
    const pagedRoots = new Set<string>();
    for (const row of graphStore.listOutboxEvents(meshId, graphId)) {
        if (row.kind !== 'graph_dependency_blocked' && row.kind !== 'graph_dependency_cancelled') continue;
        try {
            const rootId = JSON.parse(row.payload ?? '{}')?.root?.nodeId;
            if (typeof rootId === 'string') pagedRoots.add(rootId);
        } catch { /* malformed → not paged */ }
    }
    if (deadUpstream.size > 0 && [...deadUpstream.keys()].every(id => pagedRoots.has(id))) {
        const explained = new Set<string>();
        let frontier = [...deadUpstream.keys()];
        while (frontier.length > 0) {
            const next: string[] = [];
            for (const id of frontier) {
                // eslint-disable-next-line no-restricted-syntax -- GRAPH node UUIDs from one graph store — not mesh machine/daemon ids
                for (const e of edges.filter(x => x.fromNodeId === id)) {
                    if (explained.has(e.toNodeId)) continue;
                    explained.add(e.toNodeId);
                    next.push(e.toNodeId);
                }
            }
            frontier = next;
        }
        if (stuckNodes.every(n => explained.has(n.nodeId))) return null;
    }

    const describe = (n: MeshTaskGraphNodeRow): MeshGraphStopNodeRef => {
        const row = n.queueTaskId ? rows.get(n.nodeId) : null;
        const gateId = n.kind === 'coordinator_gate' ? graphStore.findGateByNodeId(graphId, n.nodeId)?.gateId : undefined;
        const code = row?.blockedReason ? reasonCodeOf(row.blockedReason) : undefined;
        return {
            nodeId: n.nodeId,
            ...(n.ref ? { ref: n.ref } : {}),
            kind: n.kind === 'coordinator_gate' ? 'coordinator_gate' : 'worker_task',
            ...(n.queueTaskId ? { taskId: n.queueTaskId } : {}),
            ...(gateId ? { gateId } : {}),
            state: row && row.status !== 'pending' ? `${n.state}/${row.status}` : n.state,
            ...(code && code !== 'unspecified' ? { reasonCode: code } : {}),
        };
    };
    const stuck = stuckNodes.map(describe);
    const fingerprint = createHash('sha256')
        .update(JSON.stringify(stuck.map(s => [s.nodeId, s.state, s.reasonCode ?? '']).sort()))
        .digest('hex').slice(0, 16);
    return {
        kind: 'graph_stalled',
        meshId,
        graphId,
        fingerprint,
        stuck,
        deadUpstream: [...deadUpstream.values()].map(n => ({
            nodeId: n.nodeId,
            ...(n.ref ? { ref: n.ref } : {}),
            kind: 'worker_task' as const,
            ...(n.queueTaskId ? { taskId: n.queueTaskId } : {}),
            state: n.state,
        })),
    };
}

/** Housekeeping: page each stalled `active` graph of one mesh, once per stuck configuration. */
export function sweepMeshGraphStalls(meshId: string, opts?: { nowMs?: number }): MeshGraphStallSweepResult {
    const graphStore = MeshRuntimeStore.getInstance().graphStore();
    const result: MeshGraphStallSweepResult = { checkedGraphs: 0, stalledGraphs: 0, stalledQueueChains: 0, noticesQueued: 0 };
    for (const graph of graphStore.listGraphsByMesh(meshId, { statuses: ['active'] })) {
        result.checkedGraphs += 1;
        const stall = detectGraphStall(meshId, graph.graphId);
        if (!stall) continue;
        result.stalledGraphs += 1;
        const rendered = renderGraphStopNotice(stall);
        const queued = notifyMeshCoordinator({
            event: rendered.event,
            meshId,
            nodeLabel: rendered.nodeLabel,
            eventId: rendered.eventId,
            metadataEvent: rendered.metadataEvent,
            coordinatorMessage: rendered.coordinatorMessage,
            ...(opts?.nowMs !== undefined ? { queuedAt: opts.nowMs } : {}),
        });
        if (queued) result.noticesQueued += 1;
    }
    for (const stall of detectQueueChainStalls(meshId)) {
        result.stalledQueueChains += 1;
        const rendered = renderGraphStopNotice(stall);
        const queued = notifyMeshCoordinator({
            event: rendered.event,
            meshId,
            nodeLabel: rendered.nodeLabel,
            eventId: rendered.eventId,
            metadataEvent: rendered.metadataEvent,
            coordinatorMessage: rendered.coordinatorMessage,
            ...(opts?.nowMs !== undefined ? { queuedAt: opts.nowMs } : {}),
        });
        if (queued) result.noticesQueued += 1;
    }
    return result;
}

/**
 * N(c) for QUEUE chains (no graph rows): a pending non-graph task whose
 * depends_on names a `failed`/`cancelled` task, where no queue-dependency
 * notice was written for that dead task yet (e.g. it ended before this shipped,
 * or through a path that bypassed the notice). One notice per dead root; the
 * eventId carries a fingerprint of the waiting set, so every later sweep over
 * the same state dedupes.
 */
export function detectQueueChainStalls(meshId: string): MeshQueueChainStalledNotice[] {
    const store = MeshRuntimeStore.getInstance();
    const graphStore = store.graphStore();
    const pending = store.getQueueEntries(meshId, ['pending']);
    const deadRoots = new Map<string, { status: 'failed' | 'cancelled'; cancelReason?: string }>();
    for (const entry of pending) {
        for (const dep of entry.dependsOn ?? []) {
            if (deadRoots.has(dep)) continue;
            const row = store.findQueueEntryById(meshId, dep);
            if (row && (row.status === 'failed' || row.status === 'cancelled')) {
                deadRoots.set(dep, { status: row.status, ...(row.cancelReason ? { cancelReason: row.cancelReason } : {}) });
            }
        }
    }
    if (deadRoots.size === 0) return [];
    const covered = new Set<string>();
    for (const row of graphStore.listOutboxEventsByKinds(meshId, ['queue_dependency_blocked', 'queue_dependency_cancelled'])) {
        try {
            const id = JSON.parse(row.payload ?? '{}')?.root?.taskId;
            if (typeof id === 'string') covered.add(id);
        } catch { /* malformed → not covered */ }
    }
    const out: MeshQueueChainStalledNotice[] = [];
    for (const [rootId, root] of deadRoots) {
        if (covered.has(rootId)) continue;
        const waiting = collectWaitingQueueDependents(store, meshId, rootId);
        if (waiting.length === 0) continue; // graph-backed only → the graph stall covers it
        const fingerprint = createHash('sha256')
            .update(JSON.stringify([root.status, ...waiting.map(w => w.taskId).sort()]))
            .digest('hex').slice(0, 16);
        out.push({
            kind: 'queue_chain_stalled',
            meshId,
            fingerprint,
            root: { taskId: rootId, outcome: root.status, reasonCode: queueRootReasonCode({ status: root.status, cancelReason: root.cancelReason }) },
            waiting,
        });
    }
    return out;
}
