// ---------------------------------------------------------------------------
// mesh-disk-retention — periodic disk / worktree retention for ~/.adhdev
// ---------------------------------------------------------------------------
// Legacy on-disk artifacts under ~/.adhdev accumulated with NO lifetime/GC and
// grew the data volume until a refine bootstrap failed at 98% disk (mission
// 86def38d). Immediate reclaim was manual; this module implements the code-level
// RETENTION so it does not recur.
//
// What it prunes (all thresholds defensive — never touches a live/in-use file):
//   1. JSONL ledger files      ~/.adhdev/mesh-ledger/*.jsonl  older than 30 days
//      (legacy after the SQLite ledger; zero lifetime before this).
//   2. session-host runtimes   ~/.adhdev/session-host/*/runtimes/*.json for
//      TERMINATED (dead) runtimes older than 14 days (live runtimes never touched).
//   3. DB backups              ~/.adhdev/mesh-ledger/mesh-runtime.db.bak-* older
//      than 7 days.
//   4. closed ledger rotations <mesh>.<n>.jsonl / <mesh>.archive.<n>.jsonl past
//      the per-mesh byte/count caps (lifecycle retention Slice 1 — see
//      enforceAllLedgerRotationCaps in mesh-ledger.ts; folds terminal counts
//      into the archived-counts rollup before unlink, never touches the active
//      ledger/current archive/runtime DB).
// Plus DETECTION-ONLY orphan-worktree signalling (see mesh-reconcile-loop.ts):
//   5. a worktree present on disk with no matching live mesh node is reported as a
//      cleanup_candidate ledger entry — NEVER auto-deleted (that stays manual /
//      coordinator-driven).
//
// The functions are split into PURE core selectors (age/orphan decisions, taking
// explicit paths + a `now` timestamp so they are deterministic and require no fs
// mocking in tests) and thin runtime wrappers that resolve the real ~/.adhdev
// paths and perform the unlink. The pure selectors are the unit-tested surface.
// ---------------------------------------------------------------------------

import {
    existsSync,
    readdirSync,
    statSync,
    unlinkSync,
    readFileSync,
} from 'fs';
import { join } from 'path';
import { getConfigDir } from '../config/config.js';
import { getLedgerDir, appendLedgerEntry, readLedgerEntries, enforceAllLedgerRotationCaps } from './mesh-ledger.js';
import { isSessionHostLiveRuntime } from '../session-host/runtime-surface.js';
import type { SessionHostSurfaceRecordLike } from '../session-host/runtime-surface.js';
import { listWorktrees } from '../git/git-worktree.js';
import type { LocalMeshEntry } from '../repo-mesh-types.js';
import { LOG } from '../logging/logger.js';
import { checkDiskSpace, logDiskSpaceStatus, type DiskSpaceLevel } from '../diagnostics/disk-space-preflight.js';
import { pruneExpiredHandoffNotes, HANDOFF_RETENTION_DAYS } from './worker-handoff-notes.js';

// ─── Thresholds (all defensive) ────────────────────────────────────────────
export const DAY_MS = 24 * 60 * 60 * 1000;
/** JSONL ledger files are legacy after the SQLite ledger — 30-day lifetime. */
export const LEDGER_JSONL_MAX_AGE_MS = 30 * DAY_MS;
/** Terminated session-host runtimes: conservative 14-day retention. */
export const SESSION_HOST_RUNTIME_MAX_AGE_MS = 14 * DAY_MS;
/** mesh-runtime.db.bak-* backups: 7-day retention. */
export const DB_BAK_MAX_AGE_MS = 7 * DAY_MS;

// ─── (1) JSONL ledger retention ─────────────────────────────────────────────

/** A file candidate for age-based pruning: absolute path + last-modified epoch ms. */
export interface AgedFile {
    path: string;
    mtimeMs: number;
}

/**
 * PURE. Select the JSONL ledger files whose mtime is older than `maxAgeMs`
 * relative to `now`. A file exactly at the threshold is KEPT (strict `>`), so a
 * 30-day-old file survives its 30th day and is pruned on the 31st. Deterministic:
 * no fs access, no clock read.
 */
export function selectExpiredLedgerJsonl(
    files: AgedFile[],
    now: number,
    maxAgeMs: number = LEDGER_JSONL_MAX_AGE_MS,
): AgedFile[] {
    return files.filter(f => now - f.mtimeMs > maxAgeMs);
}

// ─── (2) session-host runtime retention ─────────────────────────────────────

/** A parsed session-host runtime file: its path, mtime, and the wrapped record. */
export interface SessionHostRuntimeFile {
    path: string;
    mtimeMs: number;
    /** The `record` object from the on-disk `{ record, snapshot, updatedAt }` file. */
    record: SessionHostSurfaceRecordLike | null;
}

/**
 * PURE. Select the session-host runtime files safe to delete: ONLY those whose
 * runtime is terminated/dead (NOT a live runtime — decided by the session-host-core
 * SSOT `isSessionHostLiveRuntime`) AND older than `maxAgeMs`. A live runtime, or a
 * dead-but-recent one, is always kept. A file whose record failed to parse is treated
 * as NON-live but is still age-gated, so a corrupt-but-fresh file is never removed.
 */
export function selectExpiredSessionHostRuntimes(
    files: SessionHostRuntimeFile[],
    now: number,
    maxAgeMs: number = SESSION_HOST_RUNTIME_MAX_AGE_MS,
): SessionHostRuntimeFile[] {
    return files.filter(f => {
        // Never delete a live runtime, regardless of age.
        if (isSessionHostLiveRuntime(f.record ?? undefined)) return false;
        // Terminated/dead: age-gate it.
        return now - f.mtimeMs > maxAgeMs;
    });
}

// ─── (3) DB backup retention ────────────────────────────────────────────────

/** True for a `mesh-runtime.db.bak-*` backup filename (basename only). */
export function isDbBackupFileName(name: string): boolean {
    return /^mesh-runtime\.db\.bak-/.test(name);
}

/** PURE. Select `.bak-*` backups older than `maxAgeMs`. Strict `>` (see ledger). */
export function selectExpiredDbBackups(
    files: AgedFile[],
    now: number,
    maxAgeMs: number = DB_BAK_MAX_AGE_MS,
): AgedFile[] {
    return files.filter(f => now - f.mtimeMs > maxAgeMs);
}

// ─── (4) orphan worktree detection (detection-only) ─────────────────────────

/** Minimal shape needed to decide whether a worktree path is orphaned. */
export interface WorktreePathLike {
    path: string;
    bare?: boolean;
}

/** A live mesh node's known workspace paths (self workspace + repoRoot, normalized). */
export interface LiveNodeWorkspaceLike {
    workspace?: string;
    repoRoot?: string;
}

function normalizePath(p: string): string {
    // Trim a single trailing separator so "/a/b/" and "/a/b" compare equal.
    // Case-preserving (git worktree list + meshes.json are both raw paths from the
    // same daemon, so a case-fold would be over-eager on case-sensitive FS).
    return p.replace(/[/\\]+$/, '');
}

/**
 * PURE. Given the worktrees git reports on disk and the set of live-node workspace
 * paths, return the worktrees that have NO matching live node — the orphan
 * cleanup_candidates.
 *
 * SAFETY:
 *  - `mainWorktreePath` (the primary repo checkout, i.e. worktree[0]) is NEVER an
 *    orphan — it is the base repo, not a mesh clone.
 *  - `bare` worktrees are skipped (git's internal bookkeeping, not a node checkout).
 *  - Matching is path-equality after trailing-separator normalization against the
 *    union of every live node's `workspace` and `repoRoot`.
 * This is DETECTION ONLY — the caller signals a cleanup_candidate; it must not delete.
 */
export function detectOrphanWorktrees(
    worktrees: WorktreePathLike[],
    liveNodes: LiveNodeWorkspaceLike[],
    mainWorktreePath: string,
): WorktreePathLike[] {
    const liveePaths = new Set<string>();
    for (const n of liveNodes) {
        if (n.workspace) liveePaths.add(normalizePath(n.workspace));
        if (n.repoRoot) liveePaths.add(normalizePath(n.repoRoot));
    }
    const mainNorm = normalizePath(mainWorktreePath);
    return worktrees.filter(wt => {
        if (wt.bare) return false;
        const norm = normalizePath(wt.path);
        if (norm === mainNorm) return false; // base repo checkout — never an orphan
        return !liveePaths.has(norm);
    });
}

// ─── Runtime wrappers (resolve real paths + perform the unlink) ──────────────
// These are the side-effecting callers used by the reconcile loop. They are thin:
// gather → delegate to a PURE selector → unlink. Kept out of the unit tests (which
// target the deterministic selectors); their I/O is exercised by the daemon at runtime.

function safeUnlink(path: string): boolean {
    try {
        unlinkSync(path);
        return true;
    } catch (e: any) {
        LOG.warn('DiskRetention', `Failed to delete ${path}: ${e?.message || e}`);
        return false;
    }
}

function listDirFiles(dir: string): AgedFile[] {
    if (!existsSync(dir)) return [];
    const out: AgedFile[] = [];
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    for (const name of names) {
        const path = join(dir, name);
        try {
            const st = statSync(path);
            if (st.isFile()) out.push({ path, mtimeMs: st.mtimeMs });
        } catch {
            // vanished between readdir and stat — skip
        }
    }
    return out;
}

/**
 * Prune expired legacy JSONL ledger files under ~/.adhdev/mesh-ledger/.
 * Matches only `*.jsonl` (never the SQLite .db / -wal / -shm files). Returns the
 * count deleted. Best-effort: individual unlink failures are logged, not thrown.
 */
export function pruneExpiredLedgerJsonl(now: number = Date.now()): number {
    const dir = getLedgerDir();
    const jsonl = listDirFiles(dir).filter(f => f.path.endsWith('.jsonl'));
    const expired = selectExpiredLedgerJsonl(jsonl, now);
    let deleted = 0;
    for (const f of expired) if (safeUnlink(f.path)) deleted++;
    if (deleted > 0) LOG.info('DiskRetention', `Pruned ${deleted} JSONL ledger file(s) older than 30d`);
    return deleted;
}

/**
 * Prune expired `mesh-runtime.db.bak-*` backups under ~/.adhdev/mesh-ledger/.
 * Never touches the live DB (only names matching the .bak- prefix). Returns count.
 */
export function pruneExpiredDbBackups(now: number = Date.now()): number {
    const dir = getLedgerDir();
    const baks = listDirFiles(dir).filter(f => isDbBackupFileName(f.path.split(/[/\\]/).pop() || ''));
    const expired = selectExpiredDbBackups(baks, now);
    let deleted = 0;
    for (const f of expired) if (safeUnlink(f.path)) deleted++;
    if (deleted > 0) LOG.info('DiskRetention', `Pruned ${deleted} mesh-runtime.db.bak-* backup(s) older than 7d`);
    return deleted;
}

/**
 * Prune terminated session-host runtime files older than 14 days across every
 * ~/.adhdev/session-host/<app>/runtimes/ directory. A LIVE runtime is never deleted
 * regardless of age (isSessionHostLiveRuntime SSOT). Returns count deleted.
 */
export function pruneExpiredSessionHostRuntimes(now: number = Date.now()): number {
    const root = join(getConfigDir(), 'session-host');
    if (!existsSync(root)) return 0;
    let apps: string[];
    try {
        apps = readdirSync(root);
    } catch {
        return 0;
    }
    const candidates: SessionHostRuntimeFile[] = [];
    for (const app of apps) {
        const runtimesDir = join(root, app, 'runtimes');
        if (!existsSync(runtimesDir)) continue;
        for (const f of listDirFiles(runtimesDir)) {
            if (!f.path.endsWith('.json')) continue;
            let record: SessionHostRuntimeFile['record'] = null;
            try {
                const parsed = JSON.parse(readFileSync(f.path, 'utf-8'));
                const rec = parsed && typeof parsed === 'object' ? parsed.record : null;
                record = rec && typeof rec === 'object' ? (rec as SessionHostSurfaceRecordLike) : null;
            } catch {
                // Unparseable → treat as non-live; still age-gated by the selector,
                // so a corrupt-but-fresh file is preserved.
                record = null;
            }
            candidates.push({ path: f.path, mtimeMs: f.mtimeMs, record });
        }
    }
    const expired = selectExpiredSessionHostRuntimes(candidates, now);
    let deleted = 0;
    for (const f of expired) if (safeUnlink(f.path)) deleted++;
    if (deleted > 0) LOG.info('DiskRetention', `Pruned ${deleted} terminated session-host runtime file(s) older than 14d`);
    return deleted;
}

/**
 * Run the file-deleting retention passes (JSONL ledger, DB backups, session-host
 * runtimes, closed-rotation caps) once. Each pass is isolated so one failing
 * pass never blocks the others. Orphan-worktree DETECTION is driven separately
 * in the reconcile loop (it needs the live mesh config + git worktree list and
 * emits a ledger signal rather than deleting).
 * The closed-rotation pass (lifecycle retention Slice 1) evicts only the oldest
 * CLOSED rotation files past the per-mesh byte/count caps; it never touches the
 * active ledger, current archive, archived-counts rollup, or the runtime DB.
 * The returned counts are the content-free sweep metrics.
 */
export function runDiskRetentionSweep(now: number = Date.now()): {
    ledgerJsonl: number;
    dbBackups: number;
    sessionHostRuntimes: number;
    rotationEvicted: number;
    rotationEvictedBytes: number;
    /** Handoff-note ledger rows dropped past their 30-day window. */
    handoffNotes: number;
    /** Volume health after reclaiming ('ok' when unmeasurable). */
    diskLevel: DiskSpaceLevel;
} {
    let ledgerJsonl = 0;
    let dbBackups = 0;
    let sessionHostRuntimes = 0;
    let rotationEvicted = 0;
    let rotationEvictedBytes = 0;
    let handoffNotes = 0;
    try { ledgerJsonl = pruneExpiredLedgerJsonl(now); } catch (e: any) { LOG.warn('DiskRetention', `Ledger JSONL prune failed: ${e?.message || e}`); }
    try { dbBackups = pruneExpiredDbBackups(now); } catch (e: any) { LOG.warn('DiskRetention', `DB backup prune failed: ${e?.message || e}`); }
    try { sessionHostRuntimes = pruneExpiredSessionHostRuntimes(now); } catch (e: any) { LOG.warn('DiskRetention', `Session-host runtime prune failed: ${e?.message || e}`); }
    try {
        const rotation = enforceAllLedgerRotationCaps();
        rotationEvicted = rotation.evicted;
        rotationEvictedBytes = rotation.evictedBytes;
        if (rotation.evicted > 0) {
            LOG.info('DiskRetention', `Ledger rotation cap evicted ${rotation.evicted} closed rotation file(s) across ${rotation.meshes} mesh(es), ${rotation.evictedBytes} byte(s) freed (rotation_cap_count=${rotation.byReason.rotation_cap_count}, rotation_cap_bytes=${rotation.byReason.rotation_cap_bytes})`);
        }
    } catch (e: any) { LOG.warn('DiskRetention', `Ledger rotation cap sweep failed: ${e?.message || e}`); }
    // WORKER-MCP decision G / owner §12-4: handoff notes expire 30 days out.
    // A DB-row pass rather than a file pass — the notes live in mesh_turn_events
    // — but it belongs on the same hourly cadence as its file-based siblings.
    try {
        handoffNotes = pruneExpiredHandoffNotes(now);
        if (handoffNotes > 0) {
            LOG.info('DiskRetention', `Pruned ${handoffNotes} handoff note row(s) older than ${HANDOFF_RETENTION_DAYS}d`);
        }
    } catch (e: any) { LOG.warn('DiskRetention', `Handoff note prune failed: ${e?.message || e}`); }
    // Report the volume AFTER reclaiming, so the logged figure reflects what the
    // sweep actually left behind. Retention alone is not enough: this module was
    // written after an earlier 98%-disk incident and still the volume climbed
    // back to 97% and killed two sessions with ENOSPC, because nothing ever
    // *reported* the level. This is that missing signal — report-only here
    // (a periodic sweep must not throw), but never silent when unhealthy.
    let diskLevel: DiskSpaceLevel = 'ok';
    try {
        const status = checkDiskSpace(getConfigDir());
        logDiskSpaceStatus(status, 'disk retention sweep');
        if (status) diskLevel = status.level;
    } catch (e: any) { LOG.warn('DiskRetention', `Disk space check failed: ${e?.message || e}`); }
    return { ledgerJsonl, dbBackups, sessionHostRuntimes, rotationEvicted, rotationEvictedBytes, handoffNotes, diskLevel };
}

// ─── Orphan worktree detection (detection-only, emits cleanup_candidate) ──────

/** How many recent worktree_cleanup_candidate entries to scan for the re-emit guard. */
const ORPHAN_DEDUPE_WINDOW = 200;

/**
 * Detect orphaned worktrees for ONE mesh and emit a `worktree_cleanup_candidate`
 * ledger signal for each — DETECTION ONLY, never deletes. An orphan is a git worktree
 * on disk with no matching live mesh node (compared by path). It:
 *   1. picks a base (non-worktree) node owned by this mesh to anchor `git worktree list`;
 *   2. diffs the reported worktrees against the union of every node's workspace/repoRoot;
 *   3. skips the main worktree + bare entries (detectOrphanWorktrees safety);
 *   4. suppresses a repeat for a worktreePath already signalled within the recent window
 *      (idempotent re-emit guard), so the hourly sweep doesn't spam the ledger.
 * Returns the list of newly-signalled orphan paths. Best-effort: git/ledger failures are
 * logged and yield an empty result, never thrown.
 */
export async function detectAndSignalOrphanWorktrees(
    mesh: LocalMeshEntry,
    now: number = Date.now(),
): Promise<string[]> {
    const nodes = Array.isArray(mesh.nodes) ? mesh.nodes : [];
    // Anchor: a base (non-worktree) node's repoRoot (preferred) or workspace. The base
    // node is the primary checkout; its git dir enumerates every worktree of the repo.
    const baseNode = nodes.find(n => !n.isLocalWorktree && (n.repoRoot || n.workspace));
    const repoRoot = baseNode?.repoRoot || baseNode?.workspace;
    if (!repoRoot) return []; // no local base checkout for this mesh on this daemon

    let worktrees: WorktreePathLike[];
    try {
        worktrees = await listWorktrees(repoRoot);
    } catch (e: any) {
        LOG.warn('DiskRetention', `git worktree list failed for mesh ${mesh.id} (${repoRoot}): ${e?.message || e}`);
        return [];
    }
    // git worktree list emits the main worktree first; treat it as the base repo.
    const mainWorktreePath = worktrees[0]?.path || repoRoot;
    const liveNodes: LiveNodeWorkspaceLike[] = nodes.map(n => ({ workspace: n.workspace, repoRoot: n.repoRoot }));
    const orphans = detectOrphanWorktrees(worktrees, liveNodes, mainWorktreePath);
    if (orphans.length === 0) return [];

    // Re-emit guard: skip a worktreePath already signalled in the recent window so the
    // hourly sweep is idempotent and does not flood the ledger with duplicates.
    let recentPaths = new Set<string>();
    try {
        const recent = readLedgerEntries(mesh.id, { kind: ['worktree_cleanup_candidate'], tail: ORPHAN_DEDUPE_WINDOW });
        for (const e of recent) {
            const p = typeof e.payload?.worktreePath === 'string' ? e.payload.worktreePath : '';
            if (p) recentPaths.add(p);
        }
    } catch {
        recentPaths = new Set();
    }

    const signalled: string[] = [];
    for (const wt of orphans) {
        if (recentPaths.has(wt.path)) continue;
        try {
            appendLedgerEntry(mesh.id, {
                kind: 'worktree_cleanup_candidate',
                payload: {
                    worktreePath: wt.path,
                    reason: 'no_matching_live_node',
                    state: 'cleanup_candidate',
                    detectedAt: new Date(now).toISOString(),
                },
            });
            signalled.push(wt.path);
        } catch (e: any) {
            LOG.warn('DiskRetention', `Failed to record orphan worktree signal for ${wt.path}: ${e?.message || e}`);
        }
    }
    if (signalled.length > 0) {
        LOG.info('DiskRetention', `Detected ${signalled.length} orphan worktree(s) for mesh ${mesh.id} (cleanup_candidate — NOT deleted): ${signalled.join(', ')}`);
    }
    return signalled;
}
