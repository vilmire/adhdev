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

  it('uses low-accident modifier defaults for Mac navigation and session creation', () => {
    const expected: Partial<Record<DashboardActionShortcutId, string>> = {
      openNewSession: '⌘+⇧+Enter',
      splitActiveTabRight: '⌘+Ctrl+⇧+→',
      splitActiveTabDown: '⌘+Ctrl+⇧+↓',
      focusLeftPane: '',
      focusRightPane: '',
      focusUpPane: '',
      focusDownPane: '',
      moveActiveTabToLeftPane: '',
      moveActiveTabToRightPane: '',
      moveActiveTabToUpPane: '',
      moveActiveTabToDownPane: '',
      selectPreviousGroupTab: '⌘+⇧+←',
      selectNextGroupTab: '⌘+⇧+→',
    }

    for (const [actionId, shortcut] of Object.entries(expected) as [DashboardActionShortcutId, string][]) {
      expect(getDefaultShortcut(actionId, true)).toBe(shortcut)
    }
  })

  it('uses modifier+arrow defaults without bare key sequences on non-Mac platforms', () => {
    expect(getDefaultShortcut('openNewSession', false)).toBe('Ctrl+Shift+Enter')
    expect(getDefaultShortcut('selectPreviousGroupTab', false)).toBe('Ctrl+Shift+←')
    expect(getDefaultShortcut('selectNextGroupTab', false)).toBe('Ctrl+Shift+→')
    expect(getDefaultShortcut('splitActiveTabRight', false)).toBe('Ctrl+Alt+Shift+→')
    expect(getDefaultShortcut('splitActiveTabDown', false)).toBe('Ctrl+Alt+Shift+↓')
  })

  it('migrates old Mac movement defaults and rejected bare sequences to the safer defaults', () => {
    localStorage.setItem(ACTION_SHORTCUTS_KEY, JSON.stringify({
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
    }))

    expect(readActionShortcuts(true)).toMatchObject({
      openNewSession: '⌘+⇧+Enter',
      splitActiveTabRight: '⌘+Ctrl+⇧+→',
      splitActiveTabDown: '⌘+Ctrl+⇧+↓',
      focusLeftPane: '',
      focusRightPane: '',
      focusUpPane: '',
      focusDownPane: '',
      moveActiveTabToLeftPane: '',
      moveActiveTabToRightPane: '',
      moveActiveTabToUpPane: '',
      moveActiveTabToDownPane: '',
      selectPreviousGroupTab: '⌘+⇧+←',
      selectNextGroupTab: '⌘+⇧+→',
    })
  })

  it('migrates old Mac modifier movement defaults to the safer defaults', () => {
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
      splitActiveTabRight: '⌘+Ctrl+⇧+→',
      splitActiveTabDown: '⌘+Ctrl+⇧+↓',
      focusLeftPane: '',
      focusRightPane: '',
      focusUpPane: '',
      focusDownPane: '',
      moveActiveTabToLeftPane: '',
      moveActiveTabToRightPane: '',
      moveActiveTabToUpPane: '',
      moveActiveTabToDownPane: '',
      selectPreviousGroupTab: '⌘+⇧+←',
      selectNextGroupTab: '⌘+⇧+→',
    })
  })

  it('migrates old non-Mac movement defaults to the safer defaults', () => {
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
      splitActiveTabRight: 'Ctrl+Alt+Shift+→',
      splitActiveTabDown: 'Ctrl+Alt+Shift+↓',
      focusLeftPane: '',
      focusRightPane: '',
      focusUpPane: '',
      focusDownPane: '',
      moveActiveTabToLeftPane: '',
      moveActiveTabToRightPane: '',
      moveActiveTabToUpPane: '',
      moveActiveTabToDownPane: '',
      selectPreviousGroupTab: 'Ctrl+Shift+←',
      selectNextGroupTab: 'Ctrl+Shift+→',
    })
  })

  it('preserves user-customized shortcuts instead of replacing every non-default value', () => {
    localStorage.setItem(ACTION_SHORTCUTS_KEY, JSON.stringify({
      openNewSession: 'Ctrl+Alt+N',
      splitActiveTabRight: 'Ctrl+Alt+R',
      selectNextGroupTab: 'Ctrl+Alt+T',
    }))

    expect(readActionShortcuts(false)).toMatchObject({
      openNewSession: 'Ctrl+Alt+N',
      splitActiveTabRight: 'Ctrl+Alt+R',
      selectNextGroupTab: 'Ctrl+Alt+T',
    })
  })
})
