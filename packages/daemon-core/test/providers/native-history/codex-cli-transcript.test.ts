/**
 * Unit tests for the daemon-side codex-cli transcript adapter.
 *
 * Covers:
 *  1. readSession — empty file returns null
 *  2. readSession — session_meta mismatch returns null
 *  3. readSession — single message turn (user + assistant)
 *  4. readSession — function_call and function_call_output are parsed as tool kind
 *  5. readSession — malformed lines are skipped, valid lines still parsed
 *  6. readSession — custom_tool_call and custom_tool_call_output variants
 *  7. listSessions — missing watchPath returns []
 *  8. listSessions — finds sessions recursively and returns summary metadata
 *  9. listSessions — sorts by most recently updated session first
 * 10. readSession — non-existent file returns null
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir = '';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

interface TimestampedPayload {
  _ts?: number;
  [key: string]: unknown;
}

function writeCodexSession(
  sessionId: string,
  payloadLines: TimestampedPayload[],
  subdir = 'sessions',
  workspace = '/workspaces/project',
): string {
  const dir = path.join(tmpDir, '.codex', subdir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);

  const metaLine = JSON.stringify({
    type: 'session_meta',
    timestamp: 1_800_000_000_000,
    payload: { id: sessionId, cwd: workspace },
  });

  let lineTs = 1_800_000_001_000;
  const lines = [
    metaLine,
    ...payloadLines.map((p) => {
      // Use the payload's _ts if present, otherwise increment
      const ts = typeof p._ts === 'number' ? p._ts : lineTs++;
      const { _ts: _dropped, ...payloadWithoutTs } = p;
      return JSON.stringify({ type: 'response_item', timestamp: ts, payload: payloadWithoutTs });
    }),
  ];
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  return filePath;
}

function msgPayload(
  role: 'user' | 'assistant',
  content: string,
  ts = 1_800_000_001_000,
): TimestampedPayload {
  return { type: 'message', role, content, _ts: ts };
}

function toolCallPayload(name: string, args: object, ts = 1_800_000_002_000): TimestampedPayload {
  return { type: 'function_call', name, arguments: JSON.stringify(args), _ts: ts };
}

function toolOutputPayload(output: string, ts = 1_800_000_003_000): TimestampedPayload {
  return { type: 'function_call_output', output, _ts: ts };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('codex-cli-transcript — readSession', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-codex-read-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('returns null for an empty file', async () => {
    const sessionId = '11111111-0000-0000-0000-000000000001';
    const dir = path.join(tmpDir, '.codex', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, '', 'utf-8');

    const { readSession } = await import('../../../src/providers/native-history/codex-cli-transcript.js');
    const result = await readSession(filePath);
    expect(result).toBeNull();
  });

  it('returns null for a non-existent file', async () => {
    const { readSession } = await import('../../../src/providers/native-history/codex-cli-transcript.js');
    const result = await readSession('/nonexistent/codex-session.jsonl');
    expect(result).toBeNull();
  });

  it('returns null when session_meta id mismatches filename UUID', async () => {
    const sessionId = '22222222-0000-0000-0000-000000000001';
    const foreignId = 'ffffffff-0000-0000-0000-000000000999';
    const dir = path.join(tmpDir, '.codex', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);

    // Write meta with a different session id
    const lines = [
      JSON.stringify({ type: 'session_meta', timestamp: 1_800_000_000_000, payload: { id: foreignId, cwd: '/work' } }),
      JSON.stringify({ type: 'response_item', timestamp: 1_800_000_001_000, payload: { type: 'message', role: 'user', content: 'hello' } }),
    ];
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

    const { readSession } = await import('../../../src/providers/native-history/codex-cli-transcript.js');
    const result = await readSession(filePath);
    expect(result).toBeNull();
  });

  it('parses a single-turn session (user + assistant) correctly', async () => {
    const sessionId = '33333333-0000-0000-0000-000000000001';
    const filePath = writeCodexSession(
      sessionId,
      [
        msgPayload('user', 'Hello, Codex!', 1_800_000_001_000),
        msgPayload('assistant', 'Hi! Ready to code.', 1_800_000_002_000),
      ],
      'sessions',
      '/workspaces/myrepo',
    );

    const { readSession } = await import('../../../src/providers/native-history/codex-cli-transcript.js');
    const result = await readSession(filePath);

    expect(result).not.toBeNull();
    expect(result!.providerSessionId).toBe(sessionId);
    expect(result!.source).toBe('provider-native');
    expect(result!.nativeHistoryCoverage).toBe('full');
    expect(result!.workspace).toBe('/workspaces/myrepo');

    const visible = result!.messages.filter((m) => m.kind !== 'session_start');
    expect(visible).toHaveLength(2);

    expect(visible[0].role).toBe('user');
    expect(visible[0].content).toBe('Hello, Codex!');
    expect(visible[0].kind).toBe('standard');
    expect(visible[0].agent).toBe('codex-cli');
    expect(visible[0].historySessionId).toBe(sessionId);

    expect(visible[1].role).toBe('assistant');
    expect(visible[1].content).toBe('Hi! Ready to code.');
    expect(visible[1].kind).toBe('standard');
  });

  it('parses function_call and function_call_output as tool kind', async () => {
    const sessionId = '44444444-0000-0000-0000-000000000001';
    const filePath = writeCodexSession(
      sessionId,
      [
        msgPayload('user', 'Run ls', 1_800_000_001_000),
        toolCallPayload('shell', { command: 'ls /tmp' }, 1_800_000_002_000),
        toolOutputPayload('file1.txt\nfile2.txt', 1_800_000_003_000),
        msgPayload('assistant', 'Found 2 files.', 1_800_000_004_000),
      ],
    );

    const { readSession } = await import('../../../src/providers/native-history/codex-cli-transcript.js');
    const result = await readSession(filePath);

    expect(result).not.toBeNull();
    const visible = result!.messages.filter((m) => m.kind !== 'session_start');

    const toolMessages = visible.filter((m) => m.kind === 'tool');
    const standardMessages = visible.filter((m) => m.kind === 'standard');

    expect(toolMessages.length).toBeGreaterThanOrEqual(2);
    expect(toolMessages.some((m) => m.content.includes('shell') && m.content.includes('ls /tmp'))).toBe(true);
    expect(toolMessages.some((m) => m.content.includes('file1.txt'))).toBe(true);
    expect(toolMessages.every((m) => m.role === 'assistant' && m.senderName === 'Tool')).toBe(true);

    expect(standardMessages.some((m) => m.content === 'Run ls' && m.role === 'user')).toBe(true);
    expect(standardMessages.some((m) => m.content === 'Found 2 files.' && m.role === 'assistant')).toBe(true);
  });

  it('skips malformed lines and parses valid lines', async () => {
    const sessionId = '55555555-0000-0000-0000-000000000001';
    const dir = path.join(tmpDir, '.codex', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);

    const meta = JSON.stringify({ type: 'session_meta', timestamp: 1_800_000_000_000, payload: { id: sessionId, cwd: '/work' } });
    const valid1 = JSON.stringify({ type: 'response_item', timestamp: 1_800_000_001_000, payload: { type: 'message', role: 'user', content: 'Good line user' } });
    const valid2 = JSON.stringify({ type: 'response_item', timestamp: 1_800_000_002_000, payload: { type: 'message', role: 'assistant', content: 'Good line assistant' } });

    fs.writeFileSync(
      filePath,
      [meta, 'NOT JSON }{{{', valid1, '', '   ', '{"incomplete":', valid2].join('\n') + '\n',
      'utf-8',
    );

    const { readSession } = await import('../../../src/providers/native-history/codex-cli-transcript.js');
    const result = await readSession(filePath);

    expect(result).not.toBeNull();
    const visible = result!.messages.filter((m) => m.kind !== 'session_start');
    expect(visible).toHaveLength(2);
    expect(visible[0].content).toBe('Good line user');
    expect(visible[1].content).toBe('Good line assistant');
  });

  it('parses custom_tool_call and custom_tool_call_output variants', async () => {
    const sessionId = '66666666-0000-0000-0000-000000000001';
    const dir = path.join(tmpDir, '.codex', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);

    const meta = JSON.stringify({ type: 'session_meta', timestamp: 1_800_000_000_000, payload: { id: sessionId, cwd: '/work' } });
    const userMsg = JSON.stringify({ type: 'response_item', timestamp: 1_800_000_001_000, payload: { type: 'message', role: 'user', content: 'Run custom tool' } });
    const customCall = JSON.stringify({ type: 'response_item', timestamp: 1_800_000_002_000, payload: { type: 'custom_tool_call', name: 'my_tool', arguments: JSON.stringify({ query: 'data' }) } });
    const customOutput = JSON.stringify({ type: 'response_item', timestamp: 1_800_000_003_000, payload: { type: 'custom_tool_call_output', result: 'tool ran successfully' } });

    fs.writeFileSync(filePath, [meta, userMsg, customCall, customOutput].join('\n') + '\n', 'utf-8');

    const { readSession } = await import('../../../src/providers/native-history/codex-cli-transcript.js');
    const result = await readSession(filePath);

    expect(result).not.toBeNull();
    const visible = result!.messages.filter((m) => m.kind !== 'session_start');

    const toolMsgs = visible.filter((m) => m.kind === 'tool');
    expect(toolMsgs.length).toBe(2);
    expect(toolMsgs.some((m) => m.content.includes('my_tool') && m.content.includes('data'))).toBe(true);
    expect(toolMsgs.some((m) => m.content.includes('tool ran successfully'))).toBe(true);
  });
});

describe('codex-cli-transcript — listSessions', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-codex-list-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('returns [] when watchPath does not exist', async () => {
    const { listSessions } = await import('../../../src/providers/native-history/codex-cli-transcript.js');
    const result = await listSessions('~/.codex/sessions');
    expect(result).toEqual([]);
  });

  it('finds sessions recursively and returns proper summary metadata', async () => {
    const idA = 'aaaaaaaa-1111-0000-0000-000000000001';
    const idB = 'bbbbbbbb-2222-0000-0000-000000000002';

    writeCodexSession(idA, [
      msgPayload('user', 'User prompt A', 1_800_000_001_000),
      msgPayload('assistant', 'Assistant reply A', 1_800_000_002_000),
    ], 'sessions', '/workspaces/projectA');

    // Session B in a subdirectory
    const subDir = path.join(tmpDir, '.codex', 'sessions', 'nested');
    fs.mkdirSync(subDir, { recursive: true });
    const fileB = path.join(subDir, `${idB}.jsonl`);
    const metaB = JSON.stringify({ type: 'session_meta', timestamp: 1_800_000_000_000, payload: { id: idB, cwd: '/workspaces/projectB' } });
    const msgB1 = JSON.stringify({ type: 'response_item', timestamp: 1_800_000_003_000, payload: { type: 'message', role: 'user', content: 'User prompt B' } });
    const msgB2 = JSON.stringify({ type: 'response_item', timestamp: 1_800_000_004_000, payload: { type: 'message', role: 'assistant', content: 'Assistant reply B' } });
    fs.writeFileSync(fileB, [metaB, msgB1, msgB2].join('\n') + '\n', 'utf-8');

    const { listSessions } = await import('../../../src/providers/native-history/codex-cli-transcript.js');
    const result = await listSessions('~/.codex/sessions');

    expect(result).toHaveLength(2);

    const sessionA = result.find((s) => s.sessionId === idA);
    const sessionB = result.find((s) => s.sessionId === idB);

    expect(sessionA).toBeDefined();
    expect(sessionA!.agent).toBe('codex-cli');
    expect(sessionA!.source).toBe('provider-native');
    expect(sessionA!.nativeHistoryCoverage).toBe('full');
    expect(sessionA!.workspace).toBe('/workspaces/projectA');
    expect(sessionA!.messageCount).toBe(2);
    expect(sessionA!.preview).toBe('Assistant reply A');

    expect(sessionB).toBeDefined();
    expect(sessionB!.workspace).toBe('/workspaces/projectB');
    expect(sessionB!.messageCount).toBe(2);
  });

  it('sorts results by most recently updated session first', async () => {
    const olderSid = 'cccccccc-0000-0000-0000-000000000001';
    const newerSid = 'dddddddd-0000-0000-0000-000000000002';

    writeCodexSession(olderSid, [
      msgPayload('user', 'old prompt', 1_700_000_001_000),
      msgPayload('assistant', 'old reply', 1_700_000_002_000),
    ], 'sessions', '/a');

    writeCodexSession(newerSid, [
      msgPayload('user', 'new prompt', 1_800_000_001_000),
      msgPayload('assistant', 'new reply', 1_800_000_002_000),
    ], 'sessions', '/b');

    const { listSessions } = await import('../../../src/providers/native-history/codex-cli-transcript.js');
    const result = await listSessions('~/.codex/sessions');

    expect(result).toHaveLength(2);
    expect(result[0].sessionId).toBe(newerSid);
    expect(result[1].sessionId).toBe(olderSid);
  });
});
