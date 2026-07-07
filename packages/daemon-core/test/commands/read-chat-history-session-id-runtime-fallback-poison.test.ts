import { beforeEach, describe, expect, it, vi } from 'vitest'

// Root fix (D9) for "antigravity COORDINATOR chat shows only the user message"
// that the prior 8 rounds missed.
//
// The prior fixes (D1/D3/D6/D7/D8) all verified against reads where
// historySessionId was EMPTY — those succeed and resolve via the owner-confirmed
// native resolution. But the BROWSER's real read (the subscription +
// D8 refreshAuthoritativeTail) sends historySessionId === the ADHDev
// targetSessionId: for an agy coordinator whose providerSessionId is never
// surfaced to the web, getConversationHistorySessionId falls back to the ADHDev
// sessionId and the browser sends THAT back as historySessionId.
//
// That runtime id is NOT the on-disk conversations/<uuid>.db name (targetSessionId
// != the native rows' stamped conv uuid), so a native read keyed on it exact-binds
// to nothing and hasSafeNativeHistoryMapping fail-closes to pty-parser (user-only).
// Worse, a non-empty historySessionId disables canBindFromLiveSession and the
// owner-confirmed pin/resolution — so the browser POISONS its own read.
//
// The daemon fix: when historySessionId EQUALS the ADHDev targetSessionId it is a
// runtime fallback, NOT a real provider conv uuid. Treat it as ABSENT so the same
// owner-confirmed native resolution an empty historySessionId gets engages and
// returns [user, assistant, ...]. A REAL, DISTINCT provider conv uuid is unchanged.

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

import {
  __getProviderSessionPinForTest,
  __resetProviderSessionPinsForTest,
  handleReadChat,
} from '../../src/commands/chat-commands.js'

// ADHDev runtime session id (28c530af-style) the browser sends BACK as
// historySessionId. The native rows are stamped with a DIFFERENT conv uuid.
const COORDINATOR_SESSION = '28c530af-0000-4000-8000-000000000001'
const OWNER_UUID = '07f6ed3e-0000-4000-8000-00000000aaaa'
const OTHER_CONV_UUID = 'deadbeef-0000-4000-8000-00000000cccc'
const WORKSPACE = '/workspaces/agy-coordinator'

function createHelpers(sessionRegistryGet: (id: string) => any = () => undefined) {
  return {
    getCdp: () => null,
    getProvider: (type?: string) => {
      if (type === 'antigravity-cli') {
        return {
          type: 'antigravity-cli',
          category: 'cli',
          nativeHistory: { mode: 'canonical', reader: 'antigravity-cli' },
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
      sessionRegistry: {
        get: sessionRegistryGet,
        setProviderSessionId: () => {},
      },
    },
    historyWriter: { appendNewMessages: () => {} },
  }
}

// The coordinator's OWN conversation, stamped with OWNER_UUID (≠ COORDINATOR_SESSION),
// resolved via the workspace-latest owner-confirmed path — exactly what an EMPTY
// historySessionId read gets today.
function ownerConversationRead() {
  return {
    messages: [
      { role: 'user', content: 'coordinator: mesh_send_task to replicas', receivedAt: 3100, workspace: WORKSPACE, historySessionId: OWNER_UUID },
      { role: 'assistant', content: 'coordinator answer: dispatched 3 tasks', receivedAt: 3200, workspace: WORKSPACE, historySessionId: OWNER_UUID },
    ],
    hasMore: false,
    source: 'provider-native',
    providerSessionId: OWNER_UUID,
    workspace: WORKSPACE,
    lookup: 'workspace',
    ownerConfirmed: true,
  }
}

describe('read_chat runtime-fallback historySessionId poison (historySessionId === ADHDev targetSessionId)', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
    __resetProviderSessionPinsForTest()
  })

  it('the browser sends historySessionId === targetSessionId → treated as ABSENT → owner-confirmed native resolution returns [user, assistant]', async () => {
    // The native read must be invoked WITHOUT the poisoned runtime id (undefined),
    // otherwise it would exact-bind on the non-existent conv. When called with an
    // undefined/empty historySessionId the dispatcher resolves the owner-confirmed
    // workspace-latest conversation.
    mocks.readProviderChatHistory.mockImplementation((_agent: string, options: any) => {
      const passedId = typeof options?.historySessionId === 'string' ? options.historySessionId.trim() : ''
      // Poison guard proof: the runtime id must never reach the native reader.
      expect(passedId).not.toBe(COORDINATOR_SESSION)
      return ownerConversationRead()
    })

    const helpers = createHelpers((id: string) => id === COORDINATOR_SESSION
      ? { sessionId: COORDINATOR_SESSION, providerType: 'antigravity-cli', transport: 'pty', workspace: WORKSPACE }
      : undefined)

    // The EXACT browser payload from the live capture: historySessionId === the
    // ADHDev sessionId (the poison the prior fixes never saw).
    const result = await handleReadChat(helpers as any, {
      agentType: 'antigravity-cli',
      targetSessionId: COORDINATOR_SESSION,
      historySessionId: COORDINATOR_SESSION,
      workspace: WORKSPACE,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    const contents = (result.messages as any[]).map((m) => m.content)
    // The assistant answer must reach the surfaced messages (not user-echo only).
    expect(contents).toContain('coordinator answer: dispatched 3 tasks')
    expect(contents).toContain('coordinator: mesh_send_task to replicas')
    expect(result.providerSessionId).toBe(OWNER_UUID)
    // And the owner-confirmed uuid gets pinned for the next read.
    expect(__getProviderSessionPinForTest(COORDINATOR_SESSION)).toBe(OWNER_UUID)
  })

  it('the empty-historySessionId read already returns the assistant (the reference behavior the runtime-fallback read must now match)', async () => {
    mocks.readProviderChatHistory.mockImplementation((_agent: string, _options: any) => ownerConversationRead())

    const helpers = createHelpers((id: string) => id === COORDINATOR_SESSION
      ? { sessionId: COORDINATOR_SESSION, providerType: 'antigravity-cli', transport: 'pty', workspace: WORKSPACE }
      : undefined)

    // No historySessionId at all — the path the prior fixes verified against.
    const result = await handleReadChat(helpers as any, {
      agentType: 'antigravity-cli',
      targetSessionId: COORDINATOR_SESSION,
      workspace: WORKSPACE,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map((m) => m.content)).toContain('coordinator answer: dispatched 3 tasks')
  })

  it('NEGATIVE: a REAL DISTINCT provider conv uuid as historySessionId still EXACT-BINDS to that conv (unchanged)', async () => {
    // A legitimate read where historySessionId is a real provider conv uuid that is
    // NOT the ADHDev sessionId must keep exact-binding — the poison guard must not
    // fire for it. The native reader must receive that exact id.
    mocks.readProviderChatHistory.mockImplementation((_agent: string, options: any) => {
      expect(options?.historySessionId).toBe(OTHER_CONV_UUID)
      return {
        messages: [
          { role: 'user', content: 'distinct-conv user turn', receivedAt: 5100, workspace: WORKSPACE, historySessionId: OTHER_CONV_UUID },
          { role: 'assistant', content: 'distinct-conv assistant answer', receivedAt: 5200, workspace: WORKSPACE, historySessionId: OTHER_CONV_UUID },
        ],
        hasMore: false,
        source: 'provider-native',
        providerSessionId: OTHER_CONV_UUID,
        workspace: WORKSPACE,
        lookup: 'session',
        ownerConfirmed: true,
      }
    })

    const helpers = createHelpers((id: string) => id === COORDINATOR_SESSION
      ? { sessionId: COORDINATOR_SESSION, providerType: 'antigravity-cli', transport: 'pty', workspace: WORKSPACE }
      : undefined)

    const result = await handleReadChat(helpers as any, {
      agentType: 'antigravity-cli',
      targetSessionId: COORDINATOR_SESSION,
      historySessionId: OTHER_CONV_UUID,
      workspace: WORKSPACE,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map((m) => m.content)).toContain('distinct-conv assistant answer')
    expect(mocks.readProviderChatHistory).toHaveBeenLastCalledWith('antigravity-cli', expect.objectContaining({
      historySessionId: OTHER_CONV_UUID,
    }))
  })
})
