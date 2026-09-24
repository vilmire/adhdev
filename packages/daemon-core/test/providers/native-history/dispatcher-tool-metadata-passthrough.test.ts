/**
 * Regression: `toNativeHistoryMessage` (dispatcher.ts) is the FIRST hop every
 * native-history read passes through — the daemon-side allow-list projection
 * that decides which reader-stamped fields survive into `NativeHistoryResult`.
 * It used to forward only role/content/receivedAt/kind/workspace/toolBlockRef,
 * silently dropping `senderName` and `toolName` even though multiple readers
 * stamp them (claude-cli: senderName on tool/terminal bubbles; antigravity-cli:
 * both senderName AND the specific toolName of the invoked tool).
 *
 * Downstream, chat-commands-read-native-normalize.ts derives the tool bubble's
 * display label from exactly these two fields (preferring toolName over the
 * generic senderName:'Tool'), and the web-core tool card renders that label.
 * Losing them at this first hop meant the dashboard's tool card always showed
 * the generic "Tool" header — never the actual tool name — regardless of what
 * the reader resolved.
 *
 * These tests exercise the dispatcher (not the readers in isolation, which are
 * already covered by claude-cli-transcript.test.ts / antigravity-cli-tool-
 * bubbles.test.ts) for exactly the two readers that stamp these fields.
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir = '';

// The dispatcher imports 'node:os'; the claude-cli reader imports 'os'. Mock
// both so os.homedir() → tmpDir everywhere in the read-path.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => tmpDir };
});

describe('dispatcher — senderName/toolName pass-through (TOOL-LABEL)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-dispatch-toolmeta-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('claude-cli: forwards senderName on a tool_use bubble through the dispatcher', async () => {
    const sessionId = 'a1b2c3d4-0000-0000-0000-00000000d001';
    // claude-cli resolves ~/.claude/projects/<cwd-as-dashes>/<uuid>.jsonl —
    // the directory name must match cwdAsDashes(workspace) below.
    const dir = path.join(tmpDir, '.claude', 'projects', '-workspaces-test');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const lines = [
      {
        type: 'user',
        sessionId,
        timestamp: 1_800_000_001_000,
        cwd: '/workspaces/test',
        message: { role: 'user', content: 'List the files in /tmp' },
      },
      {
        type: 'assistant',
        sessionId,
        timestamp: 1_800_000_002_000,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls /tmp' } }],
        },
      },
    ];
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('claude-cli');
    const result = dispatch({
      agentType: 'claude-cli',
      sessionId,
      workspace: '/workspaces/test',
    });

    expect(result).not.toBeNull();
    const toolMessage = result!.messages.find((m) => m.kind === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.senderName).toBe('Tool');
    // TOOL-LABEL: the claude reader now also stamps the invoked tool's name so the
    // dashboard card reads 'Bash', not the generic 'Tool' (label prefers toolName).
    expect(toolMessage!.toolName).toBe('Bash');
    // A non-tool bubble must NOT pick up a stray senderName — the pass-through
    // forwards what the reader stamped, it does not invent one.
    const standardMessage = result!.messages.find((m) => m.role === 'user');
    expect(standardMessage!.senderName).toBeUndefined();
  });

  it('antigravity-cli: forwards both senderName and the specific toolName through the dispatcher', async () => {
    const SESSION = 'a9a9a9a9-0000-4000-8000-00000000c0de';
    const FIXTURE = path.join(__dirname, 'fixtures', 'antigravity-tool-turn.steps.json');

    type ProtoNode =
      | { f: number; v: number }
      | { f: number; s: string }
      | { f: number; m: ProtoNode[] }
      | { f: number; hex: string };

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
    for (const s of fixture.steps as Array<{ idx: number; step_type: number; status: number; payload: ProtoNode[]; error_details?: ProtoNode[] }>) {
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

    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');
    const result = dispatch({
      agentType: 'antigravity-cli',
      sessionId: SESSION,
      providerSessionId: SESSION,
      workspace: '/workspace/demo',
    });

    expect(result).not.toBeNull();
    const toolMessages = result!.messages.filter((m) => m.kind === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);
    // Every tool bubble carries the generic sender marker AND the specific
    // tool name the reader resolved — the exact distinction the dashboard
    // label now depends on (toolName preferred, senderName as fallback).
    for (const m of toolMessages) {
      expect(m.senderName).toBe('Tool');
      expect(typeof m.toolName).toBe('string');
      expect(m.toolName!.length).toBeGreaterThan(0);
    }
    expect(toolMessages.map((m) => m.toolName)).toEqual(
      expect.arrayContaining(['run_command', 'view_file', 'list_dir']),
    );
  });
});
