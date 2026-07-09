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

    // Layout: leading rail (avatar + Graph) → content (title) → top-right
    // corner-actions cluster (timestamp · Mute · Hide · Stop). So Hide is icon-only
    // in the corner cluster, rendered after the title in DOM order.
    expect(railIndex).toBeGreaterThanOrEqual(0)
    expect(hideIndex).toBeGreaterThan(railIndex)
    expect(hideIndex).toBeGreaterThan(titleIndex)
    expect(html).not.toContain('Hide this chat from the inbox?')
  })

  it('renders a dedicated mesh graph affordance in mobile inbox rows for coordinator conversations', () => {
    const conversation = makeConversation({
      settings: { meshCoordinatorFor: 'mesh-123' } as ActiveConversation['settings'],
    })
    const html = renderToStaticMarkup(
      React.createElement(DashboardMobileChatInbox, {
        section: 'chats',
        attentionItems: [],
        unreadItems: [],
        workingItems: [makeItem(conversation)],
        completedItems: [],
        hiddenConversations: [],
        machineCards: [],
        getAvatarText: () => 'C',
        actionLogs: [],
        sendDaemonCommand: vi.fn(),
        onOpenConversation: vi.fn(),
        onShowAllHidden: vi.fn(),
        onHideConversation: vi.fn(),
        onOpenMeshGraph: vi.fn(),
        onOpenMachine: vi.fn(),
        onOpenSettings: vi.fn(),
        onSectionChange: vi.fn(),
        wsStatus: 'connected',
      }),
    )

    const railIndex = html.indexOf('mobile-inbox-leading-rail')
    const hideIndex = html.indexOf('mobile-inbox-hide-button')
    const meshIndex = html.indexOf('mobile-inbox-mesh-button')

    // Graph (mesh) button lives in the leading rail under the avatar (before the
    // title); Hide lives in the top-right corner cluster (after). So the mesh
    // button precedes Hide in DOM order and sits just after the rail marker.
    expect(meshIndex).toBeGreaterThan(railIndex)
    expect(hideIndex).toBeGreaterThan(meshIndex)
    expect(html).toContain('Open mesh graph for Refactor mobile inbox')
  })
})
