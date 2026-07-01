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

// hermes-cli is a native-only provider: it declares a canonical native history
// source AND suppresses PTY bodies (transcriptAuthority: 'provider'). The
// history-only read path therefore has NO PTY transcript to fall back to — so
// if the source FSM declines native (e.g. a post-turn read where coverage came
// back 'partial'), the pty-parser selection returns an EMPTY array and the
// assistant answer disappears from chat_tail / read_chat. These tests pin the
// content-preservation guard: when the native read resolved real, safely-mapped
// rows for THIS session, they must be returned even if the FSM selected
// pty-parser.
function createHelpers(sessionRegistryGet: (id: string) => any = () => undefined) {
  return {
    getCdp: () => null,
    getProvider: (type?: string) => {
      if (type === 'hermes-cli') {
        return {
          type: 'hermes-cli',
          category: 'cli',
          nativeHistory: { mode: 'canonical' },
          historyBehavior: { transcriptAuthority: 'provider' },
        }
      }
      if (type === 'claude-cli') {
        // A PTY-bearing provider WITHOUT a native canonical source: supportsNative
        // is false so the native-only guard must never engage for it.
        return {
          type: 'claude-cli',
          category: 'cli',
        }
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
      sessionRegistry: { get: sessionRegistryGet },
    },
    historyWriter: { appendNewMessages: () => {} },
  }
}

describe('read_chat hermes-cli native-only tail-drop guard (post-turn)', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
  })

  it('returns the safely-mapped assistant answer even when native coverage is partial (FSM would pick pty-parser)', async () => {
    const runtimeSessionId = 'mesh-runtime-native-only-partial-1'
    const realProviderSessionId = 'hermes-provider-partial-abc'
    const workspace = '/tmp/adhdev-native-only-partial'

    // The native reader resolves REAL, safely-mapped rows keyed on the real
    // provider session id, but reports coverage 'partial' — the exact post-turn
    // shape (missing sessionStartedAtMs) that drives the source FSM from Booting
    // to Recovering and selects pty-parser. Since PTY is suppressed for hermes,
    // a pty-parser selection returns an empty array and would drop the assistant
    // answer; the content-preservation guard must return the safely-mapped rows.
    mocks.readProviderChatHistory.mockImplementation((_agent: string, options: any) => {
      if (options?.historySessionId === realProviderSessionId) {
        return {
          messages: [
            { role: 'user', content: 'hermes prompt', receivedAt: 1100, workspace, historySessionId: realProviderSessionId },
            { role: 'assistant', content: 'hermes answer', receivedAt: 1200, workspace, historySessionId: realProviderSessionId },
          ],
          hasMore: false,
          source: 'provider-native',
          providerSessionId: realProviderSessionId,
          workspace,
          nativeHistoryCoverage: 'partial',
        }
      }
      return {
        messages: [],
        hasMore: false,
        source: 'native-unavailable',
        unavailableReason: 'native_history_workspace_only_lookup_unsafe',
      }
    })

    const helpers = createHelpers((id: string) => id === runtimeSessionId
      ? { sessionId: runtimeSessionId, providerType: 'hermes-cli', transport: 'pty', workspace }
      : undefined)

    // Fresh session key (no prior native lock): the FSM starts at Booting and,
    // seeing a partial-coverage observation, transitions to Recovering →
    // pty-parser. With PTY suppressed the machine's selection returns nothing;
    // the guard must preserve the real, safely-mapped native answer.
    const postTurn = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      targetSessionId: runtimeSessionId,
      providerSessionId: realProviderSessionId,
      workspace,
      tailLimit: 20,
    })

    expect(postTurn.success).toBe(true)
    expect((postTurn.messages as any[]).map(m => m.content)).toEqual(['hermes prompt', 'hermes answer'])
    expect(postTurn.providerSessionId).toBe(realProviderSessionId)
    // Provenance flags the preservation so the drop is debuggable if it recurs,
    // and proves the rows came through the pty-parser-selected guard (not the
    // normal native-selected path).
    expect((postTurn.messageSource as any)?.nativeOnlyContentPreserved).toBe(true)
    expect((postTurn.messageSource as any)?.selected).toBe('pty-parser')
  })

  it('a truly-empty native session still returns empty safely (no phantom transcript)', async () => {
    const runtimeSessionId = 'mesh-runtime-native-only-empty-1'
    const workspace = '/tmp/adhdev-native-only-empty'

    // Nothing ever resolves — neither pinned id nor workspace-latest.
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [],
      hasMore: false,
      source: 'native-unavailable',
      unavailableReason: 'native_history_workspace_only_lookup_unsafe',
    })

    const helpers = createHelpers((id: string) => id === runtimeSessionId
      ? { sessionId: runtimeSessionId, providerType: 'hermes-cli', transport: 'pty', workspace }
      : undefined)

    const result = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      targetSessionId: runtimeSessionId,
      workspace,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]) ?? []).toEqual([])
    expect((result.messageSource as any)?.nativeOnlyContentPreserved).toBeFalsy()
  })

  it('does NOT accept a workspace-aliasing native read whose identity is unsafe', async () => {
    const runtimeSessionId = 'mesh-runtime-native-only-unsafe-1'
    const workspace = '/tmp/adhdev-native-only-unsafe'

    // Native rows come back but they are stamped with a DIFFERENT session id and
    // a DIFFERENT workspace than requested — hasSafeNativeHistoryMapping must
    // reject them, so the guard must NOT preserve/return them.
    mocks.readProviderChatHistory.mockImplementation((_agent: string, options: any) => {
      if (options?.historySessionId === 'some-other-session') {
        return {
          messages: [
            { role: 'assistant', content: 'someone-elses answer', receivedAt: 1200, workspace: '/tmp/other-cwd', historySessionId: 'some-other-session' },
          ],
          hasMore: false,
          source: 'provider-native',
          providerSessionId: 'some-other-session',
          workspace: '/tmp/other-cwd',
        }
      }
      return {
        messages: [],
        hasMore: false,
        source: 'native-unavailable',
        unavailableReason: 'native_history_workspace_only_lookup_unsafe',
      }
    })

    const helpers = createHelpers((id: string) => id === runtimeSessionId
      ? { sessionId: runtimeSessionId, providerType: 'hermes-cli', transport: 'pty', workspace }
      : undefined)

    const result = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      targetSessionId: runtimeSessionId,
      workspace,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    // Never surface another session's transcript.
    expect((result.messages as any[]) ?? []).toEqual([])
    expect((result.messageSource as any)?.nativeOnlyContentPreserved).toBeFalsy()
  })

  it('a PTY-bearing provider without native canonical source is unaffected by the guard', async () => {
    const runtimeSessionId = 'mesh-runtime-pty-bearing-1'
    const workspace = '/tmp/adhdev-pty-bearing'

    // claude-cli has no native canonical source (supportsNative === false), so
    // the native reader must never be consulted and the guard must never fire.
    const helpers = createHelpers((id: string) => id === runtimeSessionId
      ? { sessionId: runtimeSessionId, providerType: 'claude-cli', transport: 'pty', workspace }
      : undefined)

    const result = await handleReadChat(helpers as any, {
      agentType: 'claude-cli',
      targetSessionId: runtimeSessionId,
      workspace,
      tailLimit: 20,
    })

    // Whatever the non-native history-only branch returns, it is not the
    // native-only preservation path: the flag must be absent, and the native
    // reader (mocked for native providers) must not have been asked for native
    // rows via the canonical path.
    expect((result.messageSource as any)?.nativeOnlyContentPreserved).toBeFalsy()
  })
})
