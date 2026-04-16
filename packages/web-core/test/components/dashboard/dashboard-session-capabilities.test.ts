import { describe, expect, it } from 'vitest'
import { shouldShowOpenPanelAction } from '../../../src/components/dashboard/dashboardSessionCapabilities'

describe('shouldShowOpenPanelAction', () => {
  it('only shows the action when the conversation is blocked on panel visibility and explicitly supports open_panel', () => {
    expect(shouldShowOpenPanelAction({
      status: 'panel_hidden',
      sessionCapabilities: ['read_chat', 'open_panel'],
    } as any)).toBe(true)

    expect(shouldShowOpenPanelAction({
      status: 'not_monitored',
      sessionCapabilities: ['read_chat', 'open_panel'],
    } as any)).toBe(true)

    expect(shouldShowOpenPanelAction({
      status: 'panel_hidden',
      sessionCapabilities: ['read_chat'],
    } as any)).toBe(false)

    expect(shouldShowOpenPanelAction({
      status: 'idle',
      sessionCapabilities: ['read_chat', 'open_panel'],
    } as any)).toBe(false)
  })
})
