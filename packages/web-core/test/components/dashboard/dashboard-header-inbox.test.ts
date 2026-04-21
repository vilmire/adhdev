import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import DashboardHeader, { getDashboardHeaderConnectionState } from '../../../src/components/dashboard/DashboardHeader'
import { BaseDaemonProvider } from '../../../src/context/BaseDaemonContext'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { DashboardNotificationRecord } from '../../../src/utils/dashboard-notifications'

function createConversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
  return {
    routeId: 'machine-1',
    sessionId: 'session-1',
    transport: 'pty',
    mode: 'chat',
    agentName: 'Hermes',
    agentType: 'hermes-cli',
    status: 'idle',
    title: 'Hermes',
    messages: [],
    workspaceName: '/repo',
    displayPrimary: 'Hermes',
    displaySecondary: 'machine-1',
    streamSource: 'native',
    tabKey: 'tab-1',
    ...overrides,
  }
}

function renderHeader(overrides: Record<string, unknown> = {}) {
  const activeConv = createConversation()
  const notifications: DashboardNotificationRecord[] = [
    {
      id: 'n-1',
      dedupKey: 'n-1',
      type: 'task_complete',
      routeId: 'machine-1',
      sessionId: 'session-1',
      tabKey: 'tab-1',
      title: 'Hermes',
      preview: 'Done',
      createdAt: 100,
      updatedAt: 100,
      lastEventAt: 100,
    },
    {
      id: 'n-2',
      dedupKey: 'n-2',
      type: 'needs_attention',
      routeId: 'machine-1',
      sessionId: 'session-2',
      tabKey: 'tab-2',
      title: 'Codex',
      preview: 'Approve',
      createdAt: 200,
      updatedAt: 200,
      lastEventAt: 200,
      readAt: 250,
    },
  ]

  return renderToStaticMarkup(
    React.createElement(
      BaseDaemonProvider,
      null,
      React.createElement(DashboardHeader, {
        activeConv,
        wsStatus: 'connected',
        isConnected: true,
        conversations: [activeConv, createConversation({ sessionId: 'session-2', tabKey: 'tab-2', title: 'Codex', agentName: 'Codex', agentType: 'codex' })],
        onOpenHistory: () => {},
        onInboxOpenChange: () => {},
        onHiddenOpenChange: () => {},
        inboxOpen: true,
        hiddenOpen: false,
        notifications,
        notificationUnreadCount: 1,
        onOpenNotification: () => {},
        onMarkNotificationRead: () => {},
        onMarkNotificationUnread: () => {},
        onDeleteNotification: () => {},
        ...overrides,
      }),
    ),
  )
}

describe('DashboardHeader inbox notifications', () => {
  it('maps dashboard connection states to explicit English labels without legacy partial/waiting copy', () => {
    expect(getDashboardHeaderConnectionState({
      wsStatus: 'disconnected',
      isConnected: false,
      daemonCount: 0,
      p2pStates: {},
    })).toEqual({
      tone: 'disconnected',
      title: 'Disconnected',
      subtitle: null,
    })

    expect(getDashboardHeaderConnectionState({
      wsStatus: 'connected',
      isConnected: false,
      daemonCount: 0,
      p2pStates: {},
    })).toEqual({
      tone: 'limited',
      title: 'Connected to dashboard',
      subtitle: null,
    })

    expect(getDashboardHeaderConnectionState({
      wsStatus: 'connected',
      isConnected: true,
      daemonCount: 0,
      p2pStates: {},
    })).toEqual({
      tone: 'connected',
      title: 'Connected',
      subtitle: null,
    })

    expect(getDashboardHeaderConnectionState({
      wsStatus: 'connected',
      isConnected: false,
      daemonCount: 1,
      p2pStates: { 'machine-1': 'connecting' },
    })).toEqual({
      tone: 'limited',
      title: 'Connected to dashboard',
      subtitle: 'Connecting to machine...',
    })

    expect(getDashboardHeaderConnectionState({
      wsStatus: 'connected',
      isConnected: true,
      daemonCount: 1,
      p2pStates: { 'machine-1': 'connected' },
    })).toEqual({
      tone: 'connected',
      title: 'Connected',
      subtitle: null,
    })
  })

  it('shows transitional machine connection copy only before any P2P connection is established', () => {
    expect(getDashboardHeaderConnectionState({
      wsStatus: 'connected',
      isConnected: false,
      daemonCount: 1,
      p2pStates: { 'machine-1': 'connecting' },
    }).subtitle).toBe('Connecting to machine...')

    expect(getDashboardHeaderConnectionState({
      wsStatus: 'connected',
      isConnected: true,
      daemonCount: 1,
      p2pStates: { 'machine-1': 'connected' },
    }).subtitle).toBeNull()

    expect(getDashboardHeaderConnectionState({
      wsStatus: 'connected',
      isConnected: false,
      daemonCount: 1,
      p2pStates: {},
    }).subtitle).toBeNull()
  })

  it('renders unread and read notification sections with read/unread/delete actions', () => {
    const html = renderHeader()

    expect(html).toContain('Unread')
    expect(html).toContain('Read')
    expect(html).toContain('Hermes')
    expect(html).toContain('Codex')
    expect(html).toContain('Mark read')
    expect(html).toContain('Mark unread')
    expect(html).toContain('Delete')
    expect(html).toContain('>1<')
  })
})
