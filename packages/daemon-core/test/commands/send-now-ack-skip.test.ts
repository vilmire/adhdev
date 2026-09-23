/**
 * (IMAGE-TRIPLE-BUBBLE ④, ack half) A Send now press on a body the driver had
 * PARKED must NOT re-record a user-input ack: the original send_chat already
 * acked that body when it parked. With wiring-unification D2 the parked entry
 * is found by the SAME messageId the press resubmits, and the ack is stamped
 * once per messageId by SessionInputService. A press on a body that was never
 * parked is a genuine first delivery and keeps its ack.
 */
import { describe, expect, it, vi } from 'vitest'
import { handleSendChat } from '../../src/commands/chat-commands.js'

let fixtureId = 0

function fixture(parked: Array<{ messageId: string; text: string; bracketedPaste?: boolean }>) {
  const sessionId = `send-now-ack-${++fixtureId}`
  const provider = { type: 'claude-cli', category: 'cli' }
  const fifo = [...parked]
  const adapter = {
    cliType: 'claude-cli',
    getStatus: () => ({ status: 'generating' }),
    sendMessage: vi.fn(async () => ({ status: 'queued' as const, position: 1 })),
    sendMessageDuringGeneration: vi.fn(() => ({ accepted: true })),
    hasQueuedSend: (id: string) => fifo.some(e => e.messageId === id),
    claimQueuedSend: vi.fn((id: string) => {
      const index = fifo.findIndex(e => e.messageId === id)
      return index < 0 ? null : { entry: fifo.splice(index, 1)[0], index }
    }),
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
    ctx: { adapters: new Map([[sessionId, adapter]]), instanceManager: { getInstance: () => instance } },
  } as any
  const send = (messageId: string) => handleSendChat(helpers, {
    targetSessionId: sessionId, message: 'queued body', messageId, policy: { mode: 'send_now' },
  })
  return { adapter, instance, send }
}

describe('send_chat policy send_now — ack skip for a parked body', () => {
  it('★ parked: the PARKED body is written, and no second ack bubble', async () => {
    const { adapter, instance, send } = fixture([
      { messageId: 'msg_parked', text: '/tmp/img.png\nqueued body', bracketedPaste: true },
    ])
    const result = await send('msg_parked')
    expect(result).toMatchObject({ success: true, queuedWithAgent: true, submitted: false, messageId: 'msg_parked' })
    expect(adapter.claimQueuedSend).toHaveBeenCalledWith('msg_parked')
    expect(adapter.sendMessageDuringGeneration).toHaveBeenCalledWith('/tmp/img.png\nqueued body', true)
    expect(instance.recordAcknowledgedUserInput).not.toHaveBeenCalled()
  })

  it('never parked: a direct press is a first delivery and gets its ack (stamped with the id)', async () => {
    const { adapter, instance, send } = fixture([])
    const result = await send('msg_fresh')
    expect(result).toMatchObject({ success: true, queuedWithAgent: true })
    expect(adapter.sendMessageDuringGeneration).toHaveBeenCalledWith('queued body', undefined)
    expect(instance.recordAcknowledgedUserInput).toHaveBeenCalledTimes(1)
    expect(instance.recordAcknowledgedUserInput.mock.calls[0][1]).toBe('msg_fresh')
  })
})
