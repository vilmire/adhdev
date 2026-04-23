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

  it('suppresses stale parsed approval state during the post-approval cooldown once the live screen no longer shows a modal', () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'generating'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = {
      prompt: 'dangerous prompt',
      startedAt: Date.now() - 1000,
      bufferStart: 0,
      rawBufferStart: 0,
    }
    adapter.lastApprovalResolvedAt = Date.now()
    adapter.recentOutputBuffer = 'synthesizing...'
    adapter.terminalScreen = {
      getText: () => 'synthesizing...\n⚕ ❯ type a message + Enter to interrupt, Ctrl+C to cancel\n'
    }
    adapter.cliScripts.detectStatus = () => 'generating'
    adapter.cliScripts.parseApproval = () => null
    adapter.cliScripts.parseOutput = () => ({
      status: 'waiting_approval',
      messages: [
        { role: 'user', content: 'dangerous prompt' },
        { role: 'assistant', content: 'Approval requested', kind: 'system' },
      ],
      activeModal: {
        message: 'Dangerous command requires approval',
        buttons: ['Allow once', 'Deny'],
      },
    })

    const parsed = adapter.getScriptParsedStatus()

    expect(parsed.status).toBe('generating')
    expect(parsed.activeModal).toBeNull()
  })

  it('allows a fresh prompt after approval resolves when parseOutput still replays the old approval transcript', async () => {
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
        parseOutput: () => ({
          status: 'waiting_approval',
          messages: [
            { role: 'assistant', content: 'Approval requested', kind: 'system' },
          ],
          activeModal: {
            message: 'Claude Code will be able to read, edit, and execute files here.',
            buttons: ['Yes, I trust this folder', 'No, exit'],
          },
        }),
      },
    } as any, '/tmp/project') as any

    adapter.ptyProcess = { write: vi.fn() }
    adapter.waitForInteractivePrompt = vi.fn().mockResolvedValue(undefined)
    adapter.terminalScreen = { getText: () => '❯\n⏵⏵ accept edits on (shift+tab to cycle)\n' }
    adapter.getStartupConfirmationModal = () => null
    adapter.ready = true
    adapter.startupParseGate = false
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.currentTurnScope = null
    adapter.submitStrategy = 'immediate'
    adapter.lastApprovalResolvedAt = Date.now()
    adapter.recentOutputBuffer = '❯\n'
    adapter.responseBuffer = 'Quick safety check\nYes, I trust this folder\n'
    adapter.accumulatedBuffer = adapter.responseBuffer
    adapter.accumulatedRawBuffer = adapter.responseBuffer

    await expect(adapter.sendMessage('Reply with exactly OK and nothing else.')).resolves.toBeUndefined()
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('Reply with exactly OK and nothing else.\r')
  })

  it('clears stale startup approval modal state once the startup screen settles to idle chrome', () => {
    const adapter = buildAdapter()
    adapter.startupParseGate = true
    adapter.ready = false
    adapter.currentStatus = 'waiting_approval'
    adapter.activeModal = {
      message: 'Claude Code will be able to read, edit, and execute files here.',
      buttons: ['Yes, I trust this folder', 'No, exit'],
    }
    adapter.lastScreenChangeAt = Date.now() - 3000
    adapter.terminalScreen = { getText: () => '❯\n⏵⏵ accept edits on (shift+tab to cycle)\n' }
    adapter.getStartupConfirmationModal = () => null

    adapter.resolveStartupState('startup_timer')

    expect(adapter.startupParseGate).toBe(false)
    expect(adapter.ready).toBe(true)
    expect(adapter.currentStatus).toBe('idle')
    expect(adapter.activeModal).toBeNull()
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
