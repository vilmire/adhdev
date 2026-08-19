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

import { appendLedgerEntry, type MeshLedgerKind } from './mesh-ledger.js';
import { LOG } from '../logging/logger.js';

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

/** design :702-718 — the enqueue-decision record. */
export interface NormalizedOrchestrationDecision {
    decision: 'batch' | 'single';
    ready_worker_tasks?: number;
    known_graph_steps?: number;
    single_reason?: string | null;
    capability_blockers?: string[];
}

/**
 * design :714-718 — the valid `single_reason` values AFTER v2.
 *
 * `output_needed`, `workspace_unresolved` and `coordinator_action_between` are
 * deliberately absent: v2 supports all three (via `inputs_from`, `workspace_ref`
 * and coordinator gates), so reporting one is not a blocker but a signal that the
 * caller has not adopted the batch surface. {@link normalizeOrchestrationDecision}
 * keeps the reported value and flags it, rather than silently rewriting it.
 */
export const MESH_VALID_SINGLE_REASONS = [
    'only_one_step_known',
    'future_step_not_specifiable',
    'same_session_continuation',
    'legacy_client',
    'operator_override',
] as const;

/** design :720-724 — pre-P0 reasons the batch surface now covers. */
export const MESH_SUPERSEDED_SINGLE_REASONS = [
    'output_needed',
    'workspace_unresolved',
    'coordinator_action_between',
] as const;

export interface OrchestrationDecisionNormalizeResult {
    decision: NormalizedOrchestrationDecision;
    /**
     * design :722-724 — set when the caller claimed a blocker the batch surface
     * already handles. The server returns this as a structured WARNING; it never
     * rejects. ★ Rejection (`batch_required`) is phase F, gated on the server
     * feature being deployed first — E only measures.
     */
    batchCapabilityAvailable?: {
        code: 'batch_capability_available';
        reportedReason: string;
        message: string;
    };
    /** Set when `known_graph_steps >= 2` was declared but the single tool was used. */
    declaredEligibleSingle?: boolean;
}

/**
 * Normalize a caller-supplied `orchestration_decision` (design :697-731).
 *
 * Never throws: an unusable record degrades to a minimal one. The metric this
 * feeds — "declared eligible singles" — is only meaningful if a malformed record
 * still lands rather than failing the enqueue.
 */
export function normalizeOrchestrationDecision(
    raw: unknown,
    surface: 'batch' | 'single',
): OrchestrationDecisionNormalizeResult {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const readCount = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
    const readyWorkerTasks = readCount(source.ready_worker_tasks ?? source.readyWorkerTasks);
    const knownGraphSteps = readCount(source.known_graph_steps ?? source.knownGraphSteps);
    const rawReason = source.single_reason ?? source.singleReason;
    const singleReason = typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : null;
    const rawBlockers = source.capability_blockers ?? source.capabilityBlockers;
    const blockers = Array.isArray(rawBlockers)
        ? rawBlockers
            .filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
            .map(b => b.trim())
        : [];

    const decision: NormalizedOrchestrationDecision = {
        decision: surface,
        ...(readyWorkerTasks !== undefined ? { ready_worker_tasks: readyWorkerTasks } : {}),
        ...(knownGraphSteps !== undefined ? { known_graph_steps: knownGraphSteps } : {}),
        single_reason: surface === 'single' ? singleReason : null,
        ...(blockers.length > 0 ? { capability_blockers: blockers } : {}),
    };

    const result: OrchestrationDecisionNormalizeResult = { decision };
    if (surface !== 'single') return result;

    const superseded = [singleReason, ...blockers].find(
        (value): value is string => !!value && (MESH_SUPERSEDED_SINGLE_REASONS as readonly string[]).includes(value),
    );
    if (superseded) {
        result.batchCapabilityAvailable = {
            code: 'batch_capability_available',
            reportedReason: superseded,
            message: `'${superseded}' is no longer a blocker: mesh_enqueue_batch supports selected predecessor outputs `
                + '(inputs_from), delayed worktree preparation (workspace_ref) and coordinator gates. '
                + 'Declare the whole known plan in one batch instead of enqueueing the steps separately.',
        };
    }
    if (knownGraphSteps !== undefined && knownGraphSteps >= 2) {
        result.declaredEligibleSingle = true;
    }
    return result;
}

/**
 * The coordinator-facing hint for a declared-eligible single (design :722-724).
 *
 * ★ WHY THIS STRING LIVES HERE AND NOT AT THE CALL SITE. Its caller is
 * `mesh_enqueue_task` in mcp-server's `mesh-tools-queue.ts`, which is one of the
 * three PINNED SCHEDULING SURFACES (design :984-986). Those files must contain no
 * graph-layer vocabulary at all — `run_if`, `inputs_from`, `workspace_ref` — and the
 * rule is enforced by a source-text scan (daemon-core's
 * mesh-scheduler-dependency-gate-invariant suite), deliberately with no exemption for
 * comments or user-facing prose. A scan that trusted intent could not tell an
 * advisory string from a real graph check, which is the whole point: the scheduler
 * must be provably ignorant of graphs. So the advisory is composed in the graph layer
 * and the scheduling surface only forwards the finished string.
 */
export const MESH_DECLARED_ELIGIBLE_SINGLE_HINT =
    'You declared known_graph_steps >= 2 but used the single-task surface. Submit the known steps as one '
    + 'mesh_enqueue_batch — its input bindings, conditions and coordinator gates declare the ones that need '
    + 'predecessor evidence, a condition, or a coordinator action — instead of enqueueing them one at a time.';

function safeAppend(meshId: string, kind: MeshLedgerKind, payload: Record<string, unknown>, taskId?: string): void {
    try {
        appendLedgerEntry(meshId, { kind, ...(taskId ? { taskId } : {}), payload });
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
