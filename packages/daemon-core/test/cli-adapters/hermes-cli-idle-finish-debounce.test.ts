import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'

function buildAdapter(type: string, parseSession?: (input: any) => any) {
  const isHermes = type === 'hermes-cli'
  const adapter = new ProviderCliAdapter({
    type,
    name: isHermes ? 'Hermes Agent' : 'Codex CLI',
    category: 'cli',
    binary: isHermes ? 'hermes' : 'codex',
    spawn: {
      command: isHermes ? 'hermes' : 'codex',
      args: [],
      shell: true,
      env: {},
    },
    allowInputDuringGeneration: isHermes,
    timeouts: isHermes
      ? { idleFinishConfirm: 5000, statusActivityHold: 5000 }
      : {},
    scripts: {
      detectStatus: () => 'idle',
      parseSession: parseSession || (() => ({
        status: 'idle',
        parsedStatus: 'idle',
        modal: null,
        messages: [{ role: 'assistant', content: 'done' }],
      })),
      parseApproval: () => null,
    },
  } as any, '/tmp/project') as any

  adapter.terminalScreen = { getText: () => '❯' }
  adapter.getStartupConfirmationModal = () => null
  adapter.runParseApproval = () => null
  adapter.onStatusChange = () => {}
  adapter.currentStatus = 'generating'
  adapter.isWaitingForResponse = true
  adapter.currentTurnScope = {
    prompt: 'hello',
    startedAt: Date.now() - 10_000,
    bufferStart: 0,
    rawBufferStart: 0,
  }
  adapter.lastNonEmptyOutputAt = Date.now() - 6_000
  adapter.lastScreenChangeAt = Date.now() - 6_000
  adapter.responseEpoch = 1
  adapter.responseBuffer = ''
  adapter.recentOutputBuffer = ''
  adapter.accumulatedBuffer = ''
  adapter.accumulatedRawBuffer = ''
  return adapter
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ProviderCliAdapter Hermes parser-authority status handling', () => {
  it('passes isWaitingForResponse into detectStatus scripts', () => {
    const adapter = buildAdapter('hermes-cli')
    let captured: any = null
    adapter.cliScripts.detectStatus = (input: any) => {
      captured = input
      return 'idle'
    }

    adapter.isWaitingForResponse = true
    ProviderCliAdapter.prototype['runDetectStatus'].call(adapter, 'tail output')

    expect(captured?.isWaitingForResponse).toBe(true)
  })

  it('passes raw terminal context into parseSession without daemon-owned base messages', () => {
    let captured: any = null
    const adapter = buildAdapter('hermes-cli', (input: any) => {
      captured = input
      return {
        status: 'idle',
        parsedStatus: 'idle',
        modal: null,
        messages: [{ role: 'assistant', content: 'done' }],
      }
    })

    adapter.isWaitingForResponse = true
    ProviderCliAdapter.prototype['parseCurrentTranscript'].call(adapter, [{ role: 'user', content: 'stale' }], 'partial', adapter.currentTurnScope)

    expect(captured?.isWaitingForResponse).toBe(true)
    expect(captured?.messages).toEqual([])
    expect(captured?.screenText).toBe('❯')
    expect(captured?.partialResponse).toBe(adapter.responseBuffer)
  })

  it('returns parser-provided transcript rows from getScriptParsedStatus while getStatus keeps chat rows empty', () => {
    const parserMessages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done' },
      { role: 'assistant', content: 'done' },
    ]
    const adapter = buildAdapter('hermes-cli', () => ({
      status: 'idle',
      parsedStatus: 'idle',
      modal: null,
      messages: parserMessages,
    }))

    const parsed = adapter.getScriptParsedStatus()
    const status = adapter.getStatus()

    expect(parsed.messages).toEqual(parserMessages.map(message => expect.objectContaining(message)))
    expect(status.messages).toEqual([])
  })

  it('exposes parser-provided transcript rows in debug state without daemon-owned chat rows', () => {
    const parserMessages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done' },
    ]
    const adapter = buildAdapter('hermes-cli', () => ({
      id: 'hermes-cli-debug',
      status: 'idle',
      parsedStatus: 'idle',
      modal: null,
      transcriptAuthority: 'provider',
      coverage: 'full',
      messages: parserMessages,
    }))

    const debugState = adapter.getDebugState()
    const status = adapter.getStatus()

    expect(debugState.messages).toEqual(parserMessages.map(message => expect.objectContaining(message)))
    expect(debugState.messageCount).toBe(2)
    expect(debugState.parsedStatus).toMatchObject({
      id: 'hermes-cli-debug',
      status: 'idle',
      transcriptAuthority: 'provider',
      coverage: 'full',
      messageCount: 2,
    })
    expect(status.messages).toEqual([])
  })

  it('promotes waiting_approval from parser modal without requiring parseApproval fallback', () => {
    const modal = {
      message: 'Dangerous command needs approval',
      buttons: ['Allow once', 'Deny'],
    }
    const adapter = buildAdapter('hermes-cli', () => ({
      status: 'waiting_approval',
      parsedStatus: 'waiting_approval',
      modal,
      messages: [{ role: 'assistant', kind: 'system', content: 'Approval requested' }],
    }))
    adapter.runDetectStatus = () => 'generating'
    adapter.runParseApproval = () => null

    adapter.evaluateSettled()

    expect(adapter.currentStatus).toBe('waiting_approval')
    expect(adapter.activeModal).toEqual(modal)
  })

  it('projects waiting_approval from cached parser status without adding transcript rows to getStatus', () => {
    const modal = {
      message: 'Dangerous command needs approval',
      buttons: ['Allow once', 'Deny'],
    }
    const adapter = buildAdapter('hermes-cli', () => ({
      status: 'waiting_approval',
      parsedStatus: 'waiting_approval',
      modal,
      messages: [{ role: 'assistant', kind: 'system', content: 'Approval requested' }],
    }))
    adapter.currentStatus = 'generating'
    adapter.activeModal = null

    adapter.getScriptParsedStatus()
    const status = adapter.getStatus()

    expect(status.status).toBe('waiting_approval')
    expect(status.activeModal).toEqual(modal)
    expect(status.messages).toEqual([])
  })

  it('does not treat maxResponse as a fake completion while parser still reports generating', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-15T15:00:00Z'))

    const adapter = buildAdapter('hermes-cli', () => ({
      status: 'generating',
      parsedStatus: 'generating',
      modal: null,
      messages: [
        { role: 'user', content: 'long task' },
        { role: 'assistant', content: 'still working' },
      ],
    }))
    const finishResponse = vi.fn()
    adapter.finishResponse = finishResponse
    adapter.timeouts.maxResponse = 300_000
    adapter.runDetectStatus = vi.fn(() => 'generating')
    adapter.currentStatus = 'generating'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = {
      prompt: 'long task',
      startedAt: Date.now(),
      bufferStart: 0,
      rawBufferStart: 0,
    }

    adapter.armResponseTimeout()
    await vi.advanceTimersByTimeAsync(300_000)

    expect(finishResponse).not.toHaveBeenCalled()
    expect(adapter.currentStatus).toBe('generating')
    expect(adapter.isWaitingForResponse).toBe(true)
    expect(adapter.responseTimeout).toBeTruthy()
  })
})
