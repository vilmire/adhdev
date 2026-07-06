import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readProviderChatHistory: vi.fn(),
}))

vi.mock('../../src/config/chat-history.js', () => ({
  ChatHistoryWriter: class {
    appendNewMessages() {}
  },
  readProviderChatHistory: mocks.readProviderChatHistory,
  isNativeSourceCanonicalHistory: (canonicalHistory: any) => {
    if (!canonicalHistory) return false
    return canonicalHistory.mode !== 'disabled' && canonicalHistory.mode !== 'materialized-mirror'
  },
}))

import { __resetProviderSessionPinsForTest, handleReadChat } from '../../src/commands/chat-commands.js'
import { DaemonCommandHandler } from '../../src/commands/handler.js'
import { recordPersistedProviderSessionPin } from '../../src/config/state-store.js'

function createHelpers() {
  return {
    getCdp: () => null,
    getProvider: (type?: string) => {
      if (type === 'hermes-cli') {
        return { type: 'hermes-cli', category: 'cli', historyBehavior: { transcriptAuthority: 'provider' } }
      }
      if (type === 'codex-cli') {
        return { type: 'codex-cli', category: 'cli', nativeHistory: { mode: 'canonical' }, historyBehavior: {} }
      }
      if (type === 'antigravity-cli') {
        return { type: 'antigravity-cli', category: 'cli', nativeHistory: { mode: 'canonical' }, historyBehavior: {} }
      }
      return undefined
    },
    getProviderScript: () => null,
    evaluateProviderScript: async () => null,
    getCliAdapter: () => null,
    currentManagerKey: undefined,
    currentIdeType: undefined,
    currentProviderType: undefined,
    currentSession: undefined,
    agentStream: null,
    ctx: {
      instanceManager: { getInstance: () => null },
      sessionRegistry: { get: () => undefined },
    },
    historyWriter: { appendNewMessages: () => {} },
  }
}

describe('read_chat completed runtime provider fallback', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
    __resetProviderSessionPinsForTest()
  })

  it('a restored antigravity session (spawnedAtMs=0, no adapter provider id) reads via the PERSISTED pin after a daemon restart (ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP)', async () => {
    const runtimeSessionId = 'agy-restored-after-restart'
    const convUuid = '65c1fff8-543b-4f40-a8c4-49678a032dc9'

    // Simulate the pre-restart bind having been persisted to disk: on the fresh
    // (post-restart) process the pin is hydrated lazily from state.json. The
    // restored session itself carries NO provider session id (antigravity never
    // exposes one) and spawnedAtMs=0, so without the pin the read would key on the
    // bare runtime id, miss the exact-bind, and fall to the recency heuristic that
    // drops the idle store — returning the user prompt with no assistant tail.
    // The pre-restart bind is on disk. beforeEach already re-armed hydration and
    // emptied the in-memory map, so the first read below hydrates this pin straight
    // from state.json — exactly the cold-start restore path. (Disk→memory hydration
    // in isolation is covered by state-store.test.ts.)
    recordPersistedProviderSessionPin(runtimeSessionId, convUuid)

    mocks.readProviderChatHistory.mockImplementation((_agent: string, options: any) => {
      if (options?.historySessionId === convUuid) {
        return {
          messages: [
            { role: 'user', content: 'restored agy prompt', receivedAt: 1100, historySessionId: convUuid },
            { role: 'assistant', content: 'restored agy answer', receivedAt: 1200, historySessionId: convUuid },
          ],
          hasMore: false,
          source: 'provider-native',
          providerSessionId: convUuid,
          nativeHistoryCoverage: 'full',
        }
      }
      // Runtime-id keyed / unbound read → nothing (recency-excluded idle store).
      return { messages: [], hasMore: false, source: 'native-unavailable', unavailableReason: 'native_history_workspace_only_lookup_unsafe' }
    })

    const adapter = {
      cliType: 'antigravity-cli',
      cliName: 'Antigravity CLI',
      workingDir: '/tmp/adhdev-agy',
      getStatus: () => ({ status: 'idle' }),
      // No provider session id on screen — antigravity never prints it.
      getScriptParsedStatus: () => ({ status: 'idle', messages: [] }),
      getRuntimeMetadata: () => ({ runtimeId: runtimeSessionId, runtimeKey: runtimeSessionId, spawnedAtMs: 0, spawnedEnv: {} }),
      getPartialResponse: () => '',
      isProcessing: () => false,
      isReady: () => true,
    }
    const helpers = {
      ...createHelpers(),
      getCliAdapter: () => adapter,
      currentSession: {
        sessionId: runtimeSessionId,
        providerType: 'antigravity-cli',
        transport: 'pty',
        workspace: '/tmp/adhdev-agy',
      },
      ctx: {
        instanceManager: { getInstance: () => null },
        sessionRegistry: {
          get: (sessionId: string) => sessionId === runtimeSessionId
            ? { sessionId: runtimeSessionId, providerType: 'antigravity-cli', transport: 'pty', spawnedAtMs: 0 }
            : undefined,
        },
      },
    }

    const result = await handleReadChat(helpers as any, {
      agentType: 'antigravity-cli',
      targetSessionId: runtimeSessionId,
      workspace: '/tmp/adhdev-agy',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map(m => m.content)).toEqual(['restored agy prompt', 'restored agy answer'])
    // The read keyed on the PERSISTED conv uuid, never the bare runtime id.
    const keyedIds = mocks.readProviderChatHistory.mock.calls.map(c => (c[1] as any)?.historySessionId)
    expect(keyedIds).toContain(convUuid)
    expect(keyedIds).not.toContain(runtimeSessionId)
  })

  it('uses explicit providerType and providerSessionId when target runtime session is gone', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [{ role: 'assistant', content: 'completed answer', receivedAt: 1 }],
      hasMore: false,
      providerSessionId: 'provider-history-1',
    })

    const result = await handleReadChat(createHelpers() as any, {
      providerType: 'hermes-cli',
      targetSessionId: 'runtime-that-is-no-longer-active',
      providerSessionId: 'provider-history-1',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map(message => message.content)).toEqual(['completed answer'])
    expect(result.providerSessionId).toBe('provider-history-1')
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('hermes-cli', expect.objectContaining({
      historySessionId: 'provider-history-1',
      limit: 20,
    }))
  })

  it('keeps explicit agentType/providerSessionId available when target runtime session is already gone', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        { role: 'assistant', content: 'saved completed transcript', receivedAt: 1 },
      ],
      hasMore: false,
      providerSessionId: 'provider-session-42',
    })

    const handler = new DaemonCommandHandler({
      cdpManagers: new Map(),
      ideType: '',
      adapters: new Map(),
      providerLoader: {
        resolve: vi.fn((type: string) => type === 'hermes-cli'
          ? { type: 'hermes-cli', category: 'cli', historyBehavior: { transcriptAuthority: 'provider' } }
          : undefined),
      } as any,
      instanceManager: {
        getInstance: () => null,
        listInstanceIds: () => [],
      } as any,
      sessionRegistry: {
        get: () => undefined,
      } as any,
    })

    const result = await handler.handle('read_chat', {
      targetSessionId: 'runtime-session-gone',
      agentType: 'hermes-cli',
      providerSessionId: 'provider-session-42',
      tailLimit: 20,
    })

    expect(result).toMatchObject({
      success: true,
      providerSessionId: 'provider-session-42',
      totalMessages: 1,
    })
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('hermes-cli', expect.objectContaining({
      historySessionId: 'provider-session-42',
      limit: 20,
    }))
  })

  it('allows read_chat to fall through to history when only targetSessionId is provided for a missing session', async () => {
    // Regression: mesh coordinator calls read_chat with targetSessionId of a Codex CLI
    // session that has since been stopped/destroyed. No explicit providerSessionId is
    // passed. The handler must not hard-fail; it should serve persisted history using
    // the targetSessionId as the historySessionId key.
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [{ role: 'assistant', content: 'final codex answer', receivedAt: 1 }],
      hasMore: false,
      providerSessionId: '25e40a0f-2dce-4e5a-9d0d-8fbf63bf7016',
    })

    const handler = new DaemonCommandHandler({
      cdpManagers: new Map(),
      ideType: '',
      adapters: new Map(),
      providerLoader: {
        resolve: vi.fn((type: string) => type === 'codex-cli'
          ? { type: 'codex-cli', category: 'cli', historyBehavior: {} }
          : undefined),
      } as any,
      instanceManager: {
        getInstance: () => null,
        listInstanceIds: () => [],
      } as any,
      sessionRegistry: {
        get: () => undefined,
      } as any,
    })

    const result = await handler.handle('read_chat', {
      targetSessionId: '25e40a0f-2dce-4e5a-9d0d-8fbf63bf7016',
      agentType: 'codex-cli',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect((result.messages as any[]).length).toBeGreaterThan(0)
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('codex-cli', expect.objectContaining({
      historySessionId: '25e40a0f-2dce-4e5a-9d0d-8fbf63bf7016',
    }))
  })

  it('does not leak unmatched native history for a live codex runtime without providerSessionId', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        { role: 'assistant', content: 'old workspace transcript', receivedAt: 1, historySessionId: 'old-provider-session' },
      ],
      hasMore: false,
      source: 'provider-native',
      providerSessionId: 'old-provider-session',
    })

    const runtimeSessionId = 'runtime-live-without-provider-id'
    const adapter = {
      cliType: 'codex-cli',
      cliName: 'Codex CLI',
      workingDir: '/tmp/adhdev-project',
      getStatus: () => ({ status: 'idle' }),
      getScriptParsedStatus: () => ({ status: 'idle', messages: [] }),
      getRuntimeMetadata: () => ({
        runtimeId: runtimeSessionId,
        runtimeKey: runtimeSessionId,
        spawnedAtMs: 1000,
        spawnedEnv: {},
      }),
      getPartialResponse: () => '',
      isProcessing: () => false,
      isReady: () => true,
    }

    const result = await handleReadChat({
      ...createHelpers(),
      getCliAdapter: () => adapter,
      ctx: {
        instanceManager: { getInstance: () => null },
        sessionRegistry: {
          get: (sessionId: string) => sessionId === runtimeSessionId
            ? {
              sessionId: runtimeSessionId,
              providerType: 'codex-cli',
              transport: 'pty',
              spawnedAtMs: 1000,
            }
            : undefined,
        },
      },
    } as any, {
      agentType: 'codex-cli',
      targetSessionId: runtimeSessionId,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.messages).toEqual([])
    expect((result.messageSource as any)?.selected).toBe('pty-parser')
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('codex-cli', expect.objectContaining({
      historySessionId: undefined,
      workspace: '/tmp/adhdev-project',
      sessionStartedAtMs: 1000,
    }))
  })

  it('binds a live codex runtime to its spawn-matched native transcript and promotes the provider session id', async () => {
    const runtimeSessionId = 'runtime-live-without-provider-id-spawn-match'
    const providerSessionId = '019ea359-e438-7be2-b24e-88aedb6cd87c'
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        { role: 'user', content: 'unique prompt', receivedAt: 1100 },
        { role: 'assistant', content: 'unique answer', receivedAt: 1200 },
      ],
      hasMore: false,
      source: 'provider-native',
      providerSessionId,
    })
    const updateRuntimeMeta = vi.fn()
    const adapter = {
      cliType: 'codex-cli',
      cliName: 'Codex CLI',
      workingDir: '/tmp/adhdev-project',
      getStatus: () => ({ status: 'idle' }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        messages: [{ role: 'user', content: 'unique prompt', receivedAt: 1100 }],
      }),
      getRuntimeMetadata: () => ({
        runtimeId: runtimeSessionId,
        runtimeKey: runtimeSessionId,
        spawnedAtMs: 1000,
        spawnedEnv: {},
      }),
      updateRuntimeMeta,
      getPartialResponse: () => '',
      isProcessing: () => false,
      isReady: () => true,
    }

    const result = await handleReadChat({
      ...createHelpers(),
      getCliAdapter: () => adapter,
      ctx: {
        instanceManager: { getInstance: () => null },
        sessionRegistry: {
          get: (sessionId: string) => sessionId === runtimeSessionId
            ? {
              sessionId: runtimeSessionId,
              providerType: 'codex-cli',
              transport: 'pty',
              spawnedAtMs: 1000,
            }
            : undefined,
        },
      },
    } as any, {
      agentType: 'codex-cli',
      targetSessionId: runtimeSessionId,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map(message => message.content)).toEqual([
      'unique prompt',
      'unique answer',
    ])
    expect(result.providerSessionId).toBe(providerSessionId)
    expect(updateRuntimeMeta).toHaveBeenCalledWith({ providerSessionId })
  })

  it('does not use same-workspace Codex native history when an exact provider session is still empty', async () => {
    const runtimeSessionId = 'runtime-live-with-provider-id'
    const providerSessionId = '019ea33e-6f7e-7b51-91de-5b9531f2711b'
    mocks.readProviderChatHistory.mockImplementation((_agentType: string, options: any) => {
      if (options?.historySessionId === providerSessionId) {
        return {
          messages: [],
          hasMore: false,
          source: 'native-unavailable',
        }
      }
      return {
        messages: [{ role: 'assistant', content: 'old workspace transcript', receivedAt: 1 }],
        hasMore: false,
        providerSessionId: 'old-provider-session',
        source: 'provider-native',
      }
    })

    const adapter = {
      cliType: 'codex-cli',
      cliName: 'Codex CLI',
      workingDir: '/tmp/adhdev-project',
      getStatus: () => ({ status: 'idle' }),
      getScriptParsedStatus: () => ({ status: 'idle', messages: [] }),
      getRuntimeMetadata: () => ({
        runtimeId: runtimeSessionId,
        runtimeKey: runtimeSessionId,
        providerSessionId,
        spawnedAtMs: 1000,
        spawnedEnv: {},
      }),
      getPartialResponse: () => '',
      isProcessing: () => false,
      isReady: () => true,
    }

    const result = await handleReadChat({
      ...createHelpers(),
      getCliAdapter: () => adapter,
      ctx: {
        instanceManager: { getInstance: () => null },
        sessionRegistry: {
          get: (sessionId: string) => sessionId === runtimeSessionId
            ? {
              sessionId: runtimeSessionId,
              providerSessionId,
              providerType: 'codex-cli',
              transport: 'pty',
              spawnedAtMs: 1000,
            }
            : undefined,
        },
      },
    } as any, {
      agentType: 'codex-cli',
      targetSessionId: runtimeSessionId,
      historySessionId: providerSessionId,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.messages).toEqual([])
    expect((result.messageSource as any)?.selected).toBe('pty-parser')
    expect(mocks.readProviderChatHistory).toHaveBeenCalledTimes(1)
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('codex-cli', expect.objectContaining({
      historySessionId: providerSessionId,
    }))
  })

  it('keeps an exact restored Codex transcript visible when a later native slice shrinks and PTY is empty', async () => {
    const runtimeSessionId = 'runtime-restored-exact-history'
    const providerSessionId = '019ea359-e414-7e70-bfd4-e774c8dcde87'
    let readCount = 0
    mocks.readProviderChatHistory.mockImplementation(() => {
      readCount += 1
      const messages = [
        { role: 'system', content: 'session context', receivedAt: 1000 },
        { role: 'user', content: 'restored prompt', receivedAt: 1100 },
        { role: 'assistant', content: 'restored answer', receivedAt: 1200 },
      ]
      return {
        messages: readCount === 1 ? messages : messages.slice(1),
        hasMore: false,
        source: 'provider-native',
        providerSessionId,
        nativeHistoryCoverage: 'full',
      }
    })

    const adapter = {
      cliType: 'codex-cli',
      cliName: 'Codex CLI',
      workingDir: '/tmp/adhdev-project',
      getStatus: () => ({ status: 'idle' }),
      getScriptParsedStatus: () => ({ status: 'idle', messages: [], providerSessionId }),
      getRuntimeMetadata: () => ({
        runtimeId: runtimeSessionId,
        runtimeKey: runtimeSessionId,
        providerSessionId,
        spawnedAtMs: 0,
        spawnedEnv: {},
      }),
      getPartialResponse: () => '',
      isProcessing: () => false,
      isReady: () => true,
    }
    const helpers = {
      ...createHelpers(),
      getCliAdapter: () => adapter,
      currentSession: {
        sessionId: runtimeSessionId,
        providerSessionId,
        providerType: 'codex-cli',
        transport: 'pty',
        workspace: '/tmp/adhdev-project',
      },
      ctx: {
        instanceManager: { getInstance: () => null },
        sessionRegistry: {
          get: (sessionId: string) => sessionId === runtimeSessionId
            ? {
              sessionId: runtimeSessionId,
              providerSessionId,
              providerType: 'codex-cli',
              transport: 'pty',
              spawnedAtMs: 0,
            }
            : undefined,
        },
      },
    }
    const args = {
      agentType: 'codex-cli',
      targetSessionId: runtimeSessionId,
      historySessionId: providerSessionId,
      providerSessionId,
      tailLimit: 20,
    }

    const first = await handleReadChat(helpers as any, args)
    const second = await handleReadChat(helpers as any, args)

    expect((first.messageSource as any)?.selected).toBe('native-history')
    expect((second.messageSource as any)?.selected).toBe('native-history')
    expect((second.messages as any[]).map(message => message.content)).toEqual([
      'restored prompt',
      'restored answer',
    ])
  })

  it('returns idle when provider-native history has a final assistant but PTY still reports generating', async () => {
    const runtimeSessionId = 'runtime-antigravity-stuck-busy'
    const providerSessionId = 'ag-session-1'
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        { role: 'user', content: 'Update README', receivedAt: 1800, workspace: '/tmp/adhdev-project' },
        { role: 'assistant', content: 'README updated.', receivedAt: 1900, workspace: '/tmp/adhdev-project' },
      ],
      hasMore: false,
      source: 'provider-native',
      providerSessionId,
      nativeHistoryCoverage: 'full',
      workspace: '/tmp/adhdev-project',
    })

    const adapter = {
      cliType: 'antigravity-cli',
      cliName: 'Antigravity',
      workingDir: '/tmp/adhdev-project',
      getStatus: () => ({ status: 'generating', providerSessionId, activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({
        status: 'generating',
        providerSessionId,
        messages: [],
        activeModal: null,
      }),
      getRuntimeMetadata: () => ({
        runtimeId: runtimeSessionId,
        runtimeKey: runtimeSessionId,
        providerSessionId,
        spawnedAtMs: 1000,
        spawnedEnv: {},
      }),
      getPartialResponse: () => '⣾ Working...',
      isProcessing: () => true,
      isReady: () => true,
      updateRuntimeMeta: vi.fn(),
    }

    const result = await handleReadChat({
      ...createHelpers(),
      getCliAdapter: () => adapter,
      currentSession: {
        sessionId: runtimeSessionId,
        providerSessionId,
        providerType: 'antigravity-cli',
        transport: 'pty',
        workspace: '/tmp/adhdev-project',
      },
      ctx: {
        instanceManager: { getInstance: () => null },
        sessionRegistry: {
          get: () => ({
            sessionId: runtimeSessionId,
            providerSessionId,
            providerType: 'antigravity-cli',
            transport: 'pty',
            spawnedAtMs: 1000,
          }),
        },
      },
    } as any, {
      agentType: 'antigravity-cli',
      targetSessionId: runtimeSessionId,
      historySessionId: providerSessionId,
      providerSessionId,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.status).toBe('idle')
    expect((result.messageSource as any)?.selected).toBe('native-history')
    expect((result.messageSource as any)?.statusReconciled).toMatchObject({
      from: 'generating',
      to: 'idle',
      reason: 'provider_native_final_assistant',
    })
  })

  it('rejects an exact Codex provider id when the rollout belongs to another workspace', async () => {
    const runtimeSessionId = 'runtime-worktree-with-stale-provider-id'
    const providerSessionId = '019ea367-b753-7d43-b27f-cf3a08edc0d9'
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        {
          role: 'assistant',
          content: 'main workspace answer',
          receivedAt: 1200,
          workspace: '/tmp/main-project',
        },
      ],
      hasMore: false,
      source: 'provider-native',
      providerSessionId,
      nativeHistoryCoverage: 'full',
      workspace: '/tmp/main-project',
    })

    const adapter = {
      cliType: 'codex-cli',
      cliName: 'Codex CLI',
      workingDir: '/tmp/worktree-project',
      getStatus: () => ({ status: 'idle', providerSessionId }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        providerSessionId,
        messages: [{ role: 'user', content: 'worktree prompt', receivedAt: 1300 }],
      }),
      getRuntimeMetadata: () => ({
        runtimeId: runtimeSessionId,
        runtimeKey: runtimeSessionId,
        providerSessionId,
        spawnedAtMs: 1000,
        spawnedEnv: {},
      }),
      getPartialResponse: () => '',
      isProcessing: () => false,
      isReady: () => true,
    }

    const result = await handleReadChat({
      ...createHelpers(),
      getCliAdapter: () => adapter,
      currentSession: {
        sessionId: runtimeSessionId,
        providerSessionId,
        providerType: 'codex-cli',
        transport: 'pty',
        workspace: '/tmp/worktree-project',
      },
      ctx: {
        instanceManager: { getInstance: () => null },
        sessionRegistry: {
          get: () => ({
            sessionId: runtimeSessionId,
            providerSessionId,
            providerType: 'codex-cli',
            transport: 'pty',
            spawnedAtMs: 1000,
          }),
        },
      },
    } as any, {
      agentType: 'codex-cli',
      targetSessionId: runtimeSessionId,
      historySessionId: providerSessionId,
      tailLimit: 20,
    })

    expect((result.messages as any[]).map(message => message.content)).not.toContain('main workspace answer')
    expect((result.messageSource as any)?.selected).toBe('pty-parser')
    expect((result.messageSource as any)?.coverage?.safeMapping).toBe(false)
  })

  it('rebinds an auto-detected Codex id when its rollout workspace is wrong', async () => {
    const runtimeSessionId = 'runtime-worktree-auto-rebind'
    const staleProviderSessionId = '019ea36e-5bbb-7202-800b-54e0c57ee987'
    const correctProviderSessionId = '019ea36e-5bfe-7952-aa6f-4407b7f8aec7'
    mocks.readProviderChatHistory.mockImplementation((_agentType: string, options: any) => {
      if (options.historySessionId) {
        return {
          messages: [{ role: 'assistant', content: 'main answer', receivedAt: 1200, workspace: '/tmp/main-project' }],
          hasMore: false,
          source: 'provider-native',
          providerSessionId: staleProviderSessionId,
          nativeHistoryCoverage: 'full',
          workspace: '/tmp/main-project',
        }
      }
      return {
        messages: [
          { role: 'user', content: 'worktree prompt', receivedAt: 1300, workspace: '/tmp/worktree-project' },
          { role: 'assistant', content: 'worktree answer', receivedAt: 1400, workspace: '/tmp/worktree-project' },
        ],
        hasMore: false,
        source: 'provider-native',
        providerSessionId: correctProviderSessionId,
        nativeHistoryCoverage: 'full',
        workspace: '/tmp/worktree-project',
      }
    })
    const updateRuntimeMeta = vi.fn()
    const adapter = {
      cliType: 'codex-cli',
      cliName: 'Codex CLI',
      workingDir: '/tmp/worktree-project',
      getStatus: () => ({ status: 'idle', providerSessionId: staleProviderSessionId }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        providerSessionId: staleProviderSessionId,
        messages: [{ role: 'user', content: 'worktree prompt', receivedAt: 1300 }],
      }),
      getRuntimeMetadata: () => ({
        runtimeId: runtimeSessionId,
        runtimeKey: runtimeSessionId,
        providerSessionId: staleProviderSessionId,
        spawnedAtMs: 1000,
        spawnedEnv: {},
      }),
      updateRuntimeMeta,
      getPartialResponse: () => '',
      isProcessing: () => false,
      isReady: () => true,
    }

    const result = await handleReadChat({
      ...createHelpers(),
      getCliAdapter: () => adapter,
      currentSession: {
        sessionId: runtimeSessionId,
        providerSessionId: staleProviderSessionId,
        providerType: 'codex-cli',
        transport: 'pty',
        workspace: '/tmp/worktree-project',
      },
      ctx: {
        instanceManager: { getInstance: () => null },
        sessionRegistry: {
          get: () => ({
            sessionId: runtimeSessionId,
            providerSessionId: staleProviderSessionId,
            providerType: 'codex-cli',
            transport: 'pty',
            spawnedAtMs: 1000,
          }),
        },
      },
    } as any, {
      agentType: 'codex-cli',
      targetSessionId: runtimeSessionId,
      tailLimit: 20,
    })

    expect(result.providerSessionId).toBe(correctProviderSessionId)
    expect((result.messages as any[]).map(message => message.content)).toEqual([
      'worktree prompt',
      'worktree answer',
    ])
    expect(updateRuntimeMeta).toHaveBeenCalledWith({ providerSessionId: correctProviderSessionId })
    expect(mocks.readProviderChatHistory).toHaveBeenLastCalledWith('codex-cli', expect.objectContaining({
      historySessionId: undefined,
      workspace: '/tmp/worktree-project',
      sessionStartedAtMs: 1000,
    }))
  })
})
