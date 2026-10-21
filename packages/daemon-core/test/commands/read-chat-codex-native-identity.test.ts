import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claimKeyForPath, executeNativeHistory } from '../../src/providers/spec/native-history-executor.js';
import { __resetSentPromptRegistry, recordSentPrompt } from '../../src/providers/native-history/sent-prompt-registry.js';
import { __resetTranscriptClaimRegistry } from '../../src/providers/native-history/transcript-claim-registry.js';
import { readCliProviderNativeHistory } from '../../src/commands/chat-commands-read-native.js';
import { handleChatHistory, handleReadChat, __getProviderSessionPinForTest, __resetProviderSessionPinsForTest } from '../../src/commands/chat-commands.js';
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
function page(h: any, args: any = {}) {
  return handleChatHistory(h, { agentType: 'codex-cli', targetSessionId: RUNTIME, workspace,
    offset: 0, limit: 20, excludeRecentCount: 0, ...args });
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
  __resetProviderSessionPinsForTest();
  __resetSentPromptRegistry();
  __resetTranscriptClaimRegistry();
  rollout();
});
afterEach(() => {
  __resetSentPromptRegistry();
  __resetTranscriptClaimRegistry();
  fs.rmSync(root, { recursive: true, force: true });
});
describe('targeted Codex native identity through real JSONL read consumer', () => {
  it.each(['no-owner', 'unrelated-current', 'fallback-adapter', 'inactive_record', 'recovery_snapshot'] as const)(
    'refuses unknown targeted ownership in %s mode across both consumers and subsequent reads', async (mode) => {
      const foreignWorkspace = path.join(root, 'foreign-workspace'); fs.mkdirSync(foreignWorkspace);
      rollout(foreignWorkspace);
      const h: any = helpers(mode !== 'no-owner' && mode !== 'unrelated-current');
      h.ctx.sessionRegistry.get = () => undefined;
      if (mode === 'unrelated-current') h.currentSession = {
        sessionId: 'synthetic-unrelated-B', providerType: 'codex-cli', transport: 'pty', workspace: foreignWorkspace,
      };
      if (mode !== 'no-owner' && mode !== 'unrelated-current') {
        const adapter = h.getCliAdapter();
        h.getCliAdapter = () => ({ ...adapter, workingDir: foreignWorkspace,
          getRuntimeMetadata: () => ({ runtimeId: mode === 'fallback-adapter' ? 'synthetic-other-B' : RUNTIME,
            surfaceKind: mode === 'fallback-adapter' ? undefined : mode }),
        });
      }
      const nativeLookup = vi.spyOn(provider.scripts, 'readNativeHistory');
      const history = await page(h, { workspace: undefined, providerSessionId: UUID });
      expect(history.code).toBe('chat_history_target_workspace_unconfirmed');
      for (const args of [{ workspace: undefined, providerSessionId: UUID },
        { workspace: foreignWorkspace, providerSessionId: UUID }, { workspace: undefined }]) {
        const result = await read(h, args);
        expect(result.success).toBe(false); expect(result.code).toBe('read_chat_target_workspace_unconfirmed');
        expect((result.messages || []).map((m: any) => m.content)).not.toContain('SYNTHETIC_FOREIGN_ANSWER');
        expect(result.providerSessionId).toBeUndefined();
        expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined(); expect(writes).not.toHaveBeenCalled();
      }
      expect(nativeLookup).not.toHaveBeenCalled();
    });
  it.each([false, true])('uses the registry workspace for omitted-workspace read_chat with unrelated coordinator=%s', async (coordinator) => {
    const foreignWorkspace = path.join(root, 'foreign-workspace'); fs.mkdirSync(foreignWorkspace);
    rollout(foreignWorkspace);
    const h: any = helpers();
    if (coordinator) h.currentSession = {
      sessionId: 'synthetic-unrelated-B', providerType: 'codex-cli', transport: 'pty', workspace: foreignWorkspace,
    };
    const nativeLookup = vi.spyOn(provider.scripts, 'readNativeHistory');
    const result = await read(h, { workspace: undefined, providerSessionId: UUID });
    expect(result.pending).toBe(true); expect(result.messages).toEqual([]);
    expect(nativeLookup).toHaveBeenCalledWith(expect.objectContaining({ workspace }));
    expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined(); expect(writes).not.toHaveBeenCalled();
    rollout();
    const own = await read(h, { workspace: undefined, providerSessionId: UUID });
    expect(own.success).toBe(true);
    expect((own.messages as any[]).map(m => m.content)).toContain('SYNTHETIC_FOREIGN_ANSWER');
    expect(__getProviderSessionPinForTest(RUNTIME)).toBe(UUID);
  });
  it('preserves untargeted explicit native read_chat without a runtime owner or pin', async () => {
    const result = await read(helpers(), { targetSessionId: undefined, providerSessionId: UUID });
    expect(result.success).toBe(true);
    expect((result.messages as any[]).map(m => m.content)).toContain('SYNTHETIC_FOREIGN_ANSWER');
    expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined(); expect(writes).not.toHaveBeenCalled();
  });
  it('uses the confirmed active adapter workspace for exact read_chat with omitted caller workspace', async () => {
    const h = helpers(true); h.ctx.sessionRegistry.get = () => undefined;
    const nativeLookup = vi.spyOn(provider.scripts, 'readNativeHistory');
    const result = await read(h, { workspace: undefined, providerSessionId: UUID });
    expect(result.success).toBe(true);
    expect((result.messages as any[]).map(m => m.content)).toContain('SYNTHETIC_FOREIGN_ANSWER');
    expect(nativeLookup).toHaveBeenCalledWith(expect.objectContaining({ workspace }));
    expect(__getProviderSessionPinForTest(RUNTIME)).toBe(UUID);
  });
  it.each(['override', 'omitted', 'unrelated-current'] as const)(
    'rejects a foreign exact UUID page with %s workspace input and leaves subsequent read_chat unpinned', async (mode) => {
      const foreignWorkspace = path.join(root, 'foreign-workspace'); fs.mkdirSync(foreignWorkspace);
      rollout(foreignWorkspace);
      const h: any = helpers();
      if (mode === 'unrelated-current') h.currentSession = {
        sessionId: 'synthetic-coordinator-B', providerType: 'codex-cli', transport: 'pty', workspace: foreignWorkspace,
      };
      const nativeLookup = vi.spyOn(provider.scripts, 'readNativeHistory');
      const result = await page(h, { providerSessionId: UUID,
        workspace: mode === 'override' ? foreignWorkspace : undefined });
      expect((result.messages || []).map((m: any) => m.content)).not.toContain('SYNTHETIC_FOREIGN_ANSWER');
      if (mode === 'override') {
        expect(result.code).toBe('read_chat_session_node_scope_mismatch');
        expect(nativeLookup).not.toHaveBeenCalled();
        expect((await read(h, { workspace: foreignWorkspace, providerSessionId: UUID })).code)
          .toBe('read_chat_session_node_scope_mismatch');
      } else {
        expect(result.messages).toEqual([]); expect(result.source).toBe('native-unavailable');
        expect(nativeLookup).toHaveBeenCalledWith(expect.objectContaining({ workspace }));
      }
      expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined(); expect(writes).not.toHaveBeenCalled();
      const next = await read(h);
      expect(next.pending).toBe(true); expect(next.messages).toEqual([]);
      expect(next.providerSessionId).toBeUndefined();
      expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined(); expect(writes).not.toHaveBeenCalled();
    });
  it('fails closed before lookup when targeted workspace ownership is unconfirmed', async () => {
    const h = helpers(); h.ctx.sessionRegistry.get = () => undefined;
    const nativeLookup = vi.spyOn(provider.scripts, 'readNativeHistory');
    const result = await page(h, { providerSessionId: UUID });
    expect(result.success).toBe(false); expect(result.code).toBe('chat_history_target_workspace_unconfirmed');
    expect(nativeLookup).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined();
  });
  it('rejects an unrelated adapter workspace as targeted ownership evidence', async () => {
    const h: any = helpers(true); h.ctx.sessionRegistry.get = () => undefined;
    const adapter = h.getCliAdapter();
    h.getCliAdapter = () => ({ ...adapter, getRuntimeMetadata: () => ({ runtimeId: 'synthetic-other-runtime' }) });
    const nativeLookup = vi.spyOn(provider.scripts, 'readNativeHistory');
    const result = await page(h, { providerSessionId: UUID });
    expect(result.code).toBe('chat_history_target_workspace_unconfirmed');
    expect(nativeLookup).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined();
  });
  it('uses a runtime-owned adapter workspace when the target registry is unavailable', async () => {
    const h = helpers(true); h.ctx.sessionRegistry.get = () => undefined;
    const result = await page(h, { workspace: undefined, providerSessionId: UUID });
    expect(result.source).toBe('provider-native');
    expect((result.messages as any[]).map(m => m.content)).toContain('SYNTHETIC_FOREIGN_ANSWER');
    expect(__getProviderSessionPinForTest(RUNTIME)).toBe(UUID);
  });
  it('uses the target registry for valid exact paging with omitted or unrelated coordinator workspace', async () => {
    for (const currentSession of [undefined, {
      sessionId: 'synthetic-coordinator-B', providerType: 'codex-cli', transport: 'pty', workspace: path.join(root, 'coordinator-B'),
    }]) {
      const h: any = helpers(); h.currentSession = currentSession;
      const result = await page(h, { workspace: undefined, providerSessionId: UUID });
      expect(result.source).toBe('provider-native');
      expect((result.messages as any[]).map(m => m.content)).toContain('SYNTHETIC_FOREIGN_ANSWER');
      expect(__getProviderSessionPinForTest(RUNTIME)).toBe(UUID);
    }
  });
  it('preserves untargeted explicit history reads without inferring a runtime pin', async () => {
    const result = await page(helpers(), { targetSessionId: undefined, providerSessionId: UUID });
    expect(result.source).toBe('provider-native');
    expect((result.messages as any[]).map(m => m.content)).toContain('SYNTHETIC_FOREIGN_ANSWER');
    expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined(); expect(writes).not.toHaveBeenCalled();
  });
  it('rejects unconfirmed workspace mtime/timestamp pages and keeps subsequent read_chat unpinned', async () => {
    for (const floor of [spawn, spawn - 3600_000, 0]) {
      spawn = floor;
      const h = helpers();
      expect((await read(h)).pending).toBe(true);
      const result = await page(h);
      expect(result.messages).toEqual([]); expect(result.source).toBe('native-unavailable');
      expect(result.providerSessionId).toBeUndefined();
      expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined(); expect(writes).not.toHaveBeenCalled();
      expect((await read(h)).pending).toBe(true);
    }
  });
  it('rejects an explicit cross-workspace page before any pin and keeps subsequent read_chat safe', async () => {
    rollout(path.join(root, 'other-workspace'));
    const result = await page(helpers(), { providerSessionId: UUID });
    expect(result.messages).toEqual([]); expect(result.source).toBe('native-unavailable');
    expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined(); expect(writes).not.toHaveBeenCalled();
    const next = await read(helpers());
    expect(next.pending).toBe(true); expect(next.messages).toEqual([]);
    expect(next.providerSessionId).toBeUndefined(); expect(writes).not.toHaveBeenCalled();
  });
  it('pages owned PTY rows after unsafe native selection without poisoning the next read', async () => {
    const rows = ['SYNTHETIC_OWNED_OLD', 'SYNTHETIC_OWNED_RECENT'].map((content, index) => ({
      role: 'assistant', content, receivedAt: Date.now() + index,
    }));
    const h = helpers(true, rows);
    const result = await page(h, { excludeRecentCount: 1, limit: 1 });
    expect(result.source).toBe('pty-parser');
    expect((result.messages as any[]).map(m => m.content)).toEqual(['SYNTHETIC_OWNED_OLD']);
    expect(result.hasMore).toBe(false);
    const next = await read(h);
    expect((next.messages as any[]).map(m => m.content)).not.toContain('SYNTHETIC_FOREIGN_ANSWER');
    expect(next.providerSessionId).not.toBe(UUID);
    expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined(); expect(writes).not.toHaveBeenCalled();
  });
  it('preserves exact UUID paging and subsequent native read reuse', async () => {
    const result = await page(helpers(), { providerSessionId: UUID, limit: 1 });
    expect(result.source).toBe('provider-native');
    expect((result.messages as any[]).map(m => m.content)).toEqual(['SYNTHETIC_FOREIGN_ANSWER']);
    expect(result.hasMore).toBe(true); expect(__getProviderSessionPinForTest(RUNTIME)).toBe(UUID);
    expect(writes).toHaveBeenCalled();
    const next = await read(helpers());
    expect(next.providerSessionId).toBe(UUID);
    expect((next.messages as any[]).map(m => m.content)).toContain('SYNTHETIC_FOREIGN_ANSWER');
  });
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
  it('never maps a new worker session to a same-workspace verifier transcript sharing the prompt header, and binds its own rollout on positive full-prompt match', async () => {
    const sharedHeader = '--- adhdev worker protocol --- You are a delegated worker in mission 19f46133 with a shared first line';
    const verifierPrompt = `${sharedHeader}\nTask: verify the previous worker output and inspect git diff.`;
    const workerPrompt = `${sharedHeader}\nTask: fix the three CLI/tooling defects in the dedicated worktree.`;
    const workerUuid = '019ea15f-eeee-7dd2-861e-e81c2ff13ae2';
    // Verifier session spawned > SPAWN_BIND_GRACE_MS (60s) before the worker, so on base
    // pickSessionBoundFile returns null and execution reaches pickRecentByPromptEvidence
    // (because verifierFile mtime is updated after worker spawn as the verifier actively runs).
    // On base 99d55c6a3, pickRecentByPromptEvidence matched the shared 80-char header prefix
    // (or assistant text quoting workerPrompt) and returned ownerConfirmed: true, cross-binding
    // and pinning the worker session to the verifier's UUID!
    const verifierBorn = new Date(spawn - 120_000).toISOString();
    const workerBorn = new Date(spawn).toISOString();

    const verifierFile = path.join(root, `rollout-${UUID}.jsonl`);
    fs.writeFileSync(verifierFile, [
      { type: 'session_meta', payload: { id: UUID, cwd: workspace, timestamp: verifierBorn } },
      { type: 'response_item', timestamp: verifierBorn, payload: { type: 'message', role: 'user', content: [{ text: verifierPrompt }] } },
      { type: 'response_item', timestamp: verifierBorn, payload: { type: 'message', role: 'assistant', content: [{ text: `VERIFIER_TRANSCRIPT inspecting: ${workerPrompt}` }] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    fs.utimesSync(verifierFile, new Date(), new Date());

    recordSentPrompt('verifier-runtime', verifierPrompt);
    recordSentPrompt(RUNTIME, workerPrompt);

    const h = helpers(true);
    // Both omitted historySessionId (which reaches pickRecentByPromptEvidence on base) and
    // runtimeId fallback must refuse the verifier transcript and leave the worker unpinned.
    for (const extraArgs of [{}, { historySessionId: RUNTIME }]) {
      const beforeOwnRollout = await read(h, extraArgs);
      expect((beforeOwnRollout.messages as any[]).map(m => m.content)).not.toContain(`VERIFIER_TRANSCRIPT inspecting: ${workerPrompt}`);
      expect(beforeOwnRollout.providerSessionId).not.toBe(UUID);
      expect(__getProviderSessionPinForTest(RUNTIME)).toBeUndefined();
      expect(writes).not.toHaveBeenCalled();
    }

    // Now the worker's own rollout is written (even with an older mtime than the verifier's rollout).
    const workerFile = path.join(root, `rollout-${workerUuid}.jsonl`);
    fs.writeFileSync(workerFile, [
      { type: 'session_meta', payload: { id: workerUuid, cwd: workspace, timestamp: workerBorn } },
      { type: 'response_item', timestamp: workerBorn, payload: { type: 'message', role: 'user', content: [{ text: workerPrompt }] } },
      { type: 'response_item', timestamp: workerBorn, payload: { type: 'message', role: 'assistant', content: [{ text: 'WORKER_OWN_ANSWER' }] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    const now = Date.now();
    fs.utimesSync(workerFile, (now - 500) / 1000, (now - 500) / 1000);
    fs.utimesSync(verifierFile, now / 1000, now / 1000);

    const afterOwnRollout = await read(h);
    expect((afterOwnRollout.messages as any[]).map(m => m.content)).toContain('WORKER_OWN_ANSWER');
    expect((afterOwnRollout.messages as any[]).map(m => m.content)).not.toContain(`VERIFIER_TRANSCRIPT inspecting: ${workerPrompt}`);
    expect(afterOwnRollout.providerSessionId).toBe(workerUuid);
    expect(__getProviderSessionPinForTest(RUNTIME)).toBe(workerUuid);
    expect(writes).toHaveBeenCalledWith(RUNTIME, workerUuid);
  });
  it('matches workspace paths case-insensitively on win32 when binding a Codex rollout', async () => {
    expect(claimKeyForPath('c:\\Users\\Example\\Project\\', 'win32')).toBe(
      claimKeyForPath('C:\\users\\example\\project', 'win32'),
    );
    const workerPrompt = 'WIN32_CASE_VARIATION_WORKER_PROMPT';
    const workerUuid = '019ea15f-ffff-7dd2-861e-e81c2ff13ae3';
    const workerBorn = new Date(spawn).toISOString();
    // Flip drive/path case when running on a case-insensitive filesystem (win32/darwin)
    const cwdInMeta = process.platform === 'win32'
      ? workspace.replace(/^[A-Za-z]:/, (m) => (m === m.toLowerCase() ? m.toUpperCase() : m.toLowerCase()))
      : workspace;
    const workerFile = path.join(root, `rollout-${workerUuid}.jsonl`);
    fs.writeFileSync(workerFile, [
      { type: 'session_meta', payload: { id: workerUuid, cwd: cwdInMeta, timestamp: workerBorn } },
      { type: 'response_item', timestamp: workerBorn, payload: { type: 'message', role: 'user', content: [{ text: workerPrompt }] } },
      { type: 'response_item', timestamp: workerBorn, payload: { type: 'message', role: 'assistant', content: [{ text: 'WIN32_CASE_MATCHED_ANSWER' }] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    fs.utimesSync(workerFile, new Date(), new Date());

    recordSentPrompt(RUNTIME, workerPrompt);
    const res = await read(helpers(true));
    expect((res.messages as any[]).map(m => m.content)).toContain('WIN32_CASE_MATCHED_ANSWER');
    expect(res.providerSessionId).toBe(workerUuid);
  });
});
