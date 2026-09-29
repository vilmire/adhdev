import { describe, expect, it, vi } from 'vitest'
import { handleSendChat } from '../../src/commands/chat-commands.js'

describe('handleSendChat input contracts', () => {
  it('builds declared structured PTY input into ONE image body (materialized path + text, bracketed paste) — D2', async () => {
    const sendMessage = vi.fn(async () => ({ status: 'delivered' as const }))
    const recordAcknowledgedUserInput = vi.fn()
    const adapter = { cliType: 'hermes-cli', sendMessage, getStatus: () => ({ status: 'idle' }) }
    const result = await handleSendChat({
      getCdp: () => null,
      getProvider: () => ({
        type: 'hermes-cli',
        name: 'Hermes CLI',
        category: 'cli',
        capabilities: {
          input: {
            multipart: true,
            mediaTypes: ['text', 'image'],
            strategies: [{ mediaType: 'image', strategies: ['resource_link', 'text_fallback'], native: false }],
          },
        },
      }),
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      getCliAdapter: () => adapter as any,
      currentManagerKey: undefined,
      currentIdeType: undefined,
      currentProviderType: undefined,
      currentSession: { sessionId: 'sess-cli-1', transport: 'pty', providerType: 'hermes-cli' },
      agentStream: null,
      ctx: {
        adapters: new Map([['adapter-1', adapter]]),
        sessionRegistry: { get: () => ({ sessionId: 'sess-cli-1', adapterKey: 'adapter-1' }) },
        instanceManager: { getInstance: (key: string) => (key === 'adapter-1' ? { category: 'cli', type: 'hermes-cli', recordAcknowledgedUserInput } : null) },
      },
      historyWriter: { appendNewMessages: () => {} },
    } as any, {
      agentType: 'hermes-cli',
      targetSessionId: 'sess-cli-1',
      messageId: 'msg_structured_1',
      policy: { mode: 'queue' },
      input: {
        parts: [
          { type: 'text', text: 'describe this image' },
          { type: 'image', mimeType: 'image/png', data: 'aW1n' },
        ],
        textFallback: 'describe this image',
      },
    })

    expect(result).toMatchObject({ success: true, sent: true, submitted: true, method: 'pty-adapter', targetAgent: 'hermes-cli', messageId: 'msg_structured_1' })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [body, opts] = sendMessage.mock.calls[0] as unknown as [string, { bracketedPaste?: boolean; messageId?: string }]
    expect(body).toMatch(/adhdev-input-media[\\/].+\.png\ndescribe this image$/)
    expect(opts).toEqual({ bracketedPaste: true, messageId: 'msg_structured_1' })
    // The ack is stamped once, with the message identity.
    expect(recordAcknowledgedUserInput).toHaveBeenCalledTimes(1)
    expect(recordAcknowledgedUserInput.mock.calls[0][1]).toBe('msg_structured_1')
  })

  it('rejects structured PTY input when the CLI provider did not declare media support', async () => {
    const sendMessage = vi.fn()
    const onEvent = vi.fn()
    const plainAdapter = { cliType: 'plain-cli', sendMessage }
    const result = await handleSendChat({
      getCdp: () => null,
      getProvider: () => ({ type: 'plain-cli', name: 'Plain CLI', category: 'cli' }),
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      getCliAdapter: () => plainAdapter as any,
      currentManagerKey: undefined,
      currentIdeType: undefined,
      currentProviderType: undefined,
      currentSession: { sessionId: 'sess-cli-2', transport: 'pty', providerType: 'plain-cli' },
      agentStream: null,
      ctx: {
        adapters: new Map([['adapter-2', plainAdapter]]),
        sessionRegistry: { get: () => ({ sessionId: 'sess-cli-2', adapterKey: 'adapter-2' }) },
        instanceManager: { getInstance: () => ({ category: 'cli', type: 'plain-cli', onEvent }) },
      },
      historyWriter: { appendNewMessages: () => {} },
    } as any, {
      agentType: 'plain-cli',
      targetSessionId: 'sess-cli-2',
      input: {
        parts: [
          { type: 'text', text: 'describe this image' },
          { type: 'image', mimeType: 'image/png', data: 'img-base64' },
        ],
      },
    })

    expect(result.success).toBe(false)
    expect(result.reason).toBe('unsupported_input')
    expect(result.error).toContain('does not support input type: image')
    expect(sendMessage).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()
  })

})
