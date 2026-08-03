/**
 * Usage-extraction tests for the hermes-cli native history adapter.
 *
 * hermes is the only provider that persists a USD cost, and it persists an
 * UNTRUSTWORTHY one by default: `estimated_cost_usd = 0.0` with
 * `cost_status = 'unknown'` / `cost_source = 'none'` when no pricing table was
 * available (observed live on this machine). Reporting that 0 as a cost would
 * claim a session was free. These tests pin that distinction.
 *
 * Also pins the older-schema case: hermes predating the billing columns must
 * still read messages normally, with usage simply absent.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBetterSqlite3 } from '../../../src/system/load-better-sqlite3.js';

const osRef = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, homedir: () => osRef.home, default: { ...actual, homedir: () => osRef.home } };
});

// The module derives HERMES_STATE_DB from homedir() at IMPORT time and the ESM
// module cache keeps that constant for the whole file, so the home dir must be
// created ONCE and stay fixed — a per-test mkdtemp would leave every test after
// the first reading a path the module no longer points at. Each test therefore
// rebuilds state.db in place at the same location instead.
async function loadReadSession() {
    const mod = await import('../../../src/providers/native-history/hermes-cli-transcript.js');
    return mod.readSession;
}

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-usage-'));
osRef.home = homeDir;

beforeEach(() => {
    // Fresh db per test, same path.
    try { fs.rmSync(path.join(homeDir, '.hermes'), { recursive: true, force: true }); } catch { /* ignore */ }
});

afterAll(() => {
    try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function stateDbPath(): string {
    return path.join(homeDir, '.hermes', 'state.db');
}

/** Build a state.db WITH the billing columns. */
function buildDbWithUsage(rows: Array<Record<string, unknown>>): string {
    const hermesDir = path.join(homeDir, '.hermes');
    fs.mkdirSync(hermesDir, { recursive: true });
    const dbPath = stateDbPath();
    const Database = loadBetterSqlite3();
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT,
            model TEXT,
            parent_session_id TEXT,
            started_at REAL,
            message_count INTEGER DEFAULT 0,
            title TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            cache_read_tokens INTEGER,
            cache_write_tokens INTEGER,
            reasoning_tokens INTEGER,
            estimated_cost_usd REAL,
            actual_cost_usd REAL,
            cost_status TEXT,
            cost_source TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            role TEXT,
            content TEXT,
            tool_calls TEXT,
            timestamp REAL
        );
    `);
    const insertSession = db.prepare(`
        INSERT INTO sessions (id, source, model, parent_session_id, started_at, message_count,
                              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                              reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_status, cost_source)
        VALUES (@id, 'cli', @model, @parent, @started_at, 2, @input_tokens, @output_tokens,
                @cache_read_tokens, @cache_write_tokens, @reasoning_tokens,
                @estimated_cost_usd, @actual_cost_usd, @cost_status, @cost_source)
    `);
    const insertMessage = db.prepare(
        `INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)`,
    );
    for (const row of rows) {
        insertSession.run({
            model: null, parent: null, started_at: 1_700_000, input_tokens: 0, output_tokens: 0,
            cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
            estimated_cost_usd: null, actual_cost_usd: null, cost_status: null, cost_source: null,
            ...row,
        });
        insertMessage.run(String(row.id), 'user', 'question', 1_700_000);
        insertMessage.run(String(row.id), 'assistant', 'answer', 1_700_001);
    }
    db.close();
    return dbPath;
}

describe('hermes-cli usage', () => {
    it('extracts token totals and a trusted cost', async () => {
        buildDbWithUsage([{
            id: 'sess-a',
            model: 'kimi-k2',
            input_tokens: 35555,
            output_tokens: 179,
            cache_read_tokens: 1024,
            cache_write_tokens: 16,
            reasoning_tokens: 8,
            estimated_cost_usd: 0.42,
            cost_status: 'estimated',
            cost_source: 'pricing_table',
        }]);

        const readSession = await loadReadSession();
        const session = readSession(stateDbPath(), 'sess-a');
        expect(session?.usage).toBeDefined();
        expect(session!.usage!.inputTokens).toBe(35555);
        expect(session!.usage!.outputTokens).toBe(179);
        expect(session!.usage!.cacheReadTokens).toBe(1024);
        expect(session!.usage!.cacheCreationTokens).toBe(16);
        expect(session!.usage!.reasoningTokens).toBe(8);
        expect(session!.usage!.costUsd).toBeCloseTo(0.42);
        expect(session!.usage!.agent).toBe('hermes-cli');
        expect(session!.usage!.model).toBe('kimi-k2');
    });

    it('treats an unpriced 0.0 estimate as UNKNOWN cost, not as free', async () => {
        // The live default on this machine: cost columns exist and read 0.0
        // with cost_status='unknown'/cost_source='none'. Tokens are real; the
        // cost is not a measurement.
        buildDbWithUsage([{
            id: 'sess-b',
            input_tokens: 39541,
            output_tokens: 2800,
            estimated_cost_usd: 0.0,
            actual_cost_usd: null,
            cost_status: 'unknown',
            cost_source: 'none',
        }]);

        const readSession = await loadReadSession();
        const session = readSession(stateDbPath(), 'sess-b');
        expect(session!.usage!.inputTokens).toBe(39541);
        expect(session!.usage!.outputTokens).toBe(2800);
        expect(session!.usage!.costUsd).toBeUndefined();
    });

    it('prefers a billed actual cost over the estimate', async () => {
        buildDbWithUsage([{
            id: 'sess-c',
            input_tokens: 100,
            estimated_cost_usd: 0.10,
            actual_cost_usd: 0.25,
            cost_status: 'estimated',
            cost_source: 'pricing_table',
        }]);

        const readSession = await loadReadSession();
        const session = readSession(stateDbPath(), 'sess-c');
        expect(session!.usage!.costUsd).toBeCloseTo(0.25);
    });

    it('sums usage across a parent-linked sub-session cluster', async () => {
        // A logical hermes turn spans several `sessions` rows; usage must cover
        // the same cluster the messages were read from.
        buildDbWithUsage([
            { id: 'root', input_tokens: 100, output_tokens: 10, cost_status: 'estimated', cost_source: 'pricing_table', estimated_cost_usd: 0.1 },
            { id: 'child', parent: 'root', input_tokens: 200, output_tokens: 20, cost_status: 'estimated', cost_source: 'pricing_table', estimated_cost_usd: 0.2 },
        ]);

        const readSession = await loadReadSession();
        const session = readSession(stateDbPath(), 'root');
        expect(session!.usage!.inputTokens).toBe(300);
        expect(session!.usage!.outputTokens).toBe(30);
        expect(session!.usage!.costUsd).toBeCloseTo(0.3);
        expect(session!.usage!.recordCount).toBe(2);
    });

    it('REGRESSION: older hermes without billing columns still reads messages', async () => {
        // Selecting a non-existent column throws; the reader probes the schema
        // first so a pre-billing db degrades to "no usage" instead of failing
        // the whole message read.
        const hermesDir = path.join(homeDir, '.hermes');
        fs.mkdirSync(hermesDir, { recursive: true });
        const Database = loadBetterSqlite3();
        const db = new Database(stateDbPath());
        db.exec(`
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, source TEXT, parent_session_id TEXT,
                started_at REAL, message_count INTEGER DEFAULT 0, title TEXT
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
                role TEXT, content TEXT, tool_calls TEXT, timestamp REAL
            );
            INSERT INTO sessions (id, source, started_at, message_count) VALUES ('old', 'cli', 1700000, 2);
            INSERT INTO messages (session_id, role, content, timestamp) VALUES ('old', 'user', 'question', 1700000);
            INSERT INTO messages (session_id, role, content, timestamp) VALUES ('old', 'assistant', 'answer', 1700001);
        `);
        db.close();

        const readSession = await loadReadSession();
        const session = readSession(stateDbPath(), 'old');
        expect(session).not.toBeNull();
        expect(session!.usage).toBeUndefined();
        expect(session!.messages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'answer' },
        ]);
    });

    it('REGRESSION: messages, roles and timestamps are unchanged when usage exists', async () => {
        buildDbWithUsage([{ id: 'sess-d', input_tokens: 5, output_tokens: 5 }]);

        const readSession = await loadReadSession();
        const session = readSession(stateDbPath(), 'sess-d');
        expect(session!.messages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'answer' },
        ]);
        expect(session!.messages[0].receivedAt).toBe(1_700_000 * 1000);
        expect(session!.providerSessionId).toBe('sess-d');
        expect(session!.source).toBe('provider-native');
    });
});
