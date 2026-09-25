/**
 * Coordinator-gate CLOSURE — the abandon state change and the D3(a) auto-close
 * (the 2026-09-25 graph orchestration simplification), split out of
 * mesh-graph-gates.ts so the terminal choke point (the transition runner) can
 * close gates inside its own transaction.
 *
 * ★ Import discipline: this module imports only the store, the graph types, the
 * derived-failure rollup and the logger, and uses none of them at module top
 * level — NEVER the transition runner, mesh-graph-gates.ts or the queue. The
 * runner imports it; mesh-graph-gates.ts imports the runner and evaluates a
 * runner binding at module top level, so pulling gates (or the runner) in here
 * would recreate the init-order cycle measured in wave 23
 * (`MESH_GATE_RELEASE_PATCH_KEYS` evaluated to undefined). Pinned by the
 * structural test in mesh-graph-transition-runner.test.ts. Callers drain the
 * graph outbox after their own commit.
 *
 * Every state change here must run inside the caller's transaction (outbox rows
 * join it — design :185-190).
 */

import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { LOG } from '../logging/logger.js';
import {
    newMeshGraphOutboxId,
    type MeshGraphGateRow,
    type MeshGraphStatus,
    type MeshTaskGraphNodeRow,
} from './mesh-graph-types.js';
import { classifyGraphRollup } from './mesh-graph-derived-failure.js';

export interface MeshGraphGateAbandonInput {
    meshId: string;
    gateId: string;
    /** Free-form operator reason, recorded on the gate node and the cancelled downstream rows. */
    reason: string;
    /**
     * Who is abandoning. Recorded for provenance. Deliberately NOT matched
     * against `leaseOwnerSessionId`: the whole point of abandon is to close a
     * gate whose owner is gone.
     */
    coordinatorSessionId?: string;
    /**
     * A LIVE foreign lease is refused by default — the holder may be mid-action
     * on an external side effect, and abandoning under them would strand it.
     * Set true to abandon anyway (an operator who knows the holder is dead).
     */
    force?: boolean;
    nowMs?: number;
}

export interface MeshGraphGateAbandonResult {
    abandoned: boolean;
    /** gate_not_found / gate_already_abandoned / gate_terminal:<state> / gate_lease_held / gate_abandon_race. */
    reason?: string;
    gate?: MeshGraphGateRow;
    /** Downstream worker nodes cancelled by this abandon. */
    cancelledNodeIds: string[];
    /** Their still-pending queue placeholders, now `cancelled`. */
    cancelledTaskIds: string[];
    /** The graph status this abandon rolled the graph to, when it rolled at all. */
    graphStatus?: string;
}

/** The block/cancel reason an abandoned gate stamps on the work it closes. */
export function coordinatorGateAbandonedReason(gateId: string): string {
    return `coordinator_gate_abandoned:${gateId}`;
}

/**
 * The abandon state change proper — MUST run inside the caller's transaction
 * (outbox rows join it, design :185-190). The caller drains after commit.
 * Shared by the explicit verb and the D3(a) auto-close so both write the SAME
 * closure (cancelled gate + node, subtree walk, rollup, `graph_gate_abandoned`).
 */
export function abandonGateInTxn(
    store: MeshRuntimeStore,
    input: MeshGraphGateAbandonInput & {
        auto?: boolean;
        /** Internal: the graph is ALREADY terminal (markGraphTerminalInTxn) — do not re-roll it. */
        skipRollup?: boolean;
    },
    nowIso: string,
): MeshGraphGateAbandonResult {
    const graphStore = store.graphStore();
    const gate = graphStore.getGate(input.gateId);
    if (!gate || gate.meshId !== input.meshId) {
        return { abandoned: false, reason: 'gate_not_found', cancelledNodeIds: [], cancelledTaskIds: [] };
    }
    if (gate.state === 'cancelled') {
        // Idempotent: abandoning an abandoned gate is a no-op success, so a
        // retried cleanup never has to distinguish "I did it" from "it was done".
        return { abandoned: true, reason: 'gate_already_abandoned', gate, cancelledNodeIds: [], cancelledTaskIds: [] };
    }
    if (gate.state === 'released') {
        // A released gate already let its downstream run. Abandoning it would
        // claim closure over work that is in flight or finished.
        return { abandoned: false, reason: `gate_terminal:${gate.state}`, gate, cancelledNodeIds: [], cancelledTaskIds: [] };
    }
    if (!input.force && gate.state === 'claimed' && gate.leaseExpiresAt && gate.leaseExpiresAt > nowIso) {
        return { abandoned: false, reason: 'gate_lease_held', gate, cancelledNodeIds: [], cancelledTaskIds: [] };
    }

    const abandonReason = `${coordinatorGateAbandonedReason(gate.gateId)}:${input.reason}`;
    const won = graphStore.patchGate(gate.gateId, {
        state: 'cancelled',
        // Drop the lease: an abandoned gate has no owner and no live fence.
        leaseOwnerSessionId: null,
        fencingToken: null,
        leaseExpiresAt: null,
    }, nowIso, { leaseGeneration: gate.leaseGeneration });
    if (!won) {
        return { abandoned: false, reason: 'gate_abandon_race', gate, cancelledNodeIds: [], cancelledTaskIds: [] };
    }

    const node = graphStore.getNode(gate.graphId, gate.nodeId);
    if (node && node.state !== 'cancelled') {
        graphStore.updateNodeState(gate.graphId, gate.nodeId, 'cancelled', nowIso, { failureReason: abandonReason });
    }

    // ★ Downstream is CANCELLED, never materialized. Reuse the same subtree
    // walk `cancel_downstream` uses so abandon and the timeout policy agree
    // on what "everything this gate was gating" means.
    const cancelledNodeIds = node ? cancelGateDownstreamSubtree(store, node, nowIso, abandonReason) : [];
    const cancelledTaskIds: string[] = [];
    for (const nodeId of cancelledNodeIds) {
        const target = graphStore.getNode(gate.graphId, nodeId);
        if (target?.queueTaskId) cancelledTaskIds.push(target.queueTaskId);
    }

    // Rollup: with this gate settled, the graph may now be able to reach a
    // terminal state it could not reach before — that is the whole point.
    const graph = input.skipRollup ? null : graphStore.getGraph(gate.graphId);
    let graphStatus: string | undefined;
    const rolled = input.skipRollup ? null : classifyGraphRollup(graphStore.listNodes(gate.graphId));
    if (graph && rolled && graph.status !== rolled) {
        markGraphTerminalInTxn(store, gate.graphId, rolled, nowIso);
        graphStatus = rolled;
        insertGateOutbox(graphStore, gate.meshId, gate.graphId,
            rolled === 'completed' ? 'graph_completed' : rolled === 'failed' ? 'graph_failed' : 'graph_cancelled',
            { graphId: gate.graphId, status: rolled }, nowIso);
    } else if (graph?.status === 'waiting_gate') {
        // Other gates still hold the graph; drop back to `active` only when
        // this was the last one waiting.
        const stillWaiting = graphStore.listGatesByGraph(gate.graphId)
            .some(g => g.gateId !== gate.gateId && (g.state === 'awaiting_coordinator' || g.state === 'claimed'));
        if (!stillWaiting) {
            graphStore.updateGraphStatus(gate.graphId, 'active', nowIso);
            graphStatus = 'active';
        }
    }

    insertGateOutbox(graphStore, gate.meshId, gate.graphId, 'graph_gate_abandoned', {
        graphId: gate.graphId, gateId: gate.gateId, nodeId: gate.nodeId, ref: gate.ref,
        action: gate.action, priorState: gate.state, reason: input.reason,
        ...(input.coordinatorSessionId ? { coordinatorSessionId: input.coordinatorSessionId } : {}),
        ...(input.force ? { force: true } : {}),
        ...(input.auto ? { auto: true } : {}),
        ...(cancelledNodeIds.length > 0 ? { cancelledNodeIds } : {}),
    }, nowIso);
    // ★ Deliberately NO `queue_wake`: abandon opens nothing, so there is
    // nothing for the scheduler to pick up.

    return {
        abandoned: true,
        gate: graphStore.getGate(gate.gateId)!,
        cancelledNodeIds,
        cancelledTaskIds,
        ...(graphStatus ? { graphStatus } : {}),
    };
}

// ── Graph terminal ⇒ no open gate survives ────────────────────────────────────

/** Reason a gate records when its graph went terminal around it. */
export const MESH_GATE_GRAPH_TERMINAL_REASON = 'graph_terminal';

/**
 * Gate states that are still "open" — they page, sweep, or wait on the
 * coordinator. An `expired` gate counts only under `hold` (it still waits for a
 * decision); a cancel_downstream/fail_graph expiry already applied its policy
 * and is settled — it keeps `expired` as the record of what happened.
 */
function isOpenGateOnTerminal(gate: MeshGraphGateRow): boolean {
    if (gate.state === 'expired') return gate.onTimeout === 'hold';
    return gate.state === 'declared' || gate.state === 'awaiting_coordinator' || gate.state === 'claimed';
}

/**
 * THE way a graph goes terminal (completed / failed / cancelled): write the
 * status, then abandon every still-open gate in it (reason `graph_terminal`),
 * in the caller's transaction. Without this a `fail_graph` deadline expiry —
 * or a rollup past an `expired`/hold gate — left gates open under a finished
 * graph, still paging and still listed as awaiting the coordinator.
 *
 * - Forced: a live lease on a finished graph guards nothing (its release
 *   could not advance a terminal graph anyway).
 * - No rollup from the abandons (the status is already decided here).
 * - No coordinator page: `graph_gate_abandoned` is not a paged outbox kind —
 *   the notice that covers the terminal event (graph failure / expiry /
 *   stopped-downstream) is the only one.
 * Idempotent: a graph with no open gate writes nothing beyond the status.
 * Returns the gate ids it closed.
 */
export function markGraphTerminalInTxn(
    store: MeshRuntimeStore,
    graphId: string,
    /** A terminal status — classifyGraphRollup's result or an explicit policy. */
    status: MeshGraphStatus,
    nowIso: string,
): string[] {
    const graphStore = store.graphStore();
    graphStore.updateGraphStatus(graphId, status, nowIso, true);
    const closed: string[] = [];
    for (const gate of graphStore.listGatesByGraph(graphId)) {
        if (!isOpenGateOnTerminal(gate)) continue;
        const res = abandonGateInTxn(store, {
            meshId: gate.meshId,
            gateId: gate.gateId,
            reason: MESH_GATE_GRAPH_TERMINAL_REASON,
            coordinatorSessionId: MESH_GATE_AUTO_ABANDON_ACTOR,
            auto: true,
            force: true,
            skipRollup: true,
        }, nowIso);
        if (res.abandoned && res.reason !== 'gate_already_abandoned') closed.push(gate.gateId);
    }
    if (closed.length > 0) {
        LOG.info('MeshGraph', `Graph ${graphId} is ${status}: closed ${closed.length} open gate(s) (${MESH_GATE_GRAPH_TERMINAL_REASON}): ${closed.join(',')}`);
    }
    return closed;
}

// ── D3(a) auto-close: a gate whose downstream is all terminal ────────────────

/**
 * The reason an auto-closed gate records (node failure reason suffix and the
 * `graph_gate_abandoned` outbox payload). The 2026-09-25 graph orchestration simplification, D3(a).
 */
export const MESH_GATE_AUTO_ABANDON_REASON = 'downstream_all_terminal';

/** Provenance recorded on an auto-closed gate — no coordinator decided it. */
export const MESH_GATE_AUTO_ABANDON_ACTOR = 'daemon_auto_close';

/** Downstream node states that can never again need the gate. */
const DOWNSTREAM_TERMINAL_STATES: ReadonlySet<MeshTaskGraphNodeRow['state']> = new Set([
    'completed', 'failed', 'cancelled', 'skipped', 'released',
]);

/**
 * ★ Close every still-open gate of `graphId` whose DIRECT downstream nodes are
 * ALL terminal — the gate is guarding nothing any more (its work was cancelled,
 * or finished some other way), so leaving it `awaiting_coordinator` only makes
 * the graph unrollable and pages the coordinator for a dead decision. This used
 * to be a coordinator-rule chore ("if you cancelled the tasks, close the gate
 * too") that was routinely forgotten.
 *
 * Invariants kept:
 *   - It is CLOSURE through the one abandon path — never a release, no outcome.
 *   - A gate with NO downstream (a terminal approval gate that legitimately ends
 *     a graph) is never touched; neither is a gate with ANY non-terminal
 *     downstream, a released/cancelled gate, a non-hold expired gate, or a gate
 *     under a LIVE lease (the holder may be mid external action — no force).
 *   - Runs to a fixed point: closing a gate can make its upstream gate's
 *     downstream all-terminal in turn.
 *
 * MUST run inside the caller's transaction; the caller drains the outbox after
 * commit. Returns the gate ids it closed.
 */
export function autoAbandonGatesWithTerminalDownstreamInTxn(
    store: MeshRuntimeStore,
    graphId: string,
    nowIso: string,
): string[] {
    const graphStore = store.graphStore();
    const closed: string[] = [];
    for (let pass = 0; pass < 64; pass += 1) {
        // Cheap exit first — this runs on every failed/cancelled graph-backed
        // terminal, and most graphs have no open gate.
        const gates = graphStore.listGatesByGraph(graphId)
            .filter(g => g.state !== 'released' && g.state !== 'cancelled');
        if (gates.length === 0) break;
        const nodes = graphStore.listNodes(graphId);
        const edges = graphStore.listEdges(graphId);
        const byId = new Map(nodes.map(n => [n.nodeId, n]));
        let closedThisPass = 0;
        for (const gate of gates) {
            if (gate.state === 'expired' && gate.onTimeout !== 'hold') continue;
            if (gate.state === 'claimed' && gate.leaseExpiresAt && gate.leaseExpiresAt > nowIso) continue;
            // eslint-disable-next-line no-restricted-syntax -- GRAPH node UUIDs from the same graph store (mesh_task_graph_nodes.nodeId), single canonical form — not mesh machine/daemon ids
            const downstream = edges.filter(e => e.fromNodeId === gate.nodeId).map(e => byId.get(e.toNodeId));
            if (downstream.length === 0) continue;
            if (!downstream.every(n => !!n && DOWNSTREAM_TERMINAL_STATES.has(n.state))) continue;
            const res = abandonGateInTxn(store, {
                meshId: gate.meshId,
                gateId: gate.gateId,
                reason: MESH_GATE_AUTO_ABANDON_REASON,
                coordinatorSessionId: MESH_GATE_AUTO_ABANDON_ACTOR,
                auto: true,
            }, nowIso);
            if (res.abandoned && res.reason !== 'gate_already_abandoned') {
                closed.push(gate.gateId);
                closedThisPass += 1;
            }
        }
        if (closedThisPass === 0) break;
    }
    if (closed.length > 0) {
        LOG.info('MeshGraph', `Auto-closed ${closed.length} gate(s) on graph ${graphId} (${MESH_GATE_AUTO_ABANDON_REASON}): ${closed.join(',')}`);
    }
    return closed;
}

// ── F2: a gate whose upstream failed can never open ──────────────────────────

/** Reason an F2-abandoned gate records (`coordinator_gate_abandoned:<gateId>:upstream_failed`). */
export const MESH_GATE_UPSTREAM_FAILED_REASON = 'upstream_failed';

export interface MeshDeadUpstreamGateClosure {
    /** Gates abandoned because an upstream node failed/was cancelled. */
    abandonedGates: Array<{ gateId: string; ref?: string }>;
    /** Nodes the abandons cancelled (the gates' downstream subtrees). */
    cancelledNodeIds: string[];
}

/**
 * ★ `on_dependency_failure: cancel` only (the caller decides): close every
 * still-open gate of `graphId` that can NEVER open because one of its incoming
 * sources is `failed`/`cancelled` (or whose own node a subtree walk already
 * cancelled), and cancel what it guards — recursively, to a fixed point, since
 * each abandon's subtree walk can kill the upstream of another gate.
 *
 * The C3 cancel cascade deliberately stops at gates (it never walks a `gate`
 * edge); without this a failed step in front of a gate left the gate
 * `declared` forever — no deadline is stamped until a gate opens — and the
 * tasks behind it pending forever. Closure goes through the one abandon path
 * (never a release). A claimed gate under a LIVE lease is left to its holder.
 *
 * MUST run inside the caller's transaction; the caller drains after commit.
 */
export function abandonGatesWithDeadUpstreamInTxn(
    store: MeshRuntimeStore,
    graphId: string,
    nowIso: string,
): MeshDeadUpstreamGateClosure {
    const graphStore = store.graphStore();
    const out: MeshDeadUpstreamGateClosure = { abandonedGates: [], cancelledNodeIds: [] };
    for (let pass = 0; pass < 64; pass += 1) {
        const gates = graphStore.listGatesByGraph(graphId)
            .filter(g => g.state !== 'released' && g.state !== 'cancelled');
        if (gates.length === 0) break;
        const nodes = graphStore.listNodes(graphId);
        const edges = graphStore.listEdges(graphId);
        const byId = new Map(nodes.map(n => [n.nodeId, n]));
        let closedThisPass = 0;
        for (const gate of gates) {
            if (gate.state === 'expired' && gate.onTimeout !== 'hold') continue;
            if (gate.state === 'claimed' && gate.leaseExpiresAt && gate.leaseExpiresAt > nowIso) continue;
            const gateNode = byId.get(gate.nodeId);
            // eslint-disable-next-line no-restricted-syntax -- GRAPH node UUIDs from the same graph store, single canonical form — not mesh machine/daemon ids
            const incoming = edges.filter(e => e.toNodeId === gate.nodeId);
            const dead = gateNode?.state === 'cancelled'
                || incoming.some(e => {
                    const s = byId.get(e.fromNodeId)?.state;
                    return s === 'failed' || s === 'cancelled';
                });
            if (!dead) continue;
            const res = abandonGateInTxn(store, {
                meshId: gate.meshId,
                gateId: gate.gateId,
                reason: MESH_GATE_UPSTREAM_FAILED_REASON,
                coordinatorSessionId: MESH_GATE_AUTO_ABANDON_ACTOR,
                auto: true,
            }, nowIso);
            if (res.abandoned && res.reason !== 'gate_already_abandoned') {
                out.abandonedGates.push({ gateId: gate.gateId, ...(gate.ref ? { ref: gate.ref } : {}) });
                out.cancelledNodeIds.push(...res.cancelledNodeIds);
                closedThisPass += 1;
            }
        }
        if (closedThisPass === 0) break;
    }
    if (out.abandonedGates.length > 0) {
        LOG.info('MeshGraph', `Abandoned ${out.abandonedGates.length} gate(s) on graph ${graphId} (${MESH_GATE_UPSTREAM_FAILED_REASON}): ${out.abandonedGates.map(g => g.gateId).join(',')}`);
    }
    return out;
}

/** Nodes the release/expire paths must never cancel — terminal or terminal-equivalent. */
function isCancelExempt(state: MeshTaskGraphNodeRow['state']): boolean {
    return state === 'completed' || state === 'released' || state === 'skipped'
        || state === 'cancelled' || state === 'failed' || state === 'expired';
}

/**
 * `cancel_downstream` (and abandon): mark every non-terminal descendant node
 * `cancelled` and cancel its STILL-PENDING queue placeholder with a gate-owned
 * reason. An already-assigned/running row is not force-flipped here — the
 * derived-failure cascade for in-flight work is phase C3's contract.
 *
 * `reason` distinguishes the two callers: a deadline expiry stamps
 * `coordinator_gate_timeout:<nodeId>`, an explicit abandon stamps
 * `coordinator_gate_abandoned:<gateId>:<operator reason>`. They must stay
 * distinguishable — one is elapsed time, the other is a decision.
 */
export function cancelGateDownstreamSubtree(
    store: MeshRuntimeStore,
    gateNode: MeshTaskGraphNodeRow,
    nowIso: string,
    reason = `coordinator_gate_timeout:${gateNode.nodeId}`,
): string[] {
    const graphStore = store.graphStore();
    const nodes = graphStore.listNodes(gateNode.graphId);
    const edges = graphStore.listEdges(gateNode.graphId);
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    const cancelled: string[] = [];
    const visited = new Set([gateNode.nodeId]);
    let frontier = [gateNode.nodeId];
    while (frontier.length > 0) {
        const next: string[] = [];
        for (const id of frontier) {
            for (const edge of edges.filter(e => e.fromNodeId === id)) {
                if (visited.has(edge.toNodeId)) continue;
                visited.add(edge.toNodeId);
                const target = byId.get(edge.toNodeId);
                if (!target || isCancelExempt(target.state)) continue;
                graphStore.updateNodeState(target.graphId, target.nodeId, 'cancelled', nowIso, {
                    failureReason: reason,
                });
                if (target.queueTaskId) {
                    const entry = store.findQueueEntryById(target.meshId, target.queueTaskId);
                    if (entry && entry.status === 'pending') {
                        entry.status = 'cancelled';
                        entry.blockedReason = reason;
                        store.updateQueueEntry(entry);
                    }
                }
                cancelled.push(target.nodeId);
                next.push(target.nodeId);
            }
        }
        frontier = next;
    }
    return cancelled;
}

/** One outbox row inside the caller's transaction (design :185-190). */
export function insertGateOutbox(
    graphStore: ReturnType<MeshRuntimeStore['graphStore']>,
    meshId: string,
    graphId: string,
    kind: string,
    payload: Record<string, unknown>,
    nowIso: string,
): void {
    graphStore.insertOutboxEvent({
        id: newMeshGraphOutboxId(),
        meshId,
        graphId,
        kind,
        payload: JSON.stringify(payload),
        status: 'pending',
        attemptCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
    });
}
