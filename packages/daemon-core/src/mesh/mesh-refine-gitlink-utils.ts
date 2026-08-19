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
