import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeNativeHistory } from '../../src/providers/spec/native-history-executor.js';
import { readCliProviderNativeHistory } from '../../src/commands/chat-commands-read-native.js';
import { handleReadChat, __getProviderSessionPinForTest, __resetProviderSessionPinsForTest } from '../../src/commands/chat-commands.js';
const RUNTIME = 'synthetic-runtime-codex-identity';
const UUID = '019ea15f-dddd-7133-8347-920def0c7906';
let root: string, workspace: string, source: any, provider: any, spawn: number;
let writes: ReturnType<typeof vi.fn>;
function helpers(live = false, messages: any[] = []) {
  const adapter = {
    cliType: 'codex-cli', cliName: 'Codex CLI', workingDir: workspace,
    getStatus: () => ({ status: 'idle' }), getScriptParsedStatus: () => ({ status: 'idle', messages }),
    getRuntimeMetadata: () => ({ runtimeId: RUNTIME, runtimeKey: RUNTIME, spawnedAtMs: spawn, spawnedEnv: {} }),
    getPartialResponse: () => '', isProcessing: () => false, isReady: () => true, updateRuntimeMeta: writes,
  };
  return {
    getCdp: () => null, getProvider: () => provider, getProviderScript: () => null,
    evaluateProviderScript: async () => null, getCliAdapter: () => live ? adapter : null,
    currentSession: undefined, agentStream: null,
    ctx: { instanceManager: { getInstance: () => null }, sessionRegistry: {
      get: (id: string) => id === RUNTIME ? { sessionId: RUNTIME, providerType: 'codex-cli', transport: 'pty', workspace, spawnedAtMs: spawn } : undefined,
      setProviderSessionId: writes,
    } }, historyWriter: { appendNewMessages: () => {} },
  };
}
function rollout(cwd = workspace) {
  const born = new Date(spawn - 3600_000).toISOString();
  const file = path.join(root, `rollout-${UUID}.jsonl`);
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id: UUID, cwd, timestamp: born } },
    { type: 'response_item', timestamp: born, payload: { type: 'message', role: 'user', content: [{ text: 'SYNTHETIC_FOREIGN_PROMPT' }] } },
    { type: 'response_item', timestamp: born, payload: { type: 'message', role: 'assistant', content: [{ text: 'SYNTHETIC_FOREIGN_ANSWER' }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.utimesSync(file, new Date(), new Date());
}
function read(h: any, args: any = {}) {
  return handleReadChat(h, { agentType: 'codex-cli', targetSessionId: RUNTIME, workspace, tailLimit: 20, ...args });
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-codex-identity-'));
  workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  spawn = Date.now() - 1000; writes = vi.fn();
  source = { source: { kind: 'jsonl', path: root, file_pattern: 'rollout-*.jsonl', session_id_from: 'filename_uuid',
    message_filter: { where: "$.type == 'response_item' && $.payload.type == 'message'" },
    message_map: { role: '$.payload.role', content: '$.payload.content[0].text', timestamp_ms: '$.timestamp' } } };
  provider = { type: 'codex-cli', category: 'cli', nativeHistory: { mode: 'canonical', scripts: { readSession: 'readNativeHistory' } },
    historyBehavior: {}, scripts: { readNativeHistory: (input: any) => executeNativeHistory(source, input) } };
  __resetProviderSessionPinsForTest(); rollout();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
describe('targeted Codex native identity through real JSONL read consumer', () => {
  it('keeps old-born/new-mtime same-workspace candidate unconfirmed and workspace-scoped', () => {
    const result = readCliProviderNativeHistory('codex-cli', { canonicalHistory: provider.nativeHistory, scripts: provider.scripts,
      workspace, sessionStartedAtMs: spawn, instanceId: RUNTIME, offset: 0, limit: 20, excludeRecentCount: 0 });
    expect(result.providerSessionId).toBe(UUID); expect(result.ownerConfirmed).toBe(false); expect(result.lookup).toBe('workspace');
  });
  it('does not promote a near-spawn timestamp into ownership proof', () => {
    spawn -= 3600_000;
    const result = readCliProviderNativeHistory('codex-cli', { canonicalHistory: provider.nativeHistory, scripts: provider.scripts,
      workspace, sessionStartedAtMs: spawn, instanceId: RUNTIME, offset: 0, limit: 20, excludeRecentCount: 0 });
    expect(result.providerSessionId).toBe(UUID); expect(result.ownerConfirmed).toBe(false); expect(result.lookup).toBe('workspace');
  });
  it('never pins a first unsafe empty live read, and the next read remains safe', async () => {
    const h = helpers(true);
    for (let n = 0; n < 2; n++) {
      const result = await read(h);
      expect(result.messages).toEqual([]); expect(result.providerSessionId).not.toBe(UUID);
      expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined(); expect(writes).not.toHaveBeenCalled();
    }
  });
  it('preserves the owned PTY tail even when it overlaps a foreign candidate', async () => {
    const result = await read(helpers(true, [{ role: 'user', content: 'SYNTHETIC_FOREIGN_PROMPT', receivedAt: Date.now() }]));
    expect((result.messages as any[]).map(m => m.content)).toEqual(['SYNTHETIC_FOREIGN_PROMPT']);
    expect(result.providerSessionId).not.toBe(UUID); expect(writes).not.toHaveBeenCalled();
  });
  it('fails closed for completed unbound targeted reads with and without a spawn floor', async () => {
    for (const floor of [spawn, 0]) {
      spawn = floor; const result = await read(helpers());
      expect(result.pending).toBe(true); expect(result.messages).toEqual([]); expect(result.providerSessionId).toBeUndefined();
      expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined(); expect(writes).not.toHaveBeenCalled();
    }
  });
  it('accepts an explicit correct UUID and persists it only after safe selection', async () => {
    const result = await read(helpers(), { providerSessionId: UUID });
    expect(result.success).toBe(true); expect((result.messages as any[]).map(m => m.content)).toContain('SYNTHETIC_FOREIGN_ANSWER');
    expect(result.providerSessionId).toBe(UUID); expect(__getProviderSessionPinForTest(RUNTIME)).toBe(UUID);
    const next = await read(helpers());
    expect(next.providerSessionId).toBe(UUID);
    expect((next.messages as any[]).map(m => m.content)).toContain('SYNTHETIC_FOREIGN_ANSWER');
  });
  it('rejects explicit UUID ownership in another workspace without pinning', async () => {
    rollout(path.join(root, 'other-workspace')); const result = await read(helpers(), { providerSessionId: UUID });
    expect(result.pending).toBe(true); expect(result.messages).toEqual([]); expect(writes).not.toHaveBeenCalled();
    expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined();
  });
});
