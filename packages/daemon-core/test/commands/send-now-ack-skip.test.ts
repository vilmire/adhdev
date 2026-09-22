/**
 * (IMAGE-TRIPLE-BUBBLE ④, ack half) A Send now press on a body the driver had
 * PARKED (claimed > 0) must NOT re-record a user-input ack: the original
 * send_chat already acked that body when it parked, and this call's envelope is
 * text-only — for an image send the two contents differ, so the content-keyed
 * dedup window cannot collapse them and the owner got a second, differently
 * worded bubble. A direct press on an unparked body (claimed === 0) is a
 * genuine first delivery and keeps its ack.
 */
import { describe, expect, it, vi } from 'vitest'
import { handleSendChat } from '../../src/commands/chat-commands.js'

let fixtureId = 0

function fixture(claimedEntries: Array<{ text: string; bracketedPaste?: boolean; claimKey?: string }>) {
  const sessionId = `send-now-ack-${++fixtureId}`
  const provider = { type: 'claude-cli', category: 'cli' }
  const adapter = {
    cliType: 'claude-cli',
    sendMessage: vi.fn(async () => ({ status: 'queued' as const })),
    sendMessageDuringGeneration: vi.fn(() => ({ accepted: true })),
    claimQueuedSendEntries: vi.fn(() => claimedEntries),
    getScriptParsedStatus: () => null,
  }
  const instance = {
    category: 'cli', type: 'claude-cli',
    recordAcknowledgedUserInput: vi.fn(),
  }
  const helpers = {
    getProvider: () => provider,
    getCliAdapter: () => adapter,
    currentSession: { sessionId, transport: 'pty', providerType: 'claude-cli' },
    ctx: { instanceManager: { getInstance: () => instance } },
  } as any
  const send = () => handleSendChat(helpers, { targetSessionId: sessionId, message: `queued body ${fixtureId}`, sendNow: true })
  return { adapter, instance, send }
}

describe('send_chat sendNow — ack skip for claimed bodies', () => {
  it('★ claimed > 0: the body was acked when it parked — no second ack bubble', async () => {
    const { adapter, instance, send } = fixture([
      { text: '/tmp/img.png\nqueued body 1', bracketedPaste: true, claimKey: 'queued body 1' },
    ])
    const result = await send()
    expect(result).toMatchObject({ success: true, queuedWithAgent: true, claimed: 1 })
    // The parked body was the one written.
    expect(adapter.sendMessageDuringGeneration).toHaveBeenCalledWith('/tmp/img.png\nqueued body 1', true)
    expect(instance.recordAcknowledgedUserInput).not.toHaveBeenCalled()
  })

  it('claimed === 0: a direct press on an unparked body still gets its ack', async () => {
    const { instance, send } = fixture([])
    const result = await send()
    expect(result).toMatchObject({ success: true, queuedWithAgent: true, claimed: 0 })
    expect(instance.recordAcknowledgedUserInput).toHaveBeenCalledTimes(1)
  })
})
