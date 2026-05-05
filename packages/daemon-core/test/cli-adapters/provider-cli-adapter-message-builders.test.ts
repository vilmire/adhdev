import * as fs from 'fs'
import * as path from 'path'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { appendBoundedText, ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'
import { buildCliParseInput, normalizeCliParsedMessages } from '../../src/cli-adapters/provider-cli-parse.js'
import { normalizeComparableMessageContent } from '../../src/cli-adapters/provider-cli-shared.js'
import { LOG } from '../../src/logging/logger.js'
import { resetDebugRuntimeConfig, resolveDebugRuntimeConfig, setDebugRuntimeConfig } from '../../src/logging/debug-config.js'

describe('ProviderCliAdapter message fallback shaping', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetDebugRuntimeConfig()
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

  it('preserves parser-provided consecutive assistant rows instead of deduping by wrap formatting', () => {
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
      scope: null,
      lastOutputAt: 123,
      now: 123,
    })

    expect(normalized).toHaveLength(3)
    expect(normalized[1]?.content).toBe(wrapped)
    expect(normalized[2]?.content).toBe(reflowed)
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

  it('keeps parser-owned CLI messages byte-for-byte instead of hydrating timestamps or collapsing rows', () => {
    const normalized = normalizeCliParsedMessages([
      { role: 'assistant', content: 'same visible text', id: 'assistant-a' },
      { role: 'assistant', content: 'same visible text', id: 'assistant-b' },
    ], {
      committedMessages: [
        { role: 'assistant', content: 'same visible text', timestamp: 10_000, receivedAt: 10_000, id: 'committed-a' },
      ],
      scope: { prompt: 'prompt', startedAt: 11_000, bufferStart: 0, rawBufferStart: 0 },
      lastOutputAt: 12_000,
      now: 13_000,
    }) as any[]

    expect(normalized).toEqual([
      { role: 'assistant', content: 'same visible text', id: 'assistant-a' },
      { role: 'assistant', content: 'same visible text', id: 'assistant-b' },
    ])
  })

  it('passes parser-owned message rows through without role filtering, content stringification, or field whitelisting', () => {
    const parserRows = [
      {
        role: 'system',
        kind: 'system',
        content: [{ type: 'text', text: 'runtime notice' }],
        id: 'system-row',
        providerExtra: { source: 'parser' },
      },
      {
        role: 'assistant',
        kind: 'tool',
        content: [{ type: 'tool', name: 'terminal', text: 'npm test' }],
        id: 'tool-row',
        providerUnitKey: 'provider:tool:1',
        nestedParserState: { stable: true },
      },
    ]

    const normalized = normalizeCliParsedMessages(parserRows, {
      scope: null,
      lastOutputAt: 123,
      now: 456,
    }) as any[]

    expect(normalized).toEqual(parserRows)
    expect(normalized[0]).toBe(parserRows[0])
    expect(normalized[1]).toBe(parserRows[1])
  })

  it('uses parseSession as the transcript authority with raw-only input for dashboard parsed status', () => {
    const parseSession = vi.fn((input: any) => ({
      id: 'parser-session',
      status: 'idle',
      title: 'Parser Title',
      messages: [
        { role: 'assistant', content: 'parser-owned answer', id: 'parser-answer' },
      ],
      modal: null,
      parsedStatus: 'idle',
      transcriptAuthority: 'provider',
      coverage: 'tail',
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
        parseSession,
      },
    } as any, '/tmp/project') as any

    adapter.terminalScreen = {
      write: vi.fn(),
      getText: vi.fn(() => 'raw terminal screen'),
    }
    adapter.committedMessages = [
      { role: 'user', content: 'committed prompt', timestamp: 100, receivedAt: 100, id: 'committed-user' },
      { role: 'assistant', content: 'committed answer', timestamp: 101, receivedAt: 101, id: 'committed-assistant' },
    ]
    adapter.accumulatedBuffer = 'raw accumulated buffer'
    adapter.accumulatedRawBuffer = 'raw accumulated buffer'
    adapter.recentOutputBuffer = 'raw recent buffer'
    adapter.responseBuffer = 'raw partial response'
    adapter.currentStatus = 'idle'
    adapter.activeModal = null

    const result = adapter.getScriptParsedStatus()

    expect(parseSession).toHaveBeenCalledTimes(1)
    expect(parseSession.mock.calls[0][0]).toMatchObject({
      buffer: 'raw accumulated buffer',
      rawBuffer: 'raw accumulated buffer',
      recentBuffer: 'raw accumulated buffer',
      screenText: 'raw terminal screen',
      messages: [],
      partialResponse: 'raw partial response',
    })
    expect(result).toMatchObject({
      id: 'parser-session',
      status: 'idle',
      title: 'Parser Title',
      messages: [
        { role: 'assistant', content: 'parser-owned answer', id: 'parser-answer' },
      ],
      activeModal: null,
      transcriptAuthority: 'provider',
      coverage: 'tail',
    })
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

  it('keeps restored history out of daemon-owned hot status state', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'cli-adapters', 'provider-cli-adapter.ts'), 'utf-8')

    expect(source).not.toMatch(/committedMessages\b/)
    expect(source).not.toMatch(/structuredMessages\b/)
    expect(source).not.toMatch(/seedCommittedMessages\s*\(/)
    expect(source).not.toMatch(/getLastCommittedMessageActivityAt\s*\(/)
    expect(source).not.toMatch(/lastStatusHotPathParseAt\b/)
  })

  it('uses newly injected parseSession scripts immediately instead of returning a stale parsed-status cache', () => {
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
        parseSession: () => ({
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
      parseSession: () => ({
        status: 'idle',
        messages: [{ role: 'assistant', content: 'new parser' }],
      }),
    })

    expect(adapter.getScriptParsedStatus().messages[0].content).toBe('new parser')
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

  it('does not run full parseSession from the frequent getStatus hot path without a fresh parsed cache', () => {
    const parseSession = vi.fn(() => ({
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
        parseSession,
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
    expect(parseSession).not.toHaveBeenCalled()
  })

  it('skips uncached full parseSession probes when getStatus disallows parsing', () => {
    const parseSession = vi.fn(() => ({
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
        parseSession,
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
    expect(parseSession).not.toHaveBeenCalled()
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

  it('does not append a shorter stale active screen snapshot to a newer idle screen for parsed status', () => {
    const parseSession = vi.fn((input: any) => ({
      id: 'cli_session',
      status: String(input.screenText || '').includes('esc to interrupt') ? 'generating' : 'idle',
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
        parseSession,
      },
    } as any, '/tmp/project') as any

    adapter.terminalScreen = {
      write: vi.fn(),
      getText: vi.fn(() => [
        '❯ user prompt',
        '⏺ completed answer',
        '✻ Cooked for 1m 39s',
        '────────────────────────────────────────────────────────────────────────────────',
        '❯ ',
        '────────────────────────────────────────────────────────────────────────────────',
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
        'idle filler that makes the current screen supersede the stale snapshot',
      ].join('\n')),
    }
    adapter.lastScreenSnapshot = [
      '❯ user prompt',
      '⏺ partial answer',
      '────────────────────────────────────────────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt',
    ].join(' ')
    adapter.currentStatus = 'idle'
    adapter.activeModal = null

    const result = adapter.getScriptParsedStatus()

    expect(parseSession).toHaveBeenCalledTimes(1)
    expect(parseSession.mock.calls[0][0].screenText).not.toContain('esc to interrupt')
    expect(result.status).toBe('idle')
  })

  it('does not append a stale approval screen snapshot after Claude returns to idle', () => {
    const parseSession = vi.fn((input: any) => ({
      id: 'cli_session',
      status: String(input.screenText || '').includes('Enter to confirm · Esc to cancel') ? 'generating' : 'idle',
      title: 'Claude Code',
      messages: [],
      activeModal: null,
    }))
    const adapter = new ProviderCliAdapter({
      type: 'claude-cli',
      name: 'Claude Code',
      category: 'cli',
      binary: 'claude',
      spawn: {
        command: 'claude',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
        parseSession,
      },
    } as any, '/tmp/project') as any

    adapter.terminalScreen = {
      write: vi.fn(),
      getText: vi.fn(() => [
        ' ▐▛███▜▌   Claude Code v2.1.128',
        '▝▜█████▛▘  Sonnet 4.6 with medium effort · Claude Pro',
        '  ▘▘ ▝▝    /tmp/project',
        '',
        '────────────────────────────────────────────────────────────────────────────────',
        '❯ Try "fix typecheck errors"',
        '────────────────────────────────────────────────────────────────────────────────',
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
      ].join('\n')),
    }
    adapter.lastScreenSnapshot = [
      '────────────────────────────────────────────────────────────────────────────────',
      'New MCP server found in .mcp.json: adhdev-mesh',
      'MCP servers may execute code or access system resources.',
      'All tool calls require approval.',
      '❯ 1. Use this and all future MCP servers in this project',
      '2. Use this MCP server',
      '3. Continue without using this MCP server',
      'Enter to confirm · Esc to cancel',
    ].join(' ')
    adapter.currentStatus = 'idle'
    adapter.activeModal = null

    const result = adapter.getScriptParsedStatus()

    expect(parseSession).toHaveBeenCalledTimes(1)
    expect(parseSession.mock.calls[0][0].screenText).not.toContain('New MCP server found')
    expect(parseSession.mock.calls[0][0].screenText).not.toContain('Enter to confirm · Esc to cancel')
    expect(result.status).toBe('idle')
  })

  it('reuses cached parsed status when transcript inputs have not changed', () => {
    const parseSession = vi.fn(() => ({
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
        parseSession,
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

    expect(parseSession).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it('keeps parsed status cached across ANSI-only cursor output that does not change semantic terminal content', () => {
    const parseSession = vi.fn(() => ({
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
        parseSession,
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

    expect(parseSession).toHaveBeenCalledTimes(1)
    expect(afterCursorHide).toEqual(first)
    expect(afterCursorShow).toEqual(first)
    expect(afterColorOnly).toEqual(first)

    adapter.handleOutput('real text')
    adapter.getScriptParsedStatus()
    expect(parseSession).toHaveBeenCalledTimes(2)
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

