import { describe, expect, it, vi, afterEach } from 'vitest'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'

function buildAdapter(type: string) {
  const adapter = new ProviderCliAdapter({
    type,
    name: type === 'hermes-cli' ? 'Hermes Agent' : 'Codex CLI',
    category: 'cli',
    binary: type === 'hermes-cli' ? 'hermes' : 'codex',
    spawn: {
      command: type === 'hermes-cli' ? 'hermes' : 'codex',
      args: [],
      shell: true,
      env: {},
    },
    scripts: {
      detectStatus: () => 'idle',
      parseOutput: () => ({
        status: 'idle',
        messages: [{ role: 'assistant', content: 'done' }],
      }),
      parseApproval: () => null,
    },
  } as any, '/tmp/project') as any

  adapter.terminalScreen = { getText: () => '❯' }
  adapter.getStartupConfirmationModal = () => null
  adapter.runParseApproval = () => null
  adapter.runDetectStatus = () => 'idle'
  adapter.parseCurrentTranscript = () => ({
    status: 'idle',
    messages: [{ role: 'assistant', content: 'done' }],
  })
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

describe('ProviderCliAdapter Hermes idle finish debounce', () => {
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

  it('passes isWaitingForResponse into parseOutput scripts', () => {
    const adapter = buildAdapter('hermes-cli')
    let captured: any = null
    adapter.cliScripts.parseOutput = (input: any) => {
      captured = input
      return { status: 'idle', messages: [{ role: 'assistant', content: 'done' }] }
    }

    adapter.isWaitingForResponse = true
    ProviderCliAdapter.prototype['parseCurrentTranscript'].call(adapter, [], '', adapter.currentTurnScope)

    expect(captured?.isWaitingForResponse).toBe(true)
  })

  it('keeps hermes-cli turns open for 5s before finishing an idle-looking screen', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-15T15:00:00Z'))

    const adapter = buildAdapter('hermes-cli')
    const finishResponse = vi.fn()
    adapter.finishResponse = finishResponse

    adapter.evaluateSettled()
    expect(finishResponse).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(4_000)
    expect(finishResponse).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(finishResponse).toHaveBeenCalledTimes(1)
  })

  it('keeps the generating timeout from force-finishing while detectStatus still reports generating', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-15T15:00:00Z'))

    const adapter = buildAdapter('hermes-cli')
    const finishResponse = vi.fn()
    adapter.finishResponse = finishResponse
    adapter.timeouts.generatingIdle = 1_000
    adapter.runDetectStatus = vi.fn(() => 'generating')
    adapter.currentStatus = 'generating'
    adapter.recentOutputBuffer = 'still thinking'

    adapter.evaluateSettled()
    expect(finishResponse).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(finishResponse).not.toHaveBeenCalled()
    expect(adapter.runDetectStatus).toHaveBeenCalled()
  })

  it('keeps the default 2s idle-finish debounce for non-Hermes CLI providers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-15T15:00:00Z'))

    const adapter = buildAdapter('codex-cli')
    const finishResponse = vi.fn()
    adapter.finishResponse = finishResponse

    adapter.evaluateSettled()
    expect(finishResponse).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(finishResponse).toHaveBeenCalledTimes(1)
  })
})
