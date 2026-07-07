import { beforeEach, describe, expect, it, vi } from 'vitest'

// Root fix for "antigravity COORDINATOR chat shows only the user message".
//
// A coordinator agy session has NO pin (agy takes no --session-id, so
// state.json sessionProviderSessionPins is empty for it) and after attach-restore
// spawnedAtMs is 0. Its post-turn read (no live adapter) therefore resolves the
// conversation via the workspace-latest fallback (lookup === 'workspace'). The
// dispatcher STILL surfaces the on-disk conversation uuid there and flags whether
// it was OWNER-token-confirmed as this session's own (an exact/birth pick) vs a
// bare recency pick (which could be a co-located replica's conversation).
//
// Before the fix: the workspace-latest read blanked identity into the safe-mapping
// check (lookup === 'workspace' → historySessionId/providerSessionId undefined) →
// the check fell to the workspace-overlap branch → the PTY snapshot has only the
// user runtime_input_ack echo → hasSafeNativeHistoryMapping failed closed → the
// source machine regressed to pty-parser → the dashboard saw only the user echo,
// and NO pin was ever recorded (self-perpetuating trap).
//
// After the fix: an OWNER-CONFIRMED workspace-latest uuid is (a) fed as the
// explicit identity to the safe-mapping check so it trusts the assistant on the
// FIRST read, and (b) recorded as the pin. A NON-owner-confirmed (bare recency)
// uuid does NEITHER — the coordinator↔replica crosswire guard stays intact.
//
// These tests drive the history-only read path (getCliAdapter → null) with
// readProviderChatHistory mocked to reproduce the two dispatcher outcomes.

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

// The live case: coordinator mesh session id (d86e3c13-style) + two co-located
// agy conversation DBs (owner 1b8d0688, replica 59bd105c) + a PTY snapshot that
// contains ONLY the user runtime_input_ack echo.
const COORDINATOR_SESSION = 'd86e3c13-0000-4000-8000-000000000001'
const OWNER_UUID = '1b8d0688-0000-4000-8000-00000000aaaa'
const REPLICA_UUID = '59bd105c-0000-4000-8000-00000000bbbb'
const WORKSPACE = '/workspaces/agy-coordinator'

// antigravity-cli declares a native canonical history source, so the read path
// exercises readCliProviderNativeHistory + hasSafeNativeHistoryMapping. No live
// CLI adapter is registered (getCliAdapter → null) → the history-only branch runs,
// which is the exact path a coordinator hits on a post-turn read.
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
        // recordBoundProviderSessionId writes the SSOT back here — accept it.
        setProviderSessionId: () => {},
      },
    },
    historyWriter: { appendNewMessages: () => {} },
  }
}

// The coordinator's own conversation, keyed on the owner uuid. Messages carry the
// uuid as historySessionId + the coordinator workspace + a real assistant answer.
function ownerConversationRead(ownerConfirmed: boolean) {
  return {
    messages: [
      { role: 'user', content: 'coordinator: mesh_send_task to replicas', receivedAt: 3100, workspace: WORKSPACE, historySessionId: OWNER_UUID },
      { role: 'assistant', content: 'coordinator answer: dispatched 3 tasks', receivedAt: 3200, workspace: WORKSPACE, historySessionId: OWNER_UUID },
    ],
    hasMore: false,
    source: 'provider-native',
    providerSessionId: OWNER_UUID,
    workspace: WORKSPACE,
    // The read resolved via the workspace-latest fallback (no pin, spawnedAtMs=0).
    lookup: 'workspace',
    ownerConfirmed,
  }
}

describe('read_chat antigravity coordinator pin + owner-confirmed safe-mapping (workspace-latest)', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
    __resetProviderSessionPinsForTest()
  })

  it('(a) owner-confirmed workspace-latest read: assistant reaches liveMessages + safeMapping true + pin recorded', async () => {
    // No pin exists for the coordinator, so the history-only path takes the
    // workspace-latest fallback (no explicit historySessionId → the dispatcher
    // resolved the owner conversation). ownerConfirmed=true (the dispatcher's
    // exact/birth branch), so identity is trusted uuid-to-uuid on this FIRST read.
    mocks.readProviderChatHistory.mockImplementation((_agent: string, _options: any) => ownerConversationRead(true))

    const helpers = createHelpers((id: string) => id === COORDINATOR_SESSION
      ? { sessionId: COORDINATOR_SESSION, providerType: 'antigravity-cli', transport: 'pty', workspace: WORKSPACE }
      : undefined)

    const result = await handleReadChat(helpers as any, {
      agentType: 'antigravity-cli',
      targetSessionId: COORDINATOR_SESSION,
      workspace: WORKSPACE,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    // The assistant answer must reach the surfaced messages (not user-echo only).
    const contents = (result.messages as any[]).map((m) => m.content)
    expect(contents).toContain('coordinator answer: dispatched 3 tasks')
    expect(contents).toContain('coordinator: mesh_send_task to replicas')
    expect(result.providerSessionId).toBe(OWNER_UUID)

    // The pin was recorded to sessionProviderSessionPins[coordinatorSessionId].
    expect(__getProviderSessionPinForTest(COORDINATOR_SESSION)).toBe(OWNER_UUID)
  })

  it('(b) NON-owner-confirmed workspace-latest read: safeMapping stays false + NO pin recorded (crosswire guard intact)', async () => {
    // The dispatcher fell back to a bare recency/newest-by-mtime pick — the uuid it
    // surfaced may be a co-located REPLICA's conversation, not the coordinator's.
    // ownerConfirmed=false must keep the read fail-closed and NEVER record the pin
    // (recording a replica uuid would hard-wire the crosswire permanently).
    // Reproduce it precisely: the resolved (replica) uuid does not match the
    // coordinator, the PTY snapshot has only the user echo, so with identity
    // suppressed the workspace-overlap branch cannot confirm ownership.
    mocks.readProviderChatHistory.mockImplementation((_agent: string, _options: any) => ({
      messages: [
        // A replica's conversation — different uuid, but same shared workspace.
        { role: 'user', content: 'replica turn prompt', receivedAt: 4100, workspace: WORKSPACE, historySessionId: REPLICA_UUID },
        { role: 'assistant', content: 'replica answer (must NOT surface as coordinator)', receivedAt: 4200, workspace: WORKSPACE, historySessionId: REPLICA_UUID },
      ],
      hasMore: false,
      source: 'provider-native',
      providerSessionId: REPLICA_UUID,
      workspace: WORKSPACE,
      lookup: 'workspace',
      ownerConfirmed: false,
    }))

    const helpers = createHelpers((id: string) => id === COORDINATOR_SESSION
      ? { sessionId: COORDINATOR_SESSION, providerType: 'antigravity-cli', transport: 'pty', workspace: WORKSPACE }
      : undefined)

    const result = await handleReadChat(helpers as any, {
      agentType: 'antigravity-cli',
      targetSessionId: COORDINATOR_SESSION,
      workspace: WORKSPACE,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    // The replica's assistant answer must NOT surface for the coordinator.
    const contents = (result.messages as any[] | undefined)?.map((m) => m.content) ?? []
    expect(contents).not.toContain('replica answer (must NOT surface as coordinator)')
    // And the crosswire-forming pin must NOT be recorded.
    expect(__getProviderSessionPinForTest(COORDINATOR_SESSION)).toBeUndefined()
  })

  it('(a2) D3: a coordinator carrying a REAL session-host floor (registry spawnedAtMs > 0) resolves ownerConfirmed and records the pin', async () => {
    // The D3 fix threads the runtime's real (PAST) startedAt into the session
    // registry's spawnedAtMs on attach, so the coordinator's read now carries a
    // POSITIVE floor (instead of the old attach-collapsed 0). With a valid floor
    // the dispatcher's birth-branch confirms the coordinator's OWN conv
    // (ownerConfirmed:true) — modeled here by the owner-confirmed read — and the
    // pin gets recorded, breaking the self-perpetuating user-only trap.
    mocks.readProviderChatHistory.mockImplementation((_agent: string, _options: any) => ownerConversationRead(true))

    const realFloorMs = 1_900_000_000_000 // a PAST timestamp — the runtime's true birth
    const helpers = createHelpers((id: string) => id === COORDINATOR_SESSION
      ? { sessionId: COORDINATOR_SESSION, providerType: 'antigravity-cli', transport: 'pty', workspace: WORKSPACE, spawnedAtMs: realFloorMs }
      : undefined)

    const result = await handleReadChat(helpers as any, {
      agentType: 'antigravity-cli',
      targetSessionId: COORDINATOR_SESSION,
      workspace: WORKSPACE,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map((m) => m.content)).toContain('coordinator answer: dispatched 3 tasks')
    // The D3 outcome: the coordinator's own conv is pinned.
    expect(__getProviderSessionPinForTest(COORDINATOR_SESSION)).toBe(OWNER_UUID)
  })

  it('(c) once the owner-confirmed pin is recorded, the next read exact-binds via the pin (no more workspace-latest)', async () => {
    // First read: owner-confirmed workspace-latest → records the pin.
    mocks.readProviderChatHistory.mockImplementation((_agent: string, options: any) => {
      // A pinned read passes historySessionId === OWNER_UUID (exact bind).
      if (options?.historySessionId === OWNER_UUID) {
        return { ...ownerConversationRead(true), lookup: 'session' }
      }
      // Unpinned first read: workspace-latest.
      return ownerConversationRead(true)
    })

    const helpers = createHelpers((id: string) => id === COORDINATOR_SESSION
      ? { sessionId: COORDINATOR_SESSION, providerType: 'antigravity-cli', transport: 'pty', workspace: WORKSPACE }
      : undefined)

    await handleReadChat(helpers as any, {
      agentType: 'antigravity-cli',
      targetSessionId: COORDINATOR_SESSION,
      workspace: WORKSPACE,
      tailLimit: 20,
    })
    expect(__getProviderSessionPinForTest(COORDINATOR_SESSION)).toBe(OWNER_UUID)

    // Second read: the pin drives an exact bind on OWNER_UUID.
    const second = await handleReadChat(helpers as any, {
      agentType: 'antigravity-cli',
      targetSessionId: COORDINATOR_SESSION,
      workspace: WORKSPACE,
      tailLimit: 20,
    })
    expect(second.success).toBe(true)
    expect((second.messages as any[]).map((m) => m.content)).toContain('coordinator answer: dispatched 3 tasks')
    expect(mocks.readProviderChatHistory).toHaveBeenLastCalledWith('antigravity-cli', expect.objectContaining({
      historySessionId: OWNER_UUID,
    }))
  })
})
