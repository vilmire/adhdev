import { describe, expect, it } from 'vitest'
import {
  clearRecentSendOnFailure,
  shouldBlockConversationSend,
  shouldSuppressRecentDuplicateSend,
} from '../../src/hooks/useDashboardConversationCommands'

describe('useDashboardConversationCommands send dedupe helpers', () => {
  it('suppresses duplicate sends inside the recent-send window for the same tab and message', () => {
    const lastSend = { tabKey: 'tab-1', message: 'hello', timestamp: 1_000 }
    const attempt = { tabKey: 'tab-1', message: 'hello', timestamp: 2_500 }

    expect(shouldSuppressRecentDuplicateSend(lastSend, attempt, 2_000)).toBe(true)
  })

  it('does not suppress retries after a failed send clears the tracked attempt', () => {
    const failedAttempt = { tabKey: 'tab-1', message: 'hello', timestamp: 1_000 }
    const cleared = clearRecentSendOnFailure(failedAttempt, failedAttempt)
    const retryAttempt = { tabKey: 'tab-1', message: 'hello', timestamp: 1_500 }

    expect(cleared).toBeNull()
    expect(shouldSuppressRecentDuplicateSend(cleared, retryAttempt, 2_000)).toBe(false)
  })

  it('does not pre-block a new send just because another send request is still in flight', () => {
    expect(shouldBlockConversationSend({ hasMessage: true, blockedMessage: null, sendInFlight: true })).toBe(false)
  })

  it('still blocks sends when the conversation is in an approval-gated state', () => {
    expect(shouldBlockConversationSend({ hasMessage: true, blockedMessage: 'Resolve approval', sendInFlight: false })).toBe(true)
  })
})
