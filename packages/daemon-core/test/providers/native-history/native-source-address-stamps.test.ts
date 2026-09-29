/**
 * Native readers stamp the message identity ledger's source address (`_src`,
 * design 2026-09-28 §3.1–§3.2), and the address is append-stable: records
 * appended to the transcript never renumber an earlier bubble's address, so
 * its `n.<L>.<addr>` id survives every re-read. The dispatcher (first hop of
 * every native read) must carry the stamp by name.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lineageToken } from '../../../src/chat/message-source-address.js';

let tmpDir = '';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => tmpDir };
});

function writeLines(filePath: string, lines: object[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

const addrs = (messages: Array<{ _src?: any }>) => messages.map((m) => (m._src ? `${m._src.L}:${m._src.addr}` : null));

describe('native reader _src stamps', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-native-src-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('claude-cli: record/block addresses are stable when records append', async () => {
    const sessionId = 'a1b2c3d4-0000-0000-0000-00000000e001';
    const filePath = path.join(tmpDir, '.claude', 'projects', '-work', `${sessionId}.jsonl`);
    const lines: object[] = [
      { type: 'user', sessionId, timestamp: 1_800_000_001_000, cwd: '/work', message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant', sessionId, timestamp: 1_800_000_002_000,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Reading it' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] },
      },
    ];
    writeLines(filePath, lines);
    const { readSession } = await import('../../../src/providers/native-history/claude-cli-transcript.js');
    const first = readSession(filePath)!;
    const L = lineageToken(sessionId);
    // session_start, user (record 0), text block 0 → part 1, tool block 1 → part 2.
    expect(addrs(first.messages)).toEqual([`${L}:s`, `${L}:0.0`, `${L}:1.1`, `${L}:1.2`]);

    writeLines(filePath, [
      ...lines,
      { type: 'user', sessionId, timestamp: 1_800_000_003_000, isMeta: true, message: { role: 'user', content: '[Image: source: /tmp/x.png]' } },
      { type: 'user', sessionId, timestamp: 1_800_000_004_000, message: { role: 'user', content: 'thanks' } },
    ]);
    const second = readSession(filePath)!;
    expect(addrs(second.messages).slice(0, 4)).toEqual(addrs(first.messages));
    // The skipped isMeta record still consumed index 2.
    expect(addrs(second.messages)[4]).toBe(`${L}:3.0`);
  });

  it('codex-cli: one address per record, stable across appends', async () => {
    const sessionId = 'c0dec0de-0000-4000-8000-00000000e002';
    const filePath = path.join(tmpDir, '.codex', 'sessions', `rollout-${sessionId}.jsonl`);
    const lines: object[] = [
      { type: 'session_meta', timestamp: 1_800_000_000_000, payload: { id: sessionId, cwd: '/work' } },
      { type: 'response_item', timestamp: 1_800_000_001_000, payload: { type: 'message', role: 'user', content: 'hello' } },
      { type: 'response_item', timestamp: 1_800_000_002_000, payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' } },
      { type: 'response_item', timestamp: 1_800_000_003_000, payload: { type: 'message', role: 'assistant', content: 'done' } },
    ];
    writeLines(filePath, lines);
    const { readSession } = await import('../../../src/providers/native-history/codex-cli-transcript.js');
    const first = readSession(filePath)!;
    expect(first).not.toBeNull();
    const L = lineageToken(sessionId);
    expect(addrs(first.messages)).toEqual([`${L}:s`, `${L}:1.0`, `${L}:2.0`, `${L}:3.0`]);

    writeLines(filePath, [
      ...lines,
      { type: 'response_item', timestamp: 1_800_000_004_000, payload: { type: 'message', role: 'user', content: 'more' } },
    ]);
    const second = readSession(filePath)!;
    expect(addrs(second.messages).slice(0, 4)).toEqual(addrs(first.messages));
    expect(addrs(second.messages)[4]).toBe(`${L}:4.0`);
  });

  it('dispatcher carries the reader stamp through its allow-list projection', async () => {
    const sessionId = 'a1b2c3d4-0000-0000-0000-00000000e003';
    const filePath = path.join(tmpDir, '.claude', 'projects', '-workspaces-test', `${sessionId}.jsonl`);
    writeLines(filePath, [
      { type: 'user', sessionId, timestamp: 1_800_000_001_000, cwd: '/workspaces/test', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', sessionId, timestamp: 1_800_000_002_000, message: { role: 'assistant', content: 'hello' } },
    ]);
    const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
    const result = createNativeHistoryDispatcher('claude-cli')({ agentType: 'claude-cli', sessionId, workspace: '/workspaces/test' });
    expect(result).not.toBeNull();
    const L = lineageToken(sessionId);
    expect(result!.messages.map((m) => m._src)).toEqual([
      { cls: 'n', L, addr: 's' },
      { cls: 'n', L, addr: '0.0' },
      { cls: 'n', L, addr: '1.0' },
    ]);
  });

  it('end to end: the stamp survives the native history pipeline and becomes an n.* messageId at read_chat', async () => {
    const sessionId = 'a1b2c3d4-0000-0000-0000-00000000e004';
    const filePath = path.join(tmpDir, '.claude', 'projects', '-workspaces-test', `${sessionId}.jsonl`);
    writeLines(filePath, [
      { type: 'user', sessionId, timestamp: 1_800_000_001_000, cwd: '/workspaces/test', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', sessionId, timestamp: 1_800_000_002_000, message: { role: 'assistant', content: 'hello' } },
    ]);
    const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
    const { readProviderChatHistory } = await import('../../../src/config/provider-native-history.js');
    const { normalizeNativeHistoryMessages } = await import('../../../src/commands/chat-commands-read-native-normalize.js');
    const { buildReadChatCommandResult } = await import('../../../src/commands/read-chat-presentation.js');
    const history = readProviderChatHistory('claude-cli', {
      canonicalHistory: { scripts: { readSession: 'readNativeHistory' } } as any,
      scripts: { readNativeHistory: createNativeHistoryDispatcher('claude-cli') } as any,
      historySessionId: sessionId,
      workspace: '/workspaces/test',
      limit: 50,
    });
    expect(history.source).toBe('provider-native');
    const normalized = normalizeNativeHistoryMessages('claude-cli', history.messages as any, sessionId);
    const result = buildReadChatCommandResult(
      { status: 'idle', messages: normalized },
      { targetSessionId: 'sess-e2e-native', cliType: 'claude-cli' },
    ) as any;
    const L = lineageToken(sessionId);
    expect(result.messages.map((m: any) => m.messageId)).toEqual([`n.${L}.0.0`, `n.${L}.1.0`]);
    expect(result.messages.some((m: any) => '_src' in m)).toBe(false);
  });
});
