import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { ParsedIngestTimestampStamper } from '../../src/providers/cli-provider-ingest-times.js'

// Untimed parsed messages are stamped with their first-observed time before the
// merge (INGEST-TIMESTAMP), so each scenario below simulates two polls: the first
// parsed turn is observed before the runtime overlay, the second after it.

type TestInstance = CliProviderInstance & {
  runtimeMessages: Array<{ key: string; message: any }>
  parsedIngestTimestamps: ParsedIngestTimestampStamper
}

function makeInstance(runtimeMessages: Array<{ key: string; message: any }>): TestInstance {
  const instance = Object.create(CliProviderInstance.prototype) as TestInstance
  instance.runtimeMessages = runtimeMessages
  instance.parsedIngestTimestamps = new ParsedIngestTimestampStamper()
  return instance
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CliProviderInstance runtime message merge ordering', () => {
  it('keeps timed non-user-facing runtime overlays from becoming the final turn after untimed parsed assistant messages', () => {
    const instance = makeInstance([
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
    ])

    let clock = 100
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    // Poll 1: only the first parsed turn is visible (stamped at 100, before the overlay).
    instance.mergeRuntimeChatMessages([{ role: 'user', content: 'first parsed turn' } as any])

    // Poll 2: the assistant turn appears (stamped at 300, after the overlay).
    clock = 300
    const merged = instance.mergeRuntimeChatMessages([
      { role: 'user', content: 'first parsed turn' } as any,
      { role: 'assistant', content: 'second parsed turn' } as any,
    ])

    expect(merged.map((message) => message.content)).toEqual([
      'first parsed turn',
      'Runtime restored',
      'second parsed turn',
    ])
  })

  it('keeps timed auto-approval overlays from becoming the final turn after untimed parsed assistant messages', () => {
    const instance = makeInstance([
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
    ])

    let clock = 100
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    instance.mergeRuntimeChatMessages([{ role: 'user', content: 'first parsed turn' } as any])

    clock = 300
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
