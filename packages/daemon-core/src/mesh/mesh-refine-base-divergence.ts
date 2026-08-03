/**
 * Accept-time base-divergence pre-check (Refinery serialization ⓪).
 *
 * When several refine jobs run in parallel, the first one to merge advances
 * origin/<base>. Every sibling that pinned its `baseHead` before that merge then
 * validates and patch-equivalence-checks against a base that no longer exists,
 * and fails late with `patch_equivalence_failed` / `base_moved` — after having
 * paid for a full validation run.
 *
 * This module answers, at ACCEPT time, the cheap mechanical question:
 *
 *     is the live origin/<base> head still an ancestor of this branch's base?
 *
 * i.e. "has the base moved out from under this branch since it was created?".
 * The answer is recorded on the job handle as a signal a later serialization
 * queue can gate on. It deliberately does NOT delay or block acceptance today:
 * with no queue to park a job in, the only honest thing to do is record and
 * proceed exactly as before.
 *
 * Three outcomes, mirroring the three ways the question can resolve:
 *   - `clear`     — base is an ancestor of the branch's merge base: no divergence,
 *                   the job proceeds exactly as it does today.
 *   - `diverged`  — base advanced past the branch's merge base: recorded, and the
 *                   job still proceeds (the pipeline's sync_base stage rebases it).
 *   - `unknown`   — the check could not run (git error, no remote, missing ref).
 *                   FAIL-CLOSED: recorded as un-judgeable, never silently reported
 *                   as `clear`, so a future queue treats it as "must serialize"
 *                   rather than "safe to parallelize".
 *
 * Submodule scoping: the check runs per submodule the branch actually TOUCHES
 * (via {@link analyzeMeshRefineNodeChangeArea}'s `touchedSubmodulePaths`), plus
 * the root repo. A branch that only bumps `oss` is never judged against
 * `adhdev-providers` — in the incident this was built for, `adhdev-providers`
 * had not diverged at all and rebasing it would have been pure waste.
 *
 * Cost: bounded, and measured — one `git config --file .gitmodules` +
 * one `git diff --name-only` for the change area, then two `rev-parse` +
 * one `merge-base --is-ancestor` per touched scope. No fetch, no checkout, no
 * network. See `refine-accept-base-divergence.test.ts` for the latency assertion.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve as pathResolve } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveWin32Executable } from '../cli-adapters/resolve-executable.js';
import { analyzeMeshRefineNodeChangeArea } from './mesh-refine-batch.js';

const execFileAsync = promisify(execFile);

// Same win32 resolution rationale as mesh-refine-batch.ts: a bare `git` handed to
// execFile is resolved by libuv's spawn search (no PATHEXT), which misses git.cmd.
const GIT = process.platform === 'win32' ? resolveWin32Executable('git') : 'git';

/** Per-scope verdict. `unknown` is the fail-closed bucket — never conflated with `clear`. */
export type RefineBaseDivergenceVerdict = 'clear' | 'diverged' | 'unknown';

export type RefineBaseDivergenceScope = {
    /** '.' for the root repo, otherwise the submodule path as declared in .gitmodules. */
    path: string;
    verdict: RefineBaseDivergenceVerdict;
    /** Live head of the base ref at accept time (when resolvable). */
    liveBaseHead?: string;
    /** Merge base of the live base ref and the branch (when resolvable). */
    mergeBase?: string;
    /** Why the verdict is `unknown` (fail-closed diagnostics). */
    error?: string;
};

export type RefineBaseDivergenceAssessment = {
    /**
     * Overall verdict across every checked scope:
     *   diverged — at least one scope diverged
     *   unknown  — no scope diverged but at least one was un-judgeable (fail-closed)
     *   clear    — every checked scope is clear
     */
    verdict: RefineBaseDivergenceVerdict;
    /** Per-scope detail; the root repo is always present as '.'. */
    scopes: RefineBaseDivergenceScope[];
    /** Submodule paths the branch actually touches (the scoping decision, for transparency). */
    touchedSubmodulePaths: string[];
    /** Wall-clock cost of the whole assessment — asserted in tests to keep accept latency ~0. */
    durationMs: number;
};

/** Run a git command, returning trimmed stdout; throws on non-zero exit. */
async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(GIT, args, {
        cwd,
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
    });
    return String(stdout || '').trim();
}

/** `merge-base --is-ancestor` as a boolean; a non-zero exit means "not an ancestor". */
async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
        await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
    } catch {
        return false;
    }
}

/**
 * Judge one repo (root or submodule): has `baseRef` advanced past the point the
 * branch forked from? Uses only local refs — no fetch — so the check stays cheap
 * and side-effect free at accept time.
 *
 * `clear` requires a POSITIVE ancestry proof: the live base head must be an
 * ancestor of the branch head. Anything we cannot prove is `unknown`, never
 * `clear`.
 */
async function assessScope(cwd: string, path: string, baseRef: string, branchRef: string): Promise<RefineBaseDivergenceScope> {
    try {
        if (!existsSync(cwd)) return { path, verdict: 'unknown', error: `path does not exist: ${cwd}` };
        const liveBaseHead = await git(cwd, ['rev-parse', baseRef]);
        const branchHead = await git(cwd, ['rev-parse', branchRef]);
        if (!liveBaseHead || !branchHead) {
            return { path, verdict: 'unknown', error: 'could not resolve base or branch head' };
        }
        // The live base head is already contained in the branch → the branch was cut
        // from (or has since absorbed) the current base. Nothing moved under it.
        if (await isAncestor(cwd, liveBaseHead, branchHead)) {
            return { path, verdict: 'clear', liveBaseHead };
        }
        // Base is NOT contained in the branch. If they still share a merge base, the
        // base advanced past the fork point — the divergence this check exists for.
        let mergeBase: string | undefined;
        try {
            mergeBase = await git(cwd, ['merge-base', liveBaseHead, branchHead]);
        } catch {
            // No shared history at all (unrelated roots) — un-judgeable, not "clear".
            return { path, verdict: 'unknown', liveBaseHead, error: 'no common merge base' };
        }
        if (!mergeBase) return { path, verdict: 'unknown', liveBaseHead, error: 'empty merge base' };
        return { path, verdict: 'diverged', liveBaseHead, mergeBase };
    } catch (e: any) {
        // FAIL-CLOSED: any git failure is recorded as un-judgeable, never as clear.
        return { path, verdict: 'unknown', error: e?.message || String(e) };
    }
}

/** Resolve declared submodule paths from .gitmodules (dynamic — nothing hardcoded). */
async function resolveSubmodulePaths(repoRoot: string): Promise<Set<string>> {
    try {
        const stdout = await git(repoRoot, ['config', '--file', '.gitmodules', '--get-regexp', 'path']);
        const paths = new Set<string>();
        for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            const spaceIdx = trimmed.indexOf(' ');
            if (spaceIdx === -1) continue;
            const value = trimmed.slice(spaceIdx + 1).trim();
            if (value) paths.add(value);
        }
        return paths;
    } catch {
        return new Set();
    }
}

/**
 * Assess whether the base has diverged out from under a branch, scoped to the
 * submodules the branch actually touches.
 *
 * Never throws: every failure path degrades to an `unknown` verdict, because this
 * runs on the accept path and must not be able to reject a refine.
 */
export async function assessRefineBaseDivergence(args: {
    /** The base repo root (source node) — where origin/<base> lives. */
    repoRoot: string;
    /** The worktree whose branch is being refined. */
    workspace: string;
    /** Base branch name, e.g. 'main'. */
    baseBranch: string;
    /** Branch name in the worktree. */
    branch: string;
}): Promise<RefineBaseDivergenceAssessment> {
    const started = Date.now();
    const { repoRoot, workspace, baseBranch, branch } = args;
    const scopes: RefineBaseDivergenceScope[] = [];
    let touchedSubmodulePaths: string[] = [];

    // Prefer origin/<base> (the shared truth other refines push to); fall back to the
    // local base branch when there is no remote-tracking ref.
    const rootBaseRef = await (async () => {
        for (const ref of [`origin/${baseBranch}`, baseBranch, 'HEAD']) {
            try {
                await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
                return ref;
            } catch { /* try the next candidate */ }
        }
        return `origin/${baseBranch}`; // assessScope will record `unknown`
    })();

    // Root repo is always judged.
    scopes.push(await assessScope(workspace, '.', rootBaseRef, branch));

    // Scope submodule checks to what the branch actually touches. Any failure here
    // leaves touchedSubmodulePaths empty → only the root is judged, which is a
    // strictly narrower (never wrong-direction) claim.
    try {
        const submodulePaths = await resolveSubmodulePaths(repoRoot);
        if (submodulePaths.size > 0) {
            const baseRefSha = await git(repoRoot, ['rev-parse', rootBaseRef]).catch(() => '');
            const branchRefSha = await git(workspace, ['rev-parse', branch]).catch(() => '');
            if (baseRefSha && branchRefSha) {
                const area = await analyzeMeshRefineNodeChangeArea({
                    nodeId: '(accept-precheck)',
                    workspace,
                    branch,
                    baseRef: baseRefSha,
                    branchRef: branchRefSha,
                    diffCwd: workspace,
                    submodulePaths,
                });
                touchedSubmodulePaths = area.touchedSubmodulePaths;
                for (const subPath of touchedSubmodulePaths) {
                    const subCwd = pathResolve(workspace, subPath);
                    // Inside a submodule the base side is its own origin/<default>; the
                    // branch side is whatever the worktree has checked out (HEAD).
                    const subBaseRef = await (async () => {
                        for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
                            try {
                                await git(subCwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
                                return ref;
                            } catch { /* next */ }
                        }
                        return 'origin/main';
                    })();
                    scopes.push(await assessScope(subCwd, subPath, subBaseRef, 'HEAD'));
                }
            }
        }
    } catch { /* root-only assessment stands */ }

    const verdict: RefineBaseDivergenceVerdict = scopes.some(s => s.verdict === 'diverged')
        ? 'diverged'
        : scopes.some(s => s.verdict === 'unknown')
            ? 'unknown'
            : 'clear';

    return { verdict, scopes, touchedSubmodulePaths, durationMs: Date.now() - started };
}
