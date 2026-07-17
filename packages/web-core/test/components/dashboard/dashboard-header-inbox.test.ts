import React from 'react'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import DashboardHeader, { getDashboardHeaderConnectionState } from '../../../src/components/dashboard/DashboardHeader'
import { DASHBOARD_NEW_SESSION_LABEL } from '../../../src/components/dashboard/dashboard-session-cta'
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
  const activeConv = (overrides.activeConv as ActiveConversation | undefined) ?? createConversation()
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
        onOpenNewSession: () => {},
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
      titleKey: 'connection.disconnected',
      subtitleKey: null,
    })

    expect(getDashboardHeaderConnectionState({
      wsStatus: 'connected',
      isConnected: false,
      daemonCount: 0,
      p2pStates: {},
    })).toEqual({
      tone: 'limited',
      titleKey: 'connection.connectedToDashboard',
      subtitleKey: null,
    })

    expect(getDashboardHeaderConnectionState({
      wsStatus: 'connected',
      isConnected: true,
      daemonCount: 0,
      p2pStates: {},
    })).toEqual({
      tone: 'connected',
      titleKey: 'connection.connected',
      subtitleKey: null,
    })

    expect(getDashboardHeaderConnectionState({
      wsStatus: 'connected',
      isConnected: false,
      daemonCount: 1,
      p2pStates: { 'machine-1': 'connecting' },
    })).toEqual({
      tone: 'limited',
      titleKey: 'connection.connectedToDashboard',
      subtitleKey: 'connection.connectingToMachine',
    })

    expect(getDashboardHeaderConnectionState({
      wsStatus: 'connected',
      isConnected: true,
      daemonCount: 1,
      p2pStates: { 'machine-1': 'connected' },
    })).toEqual({
      tone: 'connected',
      titleKey: 'connection.connected',
      subtitleKey: null,
    })
  })

  it('shows transitional machine connection copy only before any P2P connection is established', () => {
    expect(getDashboardHeaderConnectionState({
      wsStatus: 'connected',
      isConnected: false,
      daemonCount: 1,
      p2pStates: { 'machine-1': 'connecting' },
    }).subtitleKey).toBe('connection.connectingToMachine')

    expect(getDashboardHeaderConnectionState({
      wsStatus: 'connected',
      isConnected: true,
      daemonCount: 1,
      p2pStates: { 'machine-1': 'connected' },
    }).subtitleKey).toBeNull()

    expect(getDashboardHeaderConnectionState({
      wsStatus: 'connected',
      isConnected: false,
      daemonCount: 1,
      p2pStates: {},
    }).subtitleKey).toBeNull()
  })

  it('renders the connection dot in the title row so it aligns with the Dashboard text baseline', () => {
    const html = renderHeader()

    expect(html).toContain('header-title-status-dot')
    expect(html).not.toContain('header-subtitle-dot')
    expect(html.indexOf('header-title-status-dot')).toBeGreaterThan(html.indexOf('header-title-desktop'))
    expect(html.indexOf('header-title-status-dot')).toBeLessThan(html.indexOf('header-subtitle'))
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
    expect(html).toContain(DASHBOARD_NEW_SESSION_LABEL)
    expect(html).toContain('>1<')
  })

  it('renders the dashboard guide in the header instead of a floating bottom-right overlay that can collide with chat jump buttons', () => {
    const html = renderHeader({ onOpenDashboardGuide: () => {}, guideNudgeVisible: true })
    const mainViewSource = readFileSync(path.resolve(process.cwd(), 'src/components/dashboard/DashboardMainView.tsx'), 'utf8')

    expect(html).toContain('Open dashboard guide')
    expect(html).toContain('Guide')
    expect(mainViewSource).not.toContain('fixed right-4 bottom-24')
  })

  it('keeps the mesh graph header button compact beside the CLI view toggle', () => {
    const html = renderHeader({
      activeConv: createConversation({
        daemonId: 'daemon-1',
        coordinator: { meshId: 'mesh-1', role: 'coordinator' },
      }),
      onOpenMeshGraph: () => {},
    })
    const css = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8')

    expect(html).toContain('dashboard-header-mesh-button')
    expect(html).toContain('Open live repo mesh graph')
    expect(css).toContain('.dashboard-header-mesh-button')
    expect(css).toContain('height: 32px;')
    expect(css).toContain('padding: 4px 8px;')
    expect(css).toContain('line-height: 1;')
  })
})
