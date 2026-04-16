import { describe, expect, it } from 'vitest'
import type { ActiveConversation } from '../../src/components/dashboard/types'
import type { LiveSessionInboxState } from '../../src/components/dashboard/DashboardMobileChatShared'
import {
  buildDashboardNotificationCandidates,
  deleteDashboardNotification,
  getDashboardNotificationUnreadCount,
  markDashboardNotificationRead,
  markDashboardNotificationUnread,
  markDashboardNotificationTargetRead,
  reduceDashboardNotifications,
} from '../../src/utils/dashboard-notifications'

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
    unread: true,
    lastSeenAt: 0,
    lastUpdated: 100,
    inboxBucket: 'task_complete',
    surfaceHidden: false,
    ...overrides,
  }
}

describe('dashboard notifications', () => {
  it('builds one task-complete notification candidate per unique completion event', () => {
    const conversation = createConversation()
    const stateBySessionId = new Map<string, LiveSessionInboxState>([
      ['session-1', createLiveState()],
    ])

    const candidates = buildDashboardNotificationCandidates([conversation], stateBySessionId)

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      type: 'task_complete',
      sessionId: 'session-1',
      tabKey: 'tab-1',
      title: 'Hermes',
      preview: 'Done',
      dedupKey: 'task_complete|session-1|hash-1|100',
    })
  })

  it('dedupes repeated completion candidates while keeping the existing read state', () => {
    const existing = [{
      id: 'task_complete|session-1|hash-1|100',
      dedupKey: 'task_complete|session-1|hash-1|100',
      type: 'task_complete' as const,
      routeId: 'machine-1',
      sessionId: 'session-1',
      tabKey: 'tab-1',
      title: 'Hermes',
      preview: 'Done',
      createdAt: 100,
      updatedAt: 100,
      lastEventAt: 100,
      readAt: 120,
    }]
    const incoming = [{
      id: 'task_complete|session-1|hash-1|100',
      dedupKey: 'task_complete|session-1|hash-1|100',
      type: 'task_complete' as const,
      routeId: 'machine-1',
      sessionId: 'session-1',
      tabKey: 'tab-1',
      title: 'Hermes',
      preview: 'Done again',
      createdAt: 150,
      updatedAt: 150,
      lastEventAt: 150,
    }]

    const next = reduceDashboardNotifications(existing, incoming)

    expect(next).toHaveLength(1)
    expect(next[0]?.readAt).toBe(120)
    expect(next[0]?.createdAt).toBe(100)
    expect(next[0]?.updatedAt).toBe(150)
    expect(next[0]?.preview).toBe('Done again')
  })

  it('does not create duplicate unread notifications when only polling timestamps change for the same completion', () => {
    const conversation = createConversation({
      sessionId: 'session-1',
      tabKey: 'tab-1',
      lastMessageHash: 'hash-1',
      lastMessageAt: 100,
      lastUpdated: 100,
    })

    const firstCandidates = buildDashboardNotificationCandidates(
      [conversation],
      new Map<string, LiveSessionInboxState>([
        ['session-1', createLiveState({ lastUpdated: 100 })],
      ]),
    )

    const secondCandidates = buildDashboardNotificationCandidates(
      [{ ...conversation, lastUpdated: 250 }],
      new Map<string, LiveSessionInboxState>([
        ['session-1', createLiveState({ lastUpdated: 250 })],
      ]),
    )

    expect(firstCandidates).toHaveLength(1)
    expect(secondCandidates).toHaveLength(1)
    expect(secondCandidates[0]?.id).toBe(firstCandidates[0]?.id)

    const reduced = reduceDashboardNotifications(firstCandidates, secondCandidates)
    expect(reduced).toHaveLength(1)
    expect(reduced[0]?.createdAt).toBe(100)
  })

  it('supports read, unread, delete, and unread-count projections from the same records', () => {
    const records = [
      {
        id: 'a',
        dedupKey: 'a',
        type: 'task_complete' as const,
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
        id: 'b',
        dedupKey: 'b',
        type: 'needs_attention' as const,
        routeId: 'machine-2',
        sessionId: 'session-2',
        tabKey: 'tab-2',
        title: 'Codex',
        preview: 'Approve',
        createdAt: 101,
        updatedAt: 101,
        lastEventAt: 101,
      },
    ]

    const read = markDashboardNotificationRead(records, 'a', 200)
    expect(getDashboardNotificationUnreadCount(read)).toBe(1)
    expect(read.find(record => record.id === 'a')?.readAt).toBe(200)

    const unreadAgain = markDashboardNotificationUnread(read, 'a')
    expect(getDashboardNotificationUnreadCount(unreadAgain)).toBe(2)
    expect(unreadAgain.find(record => record.id === 'a')?.readAt).toBeUndefined()

    const deleted = deleteDashboardNotification(unreadAgain, 'b')
    expect(deleted).toHaveLength(1)
    expect(deleted[0]?.id).toBe('a')
    expect(getDashboardNotificationUnreadCount(deleted)).toBe(1)
  })

  it('marks all notifications for the same session target as read together', () => {
    const records = [
      {
        id: 'a',
        dedupKey: 'a',
        type: 'task_complete' as const,
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
        id: 'b',
        dedupKey: 'b',
        type: 'needs_attention' as const,
        routeId: 'machine-1',
        sessionId: 'session-1',
        tabKey: 'tab-1',
        title: 'Hermes',
        preview: 'Approve',
        createdAt: 101,
        updatedAt: 101,
        lastEventAt: 101,
      },
      {
        id: 'c',
        dedupKey: 'c',
        type: 'task_complete' as const,
        routeId: 'machine-2',
        sessionId: 'session-2',
        tabKey: 'tab-2',
        title: 'Codex',
        preview: 'Other',
        createdAt: 102,
        updatedAt: 102,
        lastEventAt: 102,
      },
    ]

    const next = markDashboardNotificationTargetRead(records, { sessionId: 'session-1', tabKey: 'tab-1' }, 400)

    expect(next.find(record => record.id === 'a')?.readAt).toBe(400)
    expect(next.find(record => record.id === 'b')?.readAt).toBe(400)
    expect(next.find(record => record.id === 'c')?.readAt).toBeUndefined()
  })

  it('keeps only the most recent retained notifications', () => {
    const existing = Array.from({ length: 4 }, (_, index) => ({
      id: `n-${index}`,
      dedupKey: `n-${index}`,
      type: 'task_complete' as const,
      routeId: 'machine-1',
      sessionId: `session-${index}`,
      tabKey: `tab-${index}`,
      title: `Session ${index}`,
      preview: `Preview ${index}`,
      createdAt: index,
      updatedAt: index,
      lastEventAt: index,
    }))

    const next = reduceDashboardNotifications(existing, [], 2)

    expect(next.map(record => record.id)).toEqual(['n-3', 'n-2'])
  })
})
