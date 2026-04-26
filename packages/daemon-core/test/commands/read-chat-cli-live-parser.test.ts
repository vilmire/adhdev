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

  it('collapses replayed standard assistant bubbles within a turn without hiding tool rows', async () => {
    const getScriptParsedStatus = vi.fn(() => ({
      status: 'generating',
      messages: [
        { role: 'user', content: 'debug this bubble' },
        { role: 'assistant', content: 'I found the issue.' },
        { role: 'assistant', content: 'I found the issue.' },
        { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'read chat-commands.ts' },
        { role: 'assistant', content: 'I found the issue.' },
        { role: 'user', content: 'new turn can repeat that text' },
        { role: 'assistant', content: 'I found the issue.' },
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
      getStatus: () => ({ status: 'generating', messages: [], activeModal: null }),
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
    expect(result.totalMessages).toBe(5)
    expect(result.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'debug this bubble' }),
      expect.objectContaining({ role: 'assistant', content: 'I found the issue.' }),
      expect.objectContaining({ role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'read chat-commands.ts' }),
      expect.objectContaining({ role: 'user', content: 'new turn can repeat that text' }),
      expect.objectContaining({ role: 'assistant', content: 'I found the issue.' }),
    ])
  })

  it('collapses assistant-only viewport replay after a stable final answer without dropping a new user turn', async () => {
    const finalAnswer = [
      'Created the tiny browser Snake game in this workspace:',
      '/tmp/adhdev-live-snake/index.html',
      '/tmp/adhdev-live-snake/src/snake.js',
      '/tmp/adhdev-live-snake/README.md',
      'Run it by opening index.html in a browser. Controls: Arrow keys or WASD. Score, restart, and game-over state are implemented.',
    ].join('\n')
    const replayedFinalAnswer = `${finalAnswer}\nVerified again.`
    const getScriptParsedStatus = vi.fn(() => ({
      status: 'idle',
      messages: [
        { role: 'user', content: 'create snake game' },
        { role: 'assistant', kind: 'terminal', senderName: 'Terminal', content: '$ pwd' },
        { role: 'assistant', content: finalAnswer },
        { role: 'assistant', kind: 'terminal', senderName: 'Terminal', content: '$ pwd && python3 verify.py' },
        { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'read README.md' },
        { role: 'assistant', content: replayedFinalAnswer },
        { role: 'user', content: 'now summarize in one line' },
        { role: 'assistant', content: 'Snake game created and verified.' },
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
      getStatus: () => ({ status: 'idle', messages: [], activeModal: null }),
      getScriptParsedStatus,
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
    expect(result.totalMessages).toBe(7)
    expect(result.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'create snake game' }),
      expect.objectContaining({ role: 'assistant', kind: 'terminal', senderName: 'Terminal', content: '$ pwd' }),
      expect.objectContaining({ role: 'assistant', content: finalAnswer }),
      expect.objectContaining({ role: 'assistant', kind: 'terminal', senderName: 'Terminal', content: '$ pwd && python3 verify.py' }),
      expect.objectContaining({ role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'read README.md' }),
      expect.objectContaining({ role: 'user', content: 'now summarize in one line' }),
      expect.objectContaining({ role: 'assistant', content: 'Snake game created and verified.' }),
    ])
  })

  it('collapses replayed adjacent tool and terminal updates before applying tail sync', async () => {
    const getScriptParsedStatus = vi.fn(() => ({
      status: 'generating',
      messages: [
        { role: 'user', content: 'debug this bubble' },
        { role: 'assistant', kind: 'tool', senderName: 'Plan', content: 'plan 3 task(s)' },
        { role: 'assistant', kind: 'tool', senderName: 'Plan', content: 'plan 3 task(s)' },
        { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'snapshot compact' },
        { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'snapshot compact' },
        { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'grep 20260417_102240_975e9c|launch_cli|resumeSessionId|hermes-cli' },
        { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'grep 20260417_102240_975e9c|launch_cli|resumeSessionId|hermes-cli' },
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
      getStatus: () => ({ status: 'generating', messages: [], activeModal: null }),
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
    } as any, { agentType: 'hermes-cli', tailLimit: 4 })

    expect(result.success).toBe(true)
    expect(result.totalMessages).toBe(4)
    expect(result.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'debug this bubble' }),
      expect.objectContaining({ role: 'assistant', kind: 'tool', senderName: 'Plan', content: 'plan 3 task(s)' }),
      expect.objectContaining({ role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'snapshot compact' }),
      expect.objectContaining({ role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'grep 20260417_102240_975e9c|launch_cli|resumeSessionId|hermes-cli' }),
    ])
  })
})
