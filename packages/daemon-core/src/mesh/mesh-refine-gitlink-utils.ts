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
