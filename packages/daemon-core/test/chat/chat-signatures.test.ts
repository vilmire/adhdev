import { describe, expect, it } from 'vitest'
import {
  buildChatMessageSignature,
  buildChatTailDeliverySignature,
  buildSessionModalDeliverySignature,
  hashSignatureParts,
} from '../../src/chat/chat-signatures'

describe('chat signature helpers', () => {
  it('hashes signature parts deterministically', () => {
    expect(hashSignatureParts(['session-1', 'idle', 'hello'])).toBe(hashSignatureParts(['session-1', 'idle', 'hello']))
    expect(hashSignatureParts(['session-1', 'idle', 'hello'])).not.toBe(hashSignatureParts(['session-1', 'idle', 'hello!']))
  })

  it('changes message signatures when content changes beyond the initial preview region', () => {
    const before = buildChatMessageSignature({
      id: 'msg-1',
      index: 0,
      role: 'assistant',
      timestamp: 1,
      receivedAt: 1,
      content: `${'A'.repeat(240)} tail-one`,
    })

    const after = buildChatMessageSignature({
      id: 'msg-1',
      index: 0,
      role: 'assistant',
      timestamp: 1,
      receivedAt: 1,
      content: `${'A'.repeat(240)} tail-two`,
    })

    expect(after).not.toBe(before)
  })

  it('uses timestamp when receivedAt is unavailable', () => {
    const before = buildChatMessageSignature({
      id: 'msg-1',
      index: 0,
      role: 'assistant',
      timestamp: 1,
      content: 'hello',
    })
    const after = buildChatMessageSignature({
      id: 'msg-1',
      index: 0,
      role: 'assistant',
      timestamp: 2,
      content: 'hello',
    })

    expect(after).not.toBe(before)
  })

  it('changes chat-tail delivery signatures when any delivered field changes', () => {
    const base = buildChatTailDeliverySignature({
      sessionId: 'session-1',
      historySessionId: 'provider-1',
      messages: [{ id: 'msg-1', content: 'hello' }],
      status: 'idle',
      title: 'Repo',
      activeModal: null,
      syncMode: 'append',
      replaceFrom: 0,
      totalMessages: 1,
      lastMessageSignature: 'sig-1',
    })

    const changed = buildChatTailDeliverySignature({
      sessionId: 'session-1',
      historySessionId: 'provider-1',
      messages: [{ id: 'msg-1', content: 'hello world' }],
      status: 'idle',
      title: 'Repo',
      activeModal: null,
      syncMode: 'append',
      replaceFrom: 0,
      totalMessages: 1,
      lastMessageSignature: 'sig-1',
    })

    expect(changed).not.toBe(base)
  })

  it('changes modal delivery signatures when modal buttons change', () => {
    const before = buildSessionModalDeliverySignature({
      sessionId: 'session-1',
      status: 'waiting_approval',
      title: 'Repo',
      modalMessage: 'Approve?',
      modalButtons: ['Approve', 'Reject'],
    })

    const after = buildSessionModalDeliverySignature({
      sessionId: 'session-1',
      status: 'waiting_approval',
      title: 'Repo',
      modalMessage: 'Approve?',
      modalButtons: ['Approve', 'Deny'],
    })

    expect(after).not.toBe(before)
  })
})
