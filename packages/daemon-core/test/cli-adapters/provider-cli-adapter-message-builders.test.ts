import { describe, expect, it } from 'vitest'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'

describe('ProviderCliAdapter message fallback shaping', () => {
  it('preserves the full committed transcript when parseOutput is unavailable', () => {
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

    adapter.committedMessages = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
      timestamp: index + 1,
      receivedAt: index + 1,
      id: `msg-${index + 1}`,
      index,
    }))
    adapter.currentStatus = 'idle'
    adapter.activeModal = null
    adapter.cliName = 'Test CLI'

    const status = adapter.getScriptParsedStatus()

    expect(status.messages).toHaveLength(80)
    expect(status.messages[0]).toMatchObject({
      content: 'message-1',
      id: 'msg-1',
      index: 0,
    })
    expect(status.messages[79]).toMatchObject({
      content: 'message-80',
      id: 'msg-80',
      index: 79,
    })
  })

  it('throws instead of silently falling back when parseOutput crashes', () => {
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
        parseOutput: () => {
          throw new Error('parse exploded')
        },
      },
    } as any, '/tmp/project') as any

    adapter.committedMessages = [{ role: 'assistant', content: 'old', timestamp: 1 }]

    expect(() => adapter.getScriptParsedStatus()).toThrow('parse exploded')
  })
})
