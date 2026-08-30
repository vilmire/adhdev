/**
 * Mesh ledger read cache, SQLite read path, and full-scan observability.
 *
 * Pure move out of mesh-ledger.ts (file-size gate). This is the module the
 * LEDGER-READ-AMPLIFICATION fix concentrates in: the cache below is what stands
 * between the daemon's 16 standing ledger read paths and a full
 * `SELECT * FROM mesh_event_ledger` + payload re-parse on every call.
 *
 * mesh-ledger.ts imports from here (never the reverse) — the ledger's write paths
 * call recordLedgerAppend/invalidateLedgerCache, and its read paths call
 * getCachedRawEntries/readLedgerFromStore.
 */
import { existsSync, readFileSync } from 'fs';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { registerLedgerBulkChangeListener } from './mesh-runtime-store-turn-rows.js';
import { LOG } from '../logging/logger.js';
import { getLedgerPath } from './mesh-ledger-paths.js';
// Type-only import: erased at compile time, so it creates no runtime import cycle
// with mesh-ledger.ts (which imports this module's values).
import type { MeshLedgerEntry, MeshLedgerKind } from './mesh-ledger.js';

/**
 * Resolve an entry's task id — the explicit `taskId` field, else `payload.taskId`
 * for legacy rows written before the column existed (LEDGER-TASK-TRACEABILITY (B)).
 * Lives here rather than in mesh-ledger.ts because the store/JSONL read paths below
 * need it and cannot import values from mesh-ledger without closing a cycle;
 * mesh-ledger re-exports it to preserve its public surface.
 */
export function ledgerEntryTaskId(entry: Pick<MeshLedgerEntry, 'taskId' | 'payload'>): string | undefined {
    if (typeof entry.taskId === 'string' && entry.taskId.trim()) return entry.taskId.trim();
    const fromPayload = entry.payload && typeof entry.payload === 'object' ? (entry.payload as Record<string, unknown>).taskId : undefined;
    return typeof fromPayload === 'string' && fromPayload.trim() ? fromPayload.trim() : undefined;
}

// ─── Ledger Read Cache ─────────────────────────
// Absorbs repeated reads across the daemon's standing read paths (parity loop,
// read-model consumers, mesh-status, routing, idle reminder, refine guards — 16
// call sites) so a full ledger scan is rare rather than per-call.
//
// LEDGER-READ-AMPLIFICATION (2026-08-27, live incident — daemon CPU spin at 100%):
// this cache previously used a 100ms TTL and was INVALIDATED on every write. On a
// mesh whose ledger had grown to ~78.5k rows, appends arrived more often than every
// 100ms, so the cache never survived to serve a second read: effectively every one
// of the 16 read paths re-ran `SELECT * FROM mesh_event_ledger` and re-parsed 78.5k
// payload JSON blobs. A CPU profile attributed ~40% of daemon JS time to
// readLedgerEntriesOrdered + its parse callback, plus 15% GC from the churn.
//
// The fix is to make invalidation PRECISE instead of blunt, which in turn makes a
// long TTL safe:
//   - Local appends (appendLedgerEntry / appendRemoteLedgerEntries) EXTEND the
//     cached array in place instead of dropping it. See appendToLedgerCache: an
//     entry is appended only when it sorts at or after the cached tail under the
//     store's (timestamp ASC, insertion ASC) order, which is exactly the ordering
//     readLedgerEntriesOrdered returns. An out-of-order entry — possible only for
//     remote batches, whose timestamps are authored on another node — falls back to
//     invalidation, so the next read re-reads in true store order.
//   - Every other mutation (compaction, prune, retention sweep, deletion, test
//     reset) still invalidates outright.
// With no write path able to leave the cache stale, the TTL is a staleness bound of
// last resort rather than the correctness mechanism, so it is 30s.
//
// The ordering contract matters beyond performance: mesh-events relies on the
// positional order of same-millisecond entries. appendToLedgerCache preserves it by
// only ever pushing onto the tail — the same position the store's `rowid ASC`
// tiebreak would give a freshly-inserted row.

const ledgerReadCache = new Map<string, { entries: MeshLedgerEntry[]; cachedAt: number }>();
const filteredLedgerReadCache = new Map<string, Map<string, { entries: MeshLedgerEntry[]; cachedAt: number }>>();
const LEDGER_CACHE_TTL_MS = 30_000;

export function readLedgerFile(meshId: string): MeshLedgerEntry[] {
    const filePath = getLedgerPath(meshId);
    if (!existsSync(filePath)) return [];
    let content: string;
    try { content = readFileSync(filePath, 'utf-8'); } catch { return []; }
    const entries: MeshLedgerEntry[] = [];
    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line) as MeshLedgerEntry;
            if (entry.id && entry.kind) {
                // LEDGER-TASK-TRACEABILITY (B): backfill the base taskId from
                // payload.taskId for legacy JSONL lines that predate the field.
                if (!entry.taskId) {
                    const derived = ledgerEntryTaskId(entry);
                    if (derived) entry.taskId = derived;
                }
                entries.push(entry);
            }
        } catch { /* skip malformed lines */ }
    }
    return entries;
}

// ─── G2: One-Time JSONL → SQLite Import ─────────
// On the first SQLite read for a mesh (per store instance), import any legacy
// JSONL entries into mesh_event_ledger. INSERT OR IGNORE makes this idempotent:
// dual-written entries are skipped, only pre-cutover legacy entries are added.
// Keyed by the store instance so MeshRuntimeStore.resetForTests() (fresh DB)
// naturally re-imports.

let ledgerImportStoreRef: MeshRuntimeStore | undefined;
const ledgerImportDone = new Set<string>();

export function ensureLedgerImported(store: MeshRuntimeStore, meshId: string): void {
    if (ledgerImportStoreRef !== store) {
        ledgerImportDone.clear();
        ledgerImportStoreRef = store;
    }
    if (ledgerImportDone.has(meshId)) return;
    ledgerImportDone.add(meshId);
    const fileEntries = readLedgerFile(meshId);
    if (fileEntries.length === 0) return;
    try {
        store.importLedgerEntries(fileEntries.map(e => ({
            id: e.id,
            meshId: e.meshId,
            timestamp: e.timestamp,
            kind: e.kind,
            nodeId: e.nodeId ?? null,
            sessionId: e.sessionId ?? null,
            providerType: e.providerType ?? null,
            taskId: ledgerEntryTaskId(e) ?? null,
            payload: e.payload ?? {},
        })));
    } catch { /* import is best-effort; reads fall back to JSONL on store failure */ }
}

export function readLedgerFromStore(meshId: string, opts?: { since?: string; kinds?: string[]; tail?: number }): MeshLedgerEntry[] {
    const store = MeshRuntimeStore.getInstance();
    ensureLedgerImported(store, meshId);
    return store.readLedgerEntriesOrdered(meshId, opts).map(r => {
        const payload = (r.payload && typeof r.payload === 'object' ? r.payload : {}) as Record<string, unknown>;
        // LEDGER-TASK-TRACEABILITY (B): prefer the column, fall back to payload.taskId
        // for legacy rows written before the column existed (back-compat join).
        const taskId = ledgerEntryTaskId({ taskId: r.taskId ?? undefined, payload });
        return {
            id: r.id,
            meshId: r.meshId,
            timestamp: r.timestamp,
            kind: r.kind as MeshLedgerKind,
            ...(r.nodeId ? { nodeId: r.nodeId } : {}),
            ...(r.sessionId ? { sessionId: r.sessionId } : {}),
            ...(r.providerType ? { providerType: r.providerType } : {}),
            ...(taskId ? { taskId } : {}),
            payload,
        };
    });
}

// ─── Full-scan observability (LEDGER-READ-AMPLIFICATION) ────────────────────
// The read amplification above was silent: nothing counted how often a full ledger
// scan ran or how many rows it parsed, so a daemon burning 40% of its CPU on
// re-parsing the same 78.5k rows looked identical to a healthy one. These counters
// close that gap. Content-free by construction — scan counts and row counts only,
// never entry payloads (see the server content boundary in CLAUDE.md).

const ledgerScanStats = {
    fullScans: 0,
    scannedRows: 0,
    /** Cold reads served by SQL pushdown (bounded) rather than a full scan. */
    pushdownScans: 0,
    pushdownRows: 0,
    windowStartedAt: Date.now(),
    lastSummaryAt: Date.now(),
};

const LEDGER_SCAN_SUMMARY_INTERVAL_MS = 60_000;

/** Test/diagnostic accessor for the full-scan counters. */
export function getLedgerScanStats(): {
    fullScans: number;
    scannedRows: number;
    pushdownScans: number;
    pushdownRows: number;
    windowMs: number;
} {
    return {
        fullScans: ledgerScanStats.fullScans,
        scannedRows: ledgerScanStats.scannedRows,
        pushdownScans: ledgerScanStats.pushdownScans,
        pushdownRows: ledgerScanStats.pushdownRows,
        windowMs: Date.now() - ledgerScanStats.windowStartedAt,
    };
}

/** Test helper: reset the full-scan counters so a test can assert on a clean window. */
export function __resetLedgerScanStatsForTests(): void {
    ledgerScanStats.fullScans = 0;
    ledgerScanStats.scannedRows = 0;
    ledgerScanStats.pushdownScans = 0;
    ledgerScanStats.pushdownRows = 0;
    ledgerScanStats.windowStartedAt = Date.now();
    ledgerScanStats.lastSummaryAt = Date.now();
}

export function recordLedgerFullScan(rowCount: number): void {
    ledgerScanStats.fullScans++;
    ledgerScanStats.scannedRows += rowCount;
    maybeSummarizeLedgerScans();
}

export function recordLedgerPushdownScan(rowCount: number): void {
    ledgerScanStats.pushdownScans++;
    ledgerScanStats.pushdownRows += rowCount;
    maybeSummarizeLedgerScans();
}

/**
 * Emit a periodic (≤1/min) summary of ledger scan volume, then start a fresh
 * window. Logged at info so it lands in the daemon log without a debug flag —
 * this is the signal that would have made the CPU spin self-evident.
 */
function maybeSummarizeLedgerScans(): void {
    const now = Date.now();
    if (now - ledgerScanStats.lastSummaryAt < LEDGER_SCAN_SUMMARY_INTERVAL_MS) return;
    const windowMs = now - ledgerScanStats.windowStartedAt;
    const { fullScans, scannedRows, pushdownScans, pushdownRows } = ledgerScanStats;
    if (fullScans > 0 || pushdownScans > 0) {
        LOG.info(
            'MeshLedger',
            `Ledger scans in last ${Math.round(windowMs / 1000)}s: ${fullScans} full (${scannedRows} rows parsed), ` +
            `${pushdownScans} SQL-bounded (${pushdownRows} rows)`,
        );
    }
    ledgerScanStats.fullScans = 0;
    ledgerScanStats.scannedRows = 0;
    ledgerScanStats.pushdownScans = 0;
    ledgerScanStats.pushdownRows = 0;
    ledgerScanStats.windowStartedAt = now;
    ledgerScanStats.lastSummaryAt = now;
}

// ─── Cache accessors ────────────────────────────

/** Live (non-expired) cache entry for a mesh, or undefined. */
export function liveCacheEntry(meshId: string): { entries: MeshLedgerEntry[]; cachedAt: number } | undefined {
    const cached = ledgerReadCache.get(meshId);
    if (!cached) return undefined;
    if (Date.now() - cached.cachedAt >= LEDGER_CACHE_TTL_MS) return undefined;
    return cached;
}

export function getCachedRawEntries(meshId: string): MeshLedgerEntry[] {
    const cached = liveCacheEntry(meshId);
    if (cached) return cached.entries;
    let entries: MeshLedgerEntry[];
    try {
        // G2: SQLite mesh_event_ledger is the primary runtime read path.
        entries = readLedgerFromStore(meshId);
    } catch {
        // Store unavailable — fall back to the JSONL export artifact.
        entries = readLedgerFile(meshId);
    }
    recordLedgerFullScan(entries.length);
    ledgerReadCache.set(meshId, { entries, cachedAt: Date.now() });
    return entries;
}

/**
 * Build a stable key for a bounded SQL read. Kinds are a set for query semantics,
 * so sorting and de-duplicating prevents argument order (or duplicates) from
 * creating distinct cache entries.
 */
function filteredLedgerCacheKey(opts: { since?: string; kinds?: string[] }): string {
    const kinds = opts.kinds ? [...new Set(opts.kinds)].sort() : [];
    return JSON.stringify([opts.since ?? null, kinds]);
}

/**
 * Read and cache a filtered SQL result without ever placing that subset in the
 * full-ledger cache. Store failures are allowed to escape so the caller can use
 * the existing full-read/JSONL fallback path.
 */
export function getCachedFilteredRawEntries(
    meshId: string,
    opts: { since?: string; kinds?: string[] },
): MeshLedgerEntry[] {
    const key = filteredLedgerCacheKey(opts);
    let meshCache = filteredLedgerReadCache.get(meshId);
    if (meshCache) {
        const now = Date.now();
        for (const [cachedKey, entry] of meshCache) {
            if (now - entry.cachedAt >= LEDGER_CACHE_TTL_MS) meshCache.delete(cachedKey);
        }
        if (meshCache.size === 0) {
            filteredLedgerReadCache.delete(meshId);
            meshCache = undefined;
        }
    }
    const cached = meshCache?.get(key);
    if (cached) return cached.entries;

    const entries = readLedgerFromStore(meshId, opts);
    recordLedgerPushdownScan(entries.length);
    const targetCache = meshCache ?? new Map<string, { entries: MeshLedgerEntry[]; cachedAt: number }>();
    targetCache.set(key, { entries, cachedAt: Date.now() });
    if (!meshCache) filteredLedgerReadCache.set(meshId, targetCache);
    return entries;
}

function invalidateFilteredLedgerCache(meshId: string): void {
    filteredLedgerReadCache.delete(meshId);
}

/**
 * Order key for the cached array, mirroring readLedgerEntriesOrdered's
 * `ORDER BY timestamp ASC, rowid ASC`. A cached entry may be appended in place
 * only when the new entry sorts at or after the current tail — i.e. when pushing
 * it lands it in the same position a fresh store read would.
 */
function entryTimeValue(entry: MeshLedgerEntry): number {
    const t = new Date(entry.timestamp).getTime();
    // A malformed timestamp has no defined position; treat it as un-appendable so
    // the caller falls back to invalidation rather than guessing.
    return Number.isNaN(t) ? NaN : t;
}

/**
 * Incrementally extend the cached entry list instead of dropping it.
 *
 * Returns true when every entry was absorbed (cache still valid and current),
 * false when the caller must invalidate instead. False is returned when:
 *   - there is no live cache to extend (nothing to do — next read repopulates),
 *   - an entry sorts BEFORE the cached tail (a remote batch carrying older
 *     timestamps; its correct position is mid-array, and re-reading in store
 *     order is simpler and safer than splicing), or
 *   - an entry's timestamp is unparseable.
 * Local appends (appendLedgerEntry stamps `new Date()` at write time) are
 * monotonic by construction and therefore always absorbed.
 */
export function appendToLedgerCache(meshId: string, newEntries: MeshLedgerEntry[]): boolean {
    if (newEntries.length === 0) return true;
    const cached = liveCacheEntry(meshId);
    if (!cached) return false;

    let tailTime = cached.entries.length > 0
        ? entryTimeValue(cached.entries[cached.entries.length - 1])
        : -Infinity;
    if (Number.isNaN(tailTime)) return false;

    // Validate the whole batch BEFORE mutating, so a rejected batch cannot leave
    // the cache half-extended.
    for (const entry of newEntries) {
        const t = entryTimeValue(entry);
        if (Number.isNaN(t) || t < tailTime) return false;
        tailTime = t;
    }

    cached.entries.push(...newEntries);
    return true;
}

/**
 * Absorb writes into the cache when the ordering allows, else invalidate.
 * Every ledger write path funnels through here so no path can silently leave a
 * stale cache behind now that the TTL is 30s.
 */
export function recordLedgerAppend(meshId: string, newEntries: MeshLedgerEntry[]): void {
    // A filtered subset is deliberately never extended in place: determining
    // membership and preserving store order is riskier than a bounded re-read.
    invalidateFilteredLedgerCache(meshId);
    if (!appendToLedgerCache(meshId, newEntries)) invalidateLedgerCache(meshId);
}

export function invalidateLedgerCache(meshId: string): void {
    ledgerReadCache.delete(meshId);
    invalidateFilteredLedgerCache(meshId);
}

/**
 * Drop every mesh's cached ledger. Used by mutations that are not scoped to a
 * single mesh — notably the retention sweep's `pruneEventLedger`, which deletes
 * rows across ALL meshes in one statement and has no meshId to invalidate by.
 * Under the previous 100ms TTL a missed invalidation self-healed almost
 * immediately; at 30s it would serve deleted rows, so the sweep must call this.
 */
/**
 * Forget the one-time JSONL→SQLite import flag for a mesh, so the next read
 * re-imports. Used by __clearMeshLedgerForTests and by the append path when a
 * SQLite write fails (the store then self-heals from JSONL).
 */
export function clearLedgerImportFlag(meshId: string): void {
    ledgerImportDone.delete(meshId);
    invalidateFilteredLedgerCache(meshId);
}

export function invalidateAllLedgerCaches(): void {
    ledgerReadCache.clear();
    filteredLedgerReadCache.clear();
}

// Store-level mutations that are not scoped to one mesh — the retention sweep's
// cross-mesh ledger DELETE, and resetForTests swapping the whole database — call
// back through this registration. They live in modules this one imports, so they
// cannot import mesh-ledger directly without closing an import cycle.
registerLedgerBulkChangeListener(invalidateAllLedgerCaches);
