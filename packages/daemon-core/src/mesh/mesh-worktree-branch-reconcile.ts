/**
 * Worktree branch metadata reconciliation.
 *
 * `worktreeBranch` is stamped ONCE when a worktree node is created
 * (med-family/mesh-node-clone.ts, `worktreeBranch: result.branch`) and no code
 * path ever updated it afterwards. Every other reference in daemon-core is a
 * reader. So when a worktree's branch is switched or the directory is reused
 * for a later branch, the record silently keeps naming the ORIGINAL branch
 * while git reports the new one.
 *
 * That single stale field produced three unrelated-looking symptoms
 * (2026-10-16):
 *   1. branchConvergence reported `not_mergeable`/`needsConvergence` for
 *      branches whose content was already merged.
 *   2. mesh_remove_node refused with `mesh_worktree_cleanup_branch_mismatch`,
 *      because router-worktree-cleanup.ts compares git's real branch against
 *      this field.
 *   3. As a consequence of (2) the mesh stayed pinned at its node cap and NO
 *      new worktree could be created — blocking unrelated work entirely.
 *
 * The cleanup guard in (2) is CORRECT: a worktree whose branch is not the one
 * the mesh recorded genuinely must not be deleted on that record's authority.
 * The defect is that it was fed a value frozen at creation time. So this module
 * reconciles the RECORD to observed git truth; it never relaxes the guard, and
 * it never decides that a removal is safe. Whether a branch still holds
 * unmerged work remains entirely the caller's (and the guard's) question.
 *
 * Reconciliation is deliberately observation-driven rather than a write at
 * switch time: the branch of a worktree can change without any mesh code being
 * involved at all (a user or an agent running `git switch` in the directory),
 * so there is no single write site that could stay authoritative. Healing on
 * read is the only shape that converges for branches switched out-of-band.
 */

/** Capability tag prefix that mirrors `worktreeBranch` for task routing. */
const WORKTREE_TAG_PREFIX = 'worktree=';

function readTrimmed(value: unknown): string {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export interface WorktreeBranchReconcileInput {
    /** The mesh node record (read-only here; callers apply the result). */
    node: Record<string, unknown> | null | undefined;
    /**
     * Branch git actually reports for this worktree, or '' / undefined when it
     * could not be observed (detached HEAD, unreadable directory, probe
     * failure). An unobservable branch NEVER triggers a rewrite.
     */
    observedBranch: string | null | undefined;
}

export interface WorktreeBranchReconcileResult {
    /** True when the record disagrees with observed git truth. */
    stale: boolean;
    /** The value currently stored on the record ('' when absent). */
    recordedBranch: string;
    /** The observed branch ('' when it could not be determined). */
    observedBranch: string;
    /**
     * Patch to apply to the node record, or null when nothing should change.
     * Includes the refreshed `worktree=<branch>` capability tag so routing pins
     * (`required_tags: ["worktree=<branch>"]`) follow the branch too — a stale
     * tag silently routes a branch's follow-up work to the wrong workspace.
     */
    patch: { worktreeBranch: string; capabilityTags?: string[] } | null;
    /** Why no patch was produced — for honest logging, never a silent no-op. */
    reason:
        | 'in_sync'
        | 'not_a_worktree_node'
        | 'branch_unobservable'
        | 'no_recorded_branch'
        | 'reconciled';
}

/**
 * Recompute a node's capability tags with the `worktree=` entry refreshed.
 * Preserves every other tag and their order; replaces the worktree tag in
 * place when present so tag ordering stays stable across a heal.
 */
export function refreshWorktreeCapabilityTag(
    tags: unknown,
    branch: string,
): string[] | undefined {
    if (!Array.isArray(tags)) return undefined;
    const existing = tags.filter((t): t is string => typeof t === 'string');
    const wanted = `${WORKTREE_TAG_PREFIX}${branch}`;
    const idx = existing.findIndex(t => t.startsWith(WORKTREE_TAG_PREFIX));
    if (idx === -1) return [...existing, wanted];
    if (existing[idx] === wanted) return undefined;
    const next = [...existing];
    next[idx] = wanted;
    return next;
}

/**
 * Compare a worktree node's recorded branch against observed git truth and
 * report the patch needed to converge them.
 *
 * Fail-closed on every uncertainty: a non-worktree node, an unobservable
 * branch, or a record with no branch at all all produce `patch: null`. In
 * particular an absent `worktreeBranch` is NOT filled in here — a record
 * missing it is the `mesh_worktree_cleanup_missing_branch` case, which must
 * keep refusing rather than be granted a branch by inference.
 */
export function reconcileWorktreeBranch(
    input: WorktreeBranchReconcileInput,
): WorktreeBranchReconcileResult {
    const node = input.node;
    const recordedBranch = readTrimmed(node?.worktreeBranch) || readTrimmed(node?.worktree_branch);
    const observedBranch = readTrimmed(input.observedBranch);
    const base = { recordedBranch, observedBranch };

    if (node?.isLocalWorktree !== true) {
        return { ...base, stale: false, patch: null, reason: 'not_a_worktree_node' };
    }
    // Unobservable git branch (detached HEAD, unreadable worktree): keep the
    // record exactly as-is. Overwriting it with '' would destroy the only
    // record of which branch this workspace is for.
    if (!observedBranch) {
        return { ...base, stale: false, patch: null, reason: 'branch_unobservable' };
    }
    if (!recordedBranch) {
        return { ...base, stale: false, patch: null, reason: 'no_recorded_branch' };
    }
    if (recordedBranch === observedBranch) {
        return { ...base, stale: false, patch: null, reason: 'in_sync' };
    }

    const capabilityTags = refreshWorktreeCapabilityTag(node?.capabilityTags, observedBranch);
    return {
        ...base,
        stale: true,
        reason: 'reconciled',
        patch: {
            worktreeBranch: observedBranch,
            ...(capabilityTags ? { capabilityTags } : {}),
        },
    };
}
