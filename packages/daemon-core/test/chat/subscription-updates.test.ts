import { describe, expect, it } from 'vitest'
import {
  prepareSessionChatTailUpdate,
  prepareSessionModalUpdate,
} from '../../src/chat/subscription-updates'

describe('chat subscription update helpers', () => {
  it('normalizes chat-tail updates into a shared transport payload', () => {
    const prepared = prepareSessionChatTailUpdate({
      key: 'sub-1',
      sessionId: 'session-1',
      historySessionId: 'provider-1',
      seq: 3,
      timestamp: 123,
      cursor: {
        knownMessageCount: 1,
        lastMessageSignature: 'sig-old',
        tailLimit: 40,
      },
      lastDeliveredSignature: '',
      result: {
        success: true,
        syncMode: 'unexpected-mode',
        messages: [{ id: 'msg-2', content: 'hello' }],
        status: 'generating',
        title: 'Repo Thread',
        activeModal: {
          message: 'Approve?',
          buttons: ['Approve', 42, 'Reject'],
        },
        replaceFrom: 0,
        totalMessages: 2,
        lastMessageSignature: 'sig-2',
      },
    })

    expect(prepared.cursor).toEqual({
      knownMessageCount: 2,
      lastMessageSignature: 'sig-2',
      tailLimit: 40,
    })
    expect(prepared.seq).toBe(4)
    expect(prepared.lastDeliveredSignature).not.toBe('')
    expect(prepared.update).toMatchObject({
      topic: 'session.chat_tail',
      key: 'sub-1',
      sessionId: 'session-1',
      historySessionId: 'provider-1',
      seq: 4,
      timestamp: 123,
      status: 'generating',
      title: 'Repo Thread',
      syncMode: 'full',
      replaceFrom: 0,
      totalMessages: 2,
      lastMessageSignature: 'sig-2',
      activeModal: {
        message: 'Approve?',
        buttons: ['Approve', 'Reject'],
      },
    })
  })

  it('suppresses noop chat-tail updates while still refreshing the cursor', () => {
    const prepared = prepareSessionChatTailUpdate({
      key: 'sub-1',
      sessionId: 'session-1',
      seq: 2,
      timestamp: 456,
      cursor: {
        knownMessageCount: 1,
        lastMessageSignature: 'sig-old',
        tailLimit: 25,
      },
      lastDeliveredSignature: 'same-signature',
      result: {
        success: true,
        syncMode: 'noop',
        totalMessages: 5,
        lastMessageSignature: 'sig-5',
      },
    })

    expect(prepared.update).toBeNull()
    expect(prepared.seq).toBe(2)
    expect(prepared.lastDeliveredSignature).toBe('same-signature')
    expect(prepared.cursor).toEqual({
      knownMessageCount: 5,
      lastMessageSignature: 'sig-5',
      tailLimit: 25,
    })
  })

  it('suppresses duplicate modal updates after hashing the normalized modal payload', () => {
    const first = prepareSessionModalUpdate({
      key: 'modal-1',
      sessionId: 'session-1',
      seq: 0,
      timestamp: 111,
      lastDeliveredSignature: '',
      status: 'waiting_approval',
      title: 'Repo Thread',
      activeModal: {
        message: 'Approve?',
        buttons: ['Approve', 99, 'Reject'],
      },
    })

    expect(first.seq).toBe(1)
    expect(first.update).toMatchObject({
      topic: 'session.modal',
      key: 'modal-1',
      sessionId: 'session-1',
      status: 'waiting_approval',
      title: 'Repo Thread',
      modalMessage: 'Approve?',
      modalButtons: ['Approve', 'Reject'],
      seq: 1,
      timestamp: 111,
    })

    const duplicate = prepareSessionModalUpdate({
      key: 'modal-1',
      sessionId: 'session-1',
      seq: first.seq,
      timestamp: 222,
      lastDeliveredSignature: first.lastDeliveredSignature,
      status: 'waiting_approval',
      title: 'Repo Thread',
      activeModal: {
        message: 'Approve?',
        buttons: ['Approve', 'Reject'],
      },
    })

    expect(duplicate.seq).toBe(1)
    expect(duplicate.update).toBeNull()
    expect(duplicate.lastDeliveredSignature).toBe(first.lastDeliveredSignature)
  })
})
