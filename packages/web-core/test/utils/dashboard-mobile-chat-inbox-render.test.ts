import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import DashboardMobileChatInbox from '../../src/components/dashboard/DashboardMobileChatInbox'
import type { MobileConversationListItem } from '../../src/components/dashboard/DashboardMobileChatShared'
import type { ActiveConversation } from '../../src/components/dashboard/types'

function makeConversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
  return {
    routeId: 'daemon-1',
    sessionId: 'session-1',
    daemonId: 'daemon-1',
    agentName: 'Codex',
    agentType: 'codex',
    status: 'idle',
    title: 'Refactor mobile inbox',
    messages: [],
    workspaceName: 'adhdev',
    displayPrimary: 'Refactor mobile inbox',
    displaySecondary: 'Codex · adhdev',
    streamSource: 'native',
    tabKey: 'daemon-1:session-1',
    machineName: 'devbox',
    ...overrides,
  }
}

function makeItem(conversation: ActiveConversation): MobileConversationListItem {
  return {
    conversation,
    timestamp: Date.now(),
    preview: 'Last assistant message preview',
    unread: false,
    requiresAction: false,
    isWorking: false,
    inboxBucket: 'idle',
  }
}

describe('DashboardMobileChatInbox render behavior', () => {
  it('renders the mobile hide action under the leading chat icon and keeps hiding behind confirmation state', () => {
    const conversation = makeConversation()
    const html = renderToStaticMarkup(
      React.createElement(DashboardMobileChatInbox, {
        section: 'chats',
        attentionItems: [],
        unreadItems: [],
        workingItems: [],
        completedItems: [makeItem(conversation)],
        hiddenConversations: [],
        machineCards: [],
        getAvatarText: () => 'C',
        actionLogs: [],
        sendDaemonCommand: vi.fn(),
        onOpenConversation: vi.fn(),
        onShowAllHidden: vi.fn(),
        onHideConversation: vi.fn(),
        onOpenMachine: vi.fn(),
        onOpenSettings: vi.fn(),
        onSectionChange: vi.fn(),
        wsStatus: 'connected',
      }),
    )

    const railIndex = html.indexOf('mobile-inbox-leading-rail')
    const hideIndex = html.indexOf('mobile-inbox-hide-button')
    const titleIndex = html.indexOf('Refactor mobile inbox')

    expect(railIndex).toBeGreaterThanOrEqual(0)
    expect(hideIndex).toBeGreaterThan(railIndex)
    expect(titleIndex).toBeGreaterThan(hideIndex)
    expect(html).not.toContain('Hide this chat from the inbox?')
  })
})
