import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readProviderChatHistory: vi.fn(),
}))

vi.mock('../../src/config/chat-history.js', () => ({
  readProviderChatHistory: mocks.readProviderChatHistory,
  isNativeSourceCanonicalHistory: (canonicalHistory: any) => {
    if (!canonicalHistory) return false
    return canonicalHistory.mode !== 'disabled' && canonicalHistory.mode !== 'materialized-mirror'
  },
}))

describe('handleChatHistory', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
  })

  it('does not infer CLI history exclusion from adapter status messages', async () => {
    const { handleChatHistory } = await import('../../src/commands/chat-commands.js')

    mocks.readProviderChatHistory.mockReturnValue({
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

    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('hermes-cli', {
      canonicalHistory: undefined,
      historySessionId: 'history-1',
      workspace: undefined,
      offset: 0,
      limit: 30,
      excludeRecentCount: 0,
      historyBehavior: undefined,
      scripts: undefined,
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

    mocks.readProviderChatHistory.mockReturnValue({
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

    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('hermes-cli', {
      canonicalHistory: undefined,
      historySessionId: 'history-1',
      workspace: undefined,
      offset: 0,
      limit: 30,
      excludeRecentCount: 1000,
      historyBehavior: undefined,
      scripts: undefined,
    })
    expect(result).toMatchObject({
      success: true,
      messages: [{ role: 'assistant', content: 'older than visible tail' }],
      hasMore: true,
      agent: 'hermes-cli',
    })
  })

  it('falls back to the provider-authoritative parsed transcript length for CLI history exclusion', async () => {
    const { handleChatHistory } = await import('../../src/commands/chat-commands.js')

    mocks.readProviderChatHistory.mockReturnValue({
      messages: [{ role: 'assistant', content: 'older parsed history' }],
      hasMore: true,
    })
    const parsedMessages = Array.from({ length: 125 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `parsed-visible-${index + 1}`,
    }))
    const adapter = {
      getStatus: () => ({ status: 'idle', messages: [] }),
      getScriptParsedStatus: () => JSON.stringify({
        status: 'idle',
        coverage: 'full',
        transcriptAuthority: 'provider',
        messages: parsedMessages,
      }),
    }

    await handleChatHistory({
      getProvider: () => ({ type: 'hermes-cli', category: 'cli' }),
      getCliAdapter: () => adapter as any,
      currentProviderType: undefined,
      currentSession: undefined,
    } as any, {
      agentType: 'hermes-cli',
      targetSessionId: 'session-1',
      historySessionId: 'history-1',
    })

    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('hermes-cli', expect.objectContaining({
      excludeRecentCount: 125,
    }))
  })

  it('treats a malformed frontend exclude count as zero instead of poisoning pagination with NaN', async () => {
    const { handleChatHistory } = await import('../../src/commands/chat-commands.js')

    mocks.readProviderChatHistory.mockReturnValue({ messages: [], hasMore: false })

    await handleChatHistory({
      getProvider: () => ({ type: 'hermes-cli', category: 'cli' }),
      getCliAdapter: () => ({ getStatus: () => ({ status: 'idle', messages: [] }) }) as any,
      currentProviderType: undefined,
      currentSession: undefined,
    } as any, {
      agentType: 'hermes-cli',
      targetSessionId: 'session-1',
      historySessionId: 'history-1',
      excludeRecentCount: 'not-a-number',
    })

    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('hermes-cli', expect.objectContaining({
      excludeRecentCount: 0,
    }))
  })
})
