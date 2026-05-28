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

function createClaudeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    cliType: 'claude-cli',
    cliName: 'Claude Code',
    workingDir: '/workspaces/adhdev',
    getStatus: vi.fn(() => ({
      status: 'idle',
      activeModal: null,
      messages: [{ role: 'assistant', content: 'pty assistant', receivedAt: 2_000 }],
    })),
    getScriptParsedStatus: vi.fn(() => ({
      status: 'idle',
      providerSessionId: 'claude-native-session',
      title: 'Claude Code',
      messages: [
        { role: 'user', content: 'pty user', receivedAt: 1_000 },
        { role: 'assistant', content: 'pty assistant', receivedAt: 2_000 },
      ],
    })),
    getDebugSnapshot: vi.fn(() => ({ terminalScreenText: 'claude terminal status' })),
    getPartialResponse: vi.fn(() => ''),
    isProcessing: () => false,
    isReady: () => true,
    ...overrides,
  }
}

function createHelpers(adapter: any = createClaudeAdapter(), overrides: Record<string, any> = {}) {
  const provider = {
    type: 'claude-cli',
    name: 'Claude Code',
    category: 'cli',
    canonicalHistory: {
      format: 'claude-provider-native',
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
    currentProviderType: 'claude-cli',
    currentSession: {
      sessionId: 'runtime-session',
      providerType: 'claude-cli',
      providerName: 'Claude Code',
      providerSessionId: 'claude-native-session',
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

describe('Claude CLI read_chat native transcript provenance', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
  })

  it('selects fresh safely mapped native Claude history while keeping PTY for status and approval', async () => {
    const adapter = createClaudeAdapter({
      getScriptParsedStatus: vi.fn(() => ({
        status: 'waiting_approval',
        providerSessionId: 'claude-native-session',
        activeModal: { message: 'Approve command?', buttons: ['Yes', 'No'] },
        messages: [{ role: 'assistant', content: 'pty approval screen', receivedAt: 2_000 }],
      })),
    })
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.claude/projects/-workspaces-adhdev/claude-native-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      messages: [
        { role: 'system', kind: 'session_start', content: '/workspaces/adhdev', receivedAt: 2_500, historySessionId: 'claude-native-session', workspace: '/workspaces/adhdev' },
        { role: 'user', content: 'native user', receivedAt: 3_000, historySessionId: 'claude-native-session' },
        { role: 'assistant', content: 'native assistant', receivedAt: 4_000, historySessionId: 'claude-native-session' },
      ],
    })

    const result = await handleReadChat(createHelpers(adapter) as any, {
      agentType: 'claude-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'claude-native-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.status).toBe('waiting_approval')
    expect(result.activeModal).toMatchObject({ buttons: ['Yes', 'No'] })
    expect((result.messages as any[]).map(message => message.content)).toEqual(['native user', 'native assistant'])
    expect(result.messageSource).toMatchObject({
      selected: 'native-history',
      provider: 'claude-cli',
      providerType: 'claude-cli',
      nativeHandle: 'claude-native-session',
      nativeSessionId: 'claude-native-session',
      ptyStatusApprovalOnly: true,
      coverage: {
        nativeMessageCount: 3,
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
      sourcePath: '/Users/test/.claude/projects/-workspaces-adhdev/claude-native-session.jsonl',
      sourceMtimeMs: 1,
      hasMore: false,
      messages: [
        { role: 'user', content: 'stale native user', receivedAt: 500, historySessionId: 'claude-native-session' },
      ],
    })

    const result = await handleReadChat(createHelpers() as any, {
      agentType: 'claude-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'claude-native-session',
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
  })

  it('falls back to PTY parser messages with an explicit ambiguous mapping reason', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.claude/projects/-other-workspace/other-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      messages: [
        { role: 'user', content: 'wrong native user', receivedAt: 3_000, historySessionId: 'other-session' },
        { role: 'assistant', content: 'wrong native assistant', receivedAt: 4_000, historySessionId: 'other-session' },
      ],
    })

    const result = await handleReadChat(createHelpers() as any, {
      agentType: 'claude-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'claude-native-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map(message => message.content)).toEqual(['pty user', 'pty assistant'])
    expect(result.messageSource).toMatchObject({
      selected: 'pty-parser',
      fallbackReason: 'native_history_not_safely_mapped',
      coverage: { safeMapping: false },
    })
  })

  it('includes selected Claude transcript provenance in chat debug bundles', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.claude/projects/-workspaces-adhdev/claude-native-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      messages: [
        { role: 'user', content: 'native debug user', receivedAt: 3_000, historySessionId: 'claude-native-session' },
        { role: 'assistant', content: 'native debug assistant', receivedAt: 4_000, historySessionId: 'claude-native-session' },
      ],
    })

    const result = await handleGetChatDebugBundle(createHelpers() as any, {
      agentType: 'claude-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'claude-native-session',
    })

    expect(result.success).toBe(true)
    expect((result.bundle as any).readChat.messageSource).toMatchObject({
      selected: 'native-history',
      provider: 'claude-cli',
      nativeHandle: 'claude-native-session',
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

  it('exposes native Claude provenance when the live PTY adapter is missing', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.claude/projects/-workspaces-adhdev/claude-native-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      messages: [
        { role: 'user', content: 'native stopped user', receivedAt: 3_000, historySessionId: 'claude-native-session' },
        { role: 'assistant', content: 'native stopped assistant', receivedAt: 4_000, historySessionId: 'claude-native-session' },
      ],
    })

    const result = await handleReadChat(createHelpers(null) as any, {
      agentType: 'claude-cli',
      targetSessionId: 'runtime-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map(message => message.content)).toEqual(['native stopped user', 'native stopped assistant'])
    expect(result.providerSessionId).toBe('claude-native-session')
    expect(result.messageSource).toMatchObject({
      selected: 'native-history',
      provider: 'claude-cli',
      nativeHandle: 'claude-native-session',
      ptyStatusApprovalOnly: false,
      coverage: {
        nativeMessageCount: 2,
        returnedMessageCount: 2,
        safeMapping: true,
      },
    })
  })
})
