import { describe, expect, it } from 'vitest'
import { getConversationLiveMessages } from '../../../src/components/dashboard/conversation-message-snapshot'

describe('chat pane live cache authority', () => {
  it('uses chat-tail snapshot rows as the live view without merging active conversation fallbacks', () => {
    const activeConversation = {
      messages: [{ role: 'assistant', id: 'fallback-1', content: 'fallback row' }],
    } as any
    const snapshot = {
      liveMessages: [{ role: 'assistant', id: 'snapshot-1', content: 'snapshot row' }],
      cursor: { knownMessageCount: 1, lastMessageSignature: 'sig', tailLimit: 60 },
      historyMessages: [],
      historyOffset: 0,
      hasMoreHistory: true,
      historyError: null,
    }

    expect(getConversationLiveMessages(activeConversation, snapshot)).toBe(snapshot.liveMessages)
  })
})
