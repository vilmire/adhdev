import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  ACTION_SHORTCUTS_KEY,
  getDefaultShortcut,
  readActionShortcuts,
  type DashboardActionShortcutId,
} from '../../src/hooks/useActionShortcuts'

function createStorageMock() {
  const store = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key)
    }),
    clear: vi.fn(() => {
      store.clear()
    }),
  }
}

describe('dashboard action shortcut defaults', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageMock())
  })

  it('uses directional sequence defaults for Mac pane and tab movement', () => {
    const expected: Partial<Record<DashboardActionShortcutId, string>> = {
      openNewSession: 'N',
      splitActiveTabRight: 'S →',
      splitActiveTabDown: 'S ↓',
      focusLeftPane: 'F ←',
      focusRightPane: 'F →',
      focusUpPane: 'F ↑',
      focusDownPane: 'F ↓',
      moveActiveTabToLeftPane: 'M ←',
      moveActiveTabToRightPane: 'M →',
      moveActiveTabToUpPane: 'M ↑',
      moveActiveTabToDownPane: 'M ↓',
      selectPreviousGroupTab: 'T ←',
      selectNextGroupTab: 'T →',
    }

    for (const [actionId, shortcut] of Object.entries(expected) as [DashboardActionShortcutId, string][]) {
      expect(getDefaultShortcut(actionId, true)).toBe(shortcut)
    }
  })

  it('migrates old Mac movement defaults to the new directional defaults', () => {
    localStorage.setItem(ACTION_SHORTCUTS_KEY, JSON.stringify({
      splitActiveTabRight: '⌘+⌥+=',
      splitActiveTabDown: '⌘+⌥+-',
      focusLeftPane: '⌘+⌥+[',
      focusRightPane: '⌘+⌥+]',
      focusUpPane: '⌘+⌥+U',
      focusDownPane: '⌘+⌥+J',
      moveActiveTabToLeftPane: '⌘+⌥+,',
      moveActiveTabToRightPane: '⌘+⌥+.',
      moveActiveTabToUpPane: '⌘+⌥+I',
      moveActiveTabToDownPane: '⌘+⌥+K',
      selectPreviousGroupTab: '⌥+[',
      selectNextGroupTab: '⌥+]',
    }))

    expect(readActionShortcuts(true)).toMatchObject({
      splitActiveTabRight: 'S →',
      splitActiveTabDown: 'S ↓',
      focusLeftPane: 'F ←',
      focusRightPane: 'F →',
      focusUpPane: 'F ↑',
      focusDownPane: 'F ↓',
      moveActiveTabToLeftPane: 'M ←',
      moveActiveTabToRightPane: 'M →',
      moveActiveTabToUpPane: 'M ↑',
      moveActiveTabToDownPane: 'M ↓',
      selectPreviousGroupTab: 'T ←',
      selectNextGroupTab: 'T →',
    })
  })

  it('migrates old non-Mac movement defaults to the new directional defaults', () => {
    localStorage.setItem(ACTION_SHORTCUTS_KEY, JSON.stringify({
      splitActiveTabRight: 'Ctrl+Alt+\\',
      splitActiveTabDown: 'Ctrl+Alt+-',
      focusLeftPane: 'Ctrl+Alt+←',
      focusRightPane: 'Ctrl+Alt+→',
      focusUpPane: 'Ctrl+Alt+↑',
      focusDownPane: 'Ctrl+Alt+↓',
      moveActiveTabToLeftPane: 'Ctrl+Alt+Shift+←',
      moveActiveTabToRightPane: 'Ctrl+Alt+Shift+→',
      moveActiveTabToUpPane: 'Ctrl+Alt+Shift+↑',
      moveActiveTabToDownPane: 'Ctrl+Alt+Shift+↓',
      selectPreviousGroupTab: 'Ctrl+Alt+[',
      selectNextGroupTab: 'Ctrl+Alt+]',
    }))

    expect(readActionShortcuts(false)).toMatchObject({
      splitActiveTabRight: 'S →',
      splitActiveTabDown: 'S ↓',
      focusLeftPane: 'F ←',
      focusRightPane: 'F →',
      focusUpPane: 'F ↑',
      focusDownPane: 'F ↓',
      moveActiveTabToLeftPane: 'M ←',
      moveActiveTabToRightPane: 'M →',
      moveActiveTabToUpPane: 'M ↑',
      moveActiveTabToDownPane: 'M ↓',
      selectPreviousGroupTab: 'T ←',
      selectNextGroupTab: 'T →',
    })
  })
})
