import { describe, expect, it, vi } from 'vitest'
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
  it('rejects a new prompt while a response is still in progress for providers that do not allow intervention', async () => {
    const adapter = buildAdapter()

    await expect(adapter.sendMessage('second prompt')).rejects.toThrow('still processing')
    expect(adapter.ptyProcess.write).not.toHaveBeenCalled()
  })

  it('allows an intervention prompt during generation for providers that explicitly opt in', async () => {
    const adapter = buildAdapter({ allowInputDuringGeneration: true })

    await expect(adapter.sendMessage('interrupt now')).resolves.toBeUndefined()
    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('interrupt now\r')
  })
})
