import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  readProviderChatHistory: vi.fn(),
}))

vi.mock('../../src/config/chat-history.js', () => ({
  readProviderChatHistory: mocks.readProviderChatHistory,
  isNativeSourceCanonicalHistory: (canonicalHistory: any) => {
    if (!canonicalHistory) return false
    return canonicalHistory.mode !== 'disabled' && canonicalHistory.mode !== 'materialized-mirror'
  },
}))

import { handleReadChat, handleChatHistory } from '../../src/commands/chat-commands.js'

function createHelpers(overrides: Record<string, any> = {}) {
  const provider = overrides.provider || { type: 'hermes-cli', category: 'cli', historyBehavior: { transcriptAuthority: 'provider' } }
  return {
    getCdp: () => null,
    getProvider: () => provider,
    getProviderScript: () => null,
    evaluateProviderScript: async () => null,
    getCliAdapter: () => overrides.adapter || null,
    currentManagerKey: undefined,
    currentIdeType: undefined,
    currentProviderType: provider.type,
    currentSession: overrides.currentSession,
    agentStream: null,
    ctx: { instanceManager: { getInstance: () => null }, ...(overrides.ctx || {}) },
    historyWriter: { appendNewMessages: () => {} },
  }
}

describe('CLI read_chat native history hydration', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
  })

  it('uses providerSessionId for inactive Hermes conversations when no live adapter exists', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        { role: 'user', content: 'saved 질문', receivedAt: 1 },
        { role: 'assistant', content: 'saved 답변', receivedAt: 2 },
      ],
      hasMore: true,
    })

    const result = await handleReadChat(createHelpers() as any, {
      agentType: 'hermes-cli',
      targetSessionId: 'runtime-session-that-is-not-live',
      providerSessionId: 'hermes-provider-session-42',
      tailLimit: 50,
    })

    expect(result.success).toBe(true)
    const messages = result.messages as any[]
    expect(messages).toHaveLength(2)
    expect(messages.map((message: any) => message.content)).toEqual(['saved 질문', 'saved 답변'])
    expect(result.totalMessages).toBe(2)
    expect(result.providerSessionId).toBe('hermes-provider-session-42')
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('hermes-cli', expect.objectContaining({
      historySessionId: 'hermes-provider-session-42',
      offset: 0,
      limit: 50,
    }))
  })

  it('selects Hermes provider-native history over parsed PTY messages when canonical history omits mode', async () => {
    const adapter = {
      cliType: 'hermes-cli',
      cliName: 'Hermes Agent',
      workingDir: '/workspaces/adhdev',
      getStatus: vi.fn(() => ({ status: 'idle', messages: [{ role: 'assistant', content: 'pty assistant' }] })),
      getScriptParsedStatus: vi.fn(() => ({
        status: 'idle',
        providerSessionId: 'session_hermes_native_42',
        title: 'Hermes Agent',
        transcriptAuthority: 'provider',
        coverage: 'full',
        messages: [
          { role: 'user', content: 'pty user', receivedAt: 1_000 },
          { role: 'assistant', content: 'pty assistant', receivedAt: 2_000 },
        ],
      })),
      isProcessing: vi.fn(() => false),
      isReady: vi.fn(() => true),
    }
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.hermes/sessions/session_hermes_native_42.json',
      sourceMtimeMs: Date.now(),
      providerSessionId: 'session_hermes_native_42',
      messages: [
        { role: 'user', content: 'native hermes user', receivedAt: 3_000, historySessionId: 'session_hermes_native_42' },
        { role: 'assistant', content: 'native hermes assistant', receivedAt: 4_000, historySessionId: 'session_hermes_native_42' },
      ],
      hasMore: false,
    })

    const result = await handleReadChat(createHelpers({
      adapter,
      provider: {
        type: 'hermes-cli',
        category: 'cli',
        historyBehavior: { transcriptAuthority: 'provider' },
        canonicalHistory: {
          format: 'hermes-provider-native',
          scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
        },
        scripts: { readNativeHistory: () => null },
      },
      currentSession: {
        sessionId: 'runtime-session',
        providerType: 'hermes-cli',
        providerName: 'Hermes Agent',
        providerSessionId: 'session_hermes_native_42',
        transport: 'pty',
        adapterKey: 'runtime-session',
        workspace: '/workspaces/adhdev',
      },
      ctx: {
        sessionRegistry: { get: () => ({ sessionId: 'runtime-session', instanceKey: 'runtime-session' }) },
        instanceManager: { getInstance: () => null },
      },
    }) as any, {
      agentType: 'hermes-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'session_hermes_native_42',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map((message: any) => message.content)).toEqual([
      'native hermes user',
      'native hermes assistant',
    ])
    expect(result.messageSource).toMatchObject({
      selected: 'native-history',
      provider: 'hermes-cli',
      nativeHandle: 'session_hermes_native_42',
      ptyStatusApprovalOnly: true,
      coverage: {
        nativeMessageCount: 2,
        ptyMessageCount: 2,
        returnedMessageCount: 2,
        safeMapping: true,
      },
    })
    expect(result.debugReadChat).toMatchObject({
      selectedMessageSource: 'native-history',
      shouldPreferAdapterMessages: false,
    })
  })

  it('keeps a generating Codex direct task readable when only the dispatched user turn is visible', async () => {
    const prompt = 'Diagnose why mesh_read_chat returned zero messages for this Codex task.'
    const adapter = {
      cliType: 'codex-cli',
      cliName: 'Codex CLI',
      workingDir: '/tmp/adhdev-codex-live',
      getScriptParsedStatus: vi.fn(() => ({
        status: 'idle',
        title: 'Codex CLI',
        messages: [{ role: 'user', kind: 'standard', content: prompt }],
      })),
      getStatus: vi.fn(() => ({ status: 'generating', messages: [] })),
      isProcessing: vi.fn(() => true),
    }

    const result = await handleReadChat(createHelpers({
      provider: { type: 'codex-cli', category: 'cli' },
      adapter,
      currentSession: {
        sessionId: 'codex-live-session',
        providerType: 'codex-cli',
        transport: 'pty',
        workspace: '/tmp/adhdev-codex-live',
      },
    }) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'codex-live-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.status).toBe('generating')
    expect(result.totalMessages).toBe(1)
    expect((result.messages as any[]).map((message: any) => [message.role, message.content])).toEqual([
      ['user', prompt],
    ])
  })

  it('uses providerSessionId for chat_history pagination too', async () => {
    mocks.readProviderChatHistory.mockReturnValue({ messages: [], hasMore: false })

    const result = await handleChatHistory(createHelpers() as any, {
      agentType: 'hermes-cli',
      targetSessionId: 'runtime-session-that-is-not-live',
      providerSessionId: 'hermes-provider-session-42',
      offset: 25,
      limit: 25,
    })

    expect(result.success).toBe(true)
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('hermes-cli', expect.objectContaining({
      historySessionId: 'hermes-provider-session-42',
      offset: 25,
      limit: 25,
    }))
  })
})
