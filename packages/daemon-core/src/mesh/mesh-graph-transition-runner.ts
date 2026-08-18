/**
 * GRAPH-ORCHESTRATION Phase B — the single transactional terminal choke point
 * (design docs/design/2026-08-18-graph-orchestration-full.md :311-334).
 *
 * `commitTaskTerminalAndAdvanceGraph(terminal, completionEnvelope)` is THE one
 * entry point for genuine terminal acceptance. Every genuine completion path —
 * `agent:generating_completed`, completion-via-ready, and every stall/redrive/
 * zombie reconcile flip — reaches it through the two queue status mutators in
 * mesh-work-queue.ts (`updateTaskStatus`, `updateSessionTaskStatus`), which
 * delegate their terminal branch here. One call performs, inside the existing
 * mesh queue lock (ONE better-sqlite3 immediate transaction):
 *
 *   1. Fence and accept the terminal attempt (proposeTurnCompletion — the
 *      d18e9838 choke-point settle MOVED here; see the settle-ownership note
 *      in mesh-work-queue.ts updateTaskStatus).
 *   2. Persist the normalized output version (append-only mesh_task_outputs).
 *   3. Flip the upstream queue row to its terminal status.
 *   4. Advance affected graph nodes deterministically (upstream node →
 *      terminal; graph rollup when every node is terminal-equivalent).
 *   5. Evaluate `run_if` for nodes whose graph inputs are now settled ★ PHASE C1:
 *      declarative all/any/not over exists/eq/ne/in leaves with JSON Pointer
 *      selectors (mesh-graph-input-binding.ts). False ⇒ the node and its queue
 *      placeholder go `skipped`, and outgoing edges resolve per `on_upstream_skip`
 *      (default `skip` propagates; `omit_dependency` removes the edge from the
 *      downstream queue projection — design :336-369).
 *   6. Materialize eligible downstream worker nodes ★ PHASE C1: `inputs_from`
 *      bindings are resolved against the upstream nodes' normalized completion
 *      envelopes and appended to the IMMUTABLE base message as untrusted-evidence
 *      envelopes; the active `dependsOn` projection is written from `requires`
 *      edges minus skip-omitted ones. A node with no bindings still materializes
 *      by identity, exactly as in phase B.
 *   7. Clear ONLY graph-owned blocks (`graph_materialization_pending:<nodeId>:
 *      <version>`) whose recorded generation matches the version just advanced.
 *      Non-graph blocks (e.g. `dependency_failed:*`) are never touched.
 *   8. Insert graph ledger/outbox events + a queue wake request into
 *      mesh_graph_outbox (SAME transaction — design :185-190).
 *   9. Commit, then drain the outbox (queue wake rides the ordinary
 *      triggerMeshQueue via the registered wake handler).
 *
 * NEVER inside the transaction (design :329-330): provider reads, git, network,
 * Refinery calls, coordinator notification. Materialization is deterministic,
 * bounded CPU/string work only.
 *
 * Replay idempotency (design :332-334): a replayed terminal event for an
 * already-terminal row exits at the fence with `duplicate: true` — no new
 * output version, no duplicate node transition, no duplicate outbox events.
 * Materialization is a compare-and-set on (graph_node_id,
 * materialization_version, queue_status='pending'): the queue row is only
 * mutated while still 'pending' (an assigned task is immutable), and the node
 * row only advances from the exact expected version.
 *
 * ★ NON-GOALS (still): operator cancel / dependency-failure cascade / requeue-cap
 * auto-fail remain legacy writers (they carry no completion envelope and already
 * settle their own attempts); coordinator GATE release is phase C2 and DERIVED
 * FAILURE policy (failed/cancelled rollups, cancel_downstream) is phase C3.
 * `run_if` skip propagation IS implemented here (C1) because it is the other half
 * of condition evaluation — a condition that can only ever block is not a
 * condition. Failure-driven skip is a different axis and stays C3.
 */

import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { proposeTurnCompletion, type CompletionProposalSource, type TurnTerminalOutcome } from './mesh-turn-ledger.js';
import { endTaskDispatchInFlight } from './mesh-task-inflight.js';
import { LOG } from '../logging/logger.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import {
    newMeshGraphOutboxId,
    type MeshGraphNodeState,
    type MeshTaskGraphEdgeRow,
    type MeshTaskGraphNodeRow,
} from './mesh-graph-types.js';
import {
    assertDeliveryIntegrity,
    canonicalJson,
    evaluateRunIfCondition,
    MeshMaterializationError,
    parseInputBindings,
    parseRunIfCondition,
    renderMaterializedMessage,
    resolveInputBindings,
    sha256Hex,
    type MeshBoundValueReceipt,
    type MeshUpstreamOutput,
} from './mesh-graph-input-binding.js';

// ── Public contract ──────────────────────────────────────────────────────────

/** Terminal statuses the runner accepts. Operator cancels keep their own legacy path (see NON-GOALS). */
export type MeshTerminalCommitStatus = 'completed' | 'failed' | 'cancelled';

/** Normalized completion envelope input (design :149-163). Optional for non-completion terminals. */
export interface MeshTerminalCompletionEnvelope {
    workerResult?: unknown;
    finalSummary?: string;
    artifacts?: unknown;
    evidence?: unknown;
    nodeId?: string;
    providerType?: string;
    completedAt?: string;
}

export interface MeshTerminalCommitInput {
    meshId: string;
    taskId: string;
    status: MeshTerminalCommitStatus;
    sessionId?: string;
    attemptId?: string;
    occurredAtMs?: number;
    /** Attempt-fence provenance — same vocabulary as the turn reducer's CompletionProposalSource. */
    source: CompletionProposalSource;
    reason?: string;
    envelope?: MeshTerminalCompletionEnvelope;
}

export interface MeshTerminalCommitResult {
    /** The queue row after the transition (null when the task id is unknown). */
    entry: MeshWorkQueueEntry | null;
    /** False only when the task id is unknown — the fence never refuses a first terminal. */
    committed: boolean;
    /** True when the row was ALREADY terminal with the same status — a replayed event. */
    duplicate: boolean;
    /** Downstream graph nodes materialized by this transition (empty for unlinked tasks). */
    materializedNodeIds: string[];
}

// ── Graph-owned queue blocks (step 7) ─────────────────────────────────────────

const GRAPH_BLOCK_PREFIX = 'graph_materialization_pending:';

/** The ONLY blockedReason shape the graph engine may set or clear. */
export function graphMaterializationBlockReason(nodeId: string, materializationVersion: number): string {
    return `${GRAPH_BLOCK_PREFIX}${nodeId}:${materializationVersion}`;
}

function parseGraphMaterializationBlock(reason: string | undefined): { nodeId: string; version: number } | null {
    if (!reason || !reason.startsWith(GRAPH_BLOCK_PREFIX)) return null;
    const rest = reason.slice(GRAPH_BLOCK_PREFIX.length);
    const sep = rest.lastIndexOf(':');
    if (sep <= 0) return null;
    const version = Number(rest.slice(sep + 1));
    if (!Number.isInteger(version) || version < 0) return null;
    return { nodeId: rest.slice(0, sep), version };
}

// ── Queue wake outbox drain (steps 8-9) ───────────────────────────────────────

/**
 * The post-commit wake rides the ORDINARY queue trigger — the graph engine never
 * dispatches directly (design :92-96). Registered by setupMeshEventForwarding,
 * which owns DaemonComponents; the runner deliberately never imports dispatch code.
 */
let queueWakeHandler: ((meshId: string) => void) | undefined;

export function registerMeshGraphQueueWakeHandler(handler: (meshId: string) => void): void {
    queueWakeHandler = handler;
}

export function __resetMeshGraphTransitionRunnerForTests(): void {
    queueWakeHandler = undefined;
}

/**
 * Step 9 — drain pending graph outbox rows AFTER the state-change transaction
 * committed. `queue_wake` events invoke the registered wake handler; every other
 * kind is a durable notification record whose consumers arrive with later phases
 * (gates C2, views E) — draining marks it delivered so it is never double-fired.
 * Best-effort per row: a failing wake leaves the row pending with a retry stamp.
 */
export function drainMeshGraphOutbox(meshId: string): number {
    const store = MeshRuntimeStore.getInstance();
    const graphStore = store.graphStore();
    const pending = graphStore.listPendingOutboxEvents(meshId);
    let drained = 0;
    for (const event of pending) {
        const nowIso = new Date().toISOString();
        try {
            if (event.kind === 'queue_wake') {
                if (queueWakeHandler) queueWakeHandler(event.meshId);
                // No handler registered (e.g. a daemon without event forwarding): the
                // reconcile loop's periodic triggerMeshQueue covers the wake — the row
                // is still marked delivered so it cannot accumulate forever.
            }
            graphStore.markOutboxEventStatus(event.id, 'delivered', nowIso);
            drained += 1;
        } catch (e: any) {
            try {
                graphStore.markOutboxEventStatus(event.id, 'pending', nowIso, {
                    incrementAttempt: true,
                    nextAttemptAtMs: Date.now() + 5_000,
                });
            } catch { /* bookkeeping must never throw past the drain */ }
            LOG.warn('MeshGraph', `Graph outbox drain failed for ${event.kind} ${event.id} (mesh ${meshId}): ${e?.message || e}`);
        }
    }
    return drained;
}

// ── The choke point ───────────────────────────────────────────────────────────

/**
 * THE single terminal-acceptance entry point (design :313). See the module
 * header for the 9-step contract and the phase-B boundaries. Synchronous: the
 * whole state change is one better-sqlite3 immediate transaction (a nested call
 * under a caller's queue lock degrades to a savepoint).
 */
export function commitTaskTerminalAndAdvanceGraph(
    terminal: MeshTerminalCommitInput,
): MeshTerminalCommitResult {
    const store = MeshRuntimeStore.getInstance();
    const nowIso = new Date(terminal.occurredAtMs ?? Date.now()).toISOString();
    const result = store.transaction(() => {
        const entry = store.findQueueEntryById(terminal.meshId, terminal.taskId);
        if (!entry) return { entry: null, committed: false, duplicate: false, materializedNodeIds: [] as string[] };
        const priorTerminal = entry.status === 'completed' || entry.status === 'failed' || entry.status === 'cancelled';

        // REPLAY FENCE (design :332-334): a replayed terminal event carries the same
        // outcome for an already-terminal row — accept it as a duplicate and perform
        // NO further transition (no new output version, no node advance, no outbox).
        if (priorTerminal && entry.status === terminal.status) {
            return { entry, committed: true, duplicate: true, materializedNodeIds: [] as string[] };
        }

        // Step 1 — fence and accept the terminal ATTEMPT. This is the one settle call
        // that d18e9838 placed in updateTaskStatus; it moved here so the attempt and
        // the row can never diverge regardless of which completion path fires first.
        // Skipped for terminal→terminal corrections (the attempt already committed an
        // outcome; a conflicting proposal would be rejected without mutating anyway).
        // Idempotent by construction: an identical repeat returns committed+duplicate,
        // a conflicting one is rejected WITHOUT mutating — and never fails the flip.
        if (!priorTerminal) {
            try {
                proposeTurnCompletion({
                    meshId: terminal.meshId,
                    taskId: terminal.taskId,
                    attemptId: terminal.attemptId,
                    sessionId: terminal.sessionId,
                    outcome: terminal.status as TurnTerminalOutcome,
                    source: terminal.source,
                    occurredAtMs: terminal.occurredAtMs,
                    reason: terminal.reason ?? `task_status_terminal:${terminal.status}`,
                });
            } catch { /* reducer unavailable — the row write below still stands (pre-Stage-5 shadow mode) */ }
        }

        // Step 2 — persist the normalized output version (append-only; a later
        // evidence arrival is a NEW version, never a mutation — design :165-167).
        const graphStore = store.graphStore();
        const node = graphStore.findNodeByQueueTaskId(terminal.meshId, terminal.taskId);
        persistOutputVersion(store, terminal, node, nowIso);

        // Step 3 — flip the upstream queue row to terminal.
        entry.status = terminal.status;
        store.updateQueueEntry(entry);
        endTaskDispatchInFlight(terminal.meshId, terminal.taskId);

        // Steps 4-8 — graph advancement. A task with no backing graph node is the
        // legacy path: steps 1-3 + the drain still ran, everything else is a no-op.
        const materializedNodeIds = node
            ? advanceGraphForTerminalNode(store, node, terminal, nowIso)
            : [] as string[];
        return { entry, committed: true, duplicate: false, materializedNodeIds };
    });
    // Step 9 — AFTER commit: drain the outbox (queue wake + delivery marks). No
    // provider/git/network work happened inside the transaction; the wake handler
    // only SCHEDULES the ordinary queue trigger (setImmediate) outside the lock.
    try {
        drainMeshGraphOutbox(terminal.meshId);
    } catch { /* drain is best-effort — the committed state stands; the reconcile tick re-drains */ }
    return result;
}

/** Step 2 helper: insert the next immutable output version for this task. */
function persistOutputVersion(
    store: MeshRuntimeStore,
    terminal: MeshTerminalCommitInput,
    node: MeshTaskGraphNodeRow | null,
    nowIso: string,
): void {
    const graphStore = store.graphStore();
    const latest = graphStore.getLatestOutput(terminal.taskId);
    const version = (latest?.version ?? 0) + 1;
    let attemptSeq = 1;
    try {
        attemptSeq = store.getCurrentTurnAttempt(terminal.meshId, terminal.taskId)?.attemptSeq ?? 1;
    } catch { /* legacy task without an attempt row — version still persists */ }
    const envelopeJson = canonicalJson({
        task_id: terminal.taskId,
        attempt: attemptSeq,
        status: terminal.status,
        worker_result: terminal.envelope?.workerResult,
        final_summary: terminal.envelope?.finalSummary,
        artifacts: terminal.envelope?.artifacts,
        evidence: terminal.envelope?.evidence,
        completed_at: terminal.envelope?.completedAt ?? nowIso,
        source: {
            node_id: terminal.envelope?.nodeId,
            session_id: terminal.sessionId,
            provider_type: terminal.envelope?.providerType,
        },
    });
    graphStore.insertOutput({
        taskId: terminal.taskId,
        version,
        meshId: terminal.meshId,
        graphId: node?.graphId,
        nodeId: node?.nodeId,
        attempt: attemptSeq,
        status: terminal.status,
        envelopeJson,
        digest: sha256Hex(envelopeJson),
        createdAt: nowIso,
    });
}

/**
 * Steps 4-8 — deterministic graph advancement after the upstream node's terminal
 * was accepted. All work is bounded CPU/string over the graph's own rows.
 */
function advanceGraphForTerminalNode(
    store: MeshRuntimeStore,
    node: MeshTaskGraphNodeRow,
    terminal: MeshTerminalCommitInput,
    nowIso: string,
): string[] {
    const graphStore = store.graphStore();
    const outbox: Array<{ kind: string; payload: Record<string, unknown> }> = [];

    // Step 4a — the upstream node itself goes terminal.
    const nodeTerminal: MeshGraphNodeState = terminal.status;
    graphStore.updateNodeState(node.graphId, node.nodeId, nodeTerminal, nowIso,
        terminal.status === 'completed' ? undefined : { failureReason: terminal.reason ?? `task_${terminal.status}` });
    outbox.push({
        kind: 'graph_node_terminal',
        payload: { graphId: node.graphId, nodeId: node.nodeId, ref: node.ref, outcome: terminal.status, taskId: terminal.taskId },
    });

    // Step 4b — graph rollup: every node terminal-equivalent → the graph completes.
    // (Derived FAILURE policy — failed/cancelled rollups — is phase C3; only the
    // all-succeeded graph auto-completes, where `skipped` counts as succeeded per
    // design :357-359. `nodes` is listed AFTER the step-4a update, so the
    // just-transitioned node carries its fresh state here.)
    const nodes = graphStore.listNodes(node.graphId);
    const byId = new Map(nodes.map(n => [n.nodeId, n] as const));
    let graphRolledUp = false;
    if (nodes.every(isTerminalEquivalent)) {
        graphStore.updateGraphStatus(node.graphId, 'completed', nowIso, true);
        outbox.push({ kind: 'graph_completed', payload: { graphId: node.graphId } });
        graphRolledUp = true;
    }

    // Steps 5-7 only advance on SUCCESS. FAILURE propagation (cancel_downstream,
    // derived blocks) is phase C3 — the queue-level cascade that already exists in
    // mesh-work-queue remains the failure mechanism. SKIP propagation, by contrast,
    // is C1: it is the other half of `run_if` (design :356-369).
    const materialized: string[] = [];
    if (terminal.status === 'completed') {
        const edges = graphStore.listEdges(node.graphId);
        // A skip cascades: skipping node X may make X's own descendants eligible to
        // skip (default `skip`) or newly materializable (`omit_dependency`). Re-drive
        // the frontier until it settles. `byId` is a live map the passes mutate, so
        // each pass sees the previous pass's states. The graph is a DAG and every
        // pass moves at least one node to a state it can never leave here, so the
        // loop is bounded by the node count — plus a hard cap for a corrupt cycle.
        let frontier = new Set([node.nodeId]);
        for (let pass = 0; pass < nodes.length + 1 && frontier.size > 0; pass += 1) {
            const nextFrontier = new Set<string>();
            const downstreamIds = new Set(
                edges.filter(e => frontier.has(e.fromNodeId)).map(e => e.toNodeId),
            );
            for (const targetId of downstreamIds) {
                const target = byId.get(targetId);
                if (!target || target.kind !== 'worker_task' || !target.queueTaskId) continue;
                if (target.state !== 'declared' && target.state !== 'blocked') continue;
                const outcome = settleDownstreamNode(store, target, edges, byId, nowIso);
                if (outcome.kind === 'materialized') {
                    materialized.push(target.nodeId);
                    outbox.push({
                        kind: 'graph_node_materialized',
                        payload: {
                            graphId: target.graphId, nodeId: target.nodeId, ref: target.ref,
                            taskId: target.queueTaskId, materializationVersion: target.materializationVersion + 1,
                            digest: outcome.digest, receipts: outcome.receipts,
                        },
                    });
                } else if (outcome.kind === 'skipped') {
                    nextFrontier.add(target.nodeId);
                    outbox.push({
                        kind: 'graph_node_skipped',
                        payload: {
                            graphId: target.graphId, nodeId: target.nodeId, ref: target.ref,
                            taskId: target.queueTaskId, reason: outcome.reason,
                        },
                    });
                } else if (outcome.kind === 'error') {
                    outbox.push({
                        kind: 'graph_node_materialization_failed',
                        payload: {
                            graphId: target.graphId, nodeId: target.nodeId, ref: target.ref,
                            taskId: target.queueTaskId, blockedReason: outcome.blockedReason,
                        },
                    });
                }
            }
            frontier = nextFrontier;
        }
        // A skip can complete the graph (every remaining node terminal-equivalent).
        // Re-check the rollup with the post-skip states.
        if (!graphRolledUp && graphStore.listNodes(node.graphId).every(isTerminalEquivalent)) {
            graphStore.updateGraphStatus(node.graphId, 'completed', nowIso, true);
            outbox.push({ kind: 'graph_completed', payload: { graphId: node.graphId } });
        }
    }

    // Step 8 — outbox rows join THIS transaction (design :185-190). One queue_wake
    // per commit when anything materialized — never per node.
    if (materialized.length > 0) {
        outbox.push({ kind: 'queue_wake', payload: { meshId: node.meshId, reason: 'graph_materialization', graphId: node.graphId } });
    }
    for (const event of outbox) {
        graphStore.insertOutboxEvent({
            id: newMeshGraphOutboxId(),
            meshId: node.meshId,
            graphId: node.graphId,
            kind: event.kind,
            payload: JSON.stringify(event.payload),
            status: 'pending',
            attemptCount: 0,
            createdAt: nowIso,
            updatedAt: nowIso,
        });
    }
    return materialized;
}

/** Graph-level terminal equivalence for the rollup (design :357-359). */
function isTerminalEquivalent(n: MeshTaskGraphNodeRow): boolean {
    return n.state === 'completed' || n.state === 'released' || n.state === 'skipped';
}

type SettleOutcome =
    | { kind: 'deferred' }
    | { kind: 'materialized'; digest: string; receipts: MeshBoundValueReceipt[] }
    | { kind: 'skipped'; reason: string }
    | { kind: 'error'; blockedReason: string };

/**
 * Steps 5-7 for one downstream worker node ★ PHASE C1: run_if evaluation + skip
 * resolution, `inputs_from` binding, generation-checked block clearing.
 *
 * Never throws — a materialization failure becomes a `materialization_error:*`
 * block on the still-pending queue row (design :278-283), which the UNCHANGED
 * `taskDependenciesSatisfied` predicate already honours (any blockedReason ⇒ not
 * claimable). The scheduler learns nothing new about graphs.
 */
function settleDownstreamNode(
    store: MeshRuntimeStore,
    target: MeshTaskGraphNodeRow,
    edges: MeshTaskGraphEdgeRow[],
    byId: Map<string, MeshTaskGraphNodeRow>,
    nowIso: string,
): SettleOutcome {
    const graphStore = store.graphStore();
    const incoming = edges.filter(e => e.toNodeId === target.nodeId && e.kind !== 'gate');

    // ── Step 5a — skip propagation over incoming edges (design :361-366) ──────
    // An edge whose source is `skipped` either propagates the skip (default) or is
    // OMITTED from the downstream queue projection. Only the latter lets the node
    // materialize. `omit_dependency` is the explicit `omit_on_skip` edge flag.
    const skippedSources = incoming.filter(e => byId.get(e.fromNodeId)?.state === 'skipped');
    const propagatingSkip = skippedSources.find(e => !e.omitOnSkip);
    if (propagatingSkip) {
        const sourceRef = byId.get(propagatingSkip.fromNodeId)?.ref ?? propagatingSkip.fromNodeId;
        return markNodeSkipped(store, target, `upstream_skipped:${sourceRef}`, nowIso);
    }
    // Edges surviving the skip resolution — the ACTIVE projection.
    const activeIncoming = incoming.filter(e => byId.get(e.fromNodeId)?.state !== 'skipped');

    // Inputs settled: every surviving source reached `completed`. A source that is
    // still running (or blocked, or failed) leaves the node exactly where it is.
    const settled = activeIncoming.every(e => byId.get(e.fromNodeId)?.state === 'completed');
    if (!settled) return { kind: 'deferred' };

    const queueEntry = store.findQueueEntryById(target.meshId, target.queueTaskId!);
    if (!queueEntry) return { kind: 'deferred' };

    // Upstream envelopes, keyed by the source node's `ref` — the vocabulary both
    // `inputs_from.from` and `run_if.from` use (design :212, :346). Read from the
    // append-only mesh_task_outputs rows persisted at step 2, so a binding always
    // sees the exact version that was accepted, never a live provider read.
    const outputsByRef = collectUpstreamOutputs(store, activeIncoming, byId);

    // ── Step 5b — run_if evaluation ★ C1 (design :336-355) ───────────────────
    // Conditions live on conditional edges (`condition_json`) and/or on the node's
    // own base spec (`run_if`). Both are the same declarative grammar. A malformed
    // condition FAILS CLOSED as a materialization error — it never defaults to true.
    const baseSpec = safeParseJson(target.baseSpecJson);
    let conditionsHold = true;
    let falseCondition: string | undefined;
    try {
        const conditions: unknown[] = [];
        for (const edge of activeIncoming) {
            if (edge.kind === 'conditional' && typeof edge.conditionJson === 'string' && edge.conditionJson.length > 0) {
                const parsed = safeParseJson(edge.conditionJson);
                if (parsed === undefined) {
                    throw new MeshMaterializationError('invalid_condition', `edge condition_json is not valid JSON`, 'edge_json');
                }
                conditions.push(parsed);
            }
        }
        if ((baseSpec as any)?.run_if !== undefined) conditions.push((baseSpec as any).run_if);
        for (const raw of conditions) {
            const condition = parseRunIfCondition(raw);
            if (!evaluateRunIfCondition(condition, ref => outputsByRef.get(ref)?.envelope ?? null)) {
                conditionsHold = false;
                falseCondition = describeConditionSource(raw);
                break;
            }
        }
    } catch (e) {
        return blockWithMaterializationError(store, graphStore, target, queueEntry, e, nowIso);
    }

    if (!conditionsHold) {
        // design :353-359 — `on_false: skip` is the only supported (and default)
        // behaviour: the node and its queue placeholder go `skipped`, which is
        // terminal for graph/mission accounting and deliberately NOT `completed`,
        // so `taskDependenciesSatisfied` never sees it as satisfying a dependency.
        const onFalse = (baseSpec as any)?.on_false;
        if (onFalse !== undefined && onFalse !== 'skip') {
            return blockWithMaterializationError(
                store, graphStore, target, queueEntry,
                new MeshMaterializationError('invalid_condition', `unsupported on_false '${String(onFalse)}' — only 'skip' is defined`, 'on_false'),
                nowIso,
            );
        }
        return markNodeSkipped(store, target, `run_if_false:${falseCondition ?? 'condition'}`, nowIso);
    }

    // ── Step 6 — materialization ★ C1 ────────────────────────────────────────
    // CAS key (design :332-334): the node row advances ONLY from the expected
    // materialization_version, and the queue row is mutated ONLY while still
    // 'pending' (an assigned task is immutable — the single immediate transaction
    // serializes the check and the write).
    if (queueEntry.status !== 'pending') return { kind: 'deferred' };

    // The base instruction is IMMUTABLE and comes first (design :299). Bindings are
    // APPENDED to it — never interpolated into it (design :250-251).
    const baseMessage = typeof (baseSpec as any)?.message === 'string' && (baseSpec as any).message.trim()
        ? (baseSpec as any).message as string
        : queueEntry.message;
    // The queue projection: active `requires` edges only. A conditional edge is a
    // control-flow edge, not an execution prerequisite — its source is already
    // known-completed here, and projecting it would be redundant.
    const dependsOn = activeIncoming
        .filter(e => e.kind === 'requires')
        .map(e => byId.get(e.fromNodeId)?.queueTaskId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

    let rendered;
    try {
        const bindings = parseInputBindings(baseSpec);
        const resolved = resolveInputBindings(bindings, outputsByRef);
        rendered = renderMaterializedMessage(baseMessage, resolved, {
            graphId: target.graphId,
            nodeId: target.nodeId,
            materializationVersion: target.materializationVersion + 1,
        });
        // design :306-309 — the binding-aware final-delivery guard. Encoding, size,
        // and envelope integrity apply to the WHOLE delivery; instruction/permission
        // classification stays on the base message (already validated at admission),
        // so bound evidence can never rewrite the stored readonly/taskMode contract.
        assertDeliveryIntegrity(rendered);
    } catch (e) {
        return blockWithMaterializationError(store, graphStore, target, queueEntry, e, nowIso);
    }

    const digest = sha256Hex(canonicalJson({
        nodeId: target.nodeId,
        materializationVersion: target.materializationVersion + 1,
        message: rendered.message,
        renderDigest: rendered.digest,
        dependsOn,
        targetNodeId: queueEntry.targetNodeId,
    }));
    const won = graphStore.advanceNodeMaterializationCAS(
        target.graphId,
        target.nodeId,
        target.materializationVersion,
        { state: 'materialized', materializedDigest: digest },
        nowIso,
    );
    if (!won) return { kind: 'deferred' }; // replay/race: same digest already committed

    // Step 7 — clear ONLY the graph-owned block whose generation matches the version
    // just advanced. Any other blockedReason (dependency_failed, a stale generation,
    // another subsystem's) is left untouched (design :998).
    queueEntry.message = rendered.message;
    queueEntry.dependsOn = dependsOn;
    clearMatchingGraphBlock(queueEntry, target);
    store.updateQueueEntry(queueEntry);
    syncNodeRowState(byId, target, 'materialized', { materializationVersion: target.materializationVersion + 1, materializedDigest: digest });
    return { kind: 'materialized', digest, receipts: rendered.receipts };
}

/**
 * Read every active upstream source's latest completion envelope, keyed by `ref`.
 * A source with no persisted output maps to an entry with a null envelope, so a
 * `required` binding against it fails with `required_input_missing` rather than
 * silently binding nothing.
 */
function collectUpstreamOutputs(
    store: MeshRuntimeStore,
    activeIncoming: MeshTaskGraphEdgeRow[],
    byId: ReadonlyMap<string, MeshTaskGraphNodeRow>,
): Map<string, MeshUpstreamOutput> {
    const graphStore = store.graphStore();
    const outputs = new Map<string, MeshUpstreamOutput>();
    for (const edge of activeIncoming) {
        const source = byId.get(edge.fromNodeId);
        if (!source?.queueTaskId) continue;
        const ref = source.ref ?? source.nodeId;
        if (outputs.has(ref)) continue;
        const row = graphStore.getLatestOutput(source.queueTaskId);
        outputs.set(ref, {
            ref,
            taskId: source.queueTaskId,
            version: row?.version,
            envelope: row ? safeParseJson(row.envelopeJson) ?? null : null,
        });
    }
    return outputs;
}

/** A skipped node: terminal for graph/mission accounting, never `completed` (design :356-359). */
function markNodeSkipped(
    store: MeshRuntimeStore,
    target: MeshTaskGraphNodeRow,
    reason: string,
    nowIso: string,
): SettleOutcome {
    const graphStore = store.graphStore();
    graphStore.updateNodeState(target.graphId, target.nodeId, 'skipped', nowIso, { skipReason: reason });
    target.state = 'skipped';
    target.skipReason = reason;
    // The queue placeholder goes `cancelled` — the queue has no `skipped` status, and
    // `cancelled` is the one terminal status that is NOT `completed`, so the unchanged
    // dependency predicate can never mistake a skipped placeholder for satisfied work.
    const queueEntry = store.findQueueEntryById(target.meshId, target.queueTaskId!);
    if (queueEntry && queueEntry.status === 'pending') {
        queueEntry.status = 'cancelled';
        queueEntry.blockedReason = `graph_skipped:${reason}`;
        store.updateQueueEntry(queueEntry);
    }
    return { kind: 'skipped', reason };
}

/**
 * A materialization failure blocks the still-pending node with a
 * `materialization_error:*` reason (design :278-283). The coordinator may then patch
 * the node's selector/size policy (bumping the generation) and retry.
 */
function blockWithMaterializationError(
    store: MeshRuntimeStore,
    graphStore: ReturnType<MeshRuntimeStore['graphStore']>,
    target: MeshTaskGraphNodeRow,
    queueEntry: MeshWorkQueueEntry,
    error: unknown,
    nowIso: string,
): SettleOutcome {
    const blockedReason = error instanceof MeshMaterializationError
        ? error.blockedReason
        : 'materialization_error:invalid_binding_spec';
    if (target.state !== 'blocked') {
        graphStore.updateNodeState(target.graphId, target.nodeId, 'blocked', nowIso, {
            failureReason: error instanceof Error ? error.message : String(error),
        });
        target.state = 'blocked';
    }
    if (queueEntry.status === 'pending') {
        // Never overwrite another subsystem's block (design :998) — only an absent
        // block, a graph materialization block, or a prior materialization error.
        const owned = !queueEntry.blockedReason
            || parseGraphMaterializationBlock(queueEntry.blockedReason) !== null
            || queueEntry.blockedReason.startsWith('materialization_error:');
        if (owned && queueEntry.blockedReason !== blockedReason) {
            queueEntry.blockedReason = blockedReason;
            store.updateQueueEntry(queueEntry);
        }
    }
    LOG.warn('MeshGraph', `Materialization blocked for node ${target.nodeId}: ${blockedReason}`);
    return { kind: 'error', blockedReason };
}

/** Step 7's generation check, isolated so both call sites share one rule. */
function clearMatchingGraphBlock(queueEntry: MeshWorkQueueEntry, target: MeshTaskGraphNodeRow): void {
    const block = parseGraphMaterializationBlock(queueEntry.blockedReason);
    if (block && block.nodeId === target.nodeId && block.version === target.materializationVersion) {
        delete queueEntry.blockedReason;
        return;
    }
    // A prior materialization ERROR on this same node is also graph-owned: once the
    // render succeeds it must not keep the task blocked forever.
    if (queueEntry.blockedReason?.startsWith('materialization_error:')) {
        delete queueEntry.blockedReason;
    }
}

/** Keep the in-memory node map consistent with the row just written, for later passes. */
function syncNodeRowState(
    byId: Map<string, MeshTaskGraphNodeRow>,
    target: MeshTaskGraphNodeRow,
    state: MeshGraphNodeState,
    patch: { materializationVersion: number; materializedDigest: string },
): void {
    target.state = state;
    target.materializationVersion = patch.materializationVersion;
    target.materializedDigest = patch.materializedDigest;
    byId.set(target.nodeId, target);
}

/** A stable, non-secret label naming which condition evaluated false (no bound values). */
function describeConditionSource(raw: unknown): string {
    const node = raw as Record<string, unknown> | undefined;
    if (node && typeof node.from === 'string' && typeof node.select === 'string') {
        return `${node.from}${node.select}`;
    }
    if (node && node.all !== undefined) return 'all';
    if (node && node.any !== undefined) return 'any';
    if (node && node.not !== undefined) return 'not';
    return 'condition';
}

function safeParseJson(text: string): unknown {
    try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * Pre-assignment node patch guard (design :285, :332-334): a coordinator may patch a
 * STILL-PENDING node's spec (selector/size policy), but an assigned task is
 * immutable — a patch attempt after assignment fails with `task_already_claimed`.
 * The patch bumps materialization_version so digests computed from the pre-patch
 * spec can never win a later CAS.
 */
export function patchPendingGraphNodeBaseSpec(graphId: string, nodeId: string, baseSpecJson: string): MeshTaskGraphNodeRow {
    const store = MeshRuntimeStore.getInstance();
    return store.transaction(() => {
        const graphStore = store.graphStore();
        const node = graphStore.getNode(graphId, nodeId);
        if (!node) {
            throw new Error(`graph_node_not_found: no node '${nodeId}' in graph '${graphId}'`);
        }
        if (node.queueTaskId) {
            const entry = store.findQueueEntryById(node.meshId, node.queueTaskId);
            if (entry && entry.status !== 'pending') {
                throw new Error(
                    `task_already_claimed: graph node '${nodeId}' backs queue task '${node.queueTaskId}' `
                    + `which is '${entry.status}' — an assigned/completed task is immutable (design :334)`,
                );
            }
        }
        graphStore.updateNodeBaseSpec(graphId, nodeId, baseSpecJson, new Date().toISOString());
        return graphStore.getNode(graphId, nodeId)!;
    });
}
