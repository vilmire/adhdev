/**
 * Coordinator notices for STOPPED downstream work — the "tell the coordinator
 * with enough to act on" half of graph failure handling
 * (the 2026-09-25 graph orchestration simplification §5).
 *
 * Three events, one notice each:
 *   - `graph_dependency_blocked`   — `block` policy: a step FAILED and its
 *     downstream steps now wait on it forever unless the coordinator acts.
 *   - `graph_dependency_cancelled` — `cancel` policy: a failure/cancel cascade
 *     cancelled downstream steps and abandoned gates.
 *   - `graph_stalled`              — a graph still `active` with nothing
 *     running, runnable or awaiting a gate (detected by the housekeeping sweep).
 *
 * The first two ride the graph outbox (written in the terminal transaction,
 * drained after commit, delivered once); the third is emitted directly by the
 * sweep. All three become ONE coordinator notice through
 * `notifyMeshCoordinator`, which serves both a PTY-hosted coordinator (chat
 * injection) and an MCP-only coordinator (pendingCoordinatorEvents) from the
 * same notice row — so neither consumer can miss one.
 *
 * ★ Content boundary: the text and metadata carry ONLY ids, refs, enums,
 * reason CODES and counts — never a task message, failure prose or blocked
 * reason text. `reasonCodeOf` reduces any reason string to its leading code.
 *
 * ★ Dedupe: every notice has an explicit eventId keyed on graph + root node +
 * generation (the root task's output version for a–b, a state fingerprint for
 * c), so a replay, a re-drain or a repeated sweep never pages twice, while a
 * retried-and-failed-again step (new output version) pages again.
 *
 * Pure module: no store, no runtime — imported by the runner (payload parse),
 * event forwarding (render + notify) and the staleness sweep.
 */

export const GRAPH_STOP_OUTBOX_KINDS = [
    'graph_dependency_blocked',
    'graph_dependency_cancelled',
    // Queue-level `depends_on` chains (mesh_enqueue_task — the D1 default — and a
    // static mesh_enqueue_batch) have no graph rows; same notices, queue-shaped.
    'queue_dependency_blocked',
    'queue_dependency_cancelled',
] as const;
export type MeshGraphStopOutboxKind = typeof GRAPH_STOP_OUTBOX_KINDS[number];

/** A graph node named in a notice — identifiers only. */
export interface MeshGraphStopNodeRef {
    nodeId: string;
    ref?: string;
    kind?: 'worker_task' | 'coordinator_gate';
    taskId?: string;
    gateId?: string;
    /** Graph node state (enum), for the stall notice. */
    state?: string;
    /** Leading reason code only (e.g. `materialization_error`), never prose. */
    reasonCode?: string;
}

export interface MeshGraphStopRoot {
    nodeId: string;
    ref?: string;
    taskId?: string;
    outcome: 'failed' | 'cancelled';
    reasonCode: string;
}

export interface MeshGraphDependencyBlockedNotice {
    kind: 'graph_dependency_blocked';
    meshId: string;
    graphId: string;
    /** Root task's output version — a retry that fails again is a new event. */
    generation: number;
    root: MeshGraphStopRoot;
    blocked: MeshGraphStopNodeRef[];
}

export interface MeshGraphDependencyCancelledNotice {
    kind: 'graph_dependency_cancelled';
    meshId: string;
    graphId: string;
    generation: number;
    root: MeshGraphStopRoot;
    cancelled: MeshGraphStopNodeRef[];
    abandonedGates: Array<{ gateId: string; ref?: string; reason: string }>;
}

export interface MeshGraphStalledNotice {
    kind: 'graph_stalled';
    meshId: string;
    graphId: string;
    /** Deterministic fingerprint of the stuck configuration (dedupe generation). */
    fingerprint: string;
    stuck: MeshGraphStopNodeRef[];
    /** Failed/cancelled nodes the stuck ones wait on (their upstream). */
    deadUpstream: MeshGraphStopNodeRef[];
}

/** A queue task a queue-chain notice names: ids only (+ the dependency it waits through). */
export interface MeshQueueStopTaskRef {
    taskId: string;
    /** The dependency id this task waits on inside the chain (transitive chains). */
    via?: string;
}

export interface MeshQueueStopRoot {
    taskId: string;
    outcome: 'failed' | 'cancelled';
    reasonCode: string;
}

/** Queue chain, `block` policy (the default): tasks now wait on a failed/cancelled task. */
export interface MeshQueueDependencyBlockedNotice {
    kind: 'queue_dependency_blocked';
    meshId: string;
    generation: number;
    root: MeshQueueStopRoot;
    waiting: MeshQueueStopTaskRef[];
}

/** Queue chain, `cancel` policy: the failure cancelled its dependents. */
export interface MeshQueueDependencyCancelledNotice {
    kind: 'queue_dependency_cancelled';
    meshId: string;
    generation: number;
    root: MeshQueueStopRoot;
    cancelled: MeshQueueStopTaskRef[];
}

/** Housekeeping catch-all: pending queue tasks behind a dead dependency no notice covered. */
export interface MeshQueueChainStalledNotice {
    kind: 'queue_chain_stalled';
    meshId: string;
    fingerprint: string;
    root: MeshQueueStopRoot;
    waiting: MeshQueueStopTaskRef[];
}

export type MeshGraphStopNotice =
    | MeshGraphDependencyBlockedNotice
    | MeshGraphDependencyCancelledNotice
    | MeshGraphStalledNotice
    | MeshQueueDependencyBlockedNotice
    | MeshQueueDependencyCancelledNotice
    | MeshQueueChainStalledNotice;

/** How many nodes a notice lists by name before summarising the rest as a count. */
export const GRAPH_STOP_NOTICE_LIST_CAP = 10;

/**
 * The leading machine code of a reason string: `max_retries_exceeded: requeued
 * 2 time(s)…` → `max_retries_exceeded`, `dependency_failed:abc` →
 * `dependency_failed`. Anything that does not start with a code-shaped token
 * collapses to `unspecified`, so free text can never leak through.
 */
export function reasonCodeOf(reason: string | undefined | null): string {
    if (typeof reason !== 'string') return 'unspecified';
    // Codes are lower snake_case; anything else (operator/agent text) is not a code.
    const m = /^[a-z][a-z0-9_]{0,63}/.exec(reason.trim());
    if (!m) return 'unspecified';
    // A code is one token; `workspace 'x' is failed…` starts with a word, not a code.
    const next = reason.trim().charAt(m[0].length);
    if (next !== '' && next !== ':') return 'unspecified';
    return m[0].toLowerCase();
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v : undefined);

function parseNodeRefs(raw: unknown): MeshGraphStopNodeRef[] {
    if (!Array.isArray(raw)) return [];
    const out: MeshGraphStopNodeRef[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        const nodeId = str(r.nodeId);
        if (!nodeId) continue;
        out.push({
            nodeId,
            ...(str(r.ref) ? { ref: str(r.ref) } : {}),
            ...(r.kind === 'worker_task' || r.kind === 'coordinator_gate' ? { kind: r.kind } : {}),
            ...(str(r.taskId) ? { taskId: str(r.taskId) } : {}),
            ...(str(r.gateId) ? { gateId: str(r.gateId) } : {}),
            ...(str(r.state) ? { state: str(r.state) } : {}),
            ...(str(r.reasonCode) ? { reasonCode: str(r.reasonCode) } : {}),
        });
    }
    return out;
}

function parseRoot(raw: unknown): MeshGraphStopRoot | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const nodeId = str(r.nodeId);
    if (!nodeId) return null;
    return {
        nodeId,
        ...(str(r.ref) ? { ref: str(r.ref) } : {}),
        ...(str(r.taskId) ? { taskId: str(r.taskId) } : {}),
        outcome: r.outcome === 'cancelled' ? 'cancelled' : 'failed',
        reasonCode: str(r.reasonCode) ?? 'unspecified',
    };
}

function parseQueueRoot(raw: unknown): MeshQueueStopRoot | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const taskId = str(r.taskId);
    if (!taskId) return null;
    return { taskId, outcome: r.outcome === 'cancelled' ? 'cancelled' : 'failed', reasonCode: str(r.reasonCode) ?? 'unspecified' };
}

function parseQueueTaskRefs(raw: unknown): MeshQueueStopTaskRef[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && !!str((t as any).taskId))
        .map(t => ({ taskId: str(t.taskId)!, ...(str(t.via) ? { via: str(t.via) } : {}) }));
}

/** Outbox row → notice; null for a malformed row (the drain marks it delivered anyway). */
export function parseGraphStopOutbox(kind: string, meshId: string, rawPayload: string | null | undefined): MeshGraphStopNotice | null {
    if (!(GRAPH_STOP_OUTBOX_KINDS as readonly string[]).includes(kind)) return null;
    let payload: Record<string, unknown> = {};
    try {
        const parsed = rawPayload ? JSON.parse(rawPayload) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch { return null; }
    if (kind === 'queue_dependency_blocked' || kind === 'queue_dependency_cancelled') {
        const root = parseQueueRoot(payload.root);
        if (!root) return null;
        const generation = typeof payload.generation === 'number' && Number.isFinite(payload.generation) ? payload.generation : 0;
        return kind === 'queue_dependency_blocked'
            ? { kind, meshId, generation, root, waiting: parseQueueTaskRefs(payload.waiting) }
            : { kind, meshId, generation, root, cancelled: parseQueueTaskRefs(payload.cancelled) };
    }
    const graphId = str(payload.graphId);
    const root = parseRoot(payload.root);
    if (!graphId || !root) return null;
    const generation = typeof payload.generation === 'number' && Number.isFinite(payload.generation) ? payload.generation : 0;
    if (kind === 'graph_dependency_blocked') {
        return { kind, meshId, graphId, generation, root, blocked: parseNodeRefs(payload.blocked) };
    }
    const gates = Array.isArray(payload.abandonedGates) ? payload.abandonedGates : [];
    return {
        kind: 'graph_dependency_cancelled',
        meshId,
        graphId,
        generation,
        root,
        cancelled: parseNodeRefs(payload.cancelled),
        abandonedGates: gates
            .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object' && !!str((g as any).gateId))
            .map(g => ({ gateId: str(g.gateId)!, ...(str(g.ref) ? { ref: str(g.ref) } : {}), reason: str(g.reason) ?? 'unspecified' })),
    };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function label(n: { ref?: string; nodeId: string }): string {
    return n.ref ? `'${n.ref}'` : `node ${n.nodeId.slice(0, 8)}`;
}

function describeNode(n: MeshGraphStopNodeRef): string {
    if (n.kind === 'coordinator_gate') return `gate ${label(n)}${n.gateId ? ` (gate_id ${n.gateId})` : ''}`;
    return `${label(n)}${n.taskId ? ` (task ${n.taskId})` : ''}`;
}

function listCapped<T>(items: T[], render: (t: T) => string): string {
    const shown = items.slice(0, GRAPH_STOP_NOTICE_LIST_CAP).map(render);
    const rest = items.length - shown.length;
    return shown.join(', ') + (rest > 0 ? `, +${rest} more (mesh_graph_view)` : '');
}

function describeRoot(root: MeshGraphStopRoot): string {
    return `step ${label(root)}${root.taskId ? ` (task ${root.taskId})` : ''} ${root.outcome === 'failed' ? 'failed' : 'was cancelled'} (reason: ${root.reasonCode})`;
}

export interface RenderedGraphStopNotice {
    event: string;
    eventId: string;
    nodeLabel: string;
    coordinatorMessage: string;
    metadataEvent: Record<string, unknown>;
}

function shortTask(taskId: string): string {
    return taskId.slice(0, 8);
}

function describeQueueTask(t: MeshQueueStopTaskRef): string {
    return `${shortTask(t.taskId)} (task_id ${t.taskId}${t.via ? `, via ${shortTask(t.via)}` : ''})`;
}

function queueIdList(tasks: MeshQueueStopTaskRef[]): string {
    return tasks.slice(0, GRAPH_STOP_NOTICE_LIST_CAP).map(t => `'${t.taskId}'`).join(', ')
        + (tasks.length > GRAPH_STOP_NOTICE_LIST_CAP ? ` (+${tasks.length - GRAPH_STOP_NOTICE_LIST_CAP} more — mesh_view_queue)` : '');
}

function renderQueueStopNotice(
    n: MeshQueueDependencyBlockedNotice | MeshQueueDependencyCancelledNotice | MeshQueueChainStalledNotice,
): RenderedGraphStopNotice {
    const root = n.root;
    const rootLabel = `${shortTask(root.taskId)} (task_id ${root.taskId})`;
    const requeue = `mesh_queue_requeue(task_id='${root.taskId}', force=true)`;
    if (n.kind === 'queue_dependency_cancelled') {
        const coordinatorMessage =
            `Queue task ${rootLabel} ${root.outcome === 'failed' ? 'failed' : 'was cancelled'} (reason: ${root.reasonCode}). `
            + `Under on_dependency_failure=cancel, ${n.cancelled.length} dependent task(s) were cancelled: ${listCapped(n.cancelled, describeQueueTask)}. `
            + 'Cancelled tasks do not revive — if the work is still wanted, fix the cause and enqueue replacements (mesh_enqueue_task with depends_on).';
        return {
            event: 'mesh:queue_dependency_cancelled',
            eventId: `queue:queue_dependency_cancelled:${root.taskId}:${n.generation}`,
            nodeLabel: shortTask(root.taskId),
            coordinatorMessage,
            metadataEvent: {
                source: 'mesh_queue_dependency',
                taskId: root.taskId,
                rootOutcome: root.outcome,
                reasonCode: root.reasonCode,
                generation: n.generation,
                cancelledTaskIds: n.cancelled.map(t => t.taskId),
                policy: 'cancel',
            },
        };
    }
    const operatorCancel = root.outcome === 'cancelled' && root.reasonCode === 'operator_cancel';
    const waiting = n.waiting;
    const head = n.kind === 'queue_chain_stalled'
        ? `${waiting.length} pending queue task(s) can never start: they wait (depends_on) on ${rootLabel}, which ended ${root.outcome} (reason: ${root.reasonCode}): `
        : operatorCancel
            ? `${waiting.length} task(s) still wait on the task you cancelled, ${rootLabel} (reason: operator_cancel): `
            : `Queue task ${rootLabel} ${root.outcome === 'failed' ? 'failed' : 'was cancelled'} (reason: ${root.reasonCode}) and ${waiting.length} task(s) still wait on it: `;
    const next = operatorCancel
        ? `Next: cancel them too with mesh_queue_cancel(task_id=…) for ${queueIdList(waiting)}; or, if the cancel was a mistake, ${requeue} and they run once it completes.`
        : `Next: retry it with ${requeue} (add message=<corrected instruction> to change the approach) — the waiting tasks then run automatically; or drop them with mesh_queue_cancel(task_id=…) for ${queueIdList(waiting)}.`;
    const coordinatorMessage = `${head}${listCapped(waiting, describeQueueTask)}. `
        + 'Policy is on_dependency_failure=block (the default), so nothing was cancelled and they will not run on their own. '
        + next;
    const event = n.kind === 'queue_chain_stalled' ? 'mesh:queue_chain_stalled' : 'mesh:queue_dependency_blocked';
    return {
        event,
        eventId: n.kind === 'queue_chain_stalled'
            ? `queue:queue_chain_stalled:${root.taskId}:${n.fingerprint}`
            : `queue:queue_dependency_blocked:${root.taskId}:${n.generation}`,
        nodeLabel: shortTask(root.taskId),
        coordinatorMessage,
        metadataEvent: {
            source: n.kind === 'queue_chain_stalled' ? 'mesh_queue_stall_sweep' : 'mesh_queue_dependency',
            taskId: root.taskId,
            rootOutcome: root.outcome,
            reasonCode: root.reasonCode,
            ...(n.kind === 'queue_chain_stalled' ? { fingerprint: n.fingerprint } : { generation: n.generation }),
            waitingTaskIds: waiting.map(t => t.taskId),
            policy: 'block',
        },
    };
}

/** Notice → the exact coordinator-facing text + a content-free metadata record. */
export function renderGraphStopNotice(n: MeshGraphStopNotice): RenderedGraphStopNotice {
    if (n.kind === 'queue_dependency_blocked' || n.kind === 'queue_dependency_cancelled' || n.kind === 'queue_chain_stalled') {
        return renderQueueStopNotice(n);
    }
    const graphShort = n.graphId.slice(0, 8);
    if (n.kind === 'graph_dependency_blocked') {
        const tasks = n.blocked.filter(b => b.kind !== 'coordinator_gate' && b.taskId);
        const gates = n.blocked.filter(b => b.kind === 'coordinator_gate' && b.gateId);
        const patchTarget = tasks[0];
        const actions: string[] = [];
        if (n.root.taskId) {
            actions.push(`retry it with mesh_queue_requeue(task_id='${n.root.taskId}', force=true) — add message=<corrected instruction> if it needs a different approach; the blocked steps start automatically once it completes`);
        }
        if (patchTarget) {
            actions.push(`if a blocked step's inputs/condition must change, mesh_graph_node_patch(node='${patchTarget.ref ?? patchTarget.nodeId}', graph_id='${n.graphId}')`);
        }
        const giveUp: string[] = [];
        if (tasks.length > 0) giveUp.push(`mesh_queue_cancel(task_id=…) for ${tasks.map(t => `'${t.taskId}'`).slice(0, GRAPH_STOP_NOTICE_LIST_CAP).join(', ')}`);
        if (gates.length > 0) giveUp.push(`mesh_graph_gate_abandon(gate_id=…) for ${gates.map(g => `'${g.gateId}'`).slice(0, GRAPH_STOP_NOTICE_LIST_CAP).join(', ')}`);
        if (giveUp.length > 0) actions.push(`or drop this branch: ${giveUp.join(' and ')} (a gate left guarding only cancelled work closes itself)`);
        const coordinatorMessage =
            `Graph ${n.graphId}: ${describeRoot(n.root)} and ${n.blocked.length} downstream step(s) are now blocked waiting on it: `
            + `${listCapped(n.blocked, describeNode)}. Policy is on_dependency_failure=block, so nothing was cancelled and nothing will move on its own. `
            + `Next: ${actions.join('; ')}.`;
        return {
            event: 'mesh:graph_dependency_blocked',
            eventId: `graph:graph_dependency_blocked:${n.graphId}:${n.root.nodeId}:${n.generation}`,
            nodeLabel: n.root.ref ?? graphShort,
            coordinatorMessage,
            metadataEvent: {
                source: 'mesh_graph_outbox',
                taskId: n.root.taskId ?? n.root.nodeId,
                graphId: n.graphId,
                rootNodeId: n.root.nodeId,
                ...(n.root.ref ? { rootRef: n.root.ref } : {}),
                reasonCode: n.root.reasonCode,
                generation: n.generation,
                blockedNodeIds: n.blocked.map(b => b.nodeId),
                blockedTaskIds: tasks.map(t => t.taskId),
                blockedGateIds: gates.map(g => g.gateId),
                policy: 'block',
            },
        };
    }
    if (n.kind === 'graph_dependency_cancelled') {
        const gatePart = n.abandonedGates.length > 0
            ? ` and ${n.abandonedGates.length} gate(s) abandoned: ${listCapped(n.abandonedGates, g => `${g.ref ? `'${g.ref}'` : g.gateId.slice(0, 8)} (${g.reason})`)}`
            : '';
        const coordinatorMessage =
            `Graph ${n.graphId}: ${describeRoot(n.root)}. Under on_dependency_failure=cancel, ${n.cancelled.length} downstream step(s) were cancelled`
            + `${n.cancelled.length > 0 ? `: ${listCapped(n.cancelled, describeNode)}` : ''}${gatePart}. Nothing in this branch will run. `
            + `If the branch is still wanted, fix the cause and re-plan it: enqueue replacement steps with mesh_enqueue_task / mesh_enqueue_batch `
            + `(cancelled tasks do not revive). Inspect with mesh_graph_view(graph_id='${n.graphId}').`;
        return {
            event: 'mesh:graph_dependency_cancelled',
            eventId: `graph:graph_dependency_cancelled:${n.graphId}:${n.root.nodeId}:${n.generation}`,
            nodeLabel: n.root.ref ?? graphShort,
            coordinatorMessage,
            metadataEvent: {
                source: 'mesh_graph_outbox',
                taskId: n.root.taskId ?? n.root.nodeId,
                graphId: n.graphId,
                rootNodeId: n.root.nodeId,
                ...(n.root.ref ? { rootRef: n.root.ref } : {}),
                rootOutcome: n.root.outcome,
                reasonCode: n.root.reasonCode,
                generation: n.generation,
                cancelledNodeIds: n.cancelled.map(c => c.nodeId),
                cancelledTaskIds: n.cancelled.map(c => c.taskId).filter(Boolean),
                abandonedGateIds: n.abandonedGates.map(g => g.gateId),
                policy: 'cancel',
            },
        };
    }
    // graph_stalled
    const actions: string[] = [];
    const matErr = n.stuck.filter(s => s.reasonCode === 'materialization_error');
    if (matErr.length > 0) {
        actions.push(`fix ${matErr.map(s => label(s)).join(', ')} with mesh_graph_node_patch(node=…, graph_id='${n.graphId}')`);
    }
    const deadTasks = n.deadUpstream.filter(d => d.taskId);
    if (deadTasks.length > 0) {
        actions.push(`retry what they wait on with mesh_queue_requeue(task_id=…, force=true) for ${deadTasks.slice(0, GRAPH_STOP_NOTICE_LIST_CAP).map(d => `'${d.taskId}' (${label(d)}, ${d.state})`).join(', ')}`);
    }
    const stuckTasks = n.stuck.filter(s => s.kind !== 'coordinator_gate' && s.taskId);
    const stuckGates = n.stuck.filter(s => s.kind === 'coordinator_gate' && s.gateId);
    const drop: string[] = [];
    if (stuckTasks.length > 0) drop.push(`mesh_queue_cancel(task_id=…) for ${stuckTasks.slice(0, GRAPH_STOP_NOTICE_LIST_CAP).map(s => `'${s.taskId}'`).join(', ')}`);
    if (stuckGates.length > 0) drop.push(`mesh_graph_gate_abandon(gate_id=…) for ${stuckGates.slice(0, GRAPH_STOP_NOTICE_LIST_CAP).map(s => `'${s.gateId}'`).join(', ')}`);
    if (drop.length > 0) actions.push(`or settle the graph: ${drop.join(' and ')}`);
    const deadPart = n.deadUpstream.length > 0
        ? ` They wait on ${listCapped(n.deadUpstream, d => `${label(d)} (${d.state})`)}.`
        : '';
    const coordinatorMessage =
        `Graph ${n.graphId} is still active but nothing can move: no step is running, runnable, or awaiting a gate. `
        + `Stuck (${n.stuck.length}): ${listCapped(n.stuck, s => `${label(s)} [${s.state}${s.reasonCode ? `, ${s.reasonCode}` : ''}]${s.taskId ? ` task ${s.taskId}` : s.gateId ? ` gate_id ${s.gateId}` : ''}`)}.`
        + `${deadPart} Next: ${actions.length > 0 ? actions.join('; ') : `inspect with mesh_graph_view(graph_id='${n.graphId}')`}.`;
    return {
        event: 'mesh:graph_stalled',
        eventId: `graph:graph_stalled:${n.graphId}:${n.fingerprint}`,
        nodeLabel: graphShort,
        coordinatorMessage,
        metadataEvent: {
            source: 'mesh_graph_stall_sweep',
            taskId: `${n.graphId}:stalled:${n.fingerprint}`,
            graphId: n.graphId,
            fingerprint: n.fingerprint,
            stuckNodeIds: n.stuck.map(s => s.nodeId),
            deadUpstreamNodeIds: n.deadUpstream.map(d => d.nodeId),
        },
    };
}
