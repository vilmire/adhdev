/**
 * hermes-cli-transcript reader — tool_calls rows become tool bubbles (TOOL-LABEL).
 *
 * Standalone matrix run, 2026-09-25: a hermes assistant turn whose
 * finish_reason='tool_calls' has an EMPTY `content` and its payload in the
 * `tool_calls` column. The reader used to COALESCE that JSON into the content
 * slot with kind 'standard', so the dashboard showed
 * `[{"id": "tool_…", "call_id": …, "function": {…}}]` as the agent's prose.
 * Now: kind 'tool', `↗ {name}: {args}`, `toolName` = the invoked tool;
 * role='tool' rows (the tool result) render as `↘ {result}` tool bubbles.
 *
 * Same harness as hermes-cli-transcript-cluster.test.ts (mocked homedir).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBetterSqlite3 } from '../../../src/system/load-better-sqlite3.js';

const osRef = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, homedir: () => osRef.home, default: { ...actual, homedir: () => osRef.home } };
});

let homeDir = '';

// Verbatim shape from a live ~/.hermes/state.db row (hermes 0.14).
const TOOL_CALLS = JSON.stringify([{
    id: 'tool_lPnsqQiRzZacL4IpuUKJsa8L',
    call_id: 'tool_lPnsqQiRzZacL4IpuUKJsa8L',
    response_item_id: 'fc_tool_lPnsqQiRzZacL4IpuUKJsa8L',
    type: 'function',
    function: { name: 'write_file', arguments: '{"content": "hello\\n", "path": "/tmp/x/hello-hermes-cli.txt"}' },
}]);

function buildStateDb(base: number) {
    const hermesDir = path.join(homeDir, '.hermes');
    fs.mkdirSync(hermesDir, { recursive: true });
    const dbPath = path.join(hermesDir, 'state.db');
    const Database = loadBetterSqlite3();
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, source TEXT, parent_session_id TEXT, started_at REAL,
            message_count INTEGER DEFAULT 0, title TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
            tool_calls TEXT, finish_reason TEXT, timestamp REAL
        );
    `);
    db.prepare('INSERT INTO sessions (id, source, parent_session_id, started_at, message_count) VALUES (?, ?, ?, ?, ?)')
        .run('s1', 'cli', null, base, 0);
    const insM = db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, finish_reason, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
    insM.run('s1', 'user', 'Create a file', null, null, base + 1);
    insM.run('s1', 'assistant', '', TOOL_CALLS, 'tool_calls', base + 2);
    insM.run('s1', 'tool', '{"bytes_written": 6, "dirs_created": true}', null, null, base + 3);
    insM.run('s1', 'assistant', 'File created: /tmp/x/hello-hermes-cli.txt', null, 'stop', base + 4);
    db.close();
    return dbPath;
}

beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ts-tools-home-'));
    osRef.home = homeDir;
    vi.resetModules();
});

afterEach(() => {
    if (homeDir && fs.existsSync(homeDir)) fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('hermes-cli-transcript reader — tool_calls rows (TOOL-LABEL)', () => {
    it('projects an empty-content tool_calls row as a tool bubble with the tool name, and the tool row as its result', async () => {
        const dbPath = buildStateDb(1_700_000_000);
        const { readSession } = await import('../../../src/providers/native-history/hermes-cli-transcript.js');
        const session = readSession(dbPath, 's1');
        expect(session).not.toBeNull();
        const shape = session!.messages.map((m) => [m.role, m.kind, m.toolName ?? null, m.content]);
        expect(shape).toEqual([
            ['user', 'standard', null, 'Create a file'],
            ['assistant', 'tool', 'write_file', '↗ write_file: {"content": "hello\\n", "path": "/tmp/x/hello-hermes-cli.txt"}'],
            ['assistant', 'tool', null, '↘ {"bytes_written": 6, "dirs_created": true}'],
            ['assistant', 'standard', null, 'File created: /tmp/x/hello-hermes-cli.txt'],
        ]);
        // Nothing renders the raw tool_calls JSON as prose any more.
        expect(session!.messages.some((m) => m.kind === 'standard' && m.content.includes('"call_id"'))).toBe(false);
    });

    it('projectHermesToolCalls handles the flat legacy {name, arguments} shape and rejects junk', async () => {
        const { projectHermesToolCalls } = await import('../../../src/providers/native-history/hermes-cli-transcript.js');
        expect(projectHermesToolCalls('[{"name":"terminal","arguments":{"command":"ls"}}]'))
            .toEqual({ content: '↗ terminal: {"command":"ls"}', toolName: 'terminal' });
        expect(projectHermesToolCalls('not json')).toBeNull();
        expect(projectHermesToolCalls('[]')).toBeNull();
    });
});
