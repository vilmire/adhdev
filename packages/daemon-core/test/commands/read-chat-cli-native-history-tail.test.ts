import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  readProviderChatHistory: vi.fn(),
}))

vi.mock('../../src/config/chat-history.js', () => ({
  readProviderChatHistory: mocks.readProviderChatHistory,
}))

import { handleReadChat, handleChatHistory } from '../../src/commands/chat-commands.js'

function createHelpers(overrides: Record<string, any> = {}) {
  const provider = overrides.provider || { type: 'hermes-cli', category: 'cli', historyBehavior: { transcriptAuthority: 'provider' } }
  return {
    getCdp: () => null,
    getProvider: () => provider,
    getProviderScript: () => null,
    evaluateProviderScript: async () => null,
    getCliAdapter: () => overrides.adapter || null,
    currentManagerKey: undefined,
    currentIdeType: undefined,
    currentProviderType: provider.type,
    currentSession: overrides.currentSession,
    agentStream: null,
    ctx: { instanceManager: { getInstance: () => null }, ...(overrides.ctx || {}) },
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

  it('keeps a generating Codex direct task readable when only the dispatched user turn is visible', async () => {
    const prompt = 'Diagnose why mesh_read_chat returned zero messages for this Codex task.'
    const adapter = {
      cliType: 'codex-cli',
      cliName: 'Codex CLI',
      workingDir: '/tmp/adhdev-codex-live',
      getScriptParsedStatus: vi.fn(() => ({
        status: 'idle',
        title: 'Codex CLI',
        messages: [{ role: 'user', kind: 'standard', content: prompt }],
      })),
      getStatus: vi.fn(() => ({ status: 'generating', messages: [] })),
      isProcessing: vi.fn(() => true),
    }

    const result = await handleReadChat(createHelpers({
      provider: { type: 'codex-cli', category: 'cli' },
      adapter,
      currentSession: {
        sessionId: 'codex-live-session',
        providerType: 'codex-cli',
        transport: 'pty',
        workspace: '/tmp/adhdev-codex-live',
      },
    }) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'codex-live-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.status).toBe('generating')
    expect(result.totalMessages).toBe(1)
    expect((result.messages as any[]).map((message: any) => [message.role, message.content])).toEqual([
      ['user', prompt],
    ])
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
