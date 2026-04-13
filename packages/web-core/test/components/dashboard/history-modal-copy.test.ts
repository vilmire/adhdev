import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import HistoryModal from '../../../src/components/dashboard/HistoryModal'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

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

describe('HistoryModal saved-history wording', () => {
  it('uses saved-history wording for CLI resume mode', () => {
    const html = renderHistoryModal({
      routeId: 'machine-1',
      transport: 'pty',
      mode: 'chat',
      agentName: 'Hermes',
      agentType: 'hermes-cli',
      providerSessionId: 'provider-session-1',
      status: 'idle',
      title: 'Hermes',
      messages: [],
    } as ActiveConversation)

    expect(html).toContain('Saved History')
    expect(html).toContain('No saved history found yet.')
    expect(html).toContain('Refresh saved history')
  })

  it('keeps chat history wording for non-saved-session mode', () => {
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

    expect(html).toContain('Chat History')
    expect(html).toContain('Start New Chat Session')
  })
})
