import { describe, expect, it, vi } from 'vitest'
import { buildChatMessageSignature } from '../../src/chat/chat-signatures.js'
import { collapseReplayDuplicatesFromReadChat, handleReadChat } from '../../src/commands/chat-commands.js'

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

  it('keeps the full adjacent assistant answer when a terminal replay first exposes a prefix', () => {
    const prefixAnswer = [
      '내 생각은 이래.',
      '',
      '1. MCP 서버는 방향이 좋음',
      'ADHDev를 “대시보드 앱”에서 “다른 에이전트/툴이 호출할 수 있는 agent-control substrate”로 확장하는 가장 자연스러운 표면이야.',
      '',
      '지금 구조도 나쁘지 않음:',
      '- oss/packages/mcp-server 가 stdio MCP server',
      '- local mode는 standalone daemon HTTP API',
    ].join('\n')
    const fullAnswer = `${prefixAnswer}\n- cloud mode는 Cloud REST shortcuts API + adk_* API key\n\n${'추가 설명 '.repeat(80)}`

    const collapsed = collapseReplayDuplicatesFromReadChat([
      { role: 'user', content: '지금 mcp 서버하고 데몬p2p 메시에 대해서 어떻게 생각해?' },
      { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'read docs/ARCHITECTURE.md' },
      { role: 'assistant', content: prefixAnswer, id: 'hermes_prefix' },
      { role: 'assistant', content: fullAnswer, id: 'hermes_full' },
    ] as any)

    expect(collapsed).toHaveLength(3)
    expect(collapsed[2]).toEqual(expect.objectContaining({ id: 'hermes_full', content: fullAnswer }))
    expect(collapsed.map((message: any) => message.id)).not.toContain('hermes_prefix')
  })

  it('does not move a fuller assistant answer across intervening replay rows', () => {
    const prefixAnswer = `${'prefix answer '.repeat(20)}끝`
    const fullAnswer = `${prefixAnswer}\n${'full answer continuation '.repeat(20)}`

    const collapsed = collapseReplayDuplicatesFromReadChat([
      { role: 'user', content: 'debug ordering' },
      { role: 'assistant', content: prefixAnswer, id: 'hermes_prefix' },
      { role: 'system', content: 'status update', id: 'system_intervening' },
      { role: 'assistant', content: fullAnswer, id: 'hermes_full' },
    ] as any)

    expect(collapsed.map((message: any) => message.id)).toEqual([
      undefined,
      'hermes_prefix',
      'system_intervening',
    ])
  })

  it('normalizes each large read_chat replay message only once while collapsing duplicates', () => {
    const contentAccesses = { count: 0 }
    const repeatedAnswer = 'final answer '.repeat(20_000)
    const messages: any[] = [{ role: 'user', content: 'debug hot path' }]

    for (let index = 0; index < 12; index += 1) {
      const message: any = { role: 'assistant', kind: 'standard', senderName: 'Hermes' }
      Object.defineProperty(message, 'content', {
        enumerable: true,
        get() {
          contentAccesses.count += 1
          return repeatedAnswer
        },
      })
      messages.push(message)
    }

    const collapsed = collapseReplayDuplicatesFromReadChat(messages)

    expect(collapsed).toHaveLength(2)
    expect(contentAccesses.count).toBe(12)
  })

  it('treats a truncated tail cursor as current when its last signature matches the full transcript last message', async () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
      id: `msg-${index + 1}`,
      timestamp: index + 1,
    }))
    const { helpers } = createCliReadChatHarness(messages)
    const lastMessageSignature = buildChatMessageSignature(messages[messages.length - 1] as any)

    const result = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      knownMessageCount: 4,
      lastMessageSignature,
      tailLimit: 4,
    })

    expect(result.success).toBe(true)
    expect(result.syncMode).toBe('noop')
    expect(result.totalMessages).toBe(100)
    expect(result.messages).toEqual([])
    expect(result.lastMessageSignature).toBe(lastMessageSignature)
  })

  it('hydrates a bounded tail when the cursor only knows the last preview message', async () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
      id: `msg-${index + 1}`,
      timestamp: index + 1,
    }))
    const { helpers } = createCliReadChatHarness(messages)
    const lastMessageSignature = buildChatMessageSignature(messages[messages.length - 1] as any)

    const result = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      knownMessageCount: 1,
      lastMessageSignature,
      tailLimit: 60,
    })

    expect(result.success).toBe(true)
    expect(result.syncMode).toBe('full')
    expect(result.replaceFrom).toBe(0)
    expect(result.totalMessages).toBe(100)
    const resultMessages = result.messages as any[]
    expect(resultMessages).toHaveLength(60)
    expect(resultMessages[0]).toEqual(expect.objectContaining({ id: 'msg-41', content: 'message-41' }))
    expect(resultMessages[resultMessages.length - 1]).toEqual(expect.objectContaining({ id: 'msg-100', content: 'message-100' }))
    expect(result.lastMessageSignature).toBe(lastMessageSignature)
  })

  it('appends only messages after a matching truncated tail cursor signature', async () => {
    const messages = Array.from({ length: 101 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
      id: `msg-${index + 1}`,
      timestamp: index + 1,
    }))
    const { helpers } = createCliReadChatHarness(messages)
    const previousTailLastSignature = buildChatMessageSignature(messages[99] as any)
    const finalSignature = buildChatMessageSignature(messages[100] as any)

    const result = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      knownMessageCount: 4,
      lastMessageSignature: previousTailLastSignature,
      tailLimit: 4,
    })

    expect(result.success).toBe(true)
    expect(result.syncMode).toBe('append')
    expect(result.totalMessages).toBe(101)
    expect(result.messages).toEqual([
      expect.objectContaining({ id: 'msg-101', content: 'message-101' }),
    ])
    expect(result.lastMessageSignature).toBe(finalSignature)
  })

  it('falls back to a bounded full tail when a truncated tail cursor signature no longer anchors', async () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
      id: `msg-${index + 1}`,
      timestamp: index + 1,
    }))
    const { helpers } = createCliReadChatHarness(messages)

    const result = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      knownMessageCount: 4,
      lastMessageSignature: 'missing-stale-signature',
      tailLimit: 4,
    })

    expect(result.success).toBe(true)
    expect(result.syncMode).toBe('full')
    expect(result.replaceFrom).toBe(0)
    expect(result.totalMessages).toBe(100)
    expect(result.messages).toEqual([
      expect.objectContaining({ id: 'msg-97', content: 'message-97' }),
      expect.objectContaining({ id: 'msg-98', content: 'message-98' }),
      expect.objectContaining({ id: 'msg-99', content: 'message-99' }),
      expect.objectContaining({ id: 'msg-100', content: 'message-100' }),
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
