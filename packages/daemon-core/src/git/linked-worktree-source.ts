/**
 * Resolve the source repository of a linked git worktree from the worktree's OWN
 * git metadata (not from mesh membership). Used as a fallback when the parent
 * (source) node of a worktree node is gone, so removal can still run against the
 * repository that really owns the worktree.
 *
 * Every check must pass or the result is a refusal — callers must never delete a
 * directory for which this returns ok:false:
 *   1. `git rev-parse --show-toplevel` of the path is the path itself (not a
 *      subdirectory of some unrelated checkout);
 *   2. git-dir != git-common-dir (it is a LINKED worktree, not a main checkout);
 *   3. git-dir lives directly under `<commonDir>/worktrees/`;
 *   4. the back-link `<gitDir>/gitdir` points at `<path>/.git`;
 *   5. the candidate repo root reports the same git-common-dir (commondir match).
 */
import * as fs from 'fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, resolve as pathResolve } from 'path';
import { gitChildEnv } from './git-locale.js';

const execFileAsync = promisify(execFile);

export type LinkedWorktreeSource =
    | { ok: true; repoRoot: string; commonDir: string }
    | { ok: false; reason: string };

function real(p: string): string {
    const resolved = pathResolve(p);
    try { return fs.realpathSync(resolved); } catch { return resolved; }
}

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
        cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true, env: gitChildEnv(),
    });
    return String(stdout).trim();
}

export async function resolveLinkedWorktreeSource(worktreePath: string): Promise<LinkedWorktreeSource> {
    try {
        if (!fs.existsSync(worktreePath)) return { ok: false, reason: 'worktree_path_missing' };
        const lines = (await git(worktreePath, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir']))
            .split(/\r?\n/).map(l => l.trim());
        if (lines.length < 3 || !lines[0] || !lines[1] || !lines[2]) return { ok: false, reason: 'rev_parse_unexpected_output' };
        const toplevel = real(lines[0]);
        const gitDir = real(pathResolve(worktreePath, lines[1]));
        const commonDir = real(pathResolve(worktreePath, lines[2]));
        if (toplevel !== real(worktreePath)) return { ok: false, reason: 'not_worktree_toplevel' };
        if (gitDir === commonDir) return { ok: false, reason: 'not_linked_worktree' };
        if (real(dirname(gitDir)) !== real(pathResolve(commonDir, 'worktrees'))) return { ok: false, reason: 'gitdir_not_under_common_worktrees' };
        let backLink: string;
        try { backLink = fs.readFileSync(pathResolve(gitDir, 'gitdir'), 'utf8').trim(); } catch { return { ok: false, reason: 'backlink_unreadable' }; }
        if (!backLink || real(dirname(backLink)) !== real(worktreePath)) return { ok: false, reason: 'backlink_mismatch' };
        const repoRoot = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
        if (!fs.existsSync(repoRoot)) return { ok: false, reason: 'source_repo_missing' };
        const repoCommon = real(pathResolve(repoRoot, await git(repoRoot, ['rev-parse', '--git-common-dir'])));
        if (repoCommon !== commonDir) return { ok: false, reason: 'commondir_mismatch' };
        return { ok: true, repoRoot, commonDir };
    } catch (err) {
        return { ok: false, reason: `git_failed:${err instanceof Error ? err.message.split('\n')[0] : String(err)}` };
    }
}
