import { describe, expect, it, vi } from 'vitest'

import { DaemonCliManager } from '../../src/commands/cli-manager.js'

function createManager(adapterStatus = 'idle') {
  const sendMessage = vi.fn(async () => {})
  const adapter = {
    cliType: 'hermes-cli',
    cliName: 'Hermes Agent',
    workingDir: '/repo',
    spawn: vi.fn(async () => {}),
    sendMessage,
    getStatus: vi.fn(() => ({ status: adapterStatus, activeModal: null, messages: [] })),
    getPartialResponse: vi.fn(() => ''),
    shutdown: vi.fn(),
    cancel: vi.fn(),
    isProcessing: vi.fn(() => adapterStatus !== 'idle'),
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
})
