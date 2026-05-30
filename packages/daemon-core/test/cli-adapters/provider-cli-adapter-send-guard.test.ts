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

  it('queues a new prompt while a response is still in progress for providers that do not allow intervention', async () => {
    const adapter = buildAdapter()

    await expect(adapter.sendMessage('second prompt')).resolves.toBeUndefined()
    expect(adapter.pendingOutboundQueue).toHaveLength(1)
    expect(adapter.pendingOutboundQueue[0]).toMatchObject({
      role: 'user',
      content: 'second prompt',
      source: 'sendMessage',
    })
    expect(adapter.ptyProcess.write).not.toHaveBeenCalled()
  })

  it('clears a stale waiting guard when the UI is already back at an idle prompt', async () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'idle'
    adapter.recentOutputBuffer = '❯\n'
    adapter.runDetectStatus = vi.fn(() => 'idle')
    adapter.terminalScreen = { getText: () => '❯\n' }

    await expect(adapter.sendMessage('next prompt')).resolves.toBeUndefined()
    expect(adapter.isWaitingForResponse).toBe(true)
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('next prompt\r')
  })

  it('queues a second prompt when parsed status still says generating during an active turn', async () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = {
      prompt: 'Reply with exactly TURN-ONE and nothing else.',
      startedAt: Date.now(),
      bufferStart: 0,
      rawBufferStart: 0,
    }
    adapter.terminalScreen = { getText: () => '❯\n' }
    adapter.getScriptParsedStatus = vi.fn(() => ({
      status: 'generating',
      messages: [
        { role: 'user', content: 'Reply with exactly TURN-ONE and nothing else.' },
        { role: 'assistant', content: '· Proofing…' },
      ],
    }))

    await expect(adapter.sendMessage('Reply with exactly TURN-TWO and nothing else.')).resolves.toBeUndefined()
    expect(adapter.pendingOutboundQueue.map((message: any) => message.content)).toEqual([
      'Reply with exactly TURN-TWO and nothing else.',
    ])
    expect(adapter.ptyProcess.write).not.toHaveBeenCalled()
  })

  it('flushes queued prompts in order after the active turn finishes', async () => {
    const adapter = buildAdapter()

    await adapter.sendMessage('second prompt')
    await adapter.sendMessage('third prompt')
    expect(adapter.pendingOutboundQueue.map((message: any) => message.content)).toEqual(['second prompt', 'third prompt'])

    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.currentTurnScope = null
    adapter.recentOutputBuffer = '❯\n'
    adapter.runDetectStatus = vi.fn(() => 'idle')
    adapter.terminalScreen = { getText: () => '❯\n' }

    await adapter.flushPendingOutboundQueue()

    expect(adapter.pendingOutboundQueue.map((message: any) => message.content)).toEqual(['third prompt'])
    expect(adapter.currentTurnScope?.prompt).toBe('second prompt')
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('second prompt\r')
    expect(adapter.ptyProcess.write).not.toHaveBeenCalledWith('third prompt\r')
  })

  it('does not duplicate identical queued prompts from repeated sends', async () => {
    const adapter = buildAdapter()

    await adapter.sendMessage('same prompt')
    await adapter.sendMessage('same prompt')

    expect(adapter.pendingOutboundQueue.map((message: any) => message.content)).toEqual(['same prompt'])
    expect(adapter.ptyProcess.write).not.toHaveBeenCalled()
  })

  it('allows a fresh prompt when parsed generating is stale but the terminal state is idle and modal-free', async () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.currentTurnScope = null
    adapter.activeModal = null
    adapter.terminalScreen = { getText: () => '❯\n' }
    adapter.recentOutputBuffer = '❯\n'
    adapter.runDetectStatus = vi.fn(() => 'idle')
    adapter.getScriptParsedStatus = vi.fn(() => ({
      status: 'generating',
      messages: [
        { role: 'user', content: 'Reply with exactly TURN-ONE and nothing else.' },
        { role: 'assistant', content: 'TURN-ONE' },
      ],
      activeModal: null,
    }))

    await expect(adapter.sendMessage('Reply with exactly TURN-TWO and nothing else.')).resolves.toBeUndefined()
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('Reply with exactly TURN-TWO and nothing else.\r')
  })

  it('clears a stale adapter waiting guard when the rich parser has finalized idle output', async () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'generating'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = {
      prompt: 'Reply with exactly TURN-ONE and nothing else.',
      startedAt: Date.now() - 10_000,
      bufferStart: 0,
      rawBufferStart: 0,
    }
    adapter.activeModal = null
    adapter.recentOutputBuffer = 'stale Working spinner fragment'
    adapter.terminalScreen = { getText: () => 'stale Working spinner fragment' }
    adapter.runDetectStatus = vi.fn(() => 'generating')
    adapter.runParseApproval = vi.fn(() => null)
    adapter.getScriptParsedStatus = vi.fn(() => ({
      status: 'idle',
      messages: [
        { role: 'user', content: 'Reply with exactly TURN-ONE and nothing else.' },
        { role: 'assistant', content: 'TURN-ONE' },
      ],
      activeModal: null,
    }))

    await expect(adapter.sendMessage('Reply with exactly TURN-TWO and nothing else.')).resolves.toBeUndefined()
    expect(adapter.currentTurnScope?.prompt).toBe('Reply with exactly TURN-TWO and nothing else.')
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('Reply with exactly TURN-TWO and nothing else.\r')
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

  it('does not retry submit when parseApproval already reports a visible approval menu', async () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.scripts = undefined
    adapter.runDetectStatus = vi.fn(() => 'idle')
    adapter.runParseApproval = vi.fn(() => ({
      message: 'Confirm the pending action',
      buttons: ['Continue', 'Cancel'],
    }))
    adapter.terminalScreen = {
      getText: () => '❯ Reply with BEGIN, then the numbers 1 through 40 with one number per line, then END.\n1. Continue\n2. Cancel\nEnter to confirm\n'
    }

    const sendPromise = adapter.sendMessage('Reply with BEGIN, then the numbers 1 through 40 with one number per line, then END.')
    await vi.runAllTicks()
    adapter.responseBuffer = 'Reply with BEGIN, then the numbers 1 through 40 with one number per line, then END.'
    await vi.advanceTimersByTimeAsync(1000)
    await expect(sendPromise).resolves.toBeUndefined()
    expect(adapter.ptyProcess.write).toHaveBeenCalledTimes(1)
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('Reply with BEGIN, then the numbers 1 through 40 with one number per line, then END.\r')
  })

  it('skips rich parse on settled idle output when there is no active response turn', () => {
    const parseOutput = vi.fn(() => ({ status: 'idle', messages: [] }))
    const adapter = new ProviderCliAdapter({
      type: 'hermes-cli',
      name: 'Hermes Agent',
      category: 'cli',
      binary: 'hermes',
      spawn: {
        command: 'hermes',
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
    adapter.ready = true
    adapter.startupParseGate = false
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.currentTurnScope = null
    adapter.activeModal = null
    adapter.recentOutputBuffer = '❯\n'
    adapter.settledBuffer = '❯\n'
    adapter.terminalScreen = { getText: () => '❯\n' }

    adapter.evaluateSettled()

    expect(parseOutput).not.toHaveBeenCalled()
    expect(adapter.currentStatus).toBe('idle')
  })

  it('allows an intervention prompt during generation for providers that explicitly opt in', async () => {
    const adapter = buildAdapter({ allowInputDuringGeneration: true })

    await expect(adapter.sendMessage('interrupt now')).resolves.toBeUndefined()
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('interrupt now\r')
  })

  it('force-sends immediately while generating instead of adding to the pending queue', async () => {
    const adapter = buildAdapter()

    await expect(adapter.sendMessage('send now', { force: true })).resolves.toBeUndefined()

    expect(adapter.pendingOutboundQueue).toHaveLength(0)
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('send now\r')
  })

  it('surfaces async PTY write failures instead of reporting sendMessage success', async () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.ptyProcess.write = vi.fn().mockRejectedValue(new Error('runtime not ready'))

    await expect(adapter.sendMessage('will fail')).rejects.toThrow('runtime not ready')
    expect(adapter.getStatus().messages).toEqual([])
    expect(adapter.isWaitingForResponse).toBe(false)
  })

  it('submits required-echo sends after the full echo wait instead of leaving typed input pending', async () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.submitStrategy = 'wait_for_echo'
    adapter.requirePromptEchoBeforeSubmit = true
    adapter.sendDelayMs = 0
    adapter.terminalScreen = { getText: () => '⚕ ❯ \n' }

    const sendPromise = adapter.sendMessage('prompt that never echoes')
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(2500)

    await expect(sendPromise).resolves.toBeUndefined()
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('prompt that never echoes')
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('\r')
    expect(adapter.isWaitingForResponse).toBe(true)
  })

  it('surfaces writeRaw when the runtime is missing or rejects input', async () => {
    const adapter = buildAdapter()
    adapter.ptyProcess = null

    await expect(adapter.writeRaw('x')).rejects.toThrow('not running')

    adapter.ptyProcess = { write: vi.fn().mockRejectedValue(new Error('send_input failed')) }
    await expect(adapter.writeRaw('x')).rejects.toThrow('send_input failed')
  })

  it('does not block a new prompt solely because approval state is surfaced', async () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'waiting_approval'
    adapter.isWaitingForResponse = false
    adapter.activeModal = {
      message: 'Approval requested',
      buttons: ['Allow once', 'Deny'],
    }
    adapter.terminalScreen = {
      getText: () => '⚠️ Dangerous Command\nAllow once\nDeny\n❯\n'
    }

    await expect(adapter.sendMessage('continue anyway')).resolves.toBeUndefined()
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('continue anyway\r')
  })

  it('resolves numeric approval menus with an explicit confirm prompt using selection plus enter', () => {
    const adapter = new ProviderCliAdapter({
      type: 'menu-cli',
      name: 'Menu CLI',
      category: 'cli',
      binary: 'menu-cli',
      spawn: {
        command: 'menu-cli',
        args: [],
        shell: true,
        env: {},
      },
      approvalKeys: { 0: '1\r', 1: '2\r' },
      scripts: {
        detectStatus: () => 'waiting_approval',
        parseApproval: () => null,
      },
    } as any, '/tmp/project') as any

    adapter.ptyProcess = { write: vi.fn() }
    adapter.currentStatus = 'waiting_approval'
    adapter.activeModal = {
      message: 'Choose access level',
      buttons: ['Trust this workspace', 'Exit'],
    }
    adapter.recentOutputBuffer = 'Choose access level\n❯ 1. Trust this workspace\n2. Exit\nEnter to confirm\n'
    adapter.terminalScreen = {
      getText: () => 'Choose access level\n❯ 1. Trust this workspace\n2. Exit\nEnter to confirm'
    }

    adapter.resolveModal(0)

    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('1\r')
  })

  it('does not synthesize a generic approval modal when detectStatus says waiting_approval but parseApproval returns null', () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'generating'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = {
      prompt: 'delete it',
      startedAt: 10,
      bufferStart: 0,
      rawBufferStart: 0,
    }
    adapter.activeModal = null
    adapter.runDetectStatus = () => 'waiting_approval'
    adapter.runParseApproval = () => null
    adapter.parseCurrentTranscript = () => ({
      status: 'waiting_approval',
      messages: [
        { role: 'user', content: 'delete it' },
      ],
      activeModal: null,
    })

    adapter.evaluateSettled()

    expect(adapter.currentStatus).toBe('generating')
    expect(adapter.activeModal).toBeNull()
  })

  it('projects startup detectStatus waiting_approval even when parseApproval cannot build buttons', () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'starting'
    adapter.ready = false
    adapter.startupParseGate = true
    adapter.activeModal = null
    adapter.isWaitingForResponse = false
    adapter.recentOutputBuffer = 'Do you trust the contents of this directory?\n1. Yes, continue\nPress enter to continue\n'
    adapter.terminalScreen = { getText: () => adapter.recentOutputBuffer }
    adapter.runParseApproval = vi.fn(() => null)
    adapter.runDetectStatus = vi.fn(() => 'waiting_approval')

    expect(adapter.getStatus()).toMatchObject({
      status: 'waiting_approval',
      activeModal: null,
    })
    expect(adapter.getDebugState()).toMatchObject({
      status: 'waiting_approval',
      ready: true,
      activeModal: null,
    })
  })

  it('does not synthesize a generic resolveAction prompt when the provider does not supply a resolver script', async () => {
    const adapter = buildAdapter()
    adapter.sendMessage = vi.fn().mockResolvedValue(undefined)
    adapter.cliScripts = {}

    await adapter.resolveAction({
      title: 'Lint error',
      explanation: 'unused variable',
      message: 'fix it',
    })

    expect(adapter.sendMessage).not.toHaveBeenCalled()
  })

  it('does not clamp parsed generating status to idle while Hermes interrupt prompt is visible', () => {
    const adapter = buildAdapter({ allowInputDuringGeneration: true })
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.currentTurnScope = null
    adapter.recentOutputBuffer = '⚕ ❯ type a message + Enter to interrupt, Ctrl+C to cancel\n'
    adapter.accumulatedBuffer = [
      '● Please inspect the workspace.',
      '╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮',
      'I am still checking a couple more files...',
      '╰──────────────────────────────────────────────────────────────────────────────╯',
      '⚕ ❯ type a message + Enter to interrupt, Ctrl+C to cancel',
    ].join('\n')
    adapter.accumulatedRawBuffer = adapter.accumulatedBuffer
    adapter.terminalScreen = { getText: () => adapter.accumulatedBuffer }
    adapter.cliScripts.detectStatus = () => 'generating'
    adapter.cliScripts.parseApproval = () => null
    adapter.cliScripts.parseSession = () => ({
      status: 'generating',
      parsedStatus: 'generating',
      messages: [
        { role: 'user', content: 'Please inspect the workspace.' },
        { role: 'assistant', content: 'I am still checking a couple more files...' },
      ],
      modal: null,
    })

    const parsed = adapter.getScriptParsedStatus()

    expect(parsed.status).toBe('generating')
  })

  it('still clamps stale parsed generating status when interrupt copy is only assistant text', () => {
    const adapter = buildAdapter({ allowInputDuringGeneration: true })
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.currentTurnScope = null
    adapter.recentOutputBuffer = '❯\n'
    adapter.accumulatedBuffer = [
      '● Please quote the interrupt prompt.',
      '╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮',
      'Literal text: type a message + Enter to interrupt, Ctrl+C to cancel',
      '╰──────────────────────────────────────────────────────────────────────────────╯',
      '❯',
    ].join('\n')
    adapter.accumulatedRawBuffer = adapter.accumulatedBuffer
    adapter.terminalScreen = { getText: () => adapter.accumulatedBuffer }
    adapter.cliScripts.detectStatus = () => 'generating'
    adapter.cliScripts.parseApproval = () => null
    adapter.cliScripts.parseSession = () => ({
      status: 'generating',
      parsedStatus: 'generating',
      messages: [
        { role: 'user', content: 'Please quote the interrupt prompt.' },
        { role: 'assistant', content: 'Literal text: type a message + Enter to interrupt, Ctrl+C to cancel' },
      ],
      modal: null,
    })

    const parsed = adapter.getScriptParsedStatus()

    expect(parsed.status).toBe('generating')
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
    adapter.cliScripts.parseSession = () => ({
      status: 'waiting_approval',
      parsedStatus: 'waiting_approval',
      messages: [
        { role: 'user', content: 'dangerous prompt' },
        { role: 'assistant', content: 'Approval requested', kind: 'system' },
      ],
      modal: {
        message: 'Dangerous command requires approval',
        buttons: ['Allow once', 'Deny'],
      },
    })

    const parsed = adapter.getScriptParsedStatus()

    expect(parsed.status).toBe('waiting_approval')
    expect(parsed.activeModal).toEqual({
      message: 'Dangerous command requires approval',
      buttons: ['Allow once', 'Deny'],
    })
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
    adapter.runDetectStatus = vi.fn(() => 'idle')

    adapter.resolveStartupState('startup_timer')

    expect(adapter.startupParseGate).toBe(false)
    expect(adapter.ready).toBe(true)
    expect(adapter.currentStatus).toBe('idle')
    expect(adapter.activeModal).toBeNull()
  })

  it('does not mark startup ready while provider status detection still reports generating', () => {
    const adapter = buildAdapter()
    adapter.startupParseGate = true
    adapter.ready = false
    adapter.currentStatus = 'starting'
    adapter.activeModal = null
    adapter.lastScreenChangeAt = Date.now() - 3000
    adapter.recentOutputBuffer = '• Starting MCP servers (1/2): codex_apps (11s • esc to interrupt)\n'
    adapter.terminalScreen = {
      getText: () => [
        '• Starting MCP servers (1/2): codex_apps (11s • esc to interrupt)',
        '',
        '› Explain this codebase',
      ].join('\n'),
    }
    adapter.runDetectStatus = vi.fn(() => 'generating')
    adapter.runParseApproval = vi.fn(() => null)
    adapter.scheduleStartupSettleCheck = vi.fn()

    adapter.resolveStartupState('startup_timer')

    expect(adapter.startupParseGate).toBe(true)
    expect(adapter.ready).toBe(false)
    expect(adapter.currentStatus).toBe('starting')
    expect(adapter.scheduleStartupSettleCheck).toHaveBeenCalled()
  })

  it('projects startup as idle when Codex shows a visible idle prompt before the internal startup state settles', () => {
    const adapter = buildAdapter()
    adapter.cliType = 'codex-cli'
    adapter.cliName = 'Codex CLI'
    adapter.startupParseGate = true
    adapter.ready = false
    adapter.currentStatus = 'starting'
    adapter.activeModal = null
    adapter.recentOutputBuffer = 'OpenAI Codex\n› gpt-5.1 codex · /model\n'
    adapter.terminalScreen = {
      getText: () => 'OpenAI Codex\n› gpt-5.1 codex · /model\n',
    }
    adapter.runDetectStatus = vi.fn(() => 'idle')
    adapter.runParseApproval = vi.fn(() => null)

    expect(adapter.getStatus().status).toBe('idle')
  })

  it('recovers Codex send readiness when the idle prompt is visible but internal status is still starting', async () => {
    const adapter = buildAdapter()
    adapter.cliType = 'codex-cli'
    adapter.cliName = 'Codex CLI'
    adapter.startupParseGate = false
    adapter.ready = false
    adapter.currentStatus = 'starting'
    adapter.isWaitingForResponse = false
    adapter.currentTurnScope = null
    adapter.activeModal = null
    adapter.recentOutputBuffer = 'OpenAI Codex\n› gpt-5.1 codex · /model\n'
    adapter.terminalScreen = {
      getText: () => 'OpenAI Codex\n› gpt-5.1 codex · /model\n',
    }
    adapter.runDetectStatus = vi.fn(() => 'idle')
    adapter.runParseApproval = vi.fn(() => null)

    await expect(adapter.sendMessage('continue previous checks')).resolves.toBeUndefined()
    expect(adapter.ready).toBe(true)
    expect(adapter.currentStatus).toBe('idle')
    expect(adapter.currentTurnScope?.prompt).toBe('continue previous checks')
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('continue previous checks\r')
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

  it('projects parsed generating status from debug state when raw status is idle and no final assistant exists', () => {
    const adapter = buildAdapter()
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.currentTurnScope = null
    adapter.startupParseGate = false
    adapter.ready = true
    adapter.recentOutputBuffer = '• Starting work\n'
    adapter.accumulatedBuffer = adapter.recentOutputBuffer
    adapter.accumulatedRawBuffer = adapter.recentOutputBuffer
    adapter.terminalScreen = { getText: () => '• Starting work\n' }
    adapter.cliScripts.parseSession = () => ({
      status: 'generating',
      messages: [
        { role: 'user', content: 'create the file' },
      ],
      activeModal: null,
    })

    expect(adapter.getDebugState().status).toBe('generating')
  })

  it('keeps Codex generating when finish is attempted on tool-call activity instead of a final answer', () => {
    const adapter = buildAdapter()
    adapter.cliType = 'codex-cli'
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = {
      prompt: 'continue validation',
      startedAt: Date.now() - 30_000,
      bufferStart: 0,
      rawBufferStart: 0,
    }
    adapter.runParseSession = vi.fn(() => ({
      status: 'idle',
      messages: [
        { role: 'user', content: 'continue validation' },
        { role: 'assistant', kind: 'tool', content: 'functions.write_stdin({"session_id":123,"yield_time_ms":30000})' },
      ],
      activeModal: null,
    }))
    adapter.commitCurrentTranscript = vi.fn(() => ({ hasAssistant: true, assistantContent: 'tool activity' }))

    adapter.finishResponse()

    expect(adapter.isWaitingForResponse).toBe(true)
    expect(adapter.currentTurnScope?.prompt).toBe('continue validation')
    expect(adapter.currentStatus).toBe('generating')
    expect(adapter.commitCurrentTranscript).not.toHaveBeenCalled()
  })

  it('allows Codex finish once parsed idle has a final standard assistant answer', () => {
    const adapter = buildAdapter()
    adapter.cliType = 'codex-cli'
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = {
      prompt: 'finish validation',
      startedAt: Date.now() - 30_000,
      bufferStart: 0,
      rawBufferStart: 0,
    }
    adapter.runParseSession = vi.fn(() => ({
      status: 'idle',
      messages: [
        { role: 'user', content: 'finish validation' },
        { role: 'assistant', kind: 'standard', content: 'Validation is complete.' },
      ],
      activeModal: null,
    }))
    adapter.commitCurrentTranscript = vi.fn(() => ({ hasAssistant: true, assistantContent: 'Validation is complete.' }))

    adapter.finishResponse()

    expect(adapter.isWaitingForResponse).toBe(false)
    expect(adapter.currentTurnScope).toBe(null)
    expect(adapter.currentStatus).toBe('idle')
    expect(adapter.commitCurrentTranscript).toHaveBeenCalled()
  })
})
