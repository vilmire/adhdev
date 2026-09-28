/**
 * seqscribe.db space maintenance — freelist stats, bounded incremental
 * vacuum on the live connection, and a one-time offline compaction at
 * daemon shutdown.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `writer-gc.ts` prunes `session.*.chat` (and the removed `.transcript`) rows with the vendor's
 * `Node.pruneTopic`, which DELETEs `sq_log` rows. A DELETE frees pages inside
 * the file but never shrinks it, and seqscribe.db was created with
 * `auto_vacuum = NONE`, so without this module the freed space stays on disk
 * forever (measured on a preview copy 2026-09-27: 543 MB file, 127 MB of it
 * freelist, 318 MB of transcript rows from the 09-24..25 republish bug).
 *
 * Two layers:
 *   1. Online (`createSeqscribeDbMaintenance`) — read-only discovery queries
 *      plus `PRAGMA incremental_vacuum(N)` in small, bounded steps on the
 *      node's own connection. Incremental vacuum only does anything once the
 *      DB is in `auto_vacuum = INCREMENTAL` mode.
 *   2. Offline (`compactSeqscribeDbAtShutdown`) — after the node closed and
 *      released its owner lock, convert `auto_vacuum` to INCREMENTAL with a
 *      full VACUUM (the only way SQLite changes that mode on an existing DB),
 *      gated on a freelist threshold, a size cap and free disk space. Once
 *      converted, later shutdowns only run a plain incremental vacuum.
 *
 * Neither layer touches rows: all row deletion goes through the library's
 * own `pruneTopic` (never raw SQL DELETE), so contig/chain bookkeeping stays
 * the library's business.
 */

import { existsSync, statSync, statfsSync } from 'fs';
import { dirname } from 'path';
import type BetterSqlite3 from 'better-sqlite3';
import { formatBytes } from '../diagnostics/disk-space-preflight.js';
import { LOG } from '../logging/logger.js';
import { loadBetterSqlite3 } from '../system/load-better-sqlite3.js';

/** Freelist bytes at or above which a shutdown compaction runs. */
export const SEQSCRIBE_COMPACT_MIN_FREE_BYTES = 64 * 1024 * 1024;
/** Freelist share of the file at or above which a shutdown compaction runs (with a small absolute floor, below). */
export const SEQSCRIBE_COMPACT_MIN_FREE_RATIO = 0.25;
/** Absolute floor for the ratio trigger — a tiny DB with 30% of 200 KB free is not worth a VACUUM. */
export const SEQSCRIBE_COMPACT_RATIO_FLOOR_BYTES = 4 * 1024 * 1024;
/**
 * Largest file a shutdown VACUUM will rewrite. VACUUM is synchronous and
 * cannot be interrupted from better-sqlite3, so the size cap is what bounds
 * the time it can add to shutdown (a few seconds per GB on an SSD). Larger
 * files are left for `scripts/preview-data-hygiene.mjs` (offline).
 */
export const SEQSCRIBE_COMPACT_MAX_DB_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * Free-disk multiple of the file size required before a VACUUM: it writes a
 * temp copy of the live pages AND (in WAL mode) the rewritten pages into the
 * WAL before the checkpoint folds them back.
 */
export const SEQSCRIBE_COMPACT_FREE_DISK_MULTIPLE = 2;

/** `PRAGMA auto_vacuum` numeric values. */
const AUTO_VACUUM_MODES = ['none', 'full', 'incremental'] as const;
export type SeqscribeAutoVacuumMode = (typeof AUTO_VACUUM_MODES)[number];

export interface SeqscribeFreelistStats {
    pageSize: number;
    pageCount: number;
    freelistCount: number;
    /** pageCount * pageSize — the logical DB size (the WAL is not included). */
    fileBytes: number;
    /** freelistCount * pageSize. */
    freeBytes: number;
    autoVacuum: SeqscribeAutoVacuumMode;
}

export interface SeqscribeIncrementalVacuumStep {
    /** Pages returned to the OS by this step (freelist before - after). */
    freedPages: number;
    /** Freelist pages still left after this step. */
    remainingFreePages: number;
}

/**
 * Maintenance surface on the live node's connection. Every method is a
 * no-op / null once the connection is closed, and none throws — callers are
 * background housekeeping.
 */
export interface SeqscribeDbMaintenance {
    freelistStats(): SeqscribeFreelistStats | null;
    /**
     * Distinct topics that have a writer head in `sq_writers` whose name
     * matches the SQL LIKE `pattern`. `sq_writers` (one row per topic ×
     * writer) is used instead of a DISTINCT scan over `sq_log` because every
     * durable `sq_log` row belongs to a writer head, and the head table is
     * orders of magnitude smaller. Read-only.
     */
    storedTopicsLike(pattern: string): string[];
    /**
     * Whether `topic` has anything a `pruneTopic` call with these bounds
     * could remove: more than `keepNewest` rows, or its oldest row's
     * physical HLC is below `olderThanEpochMs`. Two index lookups; read-only.
     */
    topicHasPrunableRows(topic: string, bounds: { keepNewest: number; olderThanEpochMs: number }): boolean;
    /**
     * `PRAGMA incremental_vacuum(maxPages)` — at most `maxPages` pages per
     * call so one step never stalls the event loop for long. Returns null
     * when the DB is not in INCREMENTAL mode (the pragma is a no-op there).
     */
    incrementalVacuumStep(maxPages: number): SeqscribeIncrementalVacuumStep | null;
    /** `PRAGMA wal_checkpoint(mode)`; null on failure. */
    checkpoint(mode: 'PASSIVE' | 'TRUNCATE'): { busy: number; log: number; checkpointed: number } | null;
}

function readAutoVacuum(db: BetterSqlite3.Database): SeqscribeAutoVacuumMode {
    const raw = Number(db.pragma('auto_vacuum', { simple: true }));
    return AUTO_VACUUM_MODES[raw] ?? 'none';
}

function readFreelistStats(db: BetterSqlite3.Database): SeqscribeFreelistStats {
    const pageSize = Number(db.pragma('page_size', { simple: true }));
    const pageCount = Number(db.pragma('page_count', { simple: true }));
    const freelistCount = Number(db.pragma('freelist_count', { simple: true }));
    return {
        pageSize,
        pageCount,
        freelistCount,
        fileBytes: pageCount * pageSize,
        freeBytes: freelistCount * pageSize,
        autoVacuum: readAutoVacuum(db),
    };
}

function errText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function createSeqscribeDbMaintenance(db: BetterSqlite3.Database): SeqscribeDbMaintenance {
    const open = (): boolean => {
        try {
            return db.open;
        } catch {
            return false;
        }
    };
    return {
        freelistStats() {
            if (!open()) return null;
            try {
                return readFreelistStats(db);
            } catch (error) {
                LOG.debug('Seqscribe', `maintenance freelistStats failed: ${errText(error)}`);
                return null;
            }
        },
        storedTopicsLike(pattern) {
            if (!open()) return [];
            try {
                const rows = db
                    .prepare('SELECT DISTINCT topic FROM sq_writers WHERE topic LIKE ?')
                    .all(pattern) as { topic: string }[];
                return rows.map((r) => r.topic).filter((t) => typeof t === 'string');
            } catch (error) {
                LOG.debug('Seqscribe', `maintenance storedTopicsLike failed: ${errText(error)}`);
                return [];
            }
        },
        topicHasPrunableRows(topic, bounds) {
            if (!open()) return false;
            try {
                const beyond = db
                    .prepare('SELECT rowid FROM sq_log WHERE topic = ? LIMIT 1 OFFSET ?')
                    .get(topic, Math.max(0, Math.floor(bounds.keepNewest)));
                if (beyond !== undefined) return true;
                const oldest = db
                    .prepare('SELECT MIN(hlc_l) AS minL FROM sq_log WHERE topic = ?')
                    .get(topic) as { minL: number | null } | undefined;
                return oldest?.minL != null && oldest.minL < bounds.olderThanEpochMs;
            } catch (error) {
                LOG.debug('Seqscribe', `maintenance topicHasPrunableRows failed topic=${topic}: ${errText(error)}`);
                return false;
            }
        },
        incrementalVacuumStep(maxPages) {
            if (!open()) return null;
            try {
                if (readAutoVacuum(db) !== 'incremental') return null;
                const before = Number(db.pragma('freelist_count', { simple: true }));
                if (before === 0) return { freedPages: 0, remainingFreePages: 0 };
                const pages = Math.max(1, Math.floor(maxPages));
                // `.pragma()` steps the statement to completion, which is what
                // makes incremental_vacuum actually free pages.
                db.pragma(`incremental_vacuum(${pages})`);
                const after = Number(db.pragma('freelist_count', { simple: true }));
                return { freedPages: Math.max(0, before - after), remainingFreePages: after };
            } catch (error) {
                LOG.debug('Seqscribe', `maintenance incremental_vacuum failed: ${errText(error)}`);
                return null;
            }
        },
        checkpoint(mode) {
            if (!open()) return null;
            try {
                const rows = db.pragma(`wal_checkpoint(${mode})`) as { busy: number; log: number; checkpointed: number }[];
                return rows[0] ?? null;
            } catch (error) {
                LOG.debug('Seqscribe', `maintenance checkpoint(${mode}) failed: ${errText(error)}`);
                return null;
            }
        },
    };
}

// ─── Offline shutdown compaction ────────────────────────────────────────────

export type SeqscribeCompactionAction = 'skipped' | 'converted' | 'incremental' | 'failed';

export interface SeqscribeCompactionReport {
    action: SeqscribeCompactionAction;
    reason: string;
    /** On-disk bytes (db + wal) before / after. Null when the file was never opened. */
    beforeBytes: number | null;
    afterBytes: number | null;
    before: SeqscribeFreelistStats | null;
    after: SeqscribeFreelistStats | null;
}

export interface SeqscribeCompactionOptions {
    minFreeBytes?: number;
    minFreeRatio?: number;
    ratioFloorBytes?: number;
    maxDbBytes?: number;
    /** Free bytes available on the DB's volume. Injected for tests; defaults to statfs. */
    freeDiskBytes?: (dir: string) => number | null;
}

function onDiskBytes(dbPath: string): number {
    let total = 0;
    for (const p of [dbPath, `${dbPath}-wal`]) {
        try {
            total += statSync(p).size;
        } catch {
            /* absent */
        }
    }
    return total;
}

function defaultFreeDiskBytes(dir: string): number | null {
    try {
        const s = statfsSync(dir);
        return Number(s.bavail) * Number(s.bsize);
    } catch {
        return null;
    }
}

/** Whether a freelist is large enough to be worth compacting. */
export function seqscribeFreelistOverThreshold(
    stats: Pick<SeqscribeFreelistStats, 'fileBytes' | 'freeBytes'>,
    opts: Pick<SeqscribeCompactionOptions, 'minFreeBytes' | 'minFreeRatio' | 'ratioFloorBytes'> = {},
): boolean {
    const minFreeBytes = opts.minFreeBytes ?? SEQSCRIBE_COMPACT_MIN_FREE_BYTES;
    const minFreeRatio = opts.minFreeRatio ?? SEQSCRIBE_COMPACT_MIN_FREE_RATIO;
    const ratioFloor = opts.ratioFloorBytes ?? SEQSCRIBE_COMPACT_RATIO_FLOOR_BYTES;
    if (stats.freeBytes <= 0) return false;
    if (stats.freeBytes >= minFreeBytes) return true;
    return stats.fileBytes > 0 && stats.freeBytes >= ratioFloor && stats.freeBytes / stats.fileBytes >= minFreeRatio;
}

/**
 * Compact seqscribe.db after the node closed. Call ONLY after
 * `SeqscribeNodeHandle.close()` resolved — it re-takes the library's
 * cross-process owner lock (`<db>.lock`, BEGIN EXCLUSIVE, no wait) for the
 * duration, so a daemon that already started on the same file makes this a
 * skip, never a race.
 *
 * - freelist below threshold → skip (nothing worth reclaiming);
 * - `auto_vacuum` already INCREMENTAL → `PRAGMA incremental_vacuum` (all);
 * - otherwise, one-time migration: `PRAGMA auto_vacuum = INCREMENTAL` +
 *   `VACUUM`, only when the file is ≤ `maxDbBytes` and the volume has
 *   ≥ `SEQSCRIBE_COMPACT_FREE_DISK_MULTIPLE` × the file size free.
 *
 * Always ends with `wal_checkpoint(TRUNCATE)`. Never throws: a failure is
 * logged and reported as `action: 'failed'` so shutdown continues.
 */
export function compactSeqscribeDbAtShutdown(
    dbPath: string,
    opts: SeqscribeCompactionOptions = {},
): SeqscribeCompactionReport {
    const report = (
        action: SeqscribeCompactionAction,
        reason: string,
        extra: Partial<SeqscribeCompactionReport> = {},
    ): SeqscribeCompactionReport => ({
        action,
        reason,
        beforeBytes: null,
        afterBytes: null,
        before: null,
        after: null,
        ...extra,
    });

    if (!existsSync(dbPath)) return report('skipped', 'no seqscribe.db');

    let Database: typeof BetterSqlite3;
    try {
        Database = loadBetterSqlite3();
    } catch (error) {
        return report('failed', `better-sqlite3 unavailable: ${errText(error)}`);
    }

    let lockDb: BetterSqlite3.Database | null = null;
    let db: BetterSqlite3.Database | null = null;
    const beforeBytes = onDiskBytes(dbPath);
    try {
        // Same owner-lock protocol the library uses (adapters.ts): BEGIN
        // EXCLUSIVE on the sibling `.lock` DB. `timeout: 0` = fail at once if
        // another process (a restarted daemon) already owns the file.
        try {
            lockDb = new Database(`${dbPath}.lock`, { timeout: 0 });
            lockDb.exec('BEGIN EXCLUSIVE');
        } catch (error) {
            try {
                lockDb?.close();
            } catch {
                /* noop */
            }
            lockDb = null;
            return report('skipped', `owner lock held by another process (${errText(error)})`, { beforeBytes });
        }

        db = new Database(dbPath, { timeout: 1_000 });
        db.pragma('wal_checkpoint(TRUNCATE)');
        const before = readFreelistStats(db);
        const base = { beforeBytes, before };

        if (!seqscribeFreelistOverThreshold(before, opts)) {
            return report('skipped', `freelist ${formatBytes(before.freeBytes)} below threshold`, {
                ...base,
                afterBytes: onDiskBytes(dbPath),
                after: before,
            });
        }

        const startedAt = Date.now();
        let action: SeqscribeCompactionAction;
        if (before.autoVacuum === 'incremental') {
            db.pragma('incremental_vacuum');
            action = 'incremental';
        } else {
            const maxDbBytes = opts.maxDbBytes ?? SEQSCRIBE_COMPACT_MAX_DB_BYTES;
            if (before.fileBytes > maxDbBytes) {
                return report(
                    'skipped',
                    `file ${formatBytes(before.fileBytes)} exceeds the shutdown VACUUM cap ${formatBytes(maxDbBytes)} — run scripts/preview-data-hygiene.mjs offline`,
                    base,
                );
            }
            const needed = SEQSCRIBE_COMPACT_FREE_DISK_MULTIPLE * before.fileBytes;
            const freeDisk = (opts.freeDiskBytes ?? defaultFreeDiskBytes)(dirname(dbPath));
            if (freeDisk === null || freeDisk < needed) {
                return report(
                    'skipped',
                    `insufficient free disk for VACUUM (free ${freeDisk === null ? 'unknown' : formatBytes(freeDisk)}, need ${formatBytes(needed)})`,
                    base,
                );
            }
            // auto_vacuum on an existing DB only changes through a VACUUM.
            db.pragma('auto_vacuum = INCREMENTAL');
            db.exec('VACUUM');
            action = 'converted';
        }
        db.pragma('wal_checkpoint(TRUNCATE)');
        const after = readFreelistStats(db);
        const afterBytes = onDiskBytes(dbPath);
        LOG.info(
            'Seqscribe',
            `seqscribe.db compaction (${action}) ${formatBytes(beforeBytes)} → ${formatBytes(afterBytes)} ` +
                `(freelist ${formatBytes(before.freeBytes)} → ${formatBytes(after.freeBytes)}, auto_vacuum ${before.autoVacuum} → ${after.autoVacuum}, ${Date.now() - startedAt} ms)`,
        );
        return report(action, 'freelist over threshold', { ...base, after, afterBytes });
    } catch (error) {
        LOG.warn('Seqscribe', `seqscribe.db compaction failed (ignored): ${errText(error)}`);
        return report('failed', errText(error), { beforeBytes });
    } finally {
        try {
            db?.close();
        } catch {
            /* noop */
        }
        try {
            lockDb?.exec('ROLLBACK');
        } catch {
            /* noop */
        }
        try {
            lockDb?.close();
        } catch {
            /* noop */
        }
    }
}
