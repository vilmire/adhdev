/**
 * Unit tests for the daemon-side claude-cli transcript adapter.
 *
 * Covers:
 *  1. readSession — empty file
 *  2. readSession — single turn (user + assistant)
 *  3. readSession — multi-turn conversation with tool_use / tool_result
 *  4. readSession — malformed lines are skipped, valid lines still parsed
 *  5. listSessions — path glob expansion scans subdirectories recursively
 *  6. readSession — sessionId mismatch lines are filtered out
 *  7. listSessions — empty / missing watchPath returns []
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

function writeTranscript(sessionId: string, lines: object[], projectSubdir = 'test-project'): string {
  const dir = path.join(tmpDir, '.claude', 'projects', projectSubdir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return filePath;
}

function userLine(content: string | object[], sessionId: string, ts = 1_800_000_001_000, cwd?: string): object {
  return {
    type: 'user',
    sessionId,
    timestamp: ts,
    ...(cwd ? { cwd } : {}),
    message: {
      role: 'user',
      content: typeof content === 'string' ? content : content,
    },
  };
}

function assistantLine(content: string | object[], sessionId: string, ts = 1_800_000_002_000): object {
  return {
    type: 'assistant',
    sessionId,
    timestamp: ts,
    message: {
      role: 'assistant',
      content: typeof content === 'string' ? content : content,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('claude-cli-transcript — readSession', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-claude-transcript-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('returns null for an empty transcript file', async () => {
    const sessionId = 'a1b2c3d4-0000-0000-0000-000000000001';
    const dir = path.join(tmpDir, '.claude', 'projects', 'empty-project');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, '', 'utf-8');

    const { readSession } = await import('../../../src/providers/native-history/claude-cli-transcript.js');
    const result = await readSession(filePath);
    expect(result).toBeNull();
  });

  it('parses a single-turn session (user + assistant)', async () => {
    const sessionId = 'a1b2c3d4-0000-0000-0000-000000000002';
    const filePath = writeTranscript(sessionId, [
      userLine('Hello, Claude!', sessionId, 1_800_000_001_000, '/workspaces/myproject'),
      assistantLine('Hi! How can I help?', sessionId, 1_800_000_002_000),
    ]);

    const { readSession } = await import('../../../src/providers/native-history/claude-cli-transcript.js');
    const result = await readSession(filePath);

    expect(result).not.toBeNull();
    expect(result!.providerSessionId).toBe(sessionId);
    expect(result!.source).toBe('provider-native');
    expect(result!.nativeHistoryCoverage).toBe('full');
    expect(result!.workspace).toBe('/workspaces/myproject');

    const visible = result!.messages.filter((m) => m.kind !== 'session_start');
    expect(visible).toHaveLength(2);

    expect(visible[0].role).toBe('user');
    expect(visible[0].content).toBe('Hello, Claude!');
    expect(visible[0].kind).toBe('standard');
    expect(visible[0].agent).toBe('claude-cli');
    expect(visible[0].historySessionId).toBe(sessionId);

    expect(visible[1].role).toBe('assistant');
    expect(visible[1].content).toBe('Hi! How can I help?');
    expect(visible[1].kind).toBe('standard');
  });

  it('ignores startup metadata, attachments, and ai-title records without fabricating assistant output', async () => {
    const sessionId = 'a1b2c3d4-0000-0000-0000-000000000020';
    const filePath = writeTranscript(sessionId, [
      { type: 'mode', sessionId, timestamp: 1_800_000_000_000 },
      { type: 'permission-mode', sessionId, timestamp: 1_800_000_000_100 },
      userLine('AskUserQuestion prompt', sessionId, 1_800_000_001_000, '/workspaces/myproject'),
      { type: 'attachment', sessionId, timestamp: 1_800_000_001_100, filePath: '/tmp/a.png' },
      { type: 'attachment', sessionId, timestamp: 1_800_000_001_200, filePath: '/tmp/b.png' },
      { type: 'attachment', sessionId, timestamp: 1_800_000_001_300, filePath: '/tmp/c.png' },
      { type: 'ai-title', sessionId, timestamp: 1_800_000_001_400, title: 'Rock paper scissors' },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/claude-cli-transcript.js');
    const result = await readSession(filePath);

    expect(result).not.toBeNull();
    const visible = result!.messages.filter((m) => m.kind !== 'session_start');
    expect(visible).toEqual([
      expect.objectContaining({
        role: 'user',
        kind: 'standard',
        content: 'AskUserQuestion prompt',
      }),
    ]);
  });

  it('parses a multi-turn conversation with tool_use and tool_result blocks', async () => {
    const sessionId = 'a1b2c3d4-0000-0000-0000-000000000003';
    const filePath = writeTranscript(sessionId, [
      // Turn 1 — user asks, assistant replies with text + tool_use
      userLine('List the files in /tmp', sessionId, 1_800_000_001_000, '/workspaces/test'),
      assistantLine(
        [
          { type: 'text', text: "I'll check that for you." },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls /tmp' } },
        ],
        sessionId,
        1_800_000_002_000,
      ),
      // Turn 2 — user sends tool_result, assistant replies
      userLine(
        [
          { type: 'tool_result', content: 'file1.txt\nfile2.txt' },
        ],
        sessionId,
        1_800_000_003_000,
      ),
      assistantLine('The /tmp directory contains file1.txt and file2.txt.', sessionId, 1_800_000_004_000),
    ]);

    const { readSession } = await import('../../../src/providers/native-history/claude-cli-transcript.js');
    const result = await readSession(filePath);

    expect(result).not.toBeNull();

    const visible = result!.messages.filter((m) => m.kind !== 'session_start');

    // Expected: user(standard), assistant(standard), assistant(tool), assistant(tool)[tool_result], assistant(standard)
    const userMessages = visible.filter((m) => m.role === 'user');
    const assistantMessages = visible.filter((m) => m.role === 'assistant');

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe('List the files in /tmp');

    // Two assistant parts from the array content: text block + tool_use block
    const standardAssistant = assistantMessages.filter((m) => m.kind === 'standard');
    const toolAssistant = assistantMessages.filter((m) => m.kind === 'tool');

    expect(standardAssistant.length).toBeGreaterThanOrEqual(1);
    expect(standardAssistant.some((m) => m.content.includes("I'll check that for you."))).toBe(true);

    expect(toolAssistant.length).toBeGreaterThanOrEqual(1);
    // tool_use → summarized as "Bash: ls /tmp"
    expect(toolAssistant.some((m) => m.content.includes('Bash') && m.senderName === 'Tool')).toBe(true);
    // tool_result → assistant kind=tool
    expect(toolAssistant.some((m) => m.content.includes('file1.txt'))).toBe(true);
  });

  it('skips malformed lines and still parses valid lines', async () => {
    const sessionId = 'a1b2c3d4-0000-0000-0000-000000000004';
    const dir = path.join(tmpDir, '.claude', 'projects', 'malformed-project');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);

    const validUser = JSON.stringify(userLine('Valid user prompt', sessionId, 1_800_000_001_000, '/workspaces/x'));
    const validAssistant = JSON.stringify(assistantLine('Valid assistant reply', sessionId, 1_800_000_002_000));

    fs.writeFileSync(
      filePath,
      [
        validUser,
        'NOT VALID JSON {{{',
        '',
        '   ',
        validAssistant,
        '{"incomplete":',
      ].join('\n') + '\n',
      'utf-8',
    );

    const { readSession } = await import('../../../src/providers/native-history/claude-cli-transcript.js');
    const result = await readSession(filePath);

    expect(result).not.toBeNull();
    const visible = result!.messages.filter((m) => m.kind !== 'session_start');
    expect(visible).toHaveLength(2);
    expect(visible[0].content).toBe('Valid user prompt');
    expect(visible[1].content).toBe('Valid assistant reply');
  });

  it('returns null for a non-existent path', async () => {
    const { readSession } = await import('../../../src/providers/native-history/claude-cli-transcript.js');
    const result = await readSession('/nonexistent/path/session-does-not-exist.jsonl');
    expect(result).toBeNull();
  });

  it('filters out lines whose sessionId does not match the filename', async () => {
    const sessionId = 'a1b2c3d4-0000-0000-0000-000000000005';
    const foreignId = 'ffffffff-0000-0000-0000-000000000999';
    const filePath = writeTranscript(sessionId, [
      userLine('Correct session user', sessionId, 1_800_000_001_000, '/workspaces/abc'),
      // A line that belongs to a different session — should be ignored
      userLine('Wrong session user', foreignId, 1_800_000_001_500),
      assistantLine('Correct session assistant', sessionId, 1_800_000_002_000),
    ]);

    const { readSession } = await import('../../../src/providers/native-history/claude-cli-transcript.js');
    const result = await readSession(filePath);

    expect(result).not.toBeNull();
    const visible = result!.messages.filter((m) => m.kind !== 'session_start');
    expect(visible).toHaveLength(2);
    expect(visible.every((m) => m.historySessionId === sessionId)).toBe(true);
    expect(visible.some((m) => m.content === 'Wrong session user')).toBe(false);
  });
});

describe('claude-cli-transcript — listSessions', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-claude-list-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('returns [] when watchPath base directory does not exist', async () => {
    const { listSessions } = await import('../../../src/providers/native-history/claude-cli-transcript.js');
    const result = await listSessions('~/.claude/projects/**/*.jsonl');
    expect(result).toEqual([]);
  });

  it('scans subdirectories recursively and returns one entry per session', async () => {
    const idA = 'aaaaaaaa-0000-0000-0000-000000000001';
    const idB = 'bbbbbbbb-0000-0000-0000-000000000002';

    // Project A — session A
    writeTranscript(idA, [
      userLine('Project A prompt', idA, 1_800_000_001_000, '/workspaces/projectA'),
      assistantLine('Project A reply', idA, 1_800_000_002_000),
    ], 'project-a');

    // Project B — nested subdirectory — session B
    const nestedDir = path.join(tmpDir, '.claude', 'projects', 'project-b', 'sub');
    fs.mkdirSync(nestedDir, { recursive: true });
    const nestedFile = path.join(nestedDir, `${idB}.jsonl`);
    fs.writeFileSync(
      nestedFile,
      [
        JSON.stringify(userLine('Nested prompt', idB, 1_800_000_003_000, '/workspaces/projectB')),
        JSON.stringify(assistantLine('Nested reply', idB, 1_800_000_004_000)),
      ].join('\n') + '\n',
      'utf-8',
    );

    const { listSessions } = await import('../../../src/providers/native-history/claude-cli-transcript.js');
    const result = await listSessions('~/.claude/projects/**/*.jsonl');

    expect(result).toHaveLength(2);

    const sessionA = result.find((s) => s.sessionId === idA);
    const sessionB = result.find((s) => s.sessionId === idB);

    expect(sessionA).toBeDefined();
    expect(sessionA!.agent).toBe('claude-cli');
    expect(sessionA!.source).toBe('provider-native');
    expect(sessionA!.nativeHistoryCoverage).toBe('full');
    expect(sessionA!.messageCount).toBe(2);
    expect(sessionA!.workspace).toBe('/workspaces/projectA');
    expect(sessionA!.preview).toBe('Project A reply');

    expect(sessionB).toBeDefined();
    expect(sessionB!.messageCount).toBe(2);
    expect(sessionB!.workspace).toBe('/workspaces/projectB');
  });

  it('sorts results by most recently updated session first', async () => {
    const older = 'cccccccc-0000-0000-0000-000000000001';
    const newer = 'dddddddd-0000-0000-0000-000000000002';

    writeTranscript(older, [
      userLine('old prompt', older, 1_700_000_001_000, '/a'),
      assistantLine('old reply', older, 1_700_000_002_000),
    ], 'proj-old');

    writeTranscript(newer, [
      userLine('new prompt', newer, 1_800_000_001_000, '/b'),
      assistantLine('new reply', newer, 1_800_000_002_000),
    ], 'proj-new');

    const { listSessions } = await import('../../../src/providers/native-history/claude-cli-transcript.js');
    const result = await listSessions('~/.claude/projects/**/*.jsonl');

    expect(result).toHaveLength(2);
    expect(result[0].sessionId).toBe(newer);
    expect(result[1].sessionId).toBe(older);
  });
});
