import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readProviderChatHistory: vi.fn(),
}))

vi.mock('../../src/config/chat-history.js', () => ({
  readProviderChatHistory: mocks.readProviderChatHistory,
}))

import { handleReadChat } from '../../src/commands/chat-commands.js'

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
})
