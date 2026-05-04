import { describe, expect, it } from 'vitest'
import { buildVisibleConversationMessages } from '../../src/components/dashboard/conversation-message-snapshot'

describe('chat pane history/live transcript boundaries', () => {
  it('preserves overlapping history and live rows instead of deduping in the frontend', () => {
    const overlapping = { role: 'assistant' as const, content: 'same parser row', id: 'same-1', receivedAt: 1000 }

    const result = buildVisibleConversationMessages({
      historyMessages: [overlapping],
      liveMessages: [overlapping],
      visibleLiveCount: 1,
    })

    expect(result).toEqual([overlapping, overlapping])
  })
})
