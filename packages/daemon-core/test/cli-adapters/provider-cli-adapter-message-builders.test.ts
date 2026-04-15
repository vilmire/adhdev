import { describe, expect, it } from 'vitest'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'

describe('ProviderCliAdapter message fallback shaping', () => {
  it('preserves committed message kinds and metadata when parseOutput is unavailable', () => {
    const adapter = new ProviderCliAdapter({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      binary: 'test-cli',
      spawn: {
        command: 'test-cli',
        args: [],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'idle',
        parseApproval: () => null,
      },
    } as any, '/tmp/project') as any

    adapter.committedMessages = [{
      role: 'assistant',
      content: '$ ls',
      kind: 'terminal',
      senderName: 'Terminal',
      timestamp: 456,
      receivedAt: 123,
      id: 'existing_terminal_message',
      index: 9,
    }]
    adapter.currentStatus = 'idle'
    adapter.activeModal = null
    adapter.cliName = 'Test CLI'

    const status = adapter.getScriptParsedStatus()

    expect(status.messages).toHaveLength(1)
    expect(status.messages[0]).toMatchObject({
      role: 'assistant',
      content: '$ ls',
      kind: 'terminal',
      senderName: 'Terminal',
      timestamp: 456,
      receivedAt: 123,
      id: 'existing_terminal_message',
      index: 9,
    })
  })
})
