import { describe, expect, it, vi } from 'vitest'
import { handleSendChat } from '../../src/commands/chat-commands.js'

describe('handleSendChat input contracts', () => {
  it('waits once for a freshly launched Hermes CLI runtime that is still starting before sending', async () => {
    vi.useFakeTimers()

    try {
      const sendMessage = vi.fn(async () => {})
      const hermesAdapter = { cliType: 'hermes-cli', sendMessage, getStatus: () => ({ status: 'starting' }) }
      const resultPromise = handleSendChat({
        getCdp: () => null,
        getProvider: () => ({ type: 'hermes-cli', name: 'Hermes CLI', category: 'cli' }),
        getProviderScript: () => null,
        evaluateProviderScript: async () => null,
        getCliAdapter: () => hermesAdapter as any,
        currentManagerKey: undefined,
        currentIdeType: undefined,
        currentProviderType: undefined,
        currentSession: undefined,
        agentStream: null,
        ctx: { adapters: new Map([['hermes-cli_1', hermesAdapter]]), instanceManager: { getInstance: () => null } },
        historyWriter: { appendNewMessages: () => {} },
      } as any, {
        agentType: 'hermes-cli',
        message: 'launch-race-message',
      })

      await Promise.resolve()
      expect(sendMessage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1999)
      expect(sendMessage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)

      await expect(resultPromise).resolves.toMatchObject({
        success: true,
        sent: true,
        method: 'pty-adapter',
        targetAgent: 'hermes-cli',
      })
      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage).toHaveBeenCalledWith('launch-race-message', expect.objectContaining({ messageId: expect.stringMatching(/^legacy:msg_/) }))
    } finally {
      vi.useRealTimers()
    }
  })

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

  it('routes structured ACP input to the provider instance instead of collapsing it to plain text', async () => {
    // Mirrors the real AcpProviderInstance.onEvent contract: it resolves with an
    // acknowledgement, and handleSendChat now checks it.
    const onEvent = vi.fn(async () => ({ success: true, status: 'delivered' }))
    const result = await handleSendChat({
      getCdp: () => null,
      getProvider: () => ({
        type: 'acp-test',
        name: 'ACP Test',
        category: 'acp',
        capabilities: {
          input: {
            multipart: true,
            mediaTypes: ['text', 'image'],
          },
        },
      }),
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      getCliAdapter: () => null,
      currentManagerKey: undefined,
      currentIdeType: undefined,
      currentProviderType: undefined,
      currentSession: { sessionId: 'sess-1', transport: 'acp', providerType: 'acp-test' },
      agentStream: null,
      ctx: { instanceManager: { getInstance: () => ({ category: 'acp', type: 'acp-test', onEvent }) } },
      historyWriter: { appendNewMessages: () => {} },
    } as any, {
      agentType: 'acp-test',
      targetSessionId: 'sess-1',
      input: {
        parts: [
          { type: 'text', text: 'inspect this' },
          { type: 'image', mimeType: 'image/png', data: 'img-base64' },
        ],
        textFallback: 'inspect this',
      },
    })

    expect(result).toMatchObject({ success: true, sent: true, method: 'acp-instance', targetAgent: 'acp-test' })
    expect(onEvent).toHaveBeenCalledWith('send_message', {
      input: {
        parts: [
          { type: 'text', text: 'inspect this' },
          { type: 'image', mimeType: 'image/png', data: 'img-base64' },
        ],
        textFallback: 'inspect this',
      },
    })
  })

  it('does not report an ACP send as successful when the instance refuses it', async () => {
    // SEND-RECORD-SYMMETRY: the instance refuses when it has no live session or a
    // prompt is already in flight. This was fire-and-forget, so the refusal was
    // invisible and the caller was told the turn had been sent.
    const onEvent = vi.fn(async () => ({ success: false, error: 'no active ACP connection/session' }))
    const result = await handleSendChat({
      getCdp: () => null,
      getProvider: () => ({
        type: 'acp-test',
        name: 'ACP Test',
        category: 'acp',
        capabilities: { input: { multipart: false, mediaTypes: ['text'] } },
      }),
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      getCliAdapter: () => null,
      currentManagerKey: undefined,
      currentIdeType: undefined,
      currentProviderType: undefined,
      currentSession: { sessionId: 'sess-refuse', transport: 'acp', providerType: 'acp-test' },
      agentStream: null,
      ctx: { instanceManager: { getInstance: () => ({ category: 'acp', type: 'acp-test', onEvent }) } },
      historyWriter: { appendNewMessages: () => {} },
    } as any, {
      agentType: 'acp-test',
      targetSessionId: 'sess-refuse',
      input: { parts: [{ type: 'text', text: 'hello' }], textFallback: 'hello' },
    })

    expect(result).toMatchObject({ success: false, sent: false })
    expect((result as any).error).toMatch(/connection|session/i)
  })
})
