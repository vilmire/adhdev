import { describe, expect, it } from 'vitest'
import { getDashboardWarmChatOptions } from '../../src/utils/dashboard-warm-chat'

describe('getDashboardWarmChatOptions', () => {
  it('disables recent idle warming in mobile chat mode', () => {
    expect(getDashboardWarmChatOptions({ isMobile: true, mobileViewMode: 'chat' })).toEqual({
      recentActivityMs: 0,
    })
  })

  it('keeps default warming on desktop and mobile workspace mode', () => {
    expect(getDashboardWarmChatOptions({ isMobile: false, mobileViewMode: 'chat' })).toBeUndefined()
    expect(getDashboardWarmChatOptions({ isMobile: true, mobileViewMode: 'workspace' })).toBeUndefined()
  })
})
