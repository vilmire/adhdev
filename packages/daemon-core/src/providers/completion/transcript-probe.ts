/**
 * SQLite transcript probing for provider-session-id discovery (Phase 3 of the
 * completion-engine rewrite — moved out of CliProviderInstance, where raw
 * SQLite plumbing had no business living on the provider lifecycle object).
 *
 * A provider spec may declare a `sessionIdProbe` pointing at the provider's
 * own on-disk SQLite store (e.g. a conversations DB); these helpers run that
 * read-only lookup with a tiny per-instance connection cache. Fail-open
 * throughout: any error resets the cache and returns null — a broken probe
 * must never wedge status or completion.
 */

import * as fs from 'fs';
import { getDatabaseSync } from '../cli-provider-status-helpers.js';

type SqliteDbLike = {
    prepare(query: string): { get(...params: Array<string | number>): unknown };
    close(): void;
};

/** Per-instance probe state: one cached read-only connection + a missing-file backoff. */
export interface SqliteProbeCache {
    db: SqliteDbLike | null;
    dbPath: string | null;
    missingUntil: number;
}

export function createSqliteProbeCache(): SqliteProbeCache {
    return { db: null, dbPath: null, missingUntil: 0 };
}

export function closeSqliteProbeCache(cache: SqliteProbeCache): void {
    try { cache.db?.close(); } catch { /* noop */ }
    cache.db = null;
    cache.dbPath = null;
}

/** workingDir plus its realpath (symlinked workspaces must match either form). */
export function probeDirectoriesFor(workingDir: string): string[] {
    const dirs = new Set<string>();
    const addDir = (value: string | null | undefined) => {
        const normalized = typeof value === 'string' ? value.trim() : '';
        if (normalized) dirs.add(normalized);
    };
    addDir(workingDir);
    try {
        addDir(fs.realpathSync.native(workingDir));
    } catch {
        // noop
    }
    return Array.from(dirs);
}

export function sqlPlaceholderList(count: number): string {
    return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Run a single-row probe query returning the session id column `id`.
 * Reuses the cached connection while dbPath is unchanged; any error closes
 * and clears the cache so the next tick retries fresh.
 */
export function querySqliteSessionId(
    cache: SqliteProbeCache,
    dbPath: string,
    query: string,
    params: Array<string | number>,
): string | null {
    try {
        if (cache.db === null || cache.dbPath !== dbPath) {
            closeSqliteProbeCache(cache);
            const DatabaseSync = getDatabaseSync();
            cache.db = new DatabaseSync(dbPath, { readOnly: true }) as SqliteDbLike;
            cache.dbPath = dbPath;
        }
        const row = cache.db.prepare(query).get(...params) as { id?: unknown } | undefined;
        const sessionId = typeof row?.id === 'string' ? row.id.trim() : '';
        return sessionId || null;
    } catch {
        closeSqliteProbeCache(cache);
        return null;
    }
}
