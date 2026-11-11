// ---------------------------------------------------------------------------
// mesh-orphan-worktree-reaper — safe automatic removal of ORPHAN managed
// worktrees (git worktrees with no live mesh node, e.g. a finished task whose
// node was removed). Detection + the `worktree_cleanup_candidate` ledger signal
// live in mesh-disk-retention.ts; this module only decides whether a signalled
// orphan is PROVABLY safe to delete and, if so, deletes it.
//
// Fail-closed contract — an orphan is removed only when ALL hold:
//   1. no live node matches it and it is not the main worktree
//      (detectOrphanWorktrees);
//   2. its real path is strictly inside THIS mesh's managed namespace
//      (<worktreeBase>/<meshName>/… or the legacy <repoParent>/.adhdev-worktrees/<meshName>/…);
//   3. grace: the earliest worktree_cleanup_candidate record for the path is at
//      least resolveWorktreeNodeRetentionGraceMs() old (0 disables the reaper);
//   4. no live/recovery session-host session works inside it, session inventory
//      is readable, and process.cwd() is not inside it;
//   5. the repo HAS a remote (otherwise nothing is "pushed" anywhere), the
//      worktree and every initialized submodule have an empty
//      `git status --porcelain` and no commit absent from every remote ref
//      (a detached HEAD not on any remote counts as unpushed).
// Any probe error → skip. No force flags: removal is `git worktree remove`; only
// for the "contains submodules" refusal (after the clean/pushed proof above) the
// directory is deleted and `git worktree prune` drops the registration (and
// <repo>/.git/worktrees/<name>/modules with it). The branch ref is deleted only
// with the safe `git branch -d` and only when fully pushed.
// Logs/ledger carry only path + reason codes, never file content.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve, sep } from 'path';
import { LOG } from '../logging/logger.js';
import { gitChildEnv } from '../git/git-locale.js';
import { listWorktrees, resolveWorktreeBaseDir, deleteBranchRef, type WorktreeEntry } from '../git/git-worktree.js';
import { getSessionHostSurfaceKind } from '../session-host/runtime-surface.js';
import type { LocalMeshEntry } from '../repo-mesh-types.js';
import { detectOrphanWorktrees, resolveLocalBaseRepoRoot } from './mesh-disk-retention.js';
import { readLocalRecords } from './mesh-local-records.js';
import { meshRecord } from './mesh-record.js';
import { resolveWorktreeNodeRetentionGraceMs } from './mesh-retention-config.js';

const execFileAsync = promisify(execFile);
const LOG_CATEGORY = 'OrphanWorktreeReaper';
const GIT_TIMEOUT_MS = 60_000;
/** How many candidate records to scan for the earliest detectedAt of a path. */
const CANDIDATE_SCAN_TAIL = 5000;
const LEGACY_WORKTREE_DIR_NAME = '.adhdev-worktrees';
const SUBMODULE_REMOVE_RE = /working trees containing submodules cannot be moved or removed/i;

export type OrphanReapReason =
    | 'removed'
    | 'already_gone'
    | 'grace_disabled'
    | 'no_candidate_record'
    | 'within_grace'
    | 'outside_managed_base'
    | 'session_inventory_unavailable'
    | 'session_inside'
    | 'process_cwd_inside'
    | 'no_remote'
    | 'dirty'
    | 'unpushed_commits'
    | 'submodule_dirty'
    | 'submodule_unpushed'
    | 'probe_failed'
    | 'remove_failed'
    | 'in_flight';

export interface OrphanReapOutcome { path: string; reason: OrphanReapReason; removed: boolean }

export interface OrphanReapDeps {
    /** Session-host inventory; a throw/non-array → fail closed. */
    listSessions: () => Promise<unknown[]>;
    cwd?: () => string;
}

const inFlight = new Set<string>();

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
        cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: gitChildEnv(),
    });
    return String(stdout);
}

function real(p: string): string {
    const r = resolve(p);
    try { return fs.realpathSync(r); } catch { return r; }
}

function isInside(child: string, parent: string): boolean {
    const c = real(child);
    const p = real(parent);
    return c !== p && c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function safeSegment(v: string): string {
    return v.replace(/[/\\:*?"<>|]/g, '-').replace(/^\.+|\.+$/g, '');
}

/** Managed namespaces for this mesh (current base + legacy sibling layout). */
export function managedWorktreeDirs(mesh: LocalMeshEntry, repoRoot: string): string[] {
    const meshSeg = safeSegment(String(mesh.name || mesh.id || 'mesh'));
    const base = resolveWorktreeBaseDir((mesh.policy as { worktreeBaseDir?: string } | undefined)?.worktreeBaseDir);
    return [join(base, meshSeg), join(dirname(repoRoot), LEGACY_WORKTREE_DIR_NAME, meshSeg)];
}

/** Earliest `detectedAt` (ms) among candidate records for `worktreePath`, or undefined. */
function earliestCandidateAt(meshId: string, worktreePath: string): number | undefined {
    let earliest: number | undefined;
    const target = real(worktreePath);
    for (const e of readLocalRecords(meshId, { kind: ['worktree_cleanup_candidate'], tail: CANDIDATE_SCAN_TAIL, turnTerminals: false })) {
        const p = typeof e.payload?.worktreePath === 'string' ? e.payload.worktreePath : '';
        if (!p || (p !== worktreePath && real(p) !== target)) continue;
        const raw = typeof e.payload?.detectedAt === 'string' ? Date.parse(e.payload.detectedAt) : NaN;
        const ts = Number.isFinite(raw) ? raw : Date.parse(String((e as { timestamp?: string }).timestamp ?? ''));
        if (Number.isFinite(ts) && (earliest === undefined || ts < earliest)) earliest = ts;
    }
    return earliest;
}

async function hasRemote(dir: string): Promise<boolean> {
    return (await git(dir, ['remote'])).trim().length > 0;
}

async function unpushedCount(dir: string): Promise<number> {
    const n = Number.parseInt((await git(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).trim(), 10);
    if (!Number.isFinite(n)) throw new Error('unparseable rev-list count');
    return n;
}

/** Initialized submodule paths (recursive), relative to `dir`. */
async function initializedSubmodules(dir: string): Promise<string[]> {
    const out = await git(dir, ['submodule', 'status', '--recursive']);
    const paths: string[] = [];
    for (const line of out.split('\n')) {
        if (!line.trim() || line[0] === '-') continue; // '-' = not initialized
        const m = /^.[0-9a-f]{40,64} (.+?)(?: \(.*\))?$/.exec(line);
        if (!m) throw new Error('unparseable submodule status');
        paths.push(m[1]);
    }
    return paths;
}

type GitSafety = { ok: true } | { ok: false; reason: OrphanReapReason };

async function checkGitSafety(wtPath: string): Promise<GitSafety> {
    try {
        if (!(await hasRemote(wtPath))) return { ok: false, reason: 'no_remote' };
        if ((await git(wtPath, ['status', '--porcelain'])).trim()) return { ok: false, reason: 'dirty' };
        if ((await unpushedCount(wtPath)) > 0) return { ok: false, reason: 'unpushed_commits' };
        for (const sub of await initializedSubmodules(wtPath)) {
            const subDir = join(wtPath, sub);
            if (!(await hasRemote(subDir))) return { ok: false, reason: 'submodule_unpushed' };
            if ((await git(subDir, ['status', '--porcelain'])).trim()) return { ok: false, reason: 'submodule_dirty' };
            if ((await unpushedCount(subDir)) > 0) return { ok: false, reason: 'submodule_unpushed' };
        }
        return { ok: true };
    } catch {
        return { ok: false, reason: 'probe_failed' };
    }
}

async function sessionInside(wtPath: string, deps: OrphanReapDeps): Promise<'inside' | 'unavailable' | 'clear'> {
    let sessions: unknown[];
    try { sessions = await deps.listSessions(); } catch { return 'unavailable'; }
    if (!Array.isArray(sessions)) return 'unavailable';
    for (const rec of sessions as Array<Record<string, any>>) {
        if (getSessionHostSurfaceKind(rec as never) === 'inactive_record') continue;
        const dirs = [rec?.workspace, rec?.workingDir, rec?.cwd, rec?.meta?.workspace, rec?.meta?.workingDir]
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
        for (const d of dirs) {
            const rd = real(d);
            const rw = real(wtPath);
            if (rd === rw || rd.startsWith(rw + sep)) return 'inside';
        }
    }
    return 'clear';
}

async function removeOne(repoRoot: string, wt: WorktreeEntry): Promise<{ ok: true; removed: boolean } | { ok: false }> {
    if (!fs.existsSync(wt.path)) {
        try { await git(repoRoot, ['worktree', 'prune']); } catch { /* best-effort */ }
        return { ok: true, removed: false };
    }
    try {
        await git(repoRoot, ['worktree', 'remove', wt.path]);
    } catch (e: any) {
        const detail = `${e?.stderr || ''}\n${e?.stdout || ''}\n${e?.message || ''}`;
        if (!SUBMODULE_REMOVE_RE.test(detail)) return { ok: false };
        // Clean + fully pushed was proven by the caller; drop the directory and let
        // prune de-register it (including <gitdir>/worktrees/<name>/modules).
        try { fs.rmSync(wt.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { return { ok: false }; }
        if (fs.existsSync(wt.path)) return { ok: false };
    }
    try { await git(repoRoot, ['worktree', 'prune']); } catch { /* best-effort */ }
    return { ok: true, removed: true };
}

/**
 * One reaper pass for one mesh. Never throws; returns one outcome per orphan
 * considered. Idempotent: an already-removed path is success, and a path being
 * reaped by a concurrent pass in this process is skipped (`in_flight`).
 */
export async function reapOrphanWorktrees(
    mesh: LocalMeshEntry,
    deps: OrphanReapDeps,
    now: number = Date.now(),
): Promise<OrphanReapOutcome[]> {
    const outcomes: OrphanReapOutcome[] = [];
    try {
        const graceMs = resolveWorktreeNodeRetentionGraceMs();
        if (!(graceMs > 0)) return outcomes;
        const nodes = Array.isArray(mesh.nodes) ? mesh.nodes : [];
        const repoRoot = resolveLocalBaseRepoRoot(nodes);
        if (!repoRoot) return outcomes;
        const entries = await listWorktrees(repoRoot);
        const mainPath = entries[0]?.path || repoRoot;
        const orphans = detectOrphanWorktrees(entries, nodes.map(n => ({ workspace: n.workspace, repoRoot: n.repoRoot })), mainPath);
        const managed = managedWorktreeDirs(mesh, repoRoot);

        for (const orphan of orphans) {
            const wt = entries.find(e => e.path === orphan.path)!;
            const done = (reason: OrphanReapReason, removed = false) => {
                outcomes.push({ path: wt.path, reason, removed });
                if (!removed) LOG.info(LOG_CATEGORY, `skip ${wt.path}: ${reason}`);
            };
            if (inFlight.has(wt.path)) { done('in_flight'); continue; }
            inFlight.add(wt.path);
            try {
                if (!managed.some(dir => isInside(wt.path, dir))) { done('outside_managed_base'); continue; }
                const first = earliestCandidateAt(mesh.id, wt.path);
                if (first === undefined) { done('no_candidate_record'); continue; }
                if (now - first < graceMs) { done('within_grace'); continue; }
                const cwd = (deps.cwd ?? (() => process.cwd()))();
                const rw = real(wt.path);
                const rc = real(cwd);
                if (rc === rw || rc.startsWith(rw + sep)) { done('process_cwd_inside'); continue; }
                const sess = await sessionInside(wt.path, deps);
                if (sess === 'unavailable') { done('session_inventory_unavailable'); continue; }
                if (sess === 'inside') { done('session_inside'); continue; }
                if (fs.existsSync(wt.path)) {
                    const safety = await checkGitSafety(wt.path);
                    if (!safety.ok) { done(safety.reason); continue; }
                }
                const alreadyGone = !fs.existsSync(wt.path);
                const res = await removeOne(repoRoot, wt);
                if (!res.ok) { done('remove_failed'); continue; }

                let branchDeleted = false;
                if (wt.branch && !alreadyGone) {
                    try {
                        const pushed = Number.parseInt((await git(repoRoot, ['rev-list', '--count', wt.branch, '--not', '--remotes'])).trim(), 10) === 0;
                        if (pushed) branchDeleted = (await deleteBranchRef(repoRoot, wt.branch, { safeDeleteOnly: true })).deleted;
                    } catch { /* leave the branch */ }
                }
                outcomes.push({ path: wt.path, reason: res.removed ? 'removed' : 'already_gone', removed: res.removed });
                if (res.removed) {
                    try {
                        meshRecord(mesh.id, 'worktree_orphan_removed', {
                            payload: { worktreePath: wt.path, branchDeleted, removedAt: new Date(now).toISOString() },
                        }, { local: true });
                    } catch { /* ledger best-effort */ }
                    LOG.info(LOG_CATEGORY, `removed orphan worktree ${wt.path} (mesh ${mesh.id}, branchDeleted=${branchDeleted})`);
                }
            } finally {
                inFlight.delete(wt.path);
            }
        }
    } catch (e: any) {
        LOG.warn(LOG_CATEGORY, `orphan worktree reap failed for mesh ${mesh.id}: ${e?.message || e}`);
    }
    return outcomes;
}
