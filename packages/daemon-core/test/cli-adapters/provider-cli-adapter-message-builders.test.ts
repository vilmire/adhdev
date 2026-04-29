import { describe, expect, it, vi, afterEach } from 'vitest'
import { appendBoundedText, ProviderCliAdapter, sanitizeCliStandardMessageContent, trimLastAssistantEchoForCliMessages } from '../../src/cli-adapters/provider-cli-adapter.js'
import { buildCliParseInput, normalizeCliParsedMessages } from '../../src/cli-adapters/provider-cli-parse.js'
import { normalizeComparableMessageContent } from '../../src/cli-adapters/provider-cli-shared.js'
import { LOG } from '../../src/logging/logger.js'
import { resetDebugRuntimeConfig, resolveDebugRuntimeConfig, setDebugRuntimeConfig } from '../../src/logging/debug-config.js'

describe('ProviderCliAdapter message fallback shaping', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetDebugRuntimeConfig()
  })

  it('strips repeated activity prefix blocks from retained standard assistant content', () => {
    const pathPrefix = '📖 /Users/moltbot/.openclaw/workspace/projects/adhdev-providers/tests/codex-c\nl\ni-parser.test.js'
    const polluted = [
      pathPrefix,
      '점검 결과 요약:',
      pathPrefix,
      pathPrefix,
      '1. Parser regression 테스트',
      pathPrefix,
      '- 실행: node --test tests/codex-cli-parser.test.js',
      pathPrefix,
      '- 결과: pass 65, fail 0',
      pathPrefix,
      '결론: standard assistant bubble에는 파일 read activity prefix가 남으면 안 됩니다.',
    ].join('\n')

    const cleaned = sanitizeCliStandardMessageContent(polluted)

    expect(cleaned).toContain('점검 결과 요약:')
    expect(cleaned).toContain('1. Parser regression 테스트')
    expect(cleaned).toContain('결론: standard assistant bubble에는 파일 read activity prefix가 남으면 안 됩니다.')
    expect(cleaned).not.toContain('📖 /Users/moltbot')
  })

  it('normalizes wrapped assistant prose to the same comparable text as its reflowed form', () => {
    const wrapped = [
      'I created and executed tmp/adhdev_cli_verify.py, a small Python script that',
      'printed the current working directory, the square sequence 1,4,9,16,25, and a co',
      'mpact JSON representation of those same square values.',
    ].join('\n')
    const reflowed = 'I created and executed tmp/adhdev_cli_verify.py, a small Python script that printed the current working directory, the square sequence 1,4,9,16,25, and a compact JSON representation of those same square values.'

    expect(normalizeComparableMessageContent(wrapped)).toBe(normalizeComparableMessageContent(reflowed))
  })

  it('dedupes consecutive assistant messages when they only differ by wrap formatting', () => {
    const wrapped = [
      'I created and executed tmp/adhdev_cli_verify.py, a small Python script that',
      'printed the current working directory, the square sequence 1,4,9,16,25, and a co',
      'mpact JSON representation of those same square values.',
    ].join('\n')
    const reflowed = 'I created and executed tmp/adhdev_cli_verify.py, a small Python script that printed the current working directory, the square sequence 1,4,9,16,25, and a compact JSON representation of those same square values.'

    const normalized = normalizeCliParsedMessages([
      { role: 'user', content: 'follow-up prompt' },
      { role: 'assistant', content: wrapped },
      { role: 'assistant', content: reflowed },
    ], {
      committedMessages: [],
      scope: null,
      lastOutputAt: 123,
      now: 123,
    })

    expect(normalized).toHaveLength(2)
    expect(normalized[1]?.content).toBe(reflowed)
  })

  it('removes a prompt-echo assistant row when echo trimming empties the last standard bubble', () => {
    const messages: any[] = [
      { role: 'user', kind: 'standard', content: 'Run self-test and include MARKER' },
      { role: 'assistant', kind: 'terminal', senderName: 'Terminal', content: '$ python3 game.py --self-test\nMARKER' },
      { role: 'assistant', kind: 'standard', content: 'Run self-test and include MARKER' },
    ]

    trimLastAssistantEchoForCliMessages(messages, 'Run self-test and include MARKER')

    expect(messages).toEqual([
      { role: 'user', kind: 'standard', content: 'Run self-test and include MARKER' },
      { role: 'assistant', kind: 'terminal', senderName: 'Terminal', content: '$ python3 game.py --self-test\nMARKER' },
    ])
  })

  it('preserves provider-owned bubble identity when normalizing CLI parsed messages', () => {
    const normalized = normalizeCliParsedMessages([
      {
        role: 'user',
        content: 'hello',
        id: 'user-1',
        index: 0,
        providerUnitKey: 'hermes-cli:user:0:abc',
        bubbleId: 'bubble-user-1',
        bubbleState: 'final',
        _turnKey: 'turn-user-1',
      },
      {
        role: 'assistant',
        content: 'hi',
        id: 'assistant-1',
        index: 1,
        providerUnitKey: 'hermes-cli:assistant:1:def',
        bubbleId: 'bubble-assistant-1',
        bubbleState: 'streaming',
        _turnKey: 'turn-assistant-1',
      },
    ], {
      committedMessages: [],
      scope: null,
      lastOutputAt: 123,
      now: 123,
    }) as any[]

    expect(normalized[0]).toMatchObject({
      providerUnitKey: 'hermes-cli:user:0:abc',
      bubbleId: 'bubble-user-1',
      bubbleState: 'final',
      _turnKey: 'turn-user-1',
    })
    expect(normalized[1]).toMatchObject({
      providerUnitKey: 'hermes-cli:assistant:1:def',
      bubbleId: 'bubble-assistant-1',
      bubbleState: 'streaming',
      _turnKey: 'turn-assistant-1',
    })
  })

  it('uses full committed history as provider parse context when transcript ownership is provider-owned', () => {
    const adapter = new ProviderCliAdapter({
      type: 'provider-owned-cli',
      name: 'Provider Owned CLI',
      category: 'cli',
      binary: 'provider-owned-cli',
      transcriptAuthority: 'provider',
      transcriptContext: 'full',
      spawn: {
        command: 'provider-owned-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {},
    } as any, '/tmp/project', [])
    const messages = Array.from({ length: 125 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
    }))

    expect((adapter as any).selectParseBaseMessages(messages)).toHaveLength(125)
  })

  it('tails committed history by default for legacy provider parse context', () => {
    const adapter = new ProviderCliAdapter({
      type: 'legacy-cli',
      name: 'Legacy CLI',
      category: 'cli',
      binary: 'legacy-cli',
      spawn: {
        command: 'legacy-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {},
    } as any, '/tmp/project', [])
    const messages = Array.from({ length: 125 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
    }))

    const selected = (adapter as any).selectParseBaseMessages(messages)
    expect(selected).toHaveLength(100)
    expect(selected[0]?.content).toBe('message 25')
  })

  it('logs unresolved missing CLI scripts as info instead of warning noise', () => {
    const warnSpy = vi.spyOn(LOG, 'warn').mockImplementation(() => {})
    const infoSpy = vi.spyOn(LOG, 'info').mockImplementation(() => {})

    new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {},
    } as any, '/tmp/project')

    expect(warnSpy).not.toHaveBeenCalledWith('CLI', expect.stringContaining('No CLI scripts loaded'))
    expect(infoSpy).toHaveBeenCalledWith('CLI', expect.stringContaining('CLI scripts not yet resolved'))
  })

  it('keeps warning when a resolved provider still has no CLI scripts', () => {
    const warnSpy = vi.spyOn(LOG, 'warn').mockImplementation(() => {})

    new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {},
      _resolvedProviderDir: '/providers/test-cli',
      _resolvedScriptDir: '/providers/test-cli/scripts/1.0',
      _resolvedScriptsPath: '/providers/test-cli/scripts/1.0/scripts.js',
      _resolvedScriptsSource: 'upstream',
      _resolvedVersion: '1.0',
    } as any, '/tmp/project')

    expect(warnSpy).toHaveBeenCalledWith('CLI', expect.stringContaining('No CLI scripts loaded'))
  })

  it('refreshes committed message activity when the last assistant content is completed in place', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-27T12:00:01Z'))

    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
      },
    } as any, '/tmp/project')

    adapter.seedCommittedMessages([
      { role: 'assistant', content: 'partial assistant answer', timestamp: 100 },
    ])
    expect(adapter.getLastCommittedMessageActivityAt()).toBe(Date.parse('2026-04-27T12:00:01Z'))

    vi.setSystemTime(new Date('2026-04-27T12:00:04Z'))
    adapter.seedCommittedMessages([
      { role: 'assistant', content: 'partial assistant answer that is now complete', timestamp: 100 },
    ])

    expect(adapter.getLastCommittedMessageActivityAt()).toBe(Date.parse('2026-04-27T12:00:04Z'))
  })

  it('preserves the full committed transcript when parseOutput is unavailable', () => {
    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
      },
    } as any, '/tmp/project') as any

    adapter.committedMessages = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
      timestamp: index + 1,
      receivedAt: index + 1,
      id: `msg-${index + 1}`,
      index,
    }))
    adapter.currentStatus = 'idle'
    adapter.activeModal = null
    adapter.cliName = 'Test CLI'

    const status = adapter.getScriptParsedStatus()

    expect(status.messages).toHaveLength(80)
    expect(status.messages[0]).toMatchObject({
      content: 'message-1',
      id: 'msg-1',
      index: 0,
    })
    expect(status.messages[79]).toMatchObject({
      content: 'message-80',
      id: 'msg-80',
      index: 79,
    })
  })

  it('uses newly injected scripts immediately instead of returning a stale parsed-status cache', () => {
    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
        parseOutput: () => ({
          status: 'idle',
          messages: [{ role: 'assistant', content: 'old parser' }],
        }),
      },
    } as any, '/tmp/project') as any

    adapter.committedMessages = [{ role: 'assistant', content: 'transcript', timestamp: 1 }]
    expect(adapter.getScriptParsedStatus().messages[0].content).toBe('old parser')

    adapter.setCliScripts({
      detectStatus: () => 'idle',
      parseApproval: () => null,
      parseOutput: () => ({
        status: 'idle',
        messages: [{ role: 'assistant', content: 'new parser' }],
      }),
    })

    expect(adapter.getScriptParsedStatus().messages[0].content).toBe('new parser')
  })

  it('throws instead of silently falling back when parseOutput crashes', () => {
    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
        parseOutput: () => {
          throw new Error('parse exploded')
        },
      },
    } as any, '/tmp/project') as any

    adapter.committedMessages = [{ role: 'assistant', content: 'old', timestamp: 1 }]

    expect(() => adapter.getScriptParsedStatus()).toThrow('parse exploded')
  })

  it('reads the terminal screen only once per output flush', () => {
    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
      },
    } as any, '/tmp/project') as any

    const getText = vi.fn(() => 'screen snapshot')
    adapter.terminalScreen = {
      write: vi.fn(),
      getText,
    }
    adapter.scheduleSettle = vi.fn()
    adapter.resolveStartupState = vi.fn()

    adapter.handleOutput('hello world')

    expect(getText).toHaveBeenCalledTimes(1)
  })

  it('does not retain per-flush output trace entries outside dev trace mode', () => {
    setDebugRuntimeConfig(resolveDebugRuntimeConfig({ dev: false, trace: false }))

    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
      },
    } as any, '/tmp/project') as any

    adapter.terminalScreen = {
      write: vi.fn(),
      getText: vi.fn(() => 'screen snapshot'),
    }
    adapter.scheduleSettle = vi.fn()
    adapter.resolveStartupState = vi.fn()

    adapter.handleOutput('hello world')

    const outputEntry = adapter.getTraceState(10).entries.find((entry: any) => entry?.type === 'output')
    expect(outputEntry).toBeUndefined()
  })

  it('retains per-flush output trace entries in dev trace mode', () => {
    setDebugRuntimeConfig(resolveDebugRuntimeConfig({ dev: true }))

    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
      },
    } as any, '/tmp/project') as any

    adapter.terminalScreen = {
      write: vi.fn(),
      getText: vi.fn(() => 'screen snapshot'),
    }
    adapter.scheduleSettle = vi.fn()
    adapter.resolveStartupState = vi.fn()

    adapter.handleOutput('hello world')

    const outputEntry = adapter.getTraceState(10).entries.find((entry: any) => entry?.type === 'output')
    expect(outputEntry).toMatchObject({
      type: 'output',
      payload: {
        rawLength: 11,
        cleanLength: 11,
      },
    })
  })

  it('does not run full parseOutput from the frequent getStatus hot path without a fresh parsed cache', () => {
    const parseOutput = vi.fn(() => ({
      id: 'cli_session',
      status: 'waiting_approval',
      title: 'Test CLI',
      activeModal: { message: 'Approve?', buttons: ['Yes'] },
      messages: [],
    }))

    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
        parseOutput,
      },
    } as any, '/tmp/project') as any

    adapter.terminalScreen = {
      write: vi.fn(),
      getText: vi.fn(() => 'screen snapshot'),
    }
    adapter.currentStatus = 'idle'
    adapter.activeModal = null
    adapter.startupParseGate = false

    const status = adapter.getStatus()

    expect(status.status).toBe('idle')
    expect(status.activeModal).toBeNull()
    expect(parseOutput).not.toHaveBeenCalled()
  })

  it('skips uncached full parseOutput probes when getStatus disallows parsing', () => {
    const parseOutput = vi.fn(() => ({
      id: 'cli_session',
      status: 'waiting_approval',
      title: 'Test CLI',
      activeModal: { message: 'Approve?', buttons: ['Yes'] },
      messages: [],
    }))

    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'generating',
        parseApproval: () => null,
        parseOutput,
      },
    } as any, '/tmp/project') as any

    adapter.terminalScreen = {
      write: vi.fn(),
      getText: vi.fn(() => 'screen snapshot'),
    }
    adapter.currentStatus = 'generating'
    adapter.activeModal = null
    adapter.startupParseGate = false

    const status = adapter.getStatus({ allowParse: false })

    expect(status.status).toBe('generating')
    expect(status.activeModal).toBeNull()
    expect(parseOutput).not.toHaveBeenCalled()
  })

  it('throttles uncached full parseOutput probes from repeated generating getStatus calls', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-25T12:00:00Z'))

    const parseOutput = vi.fn(() => ({
      id: 'cli_session',
      status: 'generating',
      title: 'Test CLI',
      messages: [],
    }))

    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'generating',
        parseApproval: () => null,
        parseOutput,
      },
    } as any, '/tmp/project') as any

    adapter.terminalScreen = {
      write: vi.fn(),
      getText: vi.fn(() => 'screen snapshot'),
    }
    adapter.currentStatus = 'generating'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = {
      prompt: 'hello',
      startedAt: Date.now() - 1000,
      bufferStart: 0,
      rawBufferStart: 0,
    }

    adapter.getStatus()
    adapter.recentOutputBuffer = 'new output invalidates parsed cache'
    vi.setSystemTime(new Date('2026-04-25T12:00:00.500Z'))
    adapter.getStatus()

    expect(parseOutput).toHaveBeenCalledTimes(1)
  })

  it('appends rolling text without constructing an over-limit combined buffer first', () => {
    const existing = 'a'.repeat(256)
    const chunk = 'b'.repeat(128)

    const result = appendBoundedText(existing, chunk, 300)

    expect(result).toHaveLength(300)
    expect(result).toBe(`${'a'.repeat(172)}${chunk}`)
  })

  it('reuses the current output flush screen snapshot for startup readiness instead of reading the terminal twice', () => {
    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
      },
    } as any, '/tmp/project') as any

    const getText = vi.fn(() => 'screen snapshot')
    adapter.terminalScreen = {
      write: vi.fn(),
      getText,
    }
    adapter.scheduleSettle = vi.fn()
    adapter.scheduleStartupSettleCheck = vi.fn()
    adapter.startupParseGate = true
    adapter.spawnAt = Date.now()

    adapter.handleOutput('hello world')

    expect(getText).toHaveBeenCalledTimes(1)
  })

  it('throttles terminal screen full snapshot reads across bursty output flushes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-25T12:00:00Z'))

    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
      },
    } as any, '/tmp/project') as any

    const getText = vi.fn(() => 'screen snapshot')
    adapter.terminalScreen = {
      write: vi.fn(),
      getText,
    }
    adapter.scheduleSettle = vi.fn()
    adapter.scheduleStartupSettleCheck = vi.fn()
    adapter.startupParseGate = false

    adapter.handleOutput('first burst')
    vi.setSystemTime(new Date('2026-04-25T12:00:00.050Z'))
    adapter.handleOutput('second burst')

    expect(getText).toHaveBeenCalledTimes(1)
  })

  it('reuses cached parsed status when transcript inputs have not changed', () => {
    const parseOutput = vi.fn(() => ({
      id: 'cli_session',
      status: 'idle',
      title: 'Test CLI',
      messages: [
        { role: 'assistant', content: 'parsed assistant', id: 'assistant-1', index: 1, receivedAt: 2 },
      ],
    }))

    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
        parseOutput,
      },
    } as any, '/tmp/project') as any

    adapter.terminalScreen = {
      write: vi.fn(),
      getText: vi.fn(() => 'screen snapshot'),
    }
    adapter.committedMessages = [
      { role: 'user', content: 'hello', timestamp: 1, receivedAt: 1, id: 'user-1', index: 0 },
      { role: 'assistant', content: 'parsed assistant', timestamp: 2, receivedAt: 2, id: 'assistant-1', index: 1 },
    ]
    adapter.currentStatus = 'idle'
    adapter.activeModal = null

    const first = adapter.getScriptParsedStatus()
    const second = adapter.getScriptParsedStatus()

    expect(parseOutput).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it('keeps parsed status cached across ANSI-only cursor output that does not change semantic terminal content', () => {
    const parseOutput = vi.fn(() => ({
      id: 'cli_session',
      status: 'idle',
      title: 'Test CLI',
      messages: [
        { role: 'assistant', content: 'parsed assistant', id: 'assistant-1', index: 0, receivedAt: 2 },
      ],
    }))

    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
        parseOutput,
      },
    } as any, '/tmp/project') as any

    let screenText = '❯ '
    adapter.terminalScreen = {
      write: vi.fn((data: string) => {
        if (data === '\x1b[?25l' || data === '\x1b[?25h' || data === '\x1b[31m') return
        screenText += data
      }),
      getText: vi.fn(() => screenText),
    }
    adapter.scheduleSettle = vi.fn()
    adapter.scheduleStartupSettleCheck = vi.fn()
    adapter.resolveStartupState = vi.fn()
    adapter.startupParseGate = false
    adapter.committedMessages = [
      { role: 'assistant', content: 'parsed assistant', timestamp: 2, receivedAt: 2, id: 'assistant-1', index: 0 },
    ]
    adapter.currentStatus = 'idle'
    adapter.activeModal = null

    const first = adapter.getScriptParsedStatus()
    adapter.handleOutput('\x1b[?25l')
    const afterCursorHide = adapter.getScriptParsedStatus()
    adapter.handleOutput('\x1b[?25h')
    const afterCursorShow = adapter.getScriptParsedStatus()
    adapter.handleOutput('\x1b[31m')
    const afterColorOnly = adapter.getScriptParsedStatus()

    expect(parseOutput).toHaveBeenCalledTimes(1)
    expect(afterCursorHide).toEqual(first)
    expect(afterCursorShow).toEqual(first)
    expect(afterColorOnly).toEqual(first)

    adapter.handleOutput('real text')
    adapter.getScriptParsedStatus()
    expect(parseOutput).toHaveBeenCalledTimes(2)
  })

  it('passes only the committed transcript tail to parseOutput while returning the full transcript', () => {
    const parseOutput = vi.fn((input: any) => ({
      id: 'cli_session',
      status: 'idle',
      title: 'Test CLI',
      messages: [
        ...input.messages,
        { role: 'assistant', content: 'fresh assistant answer', id: 'assistant-fresh', index: 2600 },
      ],
    }))

    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
        parseOutput,
      },
    } as any, '/tmp/project') as any

    adapter.terminalScreen = {
      write: vi.fn(),
      getText: vi.fn(() => 'fresh screen snapshot'),
    }
    adapter.committedMessages = Array.from({ length: 2600 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `committed-${index + 1}`,
      timestamp: index + 1,
      receivedAt: index + 1,
      id: `msg-${index + 1}`,
      index,
    }))
    adapter.currentStatus = 'idle'
    adapter.activeModal = null

    const result = adapter.getScriptParsedStatus()
    const input = parseOutput.mock.calls[0][0]

    expect(input.messages).toHaveLength(100)
    expect(input.messages[0]).toMatchObject({ content: 'committed-2501', id: 'msg-2501' })
    expect(result.messages).toHaveLength(2601)
    expect(result.messages[0]).toMatchObject({ content: 'committed-1', id: 'msg-1' })
    expect(result.messages[2599]).toMatchObject({ content: 'committed-2600', id: 'msg-2600' })
    expect(result.messages[2600]).toMatchObject({ content: 'fresh assistant answer', id: 'assistant-fresh' })
  })

  it('preserves provider-owned identity when hydrating a committed CLI transcript prefix', () => {
    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
        parseOutput: () => ({
          id: 'cli_session',
          status: 'idle',
          title: 'Test CLI',
          messages: [
            { role: 'user', content: 'hello', id: 'user-1', index: 0 },
            { role: 'assistant', content: 'hi', id: 'assistant-1', index: 1 },
          ],
        }),
      },
    } as any, '/tmp/project') as any

    adapter.terminalScreen = {
      write: vi.fn(),
      getText: vi.fn(() => 'idle screen'),
    }
    adapter.committedMessages = [
      {
        role: 'user',
        content: 'hello',
        timestamp: 100,
        receivedAt: 100,
        id: 'user-1',
        index: 0,
        providerUnitKey: 'test-cli:user:0',
        bubbleId: 'bubble-user-1',
        bubbleState: 'final',
        _turnKey: 'turn-user-1',
      },
      {
        role: 'assistant',
        content: 'hi',
        timestamp: 101,
        receivedAt: 101,
        id: 'assistant-1',
        index: 1,
        providerUnitKey: 'test-cli:assistant:1',
        bubbleId: 'bubble-assistant-1',
        bubbleState: 'final',
        _turnKey: 'turn-assistant-1',
      },
    ]
    adapter.currentStatus = 'idle'
    adapter.activeModal = null

    const result = adapter.getScriptParsedStatus()

    expect(result.messages[0]).toMatchObject({
      providerUnitKey: 'test-cli:user:0',
      bubbleId: 'bubble-user-1',
      bubbleState: 'final',
      _turnKey: 'turn-user-1',
    })
    expect(result.messages[1]).toMatchObject({
      providerUnitKey: 'test-cli:assistant:1',
      bubbleId: 'bubble-assistant-1',
      bubbleState: 'final',
      _turnKey: 'turn-assistant-1',
    })
  })

  it('preserves timestamps by stable id/index without reading committed transcript content', () => {
    const committedContentAccesses = { count: 0 }
    const committedMessages = Array.from({ length: 250 }, (_, index) => {
      const message: any = {
        role: index % 2 === 0 ? 'user' : 'assistant',
        timestamp: 10_000 + index,
        receivedAt: 10_000 + index,
        id: `msg-${index}`,
        index,
      }
      Object.defineProperty(message, 'content', {
        enumerable: true,
        get() {
          committedContentAccesses.count += 1
          return `committed message ${index}`
        },
      })
      return message
    })
    const parsedMessages = committedMessages.map((message, index) => ({
      role: message.role,
      id: message.id,
      index: message.index,
      content: `committed message ${index}`,
    }))

    const result = normalizeCliParsedMessages(parsedMessages, {
      committedMessages,
      scope: null,
      lastOutputAt: 999,
      now: 1_000,
    })

    expect(result).toHaveLength(250)
    expect(result[0]).toMatchObject({ id: 'msg-0', index: 0, timestamp: 10_000, receivedAt: 10_000 })
    expect(result[249]).toMatchObject({ id: 'msg-249', index: 249, timestamp: 10_249, receivedAt: 10_249 })
    expect(committedContentAccesses.count).toBe(0)
  })

  it('does not repeatedly normalize the committed prefix when stitching a tail parse result', () => {
    const parseOutput = vi.fn((input: any) => ({
      id: 'cli_session',
      status: 'idle',
      title: 'Test CLI',
      messages: [
        ...input.messages,
        { role: 'assistant', content: 'fresh assistant answer', id: 'assistant-fresh', index: 2600 },
      ],
    }))

    const contentAccesses = { count: 0 }
    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
        parseOutput,
      },
    } as any, '/tmp/project') as any

    adapter.terminalScreen = {
      write: vi.fn(),
      getText: vi.fn(() => 'fresh screen snapshot'),
    }
    adapter.committedMessages = Array.from({ length: 2600 }, (_, index) => {
      const message: any = {
        role: index % 2 === 0 ? 'user' : 'assistant',
        timestamp: index + 1,
        receivedAt: index + 1,
        id: `msg-${index + 1}`,
        index,
      }
      Object.defineProperty(message, 'content', {
        enumerable: true,
        get() {
          contentAccesses.count += 1
          return `committed-${index + 1}`
        },
      })
      return message
    })
    adapter.currentStatus = 'idle'
    adapter.activeModal = null

    const result = adapter.getScriptParsedStatus()

    expect(result.messages).toHaveLength(2601)
    expect(result.messages[0]).toMatchObject({ content: 'committed-1', id: 'msg-1' })
    expect(result.messages[2600]).toMatchObject({ content: 'fresh assistant answer', id: 'assistant-fresh' })
    expect(contentAccesses.count).toBeLessThanOrEqual(2800)
  })

  it('keeps turn-scoped parse input empty instead of falling back to the full pre-turn transcript when no new output has arrived yet', () => {
    const input = buildCliParseInput({
      accumulatedBuffer: 'startup text already on screen',
      accumulatedRawBuffer: 'startup raw buffer',
      recentOutputBuffer: 'recent startup text',
      terminalScreenText: 'startup text already on screen',
      baseMessages: [],
      partialResponse: '',
      isWaitingForResponse: true,
      scope: {
        prompt: 'Reply with exactly T1 and nothing else.',
        startedAt: 1,
        bufferStart: 'startup text already on screen'.length,
        rawBufferStart: 'startup raw buffer'.length,
      },
      runtimeSettings: {},
    })

    expect(input.buffer).toBe('')
    expect(input.rawBuffer).toBe('')
    expect(input.recentBuffer).toBe('recent startup text')
  })
})

