/**
 * REBASE-FAILURE-CLASSIFY — what actually went wrong when `git rebase` failed.
 *
 * ★The defect this exists to kill (observed 2026-08-20, jobs
 * refine_ix_mt1d5wir_3226uh / refine_ix_mt1ew71i_zobslj): the rebase catch block in
 * router-refine.ts returned a HARDCODED `needs_rebase_with_conflicts` +
 * "auto-rebase failed due to conflicts" for EVERY rebase execution failure, without
 * ever looking at the error. The ledger's own `sync_base` stage recorded git's real
 * stderr:
 *
 *     error: cannot rebase: You have unstaged changes.
 *     error: Please commit or stash them.
 *
 * The rebase never ran. There was no conflict — `ahead:0, behind:1, diverged:false`.
 * But the coordinator read "auto-rebase failed due to conflicts" and came within one
 * step of hand-pushing an already-merged branch via a manual strict-ff bypass.
 *
 * "Behind main" was true; "conflicts" was authored by the error handler. This module
 * makes that distinction observable: it reads git's stderr and names the cause.
 *
 * Design constraints:
 *  - PURE. Takes an error/message, returns a classification. No git, no fs, no I/O —
 *    so it is cheap to test exhaustively against real stderr strings.
 *  - FAIL-HONEST, not fail-conflict. An unrecognized failure becomes
 *    `rebase_failed` (a truthful "the rebase command failed, cause unclassified"),
 *    never `needs_rebase_with_conflicts`. Claiming a conflict we did not observe is
 *    precisely the defect; a vaguer-but-true code is strictly better than a
 *    confident lie, because the coordinator's next action differs (manual conflict
 *    resolution vs. clean the worktree vs. read the stderr).
 *  - The ORIGINAL stderr always rides along. ★The only reason the 2026-08-20
 *    investigation could conclude anything was that the raw stderr survived in the
 *    ledger's stage record. Every classification here carries it forward into the
 *    terminal result so the next reader has the same evidence without needing the
 *    ledger.
 */

/** Terminal `code` for a rebase that failed. */
export type RefineRebaseFailureCode =
    /** git reported an actual merge conflict — a human must resolve content. */
    | 'needs_rebase_with_conflicts'
    /** The rebase REFUSED TO START because the worktree had uncommitted changes. */
    | 'worktree_dirty'
    /** The rebase failed for an identifiable non-conflict reason we can name. */
    | 'rebase_precondition_failed'
    /** The rebase failed and we will not guess why. */
    | 'rebase_failed';

export interface RefineRebaseFailureClassification {
    code: RefineRebaseFailureCode;
    /**
     * True only when git actually reported conflicting content. Callers that used
     * to branch on "the code is needs_rebase_with_conflicts" should branch on this.
     */
    conflict: boolean;
    /**
     * Whether re-running the refine could plausibly succeed without human content
     * work. A dirty worktree is retryable-in-principle (the dirt may be transient
     * build output), a real conflict is not.
     */
    retryable: boolean;
    /** Machine-readable sub-cause, for the ledger blockerContext. */
    detail:
        | 'merge_conflict'
        | 'unstaged_changes'
        | 'uncommitted_changes'
        | 'untracked_would_be_overwritten'
        | 'rebase_in_progress'
        | 'unmerged_files'
        | 'submodule_non_trivial_merge'
        | 'unclassified';
    /** ★git's raw stderr/message, verbatim and untruncated by this module. */
    originalStderr: string;
}

/**
 * Pull the most informative text out of whatever the rebase threw.
 *
 * `execFileSync` with `stdio: ['ignore','pipe','pipe']` throws an Error carrying
 * `stderr`/`stdout` as Buffers, and a `message` that is only ever
 * "Command failed: git rebase <sha>" — the message ALONE never contains the cause,
 * which is exactly why the old handler could not have classified correctly even if
 * it had tried to read it. So stderr comes first, stdout second (git writes some
 * rebase diagnostics there), message last as the fallback.
 *
 * The gitlink-aware path throws a synthetic Error whose `message` DOES carry the
 * reason (`gitlink-aware rebase aborted: ...`) plus a `gitlinkRebaseReason`; those
 * are folded in so both rebase implementations classify through one function.
 */
export function extractRebaseFailureText(err: unknown): string {
    if (err === null || err === undefined) return '';
    if (typeof err === 'string') return err;
    const e = err as Record<string, unknown>;
    const parts: string[] = [];
    const push = (v: unknown) => {
        if (v === null || v === undefined) return;
        // Buffer | string | anything stringifiable
        const s = typeof v === 'string' ? v : (typeof (v as any)?.toString === 'function' ? String(v) : '');
        const trimmed = s.trim();
        if (trimmed) parts.push(trimmed);
    };
    push(e.stderr);
    push(e.stdout);
    // The gitlink-aware rebase's own reason/conflict paths (synthetic error).
    push(e.gitlinkRebaseReason);
    if (Array.isArray(e.gitlinkRebaseConflicts) && e.gitlinkRebaseConflicts.length > 0) {
        push(`conflicting paths: ${(e.gitlinkRebaseConflicts as unknown[]).join(', ')}`);
    }
    push(e.message);
    // De-duplicate: `message` often already embeds stderr for some spawn wrappers.
    const seen = new Set<string>();
    return parts.filter(p => (seen.has(p) ? false : (seen.add(p), true))).join('\n');
}

/**
 * Markers that mean git found CONFLICTING CONTENT. Deliberately narrow: every
 * entry here is text git emits only when a merge/rebase actually produced
 * conflicts, never when it merely refused to start.
 *
 * ★"CONFLICT" is matched case-sensitively and as a whole word-ish token because
 * git's conflict banner is literally `CONFLICT (content): Merge conflict in <path>`.
 * Lowercasing it would also match the word "conflict" inside prose like
 * "resolve conflicts manually and retry" — i.e. it would match OUR OWN error
 * string and make the classifier self-confirming.
 */
const CONFLICT_MARKERS: readonly RegExp[] = [
    /^CONFLICT\b/m,
    /\bCONFLICT \(/,
    /Merge conflict in /,
    /could not apply [0-9a-f]{4,}/i,
    /error: could not apply/i,
    /Resolve all conflicts manually/i,
    /fix conflicts and then run/i,
    /Automatic merge failed/i,
];

/**
 * Non-conflict preconditions that abort a rebase BEFORE it does any merging.
 * These are the ones the old handler mislabeled as conflicts.
 */
const PRECONDITION_MARKERS: ReadonlyArray<{
    re: RegExp;
    code: RefineRebaseFailureCode;
    detail: RefineRebaseFailureClassification['detail'];
    retryable: boolean;
}> = [
    // ★The literal string from the observed defect.
    {
        re: /cannot rebase:? You have unstaged changes/i,
        code: 'worktree_dirty', detail: 'unstaged_changes', retryable: true,
    },
    {
        re: /cannot (?:rebase|pull with rebase):[\s\S]*?have unstaged changes/i,
        code: 'worktree_dirty', detail: 'unstaged_changes', retryable: true,
    },
    {
        re: /(?:your index contains uncommitted changes|cannot rebase:? Your index contains uncommitted changes)/i,
        code: 'worktree_dirty', detail: 'uncommitted_changes', retryable: true,
    },
    {
        re: /Please commit or stash them/i,
        code: 'worktree_dirty', detail: 'unstaged_changes', retryable: true,
    },
    {
        re: /untracked working tree files? would be overwritten/i,
        code: 'worktree_dirty', detail: 'untracked_would_be_overwritten', retryable: true,
    },
    {
        re: /local changes to the following files would be overwritten/i,
        code: 'worktree_dirty', detail: 'uncommitted_changes', retryable: true,
    },
    {
        // A rebase/merge/am left mid-flight by an earlier run.
        re: /(?:It seems that there is already a rebase-\w+ directory|a rebase is in progress|You have not concluded your (?:merge|rebase)|is already in progress)/i,
        code: 'rebase_precondition_failed', detail: 'rebase_in_progress', retryable: true,
    },
    {
        // Unmerged paths from a PRIOR operation — not conflicts this rebase created.
        re: /(?:You have unmerged files|fix them up in the work tree, and then|needs merge)/i,
        code: 'rebase_precondition_failed', detail: 'unmerged_files', retryable: false,
    },
    {
        // git's recursive merge refusing a non-trivial submodule gitlink. This is
        // NOT content conflict — it is git declining to compute one.
        re: /Recursive merging with submodules currently only supports trivial cases/i,
        code: 'rebase_precondition_failed', detail: 'submodule_non_trivial_merge', retryable: false,
    },
];

/**
 * ★Classify a failed `git rebase` from its real output.
 *
 * Order matters and is deliberate: PRECONDITIONS are tested BEFORE conflict
 * markers. git's "cannot rebase: You have unstaged changes" output can be
 * accompanied by unrelated advice text, and a precondition abort means the rebase
 * never merged anything — so no conflict claim can be true, whatever else the text
 * happens to contain. Testing conflicts first would let a stray word re-create the
 * exact false positive this module removes.
 */
export function classifyRefineRebaseFailure(err: unknown): RefineRebaseFailureClassification {
    const originalStderr = extractRebaseFailureText(err);

    for (const marker of PRECONDITION_MARKERS) {
        if (marker.re.test(originalStderr)) {
            return {
                code: marker.code,
                conflict: false,
                retryable: marker.retryable,
                detail: marker.detail,
                originalStderr,
            };
        }
    }

    for (const re of CONFLICT_MARKERS) {
        if (re.test(originalStderr)) {
            return {
                code: 'needs_rebase_with_conflicts',
                conflict: true,
                retryable: false,
                detail: 'merge_conflict',
                originalStderr,
            };
        }
    }

    // ★FAIL-HONEST: unrecognized. Say the rebase failed, not that it conflicted.
    return {
        code: 'rebase_failed',
        conflict: false,
        retryable: false,
        detail: 'unclassified',
        originalStderr,
    };
}

/**
 * The human-facing error string for a classified rebase failure.
 *
 * ★Always ends with the raw git output. The whole reason the 2026-08-20 defect was
 * diagnosable is that git's own words survived somewhere; putting them in the
 * terminal error means the next reader does not need ledger access to see them.
 * Bounded so a pathological rebase cannot blow up an event payload — the ledger
 * stage record still holds the untruncated text.
 */
export const REBASE_STDERR_EXCERPT_LIMIT = 2_000;

export function buildRefineRebaseFailureError(
    classification: RefineRebaseFailureClassification,
    ctx: { baseBranch: string; diverged: boolean; ahead: number; behind: number },
): string {
    const position = ctx.diverged
        ? `Branch has diverged from ${ctx.baseBranch} (ahead ${ctx.ahead}, behind ${ctx.behind})`
        : `Branch is behind ${ctx.baseBranch} (behind ${ctx.behind})`;

    const cause = classification.code === 'needs_rebase_with_conflicts'
        ? 'and auto-rebase onto the fetched base hit CONTENT CONFLICTS; resolve them manually and retry.'
        : classification.code === 'worktree_dirty'
            ? 'and auto-rebase REFUSED TO START because the worktree has uncommitted changes '
                + '(no rebase ran, so nothing conflicted); commit, stash or clean the worktree and retry.'
            : classification.detail === 'rebase_in_progress'
                ? 'and auto-rebase could not start because a rebase/merge is already in progress in that worktree '
                    + '(no rebase ran, so nothing conflicted); finish or abort it and retry.'
                : classification.detail === 'submodule_non_trivial_merge'
                    ? 'and auto-rebase aborted because git declined a non-trivial submodule gitlink merge '
                        + '(this is git refusing to merge, NOT a content conflict); converge the submodule pointer and retry.'
                    : classification.detail === 'unmerged_files'
                        ? 'and auto-rebase could not start because the worktree has unmerged paths left by an earlier '
                            + 'operation (no rebase ran); resolve them and retry.'
                        : 'and auto-rebase failed for a reason this classifier does not recognize '
                            + '(NOT necessarily a conflict — read the git output below before acting).';

    const excerpt = classification.originalStderr.length > REBASE_STDERR_EXCERPT_LIMIT
        ? `${classification.originalStderr.slice(0, REBASE_STDERR_EXCERPT_LIMIT)}\n…[truncated; full text in the sync_base stage record]`
        : classification.originalStderr;

    return `${position} ${cause}`
        + (excerpt ? `\n--- git output ---\n${excerpt}` : '\n--- git output ---\n(none captured)');
}
