// @vitest-environment jsdom
//
// (G8-14) The tab shortcut tooltip must show the saved combo verbatim. The
// stored value already carries its own modifier prefix (e.g. "Ctrl+1" or,
// on macOS with Cmd held, "Ctrl+⌘+1") — prepending another literal "Ctrl+" in
// the tooltip double-prefixes it. This locks in the fix: tooltip text must
// equal the stored shortcut, not `Ctrl+${stored}`.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import PaneGroupTabBar from '../../src/components/dashboard/PaneGroupTabBar'
import { TAB_SHORTCUTS_KEY } from '../../src/hooks/useTabShortcuts'
import type { ActiveConversation } from '../../src/components/dashboard/types'

function conv(tabKey: string): ActiveConversation {
  return {
    routeId: tabKey,
    agentName: 'agent',
    agentType: 'claude-cli',
    status: 'idle',
    title: 'Session',
    messages: [],
    workspaceName: 'ws',
    displayPrimary: 'ws',
    displaySecondary: '',
    streamSource: 'native',
    tabKey,
  }
}

describe('PaneGroupTabBar shortcut tooltip', () => {
  let container: HTMLDivElement
  let root: Root
  let originalGetItem: typeof localStorage.getItem

  beforeEach(() => {
    // test/setup.ts installs a global localStorage stub (for i18n language
    // pinning) whose getItem/setItem are no-ops for any key but 'lang'.
    // useTabShortcuts reads its saved combos via localStorage.getItem, so we
    // patch getItem locally for this suite only, restored in afterEach.
    originalGetItem = localStorage.getItem.bind(localStorage)
    localStorage.getItem = ((key: string) =>
      key === TAB_SHORTCUTS_KEY ? JSON.stringify({ 'tab-1': 'Ctrl+⌘+1' }) : originalGetItem(key)) as typeof localStorage.getItem

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    localStorage.getItem = originalGetItem
  })

  it('shows the saved combo verbatim in the tooltip, without a duplicated "Ctrl+" prefix', () => {
    act(() => {
      root.render(
        <PaneGroupTabBar
          conversations={[conv('tab-1')]}
          activeTabId="tab-1"
          groupIndex={0}
          numGroups={1}
          unreadTabKeys={new Set()}
          draggingTabRef={{ current: null }}
          onFocus={() => {}}
          onSelectTab={() => {}}
          onConversationActivated={() => {}}
          onPreviewReorder={() => {}}
          onReorderTab={() => {}}
          onCommitPreviewOrder={() => {}}
          onClearPreviewOrder={() => {}}
          onDragStateReset={() => {}}
          onDragTabKeyChange={() => {}}
        />,
      )
    })

    const shortcutEl = Array.from(container.querySelectorAll('span')).find(
      (el) => el.getAttribute('title') && el.getAttribute('title')!.includes('+'),
    )
    expect(shortcutEl).toBeDefined()
    expect(shortcutEl!.getAttribute('title')).toBe('Ctrl+⌘+1')
    expect(shortcutEl!.getAttribute('title')).not.toBe('Ctrl+Ctrl+⌘+1')
    expect(shortcutEl!.textContent).toBe('Ctrl+⌘+1')
  })
})
