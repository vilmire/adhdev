/**
 * (AGY-TOOL-BUBBLES) antigravity-cli tool use must render in the transcript.
 *
 * The current-format reader (conversations/<uuid>.db) used to select only
 * step_type 14/15 and surface only the model's prose answer, so:
 *   - a model step that ONLY called a tool (no 20→1 answer) was dropped, and the
 *     whole tool turn rendered as nothing;
 *   - the tool's execution step (per-tool step_type, call echoed at 5→4, output
 *     at 140.2.1 or a per-tool field) was never read at all.
 *
 * The fixture (`fixtures/antigravity-tool-turn.steps.json`) re-encodes an
 * anonymised copy of the real protobuf layout, surveyed across 385 stores.
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir = '';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

const SESSION = 'a9a9a9a9-0000-4000-8000-00000000c0de';
const FIXTURE = path.join(__dirname, 'fixtures', 'antigravity-tool-turn.steps.json');

// ─── Fixture encoder ────────────────────────────────────────────────────────

type ProtoNode =
  | { f: number; v: number }
  | { f: number; s: string }
  | { f: number; m: ProtoNode[] }
  | { f: number; hex: string };

interface FixtureStep {
  idx: number;
  step_type: number;
  status: number;
  payload: ProtoNode[];
  error_details?: ProtoNode[];
}

function varint(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return Buffer.from(out);
}

function encode(nodes: ProtoNode[]): Buffer {
  return Buffer.concat(nodes.map((n) => {
    if ('v' in n) return Buffer.concat([varint(n.f * 8), varint(n.v)]);
    const body = 's' in n ? Buffer.from(n.s, 'utf-8') : 'hex' in n ? Buffer.from(n.hex, 'hex') : encode(n.m);
    return Buffer.concat([varint(n.f * 8 + 2), varint(body.length), body]);
  }));
}

function metadataFor(createdAtMs: number): Buffer {
  return encode([{ f: 1, m: [{ f: 1, v: Math.floor(createdAtMs / 1000) }, { f: 2, v: (createdAtMs % 1000) * 1_000_000 }] }]);
}

async function makeDb(steps: FixtureStep[]): Promise<string> {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
  const dir = path.join(tmpDir, '.gemini', 'antigravity-cli', 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${SESSION}.db`);
  const { loadBetterSqlite3 } = await import('../../../src/system/load-better-sqlite3.js');
  const Database = loadBetterSqlite3();
  const db = new Database(filePath);
  db.exec(fixture.schema);
  const insert = db.prepare(
    'INSERT INTO steps (idx, step_type, status, metadata, error_details, step_payload) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const s of steps) {
    insert.run(
      s.idx,
      s.step_type,
      s.status,
      metadataFor(fixture.baseCreatedAtMs + s.idx * 1000),
      s.error_details ? encode(s.error_details) : null,
      encode(s.payload),
    );
  }
  db.close();
  return filePath;
}

function fixtureSteps(): FixtureStep[] {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')).steps as FixtureStep[];
}

async function loadReader() {
  return import('../../../src/providers/native-history/antigravity-cli-transcript.js');
}

/** Replace step `idx`'s generic (field 140) output text with `text`. */
function withGenericOutput(steps: FixtureStep[], idx: number, text: string): FixtureStep[] {
  return steps.map((s) => {
    if (s.idx !== idx) return s;
    const payload = JSON.parse(JSON.stringify(s.payload)) as ProtoNode[];
    const f140 = payload.find((n) => n.f === 140) as { f: number; m: ProtoNode[] };
    const result = f140.m.find((n) => n.f === 2) as { f: number; m: ProtoNode[] };
    (result.m.find((n) => n.f === 1) as { f: number; s: string }).s = text;
    return { ...s, payload };
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agy-tools-'));
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('antigravity-cli .db — tool bubbles', () => {
  it('renders user → tool call → tool result → answer in order, with kinds and tool names', async () => {
    const dbPath = await makeDb(fixtureSteps());
    const { readSession } = await loadReader();
    const session = readSession(dbPath, SESSION, '/workspace/demo')!;
    expect(session).not.toBeNull();

    const shape = session.messages.map((m) => [m.role, m.kind, m.toolName ?? null, m.content]);
    expect(shape).toEqual([
      ['user', 'standard', null, 'list the files here'],
      ['assistant', 'tool', 'run_command', 'run_command: ls'],
      ['assistant', 'tool', 'run_command', 'The command exited with code 0. Output: README.md src'],
      ['assistant', 'standard', null, 'There are two entries: README.md and src.'],
      ['user', 'standard', null, 'show me the README, then list /etc'],
      // prose + two parallel calls in ONE step → split, prose first, calls in order
      ['assistant', 'standard', null, "I'll read the README first."],
      ['assistant', 'tool', 'view_file', 'view_file: {"AbsolutePath":"/workspace/demo/README.md"}'],
      ['assistant', 'tool', 'list_dir', 'list_dir: {"DirectoryPath":"/etc"}'],
      // legacy per-tool result field (view_file = 14): longest text leaf = the file body
      ['assistant', 'tool', 'view_file', '# Demo A demo project.'],
      // status 7 + error_details → the error, not the echoed path
      ['assistant', 'tool', 'list_dir', 'Error: Permission denied for list_dir(/etc).'],
      ['assistant', 'standard', null, 'The README says: A demo project. /etc is not accessible.'],
      // step 90 (ephemeral system context) ignored; 101 → notification bubble
      ['assistant', 'tool', 'task_notification', 'Wait for task: Timer has expired > wait **Status**: Fired'],
      // still-running call: the call shows, the status-2 execution has no result yet
      ['assistant', 'tool', 'run_command', 'run_command: sleep 5'],
    ]);

    for (const m of session.messages.filter((x) => x.kind === 'tool')) {
      expect(m.senderName).toBe('Tool');
      expect(m.workspace).toBe('/workspace/demo');
      // short bodies are complete — no expand affordance
      expect(m.toolBlockRef).toBeUndefined();
    }
    for (let i = 1; i < session.messages.length; i++) {
      expect(session.messages[i].receivedAt).toBeGreaterThanOrEqual(session.messages[i - 1].receivedAt);
    }
    // Internal reasoning and the UI-only arg hints never surface.
    const all = session.messages.map((m) => m.content).join('\n');
    expect(all).not.toContain('Listing the directory');
    expect(all).not.toContain('toolSummary');
    expect(all).not.toContain('gemini_coder.Step');
  });

  it('a tool-only model turn (no prose answer) is no longer dropped', async () => {
    const steps = fixtureSteps().filter((s) => s.idx <= 2); // user, tool-only model step, execution
    const dbPath = await makeDb(steps);
    const { readSession } = await loadReader();
    const session = readSession(dbPath, SESSION)!;
    expect(session).not.toBeNull();
    expect(session.messages.map((m) => `${m.role}:${m.kind}`)).toEqual([
      'user:standard',
      'assistant:tool',
      'assistant:tool',
    ]);
  });

  it('assigns stable, distinct v3 bubble ids to tool bubbles', async () => {
    const dbPath = await makeDb(fixtureSteps());
    const { readSession } = await loadReader();
    const { normalizeNativeHistoryMessages } = await import('../../../src/commands/chat-commands-read-native-normalize.js');
    const ids = () => normalizeNativeHistoryMessages(
      'antigravity-cli',
      readSession(dbPath, SESSION)!.messages as any,
      SESSION,
    ).map((m: any) => ({ id: m.bubbleId as string, kind: m.kind as string, source: m.source as string }));

    const first = ids();
    const tools = first.filter((m) => m.kind === 'tool');
    expect(tools).toHaveLength(8);
    for (const t of tools) {
      expect(t.id).toMatch(new RegExp(`^bubble:v3:antigravity-cli:native:${SESSION}:assistant:tool:[0-9a-f]+:#\\d+$`));
      expect(t.source).toBe('tool_call'); // activity bubble — never a completion-gate "final answer"
    }
    expect(new Set(first.map((m) => m.id)).size).toBe(first.length);
    expect(ids()).toEqual(first); // re-read → identical ids
  });

  it('caps a long result, stamps a keyed ref, and the ref expands to the full body', async () => {
    const longOutput = `The command exited with code 0.\nOutput:\n${Array.from({ length: 200 }, (_, i) => `src/module-${i}.ts`).join('\n')}`;
    const dbPath = await makeDb(withGenericOutput(fixtureSteps(), 2, longOutput));
    const { readSession, readAntigravityToolBlockAt } = await loadReader();
    const { TOOL_RESULT_SUMMARY_MAX } = await import('../../../src/providers/spec/native-history-tool-blocks.js');
    const session = readSession(dbPath, SESSION)!;

    const result = session.messages[2];
    expect(result.kind).toBe('tool');
    expect(result.content.length).toBe(TOOL_RESULT_SUMMARY_MAX);
    expect(result.content.endsWith('…')).toBe(true);
    expect(result.toolBlockRef).toEqual({ sourceMtimeMs: session.sourceMtimeMs, recordIndex: 2, blockIndex: -1 });

    expect(readAntigravityToolBlockAt(dbPath, 2, -1)).toEqual({ toolName: 'run_command', result: longOutput.trim() });
    // A model-step address resolves the call's full args (UI hints included —
    // expanding shows everything the summary dropped).
    const call = readAntigravityToolBlockAt(dbPath, 5, 1)!;
    expect(call.toolName).toBe('list_dir');
    expect(JSON.parse(call.callArgs!)).toMatchObject({ DirectoryPath: '/etc', toolSummary: 'List /etc' });
    // Addresses that name no tool block refuse rather than returning neighbours.
    expect(readAntigravityToolBlockAt(dbPath, 0, -1)).toBeNull(); // user step
    expect(readAntigravityToolBlockAt(dbPath, 5, 2)).toBeNull(); // no third call
    expect(readAntigravityToolBlockAt(dbPath, 99, -1)).toBeNull();
  });

  it('round-trips through the built-in expand resolver (dispatcher-bound .db)', async () => {
    const longOutput = `Output:\n${'x '.repeat(900)}end`;
    const dbPath = await makeDb(withGenericOutput(fixtureSteps(), 2, longOutput));
    const { readSession } = await loadReader();
    const { expandBuiltinReaderToolBlock } = await import('../../../src/providers/native-history/builtin-tool-block-expand.js');
    const ref = readSession(dbPath, SESSION)!.messages[2].toolBlockRef!;
    expect(ref).toBeDefined();

    const expanded = expandBuiltinReaderToolBlock('antigravity-cli', { sessionId: SESSION, providerSessionId: SESSION }, ref);
    expect(expanded).toMatchObject({ ok: true, result: longOutput.trim(), truncated: true });

    const stale = expandBuiltinReaderToolBlock('antigravity-cli', { sessionId: SESSION }, { ...ref, sourceMtimeMs: ref.sourceMtimeMs - 1 });
    expect(stale).toEqual({ ok: false, reason: 'source_changed' });
  });

  it('listSessions preview stays the prose answer, not a trailing tool bubble', async () => {
    const dbPath = await makeDb(fixtureSteps());
    const { listSessions } = await loadReader();
    const metas = (await listSessions('')) as Array<{ sessionId: string; preview?: string; messageCount: number; sourcePath: string }>;
    const meta = metas.find((m) => m.sessionId === SESSION)!;
    expect(meta.sourcePath).toBe(dbPath);
    expect(meta.preview).toBe('The README says: A demo project. /etc is not accessible.');
    expect(meta.messageCount).toBe(5); // 2 prompts + 3 prose answers
  });
});
