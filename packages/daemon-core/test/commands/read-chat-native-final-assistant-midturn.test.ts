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

// RC17-NATIVE-FINAL-ASSISTANT-MIDTURN regression.
//
// Live evidence:
//  (A) debug bundle chat-debug-20260727T023205803Z-8c5b3b1a-...-949e1ad0.json — a Claude
//      session's read_chat status field flipped generating→idle via
//      statusReconciled.reason='provider_native_final_assistant' while
//      debugReadChat.adapterStatus/parsedStatus were BOTH still 'generating', and the raw
//      PTY tail showed live tool activity ("Auto-approved: Yes\nBash command").
//  (B) the SAME reconciliation terminalized on an INTERIM narration bubble — the native
//      transcript's last row at read time was "Starting the collector now, before the
//      two-turn protocol." — before the real two-turn protocol/tool work had a chance to
//      land in the (write-lagged) native JSONL file.
//
// Root cause: chat-commands-read.ts's `provider_native_final_assistant` reconciliation
// (~line 2483) only checked hasFinalVisibleAssistantMessage(selectedMessages) — "is the
// last visible NATIVE message a non-empty assistant bubble" — with no check for whether
// that bubble was actually the end of the turn. rc.16 (9452bd03/6677a565) closed the
// equivalent gap for the mesh agent:generating_completed event ingress via
// hasTrailingToolActivityAfterFinalAssistant + hasLiveTurnPendingEvidence, but this
// SEPARATE read_chat status ingress never got the same veto.
//
// The fix applies hasTrailingToolActivityAfterFinalAssistant to BOTH the native messages
// being judged (catches trailing tool activity already synced to the native transcript)
// AND the live PTY-parsed messages (returnedMessages — no native-transcript write-lag,
// catches evidence (A)/(B)'s exact race where the tool call had already rendered in the
// PTY but not yet landed in the native JSONL file).

function createHelpers() {
  return {
    getCdp: () => null,
    getProvider: (type?: string) => {
      if (type === 'antigravity-cli') {
        return { type: 'antigravity-cli', category: 'cli', nativeHistory: { mode: 'canonical' }, historyBehavior: {} }
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

describe('read_chat provider_native_final_assistant reconciliation — mid-turn false-completion guard', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
    __resetProviderSessionPinsForTest()
  })

  it('does NOT reconcile to idle when the live PTY tail shows tool activity after the interim native bubble (write-lag race)', async () => {
    const runtimeSessionId = 'runtime-claude-midturn-writelag'
    const providerSessionId = 'claude-session-1'
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        { role: 'user', content: 'Investigate the RCA', receivedAt: 1000, workspace: '/tmp/adhdev-project' },
        // Native JSONL has not yet caught up with the tool call that followed —
        // this interim bubble is the LAST row in the file at read time.
        { role: 'assistant', content: 'Starting the collector now, before the two-turn protocol.', receivedAt: 1100, workspace: '/tmp/adhdev-project' },
      ],
      hasMore: false,
      source: 'provider-native',
      providerSessionId,
      nativeHistoryCoverage: 'full',
      workspace: '/tmp/adhdev-project',
    })

    const adapter = {
      cliType: 'antigravity-cli',
      cliName: 'Antigravity',
      workingDir: '/tmp/adhdev-project',
      getStatus: () => ({ status: 'generating', providerSessionId, activeModal: null, messages: [] }),
      // The live PTY parse — no write-lag — already shows the tool call that followed
      // the interim bubble.
      getScriptParsedStatus: () => ({
        status: 'generating',
        providerSessionId,
        activeModal: null,
        messages: [
          { role: 'user', content: 'Investigate the RCA', receivedAt: 1000 },
          { role: 'assistant', content: 'Starting the collector now, before the two-turn protocol.', receivedAt: 1100 },
          { role: 'assistant', content: 'Auto-approved: Yes\nBash command', receivedAt: 1150, kind: 'terminal' },
        ],
      }),
      getRuntimeMetadata: () => ({
        runtimeId: runtimeSessionId,
        runtimeKey: runtimeSessionId,
        providerSessionId,
        spawnedAtMs: 1000,
        spawnedEnv: {},
      }),
      getPartialResponse: () => '',
      isProcessing: () => true,
      isReady: () => true,
      updateRuntimeMeta: vi.fn(),
    }

    const result = await handleReadChat({
      ...createHelpers(),
      getCliAdapter: () => adapter,
      currentSession: {
        sessionId: runtimeSessionId,
        providerSessionId,
        providerType: 'antigravity-cli',
        transport: 'pty',
        workspace: '/tmp/adhdev-project',
      },
      ctx: {
        instanceManager: { getInstance: () => null },
        sessionRegistry: {
          get: () => ({
            sessionId: runtimeSessionId,
            providerSessionId,
            providerType: 'antigravity-cli',
            transport: 'pty',
            spawnedAtMs: 1000,
          }),
        },
      },
    } as any, {
      agentType: 'antigravity-cli',
      targetSessionId: runtimeSessionId,
      historySessionId: providerSessionId,
      providerSessionId,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    // Must NOT have been reconciled to idle — the turn is still genuinely live.
    expect(result.status).toBe('generating')
    expect((result.messageSource as any)?.statusReconciled).toBeUndefined()
  })

  it('does NOT reconcile to idle when the native transcript itself shows trailing tool activity after the final-looking bubble', async () => {
    const runtimeSessionId = 'runtime-native-trailing-tool'
    const providerSessionId = 'native-session-1'
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        { role: 'user', content: 'Update README', receivedAt: 1800, workspace: '/tmp/adhdev-project' },
        { role: 'assistant', content: 'README updated.', receivedAt: 1900, workspace: '/tmp/adhdev-project' },
        // A tool call already landed in the native transcript AFTER the
        // final-looking bubble — the turn kept going.
        { role: 'assistant', content: 'ran a follow-up tool', receivedAt: 1950, workspace: '/tmp/adhdev-project', kind: 'tool' },
      ],
      hasMore: false,
      source: 'provider-native',
      providerSessionId,
      nativeHistoryCoverage: 'full',
      workspace: '/tmp/adhdev-project',
    })

    const adapter = {
      cliType: 'antigravity-cli',
      cliName: 'Antigravity',
      workingDir: '/tmp/adhdev-project',
      getStatus: () => ({ status: 'generating', providerSessionId, activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({
        status: 'generating',
        providerSessionId,
        messages: [],
        activeModal: null,
      }),
      getRuntimeMetadata: () => ({
        runtimeId: runtimeSessionId,
        runtimeKey: runtimeSessionId,
        providerSessionId,
        spawnedAtMs: 1000,
        spawnedEnv: {},
      }),
      getPartialResponse: () => '⣾ Working...',
      isProcessing: () => true,
      isReady: () => true,
      updateRuntimeMeta: vi.fn(),
    }

    const result = await handleReadChat({
      ...createHelpers(),
      getCliAdapter: () => adapter,
      currentSession: {
        sessionId: runtimeSessionId,
        providerSessionId,
        providerType: 'antigravity-cli',
        transport: 'pty',
        workspace: '/tmp/adhdev-project',
      },
      ctx: {
        instanceManager: { getInstance: () => null },
        sessionRegistry: {
          get: () => ({
            sessionId: runtimeSessionId,
            providerSessionId,
            providerType: 'antigravity-cli',
            transport: 'pty',
            spawnedAtMs: 1000,
          }),
        },
      },
    } as any, {
      agentType: 'antigravity-cli',
      targetSessionId: runtimeSessionId,
      historySessionId: providerSessionId,
      providerSessionId,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.status).toBe('generating')
    expect((result.messageSource as any)?.statusReconciled).toBeUndefined()
  })
})
