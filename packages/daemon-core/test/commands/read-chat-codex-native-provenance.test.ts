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

function createCodexAdapter(overrides: Record<string, unknown> = {}) {
  return {
    cliType: 'codex-cli',
    cliName: 'Codex CLI',
    workingDir: '/workspaces/adhdev',
    getStatus: vi.fn(() => ({
      status: 'idle',
      activeModal: null,
      messages: [{ role: 'assistant', content: 'pty assistant', receivedAt: 2_000 }],
    })),
    getScriptParsedStatus: vi.fn(() => ({
      status: 'idle',
      providerSessionId: 'native-session',
      title: 'Codex CLI',
      messages: [
        { role: 'user', content: 'pty user', receivedAt: 1_000 },
        { role: 'assistant', content: 'pty assistant', receivedAt: 2_000 },
      ],
    })),
    getDebugSnapshot: vi.fn(() => ({ terminalScreenText: 'codex terminal status' })),
    getPartialResponse: vi.fn(() => ''),
    isProcessing: () => false,
    isReady: () => true,
    ...overrides,
  }
}

function createHelpers(adapter = createCodexAdapter()) {
  const provider = {
    type: 'codex-cli',
    name: 'Codex CLI',
    category: 'cli',
    canonicalHistory: {
      format: 'codex-provider-native',
      mode: 'native-source',
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
    currentProviderType: 'codex-cli',
    currentSession: {
      sessionId: 'runtime-session',
      providerType: 'codex-cli',
      providerName: 'Codex CLI',
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
  }
}

describe('Codex CLI read_chat native transcript provenance', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
  })

  it('selects fresh safely mapped native Codex history while keeping PTY for status and approval', async () => {
    const adapter = createCodexAdapter({
      getScriptParsedStatus: vi.fn(() => ({
        status: 'waiting_approval',
        providerSessionId: 'native-session',
        activeModal: { message: 'Approve command?', buttons: ['Yes', 'No'] },
        messages: [{ role: 'assistant', content: 'pty approval screen', receivedAt: 2_000 }],
      })),
    })
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/native-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      messages: [
        { role: 'user', content: 'native user', receivedAt: 3_000, historySessionId: 'native-session' },
        { role: 'assistant', content: 'native assistant', receivedAt: 4_000, historySessionId: 'native-session' },
      ],
    })

    const result = await handleReadChat(createHelpers(adapter) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'native-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.status).toBe('waiting_approval')
    expect(result.activeModal).toMatchObject({ buttons: ['Yes', 'No'] })
    expect((result.messages as any[]).map(message => message.content)).toEqual(['native user', 'native assistant'])
    expect(result.messageSource).toMatchObject({
      selected: 'native-history',
      provider: 'codex-cli',
      nativeHandle: 'native-session',
      ptyStatusApprovalOnly: true,
      coverage: {
        nativeMessageCount: 2,
        ptyMessageCount: 1,
        returnedMessageCount: 2,
        safeMapping: true,
      },
    })
    expect(result.debugReadChat).toMatchObject({
      selectedMessageSource: 'native-history',
      shouldPreferAdapterMessages: false,
    })
  })

  it('falls back to PTY parser messages with an explicit stale native-history reason', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/native-session.jsonl',
      sourceMtimeMs: 1,
      hasMore: false,
      messages: [
        { role: 'user', content: 'stale native user', receivedAt: 500, historySessionId: 'native-session' },
      ],
    })

    const result = await handleReadChat(createHelpers() as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'native-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map(message => message.content)).toEqual(['pty user', 'pty assistant'])
    expect(result.messageSource).toMatchObject({
      selected: 'pty-parser',
      fallbackReason: 'native_history_stale',
      ptyStatusApprovalOnly: false,
      staleness: { freshEnough: false },
    })
    expect(result.debugReadChat).toMatchObject({
      selectedMessageSource: 'pty-parser',
      shouldPreferAdapterMessages: true,
    })
  })

  it('fails closed for inactive Codex sessions when provider-native history is not safely mapped', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/other-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      messages: [
        { role: 'assistant', content: 'wrong native assistant', receivedAt: 4_000, historySessionId: 'other-session' },
      ],
    })

    const result = await handleReadChat(createHelpers(null) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'native-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('native_history_not_safely_available')
    expect(result.messageSource).toMatchObject({
      selected: 'pty-parser',
      fallbackReason: 'native_history_not_safely_mapped',
    })
    expect((result as any).messages).toBeUndefined()
  })

  it('includes selected transcript provenance in chat debug bundles', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/native-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      messages: [
        { role: 'user', content: 'native debug user', receivedAt: 3_000, historySessionId: 'native-session' },
        { role: 'assistant', content: 'native debug assistant', receivedAt: 4_000, historySessionId: 'native-session' },
      ],
    })

    const result = await handleGetChatDebugBundle(createHelpers() as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'native-session',
    })

    expect(result.success).toBe(true)
    expect((result.bundle as any).readChat.messageSource).toMatchObject({
      selected: 'native-history',
      provider: 'codex-cli',
      nativeHandle: 'native-session',
      ptyStatusApprovalOnly: true,
    })
    expect((result.bundle as any).readChat.debugReadChat.messageSource).toMatchObject({
      selected: 'native-history',
      coverage: {
        nativeMessageCount: 2,
        ptyMessageCount: 2,
        returnedMessageCount: 2,
        safeMapping: true,
      },
    })
  })
})
