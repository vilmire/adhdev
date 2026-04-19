import { describe, expect, it } from 'vitest'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { DashboardNotificationSessionState } from '../../../src/utils/dashboard-notifications'
import type { LiveSessionInboxState } from '../../../src/components/dashboard/DashboardMobileChatShared'
import {
  getConversationInboxSurfaceState,
  isConversationTaskCompleteUnread,
} from '../../../src/components/dashboard/DashboardMobileChatShared'

function createConversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
  return {
    routeId: 'machine-1',
    sessionId: 'session-1',
    providerSessionId: 'provider-1',
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
    lastMessagePreview: 'Done',
    lastMessageHash: 'hash-1',
    lastMessageAt: 100,
    lastUpdated: 100,
    ...overrides,
  }
}

function createLiveState(overrides: Partial<LiveSessionInboxState> = {}): LiveSessionInboxState {
  return {
    sessionId: 'session-1',
    unread: false,
    lastSeenAt: 0,
    lastUpdated: 100,
    inboxBucket: 'task_complete',
    surfaceHidden: false,
    ...overrides,
  }
}

function createNotificationState(overrides: Partial<DashboardNotificationSessionState> = {}): DashboardNotificationSessionState {
  return {
    unreadCount: 1,
    latestNotificationAt: 100,
    latestRecordId: 'task_complete|provider-1|hash-1|100',
    ...overrides,
  }
}

describe('DashboardMobileChatShared', () => {
  it('keeps task-complete unread state aligned with notification state across surfaces', () => {
    const conversation = createConversation()
    const liveState = new Map<string, LiveSessionInboxState>([
      ['session-1', createLiveState({ unread: false })],
    ])
    const notificationStateBySessionId = new Map<string, DashboardNotificationSessionState>([
      ['session-1', createNotificationState({ unreadCount: 1 })],
    ])

    const surfaceState = getConversationInboxSurfaceState(conversation, liveState, {
      notificationStateBySessionId,
    })

    expect(surfaceState.unread).toBe(true)
    expect(surfaceState.inboxBucket).toBe('task_complete')
    expect(isConversationTaskCompleteUnread(conversation, liveState, {
      notificationStateBySessionId,
    })).toBe(true)
  })

  it('hides task-complete unread state for the currently open conversation', () => {
    const conversation = createConversation()
    const liveState = new Map<string, LiveSessionInboxState>([
      ['session-1', createLiveState({ unread: true })],
    ])

    const surfaceState = getConversationInboxSurfaceState(conversation, liveState, {
      hideOpenTaskCompleteUnread: true,
      isOpenConversation: true,
    })

    expect(surfaceState.unread).toBe(false)
    expect(surfaceState.inboxBucket).toBe('idle')
  })
})
