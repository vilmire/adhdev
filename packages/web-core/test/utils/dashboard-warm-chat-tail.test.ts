import { describe, expect, it } from 'vitest'
import { getDashboardWarmChatTailOptions } from '../../src/utils/dashboard-warm-chat-tail'

describe('getDashboardWarmChatTailOptions', () => {
  it('disables recent idle warming in mobile chat mode', () => {
    expect(getDashboardWarmChatTailOptions({ isMobile: true, mobileViewMode: 'chat' })).toEqual({
      recentActivityMs: 0,
    })
  })

  it('keeps default warming on desktop and mobile workspace mode', () => {
    expect(getDashboardWarmChatTailOptions({ isMobile: false, mobileViewMode: 'chat' })).toBeUndefined()
    expect(getDashboardWarmChatTailOptions({ isMobile: true, mobileViewMode: 'workspace' })).toBeUndefined()
  })
})
