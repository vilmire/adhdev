import { describe, expect, it, vi } from 'vitest'
import { handleReadChat } from '../../src/commands/chat-commands.js'

describe('handleReadChat for CLI adapters', () => {
  it('prefers live script-parsed transcript output over committed-only adapter status', async () => {
    const getScriptParsedStatus = vi.fn(() => ({
      status: 'generating',
      messages: [
        { role: 'user', content: 'run pwd' },
        { role: 'assistant', kind: 'terminal', content: '$ pwd' },
        { role: 'assistant', content: 'Working on it' },
      ],
      activeModal: null,
      title: 'Hermes Agent',
    }))

    const adapter = {
      cliType: 'hermes-cli',
      cliName: 'Hermes Agent',
      workingDir: '/tmp/project',
      spawn: async () => {},
      sendMessage: async () => {},
      getStatus: () => ({
        status: 'generating',
        messages: [{ role: 'user', content: 'run pwd' }],
        activeModal: null,
      }),
      getScriptParsedStatus,
      getPartialResponse: () => '',
      shutdown: () => {},
      cancel: () => {},
      isProcessing: () => true,
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

    expect(getScriptParsedStatus).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.status).toBe('generating')
    expect(result.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'run pwd' }),
      expect.objectContaining({ role: 'assistant', kind: 'terminal', content: '$ pwd' }),
      expect.objectContaining({ role: 'assistant', content: 'Working on it' }),
    ])
  })

  it('fails closed when the parsed transcript violates the read_chat contract', async () => {
    const adapter = {
      cliType: 'hermes-cli',
      cliName: 'Hermes Agent',
      workingDir: '/tmp/project',
      spawn: async () => {},
      sendMessage: async () => {},
      getStatus: () => ({
        status: 'idle',
        messages: [],
        activeModal: null,
      }),
      getScriptParsedStatus: () => ({
        status: 'waiting_approval',
        messages: [],
        activeModal: null,
      }),
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
    expect(result.error).toContain('waiting_approval status requires activeModal with buttons')
  })
})
