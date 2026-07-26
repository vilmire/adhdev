import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'
import { CliStateEngine } from '../../src/cli-adapters/cli-state-engine.js'

function buildAdapter() {
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

describe('Outbound Queue Delivery ACK & Post-Idle Flush', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('verifies that flushOutboundQueue fires at the end of the idle confirmation grace period and drains the queue', async () => {
    const adapter = buildAdapter()
    
    // Simulate active generating session
    adapter.currentStatus = 'generating'
    adapter.isWaitingForResponse = true
    
    // Send a message which will be queued
    const sendResult = await adapter.sendMessage('queued prompt')
    expect(sendResult).toEqual({ status: 'queued' })
    expect(adapter.pendingOutboundQueue).toHaveLength(1)
    
    // Simulate finishing response
    adapter.engine.finishResponse()
    
    // At this exact moment, flushOutboundQueue should have been called but bypassed
    // because currentStatus is still generating.
    expect(adapter.engine.currentStatus).toBe('generating')
    expect(adapter.pendingOutboundQueue).toHaveLength(1)
    expect(adapter.ptyProcess.write).not.toHaveBeenCalled()
    
    // Now simulate the prompt settling.
    adapter.engine.isWaitingForResponse = false
    
    // Wait for the IDLE_CONFIRMATION_GRACE_MS (2000ms) to fire
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(10)
    
    // Status should now be idle, and the pending queue should have been flushed!
    expect(adapter.engine.currentStatus).toBe('idle')
    expect(adapter.pendingOutboundQueue).toHaveLength(0)
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('queued prompt\r')
  })
})
