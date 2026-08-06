import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import HistoryModal from '../../../src/components/dashboard/HistoryModal'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

function readSource(): string {
  return fs.readFileSync(
    path.join(import.meta.dirname, '../../../src/components/dashboard/HistoryModal.tsx'),
    'utf8',
  )
}

function renderHistoryModal(activeConv: ActiveConversation, overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    React.createElement(HistoryModal, {
      activeConv,
      ides: [],
      isCreatingChat: false,
      isRefreshingHistory: false,
      savedSessions: [],
      isSavedSessionsLoading: false,
      isResumingSavedSessionId: null,
      onClose: () => {},
      onNewChat: () => {},
      onSwitchSession: () => {},
      onRefreshHistory: () => {},
      ...overrides,
    }),
  )
}

describe('HistoryModal switch confirmation', () => {
  it('does not render the confirm dialog before any item is clicked', () => {
    const html = renderHistoryModal({
      routeId: 'machine-1',
      transport: 'p2p',
      mode: 'chat',
      agentName: 'Cursor',
      agentType: 'cursor',
      status: 'idle',
      title: 'Cursor',
      messages: [],
    } as ActiveConversation)

    expect(html).not.toContain('Switch session?')
    expect(html).not.toContain('confirmSwitch')
  })

  it('never calls onSwitchSession/onResumeSavedSession directly from a list item onClick — only through the confirm step', () => {
    const source = readSource()

    // The chat-list item's onClick must stage a pending switch, not call onSwitchSession directly.
    const chatItemOnClickMatch = source.match(/onClick=\{\(\) => \{\s*if \(chat\.id === activeChatId\) return;\s*setPendingSwitch\(\{ kind: 'chat'[^}]*\}\);\s*\}\}/)
    expect(chatItemOnClickMatch).not.toBeNull()

    // The saved-session button's onClick must stage a pending switch, not call onResumeSavedSession directly.
    const savedItemOnClickMatch = source.match(/onClick=\{\(\) => \{\s*if \(isDisabled \|\| !onResumeSavedSession\) return;\s*setPendingSwitch\(\{ kind: 'saved', session \}\);\s*\}\}/)
    expect(savedItemOnClickMatch).not.toBeNull()

    // onSwitchSession/onResumeSavedSession must only be invoked inside the confirm dialog's confirm button.
    expect(source).toContain("if (target.kind === 'chat') {\n                                        onSwitchSession(activeConv.routeId, target.id);")
    expect(source).toContain('} else if (onResumeSavedSession) {\n                                        onResumeSavedSession(target.session);')
  })

  it('cancel clears pendingSwitch without touching switch/resume callbacks (source-level: cancel button only calls setPendingSwitch(null))', () => {
    const source = readSource()
    const cancelButtons = [...source.matchAll(/onClick=\{\(\) => setPendingSwitch\(null\)\}/g)]
    // Backdrop click + explicit Cancel button both just dismiss.
    expect(cancelButtons.length).toBeGreaterThanOrEqual(2)
  })

  it('renders identifying info (title + workspace) in the confirm copy path for a saved session target', () => {
    const source = readSource()
    expect(source).toContain('confirmSwitchDescription')
    expect(source).toContain('pendingSwitch.session.title')
    expect(source).toContain('pendingSwitch.session.workspace')
  })
})
