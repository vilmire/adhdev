import { describe, expect, it } from 'vitest'
import {
  buildChatMessageSignature,
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
})
