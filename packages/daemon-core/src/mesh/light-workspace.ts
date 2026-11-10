/**
 * LIGHT-TASK: light workspace lifecycle (design §5, §10).
 *
 * A light workspace (LW) is a per-task scratch checkout that shares the coordinator
 * checkout's git object store: detached `git worktree`s (root + each initialised
 * submodule) + a node_modules link farm + cloned build outputs. No `npm install`,
 * no node creation, no bootstrap.
 *
 * Public surface (also consumed by the review-in-task `ReviewerWorkspaceProvider`):
 *   prepareLightWorkspace(input)  -> LightWorkspaceHandle
 *   removeLightWorkspace(input)   -> LightWorkspaceRemoveResult
 *   sweepLightWorkspaces(input)   -> LightWorkspaceSweepReport
 */
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Database as DatabaseHandle } from 'better-sqlite3';
import type { OwnedPathsDeclaration, PhysicalOwnershipScope } from '@adhdev/mesh-shared';
import { resolveConfigDir } from '../config/config-dir.js';
import { gitChildEnv } from '../git/git-locale.js';
import { attestLocalOwnership } from './mesh-physical-ownership.js';
import { buildNodeModulesFarm, cloneBuildOutputs, unlinkAllLinks } from './light-workspace-farm.js';
import { expandRepoPattern, type LightWorkspaceConfig } from './light-workspace-config.js';
import {
    getLightWorkspace, listLightWorkspaces, setLightWorkspaceState, upsertLightWorkspace,
    type LightWorkspaceRow,
} from './mesh-light-workspace-store.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const MARKER_SUFFIX = '.adhdev-light.json';

async function git(cwd: string, args: string[], allowFail = false): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: gitChildEnv(),
        });
        return stdout.trim();
    } catch (e: any) {
        if (allowFail) return '';
        const detail = (typeof e?.stderr === 'string' && e.stderr.trim()) || e?.message || String(e);
        throw new Error(`git ${args.slice(0, 3).join(' ')} failed: ${detail}`);
    }
}

// ── serialisation: one preparation per repo at a time (lease key `lw:<repoHash>`) ──
const leaseChains = new Map<string, Promise<unknown>>();
function withLease<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = leaseChains.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    leaseChains.set(key, run.catch(() => undefined));
    return run;
}

export class LightWorkspaceError extends Error {
    constructor(readonly code: string, message: string) { super(message); this.name = 'LightWorkspaceError'; }
}

export function lightRepoHash(checkoutRoot: string): string {
    let real = checkoutRoot;
    try { real = fs.realpathSync.native(checkoutRoot); } catch { /* keep input */ }
    return crypto.createHash('sha1').update(real).digest('hex').slice(0, 8);
}

export function lightTaskKey(taskId: string): string {
    return taskId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || crypto.randomBytes(4).toString('hex');
}

export function resolveLightBaseDir(cfg?: Pick<LightWorkspaceConfig, 'baseDir'>, override?: string): string {
    if (override) return override;
    if (cfg?.baseDir) return cfg.baseDir;
    if (process.platform === 'win32') {
        return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'adhdev', 'lw');
    }
    return path.join(resolveConfigDir(), 'lw');
}

/**
 * L12 base selection: the checkout's HEAD, except when HEAD is a strict ancestor of its
 * remote-tracking ref (`origin/<branch>`), in which case the remote-tracking tip. No fetch.
 */
export async function resolveLightBaseSha(checkoutRoot: string, baseBranch?: string): Promise<{ sha: string; source: 'head' | 'remote_tracking'; head: string }> {
    const head = await git(checkoutRoot, ['rev-parse', 'HEAD']);
    const branch = baseBranch || await git(checkoutRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], true);
    if (branch && branch !== 'HEAD') {
        const remote = await git(checkoutRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], true);
        if (remote && remote !== head) {
            const isAncestor = await execFileAsync('git', ['merge-base', '--is-ancestor', head, remote], {
                cwd: checkoutRoot, windowsHide: true, env: gitChildEnv(), timeout: GIT_TIMEOUT_MS,
            }).then(() => true, () => false);
            if (isAncestor) return { sha: remote, source: 'remote_tracking', head };
        }
    }
    return { sha: head, source: 'head', head };
}

export interface PrepareLightWorkspaceInput {
    meshId: string;
    taskId: string;
    /** The coordinator / light-base-node checkout whose object store is shared. */
    checkoutRoot: string;
    config: LightWorkspaceConfig;
    /** Root commit to check out. Default: `resolveLightBaseSha(checkoutRoot)`. A reviewer passes the implementation head. */
    rootBaseSha?: string;
    /** Branch (created in root and every submodule worktree). Default `mesh/light/<taskId8>`; `false` keeps HEAD detached (reviewer). */
    branch?: string | false;
    /** Disambiguates multiple workspaces for one task (e.g. `review`). Becomes part of the directory name. */
    keySuffix?: string;
    /** Registry handle; when given the workspace is recorded. */
    db?: DatabaseHandle;
    baseDir?: string;
    /** When set, a physical ownership scope is attested for these paths. */
    ownership?: { paths: OwnedPathsDeclaration; repoIdentity: string; machineId: string; nodeId: string };
}

export interface LightWorkspaceHandle {
    workspaceId: string;
    path: string;
    rootBaseSha: string;
    /** submodule path -> gitlink sha at rootBaseSha (initialised submodules only) */
    submoduleBases: Record<string, string>;
    /** `.` -> root branch, `<submodule>` -> submodule branch; empty when detached */
    branchRefs: Record<string, string>;
    linkCount: number;
    copiedDirs: string[];
    ownershipScope?: PhysicalOwnershipScope;
    ownershipScopeError?: string;
    prepareMs: number;
}

function freeBytes(dir: string): number | undefined {
    let probe = dir;
    while (probe && !fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
    try { const s = (fs as any).statfsSync(probe); return Number(s.bavail) * Number(s.bsize); } catch { return undefined; }
}

async function listGitlinks(checkoutRoot: string, sha: string): Promise<Array<{ name: string; sha: string }>> {
    const out = await git(checkoutRoot, ['ls-tree', sha]);
    const links: Array<{ name: string; sha: string }> = [];
    for (const line of out.split('\n')) {
        const m = /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(line.trim());
        if (m) links.push({ sha: m[1], name: m[2] });
    }
    return links;
}

export async function prepareLightWorkspace(input: PrepareLightWorkspaceInput): Promise<LightWorkspaceHandle> {
    const checkout = fs.realpathSync.native(input.checkoutRoot);
    return withLease(`lw:${lightRepoHash(checkout)}`, async () => {
        const started = Date.now();
        const baseDir = resolveLightBaseDir(input.config, input.baseDir);
        const repoDir = path.join(baseDir, lightRepoHash(checkout));
        const key = lightTaskKey(input.taskId) + (input.keySuffix ? `-${input.keySuffix.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}` : '');
        const lw = path.join(repoDir, key);
        const workspaceId = `lw_${lightRepoHash(checkout)}_${key}`;

        const free = freeBytes(baseDir);
        if (free !== undefined && free < input.config.minFreeBytes) {
            throw new LightWorkspaceError('light_workspace_disk_low', `free disk ${free} < required ${input.config.minFreeBytes}`);
        }
        if (fs.existsSync(lw)) throw new LightWorkspaceError('light_workspace_exists', `light workspace already exists: ${lw}`);

        const rootBaseSha = input.rootBaseSha || (await resolveLightBaseSha(checkout)).sha;
        const now = new Date().toISOString();
        const row: LightWorkspaceRow = {
            workspaceId, meshId: input.meshId, taskId: input.taskId, repoRoot: checkout, path: lw, rootBaseSha,
            submoduleBases: {}, branchRefs: {}, state: 'preparing', createdAt: now, updatedAt: now,
            linkDirs: input.config.linkNodeModules.flatMap(p => expandRepoPattern(checkout, p)).filter(d => fs.existsSync(path.join(checkout, d))),
        };
        fs.mkdirSync(repoDir, { recursive: true });
        const markerPath = `${lw}${MARKER_SUFFIX}`;
        fs.writeFileSync(markerPath, JSON.stringify({ workspaceId, taskId: input.taskId, meshId: input.meshId, rootBaseSha, createdAt: now }, null, 2));
        if (input.db) upsertLightWorkspace(input.db, row);

        try {
            await git(checkout, ['worktree', 'add', '--detach', lw, rootBaseSha]);
            const gitlinks = await listGitlinks(checkout, rootBaseSha);
            const branchRefs: Record<string, string> = {};
            const branch = input.branch === false ? undefined : (input.branch || `mesh/light/${lightTaskKey(input.taskId)}`);
            for (const link of gitlinks) {
                const subSrc = path.join(checkout, link.name);
                if (!fs.existsSync(path.join(subSrc, '.git'))) continue; // uninitialised submodule stays empty
                try {
                    await git(subSrc, ['worktree', 'add', '--detach', path.join(lw, link.name), link.sha]);
                } catch (e: any) {
                    throw new LightWorkspaceError('light_submodule_worktree_failed', `${link.name}: ${e.message}`);
                }
                row.submoduleBases[link.name] = link.sha;
                if (branch) { await git(path.join(lw, link.name), ['checkout', '-B', branch]); branchRefs[link.name] = branch; }
            }
            if (branch) { await git(lw, ['checkout', '-B', branch]); branchRefs['.'] = branch; }
            row.branchRefs = branchRefs;

            const farm = buildNodeModulesFarm(checkout, lw, input.config);
            const copiedDirs = cloneBuildOutputs(checkout, lw, input.config);

            let ownershipScope: PhysicalOwnershipScope | undefined;
            let ownershipScopeError: string | undefined;
            if (input.ownership) {
                try {
                    ownershipScope = attestLocalOwnership({ ...input.ownership, nodeId: input.ownership.nodeId, workspace: lw, phase: 'source', paths: input.ownership.paths });
                } catch (e: any) { ownershipScopeError = e?.message || String(e); }
            }
            row.state = 'ready';
            row.updatedAt = new Date().toISOString();
            if (input.db) upsertLightWorkspace(input.db, row);
            return {
                workspaceId, path: lw, rootBaseSha, submoduleBases: row.submoduleBases, branchRefs,
                linkCount: farm.links.length, copiedDirs,
                ...(ownershipScope ? { ownershipScope } : {}), ...(ownershipScopeError ? { ownershipScopeError } : {}),
                prepareMs: Date.now() - started,
            };
        } catch (e: any) {
            if (input.db) setLightWorkspaceState(input.db, workspaceId, 'failed', e?.message || String(e));
            await removeLightWorkspace({ path: lw, checkoutRoot: checkout, baseDir, db: input.db, workspaceId, submodules: Object.keys(row.submoduleBases), markRemoved: true }).catch(() => undefined);
            throw e instanceof LightWorkspaceError ? e : new LightWorkspaceError('light_workspace_prepare_failed', e?.message || String(e));
        }
    });
}

export interface RemoveLightWorkspaceInput {
    path: string;
    checkoutRoot: string;
    baseDir?: string;
    config?: Pick<LightWorkspaceConfig, 'baseDir'>;
    db?: DatabaseHandle;
    workspaceId?: string;
    /** Submodule paths with their own worktrees; default = top-level dirs holding a `.git` file. */
    submodules?: string[];
    /** Delete the `mesh/light/*` branches recorded in the registry (default false: refs live 14 days). */
    deleteBranches?: boolean;
    markRemoved?: boolean;
}

export interface LightWorkspaceRemoveResult { removed: boolean; reason?: string; linksUnlinked: number }

function isInside(root: string, p: string): boolean {
    const rel = path.relative(root, p);
    return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

export async function removeLightWorkspace(input: RemoveLightWorkspaceInput): Promise<LightWorkspaceRemoveResult> {
    const baseDir = resolveLightBaseDir(input.config, input.baseDir);
    let baseReal = baseDir;
    try { baseReal = fs.realpathSync.native(baseDir); } catch { /* base missing: nothing under it */ }
    const lw = path.resolve(input.path);
    // The path itself must not be (or traverse) a link, and must sit under the light base dir.
    let lwReal: string;
    try {
        if (fs.lstatSync(lw).isSymbolicLink()) return { removed: false, reason: 'workspace_path_is_link', linksUnlinked: 0 };
        lwReal = fs.realpathSync.native(lw);
    } catch {
        // Already gone: just reconcile the registry.
        if (input.db && input.workspaceId) setLightWorkspaceState(input.db, input.workspaceId, 'removed');
        return { removed: true, reason: 'already_absent', linksUnlinked: 0 };
    }
    if (!isInside(baseReal, lwReal)) return { removed: false, reason: 'outside_light_base_dir', linksUnlinked: 0 };

    const checkout = fs.existsSync(input.checkoutRoot) ? fs.realpathSync.native(input.checkoutRoot) : input.checkoutRoot;
    const subs = input.submodules ?? fs.readdirSync(lwReal, { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(lwReal, d.name, '.git')) && fs.statSync(path.join(lwReal, d.name, '.git')).isFile())
        .map(d => d.name);

    const row = input.db && input.workspaceId ? getLightWorkspace(input.db, input.workspaceId) : undefined;
    // 1. links first, never following them (design §10).
    const linksUnlinked = unlinkAllLinks(lwReal);
    // 2. submodule worktrees, 3. root worktree.
    for (const sub of subs) await git(path.join(checkout, sub), ['worktree', 'remove', '--force', path.join(lwReal, sub)], true);
    await git(checkout, ['worktree', 'remove', '--force', lwReal], true);
    // 4. leftovers (a real-dir remainder only — every link is already gone).
    try { fs.rmSync(lwReal, { recursive: true, force: true, maxRetries: 3 }); } catch { /* reported below */ }
    for (const sub of subs) await git(path.join(checkout, sub), ['worktree', 'prune'], true);
    await git(checkout, ['worktree', 'prune'], true);
    if (input.deleteBranches && row) {
        for (const [where, branch] of Object.entries(row.branchRefs)) {
            await git(where === '.' ? checkout : path.join(checkout, where), ['branch', '-D', branch], true);
        }
    }
    try { fs.rmSync(`${lw}${MARKER_SUFFIX}`, { force: true }); } catch { /* ignore */ }
    const gone = !fs.existsSync(lwReal);
    if (gone && input.db && input.workspaceId) setLightWorkspaceState(input.db, input.workspaceId, 'removed');
    return { removed: gone, ...(gone ? {} : { reason: 'leftover_directory' }), linksUnlinked };
}

export interface SweepLightWorkspacesInput {
    checkoutRoot: string;
    db: DatabaseHandle;
    config?: Pick<LightWorkspaceConfig, 'baseDir'>;
    baseDir?: string;
    now?: number;
    /** Unregistered marker-bearing directories younger than this are left alone (default 1h). */
    orphanGraceMs?: number;
    /** result_ready workspaces older than this lose their workspace dir (default 24h). */
    resultRetentionMs?: number;
    /** failed workspaces older than this are removed (default 1h). */
    failedRetentionMs?: number;
    /**
     * Stale-leak rule: a preparing/ready/in_use workspace untouched for longer than this whose task is NOT live
     * (terminal or unknown) is removed. Such rows never reach result_ready (worker stopped/reclaimed/cancelled, daemon
     * restarted mid-task), so no other rule ever frees them. 0/undefined disables. result_ready workspaces are never
     * touched by it (they hold a landable result — `resultRetentionMs` governs them).
     */
    staleUntouchedMs?: number;
    /** True when the row's task is still running/pending. Default (when `staleUntouchedMs` is set): everything is live. */
    isTaskLive?: (row: LightWorkspaceRow) => boolean;
    /** One line per removal (with size). */
    log?: (message: string) => void;
}

/** Bytes under `dir` (lstat walk, links never followed). Best-effort, bounded by entry count. */
export function lightDirSizeBytes(dir: string, maxEntries = 200_000): number {
    let total = 0; let seen = 0;
    const stack = [dir];
    while (stack.length && seen < maxEntries) {
        const cur = stack.pop()!;
        let names: fs.Dirent[];
        try { names = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const d of names) {
            if (++seen > maxEntries) break;
            const p = path.join(cur, d.name);
            try {
                const st = fs.lstatSync(p);
                if (st.isSymbolicLink()) continue;
                if (st.isDirectory()) stack.push(p); else total += st.size;
            } catch { /* raced */ }
        }
    }
    return total;
}

const formatMiB = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MiB`;

export interface LightWorkspaceSweepReport {
    removedMissing: string[];
    removedExpired: string[];
    removedOrphans: string[];
    /** Directories without a marker: never touched, only counted. */
    unmarked: number;
    /** Marker-bearing directories not in the registry (leak metric), counted before removal. */
    leaked: number;
}

export async function sweepLightWorkspaces(input: SweepLightWorkspacesInput): Promise<LightWorkspaceSweepReport> {
    const now = input.now ?? Date.now();
    const report: LightWorkspaceSweepReport = { removedMissing: [], removedExpired: [], removedOrphans: [], unmarked: 0, leaked: 0 };
    const checkout = fs.realpathSync.native(input.checkoutRoot);
    const baseDir = resolveLightBaseDir(input.config, input.baseDir);
    const rows = listLightWorkspaces(input.db).filter(r => r.repoRoot === checkout);
    const known = new Set(rows.map(r => path.resolve(r.path)));
    let pruned = false;
    for (const row of rows) {
        const age = now - Date.parse(row.updatedAt);
        if (!fs.existsSync(row.path)) {
            setLightWorkspaceState(input.db, row.workspaceId, 'removed');
            report.removedMissing.push(row.workspaceId);
            pruned = true;
            continue;
        }
        let staleReason: string | undefined;
        if (input.staleUntouchedMs && input.staleUntouchedMs > 0 && (row.state === 'preparing' || row.state === 'ready' || row.state === 'in_use')) {
            let dirAge = Infinity;
            try { dirAge = now - fs.statSync(row.path).mtimeMs; } catch { /* keep row age */ }
            if (Math.min(age, dirAge) > input.staleUntouchedMs && !(input.isTaskLive ?? (() => true))(row)) staleReason = `stale_${row.state}_task_not_live`;
        }
        const expired = staleReason !== undefined ||
            (row.state === 'result_ready' && age > (input.resultRetentionMs ?? 24 * 3600_000)) ||
            (row.state === 'failed' && age > (input.failedRetentionMs ?? 3600_000)) ||
            row.state === 'landed' || row.state === 'discarded';
        if (expired) {
            const size = input.log ? lightDirSizeBytes(row.path) : 0;
            const res = await removeLightWorkspace({ path: row.path, checkoutRoot: checkout, baseDir, db: input.db, workspaceId: row.workspaceId, submodules: Object.keys(row.submoduleBases) });
            if (res.removed) {
                report.removedExpired.push(row.workspaceId);
                input.log?.(`removed light workspace ${row.workspaceId} (${staleReason ?? row.state}, ${formatMiB(size)}, age ${Math.round(age / 60000)} min) at ${row.path}`);
            }
        }
    }
    if (pruned) await git(checkout, ['worktree', 'prune'], true);
    const repoDir = path.join(baseDir, lightRepoHash(checkout));
    let names: string[] = [];
    try { names = fs.readdirSync(repoDir); } catch { /* none */ }
    for (const name of names) {
        if (name.endsWith(MARKER_SUFFIX)) continue;
        const dir = path.join(repoDir, name);
        try { if (!fs.statSync(dir).isDirectory()) { report.unmarked++; continue; } } catch { continue; }
        const marker = `${dir}${MARKER_SUFFIX}`;
        if (!fs.existsSync(marker)) { report.unmarked++; continue; }
        if (known.has(path.resolve(dir))) continue;
        report.leaked++;
        const age = now - fs.statSync(marker).mtimeMs;
        if (age < (input.orphanGraceMs ?? 3600_000)) continue;
        const size = input.log ? lightDirSizeBytes(dir) : 0;
        const res = await removeLightWorkspace({ path: dir, checkoutRoot: checkout, baseDir });
        if (res.removed) {
            report.removedOrphans.push(name);
            input.log?.(`removed orphan light workspace ${name} (${formatMiB(size)}, marker age ${Math.round(age / 60000)} min) at ${dir}`);
        }
    }
    return report;
}
