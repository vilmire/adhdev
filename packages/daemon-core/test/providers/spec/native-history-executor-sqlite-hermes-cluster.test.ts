/**
 * Hermes sub-session cluster read gap (HERMES-READCHAT-GAP).
 *
 * hermes ≥0.14 splits a SINGLE logical turn across several `sessions` rows
 * linked by `parent_session_id`, and the turn's FINAL assistant message lands in
 * a DIFFERENT (newer, descendant) sub-session row than the one the daemon pins /
 * `session_query` resolves. The old executor read only the anchor session's rows
 * and short-circuited at the first session with rows, so `read_chat` surfaced
 * zero assistant bubbles even though the answer was physically present in a
 * sibling sub-session — and the completion gate false-fired
 * `missing_final_assistant`.
 *
 * Fix: the sqlite source declares `session_cluster_query`. The executor treats
 * the resolved session id as an ANCHOR, expands it (via that query) to every id
 * in the parent-chain cluster, reads `message_query` for each, and merges +
 * re-sorts by mapped timestamp. The final assistant — in whichever sub-session —
 * is then always read.
 *
 * These inline queries mirror the shipped hermes-cli specs/4.0.json cluster
 * source exactly; keep them in sync if the spec's queries change.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';
import { loadBetterSqlite3 } from '../../../src/system/load-better-sqlite3.js';

let tmpDir = '';
let dbPath = '';

// Cluster-aware hermes-cli 4.0 spec sqlite source (post HERMES-READCHAT-GAP):
// session_query resolves the newest cli session, session_cluster_query expands
// it to the whole parent_session_id cluster (bidirectional walk).
function hermesCfg(dbFile: string) {
    return {
        source: {
            kind: 'sqlite' as const,
            path: dbFile,
            session_query:
                "SELECT id FROM sessions WHERE source = 'cli' AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id) AND started_at >= ? - 2 ORDER BY started_at DESC LIMIT 1",
            session_cluster_query:
                "WITH RECURSIVE up(id) AS (SELECT id FROM sessions WHERE id = ? UNION SELECT s.parent_session_id FROM sessions s JOIN up ON s.id = up.id WHERE s.parent_session_id IS NOT NULL), cluster(id) AS (SELECT id FROM up UNION SELECT s.id FROM sessions s JOIN cluster ON s.parent_session_id = cluster.id) SELECT id FROM cluster",
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-sqlite-cluster-'));
    dbPath = path.join(tmpDir, 'state.db');

    const Database = loadBetterSqlite3();
    const db = new Database(dbPath);
    // Schema mirrors the real ~/.hermes/state.db: sessions.parent_session_id
    // links a logical turn's sub-session chain (idx_sessions_parent).
    db.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT,
            parent_session_id TEXT,
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

describe('executeSqlite — hermes sub-session cluster read', () => {
    it('reads the final assistant even when it lands in a descendant sub-session', () => {
        const base = 1_700_000_000; // seconds
        withDb(db => {
            const insS = db.prepare(
                'INSERT INTO sessions (id, source, parent_session_id, started_at, message_count) VALUES (?, ?, ?, ?, ?)',
            );
            // Root session: holds the user ask + first assistant bubble.
            insS.run('root', 'cli', null, base, 0);
            // Intermediate sub-session with ZERO messages (hermes writes these).
            insS.run('mid', 'cli', 'root', base + 5, 0);
            // Leaf sub-session (newest started) holds the FINAL assistant reply.
            insS.run('leaf', 'cli', 'mid', base + 10, 0);

            const insM = db.prepare(
                'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
            );
            insM.run('root', 'user', 'do the thing', base + 1);
            insM.run('root', 'assistant', 'working on it', base + 2);
            insM.run('leaf', 'assistant', 'here is the final answer', base + 11);
        });

        const result = executeNativeHistory(hermesCfg(dbPath), {
            sessionStartedAtMs: base * 1000,
        });

        const contents = result?.messages.map(m => m.content) ?? [];
        // The whole cluster is read, merged, and chronologically ordered — the
        // final assistant (in the leaf sub-session) is present and LAST.
        expect(contents).toEqual([
            'do the thing',
            'working on it',
            'here is the final answer',
        ]);
        expect(contents[contents.length - 1]).toBe('here is the final answer');
    });

    it('resolves the cluster when the pinned anchor is the ROOT but messages are in a descendant', () => {
        const base = 1_700_000_000;
        withDb(db => {
            const insS = db.prepare(
                'INSERT INTO sessions (id, source, parent_session_id, started_at, message_count) VALUES (?, ?, ?, ?, ?)',
            );
            // Anchor (pinned) root has NO own messages — the old anchor-only read
            // returned null here and the pin fell through to newest-session churn.
            insS.run('root', 'cli', null, base, 0);
            insS.run('leaf', 'cli', 'root', base + 10, 0);
            const insM = db.prepare(
                'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
            );
            insM.run('leaf', 'user', 'ask', base + 11);
            insM.run('leaf', 'assistant', 'final reply', base + 12);
        });

        // providerSessionId pins the ROOT (the id the daemon first bound), which
        // has zero own messages. Cluster expansion still yields the descendant's.
        const result = executeNativeHistory(hermesCfg(dbPath), {
            providerSessionId: 'root',
            sessionStartedAtMs: base * 1000,
        });

        expect(result?.providerSessionId).toBe('root');
        expect(result?.messages.map(m => m.content)).toEqual(['ask', 'final reply']);
    });

    it('does not leak messages from an unrelated (different-cluster) session', () => {
        const base = 1_700_000_000;
        withDb(db => {
            const insS = db.prepare(
                'INSERT INTO sessions (id, source, parent_session_id, started_at, message_count) VALUES (?, ?, ?, ?, ?)',
            );
            insS.run('root', 'cli', null, base, 0);
            insS.run('leaf', 'cli', 'root', base + 10, 0);
            // Unrelated newer cluster in the same store — MUST NOT bleed in.
            insS.run('other', 'cli', null, base + 100, 0);
            const insM = db.prepare(
                'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
            );
            insM.run('root', 'user', 'mine-ask', base + 1);
            insM.run('leaf', 'assistant', 'mine-reply', base + 11);
            insM.run('other', 'assistant', 'not-mine', base + 101);
        });

        const result = executeNativeHistory(hermesCfg(dbPath), {
            providerSessionId: 'root',
            sessionStartedAtMs: base * 1000,
        });

        const contents = result?.messages.map(m => m.content) ?? [];
        expect(contents).toEqual(['mine-ask', 'mine-reply']);
        expect(contents).not.toContain('not-mine');
    });

    it('is unchanged for a single-session turn (no cluster / no parent chain)', () => {
        const base = 1_700_000_000;
        withDb(db => {
            db.prepare('INSERT INTO sessions (id, source, parent_session_id, started_at, message_count) VALUES (?, ?, ?, ?, ?)')
                .run('solo', 'cli', null, base, 0);
            const insM = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
            insM.run('solo', 'user', 'q', base + 1);
            insM.run('solo', 'assistant', 'a', base + 2);
        });

        const result = executeNativeHistory(hermesCfg(dbPath), { sessionStartedAtMs: base * 1000 });
        expect(result?.providerSessionId).toBe('solo');
        expect(result?.messages.map(m => m.content)).toEqual(['q', 'a']);
    });
});
