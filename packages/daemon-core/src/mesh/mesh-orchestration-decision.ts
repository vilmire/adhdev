// ---------------------------------------------------------------------------
// mesh-orchestration-decision — the pure enqueue-decision vocabulary (C-W9a)
// ---------------------------------------------------------------------------
// Moved verbatim out of mesh-graph-provenance.ts (design :697-731) so the
// mcp-server can normalize a coordinator's orchestration_decision and forward
// the advisory strings without importing the record-writing provenance module
// (C8: provenance records are written in the daemon, via its IPC commands).
// mesh-graph-provenance.ts re-exports every name.
// ---------------------------------------------------------------------------

/** design :702-718 — the enqueue-decision record, plus the direct surface (below). */
export interface NormalizedOrchestrationDecision {
    decision: 'batch' | 'single' | 'direct';
    ready_worker_tasks?: number;
    known_graph_steps?: number;
    single_reason?: string | null;
    /**
     * GRAPH-MEASUREMENT-DIRECT — why a DIRECT dispatch (`mesh_send_task`) was right,
     * rather than the queue. Null on the batch and single surfaces, which answer a
     * different question (see {@link MESH_VALID_DIRECT_REASONS}).
     */
    direct_reason?: string | null;
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

/**
 * GRAPH-MEASUREMENT-DIRECT — the closed `direct_reason` vocabulary for
 * `mesh_send_task`.
 *
 * ★ WHY A SEPARATE AXIS FROM `single_reason`. The two surfaces answer different
 * questions. A single ENQUEUE answers "why one step instead of a declared graph",
 * so its reasons are about plan shape (`only_one_step_known`,
 * `future_step_not_specifiable`). A DIRECT dispatch answers "why this already-running
 * session instead of the queue", so its reasons are about session continuity. Folding
 * them into one enum would make the majority surface's rows unreadable: a coordinator
 * reporting `only_one_step_known` on a direct dispatch has answered a question nobody
 * asked, and the row could not be classified.
 *
 * ★ EVERY VALUE HERE IS READ OFF THE COORDINATOR PROMPT, not invented. The point of
 * the measurement is to test compliance with what the prompt already says, so the
 * vocabulary must be the prompt's own. The `sanctioned` flag records whether the
 * prompt endorses that reason for direct dispatch — it is what makes a justified
 * direct separable from a lazy one after the fact.
 */
export const MESH_DIRECT_REASONS = [
    {
        // coordinator-prompt WORKFLOW 3.a :1147 "Same-subject continuation of an
        // already-running session is mesh_send_task"; RULES :1235 "The test is subject
        // continuity, not timing".
        value: 'same_subject_continuation',
        sanctioned: true,
    },
    {
        // WORKFLOW 3.f :1172 — the investigate→fix handoff: "you hand off by sending a
        // follow-up mesh_send_task to the SAME session WITHOUT the read-only flag".
        // RULES :1239 "Don't split investigation from the fix".
        value: 'investigation_handoff',
        sanctioned: true,
    },
    {
        // RULES :1235 "Reuse idle sessions ... send only the delta to the existing idle
        // session" — follow-up, retry, commit/push, or cleanup on the same issue.
        value: 'idle_session_reuse',
        sanctioned: true,
    },
    {
        // WORKFLOW 3.c :1169 "Use mesh_send_task only when you need to bypass the queue
        // and force a specific node to execute a task immediately."
        value: 'queue_bypass_urgent',
        sanctioned: true,
    },
    {
        // ★ THE LAZY CASE, and the reason this vocabulary is worth recording at all.
        // RULES :1235(e) names it explicitly as a case that must NOT reuse the session:
        // "the delta is a genuinely NEW subject rather than a continuation — a new topic
        // appended to an existing session can be dropped or re-run as the previous task,
        // so give it its own task even when a session sits idle."
        //
        // It is a LEGAL value, not a rejection: phase E measures and does not enforce, and
        // a coordinator that honestly reports `new_subject` produces a far more useful
        // datapoint than one that picks a sanctioned-sounding label to avoid a warning.
        // It is flagged (`unsanctionedDirect`) and advised, never refused.
        value: 'new_subject',
        sanctioned: false,
    },
    // Shared with the single-enqueue axis: a client that predates the field, and an
    // explicit human instruction that overrides the routing rules.
    { value: 'legacy_client', sanctioned: true },
    { value: 'operator_override', sanctioned: true },
] as const;

/** The bare `direct_reason` values, for schema docs and validation. */
export const MESH_VALID_DIRECT_REASONS: readonly string[] =
    MESH_DIRECT_REASONS.map(r => r.value);

/** The subset the coordinator prompt does NOT endorse for a direct dispatch. */
export const MESH_UNSANCTIONED_DIRECT_REASONS: readonly string[] =
    MESH_DIRECT_REASONS.filter(r => !r.sanctioned).map(r => r.value);

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
    /**
     * GRAPH-MEASUREMENT-DIRECT — set when a DIRECT dispatch reported a reason the
     * coordinator prompt does not endorse for that surface (today: `new_subject`).
     * Advisory only: like every other signal in this module it is a measurement, and
     * the dispatch proceeds unchanged.
     */
    unsanctionedDirect?: {
        code: 'unsanctioned_direct_dispatch';
        reportedReason: string;
        message: string;
    };
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
    surface: 'batch' | 'single' | 'direct',
): OrchestrationDecisionNormalizeResult {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const readCount = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
    const readyWorkerTasks = readCount(source.ready_worker_tasks ?? source.readyWorkerTasks);
    const knownGraphSteps = readCount(source.known_graph_steps ?? source.knownGraphSteps);
    const rawReason = source.single_reason ?? source.singleReason;
    const singleReason = typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : null;
    // GRAPH-MEASUREMENT-DIRECT: the direct surface's own reason axis. Read
    // independently of single_reason so a caller that supplies both (or the wrong one
    // for the surface) still produces a well-formed row on the axis that applies.
    const rawDirectReason = source.direct_reason ?? source.directReason;
    const directReason = typeof rawDirectReason === 'string' && rawDirectReason.trim()
        ? rawDirectReason.trim()
        : null;
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
        // Emitted only on the direct surface, mirroring how single_reason is emitted
        // only on the single surface: a null reason on the axis that does not apply is
        // noise that every consumer would have to filter.
        ...(surface === 'direct' ? { direct_reason: directReason } : {}),
        ...(blockers.length > 0 ? { capability_blockers: blockers } : {}),
    };

    const result: OrchestrationDecisionNormalizeResult = { decision };

    // GRAPH-MEASUREMENT-DIRECT: classify the direct surface against the prompt's own
    // sanctioned list. Advisory only — nothing here can fail a dispatch.
    if (surface === 'direct') {
        if (directReason && MESH_UNSANCTIONED_DIRECT_REASONS.includes(directReason)) {
            result.unsanctionedDirect = {
                code: 'unsanctioned_direct_dispatch',
                reportedReason: directReason,
                message: `'${directReason}' is not a sanctioned reason to dispatch directly into an existing `
                    + 'session: a new topic appended to a session can be dropped or re-run as the previous task. '
                    + 'Give genuinely new work its own task (mesh_enqueue_batch, or mesh_enqueue_task when it is a '
                    + 'terminal single step) even when a session sits idle. Recorded, not refused.',
            };
        }
        return result;
    }

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

/**
 * The coordinator-facing hint for an unsanctioned direct dispatch.
 *
 * Composed here rather than at the call site for symmetry with
 * {@link MESH_DECLARED_ELIGIBLE_SINGLE_HINT} — see that constant's note. The direct
 * dispatch surface (mesh-tools-session.ts) is not itself covered by the pinned-surface
 * scan, but keeping both advisories in the graph layer means neither call site has to
 * know which of the two rules applies to it.
 */
export const MESH_UNSANCTIONED_DIRECT_HINT =
    'You dispatched directly into an existing session for work you classified as a new subject. A new topic '
    + 'appended to a session can be dropped, or re-run as the previous task; give it its own task instead — '
    + 'mesh_enqueue_batch when a further step follows it, mesh_enqueue_task when nothing does.';
