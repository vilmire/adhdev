/**
 * GRAPH-ORCHESTRATION Phase E — ledger provenance for graph enqueues and gates
 * (design :695-757).
 *
 * ── The content boundary this module enforces ────────────────────────────────
 * design :737-738: "Message contents and bound output values are excluded; only
 * sizes and digests are emitted." Every builder below is an ALLOW-LIST that names
 * each emitted field explicitly. ★ Do not rewrite one as a spread-then-delete: a
 * deny-list silently leaks every field a caller later adds upstream, which is the
 * same failure mode the server-side status allow-lists exist to prevent
 * (CLAUDE.md, "Server content boundary").
 *
 * A gate's `instructions` are free text authored by a coordinator, so they are
 * NOT emitted here either — the gate id, ref and action identify it, and the full
 * text is available from the graph view on demand.
 *
 * ── Fresh-transaction rollback records (design :752-753) ─────────────────────
 * "A rollback event must be written in a fresh transaction after the failed graph
 * transaction; otherwise the audit record rolls back with the data it is meant to
 * describe." The mesh ledger is a JSONL append outside the SQLite transaction, so
 * calling {@link recordGraphEnqueueRolledBack} from a catch block satisfies this
 * by construction. It must still be called from the CATCH — never from inside the
 * transaction callback.
 *
 * ── Best-effort by design ────────────────────────────────────────────────────
 * Provenance must never fail the operation it describes. Every entry point
 * swallows its own errors: a full disk should not turn a committed graph into a
 * failed tool call.
 */

import { type MeshLedgerKind } from './mesh-ledger.js';
import { meshRecord } from './mesh-record.js';
import { LOG } from '../logging/logger.js';
// C-W9a: the pure decision vocabulary (types, reason lists, normalizer, advisory
// strings) lives in a leaf the mcp-server can import without importing this
// record-writing module; re-exported here for every existing importer.
import type { NormalizedOrchestrationDecision } from './mesh-orchestration-decision.js';
export {
    MESH_VALID_SINGLE_REASONS,
    MESH_DIRECT_REASONS,
    MESH_VALID_DIRECT_REASONS,
    MESH_UNSANCTIONED_DIRECT_REASONS,
    MESH_SUPERSEDED_SINGLE_REASONS,
    normalizeOrchestrationDecision,
    MESH_DECLARED_ELIGIBLE_SINGLE_HINT,
    MESH_UNSANCTIONED_DIRECT_HINT,
} from './mesh-orchestration-decision.js';
export type { NormalizedOrchestrationDecision, OrchestrationDecisionNormalizeResult } from './mesh-orchestration-decision.js';

/** design :735-737 — the enqueue provenance envelope. Identifiers, counts, digests. */
export interface GraphEnqueueProvenance {
    graphId: string;
    batchId: string;
    enqueueSurface: string;
    schemaVersion: number;
    planDigest: string;
    missionId?: string;
    coordinatorSessionId?: string;
    taskCount: number;
    gateCount: number;
    workspaceCount: number;
    dependencyEdgeCount: number;
    onDependencyFailure: string;
    /** design :697-710 — the coordinator's own normalized planning record. */
    orchestrationDecision?: NormalizedOrchestrationDecision;
    replayed?: boolean;
}

function safeAppend(meshId: string, kind: MeshLedgerKind, payload: Record<string, unknown>, taskId?: string): void {
    try {
        meshRecord(meshId, kind, { ...(taskId ? { taskId } : {}), payload }, { local: true });
    } catch (e: any) {
        // Provenance must never fail the operation it describes.
        LOG.warn('MeshGraph', `Ledger provenance append (${kind}) failed: ${e?.message || e}`);
    }
}

/** design :742 — a graph plan committed. Counts and digests only; no messages. */
export function recordGraphEnqueueCommitted(meshId: string, p: GraphEnqueueProvenance): void {
    safeAppend(meshId, 'graph_enqueue_committed', {
        graphId: p.graphId,
        batchId: p.batchId,
        enqueueSurface: p.enqueueSurface,
        schemaVersion: p.schemaVersion,
        planDigest: p.planDigest,
        ...(p.missionId ? { missionId: p.missionId } : {}),
        ...(p.coordinatorSessionId ? { coordinatorSessionId: p.coordinatorSessionId } : {}),
        taskCount: p.taskCount,
        gateCount: p.gateCount,
        workspaceCount: p.workspaceCount,
        dependencyEdgeCount: p.dependencyEdgeCount,
        onDependencyFailure: p.onDependencyFailure,
        ...(p.orchestrationDecision ? { orchestrationDecision: p.orchestrationDecision } : {}),
        ...(p.replayed ? { replayed: true } : {}),
    });
}

/**
 * design :697-731 — the enqueue-decision record for the SINGLE-task surface.
 *
 * ★ WHY THIS EXISTS SEPARATELY FROM {@link recordGraphEnqueueCommitted}: the design
 * says "every enqueue call records" the decision, but a single enqueue commits no
 * graph — there is no graphId, batchId or planDigest to report, and inventing them
 * would pollute every graph metric that joins on those fields. So the single surface
 * gets its own kind and this recorder, and the design's "declared eligible singles"
 * metric is the subset of these rows with `known_graph_steps >= 2`.
 *
 * `decisionMissing` is written when the caller supplied NO record at all: on a
 * warn-only surface an omitted decision must still be countable, otherwise a coordinator
 * that simply never passes the field is indistinguishable from one with no eligible
 * singles. Content boundary as everywhere else in this file: identifiers, counts, enums
 * — never the task message.
 */
export function recordSingleEnqueueDecision(
    meshId: string,
    p: {
        taskId: string;
        missionId?: string;
        coordinatorSessionId?: string;
        decision: NormalizedOrchestrationDecision;
        decisionMissing?: boolean;
        declaredEligibleSingle?: boolean;
        batchCapabilityAvailable?: string;
    },
): void {
    safeAppend(meshId, 'single_enqueue_decision', {
        taskId: p.taskId,
        enqueueSurface: 'single',
        ...(p.missionId ? { missionId: p.missionId } : {}),
        ...(p.coordinatorSessionId ? { coordinatorSessionId: p.coordinatorSessionId } : {}),
        orchestrationDecision: p.decision,
        ...(p.decisionMissing ? { decisionMissing: true } : {}),
        ...(p.declaredEligibleSingle ? { declaredEligibleSingle: true } : {}),
        ...(p.batchCapabilityAvailable ? { batchCapabilityAvailable: p.batchCapabilityAvailable } : {}),
    }, p.taskId);
}

/**
 * GRAPH-MEASUREMENT-DIRECT — the decision record for the DIRECT dispatch surface.
 *
 * ★ WHY THIS EXISTS. `mesh_send_task` carried no decision field at all, and it is the
 * MAJORITY surface: the graph-adoption investigation measured ~67% of dispatches going
 * through it. That made the whole adoption question unanswerable — `decision_missing`
 * counted only the enqueue minority, so "0 graphs" could not be distinguished from
 * "0 graphs were needed", and the investigation deadlocked waiting for data that the
 * system was structurally incapable of producing. Schema without a ledger write would
 * reproduce that deadlock exactly, which is why this recorder is the point of the
 * change and the schema field is merely its input.
 *
 * ★ Called from EVERY direct exit path (`p2p_direct` and `local_direct`), and
 * deliberately NOT from `mesh_send_task`'s untargeted fall-through — that path enqueues
 * a queue task rather than dispatching directly, so recording it here would count a
 * queue entry as a direct dispatch and inflate the very ratio this measures.
 *
 * Best-effort like every recorder in this file: a dispatch must never fail because its
 * provenance could not be written. Same content boundary — identifiers, counts, enums;
 * the task message is never written here, and `taskId` is the join key to the task rows.
 */
export function recordDirectDispatchDecision(
    meshId: string,
    p: {
        taskId: string;
        via: string;
        nodeId?: string;
        sessionId?: string;
        missionId?: string;
        coordinatorSessionId?: string;
        decision: NormalizedOrchestrationDecision;
        decisionMissing?: boolean;
        unsanctionedDirect?: string;
        batchCapabilityAvailable?: string;
    },
): void {
    safeAppend(meshId, 'direct_dispatch_decision', {
        taskId: p.taskId,
        enqueueSurface: 'direct',
        via: p.via,
        ...(p.nodeId ? { nodeId: p.nodeId } : {}),
        ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        ...(p.missionId ? { missionId: p.missionId } : {}),
        ...(p.coordinatorSessionId ? { coordinatorSessionId: p.coordinatorSessionId } : {}),
        orchestrationDecision: p.decision,
        ...(p.decisionMissing ? { decisionMissing: true } : {}),
        ...(p.unsanctionedDirect ? { unsanctionedDirect: p.unsanctionedDirect } : {}),
        ...(p.batchCapabilityAvailable ? { batchCapabilityAvailable: p.batchCapabilityAvailable } : {}),
    }, p.taskId);
}

/** design :741 — the plan was rejected before anything was inserted. */
export function recordGraphEnqueueValidationFailed(
    meshId: string,
    p: { code: string; batchId?: string; taskCount?: number; gateCount?: number; workspaceCount?: number;
         orchestrationDecision?: NormalizedOrchestrationDecision },
): void {
    safeAppend(meshId, 'graph_enqueue_validation_failed', {
        code: p.code,
        ...(p.batchId ? { batchId: p.batchId } : {}),
        ...(p.taskCount !== undefined ? { taskCount: p.taskCount } : {}),
        ...(p.gateCount !== undefined ? { gateCount: p.gateCount } : {}),
        ...(p.workspaceCount !== undefined ? { workspaceCount: p.workspaceCount } : {}),
        ...(p.orchestrationDecision ? { orchestrationDecision: p.orchestrationDecision } : {}),
    });
}

/**
 * design :743, :752-753 — the graph transaction rolled back.
 *
 * ★ Call this from the CATCH block, never inside the transaction callback: an
 * audit row written inside the failing transaction rolls back with the data it
 * exists to describe.
 */
export function recordGraphEnqueueRolledBack(
    meshId: string,
    p: { code: string; batchId?: string; taskCount?: number; error?: string },
): void {
    safeAppend(meshId, 'graph_enqueue_rolled_back', {
        code: p.code,
        ...(p.batchId ? { batchId: p.batchId } : {}),
        ...(p.taskCount !== undefined ? { taskCount: p.taskCount } : {}),
        // The error STRING is a validation message authored by this codebase
        // (never worker output or a task message), so it is safe provenance.
        ...(p.error ? { error: p.error.slice(0, 500) } : {}),
    });
}

/** design :748 — gate claimed. */
export function recordGraphGateClaimed(
    meshId: string,
    p: {
        graphId: string; gateId: string; ref?: string; action: string; generation: number;
        ownerSessionId: string; leaseExpiresAt?: string; ambiguousExternalOutcome?: boolean;
        previousLeaseOwnerSessionId?: string;
    },
): void {
    safeAppend(meshId, 'graph_gate_claimed', {
        graphId: p.graphId,
        gateId: p.gateId,
        ...(p.ref ? { ref: p.ref } : {}),
        action: p.action,
        generation: p.generation,
        ownerSessionId: p.ownerSessionId,
        ...(p.leaseExpiresAt ? { leaseExpiresAt: p.leaseExpiresAt } : {}),
        ...(p.ambiguousExternalOutcome ? { ambiguousExternalOutcome: true } : {}),
        ...(p.previousLeaseOwnerSessionId ? { previousLeaseOwnerSessionId: p.previousLeaseOwnerSessionId } : {}),
    });
}

/**
 * design :748 — gate released. The release OUTCOME (an enum-ish label) and the
 * evidence DIGEST are recorded; the evidence body itself is not — it may carry
 * arbitrary action-specific content.
 */
export function recordGraphGateReleased(
    meshId: string,
    p: {
        graphId: string; gateId: string; ref?: string; action: string; outcome: string;
        generation: number; releaseDigest?: string; materializedNodeIds?: string[]; duplicate?: boolean;
    },
): void {
    safeAppend(meshId, 'graph_gate_released', {
        graphId: p.graphId,
        gateId: p.gateId,
        ...(p.ref ? { ref: p.ref } : {}),
        action: p.action,
        outcome: p.outcome,
        generation: p.generation,
        ...(p.releaseDigest ? { releaseDigest: p.releaseDigest } : {}),
        ...(p.materializedNodeIds?.length ? { materializedNodeIds: p.materializedNodeIds } : {}),
        ...(p.duplicate ? { duplicate: true } : {}),
    });
}

/** design :748 — the deadline sweep expired a gate (never released one). */
export function recordGraphGateExpired(
    meshId: string,
    p: { gateId: string; graphId?: string; policy: string; deadlineAt?: string; cancelledNodeIds?: string[] },
): void {
    safeAppend(meshId, 'graph_gate_expired', {
        gateId: p.gateId,
        ...(p.graphId ? { graphId: p.graphId } : {}),
        policy: p.policy,
        ...(p.deadlineAt ? { deadlineAt: p.deadlineAt } : {}),
        ...(p.cancelledNodeIds?.length ? { cancelledNodeIds: p.cancelledNodeIds } : {}),
    });
}

/**
 * design :399 — a coordinator ABANDONED a gate (the `-> cancelled` edge).
 *
 * ★ Recorded separately from `graph_gate_released` on purpose: an abandon
 * granted no passage and produced no outcome or evidence, so folding it into the
 * release ledger would make "gave up" indistinguishable from "approved" in the
 * audit trail. The operator `reason` is a human-authored justification, so it is
 * truncated like every other free-text provenance field.
 */
export function recordGraphGateAbandoned(
    meshId: string,
    p: {
        graphId: string; gateId: string; ref?: string; action: string; priorState: string;
        reason: string; coordinatorSessionId?: string; force?: boolean;
        cancelledNodeIds?: string[]; graphStatus?: string;
    },
): void {
    safeAppend(meshId, 'graph_gate_abandoned', {
        graphId: p.graphId,
        gateId: p.gateId,
        ...(p.ref ? { ref: p.ref } : {}),
        action: p.action,
        priorState: p.priorState,
        reason: p.reason.slice(0, 500),
        ...(p.coordinatorSessionId ? { coordinatorSessionId: p.coordinatorSessionId } : {}),
        ...(p.force ? { force: true } : {}),
        ...(p.cancelledNodeIds?.length ? { cancelledNodeIds: p.cancelledNodeIds } : {}),
        ...(p.graphStatus ? { graphStatus: p.graphStatus } : {}),
    });
}

/**
 * A coordinator rewrote a still-pending node's spec and re-settled it
 * (`mesh_graph_node_patch`).
 *
 * The node's base spec is otherwise the IMMUTABLE plan, so every mutation of it
 * belongs in the audit trail: this is the one path by which the instruction a
 * worker eventually receives differs from the one the batch was accepted with.
 * Only the patched KEY NAMES are recorded, never the patch values — a selector
 * or condition is plan content, and the ledger is not a place to copy it.
 */
export function recordGraphNodePatched(
    meshId: string,
    p: {
        graphId: string; nodeId: string; ref?: string; queueTaskId?: string;
        patchedKeys: string[]; priorBlockedReason?: string;
        outcome: string; state: string; blockedReason?: string;
        materializationVersion: number; coordinatorSessionId?: string;
    },
): void {
    safeAppend(meshId, 'graph_node_patched', {
        graphId: p.graphId,
        nodeId: p.nodeId,
        ...(p.ref ? { ref: p.ref } : {}),
        ...(p.queueTaskId ? { queueTaskId: p.queueTaskId } : {}),
        patchedKeys: p.patchedKeys,
        ...(p.priorBlockedReason ? { priorBlockedReason: p.priorBlockedReason.slice(0, 200) } : {}),
        // Whether the retry actually recovered the node — the reason the patch
        // was made at all, and the thing a later reader needs to know.
        outcome: p.outcome,
        state: p.state,
        ...(p.blockedReason ? { blockedReason: p.blockedReason.slice(0, 200) } : {}),
        materializationVersion: p.materializationVersion,
        ...(p.coordinatorSessionId ? { coordinatorSessionId: p.coordinatorSessionId } : {}),
    });
}
