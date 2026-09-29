/**
 * SQLite source of the declarative native-history executor: session pick +
 * message fetch over a read-only better-sqlite3 handle, plus the tiny
 * `where`-clause language spec authors use to filter rows.
 *
 * Split out of native-history-executor.ts (file-size gate).
 */
import * as fs from 'node:fs';
import { loadBetterSqlite3 } from '../../system/load-better-sqlite3.js';
import type { NativeHistorySqliteSource, NativeHistoryMessageMap } from './types.js';
import type { NativeHistoryInput, NativeHistoryResult, NativeHistoryMessage } from './native-history-types.js';
import { expandPath, safeMtimeMs } from './native-history-paths.js';
import { projectMessages, parseTimestamp, jsonPathGet } from './native-history-projection.js';

// ────────────────────────────────────────────────────────────────────────────
// SQLite
// ────────────────────────────────────────────────────────────────────────────

export function executeSqlite(src: NativeHistorySqliteSource, input: NativeHistoryInput): NativeHistoryResult | null {
    const resolved = expandPath(src.path, input);
    if (!resolved || !fs.existsSync(resolved)) return null;

    let Database: any;
    try {
        Database = loadBetterSqlite3();
    } catch { return null; }

    let db: any;
    try { db = new Database(resolved, { readonly: true, fileMustExist: true }); }
    catch { return null; }

    try {
        const requested = input.providerSessionId || '';
        // Resolve the session id the message query runs against. The `requested`
        // pin path is tried first, but a pinned id that has NO rows in the store
        // is not a real session — fall back to the newest-session `session_query`
        // instead of returning empty. This is the hermes read_chat gap: hermes
        // never surfaces its own provider session id to the daemon (the spec
        // declares no session-id extraction and the adapter's screen-scrape is
        // codex-only), so the read pipeline falls back to threading the mesh
        // RUNTIME session id through as `providerSessionId`. That runtime id does
        // not exist in ~/.hermes/state.db, so the old unconditional pin path ran
        // `message_query WHERE session_id = '<runtime id>'` → 0 rows → null, and
        // the answer (physically present under the real cli session) was never
        // returned. Validating the pin by the spec's own `message_query` keeps
        // this schema-agnostic and only rescues the mis-bound-id case: a genuine
        // discovered pin (codex/claude use jsonl sources and never reach here;
        // any real sqlite pin has rows) still short-circuits on its own rows.
        // Expand an anchor session id to every session id in its logical
        // cluster. When the spec declares `session_cluster_query` the anchor is
        // run through it (bound `?`) and each returned row's FIRST column is a
        // cluster member id — typically a WITH RECURSIVE walk up to the cluster
        // root and back down through all descendants, so passing a root, middle,
        // or leaf anchor all resolve the same complete set. The anchor is always
        // included even if the query omits it (defensive) so a spec with no
        // cluster query, or a query that returns nothing, still reads the anchor
        // itself. Absent query → just the anchor (single-session behaviour).
        const resolveClusterIds = (anchorId: string): string[] => {
            const ids = new Set<string>();
            if (anchorId) ids.add(anchorId);
            if (src.session_cluster_query && anchorId) {
                try {
                    const rows: any[] = db.prepare(src.session_cluster_query).all(anchorId);
                    for (const row of rows) {
                        const idRaw = Object.values(row)[0];
                        if (idRaw != null && String(idRaw)) ids.add(String(idRaw));
                    }
                } catch { /* fall back to anchor-only on a malformed cluster query */ }
            }
            return Array.from(ids);
        };

        // Read messages for an anchor's WHOLE cluster, merged and re-sorted by
        // their mapped timestamp so bubbles from different sub-sessions interleave
        // in true chronological order (the turn's final assistant — written into a
        // descendant sub-session in the split-turn case — lands last). No per-session
        // short-circuit: an anchor whose OWN row has zero messages (hermes writes a
        // 0-message intermediate `sessions` row) still yields the cluster's rows,
        // and the whole cluster is scanned rather than stopping at the first
        // non-empty session. Returns null only when the ENTIRE cluster is empty,
        // preserving the pin-validation contract below (a pin that resolves no rows
        // anywhere is a mis-bound id and falls through to newest-session recovery).
        const resolveMessagesFor = (anchorId: string): any[] | null => {
            if (!anchorId) return null;
            const clusterIds = resolveClusterIds(anchorId);
            const merged: any[] = [];
            for (const id of clusterIds) {
                let rows: any[];
                try { rows = db.prepare(src.message_query).all(id); }
                catch { continue; }
                if (rows && rows.length > 0) merged.push(...rows);
            }
            if (merged.length === 0) return null;
            if (clusterIds.length > 1) sortRowsByMappedTimestamp(merged, src.message_map);
            return merged;
        };

        const resolveNewestSessionId = (): string => {
            let sessionRow: any;
            try {
                // session_query may reference `?` to receive the session's
                // start-time floor in seconds (e.g. WHERE started_at >= ?).
                // That gives spec authors a robust way to keep prior-session
                // rows out of a fresh dashboard view without inventing their
                // own time arithmetic in SQL. When the caller didn't pass a
                // session floor (i.e. no live session is associated with the
                // call), we use 0 so spec queries that bind `?` still produce
                // a sane result rather than choking the whole executor.
                const sessionFloorSeconds = typeof input.sessionStartedAtMs === 'number'
                    ? Math.floor(input.sessionStartedAtMs / 1000)
                    : 0;
                // Workspace the daemon spawned this CLI in. A store that keeps
                // the session directory as a column (opencode's
                // `session.directory`) can scope the newest-session pick to this
                // workspace so two concurrent sessions in different workspaces
                // don't cross-bind — the time floor alone can't disambiguate
                // when the OTHER workspace's session was touched more recently.
                const workspaceHint = typeof input.workspace === 'string' ? input.workspace : '';
                const stmt = db.prepare(src.session_query);
                // Binding tiers, tried in order (better-sqlite3 throws when the
                // statement declares params the bind object/args don't satisfy,
                // so each tier is guarded):
                //   1. named { floor, workspace } — spec references @floor/@workspace
                //   2. positional (floor) — legacy single-`?` floor specs
                //   3. no-arg — specs with no bound params
                try {
                    sessionRow = stmt.get({ floor: sessionFloorSeconds, workspace: workspaceHint });
                } catch {
                    try {
                        sessionRow = stmt.get(sessionFloorSeconds);
                    } catch {
                        sessionRow = stmt.get();
                    }
                }
            } catch { return ''; }
            if (!sessionRow) return '';
            // First column of the first row is the session id.
            const sessionIdRaw = Object.values(sessionRow)[0];
            return sessionIdRaw == null ? '' : String(sessionIdRaw);
        };

        let sessionId: string;
        let messageRows: any[] | null;
        if (requested) {
            // Pin path: read the requested session directly and skip the
            // newest-wins `session_query`. hermes ≥0.14 spawns a fresh
            // `sessions` row per internal sub-session, so an unpinned
            // `ORDER BY started_at DESC LIMIT 1` pick drifts to a different id
            // on every read (re-bind churn + reading completion evidence from
            // the wrong session). A pin that resolves rows is authoritative.
            messageRows = resolveMessagesFor(requested);
            if (messageRows) {
                sessionId = requested;
            } else {
                // The pinned id has no rows — it is not a real session in this
                // store (the mis-bound mesh runtime-id case). Recover by letting
                // the spec's own newest-session query self-resolve instead of
                // returning empty.
                sessionId = resolveNewestSessionId();
                messageRows = resolveMessagesFor(sessionId);
            }
        } else {
            sessionId = resolveNewestSessionId();
            messageRows = resolveMessagesFor(sessionId);
        }
        if (!sessionId) return null;
        if (!messageRows || messageRows.length === 0) return null;

        const mtime = safeMtimeMs(resolved);
        const messages: NativeHistoryMessage[] = [];
        for (let i = 0; i < messageRows.length; i += 1) {
            for (const msg of projectMessages(messageRows[i], src.message_map, i, messageRows.length, mtime)) {
                messages.push(msg);
            }
        }
        if (messages.length === 0) return null;

        // Surface the workspace at the result level too (mirrors the jsonl
        // session_meta path) so callers that read result.workspace — not just
        // per-message workspace — see the session directory.
        const resultWorkspace = messages.find(m => m.workspace)?.workspace;

        return {
            messages,
            providerSessionId: sessionId,
            sourcePath: resolved,
            sourceMtimeMs: mtime,
            nativeHistoryCoverage: 'full',
            ...(resultWorkspace ? { workspace: resultWorkspace } : {}),
        };
    } finally {
        try { db.close(); } catch { /* ignore */ }
    }
}

/**
 * Stable-sort merged cluster rows by their mapped timestamp so bubbles read
 * from different sub-sessions interleave in true chronological order. Uses the
 * same `message_map.timestamp_ms` jsonpath + `parseTimestamp` heuristic the
 * projection uses, so the sort key agrees with the receivedAt each row will be
 * given. Rows with no resolvable timestamp keep their pre-sort relative order
 * (stable), and equal timestamps preserve insertion order — both matter because
 * a turn's terminal bubbles can share a sub-second timestamp.
 */
function sortRowsByMappedTimestamp(rows: any[], map: NativeHistoryMessageMap): void {
    if (!map.timestamp_ms) return;
    const keyed = rows.map((row, index) => {
        const parsed = parseTimestamp(jsonPathGet(row, map.timestamp_ms as string));
        return { row, index, ts: parsed == null ? Number.NaN : parsed };
    });
    keyed.sort((a, b) => {
        const aHas = !Number.isNaN(a.ts);
        const bHas = !Number.isNaN(b.ts);
        if (aHas && bHas && a.ts !== b.ts) return a.ts - b.ts;
        // Missing-timestamp rows and ties fall back to original insertion order
        // so the sort stays stable.
        return a.index - b.index;
    });
    for (let i = 0; i < keyed.length; i += 1) rows[i] = keyed[i].row;
}
