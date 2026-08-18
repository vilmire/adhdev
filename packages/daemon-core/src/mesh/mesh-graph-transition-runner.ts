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
 *   5. Eligibility check for nodes whose graph inputs are now settled.
 *      ★ B BOUNDARY: `run_if`/conditional-edge evaluation is NOT implemented —
 *      a node with ANY conditional edge carrying condition_json stays deferred
 *      (fails closed) until phase C1 evaluates it.
 *   6. Materialize eligible downstream worker nodes. ★ B BOUNDARY: this is
 *      IDENTITY materialization — the immutable base message becomes the final
 *      message and the active `dependsOn` projection is written from `requires`
 *      edges. `inputs_from` binding semantics (selector language, envelope
 *      rendering, size policy) are phase C1; a node whose base spec carries
 *      bindings stays blocked instead of being guessed at.
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
 * ★ NON-GOALS for B: operator cancel / dependency-failure cascade / requeue-cap
 * auto-fail remain legacy writers (they carry no completion envelope and already
 * settle their own attempts); gate release, skip propagation, and derived
 * failure policy are phases C2/C3.
 */

import { createHash } from 'crypto';
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

// ── Deterministic envelope/digest helpers (bounded CPU/string work only) ─────

/** Canonical JSON: recursively sorted object keys so the same content yields the same digest. */
function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function sha256Hex(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
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
    // (Derived FAILURE policy — failed/cancelled rollups — is phase C3; B only
    // auto-completes the all-succeeded graph. `nodes` is listed AFTER the step-4a
    // update, so the just-transitioned node carries its fresh state here.)
    const nodes = graphStore.listNodes(node.graphId);
    const byId = new Map(nodes.map(n => [n.nodeId, n] as const));
    const isTerminalEquivalent = (n: MeshTaskGraphNodeRow): boolean =>
        n.state === 'completed' || n.state === 'released' || n.state === 'skipped';
    if (nodes.every(isTerminalEquivalent)) {
        graphStore.updateGraphStatus(node.graphId, 'completed', nowIso, true);
        outbox.push({ kind: 'graph_completed', payload: { graphId: node.graphId } });
    }

    // Steps 5-7 only advance on SUCCESS. Failure/skip propagation (cancel_downstream,
    // omit_on_skip, derived blocks) is phase C3 — the queue-level cascade that already
    // exists in mesh-work-queue remains the failure mechanism in B.
    const materialized: string[] = [];
    if (terminal.status === 'completed') {
        const edges = graphStore.listEdges(node.graphId);
        const downstreamIds = new Set(
            edges.filter(e => e.fromNodeId === node.nodeId).map(e => e.toNodeId),
        );
        for (const targetId of downstreamIds) {
            const target = byId.get(targetId);
            if (!target || target.kind !== 'worker_task' || !target.queueTaskId) continue;
            if (target.state !== 'declared' && target.state !== 'blocked') continue;
            const outcome = tryMaterializeDownstreamNode(store, target, edges, byId, nowIso);
            if (outcome.materialized) {
                materialized.push(target.nodeId);
                outbox.push({
                    kind: 'graph_node_materialized',
                    payload: {
                        graphId: target.graphId, nodeId: target.nodeId, ref: target.ref,
                        taskId: target.queueTaskId, materializationVersion: target.materializationVersion + 1,
                        digest: outcome.digest,
                    },
                });
            }
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

/**
 * Steps 5-7 for one downstream worker node: eligibility, identity materialization,
 * generation-checked block clearing. Never throws — an ineligible node simply
 * stays where it is (fail-closed).
 */
function tryMaterializeDownstreamNode(
    store: MeshRuntimeStore,
    target: MeshTaskGraphNodeRow,
    edges: MeshTaskGraphEdgeRow[],
    byId: ReadonlyMap<string, MeshTaskGraphNodeRow>,
    nowIso: string,
): { materialized: boolean; digest?: string } {
    const graphStore = store.graphStore();
    const requiresIn = edges.filter(e => e.toNodeId === target.nodeId && e.kind === 'requires');
    const conditionalIn = edges.filter(e => e.toNodeId === target.nodeId && e.kind === 'conditional');

    // Inputs settled: every `requires` source reached `completed`.
    const settled = requiresIn.every(e => byId.get(e.fromNodeId)?.state === 'completed');
    if (!settled) return { materialized: false };

    const queueEntry = store.findQueueEntryById(target.meshId, target.queueTaskId!);
    if (!queueEntry) return { materialized: false };

    // Step 5 — ★ B BOUNDARY: run_if/condition evaluation is phase C1. A node with an
    // unevaluated conditional input, or a base spec carrying inputs_from bindings
    // (C1 materialization semantics), is DEFERRED: marked blocked with a graph-owned,
    // generation-stamped block instead of being guessed at.
    const baseSpec = safeParseJson(target.baseSpecJson);
    const hasBindings = Array.isArray((baseSpec as any)?.inputs_from) && (baseSpec as any).inputs_from.length > 0;
    const hasUnevaluatedCondition = conditionalIn.some(e => typeof e.conditionJson === 'string' && e.conditionJson.length > 0);
    if (hasUnevaluatedCondition || hasBindings) {
        if (target.state !== 'blocked') {
            graphStore.updateNodeState(target.graphId, target.nodeId, 'blocked', nowIso);
        }
        const reason = graphMaterializationBlockReason(target.nodeId, target.materializationVersion);
        if (queueEntry.status === 'pending' && queueEntry.blockedReason !== reason) {
            // Never overwrite a non-graph block — the graph only owns its own shape.
            const existing = parseGraphMaterializationBlock(queueEntry.blockedReason);
            if (!queueEntry.blockedReason || existing) {
                queueEntry.blockedReason = reason;
                store.updateQueueEntry(queueEntry);
            }
        }
        return { materialized: false };
    }

    // Step 6 — identity materialization. CAS key (design :332-334): the node row
    // advances ONLY from the expected materialization_version, and the queue row is
    // mutated ONLY while still 'pending' (an assigned task is immutable — the
    // single immediate transaction serializes the check and the write).
    if (queueEntry.status !== 'pending') return { materialized: false };
    const baseMessage = typeof (baseSpec as any)?.message === 'string' && (baseSpec as any).message.trim()
        ? (baseSpec as any).message as string
        : queueEntry.message;
    const dependsOn = requiresIn
        .map(e => byId.get(e.fromNodeId)?.queueTaskId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const digest = sha256Hex(canonicalJson({
        nodeId: target.nodeId,
        materializationVersion: target.materializationVersion + 1,
        message: baseMessage,
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
    if (!won) return { materialized: false }; // replay/race: same digest already committed

    // Step 7 — clear ONLY the graph-owned block whose generation matches the version
    // just advanced. Any other blockedReason (dependency_failed, a stale generation)
    // is left untouched.
    queueEntry.message = baseMessage;
    queueEntry.dependsOn = dependsOn;
    const block = parseGraphMaterializationBlock(queueEntry.blockedReason);
    if (block && block.nodeId === target.nodeId && block.version === target.materializationVersion) {
        delete queueEntry.blockedReason;
    }
    store.updateQueueEntry(queueEntry);
    return { materialized: true, digest };
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
