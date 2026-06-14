import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@adhdev/daemon-core'
import { buildChatMessageRowSignature } from '../../src/components/ChatMessageList'

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    role: 'assistant',
    content: 'Hello world',
    id: 'm1',
    index: 0,
    receivedAt: 1000,
    ...overrides,
  } as ChatMessage
}

describe('buildChatMessageRowSignature (row memo comparator)', () => {
  it('returns an identical signature for a fresh object with identical render fields', () => {
    // The tail controller hands the list new object identities each tick. Same
    // fields → same signature → the row memo short-circuits (skips re-render).
    const a = msg()
    const b = msg()
    expect(a).not.toBe(b)
    expect(buildChatMessageRowSignature(a)).toBe(buildChatMessageRowSignature(b))
  })

  it('changes the signature when streaming content grows (last message must update)', () => {
    const before = msg({ content: 'Partial answer' })
    const after = msg({ content: 'Partial answer that kept streaming in' })
    expect(buildChatMessageRowSignature(before)).not.toBe(buildChatMessageRowSignature(after))
  })

  it('changes the signature when kind flips (e.g. standard → tool)', () => {
    expect(buildChatMessageRowSignature(msg({ kind: 'standard' })))
      .not.toBe(buildChatMessageRowSignature(msg({ kind: 'tool' })))
  })

  it('changes the signature when meta render flags change', () => {
    expect(buildChatMessageRowSignature(msg({ meta: { isRunning: true } })))
      .not.toBe(buildChatMessageRowSignature(msg({ meta: { isRunning: false } })))
    expect(buildChatMessageRowSignature(msg({ meta: { label: 'Thinking' } })))
      .not.toBe(buildChatMessageRowSignature(msg({ meta: { label: 'Done' } })))
  })

  it('changes the signature when classification-driving visibility flips without content change', () => {
    expect(buildChatMessageRowSignature(msg({ content: 'same', visibility: 'chat' })))
      .not.toBe(buildChatMessageRowSignature(msg({ content: 'same', visibility: 'internal' })))
  })

  it('changes the signature when receivedAt changes', () => {
    expect(buildChatMessageRowSignature(msg({ receivedAt: 1000 })))
      .not.toBe(buildChatMessageRowSignature(msg({ receivedAt: 2000 })))
  })

  it('changes the signature when senderName changes', () => {
    expect(buildChatMessageRowSignature(msg({ senderName: 'Alice' })))
      .not.toBe(buildChatMessageRowSignature(msg({ senderName: 'Bob' })))
  })
})
