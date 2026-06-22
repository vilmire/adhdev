import { describe, expect, it, vi } from 'vitest'

import { DaemonCliManager } from '../../src/commands/cli-manager.js'

function createManager(adapterStatus = 'idle', options: {
  parsedStatus?: string
  pending?: boolean
  parsedMessages?: any[]
} = {}) {
  const sendMessage = vi.fn(async () => {})
  const adapter = {
    cliType: 'hermes-cli',
    cliName: 'Hermes Agent',
    workingDir: '/repo',
    spawn: vi.fn(async () => {}),
    sendMessage,
    forceSendMessage: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({ status: adapterStatus, activeModal: null, messages: [] })),
    getScriptParsedStatus: vi.fn(() => ({
      status: options.parsedStatus || adapterStatus,
      activeModal: null,
      messages: options.parsedMessages || [],
    })),
    getPartialResponse: vi.fn(() => ''),
    shutdown: vi.fn(),
    cancel: vi.fn(),
    isProcessing: vi.fn(() => options.pending ?? adapterStatus !== 'idle'),
    isReady: vi.fn(() => adapterStatus === 'idle'),
    setOnStatusChange: vi.fn(),
  }
  const manager = new DaemonCliManager({
    getServerConn: () => null,
    getP2p: () => null,
    onStatusChange: vi.fn(),
    removeAgentTracking: vi.fn(),
    getInstanceManager: () => null,
  }, {
    resolve: vi.fn(() => ({ type: 'hermes-cli', category: 'cli' })),
    getMeta: vi.fn(() => ({ type: 'hermes-cli', category: 'cli' })),
  } as any)
  manager.adapters.set('session-1', adapter as any)
  return { manager, adapter, sendMessage }
}

describe('DaemonCliManager agent_command', () => {
  it('accepts send_chat while the runtime is generating and leaves queueing to the adapter', async () => {
    const { manager, sendMessage } = createManager('generating')

    const result = await manager.handleCliCommand('agent_command', {
      targetSessionId: 'session-1',
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'next task',
    })

    expect(result).toMatchObject({
      success: true,
      status: 'generating',
      queued: true,
      queuedReason: 'agent_runtime_busy',
    })
    expect(String(result?.error || '')).not.toContain('retry after the current turn finishes')
    expect(sendMessage).toHaveBeenCalledWith('next task')
  })

  it('force-sends while generating when requested', async () => {
    const { manager, adapter, sendMessage } = createManager('generating')

    const result = await manager.handleCliCommand('agent_command', {
      targetSessionId: 'session-1',
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'urgent follow-up',
      force: true,
    })

    expect(result).toMatchObject({
      success: true,
      status: 'generating',
      forceSent: true,
      queued: false,
    })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(adapter.forceSendMessage).toHaveBeenCalledWith('urgent follow-up')
  })

  it('dispatches send_chat when the target runtime is idle', async () => {
    const { manager, sendMessage } = createManager('idle')

    const result = await manager.handleCliCommand('agent_command', {
      targetSessionId: 'session-1',
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'next task',
    })

    expect(result).toMatchObject({ success: true, status: 'generating' })
    expect(sendMessage).toHaveBeenCalledWith('next task')
  })

  it('accepts send_chat when read_chat parser status is still generating', async () => {
    const { manager, sendMessage } = createManager('idle', {
      parsedStatus: 'generating',
      pending: true,
    })

    const result = await manager.handleCliCommand('agent_command', {
      targetSessionId: 'session-1',
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'next task',
    })

    expect(result).toMatchObject({
      success: true,
      status: 'generating',
      queued: true,
      queuedReason: 'agent_runtime_busy',
    })
    expect(sendMessage).toHaveBeenCalledWith('next task')
  })

  it('does not reject the first task for a zero-message starting launch state', async () => {
    vi.useFakeTimers()
    try {
      const { manager, sendMessage } = createManager('starting', {
        parsedStatus: 'generating',
        pending: false,
      })

      const resultPromise = manager.handleCliCommand('agent_command', {
        targetSessionId: 'session-1',
        agentType: 'hermes-cli',
        cliType: 'hermes-cli',
        action: 'send_chat',
        message: 'first task',
      })

      await Promise.resolve()
      expect(sendMessage).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2_000)

      await expect(resultPromise).resolves.toMatchObject({ success: true, status: 'generating' })
      expect(sendMessage).toHaveBeenCalledWith('first task')
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispatches send_chat when startup status is stale but parser has a final idle assistant', async () => {
    const { manager, sendMessage } = createManager('starting', {
      parsedStatus: 'idle',
      pending: false,
      parsedMessages: [
        { role: 'assistant', content: 'ㅇㅇ에 대해 ㅇㅇ. 뭘 도와드릴까요?', bubbleState: 'final' },
      ],
    })

    const result = await manager.handleCliCommand('agent_command', {
      targetSessionId: 'session-1',
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'next task',
    })

    expect(result).toMatchObject({ success: true, status: 'generating' })
    expect(sendMessage).toHaveBeenCalledWith('next task')
  })

  it('does not deadlock on stale parser busy once adapter idle has no pending evidence', async () => {
    const { manager, sendMessage } = createManager('idle', {
      parsedStatus: 'generating',
      pending: false,
    })

    const result = await manager.handleCliCommand('agent_command', {
      targetSessionId: 'session-1',
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'next task',
    })

    expect(result).toMatchObject({ success: true, status: 'generating' })
    expect(sendMessage).toHaveBeenCalledWith('next task')
  })

  // TASKECHO fix #1: findAdapter must fail closed when an explicit targetSessionId is
  // given but not hosted locally. Previously it fuzzy-fell-back to the first same-cliType
  // adapter (the coordinator's own session), echoing the dispatched task body back to the
  // coordinator. It must now throw instead of mis-delivering to an unrelated session.
  it('fails closed: an explicit targetSessionId that is not hosted locally is NOT fuzzy-redirected', async () => {
    const { manager, sendMessage } = createManager('idle')

    await expect(manager.handleCliCommand('agent_command', {
      targetSessionId: 'session-on-another-daemon',
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'task body that must NOT echo into the local session',
    })).rejects.toThrow(/CLI agent not running/)

    // The local same-cliType session ('session-1') must NOT have received the message.
    expect(sendMessage).not.toHaveBeenCalled()
  })

  // Regression: the fuzzy fallback is preserved when NO targetSessionId is requested
  // (sessionless dispatch — let the worker daemon pick its single live session).
  it('still fuzzy-matches the single same-cliType session when no targetSessionId is given', async () => {
    const { manager, sendMessage } = createManager('idle')

    const result = await manager.handleCliCommand('agent_command', {
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'next task',
    })

    expect(result).toMatchObject({ success: true, status: 'generating' })
    expect(sendMessage).toHaveBeenCalledWith('next task')
  })
})
