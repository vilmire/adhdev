/**
 * GHOST-FAILURE: merge-landing evidence for a terminal refine result.
 *
 * Extracted from router-refine.ts as a pure move (that file is at its frozen file-size
 * baseline). No behaviour change — `extractRefineMergeLanding` is re-exported from
 * router-refine.ts so every existing import path keeps working.
 */

/**
 * Decide, from the result shape alone, whether a refine actually landed the merge on
 * the base branch — and if so, how far it got (local vs pushed).
 *
 * The ghost this exists to kill: a refine whose merge succeeded but whose POST-merge
 * step failed (worktree cleanup, submodule alignment, push) terminates with
 * `success: false` + a stage-specific code. `finishMeshRefineJob` classified purely on
 * `success`/`code`, so the coordinator was told "failed" for work that is on origin and
 * whose worktree is already gone. Coordinators then either re-refined an already-merged
 * node (manufacturing a SECOND, genuinely-broken job against a deleted worktree — which
 * is where a ghost `dependency_bootstrap_failed`/`needs_rebase_with_conflicts` comes
 * from) or hand-classified it as blocked_review. This turns that guesswork into a fact
 * carried on the event.
 *
 * Deliberately EVIDENCE-BASED, never inferred from the failure code: it reads only the
 * explicit `merged`/`pushed` markers the merge stage stamps, so a stage that never
 * reached the merge cannot be mistaken for one that did. A pre-merge failure has no
 * `merged` marker at all and is reported exactly as before — this is why widening the
 * "success" surface cannot swallow a real failure.
 *
 * Pure (a function of the result shape) so it is unit-testable without the pipeline.
 */
export type RefineMergeLanding = {
    /** The merge commit is on the LOCAL base branch. */
    merged: boolean;
    /** The merge reached origin/<baseBranch>. */
    pushed: boolean;
};

export type RefineTerminalKind =
    | 'completed'
    | 'completed_with_warnings'
    | 'blocked_review'
    | 'validation_failed'
    | 'submodule_reachability_failed'
    | 'merge_failed'
    | 'cleanup_failed';

export type RefineTerminalClassification = {
    kind: RefineTerminalKind;
    landing: RefineMergeLanding;
    /** A post-merge failure: the change IS on origin, only a trailing step failed. */
    isPostMergeWarning: boolean;
    /** "Did the change land on origin?" — decides completed-vs-failed NOTIFICATION. */
    converged: boolean;
    /** "Is there nothing left to do?" — decides whether a blockerContext is attached. */
    clean: boolean;
};

/**
 * B1: Discriminated terminal status — do not rely solely on `result.success`. Maps
 * known failure codes to structured terminal kinds, and (GHOST-FAILURE) separates two
 * questions that were previously collapsed into one flag:
 *
 *   converged — "did the change land on origin?" This is what decides the
 *     refine:completed vs refine:failed NOTIFICATION, because that is the question the
 *     coordinator uses the notification to answer. A post-merge warning answers YES:
 *     re-refining it is wrong and destructive.
 *   clean — "is there nothing left to do?" Only a fully-clean run. This still drives
 *     blockerContext/nextStep, so residual manual work (worktree cleanup, submodule
 *     alignment) is reported in full rather than swallowed.
 *
 * Collapsing these into one flag is what produced the ghost in the first place.
 */
export function classifyRefineTerminal(result: Record<string, unknown>): RefineTerminalClassification {
    const refineCode = typeof result.code === 'string' ? result.code : '';

    // Did this run actually land the merge? Read from explicit merge-stage evidence
    // only (never inferred from the code), so a pre-merge failure can never be mistaken
    // for a landed one.
    const landing = extractRefineMergeLanding(result);

    // A POST-merge failure on the auto-push path — the merge is on origin and the
    // worktree is (or was meant to be) gone; only a trailing local step failed.
    // Reporting this as a flat failure is what made coordinators re-refine an
    // already-merged node against a deleted worktree, manufacturing the second,
    // genuinely-broken job. It stays a NON-success terminal (the operator still has real
    // cleanup to do) but gets its own kind.
    //
    // Scoped deliberately tight — pushed===true only. A merge that landed locally but
    // FAILED to push (push_failed) is NOT converged: origin does not have the change,
    // the batch must not count it, and it keeps its blocked/merge_failed reporting.
    const isPostMergeWarning = result.success !== true && landing.merged && landing.pushed;

    const kind: RefineTerminalKind = result.success === true
        ? 'completed'
        : isPostMergeWarning
            ? 'completed_with_warnings'
        // GHOST-FAILURE: `worktree_missing` is a blocked-review state, NOT a merge
        // failure — nothing was merged and nothing conflicted. Left to the fallback it
        // would have been reported as merge_failed, the misleading label this removes.
        : refineCode === 'blocked_review' || refineCode === 'worktree_missing'
            ? 'blocked_review'
            // QW3: the validation stage returns `code: validationSummary.failureCode`,
            // so a dependency/spawn failure surfaces as one of these codes — NOT the
            // literal 'validation_failed'. They must map to the validation_failed
            // terminal kind too, otherwise they fell through to the merge_failed
            // fallback and coordinators saw a merge failure for a missing-deps block.
            : refineCode === 'validation_failed' || refineCode === 'validation_dependencies_missing'
                || refineCode === 'missing_dependencies' || refineCode === 'dependency_bootstrap_failed'
                || refineCode === 'spawn_resolution_failed' || refineCode === 'validation_unavailable'
                // An output-budget kill is a validation-stage failure like the rest;
                // without it here it fell through to the 'merge_failed' fallback and
                // coordinators saw a merge failure for a command that never finished.
                || refineCode === 'output_limit_exceeded'
                ? 'validation_failed'
                : refineCode === 'submodule_reachability_failed'
                    ? 'submodule_reachability_failed'
                    : refineCode === 'merge_failed' || refineCode === 'patch_equivalence_failed' || refineCode === 'needs_rebase' || refineCode === 'needs_rebase_with_conflicts'
                        ? 'merge_failed'
                        : refineCode === 'cleanup_failed'
                            ? 'cleanup_failed'
                            : 'merge_failed'; // fallback for unclassified failures

    const clean = kind === 'completed';
    return { kind, landing, isPostMergeWarning, converged: clean || isPostMergeWarning, clean };
}

/**
 * Default `nextStep` for a non-clean terminal kind (used only when the pipeline did not
 * already supply a more specific one).
 *
 * GHOST-FAILURE: `completed_with_warnings` is the one next-step that must NOT say "retry
 * mesh_refine_node" — the merge is already on origin, so a retry is exactly the
 * destructive re-refine this fix exists to prevent.
 */
export function refineTerminalNextStep(kind: RefineTerminalKind): string {
    switch (kind) {
        case 'blocked_review':
            return 'Request user review/approval before attempting to merge again.';
        case 'validation_failed':
            return 'Fix failing tests or configure validation.bootstrapCommands and retry mesh_refine_node.';
        case 'submodule_reachability_failed':
            return 'Push unreachable submodule commits to origin/main, then retry mesh_refine_node.';
        case 'merge_failed':
            return 'Resolve merge conflicts or patch equivalence issues, then retry mesh_refine_node.';
        case 'cleanup_failed':
            return 'Manually remove the worktree and retry or use mesh_remove_node.';
        case 'completed_with_warnings':
            return 'The merge IS on origin — do NOT re-run mesh_refine_node. Only the post-merge step below needs attention '
                + '(worktree cleanup / submodule alignment); treat the branch as merged_to_main.';
        default:
            return 'Inspect refineStages for the failing stage and retry.';
    }
}

/**
 * GHOST-FAILURE: the terminal result for a refine whose worktree directory is already
 * GONE before the pipeline ran a single git command.
 *
 * The overwhelmingly likely cause is that a previous refine for this node already
 * merged, pushed and cleaned it up — worktree removal is the LAST step of a successful
 * refine, so a missing directory is evidence of prior success, not of a broken node.
 *
 * Without this guard the pipeline spawned into the deleted directory anyway:
 * `git branch --show-current` (or, once past it, the validation gate's bootstrap
 * commands, which run with cwd = workspace) died with ENOENT and was reported as
 * `dependency_bootstrap_failed` — or, having no `code` at all, fell through the outer
 * catch to the `merge_failed` fallback. That is precisely the ghost: a hard failure
 * notification for a node whose work is already on origin, and it is why the observed
 * ghosts arrived with the worktree already deleted.
 *
 * Deliberately NOT reported as success — this run merged nothing and must not claim it
 * did. It is a distinct, non-retryable terminal state that names the likely cause and
 * tells the coordinator to verify rather than re-refine.
 */
export function buildRefineWorktreeMissingResult(
    nodeId: string,
    workspace: string,
    refineStages: Array<Record<string, unknown>>,
): { success: false } & Record<string, unknown> {
    return {
        success: false,
        code: 'worktree_missing',
        convergenceStatus: 'blocked_review',
        // Never auto-retried: re-running cannot recreate the worktree, and the node has
        // most likely already converged.
        retryable: false,
        workspaceMissing: true,
        error: `The worktree directory for node '${nodeId}' no longer exists (${workspace}); nothing was merged by this run. `
            + `Worktree removal is the final step of a SUCCESSFUL refine, so this node was most likely already merged and cleaned up by an earlier job — `
            + `verify with 'git -C <repoRoot> log --oneline' before acting. Do NOT re-run refine to "fix" this.`,
        nextStep: 'Verify whether the branch already merged into the base (it most likely did). If so, treat the node as merged_to_main and remove it from the mesh; only re-clone if the work is genuinely missing.',
        refineStages,
        finalBranchConvergenceState: {
            baseBranch: undefined, merged: false, removed: true, status: 'blocked_review',
        },
    };
}

export function extractRefineMergeLanding(result: Record<string, unknown>): RefineMergeLanding {
    // `merged`/`mergedLocal` are stamped ONLY after `git merge` returned 0 (see
    // runRefineMergeAndFinalizeLocked). finalBranchConvergenceState carries the same
    // facts for the success path; read both so a shape that sets only one still counts.
    const fbcs = (result.finalBranchConvergenceState && typeof result.finalBranchConvergenceState === 'object')
        ? result.finalBranchConvergenceState as Record<string, unknown>
        : undefined;
    const merged = result.merged === true || result.mergedLocal === true || fbcs?.merged === true;
    const pushed = result.pushed === true || fbcs?.pushed === true;
    // `pushed` without `merged` is not a coherent shape; never report it as landed.
    return { merged: !!merged, pushed: !!pushed && !!merged };
}
