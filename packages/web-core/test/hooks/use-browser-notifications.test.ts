import { describe, expect, it } from 'vitest'
import { shouldSuppressBrowserNotificationForPushState } from '../../src/hooks/useBrowserNotifications'

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
