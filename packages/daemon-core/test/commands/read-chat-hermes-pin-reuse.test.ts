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

// hermes-cli declares a native (canonical) history source so the read path
// exercises readCliProviderNativeHistory + its fail-closed guard.
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

describe('read_chat hermes-cli native-history pin reuse (post-turn)', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
  })

  it('reuses the last bound provider session id on a post-turn read and does NOT fail closed', async () => {
    // Unique session id so the module-level pin store never aliases other tests.
    const runtimeSessionId = 'mesh-runtime-pin-reuse-1'
    const realProviderSessionId = 'hermes-provider-session-abc'
    const workspace = '/tmp/adhdev-worktree'

    // The native reader resolves rows ONLY when asked for the real hermes
    // provider session id. A read keyed on the daemon runtime id (the post-turn
    // getHistorySessionId fallback) resolves nothing — exactly the live bug.
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
        }
      }
      // Runtime-id keyed read (or empty) resolves nothing.
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

    // 1) Prime the pin: an explicit provider-session read binds and records it.
    const primed = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      targetSessionId: runtimeSessionId,
      providerSessionId: realProviderSessionId,
      workspace,
      tailLimit: 20,
    })
    expect(primed.success).toBe(true)
    expect((primed.messages as any[]).map(m => m.content)).toEqual(['hermes prompt', 'hermes answer'])
    expect(primed.providerSessionId).toBe(realProviderSessionId)

    // 2) Post-turn read: NO explicit provider id. getHistorySessionId falls back
    //    to the runtime session id, and there is no live spawnedAtMs binding.
    //    Before the fix this fails closed (providerSessionId=null, 0 rows).
    //    With the pin reuse it resolves the bound session's transcript.
    const postTurn = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      targetSessionId: runtimeSessionId,
      workspace,
      tailLimit: 20,
    })

    expect(postTurn.success).toBe(true)
    expect(postTurn.providerSessionId).toBe(realProviderSessionId)
    expect((postTurn.messages as any[]).map(m => m.content)).toEqual(['hermes prompt', 'hermes answer'])
    // The reuse must have driven a native read keyed on the pinned provider id,
    // not on the daemon runtime id.
    expect(mocks.readProviderChatHistory).toHaveBeenLastCalledWith('hermes-cli', expect.objectContaining({
      historySessionId: realProviderSessionId,
    }))
  })

  it('no-pin-ever + no workspace-latest match still fails closed (no crash, empty)', async () => {
    const runtimeSessionId = 'mesh-runtime-no-pin-1'
    const workspace = '/tmp/adhdev-worktree-nopin'

    // Nothing ever resolves — neither the runtime id nor a workspace-latest read.
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

    // Soft-pending / empty, but never a crash and never a wrong transcript.
    expect(result.success).toBe(true)
    expect((result.messages as any[]) ?? []).toEqual([])
    expect(result.providerSessionId).toBeFalsy()
  })

  it('no-pin-ever falls back to a workspace-latest match when one safely exists', async () => {
    const runtimeSessionId = 'mesh-runtime-ws-latest-1'
    const workspace = '/tmp/adhdev-worktree-wslatest'
    const discoveredProviderSessionId = 'hermes-workspace-latest-xyz'

    // No pin exists for this session. A workspace-scoped read (no historySessionId)
    // resolves the newest session with rows for this workspace.
    mocks.readProviderChatHistory.mockImplementation((_agent: string, options: any) => {
      if (!options?.historySessionId) {
        return {
          messages: [
            { role: 'user', content: 'ws prompt', receivedAt: 2100, workspace, historySessionId: discoveredProviderSessionId },
            { role: 'assistant', content: 'ws answer', receivedAt: 2200, workspace, historySessionId: discoveredProviderSessionId },
          ],
          hasMore: false,
          source: 'provider-native',
          providerSessionId: discoveredProviderSessionId,
          workspace,
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
    expect((result.messages as any[]).map(m => m.content)).toEqual(['ws prompt', 'ws answer'])
    expect(result.providerSessionId).toBe(discoveredProviderSessionId)
  })
})
