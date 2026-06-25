import { describe, expect, it, vi } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// TASKBUBBLE-DUP regression: a single mesh_send_task can reach a worker session
// as TWO send_chat injections (the first send is buffered during bootstrap/busy,
// then a redelivery — dispatch-confirm-timeout requeue or a reconcile
// re-dispatch — fires a second send_chat before the outbound queue drains).
// Each send_chat calls recordAcknowledgedUserInput once. The previous dedupKey
// hashed Date.now(), so two acks of identical content produced different keys
// and BOTH were appended → the prompt showed as a user bubble twice, leading the
// worker to read "resend = my prior work was incomplete". The content-stable
// windowed guard must collapse the redelivery to ONE bubble.

type TestInstance = CliProviderInstance & {
  runtimeMessages: Array<{ key: string; message: any }>
  recentUserInputAcks: Map<string, number>
  instanceId: string
  type: string
  workingDir: string
  historyWriter: { appendNewMessages: (...args: any[]) => void }
  adapter: { getScriptParsedStatus?: () => any }
}

function makeInstance(): TestInstance {
  const instance = Object.create(CliProviderInstance.prototype) as TestInstance
  instance.runtimeMessages = []
  instance.recentUserInputAcks = new Map()
  instance.instanceId = 'inst_test'
  instance.type = 'claude-cli'
  instance.workingDir = '/tmp/work'
  instance.historyWriter = { appendNewMessages: vi.fn() }
  instance.adapter = { getScriptParsedStatus: () => null }
  return instance
}

function userBubbles(instance: TestInstance): Array<{ key: string; message: any }> {
  return instance.runtimeMessages.filter((entry) => entry.message?.role === 'user')
}

describe('CliProviderInstance recordAcknowledgedUserInput dedup', () => {
  it('records one user bubble when the same dispatched task is acked twice in quick succession', () => {
    const instance = makeInstance()
    const message = 'Run the migration and report the result.'

    instance.recordAcknowledgedUserInput(message)
    instance.recordAcknowledgedUserInput(message)

    const bubbles = userBubbles(instance)
    expect(bubbles).toHaveLength(1)
    expect(instance.historyWriter.appendNewMessages).toHaveBeenCalledTimes(1)
  })

  it('records two bubbles when the same content is resent after the dedup window', () => {
    const instance = makeInstance()
    const message = 'status?'

    let clock = 1_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      instance.recordAcknowledgedUserInput(message)
      // Advance past USER_INPUT_ACK_DEDUP_WINDOW_MS (60s) — a genuine new turn.
      clock += 61_000
      instance.recordAcknowledgedUserInput(message)
    } finally {
      nowSpy.mockRestore()
    }

    expect(userBubbles(instance)).toHaveLength(2)
  })

  it('records distinct bubbles for distinct content within the window', () => {
    const instance = makeInstance()

    instance.recordAcknowledgedUserInput('first task')
    instance.recordAcknowledgedUserInput('second task')

    const bubbles = userBubbles(instance)
    expect(bubbles).toHaveLength(2)
    expect(bubbles.map((b) => b.message.content)).toEqual(['first task', 'second task'])
  })

  it('treats whitespace-only differing content as the same ack (trimmed)', () => {
    const instance = makeInstance()

    instance.recordAcknowledgedUserInput('do the thing')
    instance.recordAcknowledgedUserInput('  do the thing  ')

    expect(userBubbles(instance)).toHaveLength(1)
  })
})
