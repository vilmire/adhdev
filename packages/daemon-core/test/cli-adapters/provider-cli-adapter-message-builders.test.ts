import { describe, expect, it, vi, afterEach } from 'vitest'
import { appendBoundedText, ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'
import { buildCliParseInput, normalizeCliParsedMessages } from '../../src/cli-adapters/provider-cli-parse.js'
import { normalizeComparableMessageContent } from '../../src/cli-adapters/provider-cli-shared.js'
import { LOG } from '../../src/logging/logger.js'
import { resetDebugRuntimeConfig, resolveDebugRuntimeConfig, setDebugRuntimeConfig } from '../../src/logging/debug-config.js'

describe('ProviderCliAdapter message fallback shaping', () => {
  afterEach(() => {
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

