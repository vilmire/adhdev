import { describe, expect, it } from 'vitest'
import {
  clearRecentSendOnFailure,
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
})
