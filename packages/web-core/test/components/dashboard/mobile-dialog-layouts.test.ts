import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import DashboardNewSessionDialog from '../../../src/components/dashboard/DashboardNewSessionDialog'
import HistoryModal from '../../../src/components/dashboard/HistoryModal'
import CliStopDialog from '../../../src/components/dashboard/CliStopDialog'
import LaunchConfirmDialog from '../../../src/components/machine/LaunchConfirmDialog'
import WorkspaceBrowseDialog from '../../../src/components/machine/WorkspaceBrowseDialog'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

vi.mock('../../../src/hooks/useDaemonMetadataLoader', () => ({
  useDaemonMetadataLoader: () => async () => {},
}))

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

describe('mobile dialog layouts', () => {
  it('renders the new-session dialog with a mobile-safe sheet layout', () => {
    const html = renderToStaticMarkup(
      React.createElement(DashboardNewSessionDialog, {
        machines: [{
          id: 'machine-1',
          workspaces: [],
          availableProviders: [{ category: 'cli', installed: true, type: 'hermes-cli', displayName: 'Hermes' }],
          detectedIdes: [],
          recentLaunches: [],
        } as any],
        conversations: [createConversation()],
        ides: [],
        onClose: () => {},
        onBrowseDirectory: async () => ({ path: '/repo', directories: [] }),
        onSaveWorkspace: async () => ({ ok: true }),
        onLaunchIde: async () => ({ ok: true }),
        onLaunchProvider: async () => ({ ok: true }),
        onListSavedSessions: async () => [],
        sendDaemonCommand: async () => ({}),
        onOpenConversation: () => {},
      }),
    )

    expect(html).toContain('items-end justify-center overflow-y-auto')
    expect(html).toContain('sm:items-center sm:p-4')
    expect(html).toContain('max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-16px)]')
    expect(html).toContain('py-[calc(12px+env(safe-area-inset-bottom,0px))]')
  })

  it('renders history modal with mobile-safe height and scrolling', () => {
    const html = renderToStaticMarkup(
      React.createElement(HistoryModal, {
        activeConv: createConversation(),
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
      }),
    )

    expect(html).toContain('items-end justify-center overflow-y-auto')
    expect(html).toContain('sm:max-h-[80vh]')
    expect(html).toContain('flex-1 min-h-0 overflow-y-auto')
    expect(html).toContain('py-[calc(12px+env(safe-area-inset-bottom,0px))]')
  })

  it('renders launch confirmation and workspace browser with scrollable mobile-safe frames', () => {
    const confirmHtml = renderToStaticMarkup(
      React.createElement(LaunchConfirmDialog, {
        title: 'Launch CLI',
        description: 'Confirm launch',
        details: [{ label: 'Provider', value: 'Hermes' }],
        onConfirm: () => {},
        onCancel: () => {},
      }),
    )
    const browseHtml = renderToStaticMarkup(
      React.createElement(WorkspaceBrowseDialog, {
        title: 'Select workspace',
        description: 'Pick a folder',
        currentPath: '/repo',
        directories: [],
        onClose: () => {},
        onNavigate: () => {},
        onConfirm: () => {},
      }),
    )

    expect(confirmHtml).toContain('items-end justify-center overflow-y-auto')
    expect(confirmHtml).toContain('flex-1 min-h-0 overflow-y-auto')
    expect(browseHtml).toContain('items-end justify-center overflow-y-auto')
    expect(browseHtml).toContain('max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-16px)]')
  })

  it('renders stop dialog with a bottom-anchored mobile layout', () => {
    const html = renderToStaticMarkup(
      React.createElement(CliStopDialog, {
        activeConv: createConversation(),
        onCancel: () => {},
        onStopNow: () => {},
        onSaveAndStop: () => {},
      }),
    )

    expect(html).toContain('items-end justify-center overflow-y-auto')
    expect(html).toContain('rounded-[24px]')
    expect(html).toContain('max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-16px)]')
  })
})
