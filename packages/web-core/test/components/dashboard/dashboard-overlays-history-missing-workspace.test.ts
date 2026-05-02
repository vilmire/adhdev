import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import DashboardOverlays from '../../../src/components/dashboard/DashboardOverlays'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

function makeCliConversation(): ActiveConversation {
  return {
    routeId: 'machine-1',
    daemonId: 'machine-1',
    transport: 'pty',
    mode: 'chat',
    agentName: 'Hermes',
    agentType: 'hermes-cli',
    providerSessionId: 'active-hermes-session',
    status: 'idle',
    title: 'Hermes',
    messages: [],
  } as ActiveConversation
}

describe('DashboardOverlays saved-history missing workspace resume path', () => {
  it('passes the current workspace fallback into the saved-history modal', () => {
    const html = renderToStaticMarkup(
      React.createElement(DashboardOverlays, {
        historyModal: {
          open: true,
          targetConv: makeCliConversation(),
          ides: [],
          isCreatingChat: false,
          isRefreshingHistory: false,
          savedSessions: [{
            id: 'native-session-1',
            providerSessionId: 'native-session-1',
            providerType: 'hermes-cli',
            providerName: 'Hermes',
            kind: 'cli',
            title: 'Native Hermes session',
            preview: 'No workspace stored in native Hermes JSON.',
            workspace: null,
            messageCount: 3,
            firstMessageAt: 1,
            lastMessageAt: 2,
            canResume: false,
          }],
          savedHistoryFilters: {
            textQuery: '',
            workspaceQuery: '',
            modelQuery: '',
            resumableOnly: false,
            sortMode: 'recent',
          },
          missingWorkspaceResumePath: '/workspaces/adhdev',
          onSavedHistoryFiltersChange: () => {},
          isSavedSessionsLoading: false,
          isResumingSavedSessionId: null,
          onClose: () => {},
          onNewChat: () => {},
          onSwitchSession: () => {},
          onRefreshHistory: () => {},
          onResumeSavedSession: () => {},
        },
        remoteDialog: {
          conversation: null,
          ides: [],
          connectionStates: {},
          actionLogs: [],
          sendDaemonCommand: async () => ({}),
          setActionLogs: () => {},
          isStandalone: false,
          onOpenHistory: () => {},
          onConversationChange: () => {},
          onClose: () => {},
        },
        cliStopDialog: {
          open: false,
          onCancel: () => {},
          onStopNow: () => {},
          onSaveAndStop: () => {},
        },
        connectionBanner: {
          wsStatus: 'connected',
          showReconnected: false,
        },
        toastOverlay: {
          toasts: [],
          onDismiss: () => {},
        },
        onboarding: {
          open: false,
          onClose: () => {},
        },
      }),
    )

    expect(html).toContain('/workspaces/adhdev')
    expect(html).toContain('RESUME IN SELECTED WORKSPACE')
    expect(html).not.toContain('MISSING WORKSPACE')
  })
})
