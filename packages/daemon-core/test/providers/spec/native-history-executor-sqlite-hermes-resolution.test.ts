/**
 * SQLite native-history hermes resolution gap (HERMES-TRANSCRIPT-GAP).
 *
 * Two coupled defects in the hermes-cli spec's sqlite `native_history.source`
 * caused `read_chat` to surface zero assistant messages even though the answer
 * was already persisted in ~/.hermes/state.db:
 *
 *   (1) Session resolution filtered on the DENORMALIZED `sessions.message_count`
 *       column (DEFAULT 0). A freshly-started session already has `messages`
 *       rows while `message_count` still lags at 0, so `message_count > 0`
 *       excluded exactly the just-created session → `LIMIT 1` returned nothing →
 *       providerSessionId never resolved. Fixed by an EXISTS check against the
 *       real `messages` rows.
 *
 *   (2) The message query filtered `content IS NOT NULL AND content != ''`.
 *       Assistant turns whose `finish_reason='tool_calls'` persist an EMPTY
 *       `content` (payload lives in the `tool_calls` column), so those turn rows
 *       were dropped. Fixed by accepting rows where content OR tool_calls is
 *       non-empty and projecting `tool_calls` into the content slot when content
 *       is empty.
 *
 * These inline queries mirror the corrected hermes-cli specs/4.0.json exactly;
 * keep them in sync if the shipped spec's queries change.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';
import { loadBetterSqlite3 } from '../../../src/system/load-better-sqlite3.js';

let tmpDir = '';
let dbPath = '';

// Corrected hermes-cli 4.0 spec sqlite source block (post HERMES-TRANSCRIPT-GAP).
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

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-sqlite-res-'));
    dbPath = path.join(tmpDir, 'state.db');

    const Database = loadBetterSqlite3();
    const db = new Database(dbPath);
    // Schema mirrors the real ~/.hermes/state.db columns exercised by the fix:
    // sessions.message_count (denormalized, can lag) and messages.tool_calls
    // (where tool-call turn payloads live when content is empty).
    db.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT,
            started_at REAL,
            message_count INTEGER DEFAULT 0
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            role TEXT,
            content TEXT,
            tool_calls TEXT,
            finish_reason TEXT,
            timestamp REAL
        );
    `);
    db.close();
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function withDb(fn: (db: any) => void) {
    const Database = loadBetterSqlite3();
    const db = new Database(dbPath);
    try { fn(db); } finally { db.close(); }
}

describe('executeSqlite — hermes transcript resolution gap', () => {
    it('resolves a freshly-started session whose message_count still lags at 0', () => {
        const base = 1_700_000_000; // seconds
        withDb(db => {
            // Fresh session: messages rows exist but the denormalized
            // message_count has not been updated yet (still 0). The OLD
            // `message_count > 0` predicate would exclude this session.
            db.prepare('INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, ?)')
                .run('sess_fresh', 'cli', base, 0);
            const insMsg = db.prepare(
                'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
            );
            insMsg.run('sess_fresh', 'user', 'fresh-ask', base + 1);
            insMsg.run('sess_fresh', 'assistant', 'fresh-reply', base + 2);
        });

        const result = executeNativeHistory(hermesCfg(dbPath), {
            // Session floor equal to started_at — the `- 2` grace keeps the
            // just-created session in range despite sub-second rounding.
            sessionStartedAtMs: base * 1000,
        });

        expect(result?.providerSessionId).toBe('sess_fresh');
        expect(result?.messages.map(m => m.content)).toEqual(['fresh-ask', 'fresh-reply']);
    });

    it('surfaces an assistant tool_calls turn with empty content via the tool_calls column', () => {
        const base = 1_700_000_000;
        withDb(db => {
            db.prepare('INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, ?)')
                .run('sess_tool', 'cli', base, 0);
            const ins = db.prepare(
                'INSERT INTO messages (session_id, role, content, tool_calls, finish_reason, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
            );
            ins.run('sess_tool', 'user', 'do the thing', null, null, base + 1);
            // Assistant turn whose terminal message is a tool call: EMPTY
            // content, payload in tool_calls. The OLD `content != ''` filter
            // dropped this row entirely.
            ins.run('sess_tool', 'assistant', '', '[{"name":"run","args":{"cmd":"ls"}}]', 'tool_calls', base + 2);
            // A normal stop-with-content assistant row must still survive.
            ins.run('sess_tool', 'assistant', 'here is the answer', null, 'stop', base + 3);
        });

        const result = executeNativeHistory(hermesCfg(dbPath), {
            sessionStartedAtMs: base * 1000,
        });

        expect(result?.providerSessionId).toBe('sess_tool');
        const contents = result?.messages.map(m => m.content) ?? [];
        expect(contents).toContain('do the thing');
        // tool_calls payload projected into the content slot (not dropped).
        expect(contents).toContain('[{"name":"run","args":{"cmd":"ls"}}]');
        // normal stop row not regressed.
        expect(contents).toContain('here is the answer');
    });

    it('keeps latest-session semantics: picks the newest qualifying session', () => {
        const base = 1_700_000_000;
        withDb(db => {
            db.prepare('INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, ?)')
                .run('sess_old', 'cli', base, 0);
            db.prepare('INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, ?)')
                .run('sess_new', 'cli', base + 500, 0);
            const ins = db.prepare(
                'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
            );
            ins.run('sess_old', 'assistant', 'old-reply', base + 1);
            ins.run('sess_new', 'assistant', 'new-reply', base + 501);
        });

        const result = executeNativeHistory(hermesCfg(dbPath), {
            sessionStartedAtMs: base * 1000,
        });

        expect(result?.providerSessionId).toBe('sess_new');
        expect(result?.messages.map(m => m.content)).toEqual(['new-reply']);
    });

    it('excludes a session that genuinely has no messages rows', () => {
        const base = 1_700_000_000;
        withDb(db => {
            // Empty session with a stale non-zero message_count — must NOT be
            // resolved because it has zero actual messages rows.
            db.prepare('INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, ?)')
                .run('sess_empty', 'cli', base + 900, 5);
            db.prepare('INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, ?)')
                .run('sess_real', 'cli', base, 0);
            db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
                .run('sess_real', 'assistant', 'real-reply', base + 1);
        });

        const result = executeNativeHistory(hermesCfg(dbPath), {
            sessionStartedAtMs: base * 1000,
        });

        expect(result?.providerSessionId).toBe('sess_real');
    });
});
