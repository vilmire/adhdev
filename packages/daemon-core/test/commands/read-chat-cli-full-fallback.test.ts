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

  it('keeps the latest conversational bubbles in a bounded CLI tail flooded by activity rows', async () => {
    const allMessages = [
      { role: 'user', content: '고쳐줘', kind: 'standard', timestamp: 1 },
      { role: 'assistant', content: '수정 완료 요약', kind: 'standard', timestamp: 2 },
      ...Array.from({ length: 60 }, (_, index) => ({
        role: 'assistant',
        content: `activity-${index}`,
        kind: index % 2 === 0 ? 'tool' : 'terminal',
        timestamp: 3 + index,
      })),
    ]

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
    } as any, { agentType: 'hermes-cli', tailLimit: 50 })

    expect(result.success).toBe(true)
    expect(result.totalMessages).toBe(62)
    const returnedMessages = result.messages as any[]
    expect(returnedMessages).toHaveLength(52)
    expect(returnedMessages.map((message: any) => message.content).slice(0, 2)).toEqual(['고쳐줘', '수정 완료 요약'])
    expect(returnedMessages.map((message: any) => message.content).slice(2)).toEqual(
      allMessages.slice(-50).map(message => message.content),
    )
  })
})
