/**
 * Submodule-gitlink CONVERGENCE for the Refinery's sync_base stage.
 *
 * Extracted verbatim from `mesh-refine-gates.ts` (pure move — no behaviour
 * change) to keep that file under the file-size gate. It holds the two-step
 * machinery that turns a diverged submodule gitlink into a linear, mergeable
 * history:
 *
 *   STEP 1 {@link convergeDivergedSubmoduleGitlinks} — rebase the branch-side
 *          submodule commit onto the base-side one inside the worktree's
 *          submodule checkout.
 *   STEP 2 {@link rootRebaseResolvingGitlinks} — rebase the root branch onto the
 *          base head, resolving each gitlink conflict to STEP 1's commit.
 *
 * `mesh-refine-gates.ts` re-exports everything public here, so importers keep
 * using the gates module unchanged.
 */
import * as fs from 'fs';
import { resolve as pathResolve } from 'path';
import { execFileSync } from 'node:child_process';

import { GIT, ensureSubmoduleCommitLocal, readChangedGitlinkPaths, readTreeObject, submoduleCommitPresent } from './mesh-refine-gitlink-utils.js';

/**
 * Classification of a changed gitlink pair, used by the diverged-converge path.
 *
 *   diverged      — both commits local, neither an ancestor of the other, shared
 *                   merge base → the case auto-converge exists for.
 *   not_diverged  — equal / strict ff / strictly behind → nothing to converge.
 *   undeterminable — at least one of the two commits is NOT present in the local
 *                   submodule object store (or the checkout is missing), so no
 *                   ancestry question can be answered at all.
 *
 * ★`undeterminable` must NOT be collapsed into `not_diverged`. They are opposite
 * statements: "these commits are not divergent" vs "we could not tell". The old
 * code returned a bare false for both, so an object-fetch failure surfaced to the
 * coordinator as `not_diverged` — a positive claim about the history — and led to
 * a misdiagnosis (a stale daemon was blamed for what was actually a missing
 * object). Keeping them distinct is the whole point of this type.
 */
type SubmoduleDivergenceClass = 'diverged' | 'not_diverged' | 'undeterminable';

/**
 * Classify a changed gitlink pair (see {@link SubmoduleDivergenceClass}).
 * `baseCommit` ancestor-of `branchCommit` (strict fast-forward) is
 * `not_diverged`: that case needs no rebase (the gate excludes it). Equal commits
 * or a non-gitlink path are likewise `not_diverged`. A commit missing from the
 * local object store is `undeterminable` — never `not_diverged`.
 */
function classifySubmoduleDivergence(
    submoduleRepoPath: string,
    baseCommit: string,
    branchCommit: string,
): SubmoduleDivergenceClass {
    if (!baseCommit || !branchCommit) return 'undeterminable';
    if (baseCommit === branchCommit) return 'not_diverged';
    try {
        if (!fs.existsSync(submoduleRepoPath)) return 'undeterminable';
        execFileSync(GIT, ['cat-file', '-e', `${baseCommit}^{commit}`], { cwd: submoduleRepoPath, stdio: 'ignore' });
        execFileSync(GIT, ['cat-file', '-e', `${branchCommit}^{commit}`], { cwd: submoduleRepoPath, stdio: 'ignore' });
    } catch {
        // One of the commits is not available locally — we cannot judge divergence.
        return 'undeterminable';
    }
    // base ancestor-of branch ⇒ pure fast-forward, not a sibling divergence.
    try {
        execFileSync(GIT, ['merge-base', '--is-ancestor', baseCommit, branchCommit], { cwd: submoduleRepoPath, stdio: 'ignore' });
        return 'not_diverged';
    } catch { /* not a fast-forward → keep checking */ }
    // branch ancestor-of base ⇒ branch is strictly behind (base already contains
    // it); no branch-side commits to replay, not our case.
    try {
        execFileSync(GIT, ['merge-base', '--is-ancestor', branchCommit, baseCommit], { cwd: submoduleRepoPath, stdio: 'ignore' });
        return 'not_diverged';
    } catch { /* neither ancestor of the other → genuine divergence */ }
    // Require a real shared merge base so the rebase has a sane replay range.
    try {
        const mb = execFileSync(GIT, ['merge-base', baseCommit, branchCommit], { cwd: submoduleRepoPath, encoding: 'utf8' }).trim();
        // No shared merge base = unrelated histories; there is no sane replay
        // range, so this is not a convergeable sibling divergence.
        return mb ? 'diverged' : 'not_diverged';
    } catch {
        // `merge-base` exits non-zero when the two commits share no ancestor.
        return 'not_diverged';
    }
}

/**
 * Whether both commits exist locally in the submodule repo AND neither is an
 * ancestor of the other — i.e. a genuine sibling divergence off a shared merge
 * base. Thin wrapper over {@link classifySubmoduleDivergence} for callers that do
 * not need to distinguish "not divergent" from "could not tell".
 */
function isSubmoduleDivergedSibling(submoduleRepoPath: string, baseCommit: string, branchCommit: string): boolean {
    return classifySubmoduleDivergence(submoduleRepoPath, baseCommit, branchCommit) === 'diverged';
}

/**
 * Resolve the submodule's remote-tracking ref for its default branch
 * (`refs/remotes/origin/<branch>`). Sync, best-effort: the origin/HEAD symref
 * first, then the conventional main/master names. Undefined when none exists
 * locally — the published-equivalence short-circuit then simply does not
 * engage and the caller falls through to the rewrite path.
 */
function resolveSubmoduleRemoteMainRef(submoduleRepoPath: string): string | undefined {
    try {
        const sym = execFileSync(GIT, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], { cwd: submoduleRepoPath, encoding: 'utf8' }).trim();
        if (sym) return sym;
    } catch { /* no origin/HEAD symref */ }
    for (const branch of ['main', 'master']) {
        try {
            execFileSync(GIT, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], { cwd: submoduleRepoPath, stdio: ['ignore', 'pipe', 'pipe'] });
            return `refs/remotes/origin/${branch}`;
        } catch { /* try the next conventional name */ }
    }
    return undefined;
}

/**
 * Gap #1 (parallel-refine twin): when base and branch diverged a submodule
 * gitlink, the usual remedy is to rebase the branch-side submodule commit onto
 * the base-side one. But when a SIBLING job already merged the same content and
 * pushed it to the submodule's origin/<default> (same tree, different SHA — the
 * "published twin"), rewriting again mints a THIRD same-content commit that the
 * reachability gate then cannot find on the remote and (wrongly) demands be
 * published. Real case: origin/main=83ea6c68, sibling published 67dab44d, the
 * Refinery rewrote the branch commit into d8e3acb7 — d8e3acb7's tree was
 * byte-identical to 67dab44d's, yet it was not reachable from origin/main.
 *
 * This helper detects that case BEFORE any rewrite: it computes the tree the
 * rebase would produce (`merge-tree --write-tree`) and looks for a published
 * commit on the remote main ref that (a) descends from the base-side commit and
 * (b) has exactly that tree. Both conditions together make converging the
 * gitlink to the published commit strictly equivalent to rewriting it — a
 * genuine divergence (different content) never matches, so legitimate rewrites
 * are untouched. Any git failure returns undefined (fail-safe: the caller falls
 * through to the historical rebase path).
 */
export function findEquivalentPublishedSubmoduleCommit(
    submoduleRepoPath: string,
    baseCommit: string,
    branchCommit: string,
    remoteRef: string,
): string | undefined {
    try {
        const mergeTreeOut = execFileSync(GIT, ['merge-tree', '--write-tree', baseCommit, branchCommit], {
            cwd: submoduleRepoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        const mergedTree = mergeTreeOut.trim().split(/\s+/)[0] || '';
        if (!mergedTree) return undefined;
        const candidates = execFileSync(GIT, ['rev-list', '--max-count=100', remoteRef, '--not', baseCommit], {
            cwd: submoduleRepoPath, encoding: 'utf8',
        }).split('\n').map(s => s.trim()).filter(Boolean);
        for (const candidate of candidates) {
            // The published commit must descend from the base side, or converging
            // the gitlink to it would break the linear history the downstream
            // patch-equivalence gate relies on.
            try {
                execFileSync(GIT, ['merge-base', '--is-ancestor', baseCommit, candidate], { cwd: submoduleRepoPath, stdio: 'ignore' });
            } catch {
                continue;
            }
            const tree = execFileSync(GIT, ['rev-parse', `${candidate}^{tree}`], { cwd: submoduleRepoPath, encoding: 'utf8' }).trim();
            if (tree === mergedTree) return candidate;
        }
    } catch { /* conflicted merge-tree / missing objects → no equivalence evidence */ }
    return undefined;
}

export type SubmoduleGitlinkConvergeResult = {
    /** True when at least one diverged gitlink submodule was rebased onto its base-side commit. */
    converged: boolean;
    /**
     * Set when convergence was declined/aborted (fail-safe → caller keeps the
     * original defer→blocked_review path). One of:
     *   no_changed_gitlinks — no gitlink differs base↔branch
     *   not_diverged        — the gitlink is ff/behind/equal (gate handles it)
     *   submodule_commit_unavailable — ★NOT the same as not_diverged: one of the
     *                         two gitlink commits could not be made available in
     *                         the local submodule object store, so divergence was
     *                         UNDETERMINABLE. Reported separately so an object-
     *                         fetch failure is never mistaken for a positive
     *                         "these commits are not divergent" claim.
     *   rebase_conflict     — replaying branch-side onto base-side hit a real
     *                         content conflict inside the submodule (aborted)
     *   rebase_dropped_branch_commits — the rebase exited 0 but the branch-side
     *                         commits are NOT reachable from the rebased tip (git
     *                         skipped them as already-applied). Converging would
     *                         silently discard the branch side, so we refuse.
     *   submodule_publish_required — ★PRE-MINT GATE: the divergence is real and
     *                         convergeable, but the rebase would MINT a submodule
     *                         commit reachable from nowhere on the submodule's
     *                         remote, and auto-publish is DISABLED — so the
     *                         downstream reachability gate is guaranteed to reject
     *                         it. Refusing before the rewrite keeps the branch
     *                         untouched and makes the reported action the one that
     *                         actually unblocks: publish the submodule commit.
     */
    reason?: string;
    /**
     * Converged gitlinks: path → the rebased submodule commit (SUBNEW) that the
     * root rebase must resolve the gitlink conflict to. Only populated for paths
     * whose submodule was successfully rebased (base-side is now a strict ancestor).
     */
    resolutions: Array<{ path: string; baseCommit: string; branchCommit: string; rebasedCommit: string }>;
    /** Per-path outcome for observability/logging. */
    gitlinks: Array<{
        path: string;
        baseCommit?: string;
        branchCommit?: string;
        rebasedCommit?: string;
        action: 'rebased' | 'converged_to_published' | 'skipped_not_diverged' | 'skipped_commit_unavailable' | 'rebase_conflict' | 'rebase_dropped_branch_commits' | 'publish_required_before_rebase';
        /**
         * Which side's commit could not be made available locally. Only set with
         * `skipped_commit_unavailable`, so the log/stage record names the object
         * that is actually missing instead of just saying "not diverged".
         */
        unavailable?: Array<'base' | 'branch'>;
        /**
         * ★Observability (Gap #3): set on `rebased` to state plainly that this
         * action MINTED a submodule commit that exists on no remote yet. The
         * incident was made worse by the coordinator not noticing the Refinery had
         * synthesized a commit at all — the stage record said "rebased" and read as
         * a pointer move. `mintedUnpublishedCommit: true` says otherwise.
         *
         * It is `true` only when the rewrite was allowed to proceed despite the new
         * tip being unreachable from the submodule remote — i.e. auto-publish is
         * enabled and a publish is expected to follow.
         */
        mintedUnpublishedCommit?: boolean;
        /**
         * Which submodule remote ref the publish-required decision was made
         * against (`refs/remotes/origin/main` etc.), or `undefined` when no remote
         * main ref could be resolved at all. Only set with
         * `publish_required_before_rebase` / `mintedUnpublishedCommit`.
         */
        remoteMainRef?: string;
    }>;
};

/**
 * Options for {@link convergeDivergedSubmoduleGitlinks}.
 */
export type ConvergeDivergedSubmoduleGitlinksOptions = {
    /**
     * Mirrors the Refinery's `allowAutoPublishSubmoduleMainCommits` policy
     * (resolved by `resolveRefineryAutoPublishSubmoduleMainCommits`).
     *
     * ★This flag is what separates "minting is pointless" from "minting is
     * legitimate", and the pre-mint gate MUST respect it:
     *  - `false` (default) — nobody will publish the minted commit, so the
     *    downstream reachability gate WILL fail on it. Refuse before the rewrite.
     *  - `true` — the Refinery is permitted to push the submodule commit to the
     *    submodule's origin main, so reachability is obtainable and the rewrite is
     *    justified. Gating it here would block normal convergence.
     */
    allowAutoPublishSubmoduleMainCommits?: boolean;
};

/**
 * Whether `commit` is reachable from the submodule's remote main ref — i.e.
 * already published. Undefined `remoteMainRef` (no origin main resolvable) counts
 * as NOT reachable: we have no evidence of publication, and the pre-mint gate's
 * whole job is to refuse to synthesize commits we cannot show are publishable.
 */
function isCommitReachableFromRemoteMain(
    submoduleRepoPath: string,
    commit: string,
    remoteMainRef: string | undefined,
): boolean {
    if (!remoteMainRef) return false;
    try {
        execFileSync(GIT, ['merge-base', '--is-ancestor', commit, remoteMainRef], { cwd: submoduleRepoPath, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/**
 * STEP 1 of auto-converging diverged oss-style submodule gitlinks: rebase the
 * branch-side submodule commit(s) onto the base-side submodule commit INSIDE the
 * worktree's submodule checkout (detached HEAD), so the base-side commit becomes a
 * strict ancestor of the rebased tip. Returns the rebased commit per path so the
 * caller's root rebase can resolve the gitlink conflict to it (STEP 2, see
 * {@link rootRebaseResolvingGitlinks}). This automates the documented manual
 * strict-fast-forward bypass and keeps the landed submodule history linear rather
 * than masking a divergence.
 *
 * Gap #1 short-circuit: before rewriting, each diverged submodule's origin is
 * fetched and checked for an ALREADY-PUBLISHED equivalent commit (identical
 * merged tree, descending from the base side — the parallel-refine twin). When
 * one exists the gitlink converges to the published commit (`converged_to_published`)
 * and no rewrite happens; see {@link findEquivalentPublishedSubmoduleCommit}.
 *
 * Fail-safe by construction: it only touches gitlinks that are a genuine sibling
 * divergence (both commits local, neither an ancestor of the other, shared merge
 * base). A submodule rebase content conflict aborts, restores the branch-side
 * checkout, and returns `converged:false` (caller keeps defer→blocked_review). It
 * never commits the root and NEVER pushes — remote publish is the merge/
 * reachability stage's job; this stage is local reconciliation only.
 *
 * @param worktreeRoot the branch worktree root (its `<path>` submodule checkout is rebased)
 * @param baseRepoRoot the source/base repo root (reads the base-side gitlink commit)
 * @param baseHead     the fetched base head (root ref) — source of base-side gitlink commits
 * @param branchHead   the worktree branch head (root ref) — source of branch-side gitlink commits
 */
export function convergeDivergedSubmoduleGitlinks(
    worktreeRoot: string,
    baseRepoRoot: string,
    baseHead: string,
    branchHead: string,
    options: ConvergeDivergedSubmoduleGitlinksOptions = {},
): SubmoduleGitlinkConvergeResult {
    const changed = readChangedGitlinkPaths(worktreeRoot, baseHead, branchHead);
    if (changed.length === 0) {
        return { converged: false, reason: 'no_changed_gitlinks', resolutions: [], gitlinks: [] };
    }

    const gitlinks: SubmoduleGitlinkConvergeResult['gitlinks'] = [];
    const resolutions: SubmoduleGitlinkConvergeResult['resolutions'] = [];
    let sawDiverged = false;
    let sawUndeterminable = false;

    for (const path of changed) {
        // Base-side commit comes from the base repo's tree; branch-side from the worktree's.
        const baseCommit = readTreeObject(baseRepoRoot, baseHead, path);
        const branchCommit = readTreeObject(worktreeRoot, branchHead, path);
        const submoduleRepoPath = pathResolve(worktreeRoot, path);

        // The base-side submodule commit is recorded by the base workspace but may not
        // yet exist in the worktree's submodule object store (it was committed locally
        // in base/<path> and not necessarily fetched here). Make it available via a
        // best-effort local fetch from the base repo's own submodule checkout so the
        // ancestry check and rebase can see it. Without this, a genuinely-convergeable
        // divergence would look "not local" and fall through to blocked_review.
        if (baseCommit) {
            ensureSubmoduleCommitLocal(submoduleRepoPath, pathResolve(baseRepoRoot, path), baseCommit);
        }

        // ★`undeterminable` is deliberately NOT folded into `skipped_not_diverged`:
        // we did not establish that the gitlinks are non-divergent, we failed to
        // obtain an object needed to ask the question at all. Reporting it as "not
        // diverged" is what previously sent the coordinator chasing a stale-daemon
        // theory, so name the side that is missing and use its own reason below.
        const markUndeterminable = (): void => {
            const unavailable: Array<'base' | 'branch'> = [];
            if (!baseCommit || !submoduleCommitPresent(submoduleRepoPath, baseCommit)) unavailable.push('base');
            if (!branchCommit || !submoduleCommitPresent(submoduleRepoPath, branchCommit)) unavailable.push('branch');
            sawUndeterminable = true;
            gitlinks.push({ path, baseCommit, branchCommit, action: 'skipped_commit_unavailable', unavailable });
        };
        // A gitlink whose commit could not even be read out of the tree is
        // undeterminable by definition. Handling it first also narrows both commits
        // to `string` for the rest of the loop.
        if (!baseCommit || !branchCommit) {
            markUndeterminable();
            continue;
        }
        const divergence = classifySubmoduleDivergence(submoduleRepoPath, baseCommit, branchCommit);
        if (divergence === 'undeterminable') {
            markUndeterminable();
            continue;
        }
        if (divergence !== 'diverged') {
            gitlinks.push({ path, baseCommit, branchCommit, action: 'skipped_not_diverged' });
            continue;
        }
        sawDiverged = true;

        // Gap #1 (parallel-refine twin): BEFORE rewriting the branch side, check
        // whether the submodule's published origin already carries an equivalent
        // commit — a sibling job may have merged the same content and pushed it
        // (same tree, different SHA). Converging the gitlink to that published
        // commit keeps the landed history on public commits instead of minting a
        // local same-content twin that the reachability gate would then (wrongly)
        // demand be pushed. Best-effort fetch; any failure leaves no evidence and
        // the rewrite path below runs unchanged.
        try {
            execFileSync(GIT, ['-c', 'protocol.file.allow=always', 'fetch', '-q', 'origin'], { cwd: submoduleRepoPath, stdio: ['ignore', 'ignore', 'pipe'] });
        } catch { /* offline / no origin → no published-equivalence evidence */ }
        const remoteMainRef = resolveSubmoduleRemoteMainRef(submoduleRepoPath);
        const publishedEquivalent = remoteMainRef
            ? findEquivalentPublishedSubmoduleCommit(submoduleRepoPath, baseCommit, branchCommit, remoteMainRef)
            : undefined;
        if (publishedEquivalent) {
            try { execFileSync(GIT, ['checkout', '-q', '--detach', publishedEquivalent], { cwd: submoduleRepoPath, stdio: ['ignore', 'ignore', 'pipe'] }); } catch { /* the root rebase re-detaches when resolving the gitlink */ }
            gitlinks.push({ path, baseCommit, branchCommit, rebasedCommit: publishedEquivalent, action: 'converged_to_published' });
            resolutions.push({ path, baseCommit, branchCommit, rebasedCommit: publishedEquivalent });
            continue;
        }

        // ★ PRE-MINT PUBLISH GATE (Gap #3) — refuse to synthesize a commit whose
        // rejection is already certain.
        //
        // Reaching here means: the gitlink is genuinely diverged AND no published
        // equivalent exists on the submodule remote. The rebase below would
        // therefore MINT a brand-new submodule commit that is reachable from no
        // remote. The downstream `refineSubmoduleReachabilityStage` then demands it
        // be published — so with auto-publish off, running the rebase cannot
        // possibly end in a merge. It only rewrites the branch's submodule history
        // (and, via STEP 2, the root branch) on the way to a guaranteed block,
        // leaving an orphan gitlink pointing at a commit that exists on one machine.
        //
        // The honest move is to stop BEFORE the rewrite: the branch stays exactly as
        // the worker left it, and the reported next step is the one that actually
        // unblocks — publish the submodule commit, not "rebase again".
        //
        // ★The gate is deliberately narrow, because over-correcting here would block
        // the normal convergence path that sibling worktrees rely on. It fires ONLY
        // when auto-publish is disabled. When the policy allows the Refinery to push
        // the submodule commit to origin main, reachability IS obtainable and
        // minting is legitimate — so the rewrite proceeds untouched (and is tagged
        // `mintedUnpublishedCommit` for observability).
        //
        // ★It also fires only when the rebase would actually SUCCEED. A submodule
        // whose content genuinely conflicts must keep reporting `rebase_conflict`:
        // that is both more specific and differently actionable (resolve the
        // conflict vs publish the commit), and letting the publish gate shadow it
        // would weaken conflict detection. `merge-tree --write-tree` answers
        // "would this replay conflict?" without touching the checkout.
        const branchAlreadyPublished = isCommitReachableFromRemoteMain(submoduleRepoPath, branchCommit, remoteMainRef);
        const willMintUnpublishedCommit = !branchAlreadyPublished;
        const wouldConflict = (() => {
            try {
                execFileSync(GIT, ['merge-tree', '--write-tree', baseCommit, branchCommit], {
                    cwd: submoduleRepoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
                });
                return false;
            } catch {
                // Non-zero exit = conflicted merge → let the real rebase below produce
                // the precise `rebase_conflict` outcome and its checkout restore.
                return true;
            }
        })();
        if (willMintUnpublishedCommit && !wouldConflict && options.allowAutoPublishSubmoduleMainCommits !== true) {
            gitlinks.push({
                path,
                baseCommit,
                branchCommit,
                action: 'publish_required_before_rebase',
                remoteMainRef,
            });
            // Nothing was rewritten — the submodule checkout is untouched, so there is
            // no state to restore. Caller keeps defer→blocked_review.
            return { converged: false, reason: 'submodule_publish_required', resolutions: [], gitlinks };
        }

        // Rebase the branch-side submodule commit(s) onto the base-side commit in a
        // DETACHED HEAD (never move a submodule branch ref). A conflict aborts and
        // restores the submodule checkout to the branch-side commit.
        let rebasedCommit: string | undefined;
        try {
            execFileSync(GIT, ['checkout', '-q', '--detach', branchCommit], { cwd: submoduleRepoPath, stdio: ['ignore', 'ignore', 'pipe'] });
            execFileSync(GIT, ['rebase', baseCommit], { cwd: submoduleRepoPath, stdio: ['ignore', 'pipe', 'pipe'] });
            rebasedCommit = execFileSync(GIT, ['rev-parse', 'HEAD'], { cwd: submoduleRepoPath, encoding: 'utf8' }).trim();
        } catch {
            try { execFileSync(GIT, ['rebase', '--abort'], { cwd: submoduleRepoPath, stdio: 'ignore' }); } catch { /* ignore */ }
            try { execFileSync(GIT, ['checkout', '-q', '--detach', branchCommit], { cwd: submoduleRepoPath, stdio: 'ignore' }); } catch { /* ignore */ }
            gitlinks.push({ path, baseCommit, branchCommit, action: 'rebase_conflict' });
            // Real submodule content conflict → do NOT converge; caller keeps blocked_review.
            return { converged: false, reason: 'rebase_conflict', resolutions: [], gitlinks };
        }

        // ★ POINTER RE-TARGETING GATE — the guard against silently losing one side.
        //
        // `git rebase` exits 0 even when it drops every commit it was asked to replay:
        // if the base side already contains an EQUIVALENT patch (a sibling landed the
        // same content under a different SHA — precisely the parallel-refine case),
        // the replayed commits become empty and git skips them ("skipped previously
        // applied commit"). The rebase then "succeeds" with HEAD == baseCommit, and
        // the branch-side work is unreachable from the pointer we are about to stage
        // into the root commit. Without this check that work vanishes silently.
        //
        // The gate demands positive proof that the branch side survived. Note the
        // discriminator is NOT `merge-base --is-ancestor branchCommit rebasedCommit`:
        // a rebase always rewrites SHAs, so the original branchCommit is never an
        // ancestor of the rebased tip even on a perfectly clean replay — that check
        // would block every legitimate convergence. (Verified empirically before
        // choosing this signal.)
        //
        // The signal that actually distinguishes the two cases is how many commits the
        // rebase LANDED on top of the base: a clean replay leaves >=1 commit in
        // `baseCommit..rebasedCommit`, while a fully-dropped replay leaves 0 (and
        // rebasedCommit collapses onto baseCommit). Anything we cannot positively
        // verify is refused and left to the defer→blocked_review path so a human
        // decides, rather than this code silently discarding a side.
        const branchWorkSurvived = (() => {
            if (!rebasedCommit) return false;
            // Trivially preserved when the rebase was a no-op (already up to date).
            if (rebasedCommit === branchCommit) return true;
            // A tip that collapsed onto the base carries none of the branch's work.
            if (rebasedCommit === baseCommit) return false;
            try {
                const replayed = execFileSync(GIT, ['rev-list', '--count', `${baseCommit}..${rebasedCommit}`], {
                    cwd: submoduleRepoPath, encoding: 'utf8',
                }).trim();
                return Number.parseInt(replayed, 10) > 0;
            } catch {
                return false;
            }
        })();
        if (!branchWorkSurvived) {
            // Restore the submodule checkout to the branch side; converge nothing.
            try { execFileSync(GIT, ['checkout', '-q', '--detach', branchCommit], { cwd: submoduleRepoPath, stdio: 'ignore' }); } catch { /* ignore */ }
            gitlinks.push({ path, baseCommit, branchCommit, rebasedCommit, action: 'rebase_dropped_branch_commits' });
            return { converged: false, reason: 'rebase_dropped_branch_commits', resolutions: [], gitlinks };
        }

        // ★Name the synthesis explicitly (Gap #3). `action: 'rebased'` alone reads
        // like a pointer move; when the rebase minted a commit that no remote yet
        // carries, the stage record must say so — a publish is still owed.
        gitlinks.push({
            path,
            baseCommit,
            branchCommit,
            rebasedCommit,
            action: 'rebased',
            ...(willMintUnpublishedCommit ? { mintedUnpublishedCommit: true, remoteMainRef } : {}),
        });
        resolutions.push({ path, baseCommit, branchCommit, rebasedCommit: rebasedCommit! });
    }

    if (!sawDiverged) {
        // ★An undeterminable path outranks the not_diverged summary: if we could not
        // even judge one gitlink, the honest report is "could not determine", not
        // "nothing was divergent". The caller records this as `convergeReason`, so
        // the coordinator sees the object-availability problem directly instead of a
        // false all-clear about the submodule history.
        const reason = sawUndeterminable ? 'submodule_commit_unavailable' : 'not_diverged';
        return { converged: false, reason, resolutions: [], gitlinks };
    }
    return { converged: resolutions.length > 0, resolutions, gitlinks };
}

/**
 * The structural next step recorded on the `submodule_gitlink_converge` stage
 * when the pre-mint publish gate defers. Kept next to the gate (rather than
 * inline at the call site) so the wording and the decision cannot drift apart.
 *
 * ★It must say PUBLISH, not "rebase". Telling the coordinator to retry the rebase
 * is what the incident did, and each retry minted a fresh orphan commit.
 */
export const SUBMODULE_PUBLISH_REQUIRED_RECOMMENDED_ACTION =
    'Publish the branch-side submodule commit(s) to submodule origin main, then rerun mesh_refine_node. '
    + 'Do NOT retry the rebase: the branch was intentionally left unrewritten because a rebase here would '
    + 'mint a submodule commit the reachability gate must reject.';

/**
 * Human-readable log line for a pre-mint publish-gate deferral — names each
 * gitlink and the commit that must be published.
 */
export function describeSubmodulePublishRequired(
    nodeId: string,
    gitlinks: SubmoduleGitlinkConvergeResult['gitlinks'],
): string {
    const pending = gitlinks.filter(g => g.action === 'publish_required_before_rebase');
    return `[Refinery] Refusing to auto-converge diverged submodule gitlink(s) for node ${nodeId} — `
        + `the rebase would create a NEW submodule commit that is not reachable from the submodule remote, and `
        + `allowAutoPublishSubmoduleMainCommits is disabled, so the reachability gate would reject it. `
        + `The branch was left untouched. NEXT STEP: publish the branch-side submodule commit(s) to submodule `
        + `origin main, then rerun mesh_refine_node — do NOT rebase: `
        + pending
            .map(g => `${g.path} (branch=${(g.branchCommit || '?').slice(0, 12)} base=${(g.baseCommit || '?').slice(0, 12)} remote=${g.remoteMainRef || 'unresolved'})`)
            .join(', ');
}

/**
 * Log line for a declined convergence whose reason means something OTHER than
 * "there was nothing to converge" — returns undefined for the ordinary reasons
 * (not_diverged / rebase_conflict / dropped commits) that need no extra warning.
 *
 * Two reasons qualify, and conflating either with "not diverged" has already
 * misled an investigation once each:
 *   submodule_publish_required   — we DECLINED to rewrite (publish first)
 *   submodule_commit_unavailable — we could not JUDGE (missing object)
 */
export function describeSubmoduleConvergeDecline(
    nodeId: string,
    reason: string | undefined,
    gitlinks: SubmoduleGitlinkConvergeResult['gitlinks'],
): string | undefined {
    if (reason === 'submodule_publish_required') {
        return describeSubmodulePublishRequired(nodeId, gitlinks);
    }
    if (reason === 'submodule_commit_unavailable') {
        return `[Refinery] Could NOT determine submodule gitlink divergence for node ${nodeId} — `
            + `a gitlink commit is missing from the local submodule object store (auto-converge could not run): `
            + gitlinks
                .filter(g => g.action === 'skipped_commit_unavailable')
                .map(g => `${g.path} (missing: ${(g.unavailable || []).join('+') || 'unknown'}; base=${(g.baseCommit || '?').slice(0, 12)} branch=${(g.branchCommit || '?').slice(0, 12)})`)
                .join(', ');
    }
    return undefined;
}

/**
 * Extra stage-record fields for a declined convergence. Only the pre-mint
 * publish-gate deferral carries a structural `recommendedAction`; every other
 * decline reason keeps the historical (field-free) record shape.
 */
export function buildSubmoduleConvergeDeclineDetails(
    reason: string | undefined,
    autoPublishEnabled: boolean,
): { recommendedAction?: string; autoPublishAllowed?: boolean } {
    if (reason !== 'submodule_publish_required') return {};
    return {
        recommendedAction: SUBMODULE_PUBLISH_REQUIRED_RECOMMENDED_ACTION,
        autoPublishAllowed: autoPublishEnabled,
    };
}

/**
 * Human-readable log line for the observability gap the incident exposed: a
 * convergence that SYNTHESIZED submodule commit(s) rather than merely re-pointing
 * the gitlink. Returns undefined when nothing was minted (nothing to say).
 */
export function describeMintedUnpublishedCommits(
    nodeId: string,
    gitlinks: SubmoduleGitlinkConvergeResult['gitlinks'],
    autoPublishEnabled: boolean,
): string | undefined {
    const minted = gitlinks.filter(g => g.mintedUnpublishedCommit);
    if (minted.length === 0) return undefined;
    return `[Refinery] Node ${nodeId}: the convergence MINTED ${minted.length} new submodule commit(s) not reachable `
        + `from the submodule remote (allowed because allowAutoPublishSubmoduleMainCommits=${autoPublishEnabled}); `
        + `a publish is still required before merge: `
        + minted.map(g => `${g.path}→${(g.rebasedCommit || '?').slice(0, 12)} (remote=${g.remoteMainRef || 'unresolved'})`).join(', ');
}

export type RootRebaseGitlinkResolveResult = {
    /** True when the root rebase completed (with gitlink conflicts resolved to the converged commits). */
    ok: boolean;
    /** New root HEAD after the rebase (only meaningful when ok). */
    branchHead?: string;
    /**
     * Set when the rebase was aborted (fail-safe). One of:
     *   non_gitlink_conflict — a conflict on a non-submodule path (genuine content conflict)
     *   unexpected_gitlink   — a gitlink conflicted that we have no converged commit for
     *   rebase_error         — the rebase failed for a non-conflict reason
     */
    reason?: string;
    /** The paths that conflicted at the point of abort (for diagnostics). */
    conflictPaths?: string[];
};

/**
 * STEP 2 of auto-converging diverged submodule gitlinks: rebase the worktree root
 * branch onto `baseHead`, resolving each submodule-gitlink conflict to the
 * pre-converged commit from {@link convergeDivergedSubmoduleGitlinks}. git's
 * recursive merge refuses to auto-merge a diverged gitlink ("Recursive merging
 * with submodules currently only supports trivial cases"), so we drive the rebase
 * ourselves: on each stop, if the ONLY unmerged paths are gitlinks we have a
 * converged commit for, we stage those to the converged commit and `--continue`.
 * Any non-gitlink conflict (or a gitlink with no converged commit) aborts the
 * rebase and returns `ok:false` → caller keeps the defer→blocked_review path.
 *
 * On success the base-side gitlink is a strict ancestor of the resolved branch-side
 * commit, so the downstream patch-equivalence gate treats it as a trivial
 * fast-forward and passes.
 */
export function rootRebaseResolvingGitlinks(
    worktreeRoot: string,
    baseHead: string,
    resolutions: Array<{ path: string; rebasedCommit: string }>,
): RootRebaseGitlinkResolveResult {
    const resolveByPath = new Map(resolutions.map(r => [r.path, r.rebasedCommit]));

    const runRebase = (args: string[]): { ok: boolean } => {
        try {
            execFileSync(GIT, args, {
                cwd: worktreeRoot,
                stdio: ['ignore', 'pipe', 'pipe'],
                // A rebase editor prompt would hang; keep it non-interactive.
                env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
            });
            return { ok: true };
        } catch {
            return { ok: false };
        }
    };

    const unmergedPaths = (): string[] => {
        try {
            return execFileSync(GIT, ['diff', '--name-only', '--diff-filter=U'], { cwd: worktreeRoot, encoding: 'utf8' })
                .split('\n').map(s => s.trim()).filter(Boolean);
        } catch {
            return [];
        }
    };

    const abort = (reason: string, conflictPaths?: string[]): RootRebaseGitlinkResolveResult => {
        try { execFileSync(GIT, ['rebase', '--abort'], { cwd: worktreeRoot, stdio: 'ignore' }); } catch { /* ignore */ }
        return { ok: false, reason, conflictPaths };
    };

    let progress = runRebase(['rebase', baseHead]);
    let guard = 0;
    while (!progress.ok) {
        if (guard++ > 100) return abort('rebase_error');
        const conflicts = unmergedPaths();
        if (conflicts.length === 0) {
            // Failed but no recorded conflicts — a non-conflict rebase error.
            return abort('rebase_error');
        }
        // Every conflicting path must be a gitlink we have a converged commit for.
        const unresolvable = conflicts.filter(p => !resolveByPath.has(p));
        if (unresolvable.length > 0) {
            // Distinguish a genuine (non-gitlink) content conflict from a gitlink we
            // simply have no converged commit for. `ls-files --stage` reports mode
            // 160000 for a gitlink at any conflict stage.
            const unresolvableGitlink = unresolvable.some(p => {
                try {
                    const staged = execFileSync(GIT, ['ls-files', '--stage', '--', p], { cwd: worktreeRoot, encoding: 'utf8' });
                    return /^160000\s/m.test(staged);
                } catch {
                    return false;
                }
            });
            const allGitlink = unresolvable.every(p => {
                try {
                    const staged = execFileSync(GIT, ['ls-files', '--stage', '--', p], { cwd: worktreeRoot, encoding: 'utf8' });
                    return /^160000\s/m.test(staged);
                } catch {
                    return false;
                }
            });
            // A non-gitlink conflict is the fail-safe case that must clearly signal a
            // genuine content conflict; a gitlink-only miss is the (rarer) case where a
            // gitlink conflicted that STEP 1 did not converge.
            return abort(allGitlink && unresolvableGitlink ? 'unexpected_gitlink' : 'non_gitlink_conflict', conflicts);
        }
        // Stage every conflicting gitlink to its converged commit, then continue.
        for (const p of conflicts) {
            const commit = resolveByPath.get(p)!;
            try {
                execFileSync(GIT, ['checkout', '-q', '--detach', commit], { cwd: pathResolve(worktreeRoot, p), stdio: 'ignore' });
            } catch { /* the checkout is best-effort; the `add` below stamps the index either way */ }
            try {
                execFileSync(GIT, ['add', p], { cwd: worktreeRoot, stdio: 'ignore' });
            } catch {
                return abort('rebase_error', conflicts);
            }
        }
        progress = runRebase(['rebase', '--continue']);
    }

    let branchHead: string | undefined;
    try {
        branchHead = execFileSync(GIT, ['rev-parse', 'HEAD'], { cwd: worktreeRoot, encoding: 'utf8' }).trim();
    } catch { /* leave undefined */ }
    return { ok: true, branchHead };
}
