import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'

function buildAdapter(options: { allowInputDuringGeneration?: boolean } = {}) {
  const adapter = new ProviderCliAdapter({
    type: 'hermes-cli',
    name: 'Hermes Agent',
    category: 'cli',
    binary: 'hermes',
    allowInputDuringGeneration: options.allowInputDuringGeneration,
    spawn: {
      command: 'hermes',
      args: [],
      shell: true,
      env: {},
    },
    scripts: {
      detectStatus: () => 'generating',
      parseApproval: () => null,
    },
  } as any, '/tmp/project') as any

  adapter.ptyProcess = { write: vi.fn() }
  adapter.waitForInteractivePrompt = vi.fn().mockResolvedValue(undefined)
  adapter.terminalScreen = { getText: () => '' }
  adapter.getStartupConfirmationModal = () => null
  adapter.ready = true
  adapter.startupParseGate = false
  adapter.currentStatus = 'generating'
  adapter.isWaitingForResponse = true
  adapter.submitStrategy = 'immediate'

  return adapter
}

describe('ProviderCliAdapter sendMessage guard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects a new prompt while a response is still in progress for providers that do not allow intervention', async () => {
    const adapter = buildAdapter()

    await expect(adapter.sendMessage('second prompt')).rejects.toThrow('still processing')
    expect(adapter.ptyProcess.write).not.toHaveBeenCalled()
  })

  it('clears a stale waiting guard when the UI is already back at an idle prompt', async () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'idle'
    adapter.terminalScreen = { getText: () => '❯\n' }

    await expect(adapter.sendMessage('next prompt')).resolves.toBeUndefined()
    expect(adapter.isWaitingForResponse).toBe(true)
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('next prompt\r')
  })

  it('rejects a second prompt when parsed status still says generating even if adapter status already looks idle', async () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.terminalScreen = { getText: () => '❯\n' }
    adapter.getScriptParsedStatus = vi.fn(() => ({
      status: 'generating',
      messages: [
        { role: 'user', content: 'Reply with exactly TURN-ONE and nothing else.' },
        { role: 'assistant', content: '· Proofing…' },
      ],
    }))

    await expect(adapter.sendMessage('Reply with exactly TURN-TWO and nothing else.')).rejects.toThrow('still processing')
    expect(adapter.ptyProcess.write).not.toHaveBeenCalled()
  })

  it('retries submit when the response buffer only contains the echoed long prompt', async () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.scripts = undefined
    adapter.runDetectStatus = vi.fn(() => 'idle')
    adapter.terminalScreen = {
      getText: () => '❯ Reply with BEGIN, then the numbers 1 through 40 with one number per line, then END.\n'
    }

    const sendPromise = adapter.sendMessage('Reply with BEGIN, then the numbers 1 through 40 with one number per line, then END.')
    await vi.runAllTicks()
    adapter.responseBuffer = 'Reply with BEGIN, then the numbers 1 through 40 with one number per line, then END.'
    await vi.advanceTimersByTimeAsync(1000)
    await expect(sendPromise).resolves.toBeUndefined()
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('Reply with BEGIN, then the numbers 1 through 40 with one number per line, then END.\r')
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('\r')
  })

  it('allows an intervention prompt during generation for providers that explicitly opt in', async () => {
    const adapter = buildAdapter({ allowInputDuringGeneration: true })

    await expect(adapter.sendMessage('interrupt now')).resolves.toBeUndefined()
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('interrupt now\r')
  })

  it('resolves the synthetic Claude startup trust modal with numeric selection plus enter', () => {
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
      approvalKeys: { 0: '1', 1: '2' },
      scripts: {
        detectStatus: () => 'waiting_approval',
        parseApproval: () => null,
      },
    } as any, '/tmp/project') as any

    adapter.ptyProcess = { write: vi.fn() }
    adapter.currentStatus = 'waiting_approval'
    adapter.activeModal = null
    adapter.terminalScreen = {
      getText: () => 'Quick safety check\nClaude Code\'ll be able to read, edit, and execute files here.\n❯ 1. Yes, I trust this folder\n2. No, exit\nEnter to confirm'
    }

    adapter.resolveModal(0)

    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('1\r')
  })

  it('reports generating from getStatus while a turn is still open even if currentStatus has not caught up yet', () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = {
      prompt: 'next prompt',
      startedAt: Date.now(),
      bufferStart: 0,
      rawBufferStart: 0,
    }

    expect(adapter.getStatus().status).toBe('generating')
  })

  it('reports generating from getDebugState while a turn is still open even if currentStatus still says idle', () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = {
      prompt: 'next prompt',
      startedAt: Date.now(),
      bufferStart: 0,
      rawBufferStart: 0,
    }

    expect(adapter.getDebugState().status).toBe('generating')
  })
})
