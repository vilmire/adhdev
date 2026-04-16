import type { DashboardActionShortcutId } from '../../hooks/useActionShortcuts'

export type DashboardDockviewContextMenuItem =
  | {
      type: 'action'
      id:
        | 'dockInWindow'
        | 'moveBackToMain'
        | 'dockBackToGrid'
        | 'floatAsPanel'
        | 'openInNewWindow'
        | 'setShortcut'
        | 'removeShortcut'
        | 'hideTab'
      label: string
      shortcut?: string
      tone?: 'muted'
    }
  | {
      type: 'separator'
      id: 'before-shortcut-actions' | 'before-hide-tab'
    }

interface BuildDashboardDockviewContextMenuItemsOptions {
  isTabInPopout: boolean
  isTabFloating: boolean
  tabShortcut?: string | null
  actionShortcuts: Partial<Record<DashboardActionShortcutId, string>>
}

export function buildDashboardDockviewContextMenuItems({
  isTabInPopout,
  isTabFloating,
  tabShortcut,
  actionShortcuts,
}: BuildDashboardDockviewContextMenuItemsOptions): DashboardDockviewContextMenuItem[] {
  const items: DashboardDockviewContextMenuItem[] = []

  if (isTabInPopout) {
    if (isTabFloating) {
      items.push({ type: 'action', id: 'dockInWindow', label: 'Dock in window', shortcut: actionShortcuts.dockActiveTab })
    }
    items.push({ type: 'action', id: 'moveBackToMain', label: 'Move back to main window', shortcut: actionShortcuts.dockActiveTab })
  } else if (isTabFloating) {
    items.push({ type: 'action', id: 'dockBackToGrid', label: 'Dock back to grid', shortcut: actionShortcuts.dockActiveTab })
  } else {
    items.push(
      { type: 'action', id: 'floatAsPanel', label: 'Float as panel', shortcut: actionShortcuts.floatActiveTab },
      { type: 'action', id: 'openInNewWindow', label: 'Open in new window', shortcut: actionShortcuts.popoutActiveTab },
    )
  }

  items.push(
    { type: 'separator', id: 'before-shortcut-actions' },
    {
      type: 'action',
      id: 'setShortcut',
      label: tabShortcut ? `Change shortcut (${tabShortcut})` : 'Set shortcut',
    },
  )

  if (tabShortcut) {
    items.push({ type: 'action', id: 'removeShortcut', label: 'Remove shortcut', tone: 'muted' })
  }

  items.push(
    { type: 'separator', id: 'before-hide-tab' },
    { type: 'action', id: 'hideTab', label: 'Hide tab', shortcut: actionShortcuts.hideCurrentTab, tone: 'muted' },
  )

  return items
}
