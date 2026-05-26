import { describe, expect, it, vi } from 'vitest'

import { DaemonCliManager } from '../../src/commands/cli-manager.js'

function createManager(adapterStatus = 'idle', options: {
  parsedStatus?: string
  pending?: boolean
} = {}) {
  const sendMessage = vi.fn(async () => {})
  const adapter = {
    cliType: 'hermes-cli',
    cliName: 'Hermes Agent',
    workingDir: '/repo',
    spawn: vi.fn(async () => {}),
    sendMessage,
    getStatus: vi.fn(() => ({ status: adapterStatus, activeModal: null, messages: [] })),
    getScriptParsedStatus: vi.fn(() => ({
      status: options.parsedStatus || adapterStatus,
      activeModal: null,
      messages: [],
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
  it('returns retryable busy instead of blocking send_chat while the runtime is generating', async () => {
    const { manager, sendMessage } = createManager('generating')

    const result = await manager.handleCliCommand('agent_command', {
      targetSessionId: 'session-1',
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'next task',
    })

    expect(result).toMatchObject({
      success: false,
      code: 'agent_runtime_busy',
      reason: 'agent_runtime_busy',
      retryable: true,
      retryRecommended: true,
      status: 'generating',
      targetSessionId: 'session-1',
    })
    expect(String(result?.error)).toContain('retry after the current turn finishes')
    expect(sendMessage).not.toHaveBeenCalled()
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

  it('returns retryable busy when read_chat parser status is still generating', async () => {
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
      success: false,
      code: 'agent_runtime_busy',
      status: 'generating',
    })
    expect(sendMessage).not.toHaveBeenCalled()
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
})
