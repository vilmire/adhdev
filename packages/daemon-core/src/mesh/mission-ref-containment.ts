/**
 * Per-repository containment probe for mission refs (design 2026-11-01-mission-git-refs §3.2).
 *
 * Answers, for commits living in ONE local repository, "is this change already on the
 * base?" using only git object facts:
 *   1. `merge-base --is-ancestor`            → contained_ancestor
 *   2. `git cherry` (single commits)         → contained_patch_equivalent / cherry
 *   3. merge-tree + `patch-id` residual      → contained_patch_equivalent / residual_patch
 * Anything that cannot be answered (missing object, shallow clone, git failure, an
 * unresolvable submodule gitlink) is `unknown` — NEVER `not_contained`, and never
 * promoted to `contained`. Read-only: no ref, index or working-tree write (merge-tree
 * --write-tree writes unreferenced objects exactly as the Refinery gate does).
 *
 * Shared by the host evaluator and the `mesh_ref_containment_probe` command a member
 * node answers; this file imports no mission store and no mission write API.
 */
import { execFileSync } from 'node:child_process';
import { hiddenExecFileAsync } from '../process/hidden-spawn.js';
import { devNull } from 'node:os';
import type { MissionRefGitDetail, MissionRefGitMethod, MissionRefGitStatus } from '@adhdev/mesh-shared';
import { gitChildEnv, GIT_LOCAL_TIMEOUT_MS } from '../git/git-locale.js';
import { GIT, probeGitAncestry } from './mesh-refine-gitlink-utils.js';
import { checkWorktreeChangesPatchEquivalentInRef } from './mesh-refine-patch-equivalence.js';
import { gitCherryCounts, probeGitCherry } from './mesh-git-cherry.js';

const realGitEnv = () => ({ ...gitChildEnv(), GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull });

function git(cwd: string, args: string[]): string {
    return execFileSync(GIT, ['--no-replace-objects', ...args], {
        cwd, encoding: 'utf8', timeout: GIT_LOCAL_TIMEOUT_MS, windowsHide: true, env: realGitEnv(), stdio: ['ignore', 'pipe', 'ignore'],
    });
}

export interface ContainmentVerdict {
    status: MissionRefGitStatus;
    method?: MissionRefGitMethod;
    detail?: MissionRefGitDetail;
}

export interface ResolvedBase {
    /** Logical name stored with the verdict (`origin/main`, or `main` when only a local branch exists). */
    name: string;
    /** The ref git is asked about. */
    ref: string;
    sha: string;
}

/** The default branch's remote-tracking ref (preferred), else the local branch. `undefined` when neither resolves. */
export function resolveBase(repo: string, defaultBranch: string): ResolvedBase | undefined {
    const candidates = [
        { name: `origin/${defaultBranch}`, ref: `refs/remotes/origin/${defaultBranch}` },
        { name: defaultBranch, ref: `refs/heads/${defaultBranch}` },
    ];
    for (const c of candidates) {
        try {
            const sha = git(repo, ['rev-parse', '--verify', '--quiet', `${c.ref}^{commit}`]).trim();
            if (sha) return { ...c, sha };
        } catch { /* try the next candidate */ }
    }
    return undefined;
}

/** Full SHA of `rev` when it names a commit present in `repo`. */
export function resolveCommit(repo: string, rev: string): string | undefined {
    // Never let a ref value be read as a git option.
    if (!rev || rev.startsWith('-')) return undefined;
    try {
        const sha = git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).trim();
        return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
    } catch {
        return undefined;
    }
}

/** A branch name → SHA, preferring the remote-tracking ref (the pushed state), else the local branch. */
export function resolveBranchSha(repo: string, branch: string): string | undefined {
    const name = branch.replace(/^refs\/(heads|remotes)\//, '').replace(/^origin\//, '');
    return resolveCommit(repo, `refs/remotes/origin/${name}`) ?? resolveCommit(repo, `refs/heads/${name}`);
}

function isShallow(repo: string): boolean {
    try {
        return git(repo, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
    } catch {
        return false;
    }
}

/**
 * `git merge-tree --write-tree` exit 1 == content conflict (main touched the same lines); any other failure is not an answer.
 * Async so a large merge never blocks the daemon event loop (an exec error carries the exit code as `code`).
 */
async function mergeTreeConflicts(repo: string, base: string, sha: string): Promise<boolean> {
    try {
        await hiddenExecFileAsync(GIT, ['--no-replace-objects', 'merge-tree', '--write-tree', base, sha], {
            cwd: repo, timeout: GIT_LOCAL_TIMEOUT_MS, env: realGitEnv(), encoding: 'utf8',
        });
        return false;
    } catch (e: any) {
        return e?.code === 1;
    }
}

/** Short-lived memo of containment verdicts so repeated mission audits of the same commit skip the heavy git work. */
const CONTAINMENT_MEMO_TTL_MS = 10 * 60_000;
const CONTAINMENT_MEMO_MAX = 500;
const containmentMemo = new Map<string, { expiresAt: number; verdict: ContainmentVerdict & { sha?: string } }>();
const containmentInflight = new Map<string, Promise<ContainmentVerdict & { sha?: string }>>();

function rememberContainment(key: string, verdict: ContainmentVerdict & { sha?: string }): void {
    containmentMemo.delete(key);
    containmentMemo.set(key, { expiresAt: Date.now() + CONTAINMENT_MEMO_TTL_MS, verdict });
    while (containmentMemo.size > CONTAINMENT_MEMO_MAX) {
        const oldest = containmentMemo.keys().next().value;
        if (oldest === undefined) break;
        containmentMemo.delete(oldest);
    }
}

/** Test hook: forget every remembered verdict. */
export function clearContainmentMemo(): void { containmentMemo.clear(); containmentInflight.clear(); }

const unknown = (unknownReason: string): ContainmentVerdict => ({ status: 'unknown', detail: { unknownReason } });

/**
 * Verdict for one commit that is (maybe) present in `repo`, against `base`.
 * `tryCherry` is true for plain commit refs (a single patch); branch tips go straight
 * to the residual-patch comparison, which covers multi-commit rebase/squash landings.
 */
export async function probeCommitContainment(repo: string, base: ResolvedBase, rev: string, opts: { tryCherry: boolean }): Promise<ContainmentVerdict & { sha?: string }> {
    const sha = resolveCommit(repo, rev);
    if (!sha) return unknown('object_missing');
    // Verdicts are pure functions of (repo, base SHA, commit SHA, cherry mode): a moved ref changes the key.
    const key = `${repo}\0${base.sha}\0${sha}\0${opts.tryCherry ? 1 : 0}`;
    const hit = containmentMemo.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.verdict;
    const running = containmentInflight.get(key);
    if (running) return running;
    const task = computeContainment(repo, base, sha, opts).then((verdict) => {
        // `unknown` is often transient (timeout, unfetched object): never remember a non-answer.
        if (verdict.status !== 'unknown') rememberContainment(key, verdict);
        return verdict;
    }).finally(() => { containmentInflight.delete(key); });
    containmentInflight.set(key, task);
    return task;
}

async function computeContainment(repo: string, base: ResolvedBase, sha: string, opts: { tryCherry: boolean }): Promise<ContainmentVerdict & { sha?: string }> {

    const ancestry = probeGitAncestry(repo, sha, base.ref);
    if (ancestry === 'undeterminable') return { sha, ...unknown('undeterminable') };
    if (ancestry === true) return { sha, status: 'contained_ancestor', method: 'ancestry' };

    // "Not an ancestor" is only an answer in a repository that holds the whole history.
    if (isShallow(repo)) return { sha, ...unknown('shallow') };

    if (opts.tryCherry && probeGitCherry(repo, base.ref, sha) === true) {
        return { sha, status: 'contained_patch_equivalent', method: 'cherry' };
    }

    const residual = await checkWorktreeChangesPatchEquivalentInRef(repo, base.ref, sha);
    if (residual.contained) return { sha, status: 'contained_patch_equivalent', method: 'residual_patch' };

    if (residual.error) {
        if (/submodule conflict/i.test(residual.error)) return { sha, ...unknown('gitlink_undeterminable') };
        // A content conflict means the base touched the same lines: the change is not there as-is.
        if (await mergeTreeConflicts(repo, base.ref, sha)) {
            return { sha, status: 'not_contained', detail: { reasonCode: 'merge_conflict', note: 'modified_since_landing_possible' } };
        }
        return { sha, ...unknown('merge_tree_failed') };
    }

    // A non-empty residual patch: confirmed not (fully) on the base.
    const detail: MissionRefGitDetail = { reasonCode: 'actual_patch_diff', ...(residual.residualPatchId ? { residualPatchId: residual.residualPatchId } : {}) };
    try {
        const [behind, ahead] = git(repo, ['rev-list', '--left-right', '--count', `${base.ref}...${sha}`]).trim().split(/\s+/).map(n => Number.parseInt(n, 10));
        if (Number.isFinite(behind)) detail.behind = behind;
        if (Number.isFinite(ahead)) detail.ahead = ahead;
    } catch { /* counts are best-effort */ }
    // Some commits of the ref already have equivalents on the base, yet a residual remains:
    // the rest landed, or the base later modified those lines. A hint, not a verdict.
    const cherry = gitCherryCounts(repo, base.ref, sha);
    if (cherry !== 'undeterminable' && cherry.equivalent > 0) detail.note = 'modified_since_landing_possible';
    return { sha, status: 'not_contained', detail };
}

/** `git fetch origin <branch>` (network). Failures are swallowed: a stale base is recorded via base_sha, not hidden. */
export function fetchDefaultBranch(repo: string, defaultBranch: string, timeoutMs: number): boolean {
    try {
        execFileSync(GIT, ['fetch', '--quiet', 'origin', `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`], {
            cwd: repo, stdio: 'ignore', timeout: timeoutMs, windowsHide: true, env: realGitEnv(),
        });
        return true;
    } catch {
        return false;
    }
}
