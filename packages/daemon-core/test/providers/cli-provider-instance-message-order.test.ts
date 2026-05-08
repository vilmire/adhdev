import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

describe('CliProviderInstance runtime message merge ordering', () => {
  it('preserves parsed transcript order when parsed messages have no timestamps', () => {
    const instance = Object.create(CliProviderInstance.prototype) as CliProviderInstance & {
      runtimeMessages: Array<{ key: string; message: any }>
    }

    instance.runtimeMessages = [
      {
        key: 'runtime:recovery',
        message: {
          role: 'system',
          kind: 'system',
          content: 'Runtime restored',
          timestamp: 200,
          receivedAt: 200,
        },
      },
    ]

    const merged = instance.mergeRuntimeChatMessages([
      { role: 'user', content: 'first parsed turn' } as any,
      { role: 'assistant', content: 'second parsed turn' } as any,
    ])

    expect(merged.map((message) => message.content)).toEqual([
      'first parsed turn',
      'second parsed turn',
      'Runtime restored',
    ])
  })

  it('keeps timed auto-approval overlays from becoming the final turn after untimed parsed assistant messages', () => {
    const instance = Object.create(CliProviderInstance.prototype) as CliProviderInstance & {
      runtimeMessages: Array<{ key: string; message: any }>
    }

    instance.runtimeMessages = [
      {
        key: 'auto_approval:200:yes',
        message: {
          role: 'system',
          kind: 'system',
          senderName: 'System',
          content: 'Auto-approved: Yes',
          timestamp: 200,
          receivedAt: 200,
        },
      },
    ]

    const merged = instance.mergeRuntimeChatMessages([
      { role: 'user', content: 'first parsed turn' } as any,
      { role: 'assistant', content: 'second parsed turn' } as any,
    ])

    expect(merged.map((message) => message.content)).toEqual([
      'first parsed turn',
      'Auto-approved: Yes',
      'second parsed turn',
    ])
  })
})
