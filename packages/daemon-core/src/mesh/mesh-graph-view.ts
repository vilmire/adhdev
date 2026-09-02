/**
 * GRAPH-ORCHESTRATION Phase E — the read-only graph view (design :759-775).
 *
 * "Add `mesh_graph_view` or a graph mode to `mesh_view_queue` that reports graph
 *  nodes, refs, active edges, materialization receipts, gates, workspace sagas,
 *  derived dependency failures, and next required coordinator action."
 *
 * ── Why this is a projection, never a source of truth ────────────────────────
 * Every field here is DERIVED at read time from the graph tables and the queue.
 * Nothing in this module writes, and nothing else may read a stored "blocked
 * reason summary": C3's contract is that explanatory failure data is derived from
 * current predecessor status (design :524-527), so a retry that succeeds makes the
 * explanation disappear on its own. Persisting it would recreate exactly the stale
 * `dependency_failed:*` blockedReason the C3 migration removed.
 *
 * ── The `block` contract this view must not break ────────────────────────────
 * `dependencyFailures` here is `deriveDependencyFailures` verbatim — a SKIPPED
 * predecessor is NOT a failure (design :356-369), and a `block`ed dependent shows
 * its failures without any `blockedReason` being written for them.
 *
 * ── nextCoordinatorAction ────────────────────────────────────────────────────
 * The design asks for "next required coordinator action" (:762). It is reported
 * ONLY for states where a coordinator genuinely has to act — an awaiting/claimed
 * gate, an expired `hold` gate needing reclaim, an ORPHANED gate that can only be
 * abandoned, or a compensation-required workspace. Ordinary in-flight work reports
 * nothing: inventing an action for a running graph is what drives the polling
 * behaviour the mesh rules forbid.
 *
 * ★ Every action's `detail` must name a tool that actually exists. The
 * `gate_reclaim` text used to end with "or cancel the branch explicitly", which
 * pointed at nothing — there was no cleanup verb at all, so a coordinator that
 * followed the advice found no way to do it. It now names
 * `mesh_graph_gate_abandon`, and `gate_abandon` is reported outright for the
 * orphan case that advice was really describing.
 */

import { MeshRuntimeStore } from './mesh-runtime-store.js';
import {
    deriveDependencyFailures,
    projectGraphPublicPolicy,
    type MeshDependencyFailure,
} from './mesh-graph-derived-failure.js';
import { parseCoordinatorGateBlock } from './mesh-graph-transition-runner.js';
import type { GateConvergenceEvidence } from './mesh-graph-gate-evidence.js';
import type {
    MeshGraphGateState,
    MeshGraphNodeState,
    MeshGraphStatus,
    MeshGraphWorkspaceSagaState,
} from './mesh-graph-types.js';

export interface MeshGraphNodeView {
    nodeId: string;
    ref?: string;
    kind: 'worker_task' | 'coordinator_gate';
    state: MeshGraphNodeState;
    taskId?: string;
    /** Live queue status of the backing row — the graph node state and it can differ mid-flight. */
    taskStatus?: string;
    /** The queue row's current block, if any (graph-owned or foreign). */
    blockedReason?: string;
    /** Set when the block is this graph's gate hold: which gate is holding it. */
    blockedByGateId?: string;
    materializationVersion: number;
    /** design :132 — the receipt that a materialization actually committed. */
    materializedDigest?: string;
    skipReason?: string;
    failureReason?: string;
    /** C3: derived from CURRENT predecessor status; never a stored reason. */
    dependencyFailures?: MeshDependencyFailure[];
    /** Declared graph features, so a view reader can see why a node is advanced. */
    features?: string[];
}

export interface MeshGraphEdgeView {
    from: string;
    to: string;
    kind: string;
    omitOnSkip: boolean;
    /**
     * Human-readable summary of a conditional edge's `run_if`, e.g.
     * `review.outcome == "rejected"`. The stored `condition_json` never
     * reached a reader before, so a blueprint could show THAT a branch was
     * conditional but never on WHAT — "조건부" with no predicate reads as an
     * unexplained label. Summary only: the raw expression stays server-side.
     */
    condition?: string;
    /** False once the source is skipped and the edge was omitted from the projection. */
    active: boolean;
}

export interface MeshGraphGateView {
    gateId: string;
    ref?: string;
    nodeId: string;
    state: MeshGraphGateState;
    action: string;
    instructions?: string;
    onTimeout: string;
    leaseGeneration: number;
    leaseOwnerSessionId?: string;
    leaseExpiresAt?: string;
    /** True when a claimed gate's lease has lapsed — reclaimable at a HIGHER generation. */
    leaseExpired?: boolean;
    deadlineAt?: string;
    releaseOutcome?: string;
    eligibleCoordinatorSessionId?: string;
    /** Worker nodes this gate is currently holding. */
    blocking?: string[];
    /** Optional, caller-requested local git evidence attached by graph-view surfaces. */
    convergenceEvidence?: GateConvergenceEvidence;
}

export interface MeshGraphWorkspaceView {
    ref: string;
    sagaState: MeshGraphWorkspaceSagaState;
    branchIdentity?: string;
    createdNodeId?: string;
    createdWorktreePath?: string;
    lastError?: string;
}

export interface MeshGraphView {
    graphId: string;
    batchId: string;
    status: MeshGraphStatus;
    missionId?: string;
    enqueueSurface: string;
    schemaVersion: number;
    createdAt: string;
    terminalAt?: string;
    /** design :733-738 — the persisted, normalized policy (E-2 now really stores it). */
    onDependencyFailure: string;
    policyInvalid?: string;
    orchestrationDecision?: Record<string, unknown>;
    counts: {
        tasks: number;
        gates: number;
        workspaces: number;
        edges: number;
    };
    /** design :761 — node-state rollup. */
    nodeStates: Record<string, number>;
    nodes: MeshGraphNodeView[];
    edges: MeshGraphEdgeView[];
    gates: MeshGraphGateView[];
    workspaces: MeshGraphWorkspaceView[];
    /** Only populated when a coordinator genuinely must act. */
    nextCoordinatorAction?: Array<{
        kind: 'gate_awaiting' | 'gate_claimed' | 'gate_reclaim' | 'gate_abandon' | 'workspace_compensation' | 'workspace_declared_no_base';
        detail: string;
        gateId?: string;
        workspaceRef?: string;
    }>;
}

/** The states a graph is still doing something in. */
const IN_FLIGHT_GRAPH_STATUSES: readonly MeshGraphStatus[] = [
    'preparing', 'active', 'waiting_gate', 'compensation_required',
];

export interface BuildMeshGraphViewOptions {
    graphId?: string;
    batchId?: string;
    /** Default true: only graphs that still need attention. */
    activeOnly?: boolean;
    limit?: number;
    nowMs?: number;
}

/**
 * Build the graph view for one mesh. Returns newest-first; an explicit graphId or
 * batchId narrows to exactly one graph (including terminal ones, so a completed
 * graph is still inspectable after the fact).
 */
export function buildMeshGraphViews(meshId: string, opts: BuildMeshGraphViewOptions = {}): MeshGraphView[] {
    const store = MeshRuntimeStore.getInstance();
    const graphStore = store.graphStore();
    const nowIso = new Date(opts.nowMs ?? Date.now()).toISOString();

    let graphs;
    if (opts.graphId) {
        const one = graphStore.getGraph(opts.graphId);
        graphs = one && one.meshId === meshId ? [one] : [];
    } else if (opts.batchId) {
        const one = graphStore.getGraphByBatchId(meshId, opts.batchId);
        graphs = one ? [one] : [];
    } else {
        graphs = graphStore.listGraphsByMesh(meshId, {
            ...(opts.activeOnly === false ? {} : { statuses: IN_FLIGHT_GRAPH_STATUSES }),
            limit: opts.limit ?? 20,
        });
    }

    return graphs.map(graph => {
        const nodes = graphStore.listNodes(graph.graphId);
        const edges = graphStore.listEdges(graph.graphId);
        const gates = graphStore.listGatesByGraph(graph.graphId);
        const workspaces = graphStore.listWorkspaceIntents(graph.graphId);
        const byId = new Map(nodes.map(n => [n.nodeId, n]));
        const policy = projectGraphPublicPolicy(graph.policyJson);
        const decision = readOrchestrationDecision(graph.policyJson);

        // Queue-side state for the worker rows this graph owns.
        const queueByTaskId = new Map<string, { status: string; blockedReason?: string; cancelReason?: string; dependsOn?: string[] }>();
        for (const node of nodes) {
            if (!node.queueTaskId) continue;
            const entry = store.findQueueEntryById(meshId, node.queueTaskId);
            if (entry) {
                queueByTaskId.set(node.queueTaskId, {
                    status: entry.status,
                    blockedReason: entry.blockedReason,
                    cancelReason: (entry as { cancelReason?: string }).cancelReason,
                    dependsOn: entry.dependsOn,
                });
            }
        }
        // Predecessor status map for the C3 derivation — every dependency id a node
        // in this graph names, resolved against the live queue (a dependency may
        // point at a task outside this graph).
        const statusById = new Map<string, string>();
        const depMetaById = new Map<string, { blockedReason?: string; cancelReason?: string; status?: string }>();
        for (const [taskId, row] of queueByTaskId) {
            statusById.set(taskId, row.status);
            depMetaById.set(taskId, { status: row.status, blockedReason: row.blockedReason, cancelReason: row.cancelReason });
        }
        for (const row of queueByTaskId.values()) {
            for (const depId of row.dependsOn ?? []) {
                if (statusById.has(depId)) continue;
                const dep = store.findQueueEntryById(meshId, depId);
                if (!dep) continue;
                statusById.set(depId, dep.status);
                depMetaById.set(depId, {
                    status: dep.status,
                    blockedReason: dep.blockedReason,
                    cancelReason: (dep as { cancelReason?: string }).cancelReason,
                });
            }
        }

        const gateByNodeId = new Map(gates.map(g => [g.nodeId, g]));
        const nodeViews: MeshGraphNodeView[] = nodes.map(node => {
            const queue = node.queueTaskId ? queueByTaskId.get(node.queueTaskId) : undefined;
            const gateBlock = parseCoordinatorGateBlock(queue?.blockedReason);
            const failures = queue?.dependsOn?.length
                ? deriveDependencyFailures(queue.dependsOn, statusById, depMetaById)
                : [];
            return {
                nodeId: node.nodeId,
                ...(node.ref ? { ref: node.ref } : {}),
                kind: node.kind,
                state: node.state,
                ...(node.queueTaskId ? { taskId: node.queueTaskId } : {}),
                ...(queue ? { taskStatus: queue.status } : {}),
                ...(queue?.blockedReason ? { blockedReason: queue.blockedReason } : {}),
                ...(gateBlock ? { blockedByGateId: gateBlock.gateId } : {}),
                materializationVersion: node.materializationVersion,
                ...(node.materializedDigest ? { materializedDigest: node.materializedDigest } : {}),
                ...(node.skipReason ? { skipReason: node.skipReason } : {}),
                ...(node.failureReason ? { failureReason: node.failureReason } : {}),
                ...(failures.length > 0 ? { dependencyFailures: failures } : {}),
                ...(describeNodeFeatures(node.baseSpecJson).length > 0
                    ? { features: describeNodeFeatures(node.baseSpecJson) }
                    : {}),
            };
        });

        const edgeViews: MeshGraphEdgeView[] = edges.map(edge => {
            const source = byId.get(edge.fromNodeId);
            // An omitted skipped edge is exactly the case C1 removes from the
            // downstream projection (design :361-366).
            const active = !(source?.state === 'skipped' && edge.omitOnSkip);
            const condition = describeEdgeCondition(edge.conditionJson);
            return {
                from: source?.ref ?? edge.fromNodeId,
                to: byId.get(edge.toNodeId)?.ref ?? edge.toNodeId,
                kind: edge.kind,
                omitOnSkip: edge.omitOnSkip,
                active,
                ...(condition ? { condition } : {}),
            };
        });

        const gateViews: MeshGraphGateView[] = gates.map(gate => {
            const blocking = nodeViews
                .filter(n => n.blockedByGateId === gate.gateId)
                .map(n => n.ref ?? n.nodeId);
            const leaseExpired = gate.state === 'claimed' && !!gate.leaseExpiresAt && gate.leaseExpiresAt <= nowIso;
            return {
                gateId: gate.gateId,
                ...(gate.ref ? { ref: gate.ref } : {}),
                nodeId: gate.nodeId,
                state: gate.state,
                action: gate.action,
                ...(gate.instructions ? { instructions: gate.instructions } : {}),
                onTimeout: gate.onTimeout,
                leaseGeneration: gate.leaseGeneration,
                ...(gate.leaseOwnerSessionId ? { leaseOwnerSessionId: gate.leaseOwnerSessionId } : {}),
                ...(gate.leaseExpiresAt ? { leaseExpiresAt: gate.leaseExpiresAt } : {}),
                ...(leaseExpired ? { leaseExpired: true } : {}),
                ...(gate.deadlineAt ? { deadlineAt: gate.deadlineAt } : {}),
                ...(gate.releaseOutcome ? { releaseOutcome: gate.releaseOutcome } : {}),
                ...(gate.eligibleCoordinatorSessionId ? { eligibleCoordinatorSessionId: gate.eligibleCoordinatorSessionId } : {}),
                ...(blocking.length > 0 ? { blocking } : {}),
            };
        });

        const nodeStates: Record<string, number> = {};
        for (const node of nodes) nodeStates[node.state] = (nodeStates[node.state] ?? 0) + 1;

        // ★ Orphan detection. A gate whose downstream work is ALL terminal-and-
        // unrunnable (cancelled/failed/skipped) has nothing left to open: releasing
        // it would materialize nothing. It is the stranded case that makes a graph
        // uncloseable, because the C3 cancel cascade deliberately leaves gate nodes
        // alone and the deadline sweep skips gates with no deadline. Reported so the
        // coordinator is pointed at abandon instead of hunting for a cleanup verb.
        const orphanedGateIds = new Set<string>();
        for (const gate of gates) {
            if (gate.state !== 'awaiting_coordinator' && gate.state !== 'claimed' && gate.state !== 'expired') continue;
            const downstream = edges
                .filter(e => e.fromNodeId === gate.nodeId)
                .map(e => byId.get(e.toNodeId))
                .filter((n): n is NonNullable<typeof n> => !!n);
            // A TERMINAL gate (no downstream at all) is legitimate — a graph may end
            // at a gate — so it is never an orphan. Only a gate that HAD dependents
            // and lost every one of them is.
            if (downstream.length === 0) continue;
            if (downstream.every(n => n.state === 'cancelled' || n.state === 'failed' || n.state === 'skipped')) {
                orphanedGateIds.add(gate.gateId);
            }
        }

        const actions: NonNullable<MeshGraphView['nextCoordinatorAction']> = [];
        for (const gate of gateViews) {
            if (orphanedGateIds.has(gate.gateId)) {
                actions.push({
                    kind: 'gate_abandon',
                    gateId: gate.gateId,
                    detail: `Gate '${gate.ref ?? gate.gateId}' (${gate.action}) is ORPHANED: every task it was gating is already `
                        + 'cancelled, failed or skipped, so releasing it would open nothing. While it stays unsettled this graph '
                        + 'cannot reach ANY terminal state — not even cancelled. Close it with mesh_graph_gate_abandon and a reason. '
                        + 'Abandon cancels what the gate was holding; it never passes the gate.',
                });
                continue;
            }
            if (gate.state === 'awaiting_coordinator') {
                actions.push({
                    kind: 'gate_awaiting',
                    gateId: gate.gateId,
                    detail: `Gate '${gate.ref ?? gate.gateId}' (${gate.action}) is awaiting a coordinator. `
                        + 'Claim it with mesh_graph_gate_claim, perform the action, then release it with mesh_graph_gate_release.',
                });
            } else if (gate.state === 'claimed' && gate.leaseExpired) {
                actions.push({
                    kind: 'gate_reclaim',
                    gateId: gate.gateId,
                    detail: `Gate '${gate.ref ?? gate.gateId}' has a LAPSED lease (generation ${gate.leaseGeneration}). `
                        + 'Reclaim it to get a higher generation; the previous owner may already have performed the external side effect, '
                        + 'so reconcile external evidence before acting again.',
                });
            } else if (gate.state === 'claimed') {
                actions.push({
                    kind: 'gate_claimed',
                    gateId: gate.gateId,
                    detail: `Gate '${gate.ref ?? gate.gateId}' is claimed by ${gate.leaseOwnerSessionId ?? 'a coordinator'} `
                        + `until ${gate.leaseExpiresAt ?? 'lease expiry'}; release it to advance the graph.`,
                });
            } else if (gate.state === 'expired' && gate.onTimeout === 'hold') {
                actions.push({
                    kind: 'gate_reclaim',
                    gateId: gate.gateId,
                    detail: `Gate '${gate.ref ?? gate.gateId}' passed its deadline under on_timeout=hold — downstream is still held. `
                        + 'Reclaim it with mesh_graph_gate_claim (optionally with extend_deadline_seconds) to resume, '
                        + 'or give it up with mesh_graph_gate_abandon, which cancels what it was holding instead of opening it. '
                        + 'A timeout is never passage: the gate cannot release itself.',
                });
            }
        }
        for (const ws of workspaces) {
            if (ws.sagaState === 'compensation_required') {
                actions.push({
                    kind: 'workspace_compensation',
                    workspaceRef: ws.workspaceRef,
                    detail: `Workspace '${ws.workspaceRef}' needs manual compensation: ${ws.lastError ?? 'compensation refused'}.`,
                });
            } else if (ws.sagaState === 'declared' && !ws.baseRevision) {
                // The saga parks a base-less intent in 'declared' and retries silently.
                // The retry is only productive once a base revision exists, so this IS a
                // required coordinator action, not ordinary in-flight work — without it
                // the graph looks alive while making no progress at all.
                actions.push({
                    kind: 'workspace_declared_no_base',
                    workspaceRef: ws.workspaceRef,
                    detail: `Workspace '${ws.workspaceRef}' is stuck in 'declared': no base_revision was given and none could be derived from `
                        + `${ws.sourceNodeId ? `source node '${ws.sourceNodeId}' (its repo is unreachable on this daemon, or git could not resolve its HEAD)` : 'a source node, because the declaration named none'}. `
                        + 'The workspace will never clone and every task bound to it stays blocked. '
                        + `Re-declare the workspace with an explicit base_revision (e.g. 'main')${ws.sourceNodeId ? '' : ' and a source_node_id'}.`,
                });
            }
        }

        return {
            graphId: graph.graphId,
            batchId: graph.batchId,
            status: graph.status,
            ...(graph.missionId ? { missionId: graph.missionId } : {}),
            enqueueSurface: graph.enqueueSurface,
            schemaVersion: graph.schemaVersion,
            createdAt: graph.createdAt,
            ...(graph.terminalAt ? { terminalAt: graph.terminalAt } : {}),
            onDependencyFailure: policy.on_dependency_failure,
            ...(policy.policyInvalid ? { policyInvalid: policy.policyInvalid } : {}),
            ...(decision ? { orchestrationDecision: decision } : {}),
            counts: {
                tasks: graph.taskCount,
                gates: graph.gateCount,
                workspaces: graph.workspaceCount,
                edges: graph.dependencyEdgeCount,
            },
            nodeStates,
            nodes: nodeViews,
            edges: edgeViews,
            gates: gateViews,
            workspaces: workspaces.map(w => ({
                ref: w.workspaceRef,
                sagaState: w.sagaState,
                ...(w.branchIdentity ? { branchIdentity: w.branchIdentity } : {}),
                ...(w.createdNodeId ? { createdNodeId: w.createdNodeId } : {}),
                ...(w.createdWorktreePath ? { createdWorktreePath: w.createdWorktreePath } : {}),
                ...(w.lastError ? { lastError: w.lastError } : {}),
            })),
            ...(actions.length > 0 ? { nextCoordinatorAction: actions } : {}),
        };
    });
}

/** Exact count for the same selector used by buildMeshGraphViews, before limit. */
export function countMeshGraphViews(meshId: string, opts: BuildMeshGraphViewOptions = {}): number {
    const graphStore = MeshRuntimeStore.getInstance().graphStore();
    if (opts.graphId) {
        const graph = graphStore.getGraph(opts.graphId);
        return graph && graph.meshId === meshId ? 1 : 0;
    }
    if (opts.batchId) return graphStore.getGraphByBatchId(meshId, opts.batchId) ? 1 : 0;
    return graphStore.countGraphsByMesh(meshId, {
        ...(opts.activeOnly === false ? {} : { statuses: IN_FLIGHT_GRAPH_STATUSES }),
    });
}

/** Which advanced graph features a node declared — enough to explain a hold, no spec contents. */
/**
 * One-line, human-readable rendering of a `run_if` expression.
 *
 * The grammar is small and closed (all/any/not over exists/eq/ne/in with a
 * JSON Pointer selector — see parseRunIfCondition), so a faithful short form
 * is possible without leaking arbitrary content: selectors and literal
 * comparands are the author's own plan text, the same class of string as the
 * `ref` values already carried here.
 *
 * Returns undefined for absent/!unparseable input so the UI renders nothing
 * rather than a misleading half-condition.
 */
export function describeEdgeCondition(conditionJson: string | undefined): string | undefined {
    if (typeof conditionJson !== 'string' || conditionJson.length === 0) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(conditionJson);
    } catch {
        return undefined;
    }
    const text = renderCondition(parsed, 0);
    return text && text.length <= 120 ? text : text ? `${text.slice(0, 117)}...` : undefined;
}

function renderCondition(node: unknown, depth: number): string | undefined {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    if (depth > 4) return '...';
    const value = node as Record<string, unknown>;
    for (const key of ['all', 'any'] as const) {
        const list = value[key];
        if (Array.isArray(list) && list.length > 0) {
            const parts = list.map(entry => renderCondition(entry, depth + 1)).filter(Boolean) as string[];
            if (parts.length === 0) return undefined;
            const joined = parts.join(key === 'all' ? ' and ' : ' or ');
            return depth > 0 ? `(${joined})` : joined;
        }
    }
    if (value.not !== undefined) {
        const inner = renderCondition(value.not, depth + 1);
        return inner ? `not ${inner}` : undefined;
    }
    if (typeof value.op !== 'string') return undefined;
    const selector = typeof value.select === 'string' && value.select ? value.select.replace(/^\//, '').replace(/\//g, '.') : '';
    const subject = [typeof value.from === 'string' ? value.from : '', selector].filter(Boolean).join('.') || 'result';
    switch (value.op) {
        case 'exists': return `${subject} exists`;
        case 'eq': return `${subject} == ${renderLiteral(value.value)}`;
        case 'ne': return `${subject} != ${renderLiteral(value.value)}`;
        case 'in': return `${subject} in ${renderLiteral(value.value)}`;
        default: return undefined;
    }
}

function renderLiteral(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(renderLiteral).join(', ')}]`;
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'object') return '{...}';
    return String(value);
}

function describeNodeFeatures(baseSpecJson: string): string[] {
    let spec: Record<string, unknown> | undefined;
    try {
        const parsed = JSON.parse(baseSpecJson);
        spec = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
    } catch {
        return ['invalid_base_spec'];
    }
    if (!spec) return [];
    const features: string[] = [];
    if (Array.isArray(spec.inputs_from) && spec.inputs_from.length > 0) features.push('inputs_from');
    if (spec.run_if !== undefined) features.push('run_if');
    if (typeof spec.workspace_ref === 'string' && spec.workspace_ref) features.push('workspace_ref');
    return features;
}

/** The enqueue-decision provenance record stored next to the policy (design :697-710). */
function readOrchestrationDecision(policyJson: string | undefined): Record<string, unknown> | undefined {
    if (!policyJson) return undefined;
    try {
        const parsed = JSON.parse(policyJson);
        const decision = parsed?.orchestration_decision;
        return decision && typeof decision === 'object' && !Array.isArray(decision)
            ? decision as Record<string, unknown>
            : undefined;
    } catch {
        return undefined;
    }
}
