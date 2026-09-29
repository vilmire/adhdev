/**
 * SQLite source of the declarative native-history executor: session pick +
 * message fetch over a read-only better-sqlite3 handle, plus the tiny
 * `where`-clause language spec authors use to filter rows.
 *
 * Split out of native-history-executor.ts (file-size gate).
 */
import * as fs from 'node:fs';
import { loadBetterSqlite3 } from '../../system/load-better-sqlite3.js';
import type { NativeHistorySqliteSource } from './types.js';
import type { NativeHistoryInput, NativeHistoryResult, NativeHistoryMessage } from './native-history-types.js';
import { expandPath, safeMtimeMs } from './native-history-paths.js';
import { projectMessages } from './native-history-projection.js';

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
        // instead of returning empty (the mis-bound mesh RUNTIME-id case, where the
        // read pipeline threads a runtime session id through as `providerSessionId`
        // that does not exist in the provider's own store). Validating the pin by
        // the spec's own `message_query` keeps this schema-agnostic: a genuine
        // pin (any real sqlite session has rows) still short-circuits on its own
        // rows.
        const resolveMessagesFor = (sessionId: string): any[] | null => {
            if (!sessionId) return null;
            let rows: any[];
            try { rows = db.prepare(src.message_query).all(sessionId); }
            catch { return null; }
            return rows && rows.length > 0 ? rows : null;
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
            // newest-wins `session_query`, which can drift between reads when the
            // store creates a fresh session row per internal sub-session. A pin
            // that resolves rows is authoritative.
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
