/**
 * Usage-extraction tests for the native-history transcript adapters.
 *
 * The load-bearing cases here are the REGRESSION ones: usage is an additive
 * field, so every assertion about content/role/timestamp must still hold
 * exactly as it did before usage existed. A parser that gains token counts but
 * shifts a single message is a net loss.
 *
 * Covers, per provider:
 *  - usage present  → normalized totals with the right accumulation semantics
 *  - usage absent   → session still parses, `usage` is simply undefined
 *  - regression     → messages/roles/timestamps unchanged by the usage work
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir = '';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

const { readSession: readClaudeSession } = await import('../../../src/providers/native-history/claude-cli-transcript.js');
const { readSession: readCodexSession } = await import('../../../src/providers/native-history/codex-cli-transcript.js');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-transcript-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── claude-cli ─────────────────────────────────────────────────────────────

function writeClaudeTranscript(sessionId: string, lines: object[]): string {
  const dir = path.join(tmpDir, '.claude', 'projects', 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return filePath;
}

describe('claude-cli usage', () => {
  const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('sums per-message usage deltas across assistant turns', () => {
    const file = writeClaudeTranscript(SESSION, [
      { type: 'user', sessionId: SESSION, timestamp: 1000, cwd: '/ws', message: { role: 'user', content: 'hi' } },
      {
        type: 'assistant',
        sessionId: SESSION,
        timestamp: 2000,
        message: {
          role: 'assistant',
          id: 'msg_1',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'hello' }],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 200,
          },
        },
      },
      {
        type: 'assistant',
        sessionId: SESSION,
        timestamp: 3000,
        message: {
          role: 'assistant',
          id: 'msg_2',
          content: [{ type: 'text', text: 'more' }],
          usage: {
            input_tokens: 20,
            output_tokens: 7,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);

    const session = readClaudeSession(file);
    expect(session?.usage).toBeDefined();
    expect(session!.usage!.inputTokens).toBe(30);
    expect(session!.usage!.outputTokens).toBe(12);
    expect(session!.usage!.cacheReadTokens).toBe(150);
    expect(session!.usage!.cacheCreationTokens).toBe(200);
    expect(session!.usage!.recordCount).toBe(2);
    expect(session!.usage!.agent).toBe('claude-cli');
    expect(session!.usage!.providerSessionId).toBe(SESSION);
  });

  it('counts a streamed message once even when re-emitted under one id', () => {
    // Claude re-emits a streaming assistant message across several lines that
    // share message.id, each carrying that message's usage. Counting each line
    // would multiply a long reply's cost.
    const file = writeClaudeTranscript(SESSION, [
      { type: 'user', sessionId: SESSION, timestamp: 1000, cwd: '/ws', message: { role: 'user', content: 'hi' } },
      {
        type: 'assistant', sessionId: SESSION, timestamp: 2000,
        message: { role: 'assistant', id: 'msg_dup', content: [{ type: 'text', text: 'part 1' }], usage: { input_tokens: 10, output_tokens: 5 } },
      },
      {
        type: 'assistant', sessionId: SESSION, timestamp: 2100,
        message: { role: 'assistant', id: 'msg_dup', content: [{ type: 'text', text: 'part 2' }], usage: { input_tokens: 10, output_tokens: 5 } },
      },
    ]);

    const session = readClaudeSession(file);
    expect(session!.usage!.recordCount).toBe(1);
    expect(session!.usage!.inputTokens).toBe(10);
    expect(session!.usage!.outputTokens).toBe(5);
    // Both text parts are still rendered — dedupe applies to usage only.
    const texts = session!.messages.filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(texts).toEqual(['part 1', 'part 2']);
  });

  it('parses a transcript with no usage at all and leaves usage undefined', () => {
    const file = writeClaudeTranscript(SESSION, [
      { type: 'user', sessionId: SESSION, timestamp: 1000, cwd: '/ws', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', sessionId: SESSION, timestamp: 2000, message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    ]);

    const session = readClaudeSession(file);
    expect(session).not.toBeNull();
    expect(session!.usage).toBeUndefined();
    expect(session!.messages.some((m) => m.content === 'hello')).toBe(true);
  });

  it('REGRESSION: content, role, kind and timestamps are unchanged by usage extraction', () => {
    const file = writeClaudeTranscript(SESSION, [
      { type: 'user', sessionId: SESSION, timestamp: 1000, cwd: '/ws', message: { role: 'user', content: 'question' } },
      {
        type: 'assistant', sessionId: SESSION, timestamp: 2000,
        message: {
          role: 'assistant', id: 'm1',
          content: [
            { type: 'text', text: 'answer' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]);

    const session = readClaudeSession(file);
    const visible = session!.messages.filter((m) => m.kind !== 'session_start');

    expect(visible.map((m) => ({ role: m.role, content: m.content, kind: m.kind }))).toEqual([
      { role: 'user', content: 'question', kind: 'standard' },
      { role: 'assistant', content: 'answer', kind: 'standard' },
      { role: 'assistant', content: 'Bash: ls', kind: 'tool' },
    ]);
    expect(visible[0].receivedAt).toBe(1000);
    expect(visible[1].receivedAt).toBe(2000);
    expect(session!.workspace).toBe('/ws');
    expect(session!.providerSessionId).toBe(SESSION);
  });

  it('counts an assistant turn whose content yields no bubbles', () => {
    // A tool-only turn still consumed tokens; billing must not depend on
    // whether the turn produced renderable text.
    const file = writeClaudeTranscript(SESSION, [
      { type: 'user', sessionId: SESSION, timestamp: 1000, cwd: '/ws', message: { role: 'user', content: 'hi' } },
      {
        type: 'assistant', sessionId: SESSION, timestamp: 2000,
        message: { role: 'assistant', id: 'm_empty', content: [], usage: { input_tokens: 99, output_tokens: 3 } },
      },
    ]);

    const session = readClaudeSession(file);
    expect(session!.usage!.inputTokens).toBe(99);
    expect(session!.usage!.outputTokens).toBe(3);
  });
});

// ─── codex-cli ──────────────────────────────────────────────────────────────

function writeCodexRollout(sessionId: string, lines: object[]): string {
  const dir = path.join(tmpDir, '.codex', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return filePath;
}

describe('codex-cli usage', () => {
  const SESSION = '019d5335-8495-7b62-880e-473bc5196cc7';

  function metaLine(): object {
    return { type: 'session_meta', timestamp: 1000, payload: { id: SESSION, cwd: '/ws' } };
  }

  function tokenCountLine(
    timestamp: number,
    totals: Record<string, number> | null,
  ): object {
    return {
      type: 'event_msg',
      timestamp,
      payload: {
        type: 'token_count',
        info: totals ? { total_token_usage: totals, model_context_window: 258400 } : null,
        rate_limits: { primary: { used_percent: 8 } },
      },
    };
  }

  it('takes the LAST cumulative total rather than summing every report', () => {
    // Real rollouts re-report total_token_usage on every turn. Summing three
    // records below would yield 6000 input; the true session total is 3000.
    const file = writeCodexRollout(SESSION, [
      metaLine(),
      { type: 'response_item', timestamp: 1100, payload: { type: 'message', role: 'user', content: 'hi' } },
      tokenCountLine(1200, { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 1, total_tokens: 1010 }),
      tokenCountLine(1300, { input_tokens: 2000, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 2, total_tokens: 2020 }),
      tokenCountLine(1400, { input_tokens: 3000, cached_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 3, total_tokens: 3030 }),
    ]);

    const session = readCodexSession(file);
    expect(session?.usage).toBeDefined();
    expect(session!.usage!.inputTokens).toBe(3000);
    expect(session!.usage!.outputTokens).toBe(30);
    expect(session!.usage!.reasoningTokens).toBe(3);
    expect(session!.usage!.recordCount).toBe(3);
    expect(session!.usage!.agent).toBe('codex-cli');
  });

  it('subtracts cached tokens so inputTokens means uncached input', () => {
    // codex reports input_tokens INCLUSIVE of cached_input_tokens, unlike
    // claude where the two are disjoint.
    const file = writeCodexRollout(SESSION, [
      metaLine(),
      { type: 'response_item', timestamp: 1100, payload: { type: 'message', role: 'user', content: 'hi' } },
      tokenCountLine(1200, { input_tokens: 15618, cached_input_tokens: 13696, output_tokens: 219, reasoning_output_tokens: 51, total_tokens: 15837 }),
    ]);

    const session = readCodexSession(file);
    expect(session!.usage!.inputTokens).toBe(15618 - 13696);
    expect(session!.usage!.cacheReadTokens).toBe(13696);
  });

  it('ignores a token_count whose info is null', () => {
    // Observed live: codex emits bare token_count lines carrying only
    // rate_limits. Those are quota refreshes, not token observations.
    const file = writeCodexRollout(SESSION, [
      metaLine(),
      { type: 'response_item', timestamp: 1100, payload: { type: 'message', role: 'user', content: 'hi' } },
      tokenCountLine(1200, null),
    ]);

    const session = readCodexSession(file);
    expect(session).not.toBeNull();
    expect(session!.usage).toBeUndefined();
  });

  it('parses a rollout with no token_count lines and leaves usage undefined', () => {
    const file = writeCodexRollout(SESSION, [
      metaLine(),
      { type: 'response_item', timestamp: 1100, payload: { type: 'message', role: 'user', content: 'hi' } },
      { type: 'response_item', timestamp: 1200, payload: { type: 'message', role: 'assistant', content: 'hello' } },
    ]);

    const session = readCodexSession(file);
    expect(session).not.toBeNull();
    expect(session!.usage).toBeUndefined();
  });

  it('REGRESSION: messages, roles and workspace are unchanged by usage extraction', () => {
    const file = writeCodexRollout(SESSION, [
      metaLine(),
      { type: 'response_item', timestamp: 1100, payload: { type: 'message', role: 'user', content: 'question' } },
      tokenCountLine(1150, { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 11 }),
      { type: 'response_item', timestamp: 1200, payload: { type: 'message', role: 'assistant', content: 'answer' } },
    ]);

    const session = readCodexSession(file);
    const visible = session!.messages.filter((m) => m.kind !== 'session_start');

    // A token_count line must contribute NO message.
    expect(visible.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ]);
    expect(visible[0].receivedAt).toBe(1100);
    expect(visible[1].receivedAt).toBe(1200);
    expect(session!.workspace).toBe('/ws');
    expect(session!.providerSessionId).toBe(SESSION);
  });
});
