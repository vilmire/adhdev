/**
 * grok-cli native history reader.
 *
 * Fixtures are copies of REAL grok 1.0.4 chat_history.jsonl records captured
 * from ~/.grok/sessions/<url-encoded-cwd>/<uuid>/, not hand-invented shapes.
 * The record types that matter here (and are easy to regress):
 *   - `synthetic_reason` user records are CLI-injected context, not user chat
 *   - real prompts arrive wrapped in <user_query> … </user_query>
 *   - assistant `content` is a bare STRING, and is empty for a tool-call turn
 *   - `reasoning` records carry content:null and must never render
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseGrokRecord,
  unwrapUserQuery,
  encodeWorkspaceDir,
  readSession,
  listSessions,
  resolveGrokPath,
} from '../../src/providers/native-history/grok-cli-transcript.js';

// Verbatim records from a captured session.
const SYSTEM = { type: 'system', content: 'You are Grok 4.6 released by xAI.' };
const USER_INFO = {
  type: 'user',
  content: [{ type: 'text', text: '<user_info>\nOS Version: macos\n</user_info>' }],
};
const SYNTHETIC = {
  type: 'user',
  synthetic_reason: 'system_reminder',
  content: [{ type: 'text', text: '<system-reminder>\nMCP servers connected:\n- tasks (9 tools)\n</system-reminder>' }],
};
const USER_QUERY = {
  type: 'user',
  prompt_index: 0,
  content: [{ type: 'text', text: '<user_query>\nWhat color is this image?\n</user_query>' }],
};
const REASONING = {
  type: 'reasoning',
  id: 'rs_50f4a86f',
  summary: [{ type: 'summary_text', text: 'The user wants me to look at an image.' }],
  encrypted_content: 'K+rMKWadZyCWO4NpliPg8Z22Y1I',
  status: 'completed',
  content: null,
};
const ASSISTANT_TOOL_CALL = {
  type: 'assistant',
  content: '',
  model_id: 'grok-4.6-build',
  tool_calls: [{ id: 'call-f98ad9ae-0', name: 'read_file', arguments: '{"target_file":"/tmp/blue64.png"}' }],
};
const TOOL_RESULT = {
  type: 'tool_result',
  tool_call_id: 'call-f98ad9ae-0',
  content: 'Read image file: /tmp/blue64.png',
};
const ASSISTANT_TEXT = { type: 'assistant', content: 'Blue', model_id: 'grok-4.6-build' };

describe('grok-cli transcript — record parsing', () => {
  it('drops the system prompt', () => {
    expect(parseGrokRecord(SYSTEM)).toBeNull();
  });

  it('drops CLI-injected synthetic context (system-reminder)', () => {
    // Regression guard: without the synthetic_reason check these render as if
    // the user had typed the MCP/skills reminder into the chat.
    expect(parseGrokRecord(SYNTHETIC)).toBeNull();
  });

  it('drops reasoning records (content is null, summary is thinking)', () => {
    expect(parseGrokRecord(REASONING)).toBeNull();
  });

  it('unwraps <user_query> to what the user actually typed', () => {
    const parsed = parseGrokRecord(USER_QUERY);
    expect(parsed).toEqual({ role: 'user', content: 'What color is this image?', kind: 'standard' });
  });

  it('reads assistant text from a bare string content', () => {
    const parsed = parseGrokRecord(ASSISTANT_TEXT);
    expect(parsed).toEqual({ role: 'assistant', content: 'Blue', kind: 'standard' });
  });

  it('names the tool instead of emitting an empty bubble for a tool-call turn', () => {
    const parsed = parseGrokRecord(ASSISTANT_TOOL_CALL);
    expect(parsed).toEqual({ role: 'assistant', content: '[tool: read_file]', kind: 'tool' });
  });

  it('surfaces tool_result as a tool message', () => {
    const parsed = parseGrokRecord(TOOL_RESULT);
    expect(parsed?.kind).toBe('tool');
    expect(parsed?.content).toContain('Read image file');
  });

  it('leaves an unwrapped prompt untouched', () => {
    expect(unwrapUserQuery('plain text')).toBe('plain text');
  });
});

describe('grok-cli transcript — workspace dir encoding', () => {
  it('percent-encodes the cwd the way grok names its session dirs', () => {
    // Verified against a real on-disk dir name.
    expect(encodeWorkspaceDir('/private/tmp/grokprobe/ws')).toBe('%2Fprivate%2Ftmp%2Fgrokprobe%2Fws');
  });
});

describe('grok-cli transcript — session read/list', () => {
  let home: string;
  let prevGrokHome: string | undefined;
  const workspace = '/tmp/grok-fixture-ws';
  const sessionId = '01a00394-3aed-7823-8a61-adf9316eb82f';

  function writeSession(id: string, records: unknown[], createdAt: string): string {
    const dir = path.join(home, 'sessions', encodeWorkspaceDir(workspace), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'chat_history.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify({ info: { id, cwd: workspace }, created_at: createdAt }),
    );
    return path.join(dir, 'chat_history.jsonl');
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
    prevGrokHome = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
  });

  afterEach(() => {
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reads a full turn, keeping only user-visible messages in order', () => {
    const file = writeSession(
      sessionId,
      [SYSTEM, USER_INFO, SYNTHETIC, USER_QUERY, REASONING, ASSISTANT_TOOL_CALL, TOOL_RESULT, ASSISTANT_TEXT],
      '2026-08-15T03:36:23.102979Z',
    );

    const session = readSession(file, sessionId, workspace);
    expect(session).not.toBeNull();
    expect(session!.providerSessionId).toBe(sessionId);

    const shape = session!.messages.map((m) => [m.role, m.kind, m.content]);
    expect(shape).toEqual([
      ['user', 'standard', '<user_info>\nOS Version: macos\n</user_info>'],
      ['user', 'standard', 'What color is this image?'],
      ['assistant', 'tool', '[tool: read_file]'],
      ['assistant', 'tool', 'Read image file: /tmp/blue64.png'],
      ['assistant', 'standard', 'Blue'],
    ]);
  });

  it('assigns monotonically non-decreasing receivedAt despite no on-disk timestamps', () => {
    // grok's chat_history carries no per-message ts; ordering must still hold.
    const file = writeSession(sessionId, [USER_QUERY, ASSISTANT_TEXT], '2026-08-15T03:36:23.102979Z');
    const session = readSession(file, sessionId, workspace)!;
    const times = session.messages.map((m) => m.receivedAt);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
  });

  it('gives every message a stable distinct providerUnitKey', () => {
    const file = writeSession(sessionId, [USER_QUERY, ASSISTANT_TEXT], '2026-08-15T03:36:23.102979Z');
    const keys = readSession(file, sessionId, workspace)!.messages.map((m) => m.providerUnitKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toContain(sessionId);
  });

  it('resolves the transcript path from workspace + session uuid', () => {
    writeSession(sessionId, [USER_QUERY, ASSISTANT_TEXT], '2026-08-15T03:36:23.102979Z');
    const resolved = resolveGrokPath(workspace, sessionId);
    expect(resolved).not.toBeNull();
    expect(resolved).toContain(sessionId);
    expect(resolved!.endsWith('chat_history.jsonl')).toBe(true);
  });

  it('refuses a non-uuid session id rather than guessing a transcript', () => {
    writeSession(sessionId, [USER_QUERY], '2026-08-15T03:36:23.102979Z');
    expect(resolveGrokPath(workspace, '../../etc/passwd')).toBeNull();
    expect(resolveGrokPath(workspace, 'not-a-uuid')).toBeNull();
  });

  it('enumerates sessions for the workspace with a preview title', () => {
    writeSession(sessionId, [USER_QUERY, ASSISTANT_TEXT], '2026-08-15T03:36:23.102979Z');
    writeSession('01a00392-540f-7bc3-a26f-e14298b7ae23', [USER_QUERY], '2026-08-15T03:30:00.000000Z');

    const listed = listSessions(workspace);
    expect(listed.length).toBe(2);
    expect(listed[0].agent).toBe('grok-cli');
    expect(listed[0].sessionTitle).toBe('What color is this image?');
    expect(listed.every((s) => s.messageCount > 0)).toBe(true);
  });

  it('returns an empty list for a workspace with no grok sessions', () => {
    expect(listSessions('/tmp/never-used-by-grok')).toEqual([]);
  });

  it('titles a session with the real prompt, not the <user_info> preamble', () => {
    // Every grok session opens with an environment preamble in a user record.
    // Titling from it makes every row in the saved-session list look identical.
    const file = writeSession(sessionId, [USER_INFO, USER_QUERY, ASSISTANT_TEXT], '2026-08-15T03:36:23.102979Z');
    const listed = listSessions(workspace);
    expect(listed[0].sessionTitle).toBe('What color is this image?');
    expect(listed[0].preview).not.toContain('<user_info>');
    expect(file).toContain(sessionId);
  });

  it('falls back to the preamble when a session has no real prompt yet', () => {
    writeSession(sessionId, [USER_INFO], '2026-08-15T03:36:23.102979Z');
    const listed = listSessions(workspace);
    expect(listed[0].sessionTitle).toContain('<user_info>');
  });
});
