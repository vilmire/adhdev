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

const WORKSPACE = '/tmp/adhdev-project'

function createHelpers() {
  return {
    getCdp: () => null,
    getProvider: (type?: string) => {
      if (type === 'codex-cli') {
        return { type: 'codex-cli', category: 'cli', nativeHistory: { mode: 'canonical' }, historyBehavior: {} }
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

function ptyMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `pty row ${index + 1}`,
    receivedAt: 2000 + index,
  }))
}

function nativeMessages(contents: Array<{ role: string; content: string; receivedAt: number; historySessionId?: string }>) {
  return contents
}

function createAdapter(runtimeSessionId: string, providerSessionId: string | undefined, messages: any[]) {
  return {
    cliType: 'codex-cli',
    cliName: 'Codex CLI',
    workingDir: WORKSPACE,
    getStatus: () => ({ status: 'idle' }),
    getScriptParsedStatus: () => ({
      status: 'idle',
      ...(providerSessionId ? { providerSessionId } : {}),
      messages,
    }),
    getRuntimeMetadata: () => ({
      runtimeId: runtimeSessionId,
      runtimeKey: runtimeSessionId,
      ...(providerSessionId ? { providerSessionId } : {}),
      spawnedAtMs: 1000,
      spawnedEnv: {},
    }),
    getPartialResponse: () => '',
    isProcessing: () => false,
    isReady: () => true,
  }
}

function createSessionHelpers(runtimeSessionId: string, adapter: any, providerSessionId?: string) {
  return {
    ...createHelpers(),
    getCliAdapter: () => adapter,
    currentSession: {
      sessionId: runtimeSessionId,
      ...(providerSessionId ? { providerSessionId } : {}),
      providerType: 'codex-cli',
      transport: 'pty',
      workspace: WORKSPACE,
    },
    ctx: {
      instanceManager: { getInstance: () => null },
      sessionRegistry: {
        get: (sessionId: string) => sessionId === runtimeSessionId
          ? {
            sessionId: runtimeSessionId,
            ...(providerSessionId ? { providerSessionId } : {}),
            providerType: 'codex-cli',
            transport: 'pty',
            workspace: WORKSPACE,
            spawnedAtMs: 1000,
          }
          : undefined,
      },
    },
  }
}

describe('read_chat STICKY-NATIVE empty-hold guard (coordinator zero-bubble fix)', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
    __resetProviderSessionPinsForTest()
  })

  it('falls through to PTY when a NativeLocked exact-identity session observes an empty native read (6 PTY rows render, not suppressed)', async () => {
    const runtimeSessionId = 'runtime-sticky-empty-gap'
    const providerSessionId = '019ea400-0000-7000-8000-000000000001'
    let readCount = 0
    mocks.readProviderChatHistory.mockImplementation(() => {
      readCount += 1
      if (readCount === 1) {
        return {
          messages: nativeMessages([
            { role: 'user', content: 'native prompt 1', receivedAt: 1000 },
            { role: 'assistant', content: 'native answer 1', receivedAt: 1100 },
            { role: 'user', content: 'native prompt 2', receivedAt: 1200 },
            { role: 'assistant', content: 'native answer 2', receivedAt: 1300 },
          ]),
          hasMore: false,
          source: 'provider-native',
          providerSessionId,
          nativeHistoryCoverage: 'full',
        }
      }
      // Transient native gap: exact session read comes back empty (mid-write
      // rewrite / post-restart transient), still pinned to the exact uuid.
      return {
        messages: [],
        hasMore: false,
        source: 'provider-native',
        providerSessionId,
      }
    })

    const adapter = createAdapter(runtimeSessionId, providerSessionId, ptyMessages(6))
    const helpers = createSessionHelpers(runtimeSessionId, adapter, providerSessionId)
    const args = {
      agentType: 'codex-cli',
      targetSessionId: runtimeSessionId,
      historySessionId: providerSessionId,
      providerSessionId,
      tailLimit: 20,
    }

    const first = await handleReadChat(helpers as any, args)
    expect((first.messageSource as any)?.selected).toBe('native-history')

    const second = await handleReadChat(helpers as any, args)
    expect(second.success).toBe(true)
    // The empty native observation must NOT be held as an authoritative empty
    // native tail: PTY is the source for this read and its rows render.
    expect((second.messageSource as any)?.selected).toBe('pty-parser')
    expect((second.messageSource as any)?.ptyStatusApprovalOnly).toBe(false)
    expect((second.messageSource as any)?.coverage?.ptyMessagesSuppressed).toBe(false)
    expect((second.messages as any[]).map(message => message.content)).toEqual([
      'pty row 1',
      'pty row 2',
      'pty row 3',
      'pty row 4',
      'pty row 5',
      'pty row 6',
    ])
    expect(second.totalMessages).toBe(6)
  })

  it('declines the hold when the native slice is unsafely mapped (foreign session rows never surface)', async () => {
    const runtimeSessionId = 'runtime-sticky-unsafe-gap'
    const providerSessionId = '019ea400-0000-7000-8000-000000000002'
    let readCount = 0
    mocks.readProviderChatHistory.mockImplementation(() => {
      readCount += 1
      if (readCount === 1) {
        return {
          messages: nativeMessages([
            { role: 'user', content: 'own prompt', receivedAt: 1000 },
            { role: 'assistant', content: 'own answer', receivedAt: 1100 },
          ]),
          hasMore: false,
          source: 'provider-native',
          providerSessionId,
          nativeHistoryCoverage: 'full',
        }
      }
      // Exact pin still resolves, but the mapped rows carry a FOREIGN session
      // identity — unsafe mapping. The hold must not pin these rows as an
      // authoritative native tail.
      return {
        messages: nativeMessages([
          { role: 'user', content: 'foreign prompt', receivedAt: 1200, historySessionId: 'foreign-session' },
          { role: 'assistant', content: 'foreign answer', receivedAt: 1300, historySessionId: 'foreign-session' },
        ]),
        hasMore: false,
        source: 'provider-native',
        providerSessionId,
        nativeHistoryCoverage: 'full',
      }
    })

    const adapter = createAdapter(runtimeSessionId, providerSessionId, ptyMessages(6))
    const helpers = createSessionHelpers(runtimeSessionId, adapter, providerSessionId)
    const args = {
      agentType: 'codex-cli',
      targetSessionId: runtimeSessionId,
      historySessionId: providerSessionId,
      providerSessionId,
      tailLimit: 20,
    }

    const first = await handleReadChat(helpers as any, args)
    expect((first.messageSource as any)?.selected).toBe('native-history')

    const second = await handleReadChat(helpers as any, args)
    expect((second.messageSource as any)?.selected).toBe('pty-parser')
    const contents = (second.messages as any[]).map(message => message.content)
    expect(contents).toHaveLength(6)
    expect(contents.some(content => String(content).startsWith('foreign'))).toBe(false)
    expect(contents).toContain('pty row 1')
  })

  it('still holds native-history for a shrunk but non-empty safely mapped native slice', async () => {
    const runtimeSessionId = 'runtime-sticky-shrunk-hold'
    const providerSessionId = '019ea400-0000-7000-8000-000000000003'
    let readCount = 0
    mocks.readProviderChatHistory.mockImplementation(() => {
      readCount += 1
      const messages = [
        { role: 'system', content: 'session context', receivedAt: 1000 },
        { role: 'user', content: 'restored prompt', receivedAt: 1100 },
        { role: 'assistant', content: 'restored answer', receivedAt: 1200 },
      ]
      return {
        // Mid-write rewrite drops the leading system row: a shrunk, non-empty
        // slice of the SAME session — the hold this fix must preserve.
        messages: readCount === 1 ? messages : messages.slice(1),
        hasMore: false,
        source: 'provider-native',
        providerSessionId,
        nativeHistoryCoverage: 'full',
      }
    })

    const adapter = createAdapter(runtimeSessionId, providerSessionId, ptyMessages(6))
    const helpers = createSessionHelpers(runtimeSessionId, adapter, providerSessionId)
    const args = {
      agentType: 'codex-cli',
      targetSessionId: runtimeSessionId,
      historySessionId: providerSessionId,
      providerSessionId,
      tailLimit: 20,
    }

    const first = await handleReadChat(helpers as any, args)
    expect((first.messageSource as any)?.selected).toBe('native-history')

    const second = await handleReadChat(helpers as any, args)
    expect((second.messageSource as any)?.selected).toBe('native-history')
    expect((second.messageSource as any)?.fallbackReason).toBe('native_history_transient_gap_held')
    expect((second.messageSource as any)?.ptyStatusApprovalOnly).toBe(true)
    expect((second.messages as any[]).map(message => message.content)).toEqual([
      'restored prompt',
      'restored answer',
    ])
  })

  it('leaves non-exact (live-bound) sessions on the normal machine path — no sticky hold, PTY renders on a native gap', async () => {
    const runtimeSessionId = 'runtime-nonexact-native-gap'
    const liveProviderSessionId = '019ea400-0000-7000-8000-000000000004'
    let readCount = 0
    mocks.readProviderChatHistory.mockImplementation(() => {
      readCount += 1
      if (readCount === 1) {
        return {
          messages: nativeMessages([
            { role: 'user', content: 'live prompt', receivedAt: 1000 },
            { role: 'assistant', content: 'live answer', receivedAt: 1100 },
          ]),
          hasMore: false,
          source: 'provider-native',
          providerSessionId: liveProviderSessionId,
          nativeHistoryCoverage: 'full',
        }
      }
      return {
        messages: [],
        hasMore: false,
        source: 'provider-native',
        providerSessionId: liveProviderSessionId,
      }
    })

    // No explicit historySessionId / providerSessionId args and no parsed
    // provider id: the read live-binds via spawn floor (non-exact identity).
    const adapter = createAdapter(runtimeSessionId, undefined, ptyMessages(6))
    const helpers = createSessionHelpers(runtimeSessionId, adapter)
    const args = {
      agentType: 'codex-cli',
      targetSessionId: runtimeSessionId,
      tailLimit: 20,
    }

    const first = await handleReadChat(helpers as any, args)
    expect((first.messageSource as any)?.selected).toBe('native-history')

    const second = await handleReadChat(helpers as any, args)
    expect((second.messageSource as any)?.selected).toBe('pty-parser')
    expect((second.messages as any[]).map(message => message.content)).toContain('pty row 1')
  })

  it('cold resolver after a daemon restart (Booting) with an exact pin and empty native renders PTY, then locks native on recovery', async () => {
    const runtimeSessionId = 'runtime-cold-resolver-gap'
    const providerSessionId = '019ea400-0000-7000-8000-000000000005'
    let readCount = 0
    mocks.readProviderChatHistory.mockImplementation(() => {
      readCount += 1
      if (readCount === 1) {
        return {
          messages: [],
          hasMore: false,
          source: 'provider-native',
          providerSessionId,
        }
      }
      return {
        messages: nativeMessages([
          { role: 'user', content: 'recovered prompt', receivedAt: 1000 },
          { role: 'assistant', content: 'recovered answer', receivedAt: 1100 },
        ]),
        hasMore: false,
        source: 'provider-native',
        providerSessionId,
        nativeHistoryCoverage: 'full',
      }
    })

    const adapter = createAdapter(runtimeSessionId, providerSessionId, ptyMessages(6))
    const helpers = createSessionHelpers(runtimeSessionId, adapter, providerSessionId)
    const args = {
      agentType: 'codex-cli',
      targetSessionId: runtimeSessionId,
      historySessionId: providerSessionId,
      providerSessionId,
      tailLimit: 20,
    }

    // First read of a fresh process: the registry has no record (Booting), so
    // the machine selects PTY on the empty native observation and the PTY rows
    // render — no zero-bubble.
    const first = await handleReadChat(helpers as any, args)
    expect(first.success).toBe(true)
    expect((first.messageSource as any)?.selected).toBe('pty-parser')
    expect((first.messageSource as any)?.ptyStatusApprovalOnly).toBe(false)
    expect((first.messages as any[]).map(message => message.content)).toHaveLength(6)

    // Native recovers on the next read: Booting → PtyOnly → NativeLocked.
    const second = await handleReadChat(helpers as any, args)
    expect((second.messageSource as any)?.selected).toBe('native-history')
    expect((second.messages as any[]).map(message => message.content)).toEqual([
      'recovered prompt',
      'recovered answer',
    ])
  })

  it('hold-free gap then native recovery returns the original native rows with no duplicates and no reorder', async () => {
    const runtimeSessionId = 'runtime-gap-recover-order'
    const providerSessionId = '019ea400-0000-7000-8000-000000000006'
    const fullNative = [
      { role: 'user', content: 'turn 1 prompt', receivedAt: 1000 },
      { role: 'assistant', content: 'turn 1 answer', receivedAt: 1100 },
      { role: 'user', content: 'turn 2 prompt', receivedAt: 1200 },
      { role: 'assistant', content: 'turn 2 answer', receivedAt: 1300 },
    ]
    let readCount = 0
    mocks.readProviderChatHistory.mockImplementation(() => {
      readCount += 1
      if (readCount === 2) {
        return {
          messages: [],
          hasMore: false,
          source: 'provider-native',
          providerSessionId,
        }
      }
      return {
        messages: nativeMessages(fullNative),
        hasMore: false,
        source: 'provider-native',
        providerSessionId,
        nativeHistoryCoverage: 'full',
      }
    })

    const adapter = createAdapter(runtimeSessionId, providerSessionId, ptyMessages(6))
    const helpers = createSessionHelpers(runtimeSessionId, adapter, providerSessionId)
    const args = {
      agentType: 'codex-cli',
      targetSessionId: runtimeSessionId,
      historySessionId: providerSessionId,
      providerSessionId,
      tailLimit: 20,
    }

    const first = await handleReadChat(helpers as any, args)
    expect((first.messageSource as any)?.selected).toBe('native-history')
    const firstContents = (first.messages as any[]).map(message => message.content)

    const second = await handleReadChat(helpers as any, args)
    expect((second.messageSource as any)?.selected).toBe('pty-parser')

    // Recovering re-locks on the next progressed observation; the recovered
    // native tail is byte-identical in content and order to the pre-gap tail.
    const third = await handleReadChat(helpers as any, args)
    expect((third.messageSource as any)?.selected).toBe('native-history')
    const thirdContents = (third.messages as any[]).map(message => message.content)
    expect(thirdContents).toEqual(firstContents)
    expect(thirdContents).toEqual([
      'turn 1 prompt',
      'turn 1 answer',
      'turn 2 prompt',
      'turn 2 answer',
    ])
    expect(new Set(thirdContents).size).toBe(thirdContents.length)
  })
})
