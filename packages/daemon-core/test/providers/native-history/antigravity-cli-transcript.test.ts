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
const SESSION_D = 'dddddddd-4444-0000-0000-000000000004';
const SESSION_E = 'eeeeeeee-5555-0000-0000-000000000005';

// steps.status values, verified against 289 real conversation stores
// (~/.gemini/antigravity-cli/conversations/*.db) plus a live in-flight capture.
/** Settled / DONE. The ONLY status a step_type 14/15 row ever holds at rest. */
const AGY_STATUS_DONE = 3;
/** In-flight: the model step is still being written; step_payload keeps growing. */
const AGY_STATUS_IN_FLIGHT = 8;
/** Awaiting tool approval. Observed only on tool step types, never on 14/15. */
const AGY_STATUS_AWAITING_APPROVAL = 7;

function antigravityRoot(): string {
  return path.join(tmpDir, '.gemini', 'antigravity-cli');
}

// ─── Minimal protobuf encoders (mirror the real antigravity step_payload) ─────

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  } while (v > 0);
  return Buffer.from(bytes);
}

/** Tag byte for (field, wireType). */
function tag(field: number, wireType: number): Buffer {
  return encodeVarint(field * 8 + wireType);
}

/** Length-delimited (wireType 2) field. */
function lenField(field: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), encodeVarint(payload.length), payload]);
}

/** Varint (wireType 0) field. */
function varField(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, 0), encodeVarint(value)]);
}

function strField(field: number, text: string): Buffer {
  return lenField(field, Buffer.from(text, 'utf-8'));
}

/**
 * Build a step_type 14 (USER) payload: user prompt at field 19 → field 2
 * (and field 3 as the newline-wrapped duplicate the real store also writes).
 */
function encodeUserStep(prompt: string): Buffer {
  const inner = Buffer.concat([
    strField(2, prompt),
    strField(3, `\n\n${prompt}`),
  ]);
  return Buffer.concat([
    varField(1, 14),          // step_type
    varField(4, 3),           // status DONE
    lenField(19, inner),      // user payload subtree
  ]);
}

/**
 * Build a step_type 15 (MODEL) payload. When `answer` is provided, it is placed
 * at field 20 → field 1 (and field 8, identical, as the real store does). When
 * omitted, only a reasoning summary (field 20 → field 3) is written — a step
 * that carries NO user-visible answer and must be skipped by the reader.
 */
function encodeModelStep(opts: { answer?: string; reasoning?: string }): Buffer {
  const parts: Buffer[] = [];
  if (opts.reasoning) parts.push(strField(3, opts.reasoning));
  if (opts.answer !== undefined) {
    parts.push(strField(1, opts.answer));
    parts.push(strField(8, opts.answer));
  }
  const inner = Buffer.concat(parts);
  return Buffer.concat([
    varField(1, 15),
    varField(4, 3),
    lenField(20, inner),
  ]);
}

/**
 * Build a step_type 15 (MODEL) payload whose answer has DRIFTED off the known
 * field path (field 20 → 1/8) to field 20 → 9, with the reasoning still at
 * field 20 → 3. Simulates a future antigravity step_payload schema drift: the
 * known extractor returns '' and the reader must fall back to a printable-run
 * scan to recover the answer without surfacing the reasoning.
 */
function encodeDriftedModelStep(answer: string, reasoning: string): Buffer {
  const inner = Buffer.concat([
    strField(3, reasoning),   // reasoning summary — must NOT be surfaced
    strField(9, answer),      // answer moved off the known 20→1/8 path
  ]);
  return Buffer.concat([
    varField(1, 15),
    varField(4, 3),
    lenField(20, inner),
  ]);
}

/**
 * Build a step_type 14 (USER) payload whose prompt has DRIFTED off the known
 * field path (field 19 → 2/3) to field 19 → 7. Simulates a schema drift on the
 * user side; the reader must recover the prompt via the printable-run fallback.
 */
function encodeDriftedUserStep(prompt: string): Buffer {
  const inner = strField(7, prompt);
  return Buffer.concat([
    varField(1, 14),
    varField(4, 3),
    lenField(19, inner),
  ]);
}

/**
 * Build a step_type 15 (MODEL) payload that is really a tool-call step: it has
 * reasoning (field 20 → 3) and JSON tool arguments (field 20 → 7), but NO answer
 * at field 20 → 1/8. Real antigravity model tool steps look like this. The
 * reader must drop it — the fallback must NOT surface the JSON args as an answer.
 */
function encodeToolArgModelStep(reasoning: string, toolArgsJson: string): Buffer {
  const inner = Buffer.concat([
    strField(3, reasoning),
    strField(7, toolArgsJson),
  ]);
  return Buffer.concat([
    varField(1, 15),
    varField(4, 3),
    lenField(20, inner),
  ]);
}

/** Build a non-message step (e.g. a tool call) that the reader must ignore. */
function encodeToolStep(): Buffer {
  return Buffer.concat([
    varField(1, 21),          // step_type = tool
    varField(4, 3),
    lenField(20, strField(2, 'run_command')),
  ]);
}

/**
 * Create a conversations/<uuid>.db with a `steps` table mirroring the real
 * antigravity schema. Each row is (idx, step_type, step_payload BLOB).
 */
async function makeConversationDb(
  sessionId: string,
  steps: Array<{ step_type: number; payload: Buffer; status?: number }>,
): Promise<string> {
  const dir = path.join(antigravityRoot(), 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.db`);

  const { loadBetterSqlite3 } = await import(
    '../../../src/system/load-better-sqlite3.js'
  );
  const Database = loadBetterSqlite3();
  const db = new Database(filePath);
  db.exec(
    'CREATE TABLE `steps` (`idx` integer, `step_type` integer NOT NULL DEFAULT 0, ' +
      '`status` integer NOT NULL DEFAULT 0, `step_payload` blob, PRIMARY KEY (`idx`));',
  );
  const insert = db.prepare(
    'INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)',
  );
  // Rows default to status 3 (DONE) — the settled state every step reaches on
  // disk. Tests that exercise an in-flight turn pass an explicit status.
  steps.forEach((s, i) => insert.run(i, s.step_type, s.status ?? AGY_STATUS_DONE, s.payload));
  db.close();
  return filePath;
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

// ─── SQLite (.db) conversation reader ─────────────────────────────────────────
//
// Recent antigravity migrated per-session conversation storage to
// conversations/<uuid>.db (SQLite, `steps` table with protobuf `step_payload`
// blobs). Before this reader existed the daemon read 0 rows from these dbs and
// read_chat fell back to the pty parser, losing every assistant answer. These
// tests use a fixture db built with the SAME protobuf field layout as the real
// store (verified against real ~/.gemini/antigravity-cli/conversations/*.db).

describe('antigravity-cli-transcript — readSession (.db SQLite)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agy-db-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('extracts user prompts and assistant answers from the steps table', async () => {
    const dbPath = await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeUserStep('Help me debug this') },
      { step_type: 90, payload: Buffer.from([0x08, 0x5a]) }, // ephemeral system context — ignored
      { step_type: 15, payload: encodeModelStep({ answer: "I'll help you debug that." }) },
      { step_type: 14, payload: encodeUserStep('And now deploy it') },
      { step_type: 15, payload: encodeModelStep({ answer: 'Deployed to preview.' }) },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D, '/workspaces/agy');

    expect(result).not.toBeNull();
    expect(result!.providerSessionId).toBe(SESSION_D);
    expect(result!.nativeHistoryCoverage).toBe('full');

    const messages = result!.messages;
    expect(messages).toHaveLength(4);

    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Help me debug this');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe("I'll help you debug that.");
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toBe('And now deploy it');
    expect(messages[3].role).toBe('assistant');
    expect(messages[3].content).toBe('Deployed to preview.');

    // Order preserved via idx-derived receivedAt.
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].receivedAt).toBeGreaterThanOrEqual(messages[i - 1].receivedAt);
    }
    expect(messages.every((m) => m.workspace === '/workspaces/agy')).toBe(true);
  });

  it('skips model steps that carry only reasoning (no user-visible answer)', async () => {
    const dbPath = await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeUserStep('Do the thing') },
      { step_type: 15, payload: encodeModelStep({ reasoning: '**Thinking** about the approach.' }) },
      { step_type: 21, payload: encodeToolStep() }, // tool call — ignored
      { step_type: 15, payload: encodeModelStep({ answer: 'The thing is done.' }) },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D);

    expect(result).not.toBeNull();
    const messages = result!.messages;
    // Only the user prompt + the ONE model step that has an answer.
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1].content).toBe('The thing is done.');
    expect(messages.some((m) => m.content.includes('Thinking'))).toBe(false);
  });

  it('strips the MARKER_V1 answer prefix', async () => {
    const dbPath = await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeUserStep('hi') },
      { step_type: 15, payload: encodeModelStep({ answer: "MARKER_V1\n\nI've received your prompt." }) },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D);

    expect(result).not.toBeNull();
    expect(result!.messages[1].content).toBe("I've received your prompt.");
  });

  it('unwraps the USER_REQUEST XML wrapper in db user prompts', async () => {
    const dbPath = await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeUserStep('<USER_REQUEST>Wrapped prompt</USER_REQUEST>') },
      { step_type: 15, payload: encodeModelStep({ answer: 'ok' }) },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D);

    expect(result).not.toBeNull();
    expect(result!.messages[0].content).toBe('Wrapped prompt');
  });

  it('returns null for a db whose uuid does not match the path filename', async () => {
    const dbPath = await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeUserStep('hi') },
      { step_type: 15, payload: encodeModelStep({ answer: 'hello' }) },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    // A non-uuid explicit sessionId is rejected up front.
    const result = await readSession(dbPath, 'not-a-uuid');
    expect(result).toBeNull();
  });

  it('retries a transient SQLITE_BUSY open and still returns the assistant rows', async () => {
    // Regression: on win32 antigravity holds a mandatory WAL write/checkpoint
    // lock while persisting a step; a readonly open racing that lock throws
    // SQLITE_BUSY. Collapsing that to null on the first failure erased the
    // just-written assistant answer on chat_history re-query. The reader must
    // retry and surface the already-persisted rows instead.
    const dbPath = await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeUserStep('Answer me') },
      { step_type: 15, payload: encodeModelStep({ answer: 'Here is the persisted answer.' }) },
    ]);

    // Wrap the real binding so the FIRST two open attempts throw SQLITE_BUSY,
    // then the third opens for real. parseConversationDb re-opens per attempt,
    // so this exercises the bounded retry loop end to end.
    const { loadBetterSqlite3: realLoad } = await import(
      '../../../src/system/load-better-sqlite3.js'
    );
    const RealDatabase = realLoad();
    let openAttempts = 0;
    const FlakyDatabase = function (this: any, ...ctorArgs: any[]) {
      openAttempts++;
      if (openAttempts <= 2) {
        const err: any = new Error('SQLITE_BUSY: database is locked');
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return new (RealDatabase as any)(...ctorArgs);
    } as unknown as typeof RealDatabase;

    vi.doMock('../../../src/system/load-better-sqlite3.js', () => ({
      loadBetterSqlite3: () => FlakyDatabase,
    }));

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D);

    expect(openAttempts).toBeGreaterThanOrEqual(3); // two busy failures + one success
    expect(result).not.toBeNull();
    const messages = result!.messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1].content).toBe('Here is the persisted answer.');

    vi.doUnmock('../../../src/system/load-better-sqlite3.js');
    vi.resetModules();
  });

  it('returns null only after a SQLITE_BUSY lock persists past all retries', async () => {
    const dbPath = await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeUserStep('hi') },
      { step_type: 15, payload: encodeModelStep({ answer: 'never surfaces this read' }) },
    ]);

    let openAttempts = 0;
    const AlwaysBusyDatabase = function (this: any) {
      openAttempts++;
      const err: any = new Error('SQLITE_BUSY: database is locked');
      err.code = 'SQLITE_BUSY';
      throw err;
    } as unknown as any;

    vi.doMock('../../../src/system/load-better-sqlite3.js', () => ({
      loadBetterSqlite3: () => AlwaysBusyDatabase,
    }));

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D);

    // Exhausts the bounded retry loop (4 attempts) before giving up.
    expect(openAttempts).toBe(4);
    expect(result).toBeNull();

    vi.doUnmock('../../../src/system/load-better-sqlite3.js');
    vi.resetModules();
  });

  it('recovers an assistant answer when the field path drifts off 20→1/8 (schema-drift fallback)', async () => {
    // Field 20 → 1/8 is absent; the answer lives at field 20 → 9 instead. The
    // known extractor returns '' — the reader must NOT silently drop the turn,
    // but recover the answer via the printable-run fallback while EXCLUDING the
    // reasoning subtree (field 20 → 3) so reasoning is never surfaced.
    const answer =
      'The migration completed successfully across all twelve workspaces, and every submodule pointer was fast-forwarded onto the new main branch without any conflicts.';
    const reasoning =
      '**Prioritizing Tool Usage** I am considering which migration steps to run first and how to sequence the submodule fast-forwards safely.';
    const dbPath = await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeUserStep('Run the migration') },
      { step_type: 15, payload: encodeDriftedModelStep(answer, reasoning) },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D);

    expect(result).not.toBeNull();
    const messages = result!.messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    // Recovered (not dropped) and NOT '' — the whole point of the forward-fix.
    expect(messages[1].content).not.toBe('');
    expect(messages[1].content).toContain('migration completed successfully');
    // The reasoning summary must never be surfaced as the answer.
    expect(messages[1].content).not.toContain('Prioritizing Tool Usage');
  });

  it('recovers a user prompt when the field path drifts off 19→2/3 (schema-drift fallback)', async () => {
    const prompt =
      'Please explain in detail how the SQLite WAL journal mode interacts with a read-only reader that opens the database while a writer holds the checkpoint lock.';
    const dbPath = await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeDriftedUserStep(prompt) },
      { step_type: 15, payload: encodeModelStep({ answer: 'In WAL mode readers do not block the writer.' }) },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D);

    expect(result).not.toBeNull();
    const messages = result!.messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0].content).not.toBe('');
    expect(messages[0].content).toContain('WAL journal mode interacts');
  });

  it('still drops a reasoning-only model step under the fallback (never surfaces reasoning)', async () => {
    // A legitimately answer-less step: only reasoning (field 20 → 3), no answer
    // anywhere. The fallback must find nothing beyond the excluded reasoning and
    // drop the step — preserving the reasoning-skip contract.
    const dbPath = await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeUserStep('do it') },
      {
        step_type: 15,
        payload: encodeModelStep({
          reasoning: '**Prioritizing Tool Usage** Deciding which command to run before answering.',
        }),
      },
      { step_type: 15, payload: encodeModelStep({ answer: 'All done.' }) },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D);

    expect(result).not.toBeNull();
    const messages = result!.messages;
    // user + the ONE model step that actually has an answer; reasoning-only dropped.
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1].content).toBe('All done.');
    expect(messages.some((m) => m.content.includes('Prioritizing Tool Usage'))).toBe(false);
  });

  it('never surfaces tool-call JSON arguments as an assistant answer (fallback stays prose-only)', async () => {
    // Real antigravity model tool steps carry reasoning + JSON tool args but no
    // answer. A naive printable-run fallback would surface the JSON as a fake
    // answer — a regression worse than dropping. It must be filtered out.
    const dbPath = await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeUserStep('search the code') },
      {
        step_type: 15,
        payload: encodeToolArgModelStep(
          '**Prioritizing Tool Usage** I will grep the repository for the PTY adapter.',
          '{"Query":"PTY.*adapter","SearchPath":"D:\\\\gh\\\\adhdev-cloud","IsRegex":true,"MatchPerLine":true}',
        ),
      },
      { step_type: 15, payload: encodeModelStep({ answer: 'Found it in daemon-core.' }) },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D);

    expect(result).not.toBeNull();
    const messages = result!.messages;
    // Only the user prompt + the real final answer; the tool-arg step is dropped.
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1].content).toBe('Found it in daemon-core.');
    const combined = messages.map((m) => m.content).join('\n');
    expect(combined).not.toContain('"Query"');
    expect(combined).not.toContain('SearchPath');
    expect(combined).not.toContain('Prioritizing Tool Usage');
  });

  it('returns null for a .db without a steps table', async () => {
    const dir = path.join(antigravityRoot(), 'conversations');
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, `${SESSION_D}.db`);
    const { loadBetterSqlite3 } = await import('../../../src/system/load-better-sqlite3.js');
    const Database = loadBetterSqlite3();
    const db = new Database(dbPath);
    db.exec('CREATE TABLE unrelated (x integer);');
    db.close();

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D);
    expect(result).toBeNull();
  });
});

// ─── ANTIGRAVITY-COMPLETION-DASHBOARD-GAP ────────────────────────────────────
// The dispatcher binds straight to conversations/<uuid>.db once the session id
// is known and never re-resolves to a sibling source. When that bound .db read
// comes back empty (transient WAL lock / assistant step not yet flushed / decode
// miss), the whole read used to collapse to native-unavailable even though the
// SAME session's assistant answer was still recoverable from the legacy brain
// transcript / .pb / history.jsonl. readSession now falls back across those
// siblings for the same session id before giving up.
/**
 * (ANTIGRAVITY-STEPS-STATUS-COMPLETION) The reader must consume only SETTLED
 * steps. Antigravity writes a model step incrementally: the row appears with
 * status 8 (in-flight) and a tiny step_payload that grows on every flush, then
 * flips to status 3 (DONE) with the complete answer — at the SAME idx.
 *
 * Live capture of a 199s turn (agy 1.1.11), polling the store every 400ms:
 *   t=189.3s  idx7 ty15 st8   247B   ← partial, still being written
 *   t=195.8s  idx7 ty15 st8  2268B   ← same row, grown
 *   t=199.1s  idx7 ty15 st3  3529B   ← settled, complete answer
 *
 * Reading the status-8 row surfaced a truncated answer as if it were final, and
 * because the settled row reuses the same providerSessionId + idx, the partial
 * and the full text collided downstream instead of replacing.
 *
 * Filtering to status 3 costs nothing in coverage: across 289 real conversation
 * stores, step_type 14/15 rows hold status 3 and no other value once settled
 * (456 user + 2260 model rows, zero exceptions).
 */
describe('antigravity-cli-transcript — readSession (.db in-flight step filtering)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agy-inflight-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('skips an in-flight (status 8) model step so a partial answer never surfaces as final', async () => {
    const dbPath = await makeConversationDb(SESSION_E, [
      { step_type: 14, payload: encodeUserStep('Explain B-tree indexes in depth') },
      { step_type: 15, payload: encodeModelStep({ answer: 'A B-tree index is a balanced tree that keeps keys sorted.' }) },
      { step_type: 14, payload: encodeUserStep('Now cover page splits') },
      // The turn currently generating: present on disk, but truncated.
      {
        step_type: 15,
        status: AGY_STATUS_IN_FLIGHT,
        payload: encodeModelStep({ answer: 'When a leaf page fills, the' }),
      },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_E, '/workspaces/agy');

    expect(result).not.toBeNull();
    const messages = result!.messages;

    // The truncated in-flight text must not appear anywhere.
    expect(messages.some((m) => m.content.includes('When a leaf page fills, the'))).toBe(false);

    // Settled turns are unaffected.
    expect(messages).toHaveLength(3);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('A B-tree index is a balanced tree that keeps keys sorted.');
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toBe('Now cover page splits');
  });

  it('surfaces the settled answer once the same idx flips from status 8 to status 3', async () => {
    const FULL = 'When a leaf page fills, the node splits at its median and the separator key is promoted to the parent.';

    // Same row, now settled — this is the state the store reaches at t=199.1s.
    const dbPath = await makeConversationDb(SESSION_E, [
      { step_type: 14, payload: encodeUserStep('Now cover page splits') },
      { step_type: 15, status: AGY_STATUS_DONE, payload: encodeModelStep({ answer: FULL }) },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_E, '/workspaces/agy');

    expect(result).not.toBeNull();
    const assistant = result!.messages.filter((m) => m.role === 'assistant');
    // Exactly one assistant bubble carrying the COMPLETE text — no concatenation
    // of the earlier partial with the settled answer.
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe(FULL);
  });

  it('does not treat an approval-wait (status 7) step as a completed message', async () => {
    const dbPath = await makeConversationDb(SESSION_E, [
      { step_type: 14, payload: encodeUserStep('Delete the build directory') },
      // A model step parked awaiting tool approval must not read as a finished turn.
      {
        step_type: 15,
        status: AGY_STATUS_AWAITING_APPROVAL,
        payload: encodeModelStep({ answer: 'Running rm -rf build/' }),
      },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_E, '/workspaces/agy');

    const assistantText = (result?.messages ?? [])
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content);
    expect(assistantText).not.toContain('Running rm -rf build/');
  });
});

describe('antigravity-cli-transcript — readSession (.db empty → sibling fallback)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agy-dbfallback-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  /** Write an empty (no steps) .db for a session so parseConversationDb yields null. */
  async function makeEmptyConversationDb(sessionId: string): Promise<string> {
    return makeConversationDb(sessionId, []);
  }

  it('recovers the assistant answer from the brain transcript when the .db is empty', async () => {
    const dbPath = await makeEmptyConversationDb(SESSION_D);
    makeBrainTranscript(SESSION_D, [
      brainRow('USER_EXPLICIT', 'USER_INPUT', '<USER_REQUEST>Help me debug this</USER_REQUEST>', 'DONE', 1_800_000_001_000),
      brainRow('MODEL', 'PLANNER_RESPONSE', 'The bug is in the loop.', 'DONE', 1_800_000_002_000),
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D, '/workspaces/agy');

    expect(result).not.toBeNull();
    expect(result!.nativeHistoryCoverage).toBe('full');
    expect(result!.providerSessionId).toBe(SESSION_D);
    expect(result!.sourcePath).toContain('transcript.jsonl');
    const assistant = result!.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe('The bug is in the loop.');
  });

  it('falls back to the sibling .pb (best-effort) when the .db is empty and no brain transcript exists', async () => {
    const dbPath = await makeEmptyConversationDb(SESSION_D);
    makePbFile(SESSION_D, 'The answer lives in the protobuf payload.');

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D);

    expect(result).not.toBeNull();
    expect(result!.nativeHistoryCoverage).toBe('best-effort');
    expect(result!.partialReason).toBe('antigravity_cli_pb_raw_text_extraction');
    expect(result!.messages.some((m) => m.role === 'assistant' && m.content.includes('protobuf payload'))).toBe(true);
  });

  it('falls back to history.jsonl (partial, user prompts) when the .db is empty and no brain/.pb exists', async () => {
    const dbPath = await makeEmptyConversationDb(SESSION_D);
    makeHistoryJsonl([
      { conversationId: SESSION_D, display: 'What is the status?', workspace: '/workspaces/agy', ts: 1_800_000_001_000 },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D, '/workspaces/agy');

    expect(result).not.toBeNull();
    expect(result!.nativeHistoryCoverage).toBe('partial');
    expect(result!.partialReason).toBe('antigravity_cli_history_jsonl_contains_user_prompts_only');
    expect(result!.messages.some((m) => m.role === 'user' && m.content === 'What is the status?')).toBe(true);
  });

  it('prefers the brain transcript over .pb/history.jsonl when several siblings exist', async () => {
    const dbPath = await makeEmptyConversationDb(SESSION_D);
    makeBrainTranscript(SESSION_D, [
      brainRow('MODEL', 'PLANNER_RESPONSE', 'Brain answer wins.', 'DONE', 1_800_000_002_000),
    ]);
    makePbFile(SESSION_D, 'Pb answer should be ignored.');
    makeHistoryJsonl([
      { conversationId: SESSION_D, display: 'jsonl prompt', workspace: '/workspaces/agy', ts: 1_800_000_001_000 },
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D);

    expect(result).not.toBeNull();
    expect(result!.nativeHistoryCoverage).toBe('full');
    expect(result!.messages.some((m) => m.content === 'Brain answer wins.')).toBe(true);
    expect(result!.messages.some((m) => m.content.includes('Pb answer'))).toBe(false);
  });

  it('does NOT consult siblings when the .db read succeeds (no double-source)', async () => {
    // Non-empty .db AND a brain transcript for the same uuid both exist. The .db
    // is authoritative and must win outright — the fallback must never run, so
    // the brain content cannot leak in alongside the .db content.
    const dbPath = await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeUserStep('db prompt') },
      { step_type: 15, payload: encodeModelStep({ answer: 'db answer.' }) },
    ]);
    makeBrainTranscript(SESSION_D, [
      brainRow('MODEL', 'PLANNER_RESPONSE', 'brain answer that must not appear.', 'DONE', 1_800_000_002_000),
    ]);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D);

    expect(result).not.toBeNull();
    expect(result!.nativeHistoryCoverage).toBe('full');
    expect(result!.sourcePath).toContain(`${SESSION_D}.db`);
    expect(result!.messages.some((m) => m.content === 'db answer.')).toBe(true);
    expect(result!.messages.some((m) => m.content.includes('brain answer'))).toBe(false);
  });

  it('returns null when the .db is empty and no sibling source exists', async () => {
    const dbPath = await makeEmptyConversationDb(SESSION_D);

    const { readSession } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await readSession(dbPath, SESSION_D);

    expect(result).toBeNull();
  });
});

describe('antigravity-cli-transcript — listSessions (.db discovery + priority)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agy-dblist-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('lists a .db-only session with full coverage and accurate counts', async () => {
    await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeUserStep('First prompt') },
      { step_type: 15, payload: encodeModelStep({ answer: 'First answer' }) },
      { step_type: 14, payload: encodeUserStep('Second prompt') },
      { step_type: 15, payload: encodeModelStep({ answer: 'Second answer' }) },
    ]);

    const { listSessions } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await listSessions('~/.gemini/antigravity-cli');

    const session = result.find((s) => s.sessionId === SESSION_D);
    expect(session).toBeDefined();
    expect(session!.nativeHistoryCoverage).toBe('full');
    expect(session!.messageCount).toBe(4);
    expect(session!.preview).toBe('Second answer');
    expect(session!.sourcePath.endsWith(`${SESSION_D}.db`)).toBe(true);
  });

  it('prefers a .db over a sibling .pb of the same session uuid', async () => {
    // Same uuid has BOTH a .db (full) and a .pb (best-effort). db must win.
    await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeUserStep('prompt') },
      { step_type: 15, payload: encodeModelStep({ answer: 'db answer wins' }) },
    ]);
    const dir = path.join(antigravityRoot(), 'conversations');
    fs.writeFileSync(
      path.join(dir, `${SESSION_D}.pb`),
      Buffer.from('this is stale protobuf best effort content only', 'utf-8'),
    );

    const { listSessions } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await listSessions('~/.gemini/antigravity-cli');

    const sessions = result.filter((s) => s.sessionId === SESSION_D);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].nativeHistoryCoverage).toBe('full');
    expect(sessions[0].sourcePath.endsWith('.db')).toBe(true);
  });

  it('still surfaces .pb-only sessions as best-effort (no regression)', async () => {
    makePbFile(
      SESSION_C,
      Buffer.from('This is a legacy protobuf conversation with readable content here', 'utf-8'),
    );

    const { listSessions } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await listSessions('~/.gemini/antigravity-cli');

    const sessionC = result.find((s) => s.sessionId === SESSION_C);
    expect(sessionC).toBeDefined();
    expect(sessionC!.nativeHistoryCoverage).toBe('best-effort');
  });

  it('lets a brain transcript take priority over a .db of the same uuid', async () => {
    // brain source is added to `seen` first, so the conversations/ scan skips it.
    makeBrainTranscript(SESSION_D, [
      brainRow('USER_EXPLICIT', 'USER_INPUT', '<USER_REQUEST>Brain prompt</USER_REQUEST>', 'DONE', 1_800_000_001_000),
      brainRow('MODEL', 'PLANNER_RESPONSE', 'Brain reply', 'DONE', 1_800_000_002_000),
    ]);
    await makeConversationDb(SESSION_D, [
      { step_type: 14, payload: encodeUserStep('Db prompt') },
      { step_type: 15, payload: encodeModelStep({ answer: 'Db reply' }) },
    ]);

    const { listSessions } = await import('../../../src/providers/native-history/antigravity-cli-transcript.js');
    const result = await listSessions('~/.gemini/antigravity-cli');

    const sessions = result.filter((s) => s.sessionId === SESSION_D);
    expect(sessions).toHaveLength(1);
    // brain transcript path wins (its sourcePath is the jsonl, not the db).
    expect(sessions[0].sourcePath.endsWith('.jsonl')).toBe(true);
  });
});
