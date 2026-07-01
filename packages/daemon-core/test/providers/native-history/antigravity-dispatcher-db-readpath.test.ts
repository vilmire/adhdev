/**
 * Regression: the antigravity read-path must surface assistant answers from a
 * per-session conversations/<uuid>.db through the *dispatcher* — the layer the
 * live daemon actually calls (createNativeHistoryDispatcher('antigravity-cli'),
 * wired by provider-loader when a spec declares native_history.reader).
 *
 * Live win32 evidence (2026-07-01): antigravity wrote its answer into a 708KB
 * conversations/<uuid>.db (step_type=15 assistant payloads) while every
 * brain per-session transcript.jsonl was 0 bytes. mesh_read_chat
 * returned providerSessionId=null + 0 assistant messages. Root cause: the
 * antigravity spec declared a declarative jsonl `source` pointing at the EMPTY
 * brain transcript, so the loader routed the read through the declarative
 * executor and the purpose-built .db reader was never reached. The fix switches
 * the spec to `native_history.reader: "antigravity-cli"`, routing reads through
 * this dispatcher → resolveAntigravityPath → the .db-aware reader.
 *
 * These tests exercise that dispatcher path end-to-end (path resolution +
 * reader), NOT just the reader in isolation (already covered in
 * antigravity-cli-transcript.test.ts). They fail if the .db is not discovered,
 * not decoded, or the providerSessionId is not resolved — the exact live
 * symptoms.
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir = '';

// The dispatcher imports 'node:os'; the reader imports 'os'. Mock both so
// os.homedir() → tmpDir everywhere in the read-path.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => tmpDir };
});

const SESSION = 'eeeeeeee-5555-0000-0000-000000000005';

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
function tag(field: number, wireType: number): Buffer {
  return encodeVarint(field * 8 + wireType);
}
function lenField(field: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), encodeVarint(payload.length), payload]);
}
function varField(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, 0), encodeVarint(value)]);
}
function strField(field: number, text: string): Buffer {
  return lenField(field, Buffer.from(text, 'utf-8'));
}
function encodeUserStep(prompt: string): Buffer {
  const inner = Buffer.concat([strField(2, prompt), strField(3, `\n\n${prompt}`)]);
  return Buffer.concat([varField(1, 14), varField(4, 3), lenField(19, inner)]);
}
function encodeModelStep(answer: string): Buffer {
  const inner = Buffer.concat([strField(1, answer), strField(8, answer)]);
  return Buffer.concat([varField(1, 15), varField(4, 3), lenField(20, inner)]);
}

async function makeConversationDb(
  sessionId: string,
  steps: Array<{ step_type: number; payload: Buffer }>,
): Promise<string> {
  const dir = path.join(antigravityRoot(), 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.db`);
  const { loadBetterSqlite3 } = await import('../../../src/system/load-better-sqlite3.js');
  const Database = loadBetterSqlite3();
  const db = new Database(filePath);
  db.exec(
    'CREATE TABLE `steps` (`idx` integer, `step_type` integer NOT NULL DEFAULT 0, ' +
      '`status` integer NOT NULL DEFAULT 0, `step_payload` blob, PRIMARY KEY (`idx`));',
  );
  const insert = db.prepare(
    'INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, 3, ?)',
  );
  steps.forEach((s, i) => insert.run(i, s.step_type, s.payload));
  db.close();
  return filePath;
}

/** Reproduce the live condition: a brain transcript dir with a 0-byte jsonl. */
function makeEmptyBrainTranscript(sessionId: string): void {
  const logsDir = path.join(
    antigravityRoot(),
    'brain',
    sessionId,
    '.system_generated',
    'logs',
  );
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), '', 'utf-8');
}

describe('antigravity dispatcher read-path — .db surfacing (live win32 regression)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agy-dispatch-'));
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('binds the .db by exact sessionId and returns assistant answers + providerSessionId', async () => {
    await makeConversationDb(SESSION, [
      { step_type: 14, payload: encodeUserStep('verify marker prompt') },
      { step_type: 15, payload: encodeModelStep('MARKER_V1\n\nverify marker answer') },
    ]);

    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');
    const result = dispatch({
      agentType: 'antigravity-cli',
      sessionId: SESSION,
      providerSessionId: SESSION,
      workspace: '/workspaces/agy',
    });

    expect(result).not.toBeNull();
    // The live break was providerSessionId=null — assert it resolves.
    expect(result!.providerSessionId).toBe(SESSION);
    const assistant = result!.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe('verify marker answer'); // MARKER_V1 stripped
    expect(result!.messages.some((m) => m.role === 'user' && m.content === 'verify marker prompt')).toBe(true);
  });

  it('surfaces the .db even when the brain transcript.jsonl is 0 bytes (the live condition)', async () => {
    // brain jsonl exists but is empty — the primary jsonl source is dead, so the
    // ONLY place the answer lives is the .db. The dispatcher must still surface it.
    makeEmptyBrainTranscript(SESSION);
    await makeConversationDb(SESSION, [
      { step_type: 14, payload: encodeUserStep('empty-brain prompt') },
      { step_type: 15, payload: encodeModelStep('answer from db despite empty brain') },
    ]);

    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');
    const result = dispatch({
      agentType: 'antigravity-cli',
      sessionId: SESSION,
      providerSessionId: SESSION,
      workspace: '/workspaces/agy',
    });

    expect(result).not.toBeNull();
    expect(result!.providerSessionId).toBe(SESSION);
    expect(result!.messages.some((m) => m.role === 'assistant' && m.content === 'answer from db despite empty brain')).toBe(true);
    expect(result!.sourcePath.endsWith('.db')).toBe(true);
  });

  it('falls back to the newest recent .db when no sessionId is bound (empty brain)', async () => {
    // No exact sessionId hint + empty brain → resolveAntigravityPath must reach
    // the newest-recent conversations/*.db fallback and still decode it.
    makeEmptyBrainTranscript(SESSION);
    await makeConversationDb(SESSION, [
      { step_type: 14, payload: encodeUserStep('unbound prompt') },
      { step_type: 15, payload: encodeModelStep('unbound answer from newest db') },
    ]);

    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');
    const result = dispatch({
      agentType: 'antigravity-cli',
      sessionId: '', // unbound
      workspace: '/workspaces/agy',
    });

    expect(result).not.toBeNull();
    expect(result!.providerSessionId).toBe(SESSION);
    expect(result!.messages.some((m) => m.role === 'assistant' && m.content === 'unbound answer from newest db')).toBe(true);
  });
});
