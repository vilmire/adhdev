import { describe, expect, it, vi } from 'vitest'
import { handleReadChat } from '../../src/commands/chat-commands.js'

describe('handleReadChat CLI fallback transcript retention', () => {
  it('keeps the full committed transcript when script parsing is unavailable', async () => {
    const allMessages = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
      timestamp: index + 1,
    }))

    const adapter = {
      cliType: 'hermes-cli',
      cliName: 'Hermes Agent',
      workingDir: '/tmp/project',
      spawn: async () => {},
      sendMessage: async () => {},
      getStatus: () => ({
        status: 'idle',
        messages: allMessages,
        activeModal: null,
      }),
      getScriptParsedStatus: () => null,
      getPartialResponse: () => '',
      shutdown: () => {},
      cancel: () => {},
      isProcessing: () => false,
      isReady: () => true,
      setOnStatusChange: () => {},
    }

    const result = await handleReadChat({
      getCdp: () => null,
      getProvider: () => ({ type: 'hermes-cli', category: 'cli' }),
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      getCliAdapter: () => adapter as any,
      currentManagerKey: undefined,
      currentIdeType: undefined,
      currentProviderType: undefined,
      currentSession: undefined,
      agentStream: null,
      ctx: {},
      historyWriter: { appendNewMessages: () => {} },
    } as any, { agentType: 'hermes-cli' })

    expect(result.success).toBe(true)
    expect(result.totalMessages).toBe(80)
    expect(result.messages).toHaveLength(80)
    expect(result.messages[0]).toEqual(expect.objectContaining({ content: 'message-1' }))
    expect(result.messages[79]).toEqual(expect.objectContaining({ content: 'message-80' }))
  })

  it('surfaces parseOutput crashes instead of masking them behind adapter status fallback', async () => {
    const adapter = {
      cliType: 'hermes-cli',
      cliName: 'Hermes Agent',
      workingDir: '/tmp/project',
      spawn: async () => {},
      sendMessage: async () => {},
      getStatus: () => ({
        status: 'idle',
        messages: [{ role: 'assistant', content: 'stale transcript' }],
        activeModal: null,
      }),
      getScriptParsedStatus: () => {
        throw new Error('parse exploded')
      },
      getPartialResponse: () => '',
      shutdown: () => {},
      cancel: () => {},
      isProcessing: () => false,
      isReady: () => true,
      setOnStatusChange: () => {},
    }

    const result = await handleReadChat({
      getCdp: () => null,
      getProvider: () => ({ type: 'hermes-cli', category: 'cli' }),
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      getCliAdapter: () => adapter as any,
      currentManagerKey: undefined,
      currentIdeType: undefined,
      currentProviderType: undefined,
      currentSession: undefined,
      agentStream: null,
      ctx: {},
      historyWriter: { appendNewMessages: () => {} },
    } as any, { agentType: 'hermes-cli' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('parse exploded')
  })
})
