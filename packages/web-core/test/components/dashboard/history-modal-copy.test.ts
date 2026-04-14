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
    expect(html).toContain('Use saved history when you want continuity in the same provider conversation.')
    expect(html).toContain('No saved history found yet.')
    expect(html).toContain('Refresh saved history')
  })

  it('renders persisted saved-history filter values when provided by the parent', () => {
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
    } as ActiveConversation, {
      savedHistoryFilters: {
        textQuery: 'sonnet',
        workspaceQuery: 'remote_vs',
        modelQuery: 'gpt-5.4',
        resumableOnly: true,
        sortMode: 'messages',
      },
      savedSessions: [{
        id: 'session-1',
        providerSessionId: 'session-1',
        providerType: 'hermes-cli',
        providerName: 'Hermes',
        kind: 'cli',
        title: 'Need sonnet follow-up',
        preview: 'reply with exactly ok',
        workspace: '/tmp/remote_vs',
        currentModel: 'gpt-5.4',
        messageCount: 2,
        firstMessageAt: 1,
        lastMessageAt: 2,
        canResume: true,
      }],
    })

    expect(html).toContain('value="sonnet"')
    expect(html).toContain('value="remote_vs"')
    expect(html).toContain('value="gpt-5.4"')
    expect(html).toContain('checked=""')
    expect(html).toContain('value="messages"')
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
