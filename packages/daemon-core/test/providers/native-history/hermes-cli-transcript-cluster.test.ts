/**
 * Parity: the TS hermes reader (hermes-cli-transcript.ts) must read the same
 * sub-session cluster as the declarative sqlite executor.
 *
 * hermes ≥0.14 splits a logical turn across `parent_session_id`-linked sessions
 * rows; the final assistant lands in a descendant. The read path and the
 * transcript path must both walk the whole cluster so read_chat surfaces the
 * final assistant (no missing_final_assistant false-positive).
 *
 * The reader hardcodes ~/.hermes/state.db, so we stub os.homedir() to a tmp dir
 * and materialize a real state.db with a parent-chained cluster.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBetterSqlite3 } from '../../../src/system/load-better-sqlite3.js';

// os.homedir() can't be spied under ESM, so mock node:os with a factory that
// reads the current homeDir from a hoisted mutable ref. hermes-cli-transcript.ts
// imports `* as os from 'node:os'` and derives HERMES_STATE_DB from homedir().
const osRef = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, homedir: () => osRef.home, default: { ...actual, homedir: () => osRef.home } };
});

let homeDir = '';

function buildStateDb(base: number) {
    const hermesDir = path.join(homeDir, '.hermes');
    fs.mkdirSync(hermesDir, { recursive: true });
    const dbPath = path.join(hermesDir, 'state.db');
    const Database = loadBetterSqlite3();
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT,
            parent_session_id TEXT,
            started_at REAL,
            message_count INTEGER DEFAULT 0,
            title TEXT
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
    const insS = db.prepare('INSERT INTO sessions (id, source, parent_session_id, started_at, message_count) VALUES (?, ?, ?, ?, ?)');
    insS.run('root', 'cli', null, base, 0);
    insS.run('mid', 'cli', 'root', base + 5, 0);   // 0-message intermediate
    insS.run('leaf', 'cli', 'mid', base + 10, 0);  // holds the final assistant
    const insM = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
    insM.run('root', 'user', 'do the thing', base + 1);
    insM.run('root', 'assistant', 'partial', base + 2);
    insM.run('leaf', 'assistant', 'final answer', base + 11);
    db.close();
    return dbPath;
}

beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ts-cluster-home-'));
    osRef.home = homeDir;
    // The reader captures HERMES_STATE_DB = homedir()/.hermes/state.db at module
    // load. Reset the module registry each test so the fresh dynamic import
    // re-captures the CURRENT mocked home rather than a stale one.
    vi.resetModules();
});

afterEach(() => {
    if (homeDir && fs.existsSync(homeDir)) fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('hermes-cli-transcript reader — sub-session cluster parity', () => {
    it('reads the final assistant from a descendant sub-session when pinned to the root', async () => {
        const base = 1_700_000_000;
        const dbPath = buildStateDb(base);

        // Import AFTER os.homedir() is stubbed so HERMES_STATE_DB resolves to tmp.
        const { readSession } = await import('../../../src/providers/native-history/hermes-cli-transcript.js');
        const session = readSession(dbPath, 'root');

        expect(session).not.toBeNull();
        expect(session!.providerSessionId).toBe('root');
        const contents = session!.messages.map(m => m.content);
        expect(contents).toEqual(['do the thing', 'partial', 'final answer']);
        expect(contents[contents.length - 1]).toBe('final answer');
    });

    it('unpinned discovery still resolves the cluster and its final assistant', async () => {
        const base = 1_700_000_000;
        const dbPath = buildStateDb(base);
        const { readSession } = await import('../../../src/providers/native-history/hermes-cli-transcript.js');
        // No pin: newest cli session with messages is the anchor (root has msgs);
        // cluster expansion still pulls the leaf's final assistant.
        const session = readSession(dbPath);
        expect(session).not.toBeNull();
        expect(session!.messages.map(m => m.content)).toContain('final answer');
    });
});
