import { describe, expect, it, vi, afterEach } from 'vitest'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'

function buildAdapter(type: string) {
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
    // Replicate the provider.json timeout values so the test reflects real config.
    // hermes-cli uses 5000ms for both idleFinishConfirm and statusActivityHold;
    // other providers use the default 2000ms.
    allowInputDuringGeneration: isHermes,
    timeouts: isHermes
      ? { idleFinishConfirm: 5000, statusActivityHold: 5000 }
      : {},
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

  it('keeps hermes-cli turns open for 5s before finishing an idle-looking screen when the settled transcript still has no assistant turn', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-15T15:00:00Z'))

    const adapter = buildAdapter('hermes-cli')
    const finishResponse = vi.fn()
    adapter.finishResponse = finishResponse
    adapter.parseCurrentTranscript = () => ({
      status: 'idle',
      messages: [],
    })

    adapter.evaluateSettled()
    expect(finishResponse).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(4_000)
    expect(finishResponse).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(finishResponse).toHaveBeenCalledTimes(1)
  })

  it('commits the settled transcript immediately when Hermes parseOutput already contains the assistant turn even if the screen only shows idle chrome', () => {
    const adapter = buildAdapter('hermes-cli')
    adapter.committedMessages = [{ role: 'user', content: 'hello', timestamp: 1 }]
    adapter.syncMessageViews()
    adapter.currentStatus = 'generating'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = {
      prompt: 'hello',
      startedAt: 10,
      bufferStart: 0,
      rawBufferStart: 0,
    }
    adapter.terminalScreen = { getText: () => '❯' }
    adapter.parseCurrentTranscript = () => ({
      status: 'idle',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'done' },
      ],
    })

    adapter.evaluateSettled()

    expect(adapter.currentStatus).toBe('idle')
    expect(adapter.isWaitingForResponse).toBe(false)
    expect(adapter.currentTurnScope).toBeNull()
    expect(adapter.committedMessages).toHaveLength(2)
    expect(adapter.committedMessages[1].content).toBe('done')
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

  it('commits a visible assistant turn immediately when parseOutput already reports idle during an active Hermes turn', () => {
    const adapter = buildAdapter('hermes-cli')
    adapter.committedMessages = [{ role: 'user', content: 'hello', timestamp: 1 }]
    adapter.syncMessageViews()
    adapter.currentStatus = 'generating'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = {
      prompt: 'hello',
      startedAt: 10,
      bufferStart: 0,
      rawBufferStart: 0,
    }
    adapter.parseCurrentTranscript = () => ({
      status: 'idle',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'done' },
      ],
    })

    const result = adapter.getScriptParsedStatus()

    expect(adapter.currentStatus).toBe('idle')
    expect(adapter.isWaitingForResponse).toBe(false)
    expect(adapter.currentTurnScope).toBeNull()
    expect(adapter.committedMessages).toHaveLength(2)
    expect(adapter.committedMessages[1].content).toBe('done')
    expect(result.status).toBe('idle')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1].content).toBe('done')
  })

  it('adopts a richer parsed idle Hermes transcript even after the active turn scope has already been cleared', () => {
    const adapter = buildAdapter('hermes-cli')
    adapter.committedMessages = [{ role: 'user', content: 'hello', timestamp: 1 }]
    adapter.syncMessageViews()
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.currentTurnScope = null
    adapter.activeModal = null
    adapter.parseCurrentTranscript = () => ({
      status: 'idle',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'done later' },
      ],
    })

    const result = adapter.getScriptParsedStatus()

    expect(adapter.committedMessages).toHaveLength(2)
    expect(adapter.committedMessages[1].content).toBe('done later')
    expect(result.status).toBe('idle')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1].content).toBe('done later')
  })

  it('adopts a richer parsed idle Hermes transcript when message count is unchanged but the final assistant turn is fuller', () => {
    const adapter = buildAdapter('hermes-cli')
    adapter.committedMessages = [
      { role: 'user', content: 'hello', timestamp: 1 },
      { role: 'assistant', content: 'partial answer', timestamp: 2 },
    ]
    adapter.syncMessageViews()
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.currentTurnScope = null
    adapter.activeModal = null
    adapter.parseCurrentTranscript = () => ({
      status: 'idle',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'partial answer with the full tail visible now' },
      ],
    })

    const result = adapter.getScriptParsedStatus()

    expect(adapter.committedMessages).toHaveLength(2)
    expect(adapter.committedMessages[1].content).toBe('partial answer with the full tail visible now')
    expect(result.status).toBe('idle')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1].content).toBe('partial answer with the full tail visible now')
  })

  it('adopts a richer parsed idle Hermes transcript when the turn scope is already cleared but stale generating state is still hanging around', () => {
    const adapter = buildAdapter('hermes-cli')
    adapter.committedMessages = [{ role: 'user', content: 'hello', timestamp: 1 }]
    adapter.syncMessageViews()
    adapter.currentStatus = 'generating'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = null
    adapter.activeModal = null
    adapter.terminalScreen = {
      getText: () => [
        '╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮',
        'done after visible box',
        '╰──────────────────────────────────────────────────────────────────────────────╯',
        '❯',
      ].join('\n'),
    }
    adapter.parseCurrentTranscript = () => ({
      status: 'idle',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'done after visible box' },
      ],
    })

    const result = adapter.getScriptParsedStatus()

    expect(adapter.committedMessages).toHaveLength(2)
    expect(adapter.committedMessages[1].content).toBe('done after visible box')
    expect(adapter.currentStatus).toBe('idle')
    expect(adapter.isWaitingForResponse).toBe(false)
    expect(result.status).toBe('idle')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1].content).toBe('done after visible box')
  })

  it('promotes Hermes back to generating when parsed transcript is still live even if the turn scope was cleared early', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-21T12:30:00Z'))

    const adapter = buildAdapter('hermes-cli')
    adapter.committedMessages = [{ role: 'user', content: 'hello', timestamp: 1 }]
    adapter.syncMessageViews()
    adapter.currentStatus = 'idle'
    adapter.isWaitingForResponse = false
    adapter.currentTurnScope = null
    adapter.activeModal = null
    adapter.runDetectStatus = () => 'generating'
    adapter.terminalScreen = {
      getText: () => [
        'Welcome to Hermes Agent! Type your message or /help for commands.',
        '● hello',
        '╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮',
        'Still checking a couple more files...',
        '❯',
      ].join('\n'),
    }
    adapter.parseCurrentTranscript = () => ({
      status: 'generating',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Still checking a couple more files...' },
      ],
    })

    adapter.evaluateSettled()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(adapter.currentStatus).toBe('generating')
    expect(adapter.getStatus().status).toBe('generating')
  })

  it('promotes Hermes into waiting_approval when parsed transcript surfaces approval even if detectStatus is still generating', () => {
    const adapter = buildAdapter('hermes-cli')
    adapter.currentStatus = 'generating'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = {
      prompt: 'delete it',
      startedAt: 10,
      bufferStart: 0,
      rawBufferStart: 0,
    }
    adapter.runDetectStatus = () => 'generating'
    adapter.runParseApproval = () => null
    adapter.parseCurrentTranscript = () => ({
      status: 'waiting_approval',
      messages: [
        { role: 'user', content: 'delete it' },
        { role: 'assistant', kind: 'terminal', content: '$ rm /tmp/file' },
      ],
      activeModal: {
        message: 'Deleting /tmp/file requires approval. Approve the delete?',
        buttons: ['Approve delete', 'Do not delete', 'Other (type your answer)'],
      },
    })

    adapter.evaluateSettled()

    expect(adapter.currentStatus).toBe('waiting_approval')
    expect(adapter.activeModal).toEqual({
      message: 'Deleting /tmp/file requires approval. Approve the delete?',
      buttons: ['Approve delete', 'Do not delete', 'Other (type your answer)'],
    })
  })

  it('promotes adapter state from parsed waiting_approval during read-chat parsing so resolve_action can see the live modal', () => {
    const adapter = buildAdapter('hermes-cli')
    adapter.currentStatus = 'generating'
    adapter.isWaitingForResponse = true
    adapter.currentTurnScope = {
      prompt: 'run the command',
      startedAt: 10,
      bufferStart: 0,
      rawBufferStart: 0,
    }
    adapter.activeModal = null
    adapter.terminalScreen = {
      getText: () => '⚠️ Dangerous Command\n❯ Allow once\nAllow for this session\nAdd to permanent allowlist\nDeny',
    }
    adapter.parseCurrentTranscript = () => ({
      status: 'waiting_approval',
      messages: [
        { role: 'user', content: 'run the command' },
        { role: 'assistant', kind: 'system', content: 'Approval requested' },
      ],
      activeModal: {
        message: 'Dangerous command needs approval',
        buttons: ['Allow once', 'Allow for this session', 'Add to permanent allowlist', 'Deny'],
      },
    })

    const parsed = adapter.getScriptParsedStatus()

    expect(parsed.status).toBe('waiting_approval')
    expect(parsed.activeModal).toEqual({
      message: 'Dangerous command needs approval',
      buttons: ['Allow once', 'Allow for this session', 'Add to permanent allowlist', 'Deny'],
    })
    expect(adapter.currentStatus).toBe('waiting_approval')
    expect(adapter.getStatus().status).toBe('waiting_approval')
    expect(adapter.getStatus().activeModal).toEqual({
      message: 'Dangerous command needs approval',
      buttons: ['Allow once', 'Allow for this session', 'Add to permanent allowlist', 'Deny'],
    })
  })

  it('projects waiting_approval from activeModal even if the raw adapter status is still generating', () => {
    const adapter = buildAdapter('hermes-cli')
    adapter.currentStatus = 'generating'
    adapter.activeModal = {
      message: 'Dangerous command needs approval',
      buttons: ['Allow once', 'Deny'],
    }

    expect(adapter.getStatus().status).toBe('waiting_approval')
    expect(adapter.getDebugState().status).toBe('waiting_approval')
  })

  it('projects waiting_approval from parsed transcript even before adapter.activeModal has been synchronized', () => {
    const adapter = buildAdapter('hermes-cli')
    adapter.currentStatus = 'generating'
    adapter.activeModal = null
    adapter.terminalScreen = {
      getText: () => '⚠️ Dangerous Command\n❯ Allow once\nAllow for this session\nAdd to permanent allowlist\nDeny',
    }
    adapter.parseCurrentTranscript = () => ({
      status: 'waiting_approval',
      messages: [
        { role: 'user', content: 'run the command' },
        { role: 'assistant', kind: 'system', content: 'Approval requested' },
      ],
      activeModal: {
        message: 'Dangerous command needs approval',
        buttons: ['Allow once', 'Allow for this session', 'Add to permanent allowlist', 'Deny'],
      },
    })

    expect(adapter.getStatus().status).toBe('waiting_approval')
    expect(adapter.getStatus().activeModal).toEqual({
      message: 'Dangerous command needs approval',
      buttons: ['Allow once', 'Allow for this session', 'Add to permanent allowlist', 'Deny'],
    })
  })

  it('resolves approval from parsed transcript even before adapter.activeModal has been synchronized', () => {
    const adapter = buildAdapter('hermes-cli')
    const write = vi.fn()
    adapter.ptyProcess = { write }
    adapter.currentStatus = 'generating'
    adapter.activeModal = null
    adapter.terminalScreen = {
      getText: () => '⚠️ Dangerous Command\n❯ Allow once\nAllow for this session\nAdd to permanent allowlist\nDeny',
    }
    adapter.parseCurrentTranscript = () => ({
      status: 'waiting_approval',
      messages: [
        { role: 'user', content: 'run the command' },
        { role: 'assistant', kind: 'system', content: 'Approval requested' },
      ],
      activeModal: {
        message: 'Dangerous command needs approval',
        buttons: ['Allow once', 'Allow for this session', 'Add to permanent allowlist', 'Deny'],
      },
    })

    adapter.resolveModal(3)

    expect(write).toHaveBeenCalledWith('\x1B[B\x1B[B\x1B[B\r')
  })

  it('eventually finishes an idle-looking screen for non-Hermes CLI providers when the settled transcript still has no assistant turn', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-15T15:00:00Z'))

    const adapter = buildAdapter('codex-cli')
    const finishResponse = vi.fn()
    adapter.finishResponse = finishResponse
    adapter.parseCurrentTranscript = () => ({
      status: 'idle',
      messages: [],
    })

    adapter.evaluateSettled()
    expect(finishResponse).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(finishResponse).toHaveBeenCalledTimes(1)
  })
})
