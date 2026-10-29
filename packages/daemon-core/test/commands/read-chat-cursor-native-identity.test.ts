/**
 * cursor-cli native identity (live 2026-10-29): cursor-agent takes no
 * --session-id, so the only identity proof is the claim transaction in the
 * native-history executor (sent-prompt evidence + exclusive per-session
 * transcript claim). A transcript this session holds a live claim on must map
 * safely (native-history selected, assistant answer present); an unclaimed
 * ambiguous pair of candidates or a foreign claim must stay fail-closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeNativeHistory, claimKeyForPath } from '../../src/providers/spec/native-history-executor.js';
import { __resetSentPromptRegistry, recordSentPrompt } from '../../src/providers/native-history/sent-prompt-registry.js';
import { __resetTranscriptClaimRegistry, claimTranscript, transcriptClaimOwnerToken } from '../../src/providers/native-history/transcript-claim-registry.js';
import { handleReadChat, __resetProviderSessionPinsForTest } from '../../src/commands/chat-commands.js';

const RUNTIME = 'synthetic-runtime-cursor-identity';
const PROMPT = 'Create a file notes/x.txt containing the single line: hello cursor identity';
const ANSWER = 'SYNTHETIC_CURSOR_ANSWER';
const U1 = 'f12ca58e-985f-4aaa-b99e-e8c2b9ecd3ea';
let root: string, workspace: string, provider: any, spawn: number;

const slug = (ws: string) => ws.replace(/^\/+/, '').replace(/[^A-Za-z0-9_-]/g, '-');
function transcript(uuid: string, prompt = PROMPT) {
  const dir = path.join(root, 'projects', slug(workspace), 'agent-transcripts', uuid);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, [
    { role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${prompt}\n</user_query>` }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: ANSWER }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const t = new Date(); fs.utimesSync(file, t, t);
}
function helpers() {
  const adapter = {
    cliType: 'cursor-cli', cliName: 'Cursor Agent', workingDir: workspace,
    getStatus: () => ({ status: 'idle' }),
    getScriptParsedStatus: () => ({ status: 'idle', messages: [{ role: 'user', content: PROMPT, kind: 'standard' }] }),
    getRuntimeMetadata: () => ({ runtimeId: RUNTIME, runtimeKey: RUNTIME, spawnedAtMs: spawn, spawnedEnv: {} }),
    getPartialResponse: () => '', isProcessing: () => false, isReady: () => true, updateRuntimeMeta: vi.fn(),
  };
  return {
    getCdp: () => null, getProvider: () => provider, getProviderScript: () => null,
    evaluateProviderScript: async () => null, getCliAdapter: () => adapter,
    currentSession: undefined, agentStream: null,
    ctx: { instanceManager: { getInstance: () => null }, sessionRegistry: {
      get: (id: string) => id === RUNTIME ? { sessionId: RUNTIME, providerType: 'cursor-cli', transport: 'pty', workspace, spawnedAtMs: spawn } : undefined,
      setProviderSessionId: vi.fn(),
    } }, historyWriter: { appendNewMessages: () => {} },
  };
}
const read = (h: any) => handleReadChat(h, { agentType: 'cursor-cli', targetSessionId: RUNTIME, workspace, tailLimit: 20 });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-cursor-identity-'));
  workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  spawn = Date.now() - 5000;
  const source = { source: { kind: 'jsonl', path: path.join(root, 'projects', '*', 'agent-transcripts', '*'), file_pattern: '*.jsonl',
    session_id_from: 'filename_uuid', workspace_from_input: true,
    message_map: { role: '$.role', content: '$.message.content', content_strip: ['timestamp'], content_unwrap: ['user_query'], tools: {} } } };
  provider = { type: 'cursor-cli', category: 'cli', nativeHistory: { mode: 'canonical', scripts: { readSession: 'readNativeHistory' } },
    historyBehavior: {}, scripts: { readNativeHistory: (input: any) => executeNativeHistory(source as any, input) } };
  __resetProviderSessionPinsForTest(); __resetSentPromptRegistry(); __resetTranscriptClaimRegistry();
  recordSentPrompt(RUNTIME, PROMPT);
});
afterEach(() => {
  __resetSentPromptRegistry(); __resetTranscriptClaimRegistry();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('cursor-cli native identity via prompt-evidence claim', () => {
  it('maps the claimed transcript safely and returns the assistant answer from native history', async () => {
    transcript(U1);
    const result: any = await read(helpers());
    expect(result.messageSource?.selected).toBe('native-history');
    expect(result.messageSource?.identityStatus).toBe('safe');
    expect(result.messageSource?.coverage?.safeMapping).toBe(true);
    expect((result.messages as any[]).map(m => m.content)).toContain(ANSWER);
  });

  it('stays fail-closed when the only matching transcript is claimed by another session', async () => {
    transcript(U1);
    const key = claimKeyForPath(path.join(root, 'projects', slug(workspace), 'agent-transcripts', U1, `${U1}.jsonl`));
    expect(claimTranscript(key, transcriptClaimOwnerToken('synthetic-other-session'))).toBe('claimed');
    const result: any = await read(helpers());
    expect(result.messageSource?.selected).not.toBe('native-history');
    expect(result.messageSource?.coverage?.safeMapping).not.toBe(true);
    expect((result.messages as any[]).map(m => m.content)).not.toContain(ANSWER);
  });
});
