import { describe, expect, it } from 'vitest'
import { buildDashboardDockviewContextMenuItems } from '../../../src/components/dashboard/dockviewContextMenuItems'

describe('buildDashboardDockviewContextMenuItems', () => {
  it('shows the hide-tab action with the configured keyboard shortcut in the main tab menu', () => {
    const items = buildDashboardDockviewContextMenuItems({
      isTabInPopout: false,
      isTabFloating: false,
      tabShortcut: '',
      actionShortcuts: {
        floatActiveTab: '⌥+F',
        popoutActiveTab: '⌥+P',
        hideCurrentTab: '⌥+X',
      },
    })

    expect(items).toEqual([
      { type: 'action', id: 'floatAsPanel', label: 'Float as panel', shortcut: '⌥+F' },
      { type: 'action', id: 'openInNewWindow', label: 'Open in new window', shortcut: '⌥+P' },
      { type: 'separator', id: 'before-shortcut-actions' },
      { type: 'action', id: 'setShortcut', label: 'Set shortcut' },
      { type: 'separator', id: 'before-hide-tab' },
      { type: 'action', id: 'hideTab', label: 'Hide tab', shortcut: '⌥+X', tone: 'muted' },
    ])
  })

  it('keeps popout-only tabs aligned with the previous menu actions', () => {
    const items = buildDashboardDockviewContextMenuItems({
      isTabInPopout: true,
      isTabFloating: false,
      tabShortcut: '',
      actionShortcuts: {
        dockActiveTab: '⌥+D',
        hideCurrentTab: '⌥+X',
      },
    })

    expect(items).toContainEqual({
      type: 'action',
      id: 'moveBackToMain',
      label: 'Move back to main window',
      shortcut: '⌥+D',
    })
    expect(items).not.toContainEqual(expect.objectContaining({ id: 'dockInWindow' }))
  })

  it('keeps the current tab shortcut label while still exposing hide-tab keyboard help', () => {
    const items = buildDashboardDockviewContextMenuItems({
      isTabInPopout: false,
      isTabFloating: false,
      tabShortcut: '⌘+1',
      actionShortcuts: {
        floatActiveTab: '⌥+F',
        popoutActiveTab: '⌥+P',
        hideCurrentTab: '⌥+X',
      },
    })

    expect(items).toContainEqual({
      type: 'action',
      id: 'setShortcut',
      label: 'Change shortcut (⌘+1)',
    })
    expect(items).toContainEqual({
      type: 'action',
      id: 'hideTab',
      label: 'Hide tab',
      shortcut: '⌥+X',
      tone: 'muted',
    })
  })
})
