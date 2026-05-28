import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { handleGetChatDebugBundle, handleReadChat } from '../../src/commands/chat-commands.js'

function createAntigravityAdapter(overrides: Record<string, unknown> = {}) {
  return {
    cliType: 'antigravity-cli',
    cliName: 'Antigravity CLI',
    workingDir: '/workspaces/adhdev',
    getStatus: vi.fn(() => ({
      status: 'idle',
      activeModal: null,
      messages: [{ role: 'assistant', content: 'pty assistant', receivedAt: 2_000 }],
    })),
    getScriptParsedStatus: vi.fn(() => ({
      status: 'idle',
      providerSessionId: 'agy-native-conversation',
      title: 'Antigravity CLI',
      messages: [
        { role: 'user', content: 'pty user', receivedAt: 1_000 },
        { role: 'assistant', content: 'pty assistant', receivedAt: 2_000 },
      ],
    })),
    getDebugSnapshot: vi.fn(() => ({ terminalScreenText: 'antigravity terminal status' })),
    getPartialResponse: vi.fn(() => ''),
    isProcessing: () => false,
    isReady: () => true,
    ...overrides,
  }
}

function createHelpers(adapter: any = createAntigravityAdapter(), overrides: Record<string, any> = {}) {
  const provider = {
    type: 'antigravity-cli',
    name: 'Antigravity CLI',
    category: 'cli',
    canonicalHistory: {
      format: 'antigravity-opaque-protobuf',
      mode: 'native-source',
      watchPath: '~/.gemini/antigravity/conversations/*.pb',
      scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
    },
    scripts: { readNativeHistory: () => null },
  }
  return {
    getCdp: () => null,
    getProvider: () => provider,
    getProviderScript: () => null,
    evaluateProviderScript: vi.fn(),
    getCliAdapter: () => adapter,
    currentManagerKey: undefined,
    currentIdeType: undefined,
    currentProviderType: 'antigravity-cli',
    currentSession: {
      sessionId: 'runtime-session',
      providerType: 'antigravity-cli',
      providerName: 'Antigravity CLI',
      providerSessionId: 'agy-native-conversation',
      transport: 'pty',
      adapterKey: 'runtime-session',
      workspace: '/workspaces/adhdev',
    },
    agentStream: null,
    ctx: {
      sessionRegistry: { get: () => ({ sessionId: 'runtime-session', instanceKey: 'runtime-session' }) },
      instanceManager: { getInstance: () => null },
    },
    historyWriter: { appendNewMessages: () => {} },
    ...overrides,
  }
}

describe('Antigravity CLI read_chat native transcript provenance', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
  })

  it('checks Antigravity native history but keeps PTY visible source when native protobuf is unavailable', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'native-unavailable',
      hasMore: false,
      messages: [],
    })

    const result = await handleReadChat(createHelpers() as any, {
      agentType: 'antigravity-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'agy-native-conversation',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map(message => message.content)).toEqual(['pty user', 'pty assistant'])
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('antigravity-cli', expect.objectContaining({
      canonicalHistory: expect.objectContaining({ format: 'antigravity-opaque-protobuf' }),
      historySessionId: 'agy-native-conversation',
      workspace: '/workspaces/adhdev',
    }))
    expect(result.messageSource).toMatchObject({
      selected: 'pty-parser',
      provider: 'antigravity-cli',
      providerType: 'antigravity-cli',
      fallbackReason: 'native_history_unavailable',
      ptyStatusApprovalOnly: false,
      coverage: {
        nativeMessageCount: 0,
        ptyMessageCount: 2,
        returnedMessageCount: 2,
        safeMapping: true,
      },
    })
    expect(result.debugReadChat).toMatchObject({
      selectedMessageSource: 'pty-parser',
      shouldPreferAdapterMessages: true,
    })
  })

  it('includes Antigravity fallback provenance in chat debug bundles', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'native-unavailable',
      hasMore: false,
      messages: [],
    })

    const result = await handleGetChatDebugBundle(createHelpers() as any, {
      agentType: 'antigravity-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'agy-native-conversation',
    })

    expect(result.success).toBe(true)
    expect((result.bundle as any).readChat.messageSource).toMatchObject({
      selected: 'pty-parser',
      provider: 'antigravity-cli',
      fallbackReason: 'native_history_unavailable',
      ptyStatusApprovalOnly: false,
    })
    expect((result.bundle as any).readChat.debugReadChat.messageSource).toMatchObject({
      selected: 'pty-parser',
      fallbackReason: 'native_history_unavailable',
    })
  })
})
