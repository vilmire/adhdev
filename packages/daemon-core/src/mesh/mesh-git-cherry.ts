/**
 * `git cherry` as a read-only probe, for the case where a change landed on a base
 * under a DIFFERENT commit id (cherry-pick / rebase): cherry marks each commit of
 * `base..head` with `-` when an equivalent patch (same `patch-id`) exists in
 * `head..base`, `+` when none does.
 *
 * Kept out of mesh-refine-gitlink-utils.ts (at its size budget). Same discipline as
 * probeGitAncestry: unresolvable operands / spawn failures are `'undeterminable'`,
 * never a "no".
 */
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import { gitChildEnv, GIT_LOCAL_TIMEOUT_MS } from '../git/git-locale.js';
import { GIT } from './mesh-refine-gitlink-utils.js';

const realGitEnv = () => ({ ...gitChildEnv(), GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull });

function git(cwd: string, args: string[]): string {
    return execFileSync(GIT, ['--no-replace-objects', ...args], {
        cwd, encoding: 'utf8', timeout: GIT_LOCAL_TIMEOUT_MS, windowsHide: true, env: realGitEnv(), stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024,
    });
}

export interface GitCherryCounts {
    /** Commits of `base..head` that have an equivalent patch in the base (`-`). */
    equivalent: number;
    /** Commits of `base..head` with no equivalent patch in the base (`+`). */
    notEquivalent: number;
}

/** Counts of `git cherry <base> <head> [<limit>]`, or `'undeterminable'`. */
export function gitCherryCounts(cwd: string, base: string, head: string, limit?: string): GitCherryCounts | 'undeterminable' {
    try {
        const out = git(cwd, ['cherry', base, head, ...(limit ? [limit] : [])]);
        let equivalent = 0;
        let notEquivalent = 0;
        for (const line of out.split('\n')) {
            if (line.startsWith('- ')) equivalent++;
            else if (line.startsWith('+ ')) notEquivalent++;
        }
        return { equivalent, notEquivalent };
    } catch {
        return 'undeterminable';
    }
}

/**
 * Whether the single commit `sha` has an equivalent patch in `base` (cherry-picked
 * there under another id). Three states: `true` (`-`), `false` (`+`), and
 * `'undeterminable'` for a root commit, a merge commit (no single patch), an empty
 * answer or any git failure.
 */
export function probeGitCherry(cwd: string, base: string, sha: string): true | false | 'undeterminable' {
    let parents: string[];
    try {
        parents = git(cwd, ['rev-list', '--parents', '-n', '1', sha]).trim().split(/\s+/).slice(1);
    } catch {
        return 'undeterminable';
    }
    if (parents.length !== 1) return 'undeterminable';
    const counts = gitCherryCounts(cwd, base, sha, parents[0]);
    if (counts === 'undeterminable') return 'undeterminable';
    if (counts.equivalent === 1 && counts.notEquivalent === 0) return true;
    if (counts.notEquivalent === 1 && counts.equivalent === 0) return false;
    return 'undeterminable';
}
