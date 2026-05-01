import { beforeEach, describe, expect, it, vi } from 'vitest'

const readProviderChatHistoryMock = vi.fn()

vi.mock('../../src/config/chat-history.js', () => ({
  readProviderChatHistory: readProviderChatHistoryMock,
}))

describe('handleChatHistory', () => {
  beforeEach(() => {
    readProviderChatHistoryMock.mockReset()
  })

  it('excludes the live transcript tail when paging older CLI history', async () => {
    const { handleChatHistory } = await import('../../src/commands/chat-commands.js')

    readProviderChatHistoryMock.mockReturnValue({
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

    expect(readProviderChatHistoryMock).toHaveBeenCalledWith('hermes-cli', {
      canonicalHistory: undefined,
      historySessionId: 'history-1',
      workspace: undefined,
      offset: 0,
      limit: 30,
      excludeRecentCount: 50,
      historyBehavior: undefined,
    })
    expect(result).toMatchObject({
      success: true,
      messages: [{ role: 'user', content: 'older message' }],
      hasMore: true,
      agent: 'hermes-cli',
    })
  })

  it('honors the frontend live-tail exclude count instead of skipping the full adapter transcript', async () => {
    const { handleChatHistory } = await import('../../src/commands/chat-commands.js')

    readProviderChatHistoryMock.mockReturnValue({
      messages: [{ role: 'assistant', content: 'older than visible tail' }],
      hasMore: true,
    })

    const adapter = {
      getStatus: () => ({
        status: 'idle',
        messages: Array.from({ length: 5000 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `full-adapter-${index + 1}`,
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
      excludeRecentCount: 1000,
    })

    expect(readProviderChatHistoryMock).toHaveBeenCalledWith('hermes-cli', {
      canonicalHistory: undefined,
      historySessionId: 'history-1',
      workspace: undefined,
      offset: 0,
      limit: 30,
      excludeRecentCount: 1000,
      historyBehavior: undefined,
    })
    expect(result).toMatchObject({
      success: true,
      messages: [{ role: 'assistant', content: 'older than visible tail' }],
      hasMore: true,
      agent: 'hermes-cli',
    })
  })
})
