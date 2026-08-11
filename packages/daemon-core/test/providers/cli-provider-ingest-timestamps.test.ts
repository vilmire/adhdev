import { describe, expect, it, vi, afterEach } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { ParsedIngestTimestampStamper } from '../../src/providers/cli-provider-ingest-times.js'

// INGEST-TIMESTAMP regression: PTY-parsed provider messages (e.g. kimi's screen
// parser) carry no receivedAt/timestamp, while the runtime user-input ack does.
// mergeConversationMessages only interleaves by time when BOTH sides are timed,
// so the ack used to fall back to positional ordering — pinned AFTER every
// parsed message — and the web sort (untimed → key 0, sorted to the top) then
// rendered the user's own bubble below the assistant bubbles answering it.
// The daemon now stamps untimed parsed messages with their first-observed time
// so the ack interleaves by clock.

type TestInstance = CliProviderInstance & {
  runtimeMessages: Array<{ key: string; message: any }>
  parsedIngestTimestamps: ParsedIngestTimestampStamper
}

function makeInstance(): TestInstance {
  const instance = Object.create(CliProviderInstance.prototype) as TestInstance
  instance.runtimeMessages = []
  instance.parsedIngestTimestamps = new ParsedIngestTimestampStamper()
  return instance
}

function roles(merged: Array<{ role?: string; content?: unknown }>): string[] {
  return merged.map((message) => String(message.role))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ParsedIngestTimestampStamper', () => {
  it('stamps untimed messages with the current time', () => {
    const stamper = new ParsedIngestTimestampStamper()
    const [stamped] = stamper.stamp([{ role: 'assistant', content: 'hi' }], 1000)
    expect(stamped.receivedAt).toBe(1000)
  })

  it('keeps the first-observed stamp stable across polls', () => {
    const stamper = new ParsedIngestTimestampStamper()
    const [first] = stamper.stamp([{ role: 'assistant', content: 'hi' }], 1000)
    const [second] = stamper.stamp([{ role: 'assistant', content: 'hi' }], 5000)
    expect(first.receivedAt).toBe(1000)
    expect(second.receivedAt).toBe(1000)
  })

  it('leaves already-timed messages untouched', () => {
    const stamper = new ParsedIngestTimestampStamper()
    const message = { role: 'assistant', content: 'hi', receivedAt: 777 }
    const [stamped] = stamper.stamp([message], 1000)
    expect(stamped).toBe(message)
    expect(stamped.receivedAt).toBe(777)
  })

  it('evicts the oldest entries past the tracking cap so re-stamping assigns a new time', () => {
    const stamper = new ParsedIngestTimestampStamper()
    const first = Array.from({ length: 2001 }, (_, index) => ({
      role: 'assistant',
      content: `message-${index}`,
    }))
    stamper.stamp(first, 1000)
    const [restamped] = stamper.stamp([{ role: 'assistant', content: 'message-0' }], 9000)
    expect(restamped.receivedAt).toBe(9000)
    // A message still inside the cap keeps its original stamp.
    const [retained] = stamper.stamp([{ role: 'assistant', content: 'message-2000' }], 9500)
    expect(retained.receivedAt).toBe(1000)
  })
})

describe('CliProviderInstance ingest timestamp merge ordering', () => {
  it('interleaves the timed user-input ack between older and newer untimed parsed messages', () => {
    const instance = makeInstance()
    let clock = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)

    // Poll 1: the provider transcript shows only the previous turn, untimed.
    const priorTurn = { role: 'assistant', kind: 'standard', content: 'previous answer' }
    const firstMerge = instance.mergeRuntimeChatMessages([priorTurn])
    expect(firstMerge[0].receivedAt).toBe(1000)

    // The user sends a prompt: the daemon records a timed input ack.
    clock = 2000
    instance.runtimeMessages.push({
      key: 'ack-1',
      message: {
        role: 'user',
        kind: 'standard',
        content: 'do the thing',
        receivedAt: 2000,
        timestamp: 2000,
        source: 'runtime_input_ack',
        meta: { runtimeInputAck: true },
      },
    })

    // Poll 2: the assistant response appears in the transcript, still untimed.
    clock = 3000
    const response = { role: 'assistant', kind: 'standard', content: 'done' }
    const merged = instance.mergeRuntimeChatMessages([priorTurn, response])

    expect(roles(merged)).toEqual(['assistant', 'user', 'assistant'])
    expect(merged[1].content).toBe('do the thing')
    // The previously stamped message keeps its first-observed time.
    expect(merged[0].receivedAt).toBe(1000)
    expect(merged[2].receivedAt).toBe(3000)
  })
})
