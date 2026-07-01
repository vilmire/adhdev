/**
 * SQLite native-history — mis-bound runtime-id fallback (HERMES-TRANSCRIPT-GAP).
 *
 * Root cause of the live read_chat gap:
 *   hermes-cli never surfaces its own provider session id to the daemon. The
 *   spec declares no session-id extraction, and the spec adapter's screen-scrape
 *   (`extractProviderSessionIdFromScreen`) is codex-only. So the daemon's
 *   read pipeline falls back to threading the mesh RUNTIME session id
 *   (e.g. `20260701_...` daemon runtime id) through as `providerSessionId`.
 *   That runtime id does not exist in ~/.hermes/state.db.
 *
 * OLD behaviour: `executeSqlite` unconditionally trusted the pin and ran
 *   `message_query WHERE session_id = '<runtime id>'` → 0 rows → null. A
 *   post-turn read then surfaced only the runtime `user_input_ack` echo with
 *   providerSessionId=null; the assistant answer — physically present under the
 *   real cli session — was never returned.
 *
 * FIX: a pinned id that resolves NO rows is not a real session. The executor
 *   falls back to the spec's own newest-session `session_query` (the same path
 *   an unpinned discovery read takes), which resolves the real cli session and
 *   returns its messages. A genuine pin (rows exist) still short-circuits, so
 *   the hermes ≥0.14 sub-session churn fix is preserved.
 *
 * Scope safety: only hermes-cli uses a `kind:'sqlite'` native source with a
 *   `session_query`; codex/claude/antigravity use `kind:'jsonl'` and never reach
 *   `executeSqlite`, so this fallback cannot affect their session binding.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';
import { loadBetterSqlite3 } from '../../../src/system/load-better-sqlite3.js';

let tmpDir = '';
let dbPath = '';

// Verbatim hermes-cli 4.0 spec sqlite source block (EXISTS + tool_calls + the
// `started_at >= ? - 2` seconds floor). Keep in sync with specs/4.0.json.
function hermesCfg(dbFile: string) {
    return {
        source: {
            kind: 'sqlite' as const,
            path: dbFile,
            session_query:
                "SELECT id FROM sessions WHERE source = 'cli' AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id) AND started_at >= ? - 2 ORDER BY started_at DESC LIMIT 1",
            message_query:
                "SELECT role, COALESCE(NULLIF(content, ''), tool_calls) AS content, CAST(timestamp * 1000 AS INTEGER) AS ts_ms FROM messages WHERE session_id = ? AND ((content IS NOT NULL AND content != '') OR (tool_calls IS NOT NULL AND tool_calls != '')) AND role IN ('user', 'assistant', 'system', 'tool') ORDER BY timestamp ASC, id ASC",
            message_map: {
                role: '$.role',
                content: '$.content',
                timestamp_ms: '$.ts_ms',
            },
        },
    };
}

// The daemon's `spawnedAtMs` (Date.now(), ms) — the executor divides by 1000
// to compare against the seconds `started_at` column. `base` here is seconds.
const base = 1_782_888_463; // seconds, ~2026-07 (matches real state.db magnitude)

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-runtime-id-'));
    dbPath = path.join(tmpDir, 'state.db');

    const Database = loadBetterSqlite3();
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL, message_count INTEGER DEFAULT 0);
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, finish_reason TEXT, timestamp REAL);
    `);
    // A real completed hermes cli session — the one that holds the answer.
    db.prepare('INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, ?)')
        .run('20260701_153807_9da8ba', 'cli', base, 2);
    const insMsg = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
    insMsg.run('20260701_153807_9da8ba', 'user', 'what is 2+2', base + 1);
    insMsg.run('20260701_153807_9da8ba', 'assistant', 'the answer is 4', base + 2);
    db.close();
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('executeSqlite — mis-bound runtime-id fallback', () => {
    it('recovers the real cli session when a mesh runtime id (absent from the DB) is pinned', () => {
        // Exact live failure: the daemon threads the mesh RUNTIME session id in
        // as providerSessionId because hermes never surfaced a real one.
        const result = executeNativeHistory(hermesCfg(dbPath), {
            providerSessionId: '2a358055', // mesh runtime id — not in `sessions`
            // Post-turn read: floor from the registry spawn time (ms). Even the
            // undefined-floor case works (defaults to 0), tested below.
            sessionStartedAtMs: base * 1000,
        });
        // Real session resolved via session_query, NOT the bogus runtime id, and
        // the assistant answer is returned.
        expect(result?.providerSessionId).toBe('20260701_153807_9da8ba');
        expect(result?.messages.map(m => m.content)).toEqual(['what is 2+2', 'the answer is 4']);
    });

    it('recovers even when no session floor is supplied (post-turn, instance gone)', () => {
        // sessionStartedAtMs undefined → floor defaults to 0 → session_query
        // `started_at >= 0 - 2` matches, newest cli session wins.
        const result = executeNativeHistory(hermesCfg(dbPath), {
            providerSessionId: '2a358055',
        });
        expect(result?.providerSessionId).toBe('20260701_153807_9da8ba');
        expect(result?.messages.map(m => m.content)).toContain('the answer is 4');
    });

    it('still honours a genuine pin (id with rows short-circuits, no churn drift)', () => {
        // Regression guard: a REAL pinned id must read THAT session directly and
        // NOT fall through to newest-wins. Add a newer sub-session; the pinned
        // older one must still win.
        const Database = loadBetterSqlite3();
        const db = new Database(dbPath);
        db.prepare('INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, ?)')
            .run('20260701_160000_ffffff', 'cli', base + 900, 1);
        db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
            .run('20260701_160000_ffffff', 'assistant', 'NEWER-should-not-win', base + 901);
        db.close();

        const result = executeNativeHistory(hermesCfg(dbPath), {
            providerSessionId: '20260701_153807_9da8ba', // genuine pin, has rows
            sessionStartedAtMs: base * 1000,
        });
        expect(result?.providerSessionId).toBe('20260701_153807_9da8ba');
        expect(result?.messages.map(m => m.content)).not.toContain('NEWER-should-not-win');
    });

    it('does not invent a session when the pin is absent AND session_query resolves nothing', () => {
        // A far-future floor makes session_query match nothing; a bogus pin must
        // still yield null rather than aliasing an out-of-range session.
        const result = executeNativeHistory(hermesCfg(dbPath), {
            providerSessionId: '2a358055',
            sessionStartedAtMs: (base + 10_000) * 1000, // floor after every session
        });
        expect(result).toBeNull();
    });
});
