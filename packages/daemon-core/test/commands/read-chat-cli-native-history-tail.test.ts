import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  readProviderChatHistory: vi.fn(),
}))

vi.mock('../../src/config/chat-history.js', () => ({
  readProviderChatHistory: mocks.readProviderChatHistory,
}))

import { handleReadChat, handleChatHistory } from '../../src/commands/chat-commands.js'

function createHelpers() {
  return {
    getCdp: () => null,
    getProvider: () => ({ type: 'hermes-cli', category: 'cli', historyBehavior: { transcriptAuthority: 'provider' } }),
    getProviderScript: () => null,
    evaluateProviderScript: async () => null,
    getCliAdapter: () => null,
    currentManagerKey: undefined,
    currentIdeType: undefined,
    currentProviderType: undefined,
    currentSession: undefined,
    agentStream: null,
    ctx: { instanceManager: { getInstance: () => null } },
    historyWriter: { appendNewMessages: () => {} },
  }
}

describe('CLI read_chat native history hydration', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
  })

  it('uses providerSessionId for inactive Hermes conversations when no live adapter exists', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        { role: 'user', content: 'saved 질문', receivedAt: 1 },
        { role: 'assistant', content: 'saved 답변', receivedAt: 2 },
      ],
      hasMore: true,
    })

    const result = await handleReadChat(createHelpers() as any, {
      agentType: 'hermes-cli',
      targetSessionId: 'runtime-session-that-is-not-live',
      providerSessionId: 'hermes-provider-session-42',
      tailLimit: 50,
    })

    expect(result.success).toBe(true)
    const messages = result.messages as any[]
    expect(messages).toHaveLength(2)
    expect(messages.map((message: any) => message.content)).toEqual(['saved 질문', 'saved 답변'])
    expect(result.totalMessages).toBe(2)
    expect(result.providerSessionId).toBe('hermes-provider-session-42')
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('hermes-cli', expect.objectContaining({
      historySessionId: 'hermes-provider-session-42',
      offset: 0,
      limit: 50,
    }))
  })

  it('uses providerSessionId for chat_history pagination too', async () => {
    mocks.readProviderChatHistory.mockReturnValue({ messages: [], hasMore: false })

    const result = await handleChatHistory(createHelpers() as any, {
      agentType: 'hermes-cli',
      targetSessionId: 'runtime-session-that-is-not-live',
      providerSessionId: 'hermes-provider-session-42',
      offset: 25,
      limit: 25,
    })

    expect(result.success).toBe(true)
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('hermes-cli', expect.objectContaining({
      historySessionId: 'hermes-provider-session-42',
      offset: 25,
      limit: 25,
    }))
  })
})
