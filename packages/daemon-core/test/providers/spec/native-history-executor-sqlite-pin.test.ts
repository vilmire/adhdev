/**
 * SQLite native-history session pin (hermes-cli churn fix).
 *
 * hermes ≥0.14 writes a fresh `sessions` row per internal sub-session, so the
 * spec's newest-wins `session_query` (`ORDER BY started_at DESC LIMIT 1`)
 * drifts to a different id on every read. Left unpinned this churns the bound
 * daemon session (each re-bind re-hydrates unbounded history → saturation) and
 * reads completion evidence from the wrong session (turn never finalizes).
 *
 * The executor now pins: when the caller passes `providerSessionId`, it reads
 * THAT session directly and skips the newest-wins query. Without it, discovery
 * still picks the newest session.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';
import { loadBetterSqlite3 } from '../../../src/system/load-better-sqlite3.js';

let tmpDir = '';
let dbPath = '';

// Mirror the hermes-cli 4.0 spec's sqlite source block.
function hermesCfg(dbFile: string) {
    return {
        source: {
            kind: 'sqlite' as const,
            path: dbFile,
            session_query: "SELECT id FROM sessions WHERE source = 'cli' AND message_count > 0 AND started_at >= ? ORDER BY started_at DESC LIMIT 1",
            message_query: "SELECT role, content, CAST(timestamp * 1000 AS INTEGER) AS ts_ms FROM messages WHERE session_id = ? AND content IS NOT NULL AND content != '' AND role IN ('user', 'assistant', 'system', 'tool') ORDER BY timestamp ASC, id ASC",
            message_map: {
                role: '$.role',
                content: '$.content',
                timestamp_ms: '$.ts_ms',
            },
        },
    };
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-sqlite-pin-'));
    dbPath = path.join(tmpDir, 'state.db');

    const Database = loadBetterSqlite3();
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL, message_count INTEGER);
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
    `);

    // Two hermes sub-sessions: OLD (bound) started earlier, NEW started later.
    const base = 1_700_000_000; // seconds
    db.prepare('INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, ?)')
        .run('20260412_201157_ebca2a', 'cli', base, 2);
    db.prepare('INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, ?)')
        .run('20260412_202020_f2a65b', 'cli', base + 500, 2);

    const insMsg = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
    insMsg.run('20260412_201157_ebca2a', 'user', 'BOUND-ask', base + 1);
    insMsg.run('20260412_201157_ebca2a', 'assistant', 'BOUND-reply', base + 2);
    insMsg.run('20260412_202020_f2a65b', 'user', 'NEWER-ask', base + 501);
    insMsg.run('20260412_202020_f2a65b', 'assistant', 'NEWER-reply', base + 502);
    db.close();
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('executeSqlite — hermes session pin', () => {
    it('reads the bound session directly when providerSessionId is passed (not newest)', () => {
        const result = executeNativeHistory(hermesCfg(dbPath), {
            providerSessionId: '20260412_201157_ebca2a',
        });
        expect(result?.providerSessionId).toBe('20260412_201157_ebca2a');
        expect(result?.messages.map(m => m.content)).toEqual(['BOUND-ask', 'BOUND-reply']);
    });

    it('does not drift to the newest sub-session even when it is more recent', () => {
        // A fresh NEW sub-session appears mid-turn; the bound reader must keep
        // reading the OLD (bound) session's messages, not the newest row.
        const result = executeNativeHistory(hermesCfg(dbPath), {
            providerSessionId: '20260412_201157_ebca2a',
            // spawn floor deliberately old so the newest-wins query WOULD
            // otherwise happily return the newer session.
            sessionStartedAtMs: 1_699_999_000_000,
        });
        expect(result?.providerSessionId).toBe('20260412_201157_ebca2a');
        expect(result?.messages.map(m => m.content)).not.toContain('NEWER-reply');
    });

    it('falls back to newest-wins discovery when no providerSessionId is bound', () => {
        const result = executeNativeHistory(hermesCfg(dbPath), {
            sessionStartedAtMs: 1_699_999_000_000,
        });
        expect(result?.providerSessionId).toBe('20260412_202020_f2a65b');
        expect(result?.messages.map(m => m.content)).toEqual(['NEWER-ask', 'NEWER-reply']);
    });

    it('returns null for a pinned id that has no messages (no silent alias)', () => {
        const result = executeNativeHistory(hermesCfg(dbPath), {
            providerSessionId: 'nonexistent_session_id',
        });
        expect(result).toBeNull();
    });
});
