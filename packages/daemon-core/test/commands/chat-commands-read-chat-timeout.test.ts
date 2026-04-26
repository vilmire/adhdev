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

  it('surfaces invalid extension read_chat payloads instead of returning an empty successful transcript', async () => {
    const result = await handleReadChat({
      getCdp: () => null,
      getProvider: () => ({ type: 'claude-code', category: 'extension' }),
      getProviderScript: () => null,
      evaluateProviderScript: vi.fn(async () => ({ result: 'not-json' })),
      getCliAdapter: () => null,
      currentManagerKey: undefined,
      currentIdeType: undefined,
      currentProviderType: undefined,
      currentSession: undefined,
      agentStream: null,
      ctx: {},
      historyWriter: { appendNewMessages: () => {} },
    } as any, { agentType: 'claude-code' })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/extension read_chat/i)
  })

  it('surfaces invalid webview read_chat payloads instead of returning an empty successful transcript', async () => {
    const result = await handleReadChat({
      getCdp: () => ({
        isConnected: true,
        evaluateInWebviewFrame: vi.fn(async () => 'not-json'),
      }),
      getProvider: () => ({ type: 'kiro', category: 'ide', webviewMatchText: 'Kiro' }),
      getProviderScript: (name: string) => name === 'webviewReadChat' ? 'read-chat-script' : null,
      evaluateProviderScript: vi.fn(),
      getCliAdapter: () => null,
      currentManagerKey: 'kiro',
      currentIdeType: 'kiro',
      currentProviderType: 'kiro',
      currentSession: undefined,
      agentStream: null,
      ctx: {},
      historyWriter: { appendNewMessages: () => {} },
    } as any, { agentType: 'kiro' })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/webview read_chat/i)
  })

  it('surfaces invalid IDE read_chat payloads instead of returning an empty successful transcript', async () => {
    const result = await handleReadChat({
      getCdp: () => ({ isConnected: true }),
      getProvider: () => ({ type: 'cursor', category: 'ide' }),
      getProviderScript: (name: string) => name === 'readChat' ? 'read-chat-script' : null,
      evaluateProviderScript: vi.fn(async () => ({ result: 'not-json' })),
      getCliAdapter: () => null,
      currentManagerKey: 'cursor',
      currentIdeType: 'cursor',
      currentProviderType: 'cursor',
      currentSession: undefined,
      agentStream: null,
      ctx: {},
      historyWriter: { appendNewMessages: () => {} },
    } as any, { agentType: 'cursor' })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/ide read_chat/i)
  })

  it('surfaces unavailable read_chat support instead of returning an empty successful transcript', async () => {
    const result = await handleReadChat({
      getCdp: () => ({ isConnected: true }),
      getProvider: () => ({ type: 'cursor', category: 'ide' }),
      getProviderScript: () => null,
      evaluateProviderScript: vi.fn(),
      getCliAdapter: () => null,
      currentManagerKey: 'cursor',
      currentIdeType: 'cursor',
      currentProviderType: 'cursor',
      currentSession: undefined,
      agentStream: null,
      ctx: {},
      historyWriter: { appendNewMessages: () => {} },
    } as any, { agentType: 'cursor' })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/read_chat unavailable/i)
  })
})
