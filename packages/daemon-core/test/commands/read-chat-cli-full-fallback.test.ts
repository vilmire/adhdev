import { describe, expect, it } from 'vitest'
import { handleReadChat } from '../../src/commands/chat-commands.js'

function createHelpers(adapter: any) {
  return {
    getCdp: () => null,
    getProvider: () => ({ type: 'hermes-cli', category: 'cli' }),
    getProviderScript: () => null,
    evaluateProviderScript: async () => null,
    getCliAdapter: () => adapter,
    currentManagerKey: undefined,
    currentIdeType: undefined,
    currentProviderType: undefined,
    currentSession: undefined,
    agentStream: null,
    ctx: {},
    historyWriter: { appendNewMessages: () => {} },
  }
}

describe('handleReadChat CLI parser authority', () => {
  it('fails closed when script parsing is unavailable instead of falling back to adapter status messages', async () => {
    const adapter = {
      cliType: 'hermes-cli',
      cliName: 'Hermes Agent',
      workingDir: '/tmp/project',
      getStatus: () => ({
        status: 'idle',
        messages: [{ role: 'assistant', content: 'stale transcript' }],
        activeModal: null,
      }),
      getScriptParsedStatus: () => null,
      getPartialResponse: () => '',
      isProcessing: () => false,
      isReady: () => true,
    }

    const result = await handleReadChat(createHelpers(adapter) as any, { agentType: 'hermes-cli' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('parser did not return messages')
  })

  it('surfaces parser crashes instead of masking them behind adapter status fallback', async () => {
    const adapter = {
      cliType: 'hermes-cli',
      cliName: 'Hermes Agent',
      workingDir: '/tmp/project',
      getStatus: () => ({
        status: 'idle',
        messages: [{ role: 'assistant', content: 'stale transcript' }],
        activeModal: null,
      }),
      getScriptParsedStatus: () => {
        throw new Error('parse exploded')
      },
      getPartialResponse: () => '',
      isProcessing: () => false,
      isReady: () => true,
    }

    const result = await handleReadChat(createHelpers(adapter) as any, { agentType: 'hermes-cli' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('parse exploded')
  })

  it('uses parser-provided transcript rows after visibility filtering and applies tailLimit to visible chat', async () => {
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
      getStatus: () => ({ status: 'idle', messages: [], activeModal: null }),
      getScriptParsedStatus: () => ({ status: 'idle', messages: allMessages, activeModal: null }),
      getPartialResponse: () => '',
      isProcessing: () => false,
      isReady: () => true,
    }

    const result = await handleReadChat(createHelpers(adapter) as any, { agentType: 'hermes-cli', tailLimit: 50 })

    expect(result.success).toBe(true)
    expect(result.totalMessages).toBe(2)
    expect(result.messages).toHaveLength(2)
    expect((result.messages as any[]).map(message => message.content)).toEqual(['고쳐줘', '수정 완료 요약'])
    expect((result as any).debugReadChat).toEqual(expect.objectContaining({
      fullMsgCount: 62,
      visibleMsgCount: 2,
      hiddenMsgCount: 60,
      returnedMsgCount: 2,
    }))
  })
})
