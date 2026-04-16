import { describe, expect, it, vi } from 'vitest'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'

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

  return adapter
}

describe('ProviderCliAdapter sendMessage guard', () => {
  it('rejects a new prompt while a response is still in progress instead of silently succeeding', async () => {
    const adapter = buildAdapter()

    await expect(adapter.sendMessage('second prompt')).rejects.toThrow('still processing')
    expect(adapter.ptyProcess.write).not.toHaveBeenCalled()
  })
})
