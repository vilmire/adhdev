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

import { __resetProviderSessionPinsForTest, handleChatHistory } from '../../src/commands/chat-commands.js'

const WORKSPACE = '/tmp/adhdev-project'

function ptyMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `pty row ${index + 1}`,
    receivedAt: 2000 + index,
  }))
}

function createAdapter(overrides: Record<string, any> = {}) {
  const runtimeId = overrides.runtimeId ?? 'session-1'
  const workingDir = overrides.workingDir ?? WORKSPACE
  const messages = overrides.messages ?? ptyMessages(6)
  const surfaceKind = overrides.surfaceKind
  return {
    cliType: 'codex-cli',
    cliName: 'Codex CLI',
    workingDir,
    getStatus: () => ({ status: 'idle' }),
    getScriptParsedStatus: () => ({ status: 'idle', messages }),
    getRuntimeMetadata: () => ({
      runtimeId,
      runtimeKey: runtimeId,
      ...(surfaceKind ? { surfaceKind } : {}),
      spawnedAtMs: 1000,
      spawnedEnv: {},
    }),
    getPartialResponse: () => '',
    isProcessing: () => false,
    isReady: () => true,
  }
}

function createHelpers(adapter: any) {
  return {
    getCdp: () => null,
    getProvider: (type?: string) => type === 'codex-cli'
      ? { type: 'codex-cli', category: 'cli', nativeHistory: { mode: 'canonical' }, historyBehavior: {} }
      : undefined,
    getProviderScript: () => null,
    evaluateProviderScript: async () => null,
    getCliAdapter: () => adapter,
    currentManagerKey: undefined,
    currentIdeType: undefined,
    currentProviderType: undefined,
    currentSession: {
      sessionId: 'session-1',
      providerType: 'codex-cli',
      transport: 'pty',
      workspace: WORKSPACE,
    },
    agentStream: null,
    ctx: {
      instanceManager: { getInstance: () => null },
      sessionRegistry: {
        get: (sessionId: string) => sessionId === 'session-1'
          ? { sessionId: 'session-1', providerType: 'codex-cli', transport: 'pty', workspace: WORKSPACE, spawnedAtMs: 1000 }
          : undefined,
      },
    },
    historyWriter: { appendNewMessages: () => {} },
  }
}

describe('handleChatHistory safe PTY fallback (Load older zero-bubble fix)', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
    __resetProviderSessionPinsForTest()
  })

  it('recovers a safely attributed PTY page when the exact native history read is empty', async () => {
    // Transient native gap on an exact, session-scoped read — the same trigger
    // that blanks the live tail. "Load older" must serve the session's own PTY
    // rows instead of returning [].
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [],
      hasMore: false,
      source: 'provider-native',
      providerSessionId: 'provider-history-1',
    })

    const adapter = createAdapter({ messages: ptyMessages(10) })
    const result = await handleChatHistory(createHelpers(adapter) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'session-1',
      historySessionId: 'provider-history-1',
      workspace: WORKSPACE,
      offset: 0,
      limit: 4,
      excludeRecentCount: 2,
    })

    expect(result.success).toBe(true)
    expect((result as any).source).toBe('pty-parser')
    // Paging contract matches the native path: exclude the 2 rows the live
    // tail already shows, then the newest 4 of the remainder, hasMore while
    // older rows remain.
    expect((result.messages as any[]).map(message => message.content)).toEqual([
      'pty row 5',
      'pty row 6',
      'pty row 7',
      'pty row 8',
    ])
    expect(result.hasMore).toBe(true)
  })

  it('recovers a safely attributed PTY page when the exact native history read is unsafely mapped', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        { role: 'assistant', content: 'foreign workspace answer', receivedAt: 1200, workspace: '/tmp/main-project' },
      ],
      hasMore: false,
      source: 'provider-native',
      providerSessionId: 'provider-history-1',
      nativeHistoryCoverage: 'full',
      workspace: '/tmp/main-project',
    })

    const adapter = createAdapter({ messages: ptyMessages(6) })
    const result = await handleChatHistory(createHelpers(adapter) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'session-1',
      historySessionId: 'provider-history-1',
      workspace: WORKSPACE,
      offset: 0,
      limit: 30,
      excludeRecentCount: 0,
    })

    expect(result.success).toBe(true)
    expect((result as any).source).toBe('pty-parser')
    const contents = (result.messages as any[]).map(message => message.content)
    expect(contents).toHaveLength(6)
    expect(contents).not.toContain('foreign workspace answer')
    expect(result.hasMore).toBe(false)
  })

  it('stays empty when the PTY transcript belongs to a different workspace', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [],
      hasMore: false,
      source: 'provider-native',
      providerSessionId: 'provider-history-1',
    })

    const adapter = createAdapter({ workingDir: '/tmp/other-workspace' })
    const result = await handleChatHistory(createHelpers(adapter) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'session-1',
      historySessionId: 'provider-history-1',
      workspace: WORKSPACE,
      offset: 0,
      limit: 30,
      excludeRecentCount: 0,
    })

    expect(result.success).toBe(true)
    expect((result as any).source).not.toBe('pty-parser')
    expect(result.messages).toEqual([])
  })

  it('stays empty when the PTY transcript belongs to a different session (cross-session)', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [],
      hasMore: false,
      source: 'provider-native',
      providerSessionId: 'provider-history-1',
    })

    const adapter = createAdapter({ runtimeId: 'other-session' })
    const result = await handleChatHistory(createHelpers(adapter) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'session-1',
      historySessionId: 'provider-history-1',
      workspace: WORKSPACE,
      offset: 0,
      limit: 30,
      excludeRecentCount: 0,
    })

    expect(result.success).toBe(true)
    expect((result as any).source).not.toBe('pty-parser')
    expect(result.messages).toEqual([])
  })

  it('keeps the native-unavailable empty response when native is unsafe AND the PTY side cannot be proven safe', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        { role: 'assistant', content: 'foreign workspace answer', receivedAt: 1200, workspace: '/tmp/main-project' },
      ],
      hasMore: false,
      source: 'provider-native',
      providerSessionId: 'provider-history-1',
      nativeHistoryCoverage: 'full',
      workspace: '/tmp/main-project',
    })

    const adapter = createAdapter({ workingDir: '/tmp/other-workspace' })
    const result = await handleChatHistory(createHelpers(adapter) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'session-1',
      historySessionId: 'provider-history-1',
      workspace: WORKSPACE,
      offset: 0,
      limit: 30,
      excludeRecentCount: 0,
    })

    expect(result).toMatchObject({
      success: true,
      messages: [],
      hasMore: false,
      source: 'native-unavailable',
    })
  })

  it('returns an empty page with hasMore=false when every PTY row is already visible in the live tail', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [],
      hasMore: false,
      source: 'provider-native',
      providerSessionId: 'provider-history-1',
    })

    const adapter = createAdapter({ messages: ptyMessages(6) })
    const result = await handleChatHistory(createHelpers(adapter) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'session-1',
      historySessionId: 'provider-history-1',
      workspace: WORKSPACE,
      offset: 0,
      limit: 30,
      excludeRecentCount: 6,
    })

    expect(result.success).toBe(true)
    expect((result as any).source).toBe('pty-parser')
    expect(result.messages).toEqual([])
    expect(result.hasMore).toBe(false)
  })
})
