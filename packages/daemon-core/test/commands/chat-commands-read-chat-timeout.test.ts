import { describe, expect, it, vi } from 'vitest'
import { handleReadChat, READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS } from '../../src/commands/chat-commands.js'

describe('handleReadChat provider evaluation timeout', () => {
  it('keeps provider read_chat evaluation below the cloud P2P command timeout', async () => {
    expect(READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS).toBe(25_000)
    expect(READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS).toBeLessThanOrEqual(30_000)

    const evaluateProviderScript = vi.fn(async () => ({
      result: JSON.stringify({
        status: 'idle',
        messages: [{ role: 'assistant', content: 'hello' }],
      }),
    }))

    const result = await handleReadChat({
      getCdp: () => null,
      getProvider: () => ({ type: 'claude-code', category: 'extension' }),
      getProviderScript: () => null,
      evaluateProviderScript,
      getCliAdapter: () => null,
      currentManagerKey: undefined,
      currentIdeType: undefined,
      currentProviderType: undefined,
      currentSession: undefined,
      agentStream: null,
      ctx: {},
      historyWriter: { appendNewMessages: () => {} },
    } as any, { agentType: 'claude-code' })

    expect(result.success).toBe(true)
    expect(evaluateProviderScript).toHaveBeenCalledWith('readChat', undefined, READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS)
  })
})
