import { describe, expect, it, vi } from 'vitest'
import { handleReadChat } from '../../src/commands/chat-commands.js'

function createCliReadChatHarness(messages: Array<Record<string, any>>) {
  const getScriptParsedStatus = vi.fn(() => ({
    status: 'generating',
    messages,
    activeModal: null,
    title: 'Hermes Agent',
  }))
  const adapter = {
    cliType: 'hermes-cli',
    cliName: 'Hermes Agent',
    workingDir: '/tmp/project',
    spawn: async () => {},
    sendMessage: async () => {},
    getStatus: () => ({ status: 'generating', messages: [], activeModal: null }),
    getScriptParsedStatus,
    getPartialResponse: () => '',
    shutdown: () => {},
    cancel: () => {},
    isProcessing: () => true,
    isReady: () => true,
    setOnStatusChange: () => {},
  }
  const helpers = {
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
  }
  return { helpers, getScriptParsedStatus }
}

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

  it('includes CLI provider runtime system messages in read_chat results', async () => {
    const getScriptParsedStatus = vi.fn(() => ({
      status: 'idle',
      messages: [
        { role: 'user', content: 'run tests' },
        { role: 'assistant', content: 'Done' },
      ],
      activeModal: null,
      title: 'Claude Code',
    }))
    const adapter = {
      cliType: 'claude-cli',
      cliName: 'Claude Code',
      workingDir: '/tmp/project',
      spawn: async () => {},
      sendMessage: async () => {},
      getStatus: () => ({ status: 'idle', messages: [], activeModal: null }),
      getScriptParsedStatus,
      getPartialResponse: () => '',
      shutdown: () => {},
      cancel: () => {},
      isProcessing: () => false,
      isReady: () => true,
      setOnStatusChange: () => {},
    }
    const mergeRuntimeChatMessages = vi.fn((messages: any[]) => [
      ...messages,
      {
        role: 'system',
        kind: 'system',
        senderName: 'System',
        content: 'Auto-approved: Yes',
        receivedAt: 1_778_042_463_224,
        timestamp: 1_778_042_463_224,
      },
    ])
    const instance = {
      type: 'claude-cli',
      category: 'cli',
      mergeRuntimeChatMessages,
    }

    const result = await handleReadChat({
      getCdp: () => null,
      getProvider: () => ({ type: 'claude-cli', category: 'cli' }),
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      getCliAdapter: () => adapter as any,
      currentManagerKey: undefined,
      currentIdeType: undefined,
      currentProviderType: undefined,
      currentSession: undefined,
      agentStream: null,
      ctx: {
        sessionRegistry: { get: () => ({ adapterKey: 'sess-1', instanceKey: 'sess-1' }) },
        instanceManager: { getInstance: () => instance },
      },
      historyWriter: { appendNewMessages: () => {} },
    } as any, { targetSessionId: 'sess-1', agentType: 'claude-cli' })

    expect(result.success).toBe(true)
    expect(mergeRuntimeChatMessages).toHaveBeenCalledWith([
      { role: 'user', content: 'run tests' },
      { role: 'assistant', content: 'Done' },
    ])
    expect(result.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'run tests' }),
      expect.objectContaining({ role: 'assistant', content: 'Done' }),
      expect.objectContaining({ role: 'system', kind: 'system', senderName: 'System', content: 'Auto-approved: Yes' }),
    ])
    expect((result as any).debugReadChat?.parsedMsgCount).toBe(2)
    expect((result as any).debugReadChat?.returnedMsgCount).toBe(3)
  })

  it('does not replace a provider-authoritative parsed transcript with longer adapter history', async () => {
    const getScriptParsedStatus = vi.fn(() => ({
      status: 'generating',
      messages: [
        { role: 'user', content: 'current prompt', providerUnitKey: 'provider:user:current' },
        { role: 'assistant', content: 'canonical current answer', providerUnitKey: 'provider:assistant:current' },
      ],
      activeModal: null,
      title: 'Hermes Agent',
      transcriptAuthority: 'provider',
      coverage: 'full',
    }))

    const adapter = {
      cliType: 'hermes-cli',
      cliName: 'Hermes Agent',
      workingDir: '/tmp/project',
      spawn: async () => {},
      sendMessage: async () => {},
      getStatus: () => ({
        status: 'generating',
        messages: [
          { role: 'user', content: 'stale prompt' },
          { role: 'assistant', content: 'stale answer' },
          { role: 'assistant', content: 'stale duplicate that used to win by count' },
        ],
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

    expect(result.success).toBe(true)
    expect(result.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'current prompt', providerUnitKey: 'provider:user:current' }),
      expect.objectContaining({ role: 'assistant', content: 'canonical current answer', providerUnitKey: 'provider:assistant:current' }),
    ])
    expect((result as any).debugReadChat?.shouldPreferAdapterMessages).toBe(false)
    expect((result as any).transcriptAuthority).toBe('provider')
    expect((result as any).coverage).toBe('full')
  })

  it('treats parsed CLI transcript as the only chat-body authority even when adapter status has more messages', async () => {
    const adapter = {
      cliType: 'hermes-cli',
      cliName: 'Hermes Agent',
      workingDir: '/tmp/project',
      spawn: async () => {},
      sendMessage: async () => {},
      getStatus: () => ({
        status: 'generating',
        messages: [
          { role: 'user', content: 'stale prompt' },
          { role: 'assistant', content: 'stale answer' },
          { role: 'assistant', content: 'stale duplicated tail' },
        ],
        activeModal: null,
      }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        messages: [
          { role: 'user', content: 'parser prompt' },
          { role: 'assistant', content: 'parser answer' },
        ],
        activeModal: null,
        title: 'Hermes Agent',
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

    expect(result.success).toBe(true)
    expect(result.status).toBe('idle')
    expect(result.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'parser prompt' }),
      expect.objectContaining({ role: 'assistant', content: 'parser answer' }),
    ])
    expect((result as any).debugReadChat?.shouldPreferAdapterMessages).toBe(false)
  })

  it('maps internal startup CLI status to a read_chat-compatible status so restored history can hydrate immediately', async () => {
    const adapter = {
      cliType: 'hermes-cli',
      cliName: 'Hermes Agent',
      workingDir: '/tmp/project',
      spawn: async () => {},
      sendMessage: async () => {},
      getStatus: () => ({
        status: 'starting',
        messages: [
          { role: 'user', content: 'earlier prompt' },
          { role: 'assistant', content: 'earlier answer' },
        ],
        activeModal: null,
      }),
      getScriptParsedStatus: () => ({
        status: 'starting',
        messages: [
          { role: 'user', content: 'earlier prompt' },
          { role: 'assistant', content: 'earlier answer' },
        ],
        activeModal: null,
        title: 'Hermes Agent',
      }),
      getPartialResponse: () => '',
      shutdown: () => {},
      cancel: () => {},
      isProcessing: () => false,
      isReady: () => false,
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
    expect(result.status).toBe('generating')
    expect(result.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'earlier prompt' }),
      expect.objectContaining({ role: 'assistant', content: 'earlier answer' }),
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

  it('uses parsed waiting_approval status when the parsed transcript has approval buttons even if adapter status is still generating', async () => {
    const adapter = {
      cliType: 'hermes-cli',
      cliName: 'Hermes Agent',
      workingDir: '/tmp/project',
      spawn: async () => {},
      sendMessage: async () => {},
      getStatus: () => ({
        status: 'generating',
        messages: [{ role: 'user', content: 'delete it' }],
        activeModal: null,
      }),
      getScriptParsedStatus: () => ({
        status: 'waiting_approval',
        messages: [
          { role: 'user', content: 'delete it' },
          { role: 'assistant', kind: 'terminal', content: '$ rm /tmp/file' },
          { role: 'assistant', content: 'I need approval before deleting /tmp/file.' },
        ],
        activeModal: {
          message: 'Deleting /tmp/file requires approval. Approve the delete?',
          buttons: ['Approve delete', 'Do not delete', 'Other (type your answer)'],
        },
        title: 'Hermes Agent',
      }),
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

    expect(result.success).toBe(true)
    expect(result.status).toBe('waiting_approval')
    expect(result.activeModal).toEqual({
      message: 'Deleting /tmp/file requires approval. Approve the delete?',
      buttons: ['Approve delete', 'Do not delete', 'Other (type your answer)'],
    })
  })

  it('returns parser-provided duplicate rows without replay collapse or daemon dedupe', async () => {
    const messages = [
      { role: 'user', content: 'debug this bubble' },
      { role: 'assistant', content: 'I found the issue.' },
      { role: 'assistant', content: 'I found the issue.' },
      { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'read chat-commands.ts' },
      { role: 'assistant', content: 'I found the issue.' },
    ]
    const { helpers } = createCliReadChatHarness(messages)

    const result = await handleReadChat(helpers as any, { agentType: 'hermes-cli' })

    expect(result.success).toBe(true)
    expect(result.totalMessages).toBe(5)
    expect(result.messages).toEqual(messages.map(message => expect.objectContaining(message)))
  })

  it('applies tailLimit as a plain transport window without injecting hidden conversation anchors', async () => {
    const messages = [
      { role: 'user', content: '고쳐줘', kind: 'standard', timestamp: 1 },
      { role: 'assistant', content: '수정 완료 요약', kind: 'standard', timestamp: 2 },
      ...Array.from({ length: 60 }, (_, index) => ({
        role: 'assistant',
        content: `activity-${index}`,
        kind: index % 2 === 0 ? 'tool' : 'terminal',
        timestamp: 3 + index,
      })),
    ]
    const { helpers } = createCliReadChatHarness(messages)

    const result = await handleReadChat(helpers as any, { agentType: 'hermes-cli', tailLimit: 50 })

    expect(result.success).toBe(true)
    expect(result.totalMessages).toBe(62)
    const returnedMessages = result.messages as any[]
    expect(returnedMessages).toHaveLength(50)
    expect(returnedMessages.map(message => message.content)).toEqual(
      messages.slice(-50).map(message => message.content),
    )
  })


  it('ignores truncated tail cursor anchors and returns the bounded parser tail as a full refresh', async () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
      id: `msg-${index + 1}`,
      timestamp: index + 1,
    }))
    const { helpers } = createCliReadChatHarness(messages)
    const result = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      tailLimit: 4,
    })

    expect(result.success).toBe(true)
    expect(result).not.toHaveProperty('syncMode')
    expect(result).not.toHaveProperty('replaceFrom')
    expect(result).not.toHaveProperty('lastMessageSignature')
    expect(result.totalMessages).toBe(100)
    expect(result.messages).toEqual([
      expect.objectContaining({ id: 'msg-97', content: 'message-97' }),
      expect.objectContaining({ id: 'msg-98', content: 'message-98' }),
      expect.objectContaining({ id: 'msg-99', content: 'message-99' }),
      expect.objectContaining({ id: 'msg-100', content: 'message-100' }),
    ])
  })

  it('hydrates a bounded tail when the cursor only knows the last preview message', async () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
      id: `msg-${index + 1}`,
      timestamp: index + 1,
    }))
    const { helpers } = createCliReadChatHarness(messages)
    const result = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      tailLimit: 60,
    })

    expect(result.success).toBe(true)
    expect(result).not.toHaveProperty('syncMode')
    expect(result).not.toHaveProperty('replaceFrom')
    expect(result).not.toHaveProperty('lastMessageSignature')
    expect(result.totalMessages).toBe(100)
    const resultMessages = result.messages as any[]
    expect(resultMessages).toHaveLength(60)
    expect(resultMessages[0]).toEqual(expect.objectContaining({ id: 'msg-41', content: 'message-41' }))
    expect(resultMessages[resultMessages.length - 1]).toEqual(expect.objectContaining({ id: 'msg-100', content: 'message-100' }))
  })

  it('returns a bounded full parser tail instead of appending after a matching truncated cursor signature', async () => {
    const messages = Array.from({ length: 101 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
      id: `msg-${index + 1}`,
      timestamp: index + 1,
    }))
    const { helpers } = createCliReadChatHarness(messages)
    const result = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      tailLimit: 4,
    })

    expect(result.success).toBe(true)
    expect(result).not.toHaveProperty('syncMode')
    expect(result).not.toHaveProperty('replaceFrom')
    expect(result).not.toHaveProperty('lastMessageSignature')
    expect(result.totalMessages).toBe(101)
    expect(result.messages).toEqual([
      expect.objectContaining({ id: 'msg-98', content: 'message-98' }),
      expect.objectContaining({ id: 'msg-99', content: 'message-99' }),
      expect.objectContaining({ id: 'msg-100', content: 'message-100' }),
      expect.objectContaining({ id: 'msg-101', content: 'message-101' }),
    ])
  })

  it('returns a bounded full tail when a truncated tail cursor signature no longer anchors', async () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
      id: `msg-${index + 1}`,
      timestamp: index + 1,
    }))
    const { helpers } = createCliReadChatHarness(messages)

    const result = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      tailLimit: 4,
    })

    expect(result.success).toBe(true)
    expect(result).not.toHaveProperty('syncMode')
    expect(result).not.toHaveProperty('replaceFrom')
    expect(result).not.toHaveProperty('lastMessageSignature')
    expect(result.totalMessages).toBe(100)
    expect(result.messages).toEqual([
      expect.objectContaining({ id: 'msg-97', content: 'message-97' }),
      expect.objectContaining({ id: 'msg-98', content: 'message-98' }),
      expect.objectContaining({ id: 'msg-99', content: 'message-99' }),
      expect.objectContaining({ id: 'msg-100', content: 'message-100' }),
    ])
  })

  it('does not collapse repeated activity rows before applying tail sync', async () => {
    const messages = [
      { role: 'user', content: 'debug this bubble' },
      { role: 'assistant', kind: 'tool', senderName: 'Plan', content: 'plan 3 task(s)' },
      { role: 'assistant', kind: 'tool', senderName: 'Plan', content: 'plan 3 task(s)' },
      { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'snapshot compact' },
      { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'snapshot compact' },
      { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'grep 20260417_102240_975e9c|launch_cli|resumeSessionId|hermes-cli' },
      { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'grep 20260417_102240_975e9c|launch_cli|resumeSessionId|hermes-cli' },
    ]
    const { helpers } = createCliReadChatHarness(messages)

    const result = await handleReadChat(helpers as any, { agentType: 'hermes-cli', tailLimit: 4 })

    expect(result.success).toBe(true)
    expect(result.totalMessages).toBe(7)
    expect(result.messages).toEqual(messages.slice(-4).map(message => expect.objectContaining(message)))
  })
})
