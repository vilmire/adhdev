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
import { DaemonCommandHandler } from '../../src/commands/handler.js'

function createHelpers() {
  return {
    getCdp: () => null,
    getProvider: (type?: string) => type === 'hermes-cli'
      ? ({ type: 'hermes-cli', category: 'cli', historyBehavior: { transcriptAuthority: 'provider' } })
      : undefined,
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

describe('read_chat completed runtime provider fallback', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
  })

  it('uses explicit providerType and providerSessionId when target runtime session is gone', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [{ role: 'assistant', content: 'completed answer', receivedAt: 1 }],
      hasMore: false,
      providerSessionId: 'provider-history-1',
    })

    const result = await handleReadChat(createHelpers() as any, {
      providerType: 'hermes-cli',
      targetSessionId: 'runtime-that-is-no-longer-active',
      providerSessionId: 'provider-history-1',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map(message => message.content)).toEqual(['completed answer'])
    expect(result.providerSessionId).toBe('provider-history-1')
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('hermes-cli', expect.objectContaining({
      historySessionId: 'provider-history-1',
      limit: 20,
    }))
  })

  it('keeps explicit agentType/providerSessionId available when target runtime session is already gone', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        { role: 'assistant', content: 'saved completed transcript', receivedAt: 1 },
      ],
      hasMore: false,
      providerSessionId: 'provider-session-42',
    })

    const handler = new DaemonCommandHandler({
      cdpManagers: new Map(),
      ideType: '',
      adapters: new Map(),
      providerLoader: {
        resolve: vi.fn((type: string) => type === 'hermes-cli'
          ? { type: 'hermes-cli', category: 'cli', historyBehavior: { transcriptAuthority: 'provider' } }
          : undefined),
      } as any,
      instanceManager: {
        getInstance: () => null,
        listInstanceIds: () => [],
      } as any,
      sessionRegistry: {
        get: () => undefined,
      } as any,
    })

    const result = await handler.handle('read_chat', {
      targetSessionId: 'runtime-session-gone',
      agentType: 'hermes-cli',
      providerSessionId: 'provider-session-42',
      tailLimit: 20,
    })

    expect(result).toMatchObject({
      success: true,
      providerSessionId: 'provider-session-42',
      totalMessages: 1,
    })
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('hermes-cli', expect.objectContaining({
      historySessionId: 'provider-session-42',
      limit: 20,
    }))
  })

  it('allows read_chat to fall through to history when only targetSessionId is provided for a missing session', async () => {
    // Regression: mesh coordinator calls read_chat with targetSessionId of a Codex CLI
    // session that has since been stopped/destroyed. No explicit providerSessionId is
    // passed. The handler must not hard-fail; it should serve persisted history using
    // the targetSessionId as the historySessionId key.
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [{ role: 'assistant', content: 'final codex answer', receivedAt: 1 }],
      hasMore: false,
      providerSessionId: '25e40a0f-2dce-4e5a-9d0d-8fbf63bf7016',
    })

    const handler = new DaemonCommandHandler({
      cdpManagers: new Map(),
      ideType: '',
      adapters: new Map(),
      providerLoader: {
        resolve: vi.fn((type: string) => type === 'codex-cli'
          ? { type: 'codex-cli', category: 'cli', historyBehavior: {} }
          : undefined),
      } as any,
      instanceManager: {
        getInstance: () => null,
        listInstanceIds: () => [],
      } as any,
      sessionRegistry: {
        get: () => undefined,
      } as any,
    })

    const result = await handler.handle('read_chat', {
      targetSessionId: '25e40a0f-2dce-4e5a-9d0d-8fbf63bf7016',
      agentType: 'codex-cli',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect((result.messages as any[]).length).toBeGreaterThan(0)
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('codex-cli', expect.objectContaining({
      historySessionId: '25e40a0f-2dce-4e5a-9d0d-8fbf63bf7016',
    }))
  })
})
