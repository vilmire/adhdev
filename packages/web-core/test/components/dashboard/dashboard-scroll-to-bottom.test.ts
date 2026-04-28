import { describe, expect, it } from 'vitest'
import {
  buildDashboardScrollToBottomRequest,
  shouldRequestDashboardScrollToBottom,
} from '../../../src/components/dashboard/dashboard-scroll-to-bottom'

describe('dashboard scroll-to-bottom intents', () => {
  it('requests bottom scroll for user navigation intents', () => {
    expect(shouldRequestDashboardScrollToBottom('notification-open')).toBe(true)
    expect(shouldRequestDashboardScrollToBottom('toast-open')).toBe(true)
    expect(shouldRequestDashboardScrollToBottom('conversation-open')).toBe(true)
    expect(shouldRequestDashboardScrollToBottom('requested-tab')).toBe(true)
  })

  it('does not request bottom scroll for layout-only dockview actions or passive restore flows', () => {
    expect(shouldRequestDashboardScrollToBottom('dockview-shortcut')).toBe(false)
    expect(shouldRequestDashboardScrollToBottom('dockview-split')).toBe(false)
    expect(shouldRequestDashboardScrollToBottom('dockview-focus')).toBe(false)
    expect(shouldRequestDashboardScrollToBottom('dockview-move')).toBe(false)
    expect(shouldRequestDashboardScrollToBottom('stored-layout-restore')).toBe(false)
    expect(shouldRequestDashboardScrollToBottom('passive-tab-sync')).toBe(false)
  })

  it('builds requests only for explicit intents with a tab key', () => {
    expect(buildDashboardScrollToBottomRequest('tab-1', 'notification-open', 123)).toEqual({
      tabKey: 'tab-1',
      nonce: 123,
    })

    expect(buildDashboardScrollToBottomRequest('tab-1', 'stored-layout-restore', 123)).toBeNull()
    expect(buildDashboardScrollToBottomRequest('', 'dockview-split', 123)).toBeNull()
  })
})
