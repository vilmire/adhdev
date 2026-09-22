/**
 * Batch chain-abort: stop a batch when the node that failed took the BASE down
 * with it, and only then.
 *
 * ## The distinction this module exists to make
 *
 * A refine batch converges N sibling branches onto ONE base, sequentially. Its
 * documented design is "isolate a failed node, keep going" — and that is right,
 * because a node whose own tests fail says nothing about its siblings.
 *
 * But the SAME loop has the opposite property when the failure is on the base
 * axis. Every later node merges into the base that the earlier node was supposed
 * to advance; if the base is unmergeable, unreadable, or moved, every remaining
 * node is already determined to fail. Measured 2026-09-22 (incident 2): node 1
 * hit `merge_failed` because the base worktree was dirty, and nodes 2 and 3 then
 * ran their full gate sets — minutes each — to reach the identical failure for
 * the identical reason.
 *
 * So the rule is not "abort on failure" and not "never abort". It is: abort when
 * the failure is a property of the BASE, continue when it is a property of the
 * NODE.
 *
 * ## How the two are told apart
 *
 * Not by guessing from the error text. The refine pipeline already classifies
 * its own failures, and the classification is reused verbatim:
 *
 *   - `code` — the pipeline's terminal code. The base-axis codes are exactly the
 *     ones whose remedy is "fix or re-read the base", never "fix this branch":
 *     the base-movement family already enumerated by
 *     `RETRYABLE_BASE_MOVEMENT_CODES` (base_moved / base_locked /
 *     base_cas_undeterminable), plus `merge_failed` and the accept-time base
 *     preflight codes.
 *   - `stage` — the failing stage, as a back-stop for when a code is absent or
 *     unrecognized. `merge` and `base_cas` are base-axis stages by construction.
 *
 * Everything else — a failing test, a lint error, a patch-equivalence mismatch,
 * a submodule reachability problem specific to one branch's commits — is
 * node-local and must NOT stop the batch. `submodule_reachability_failed` is
 * deliberately NOT treated as base-axis: it says THIS branch's submodule commits
 * are unpublished, which is a fact about the branch, and a sibling that touched
 * no submodule converges fine.
 *
 * ## Why `merge_failed` counts as base-axis despite being node-shaped
 *
 * A merge conflict between a branch and the base is genuinely ambiguous: it can
 * mean "this branch conflicts" (node-local) or "the base cannot be merged into
 * at all" (base-axis). The incident that motivates this module is the second
 * kind, and the first kind is cheap to get wrong in only one direction:
 *
 *   - Treating a node-local conflict as base-axis stops the batch early. The
 *     remaining nodes are reported as SKIPPED, not failed, and re-running the
 *     batch converges them. Cost: one extra batch invocation.
 *   - Treating a base-axis failure as node-local runs every remaining node's
 *     full gate set to reach a foregone failure. Cost: the incident.
 *
 * The asymmetry is what decides it. Skipped nodes are explicitly labelled as
 * "not attempted" so nothing is silently dropped — see
 * {@link buildSkippedChainNodeOutcome}.
 */

/** Terminal codes whose remedy is to fix the BASE, not the branch. */
const BASE_AXIS_CODES: ReadonlySet<string> = new Set([
    // Base-movement family — identical to RETRYABLE_BASE_MOVEMENT_CODES in
    // router-refine.ts. Kept as a literal rather than imported to avoid a mesh →
    // commands layer dependency (check:boundaries); the parity test
    // mesh-refine-batch-chain-abort.test.ts asserts the two sets agree.
    'base_moved',
    'base_locked',
    'base_cas_undeterminable',
    // The merge itself could not be applied to the base.
    'merge_failed',
    // ★Accept-time base preflight (mesh-refine-accept-preflight.ts). These can
    // reach a per-node outcome when a node is refined individually inside a
    // batch-shaped flow; the base is unusable by definition.
    'base_worktree_dirty',
    'base_stash_entries_present',
    'base_diverged_from_origin',
    'base_preflight_blocked',
]);

/** Failing stages that are base-axis by construction. */
const BASE_AXIS_STAGES: ReadonlySet<string> = new Set(['merge', 'base_cas']);

export interface RefineBatchChainAbortDecision {
    /** True when the remaining nodes are determined to fail and must be skipped. */
    abort: boolean;
    /** The code that triggered the abort, for the report. */
    code?: string;
    /** The stage that triggered the abort, when the code was not decisive. */
    stage?: string;
    /** Human-readable reason, naming the axis. */
    reason?: string;
}

/**
 * Decide whether a finished node outcome should stop the rest of the batch.
 *
 * Only FAILED outcomes can abort: a node that merged, or that was skipped as
 * patch-equivalent, advances the base normally. `retried` is irrelevant here —
 * the second pass runs after the first completes, so a retryable node has
 * already had its chance by the time this matters.
 */
export function decideRefineBatchChainAbort(outcome: {
    convergence: string;
    code?: string;
    stage?: string;
}): RefineBatchChainAbortDecision {
    const failed = outcome.convergence === 'blocked_review' || outcome.convergence === 'not_mergeable';
    if (!failed) return { abort: false };

    const code = typeof outcome.code === 'string' ? outcome.code : '';
    if (code && BASE_AXIS_CODES.has(code)) {
        return {
            abort: true,
            code,
            ...(outcome.stage ? { stage: outcome.stage } : {}),
            reason: `Node failed on the BASE axis (${code}) — the base was not advanced, so every remaining node in this batch would fail for the same reason.`,
        };
    }

    const stage = typeof outcome.stage === 'string' ? outcome.stage : '';
    if (stage && BASE_AXIS_STAGES.has(stage)) {
        return {
            abort: true,
            ...(code ? { code } : {}),
            stage,
            reason: `Node failed in the base-axis stage '${stage}' — the base was not advanced, so every remaining node in this batch would fail for the same reason.`,
        };
    }

    return { abort: false };
}

/**
 * The outcome recorded for a node the batch never attempted.
 *
 * Deliberately NOT a failure: the node was not tried, and reporting it as
 * blocked_review would claim a verdict that was never measured (and would inflate
 * the `blocked` summary count with nodes that may well converge on the next run).
 * `chainSkipped` plus the precursor's identity is what makes the report say
 * "derived from node X" rather than leaving a coordinator to infer it.
 */
export function buildSkippedChainNodeOutcome(params: {
    nodeId: string;
    workspace: string;
    precursorNodeId: string;
    decision: RefineBatchChainAbortDecision;
}): Record<string, unknown> {
    const { nodeId, workspace, precursorNodeId, decision } = params;
    return {
        nodeId,
        workspace,
        convergence: 'skipped_chain_abort',
        chainSkipped: true,
        precursorNodeId,
        ...(decision.code ? { precursorCode: decision.code } : {}),
        ...(decision.stage ? { precursorStage: decision.stage } : {}),
        reason: `Not attempted: node '${precursorNodeId}' failed on the base axis`
            + `${decision.code ? ` (${decision.code})` : ''}, so the base was never advanced.`
            + ' Re-run the batch for this node after resolving that failure.',
    };
}

/**
 * The batch-level `nextStep` when a chain abort happened.
 *
 * States the ROOT cause first and names the skipped nodes, so a coordinator acts
 * on one failure rather than triaging N lookalike ones (B4).
 */
export function buildChainAbortNextStep(params: {
    precursorNodeId: string;
    decision: RefineBatchChainAbortDecision;
    skippedNodeIds: string[];
}): string {
    const { precursorNodeId, decision, skippedNodeIds } = params;
    const skipped = skippedNodeIds.length
        ? ` ${skippedNodeIds.length} node(s) were NOT attempted: ${skippedNodeIds.join(', ')}.`
        : '';
    return `ROOT CAUSE: node '${precursorNodeId}' failed on the base axis`
        + `${decision.code ? ` [${decision.code}]` : ''}${decision.stage ? ` at stage '${decision.stage}'` : ''}`
        + ` and did not advance the base.${skipped}`
        + ' Fix that one failure, then re-run mesh_refine_batch — the skipped nodes were never run and need no cleanup.';
}
