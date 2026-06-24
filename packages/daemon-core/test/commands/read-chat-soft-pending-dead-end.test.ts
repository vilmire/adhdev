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

import { handleReadChat } from '../../src/commands/chat-commands.js'

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

describe('read_chat dead-end soft response (no live adapter + native not safely mappable)', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
  })

  it('returns success:true + empty + pending + reason instead of a hard error when native history cannot be safely mapped', async () => {
    // History-only path (no live adapter). Native history is returned but its
    // workspace mismatches the requested session's workspace and it carries no
    // historySessionId stamp, so hasSafeNativeHistoryMapping() fails closed and
    // the source machine refuses to select native. Previously this returned
    // { success:false, code:'native_history_not_safely_available' } which the
    // command logger emits at warn level on every coordinator poll. It must now
    // be a soft pending success so the coordinator backs off without a log storm.
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        { role: 'assistant', content: 'some other session answer', receivedAt: 1, workspace: '/tmp/other-workspace' },
      ],
      hasMore: false,
      source: 'provider-native',
      providerSessionId: 'unrelated-provider-session',
      workspace: '/tmp/other-workspace',
    })

    const result = await handleReadChat(createHelpers() as any, {
      agentType: 'codex-cli',
      targetSessionId: 'dead-end-runtime-session',
      historySessionId: 'explicit-requested-session-id',
      workspace: '/tmp/requested-workspace',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result as any).pending).toBe(true)
    expect((result as any).reason).toBe('native_history_not_safely_available')
    expect((result as any).reasons).toContain('live_adapter_not_found')
    expect((result as any).reasons).toContain('native_history_not_safely_available')
    expect(result.messages).toEqual([])
    // No error string => the command logger does not emit a warn-level line.
    expect(result.error).toBeUndefined()
  })

  it('still returns normal history (not a soft pending) when native history IS safely mapped to the requested session', async () => {
    // Regression guard: the safe-native return path must be untouched. Here the
    // native messages carry the requested historySessionId and matching
    // workspace, so safeMapping holds and real messages are returned.
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        {
          role: 'assistant',
          content: 'matched session answer',
          receivedAt: 1,
          workspace: '/tmp/requested-workspace',
          historySessionId: 'explicit-requested-session-id',
        },
      ],
      hasMore: false,
      source: 'provider-native',
      providerSessionId: 'explicit-requested-session-id',
      workspace: '/tmp/requested-workspace',
    })

    const result = await handleReadChat(createHelpers() as any, {
      agentType: 'codex-cli',
      targetSessionId: 'dead-end-runtime-session',
      historySessionId: 'explicit-requested-session-id',
      workspace: '/tmp/requested-workspace',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result as any).pending).toBeUndefined()
    expect((result.messages as any[]).map((m) => m.content)).toEqual(['matched session answer'])
  })

  it('returns live messages (not a soft pending) when a live adapter is present', async () => {
    // Regression guard: the live-adapter path must be untouched. With a live
    // PTY adapter bound to the runtime session, read_chat returns the live/native
    // messages normally — it never enters the history-only dead-end branch.
    const runtimeSessionId = 'live-runtime-session'
    const providerSessionId = '019ea359-e438-7be2-b24e-88aedb6cd87c'
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        { role: 'user', content: 'live prompt', receivedAt: 1100 },
        { role: 'assistant', content: 'live answer', receivedAt: 1200 },
      ],
      hasMore: false,
      source: 'provider-native',
      providerSessionId,
    })
    const adapter = {
      cliType: 'codex-cli',
      cliName: 'Codex CLI',
      workingDir: '/tmp/adhdev-project',
      getStatus: () => ({ status: 'idle' }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        messages: [{ role: 'user', content: 'live prompt', receivedAt: 1100 }],
      }),
      getRuntimeMetadata: () => ({
        runtimeId: runtimeSessionId,
        runtimeKey: runtimeSessionId,
        spawnedAtMs: 1000,
        spawnedEnv: {},
      }),
      updateRuntimeMeta: vi.fn(),
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
    expect((result as any).pending).toBeUndefined()
    expect((result.messages as any[]).map((m) => m.content)).toEqual(['live prompt', 'live answer'])
  })
})
