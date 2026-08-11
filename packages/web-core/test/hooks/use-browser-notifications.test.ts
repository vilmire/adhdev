import { describe, expect, it } from 'vitest'
import { shouldSkipNotificationForMute, shouldSuppressBrowserNotificationForPushState } from '../../src/hooks/useBrowserNotifications'

describe('useBrowserNotifications push subscription gating', () => {
  it('suppresses browser notifications while push subscription state is still pending', () => {
    expect(shouldSuppressBrowserNotificationForPushState(null)).toBe(true)
  })

  it('suppresses browser notifications when service-worker push is active', () => {
    expect(shouldSuppressBrowserNotificationForPushState(true)).toBe(true)
  })

  it('allows browser notifications only after service-worker push is known inactive', () => {
    expect(shouldSuppressBrowserNotificationForPushState(false)).toBe(false)
  })
})

describe('useBrowserNotifications mute skip (waiting_choice override)', () => {
  it('never skips when the conversation is not muted', () => {
    expect(shouldSkipNotificationForMute(false, 'generating', 'idle')).toBe(false)
    expect(shouldSkipNotificationForMute(undefined, 'generating', 'waiting_choice')).toBe(false)
  })

  it('skips ordinary transitions for a muted conversation', () => {
    expect(shouldSkipNotificationForMute(true, 'generating', 'idle')).toBe(true)
    expect(shouldSkipNotificationForMute(true, 'generating', 'waiting_approval')).toBe(true)
  })

  it('does NOT skip entry into waiting_choice even when muted (coordinator question must ping)', () => {
    expect(shouldSkipNotificationForMute(true, 'generating', 'waiting_choice')).toBe(false)
  })

  it('a REPEATED waiting_choice frame (no transition) stays muted', () => {
    expect(shouldSkipNotificationForMute(true, 'waiting_choice', 'waiting_choice')).toBe(true)
  })
})
