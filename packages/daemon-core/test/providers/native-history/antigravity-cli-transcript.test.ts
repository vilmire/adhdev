/**
 * Unit tests for the daemon-side antigravity-cli transcript adapter.
 *
 * Covers:
 *  1. readSession — brain transcript JSONL: parses USER_EXPLICIT + MODEL rows
 *  2. readSession — brain transcript JSONL: only DONE-status rows are processed
 *  3. readSession — .pb file: best-effort printable string extraction
 *  4. readSession — history.jsonl: partial coverage from prompt index
 *  5. readSession — non-existent file returns null
 *  6. listSessions — missing watchPath returns []
 *  7. listSessions — brain sessions take priority over history entries
 *  8. listSessions — .pb-only sessions appear with best-effort coverage
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

const SESSION_A = 'aaaaaaaa-1111-0000-0000-000000000001';
const SESSION_B = 'bbbbbbbb-2222-0000-0000-000000000002';
const SESSION_C = 'cccccccc-3333-0000-0000-000000000003';

function antigravityRoot(): string {
  return path.join(tmpDir, '.gemini', 'antigravity-cli');
}

function makeBrainTranscript(
  sessionId: string,
  rows: object[],
  workspace = '/workspaces/agy',
): string {
  const logsDir = path.join(antigravityRoot(), 'brain', sessionId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, 'transcript.jsonl');
  const allRows = rows;
  fs.writeFileSync(filePath, allRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return filePath;
}

function brainRow(
  source: 'USER_EXPLICIT' | 'MODEL',
  type: string,
  content: string,
  status: 'DONE' | 'IN_PROGRESS' = 'DONE',
  ts = 1_800_000_001_000,
): object {
  return { source, type, content, status, created_at: ts };
}

function makeHistoryJsonl(entries: Array<{ conversationId: string; display: string; workspace: string; ts: number }>): void {
  const dir = antigravityRoot();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'history.jsonl');
  const lines = entries.map((e) =>
    JSON.stringify({ conversationId: e.conversationId, display: e.display, workspace: e.workspace, timestamp: e.ts }),
  );
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

function makePbFile(sessionId: string, content: Buffer | string): string {
  const dir = path.join(antigravityRoot(), 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.pb`);
  if (typeof content === 'string') {
    fs.writeFileSync(filePath, content, 'utf-8');
  } else {
    fs.writeFileSync(filePath, content);
  }
  return filePath;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('antigravity-cli-transcript — readSession (brain transcript)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agy-brain-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('parses USER_EXPLICIT + MODEL rows from a brain transcript', async () => {
    const transcriptPath = makeBrainTranscript(SESSION_A, [
      brainRow('USER_EXPLICIT', 'USER_INPUT', '<USER_REQUEST>Help me debug this</USER_REQUEST>', 'DONE', 1_800_000_001_000),
      brainRow('MODEL', 'PLANNER_RESPONSE', "I'll help you debug that.", 'DONE', 1_800_000_002_000),
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(transcriptPath, SESSION_A, '/workspaces/agy');

    expect(result).not.toBeNull();
    expect(result!.providerSessionId).toBe(SESSION_A);
    expect(result!.source).toBe('provider-native');
    expect(result!.nativeHistoryCoverage).toBe('full');

    const messages = result!.messages;
    expect(messages).toHaveLength(2);

    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Help me debug this');
    expect(messages[0].kind).toBe('standard');
    expect(messages[0].agent).toBe('antigravity-cli');
    expect(messages[0].historySessionId).toBe(SESSION_A);

    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe("I'll help you debug that.");
    expect(messages[1].kind).toBe('standard');
  });

  it('skips rows whose status is not DONE', async () => {
    const transcriptPath = makeBrainTranscript(SESSION_A, [
      brainRow('USER_EXPLICIT', 'USER_INPUT', '<USER_REQUEST>User prompt</USER_REQUEST>', 'DONE', 1_800_000_001_000),
      brainRow('MODEL', 'PLANNER_RESPONSE', 'This should be skipped', 'IN_PROGRESS', 1_800_000_002_000),
      brainRow('MODEL', 'PLANNER_RESPONSE', 'This should be included', 'DONE', 1_800_000_003_000),
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(transcriptPath, SESSION_A);

    expect(result).not.toBeNull();
    const messages = result!.messages;
    expect(messages).toHaveLength(2);
    expect(messages.some((m) => m.content === 'This should be skipped')).toBe(false);
    expect(messages.some((m) => m.content === 'This should be included')).toBe(true);
  });

  it('classifies non-PLANNER_RESPONSE MODEL rows as tool kind', async () => {
    const transcriptPath = makeBrainTranscript(SESSION_A, [
      brainRow('USER_EXPLICIT', 'USER_INPUT', '<USER_REQUEST>Run a command</USER_REQUEST>', 'DONE', 1_800_000_001_000),
      brainRow('MODEL', 'TOOL_CALL', 'bash_result: file1.txt', 'DONE', 1_800_000_002_000),
      brainRow('MODEL', 'PLANNER_RESPONSE', 'Found the file.', 'DONE', 1_800_000_003_000),
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(transcriptPath, SESSION_A);

    expect(result).not.toBeNull();
    const messages = result!.messages;

    const toolMsgs = messages.filter((m) => m.kind === 'tool');
    const standardMsgs = messages.filter((m) => m.kind === 'standard');

    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].content).toBe('bash_result: file1.txt');
    expect(toolMsgs[0].senderName).toBe('Tool');

    expect(standardMsgs).toHaveLength(2); // user + final assistant
  });

  it('returns null for a non-existent path', async () => {
    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession('/nonexistent/brain/session/transcript.jsonl');
    expect(result).toBeNull();
  });
});

describe('antigravity-cli-transcript — readSession (.pb file)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agy-pb-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('extracts printable text runs from a .pb binary file', async () => {
    // Construct a buffer that has some binary noise interleaved with readable text
    const textSegment1 = Buffer.from('This is a meaningful message from the user\n', 'utf-8');
    const binaryNoise = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]);
    const textSegment2 = Buffer.from('Assistant replied with a helpful response here', 'utf-8');
    const pbContent = Buffer.concat([textSegment1, binaryNoise, textSegment2]);

    const pbPath = makePbFile(SESSION_B, pbContent);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(pbPath, SESSION_B);

    expect(result).not.toBeNull();
    expect(result!.nativeHistoryCoverage).toBe('best-effort');
    expect(result!.providerSessionId).toBe(SESSION_B);
    expect(result!.messages.length).toBeGreaterThan(0);
    // The extracted content should contain our text segments
    const combined = result!.messages.map((m) => m.content).join('\n');
    expect(combined).toContain('meaningful message');
    expect(combined).toContain('helpful response');
  });

  it('returns null for an empty .pb file', async () => {
    const pbPath = makePbFile(SESSION_B, Buffer.alloc(0));

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(pbPath, SESSION_B);
    expect(result).toBeNull();
  });

  it('returns null for a .pb file with only binary noise (no printable runs)', async () => {
    const noiseBuf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0xff, 0xfe]);
    const pbPath = makePbFile(SESSION_B, noiseBuf);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(pbPath, SESSION_B);
    expect(result).toBeNull();
  });
});

describe('antigravity-cli-transcript — listSessions', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agy-list-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('returns [] when the antigravity-cli directory does not exist', async () => {
    const { listSessions } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await listSessions('~/.gemini/antigravity-cli/history.jsonl');
    expect(result).toEqual([]);
  });

  it('returns brain transcript sessions with full coverage', async () => {
    makeBrainTranscript(SESSION_A, [
      brainRow('USER_EXPLICIT', 'USER_INPUT', '<USER_REQUEST>Session A prompt</USER_REQUEST>', 'DONE', 1_800_000_001_000),
      brainRow('MODEL', 'PLANNER_RESPONSE', 'Session A reply', 'DONE', 1_800_000_002_000),
    ], '/workspaces/projectA');

    makeHistoryJsonl([
      { conversationId: SESSION_A, display: 'Session A prompt', workspace: '/workspaces/projectA', ts: 1_800_000_001_000 },
    ]);

    const { listSessions } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await listSessions('~/.gemini/antigravity-cli');

    const sessionA = result.find((s) => s.sessionId === SESSION_A);
    expect(sessionA).toBeDefined();
    expect(sessionA!.nativeHistoryCoverage).toBe('full');
    expect(sessionA!.agent).toBe('antigravity-cli');
    expect(sessionA!.source).toBe('provider-native');
    expect(sessionA!.messageCount).toBe(2);
  });

  it('falls back to partial coverage for history-only sessions (no brain transcript)', async () => {
    makeHistoryJsonl([
      { conversationId: SESSION_B, display: 'Session B prompt 1', workspace: '/workspaces/projectB', ts: 1_800_000_001_000 },
      { conversationId: SESSION_B, display: 'Session B prompt 2', workspace: '/workspaces/projectB', ts: 1_800_000_003_000 },
    ]);

    const { listSessions } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await listSessions('~/.gemini/antigravity-cli');

    const sessionB = result.find((s) => s.sessionId === SESSION_B);
    expect(sessionB).toBeDefined();
    expect(sessionB!.nativeHistoryCoverage).toBe('partial');
    expect(sessionB!.messageCount).toBe(2);
    expect(sessionB!.workspace).toBe('/workspaces/projectB');
  });

  it('includes .pb-only sessions with best-effort coverage', async () => {
    // SESSION_C only has a .pb file — no brain transcript, no history entry
    makePbFile(
      SESSION_C,
      Buffer.from('This is a test conversation from protobuf storage with readable content here', 'utf-8'),
    );

    const { listSessions } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await listSessions('~/.gemini/antigravity-cli');

    const sessionC = result.find((s) => s.sessionId === SESSION_C);
    expect(sessionC).toBeDefined();
    expect(sessionC!.nativeHistoryCoverage).toBe('best-effort');
    expect(sessionC!.agent).toBe('antigravity-cli');
  });

  it('sorts results by most recently updated first', async () => {
    // SESSION_A: brain transcript with newer timestamps
    makeBrainTranscript(SESSION_A, [
      brainRow('USER_EXPLICIT', 'USER_INPUT', '<USER_REQUEST>Newer prompt</USER_REQUEST>', 'DONE', 1_800_000_010_000),
      brainRow('MODEL', 'PLANNER_RESPONSE', 'Newer reply', 'DONE', 1_800_000_011_000),
    ]);

    // SESSION_B: history only with older timestamps
    makeHistoryJsonl([
      { conversationId: SESSION_B, display: 'Older prompt', workspace: '/b', ts: 1_700_000_001_000 },
    ]);

    const { listSessions } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await listSessions('~/.gemini/antigravity-cli');

    expect(result.length).toBeGreaterThanOrEqual(2);
    const idxA = result.findIndex((s) => s.sessionId === SESSION_A);
    const idxB = result.findIndex((s) => s.sessionId === SESSION_B);
    expect(idxA).toBeLessThan(idxB);
  });
});
