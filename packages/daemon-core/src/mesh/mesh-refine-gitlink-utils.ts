/**
 * Low-level git readers shared by the Refinery's gitlink paths.
 *
 * Extracted verbatim from `mesh-refine-gates.ts` (pure move — no behaviour
 * change) so that `mesh-refine-submodule-converge.ts` can use them without
 * importing the gates module back (which would be circular). Both
 * `mesh-refine-gates.ts` and `mesh-refine-submodule-converge.ts` import from
 * here; nothing here imports either of them.
 */
import * as fs from 'fs';
import { execFileSync } from 'node:child_process';
import { resolve as pathResolve } from 'path';

import { LOG } from '../logging/logger.js';

import { resolveWin32Executable } from '../cli-adapters/resolve-executable.js';

export const GIT = process.platform === 'win32' ? resolveWin32Executable('git') : 'git';

export const REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

/** The gitlink (mode 160000) paths whose recorded commit differs between two refs. */
export function readChangedGitlinkPaths(repoRoot: string, fromRef: string, toRef: string): string[] {
    try {
        const output = execFileSync(GIT, ['diff', '--raw', '--no-abbrev', fromRef, toRef], {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
        });
        const paths = new Set<string>();
        for (const line of output.split('\n')) {
            if (!line.trim()) continue;
            const metaAndPath = line.split('\t');
            const meta = metaAndPath[0] || '';
            const path = metaAndPath[metaAndPath.length - 1]?.trim();
            if (!path) continue;
            const parts = meta.split(/\s+/);
            if (parts[0]?.includes('160000') || parts[1]?.includes('160000')) {
                paths.add(path);
            }
        }
        return [...paths].sort();
    } catch {
        return [];
    }
}

/** The submodule commit a ref's tree records at `path`, or undefined. */
export function readTreeObject(repoRoot: string, ref: string, path: string): string | undefined {
    try {
        const output = execFileSync(GIT, ['ls-tree', ref, '--', path], {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
        }).trim();
        const match = output.match(/\bcommit\s+([0-9a-f]{40})\b/i);
        return match?.[1];
    } catch {
        return undefined;
    }
}

/**
 * Tri-state result of an ancestry probe: answered yes, answered no, or COULD NOT
 * BE ANSWERED. See {@link probeGitAncestry} for why the third state must exist.
 */
export type GitAncestryProbe = true | false | 'undeterminable';

/**
 * Whether every ref/object named in `refs` resolves inside `cwd`. A missing
 * object is the difference between "not an ancestor" and "we cannot tell".
 */
function gitRefsResolvable(cwd: string, refs: string[]): boolean {
    for (const ref of refs) {
        if (!ref) return false;
        try {
            execFileSync(GIT, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, stdio: 'ignore', windowsHide: true });
        } catch {
            return false;
        }
    }
    return true;
}

/**
 * `merge-base --is-ancestor` as a THREE-state probe.
 *
 * ★The two-state predecessor (`execGitOk`, in mesh-refine-gates.ts) is the
 * 2026-08-22 false-block: it ran `merge-base --is-ancestor <commit>
 * refs/remotes/origin/main` and folded EVERY non-zero exit into `false`. git
 * exits non-zero both for "no, not an ancestor" (exit 1) and for "fatal: Not a
 * valid object name" / a missing `refs/remotes/origin/main` — i.e. "we could not
 * judge". The classifier then published `reachableFromOriginMain: false`, which
 * reads as *proof of an unpublished submodule commit* and blocks the branch. In
 * that incident the commit was already on the submodule's `refs/heads/main`;
 * only the repo being probed lacked the object.
 *
 * So: resolve every ref FIRST. If any is missing → `'undeterminable'`, never
 * `false`. Only a clean exit-1 from a probe whose operands both exist is a real
 * "not an ancestor" — and that answer still blocks, exactly as before.
 */
export function probeGitAncestry(cwd: string, ancestor: string, descendant: string): GitAncestryProbe {
    try {
        if (!fs.existsSync(cwd)) return 'undeterminable';
    } catch {
        return 'undeterminable';
    }
    if (!gitRefsResolvable(cwd, [ancestor, descendant])) return 'undeterminable';
    try {
        execFileSync(GIT, ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, stdio: 'ignore', windowsHide: true });
        return true;
    } catch (e: any) {
        // Both operands resolved above, so exit 1 is git's real "no". Anything
        // else (signal, spawn failure, unexpected status) is not an answer.
        return e?.status === 1 ? false : 'undeterminable';
    }
}

export type SubmoduleGitlinkReachability = {
    path: string;
    baseCommit?: string;
    branchCommit?: string;
    fastForward?: boolean;
    reachableFromOriginMain?: boolean;
    undeterminable?: Array<'fastForward' | 'reachableFromOriginMain'>;
    probedRepo?: string;
};

/**
 * Fast-forward + origin/main reachability for ONE changed gitlink, as tri-state
 * evidence.
 *
 * ★`probeRoot` is the refine node's WORKTREE, not the base repo. `<base>/<path>`
 * and `<worktree>/<path>` are independent checkouts with separate object stores
 * and separate remote-tracking refs; the base mirror routinely lacks the
 * branch-side submodule commit and carries a stale `origin/main`. Probing it is
 * the 2026-08-22 false-block, where a commit already on the submodule's main was
 * reported unreachable.
 *
 * `baseRepoRoot` is still needed as the FETCH SOURCE: the base-side gitlink commit
 * may only exist in the base checkout, so — same discipline the gate body already
 * follows — {@link ensureSubmoduleCommitLocal} pulls both commits into the probed
 * store first, so a merely-absent object cannot degrade the probe.
 *
 * An unanswerable probe leaves its boolean UNDEFINED and records the probe name in
 * `undeterminable`; it is never reported as `false`.
 */
export function probeSubmoduleGitlinkReachability(input: {
    path: string;
    baseCommit?: string;
    branchCommit?: string;
    probeRoot: string;
    baseRepoRoot: string;
}): SubmoduleGitlinkReachability {
    const { path, baseCommit, branchCommit, probeRoot, baseRepoRoot } = input;
    const submoduleRepo = pathResolve(probeRoot, path);
    const baseSubmoduleRepo = pathResolve(baseRepoRoot, path);
    if (baseCommit) ensureSubmoduleCommitLocal(submoduleRepo, baseSubmoduleRepo, baseCommit);
    if (branchCommit) ensureSubmoduleCommitLocal(submoduleRepo, baseSubmoduleRepo, branchCommit);

    let fastForward: boolean | undefined;
    let reachableFromOriginMain: boolean | undefined;
    const undeterminable: Array<'fastForward' | 'reachableFromOriginMain'> = [];
    if (branchCommit) {
        if (baseCommit) {
            const ff = probeGitAncestry(submoduleRepo, baseCommit, branchCommit);
            if (ff === 'undeterminable') undeterminable.push('fastForward');
            else fastForward = ff;
        }
        const reach = probeGitAncestry(submoduleRepo, branchCommit, 'refs/remotes/origin/main');
        if (reach === 'undeterminable') undeterminable.push('reachableFromOriginMain');
        else reachableFromOriginMain = reach;
    }
    return {
        path, baseCommit, branchCommit, fastForward, reachableFromOriginMain,
        ...(undeterminable.length ? { undeterminable } : {}),
        probedRepo: submoduleRepo,
    };
}

/**
 * ★The loud warning text for an unanswerable submodule reachability probe, or
 * undefined when every probe was answered. Kept next to {@link probeGitAncestry}
 * because it exists to preserve that function's third state all the way to the
 * operator: this means "we could not judge", NOT "the commit is unpublished" and
 * NOT "nothing to converge". The 2026-08-22 false-block was exactly this signal
 * folded into a plain `reachableFromOriginMain: false`.
 */
export function buildSubmoduleReachabilityUndeterminableWarning(
    nodeId: string,
    evidence: {
        submoduleGitlinks?: Array<{ path: string; branchCommit?: string; probedRepo?: string; undeterminable?: string[] }>;
        submoduleReachabilityUndeterminable?: boolean;
    },
): string | undefined {
    if (!evidence.submoduleReachabilityUndeterminable) return undefined;
    const entries = (evidence.submoduleGitlinks || [])
        .filter(g => (g.undeterminable || []).includes('reachableFromOriginMain'))
        .map(g => `${g.path}@${(g.branchCommit || '?').slice(0, 12)} (probed: ${g.probedRepo || 'unknown'})`)
        .join(', ');
    return `[Refinery] Could NOT determine submodule gitlink reachability from submodule origin/main for node ${nodeId} — `
        + `probe had NO ANSWER (missing commit object and/or missing refs/remotes/origin/main in the probed repo). `
        + `"undeterminable", NOT "unpublished" and NOT "nothing to converge": ${entries}`;
}

/** {@link buildSubmoduleReachabilityUndeterminableWarning}, emitted via LOG.warn when it applies. */
export function warnRefineSubmoduleUndeterminable(nodeId: string, evidence: any): void {
    const message = buildSubmoduleReachabilityUndeterminableWarning(nodeId, evidence);
    if (message) LOG.warn('Mesh', message);
}

/** Whether `commit` is a commit object present in the submodule's local object store. */
export function submoduleCommitPresent(submoduleRepoPath: string, commit: string): boolean {
    if (!commit) return false;
    try {
        execFileSync(GIT, ['cat-file', '-e', `${commit}^{commit}`], { cwd: submoduleRepoPath, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Best-effort: ensure `commit` exists in the submodule repo at `submoduleRepoPath`
 * by fetching it from the base repo's submodule checkout (a sibling working copy on
 * the same machine) when it is missing. Returns true when the commit is present
 * afterwards. A no-op (true) when it is already present; false when the source path
 * does not exist or every fetch strategy failed. Never throws — the caller's
 * classification then reports `undeterminable` rather than claiming "not diverged".
 *
 * ★Three strategies, in order, because ONE refspec is not enough:
 *
 *   1. `+refs/heads/*` — cheap and portable, but structurally blind to the common
 *      case. A submodule checkout is normally on a **detached HEAD**, and the base
 *      workspace routinely has NO local branch pointing at the commit its root
 *      tree records. This refspec then cannot name the object at all, and the
 *      historical single-strategy implementation silently gave up here — the exact
 *      false-block this function was extended to fix. Detached HEAD is the normal
 *      state of a submodule checkout, not an edge case.
 *   2. `HEAD` + all refs (`refs/*`) — reaches the detached-HEAD commit itself plus
 *      anything under refs/ that `refs/heads/*` missed (tags, remote-tracking refs,
 *      other worktrees' refs). Covers the case above whenever the wanted commit is
 *      the base checkout's HEAD or is reachable from any of its refs.
 *   3. The exact SHA, with `uploadpack.allowAnySHA1InWant` forced on the SOURCE
 *      side via `--upload-pack`. Some gits refuse a bare-sha want without it; we
 *      set it for this one invocation rather than mutating the base repo's config.
 *      This is the last resort that works even when the object is reachable from
 *      nothing at all in the base repo (e.g. only from its index/reflog).
 *
 * Each strategy is tried only while the commit is still missing, so the common
 * (already-present / strategy-1-suffices) path costs no extra git spawns.
 */
export function ensureSubmoduleCommitLocal(submoduleRepoPath: string, baseSubmoduleRepoPath: string, commit: string): boolean {
    if (!commit) return false;
    const present = (): boolean => {
        try {
            execFileSync(GIT, ['cat-file', '-e', `${commit}^{commit}`], { cwd: submoduleRepoPath, stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    };
    if (present()) return true;
    try {
        if (!fs.existsSync(submoduleRepoPath) || !fs.existsSync(baseSubmoduleRepoPath)) return false;
    } catch {
        return false;
    }

    const strategies: string[][] = [
        // 1. All local branches (historical behaviour).
        ['fetch', '-q', baseSubmoduleRepoPath, '+refs/heads/*:refs/adhdev-refine-base/*'],
        // 2. The base checkout's detached HEAD plus every ref it has.
        ['fetch', '-q', baseSubmoduleRepoPath, 'HEAD', '+refs/*:refs/adhdev-refine-base-all/*'],
        // 3. The exact object, allowing a bare-sha want on the source side.
        ['fetch', '-q', '--upload-pack', 'git -c uploadpack.allowAnySHA1InWant=true upload-pack', baseSubmoduleRepoPath, commit],
    ];
    for (const args of strategies) {
        try {
            execFileSync(GIT, ['-c', 'protocol.file.allow=always', ...args], {
                cwd: submoduleRepoPath,
                stdio: ['ignore', 'ignore', 'pipe'],
            });
        } catch { /* try the next strategy */ }
        if (present()) return true;
    }
    return false;
}

/**
 * Per-path detail for the changed gitlinks inspected by the trivial-ff
 * evaluation. Lives here (rather than in mesh-refine-gates.ts) next to the
 * probes that populate it.
 */
export type GitlinkFastForwardDetail = {
    path: string;
    baseCommit?: string;
    branchCommit?: string;
    /**
     * True only when the ancestry probe ANSWERED yes. An unanswerable probe is
     * false here (it is not a proven fast-forward, so it must block) and is
     * additionally flagged via `fastForwardUndeterminable` — do not read
     * `fastForward: false` alone as "diverged".
     */
    fastForward: boolean;
    /**
     * Set when the fast-forward probe could not be answered at all (a gitlink
     * commit missing from the local submodule object store, or a missing
     * submodule checkout) — "we could not judge", NOT "these diverged".
     */
    fastForwardUndeterminable?: boolean;
};

/**
 * Check, inside a submodule repo, whether `baseCommit` is an ancestor of
 * `branchCommit` (i.e. advancing the gitlink from base→branch is a pure
 * fast-forward), as a THREE-state probe.
 *
 * ★This was the third recurrence of one class of defect (after
 * `isSubmoduleDivergedSibling` and `execGitOk`): a `cat-file -e` presence check
 * and a `merge-base --is-ancestor` answer sharing ONE `catch { return false }`.
 * git exits non-zero for two categorically different things — "no, not an
 * ancestor" (exit 1, both operands real) and "I could not look" (missing object,
 * missing checkout, spawn failure). Folding them together turns a merely-absent
 * object into a positive claim of divergence, which the trivial-ff evaluation
 * then reported as `diverged_gitlinks:<path>` — a statement about the history
 * that was never measured. It is fail-closed (nothing is wrongly merged) but it
 * MISDIAGNOSES: a coordinator reading "diverged" rebases a submodule that never
 * diverged, which is exactly the wasted work this class of fix exists to stop.
 *
 * So the presence check and the ancestry answer are separated: only a clean
 * exit-1 from a probe whose operands both resolve is a real `false`. Everything
 * else is `'undeterminable'`, and callers must keep blocking on it while
 * reporting it as "could not judge", never as "diverged". Delegates to
 * {@link probeGitAncestry}, the shared tri-state probe landed for `execGitOk`.
 */
export function probeSubmoduleFastForward(submoduleRepoPath: string, baseCommit: string, branchCommit: string): GitAncestryProbe {
    if (!baseCommit || !branchCommit) return 'undeterminable';
    if (baseCommit === branchCommit) return true;
    return probeGitAncestry(submoduleRepoPath, baseCommit, branchCommit);
}

/**
 * Two-state view of {@link probeSubmoduleFastForward} for call sites that only
 * need "is it safe to treat this gitlink as a proven fast-forward?". An
 * unanswerable probe is NOT a proven fast-forward, so it collapses to false —
 * identical to the historical behaviour, and deliberately conservative.
 *
 * ★Do NOT use this where the answer is reported to an operator as a *reason*.
 * There, use the tri-state probe so "undeterminable" stays distinguishable from
 * "diverged" — that distinction is the entire point of the tri-state.
 */
export function isSubmoduleFastForward(submoduleRepoPath: string, baseCommit: string, branchCommit: string): boolean {
    return probeSubmoduleFastForward(submoduleRepoPath, baseCommit, branchCommit) === true;
}

/**
 * ★The loud warning text for a gitlink whose fast-forward probe had NO ANSWER,
 * or undefined when every gitlink was judged. Sibling of
 * {@link buildSubmoduleReachabilityUndeterminableWarning}, and it exists for the
 * same reason: to carry the third state all the way to the operator instead of
 * letting it read as `diverged_gitlinks`. "We could not judge" is not "these
 * diverged" — the fix for the first is to fetch the missing object, the fix for
 * the second is to rebase, and telling them apart is what saves a wasted rebase.
 */
export function buildGitlinkFastForwardUndeterminableWarning(
    label: string,
    gitlinks: GitlinkFastForwardDetail[],
): string | undefined {
    const entries = gitlinks.filter(entry => entry.fastForwardUndeterminable);
    if (entries.length === 0) return undefined;
    const detail = entries
        .map(entry => `${entry.path} (base=${(entry.baseCommit || '?').slice(0, 12)} branch=${(entry.branchCommit || '?').slice(0, 12)})`)
        .join(', ');
    return `[Refinery] Could NOT determine submodule gitlink fast-forward for ${label} — `
        + `ancestry probe had NO ANSWER (a gitlink commit is missing from the local submodule object store, `
        + `or the submodule checkout is absent). "undeterminable", NOT "diverged": ${detail}`;
}

/** {@link buildGitlinkFastForwardUndeterminableWarning}, emitted via LOG.warn when it applies. */
export function warnGitlinkFastForwardUndeterminable(
    label: string,
    gitlinks: GitlinkFastForwardDetail[],
): void {
    const message = buildGitlinkFastForwardUndeterminableWarning(label, gitlinks);
    if (message) LOG.warn('Mesh', message);
}

/**
 * Outcome of the trivial-gitlink-fast-forward evaluation (implemented in
 * mesh-refine-gates.ts; the type lives here beside the probes that populate it).
 */
export type GitlinkTrivialFastForwardEvaluation = {
    /** True only when the merge-tree conflict is *fully* explained by trivial-ff gitlinks. */
    trivial: boolean;
    /**
     * Why the evaluation declined to treat the conflict as trivial (set when
     * trivial=false). ★`diverged_gitlinks:` and `undeterminable_gitlinks:` are
     * DIFFERENT claims — measured divergence vs no answer — and must stay
     * distinguishable here; that distinction is what avoids a wasted rebase.
     */
    reason?: string;
    /** Per-path detail for the changed gitlinks that were inspected. */
    gitlinks: GitlinkFastForwardDetail[];
};

/**
 * Read the set of paths that differ between two refs, tagging whether each is a
 * gitlink (submodule, mode 160000) on either side. Returns one entry per
 * changed path. Empty on error.
 */
export function readChangedPathKinds(repoRoot: string, fromRef: string, toRef: string): Array<{ path: string; isGitlink: boolean }> {
    try {
        const output = execFileSync(GIT, ['diff', '--raw', '--no-abbrev', fromRef, toRef], {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
        });
        const result: Array<{ path: string; isGitlink: boolean }> = [];
        const seen = new Set<string>();
        for (const line of output.split('\n')) {
            if (!line.trim()) continue;
            const metaAndPath = line.split('\t');
            const meta = metaAndPath[0] || '';
            const path = metaAndPath[metaAndPath.length - 1]?.trim();
            if (!path || seen.has(path)) continue;
            seen.add(path);
            const parts = meta.split(/\s+/);
            const isGitlink = !!(parts[0]?.includes('160000') || parts[1]?.includes('160000'));
            result.push({ path, isGitlink });
        }
        return result;
    } catch {
        return [];
    }
}

/**
 * Tri-state result of "is this commit contained in the remote's default branch?".
 *
 * `absent` means git ANSWERED no. `undeterminable` means we never got an answer.
 * Collapsing the two is the 2026-08-23 false-publish: see
 * {@link verifyRemoteBranchContainsCommit}.
 */
export type RemoteContainmentState = 'contained' | 'absent' | 'undeterminable';

export type RemoteContainmentVerdict =
    | { state: 'contained' }
    | { state: 'absent' | 'undeterminable'; error: any };

/**
 * Fetch the remote branch, then ask whether `commit` is an ancestor of it — as a
 * THREE-state verdict.
 *
 * ★The two-state predecessor (inline in `runMeshRefineSubmoduleReachabilityGate`)
 * is the 2026-08-23 false-publish. It ran `fetch origin` and `merge-base
 * --is-ancestor` under ONE shared `catch`, so every failure of EITHER collapsed
 * to the same value. The caller read that value as "the commit is not on
 * origin/main": it set `publishRequired: true` and, when
 * `allowAutoPublishSubmoduleMainCommits` was enabled, performed a real `git
 * push`. A failed fetch — offline, auth rejected, remote deleted, DNS, timeout —
 * was therefore indistinguishable from a genuine "not published", and could
 * publish a commit on evidence that was never obtained. The in-code comment even
 * asserted "Only the ancestry-only verdict reaches here", which the shared catch
 * made false.
 *
 * So the fetch is judged FIRST and separately, and both ancestry operands are
 * resolved before the comparison — same discipline as {@link probeGitAncestry}.
 * When we do not know, the answer is `'undeterminable'` and the safe default is
 * to NOT push. Only a successful fetch followed by a clean exit-1 from
 * `--is-ancestor` is a real "no", and that still blocks and still prescribes a
 * publish, exactly as before.
 *
 * `runGit` is injected so the caller keeps its own exec policy (timeouts,
 * maxBuffer, windowsHide) rather than this module imposing one.
 */
export async function verifyRemoteBranchContainsCommit(
    runGit: (cwd: string, args: string[]) => Promise<string>,
    submodulePath: string,
    commit: string,
    branch = 'main',
): Promise<RemoteContainmentVerdict> {
    try {
        await runGit(submodulePath, ['-c', 'protocol.file.allow=always', 'fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    } catch (fetchError: any) {
        // The remote was never consulted — no ancestry verdict exists.
        return { state: 'undeterminable', error: fetchError };
    }
    const remoteRef = `refs/remotes/origin/${branch}`;
    // ★The REMOTE ref must resolve. If `refs/remotes/origin/<branch>` does not
    // exist even after a successful fetch (branch absent on the remote, refspec
    // wrote nothing), there is no set to test membership in — `--is-ancestor`
    // would fail for a reason that is not "not an ancestor". Undeterminable.
    try {
        await runGit(submodulePath, ['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`]);
    } catch (resolveError: any) {
        return { state: 'undeterminable', error: resolveError };
    }
    // ★The CANDIDATE commit is checked separately, and its absence is a
    // DETERMINATE 'absent' — not undeterminable. The gate probes the base
    // checkout, whose object store legitimately lacks a commit that lives only
    // in the node's worktree or only on a remote feature branch. We just
    // fetched origin/<branch>; if the object is still not here, it is
    // demonstrably not in origin/<branch> either — which is exactly the
    // publish-required verdict this gate exists to produce. Reporting it as
    // "we could not tell" would over-correct the fetch fix into a fail-open
    // hole. Pinned by mesh-refine-validation.test.ts "does not treat submodule
    // feature-branch reachability as remote main convergence".
    //
    // It must be a separate probe because `merge-base --is-ancestor` exits 128
    // (fatal: not a valid object) for a missing candidate, which is
    // indistinguishable by exit code from a genuine spawn/environment failure.
    try {
        await runGit(submodulePath, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
    } catch (missingCandidate: any) {
        return { state: 'absent', error: missingCandidate };
    }
    try {
        await runGit(submodulePath, ['merge-base', '--is-ancestor', commit, remoteRef]);
        return { state: 'contained' };
    } catch (ancestryError: any) {
        // Both operands resolved above, so exit 1 is git's real "no". Anything
        // else (signal, spawn failure) is not an answer.
        return ancestryError?.code === 1
            ? { state: 'absent', error: ancestryError }
            : { state: 'undeterminable', error: ancestryError };
    }
}

/** Outcome of one Refinery stage. Moved here with the reachability shapes
 *  that reference it (pure move); re-exported by mesh-refine-gates.ts. */
export type MeshRefineStageStatus = 'passed' | 'failed' | 'skipped';

/* ── submodule reachability: result shapes + operator prose ──────────────────
 * Moved here (pure move) from mesh-refine-gates.ts alongside
 * verifyRemoteBranchContainsCommit, which produces the verdicts these shapes
 * carry. Both were previously module-private types in the gates file; they are
 * exported now that they live in the shared module, and mesh-refine-gates.ts
 * re-exports them via its `export *` barrel, so every existing import path
 * keeps working unchanged.
 */

export type MeshRefineSubmoduleReachabilityEntry = {
    path: string;
    commit: string;
    reachable: boolean;
    publishRequired?: boolean;
    /**
     * Gap #2 (parallel-refine twin): set when the gitlink commit is NOT reachable
     * from origin/<default> but a commit with an IDENTICAL tree already is — a
     * sibling job published the same content under a different SHA. Publishing
     * this commit would mint duplicate history; the remedy is to converge the
     * gitlink to this published commit, so `publishRequired` is false.
     */
    equivalentPublishedCommit?: string;
    autoPublishAllowed?: boolean;
    autoPublishAttempted?: boolean;
    autoPublishSucceeded?: boolean;
    autoPublishVerified?: boolean;
    autoPublishRefspec?: string;
    autoPublishSkippedReason?: string;
    importedFromWorktree?: boolean;
    checkedLocal?: boolean;
    localReachable?: boolean;
    remote?: string;
    remoteUrl?: string;
    remoteReachable?: boolean;
    remoteMainBranch?: string;
    remoteMainReachable?: boolean;
    /**
     * ★Set when remote-main containment COULD NOT BE JUDGED — the `fetch` failed
     * (offline / auth / remote gone / timeout) or an operand did not resolve, so
     * the remote was never actually consulted. Distinct from
     * `remoteMainReachable: false`, which means git answered "not an ancestor".
     * An undetermined verdict is NOT evidence the commit is unpublished, so it
     * never sets `publishRequired` and never permits the auto-publish push;
     * `remoteMainReachable` is left UNDEFINED rather than false.
     */
    remoteMainUndeterminable?: boolean;
    fetchedFromOrigin?: boolean;
    error?: string;
    publishStdout?: string;
    publishStderr?: string;
};

export type MeshRefineSubmoduleReachabilitySummary = {
    status: MeshRefineStageStatus;
    checked: number;
    unreachable: MeshRefineSubmoduleReachabilityEntry[];
    entries: MeshRefineSubmoduleReachabilityEntry[];
    durationMs: number;
    autoPublishAllowed?: boolean;
    autoPublishPolicySource?: string;
    error?: string;
};

export function buildSubmodulePublishRequiredNextStep(entries: MeshRefineSubmoduleReachabilityEntry[]): string {
    // ★An undetermined remote-main probe is NOT a publish candidate: we never
    // consulted the remote, so "push this commit" is a prescription written from
    // absent evidence. It gets its own instruction — fix the remote access and
    // re-run — and is excluded from the approve-a-push list below.
    const undeterminable = entries.filter(entry => entry.remoteMainUndeterminable);
    const decided = entries.filter(entry => !entry.remoteMainUndeterminable);
    const convergeable = decided.filter(entry => entry.equivalentPublishedCommit);
    const publishable = decided.filter(entry => !entry.equivalentPublishedCommit);
    const parts: string[] = [];
    if (undeterminable.length > 0) {
        const refs = undeterminable
            .map(entry => `${entry.path}@${entry.commit}`)
            .join(', ');
        parts.push(`Submodule remote main containment could not be determined for (${refs}) — the submodule remote was not successfully consulted (network, auth, or a missing remote). This is NOT evidence that the commit is unpublished, so do not push it: restore access to the submodule remote and rerun mesh_refine_node to obtain a real verdict.`);
    }
    if (convergeable.length > 0) {
        const refs = convergeable
            .map(entry => `${entry.path}: ${entry.commit} → ${entry.equivalentPublishedCommit}`)
            .join(', ');
        parts.push(`Converge the submodule gitlink(s) to the already-published equivalent commit(s) (${refs}): a commit with an identical tree already exists on the submodule remote main branch, so publishing the local same-content twin is wrong. Retarget the gitlink to the published commit, commit the root pointer update, then rerun mesh_refine_node.`);
    }
    if (publishable.length > 0) {
        const refs = publishable
            .map(entry => `${entry.path}@${entry.commit}`)
            .join(', ');
        parts.push(`Ask the user for explicit approval to push/publish the unreachable submodule commit(s) (${refs}) to the configured submodule remote main branch, then rerun mesh_refine_node.`);
    }
    parts.push('Do not merge the root branch until every submodule gitlink commit is reachable from submodule origin/main.');
    return parts.join(' ');
}
