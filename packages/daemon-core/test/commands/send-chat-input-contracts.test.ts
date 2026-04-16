import { describe, expect, it, vi } from 'vitest'
import { handleSendChat } from '../../src/commands/chat-commands.js'

describe('handleSendChat input contracts', () => {
  it('rejects non-text input for PTY transports instead of flattening it', async () => {
    const sendMessage = vi.fn()
    const result = await handleSendChat({
      getCdp: () => null,
      getProvider: () => ({ type: 'hermes-cli', name: 'Hermes CLI', category: 'cli' }),
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      getCliAdapter: () => ({ cliType: 'hermes-cli', sendMessage }) as any,
      currentManagerKey: undefined,
      currentIdeType: undefined,
      currentProviderType: undefined,
      currentSession: undefined,
      agentStream: null,
      ctx: { instanceManager: { getInstance: () => null } },
      historyWriter: { appendNewMessages: () => {} },
    } as any, {
      agentType: 'hermes-cli',
      input: {
        parts: [
          { type: 'text', text: 'describe this image' },
          { type: 'image', mimeType: 'image/png', data: 'img-base64' },
        ],
      },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('only supports text input')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('routes structured ACP input to the provider instance instead of collapsing it to plain text', async () => {
    const onEvent = vi.fn()
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
})
