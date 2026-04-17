import { describe, expect, it, vi } from 'vitest'

const readChatHistoryMock = vi.fn()

vi.mock('../../src/config/chat-history.js', () => ({
  readChatHistory: readChatHistoryMock,
}))

describe('handleChatHistory', () => {
  it('excludes the live transcript tail when paging older CLI history', async () => {
    const { handleChatHistory } = await import('../../src/commands/chat-commands.js')

    readChatHistoryMock.mockReturnValue({
      messages: [{ role: 'user', content: 'older message' }],
      hasMore: true,
    })

    const adapter = {
      getStatus: () => ({
        status: 'idle',
        messages: Array.from({ length: 50 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `live-${index + 1}`,
        })),
      }),
    }

    const result = await handleChatHistory({
      getProvider: () => ({ type: 'hermes-cli', category: 'cli' }),
      getCliAdapter: () => adapter as any,
      currentProviderType: undefined,
      currentSession: undefined,
    } as any, {
      agentType: 'hermes-cli',
      targetSessionId: 'session-1',
      historySessionId: 'history-1',
      offset: 0,
      limit: 30,
    })

    expect(readChatHistoryMock).toHaveBeenCalledWith('hermes-cli', 0, 30, 'history-1', 50)
    expect(result).toMatchObject({
      success: true,
      messages: [{ role: 'user', content: 'older message' }],
      hasMore: true,
      agent: 'hermes-cli',
    })
  })
})
