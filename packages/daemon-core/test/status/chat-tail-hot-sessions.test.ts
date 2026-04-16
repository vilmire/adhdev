import { describe, expect, it } from 'vitest'
import {
  classifyHotChatSessionsForSubscriptionFlush,
  DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS,
} from '../../src/status/chat-tail-hot-sessions.js'

describe('classifyHotChatSessionsForSubscriptionFlush', () => {
  it('treats actively generating sessions as hot', () => {
    const result = classifyHotChatSessionsForSubscriptionFlush([
      { id: 'session-active', status: 'generating', lastMessageAt: 0 },
    ], new Set(), { now: 1_000 })

    expect(Array.from(result.active)).toEqual(['session-active'])
    expect(Array.from(result.finalizing)).toEqual([])
  })

  it('keeps recently completed sessions hot long enough to flush the completion tail', () => {
    const now = 10_000
    const result = classifyHotChatSessionsForSubscriptionFlush([
      {
        id: 'session-complete',
        status: 'idle',
        lastMessageAt: now - (DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS - 500),
      },
    ], new Set(), { now })

    expect(Array.from(result.active)).toEqual(['session-complete'])
    expect(Array.from(result.finalizing)).toEqual([])
  })

  it('does not keep stale idle sessions hot forever', () => {
    const now = 20_000
    const result = classifyHotChatSessionsForSubscriptionFlush([
      {
        id: 'session-stale',
        status: 'idle',
        lastMessageAt: now - (DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS + 1_000),
      },
    ], new Set(), { now })

    expect(Array.from(result.active)).toEqual([])
    expect(Array.from(result.finalizing)).toEqual([])
  })

  it('marks previous hot sessions as finalizing once they fall out of the grace window', () => {
    const now = 30_000
    const result = classifyHotChatSessionsForSubscriptionFlush([
      {
        id: 'session-finalizing',
        status: 'idle',
        lastMessageAt: now - (DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS + 1_000),
      },
    ], new Set(['session-finalizing']), { now })

    expect(Array.from(result.active)).toEqual([])
    expect(Array.from(result.finalizing)).toEqual(['session-finalizing'])
  })
})