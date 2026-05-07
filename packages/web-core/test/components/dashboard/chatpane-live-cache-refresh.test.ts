import { describe, expect, it } from 'vitest'
import { getConversationLiveMessages } from '../../../src/components/dashboard/conversation-message-snapshot'

describe('chat pane live cache authority', () => {
  it('uses chat-tail snapshot rows as the live view without merging active conversation fallbacks', () => {
    const activeConversation = {
      messages: [{ role: 'assistant', id: 'fallback-1', content: 'fallback row' }],
    } as any
    const snapshot = {
      liveMessages: [{ role: 'assistant', id: 'snapshot-1', content: 'snapshot row' }],
      hasLiveSnapshot: true,
      cursor: { knownMessageCount: 1, lastMessageSignature: 'sig', tailLimit: 60 },
      historyMessages: [],
      historyOffset: 0,
      hasMoreHistory: true,
      historyError: null,
    }

    expect(getConversationLiveMessages(activeConversation, snapshot)).toBe(snapshot.liveMessages)
  })

  it('uses active conversation rows while the chat-tail controller is still unhydrated', () => {
    const activeConversation = {
      messages: [{ role: 'assistant', id: 'fallback-1', content: 'fallback row' }],
    } as any
    const snapshot = {
      liveMessages: [],
      hasLiveSnapshot: false,
      cursor: { tailLimit: 60 },
      historyMessages: [],
      historyOffset: 0,
      hasMoreHistory: true,
      historyError: null,
    }

    expect(getConversationLiveMessages(activeConversation, snapshot)).toBe(activeConversation.messages)
  })

  it('uses authoritative live tail when it first hydrates with a truncated window before history loads', () => {
    // Regression: long Hermes/CLI session. The frontend conversation fallback can be
    // stale/empty or a different cached slice, while chat-tail/readChat is the daemon
    // parser authority. Once chat-tail has hydrated, use that bounded live tail
    // immediately and let explicit history paging recover older rows.
    const fallbackMessages = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      id: `fallback-${i}`,
      content: `fallback message ${i}`,
    }))
    const activeConversation = { messages: fallbackMessages } as any
    const truncatedLiveTail = Array.from({ length: 20 }, (_, i) => ({
      role: 'assistant',
      id: `live-${i + 30}`,
      content: `live message ${i + 30}`,
    }))
    const snapshot = {
      liveMessages: truncatedLiveTail,
      hasLiveSnapshot: true,
      cursor: { tailLimit: 50 },
      historyMessages: [],
      historyOffset: 0,
      hasMoreHistory: true,
      historyError: null,
    }

    const result = getConversationLiveMessages(activeConversation, snapshot)
    expect(result).toBe(truncatedLiveTail)
    expect(result).toHaveLength(20)
  })

  it('switches to authoritative live tail once history has started loading (historyOffset > 0)', () => {
    // After history loads, the live tail is trusted as the authoritative recent window
    // even if it is shorter than the original conversation fallback.
    const fallbackMessages = Array.from({ length: 50 }, (_, i) => ({
      role: 'assistant',
      id: `fallback-${i}`,
      content: `fallback message ${i}`,
    }))
    const activeConversation = { messages: fallbackMessages } as any
    const truncatedLiveTail = Array.from({ length: 20 }, (_, i) => ({
      role: 'assistant',
      id: `live-${i + 30}`,
      content: `live message ${i + 30}`,
    }))
    const snapshot = {
      liveMessages: truncatedLiveTail,
      hasLiveSnapshot: true,
      cursor: { tailLimit: 50 },
      historyMessages: [],
      historyOffset: 30,
      hasMoreHistory: false,
      historyError: null,
    }

    const result = getConversationLiveMessages(activeConversation, snapshot)
    expect(result).toBe(truncatedLiveTail)
    expect(result).toHaveLength(20)
  })

  it('uses live tail when it covers at least as many messages as the fallback even before history loads', () => {
    // When the live tail window is equal to or longer than the fallback, it is authoritative
    // immediately — no need to wait for history.
    const fallbackMessages = Array.from({ length: 20 }, (_, i) => ({
      role: 'assistant',
      id: `fallback-${i}`,
      content: `fallback message ${i}`,
    }))
    const activeConversation = { messages: fallbackMessages } as any
    const liveTail = Array.from({ length: 20 }, (_, i) => ({
      role: 'assistant',
      id: `live-${i}`,
      content: `live message ${i}`,
    }))
    const snapshot = {
      liveMessages: liveTail,
      hasLiveSnapshot: true,
      cursor: { tailLimit: 60 },
      historyMessages: [],
      historyOffset: 0,
      hasMoreHistory: true,
      historyError: null,
    }

    const result = getConversationLiveMessages(activeConversation, snapshot)
    expect(result).toBe(liveTail)
  })
})
