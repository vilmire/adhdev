import { describe, expect, it } from 'vitest'
import type { ActiveConversation } from '../../src/components/dashboard/types'
import type { LiveSessionInboxState } from '../../src/components/dashboard/DashboardMobileChatShared'
import {
  applyDashboardNotificationOverlays,
  buildDashboardNotificationCandidates,
  buildDashboardNotificationOverlays,
  buildDashboardNotificationStateBySessionId,
  deleteDashboardNotification,
  getDashboardNotificationUnreadCount,
  markDashboardNotificationRead,
  markDashboardNotificationUnread,
  markDashboardNotificationTargetRead,
  reduceDashboardNotificationOverlays,
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
  it('builds notification candidates from the shared display contract', () => {
    const conversation = createConversation({
      routeId: 'machine-1:ide:cursor-1',
      title: '',
      displayPrimary: '',
      agentName: '',
      tabKey: '',
      lastMessagePreview: '',
      displaySecondary: 'Cursor · Codex',
    })
    const stateBySessionId = new Map<string, LiveSessionInboxState>([
      ['session-1', createLiveState()],
    ])

    const candidates = buildDashboardNotificationCandidates([conversation], stateBySessionId)

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      title: 'machine-1:ide:cursor-1',
      preview: 'Cursor · Codex',
    })
  })

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

  it('keeps task-complete candidates aligned with notification unread state when live unread already cleared', () => {
    const conversation = createConversation({
      providerSessionId: 'provider-1',
    })
    const stateBySessionId = new Map<string, LiveSessionInboxState>([
      ['session-1', createLiveState({ unread: false, inboxBucket: 'task_complete' })],
    ])
    const notificationStateBySessionId = new Map([
      ['session-1', { unreadCount: 1, latestNotificationAt: 100, latestRecordId: 'task_complete|provider-1|hash-1|100' }],
    ])

    const candidates = buildDashboardNotificationCandidates(
      [conversation],
      stateBySessionId,
      notificationStateBySessionId,
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      type: 'task_complete',
      providerSessionId: 'provider-1',
      dedupKey: 'task_complete|provider-1|hash-1|100',
    })
  })

  it('keeps task-complete candidates alive for the current completion when a local force-unread overlay exists', () => {
    const conversation = createConversation({
      providerSessionId: 'provider-1',
    })
    const stateBySessionId = new Map<string, LiveSessionInboxState>([
      ['session-1', createLiveState({ unread: false, inboxBucket: 'task_complete' })],
    ])
    const overlayById = new Map([
      ['task_complete|provider-1|hash-1|100', { id: 'task_complete|provider-1|hash-1|100', forceUnread: true }],
    ])

    const candidates = buildDashboardNotificationCandidates(
      [conversation],
      stateBySessionId,
      undefined,
      overlayById,
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      type: 'task_complete',
      providerSessionId: 'provider-1',
      dedupKey: 'task_complete|provider-1|hash-1|100',
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

  it('dedupes resumed conversations by providerSessionId even when runtime session ids change', () => {
    const first = buildDashboardNotificationCandidates(
      [createConversation({
        sessionId: 'runtime-a',
        providerSessionId: 'provider-1',
        tabKey: 'tab-a',
        lastMessageHash: 'hash-1',
        lastMessageAt: 100,
      })],
      new Map<string, LiveSessionInboxState>([
        ['runtime-a', createLiveState({ sessionId: 'runtime-a', lastUpdated: 100 })],
      ]),
    )

    const second = buildDashboardNotificationCandidates(
      [createConversation({
        sessionId: 'runtime-b',
        providerSessionId: 'provider-1',
        tabKey: 'tab-b',
        lastMessageHash: 'hash-1',
        lastMessageAt: 100,
      })],
      new Map<string, LiveSessionInboxState>([
        ['runtime-b', createLiveState({ sessionId: 'runtime-b', lastUpdated: 100 })],
      ]),
    )

    expect(first[0]?.id).toBe('task_complete|provider-1|hash-1|100')
    expect(second[0]?.id).toBe(first[0]?.id)

    const reduced = reduceDashboardNotifications(first, second)
    expect(reduced).toHaveLength(1)
    expect(reduced[0]?.providerSessionId).toBe('provider-1')
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

  it('marks notifications read by providerSessionId across resumed runtime ids and updates state projections', () => {
    const records = [{
      id: 'task_complete|provider-1|hash-1|100',
      dedupKey: 'task_complete|provider-1|hash-1|100',
      type: 'task_complete' as const,
      routeId: 'machine-1',
      sessionId: 'runtime-a',
      providerSessionId: 'provider-1',
      tabKey: 'tab-a',
      title: 'Hermes',
      preview: 'Done',
      createdAt: 100,
      updatedAt: 100,
      lastEventAt: 100,
    }]

    const next = markDashboardNotificationTargetRead(records, { providerSessionId: 'provider-1' }, 250)
    expect(next[0]?.readAt).toBe(250)

    const stateBySessionId = buildDashboardNotificationStateBySessionId(next)
    expect(stateBySessionId.get('provider-1')?.unreadCount).toBe(0)
    expect(stateBySessionId.get('runtime-a')?.unreadCount).toBe(0)
    expect(stateBySessionId.get('tab-a')?.unreadCount).toBe(0)
  })

  it('matches notifications by route id when session identifiers are unavailable', () => {
    const records = [{
      id: 'task_complete|machine-1:ide:cursor-1|hash-1|100',
      dedupKey: 'task_complete|machine-1:ide:cursor-1|hash-1|100',
      type: 'task_complete' as const,
      routeId: 'machine-1:ide:cursor-1',
      title: 'Hermes',
      preview: 'Done',
      createdAt: 100,
      updatedAt: 100,
      lastEventAt: 100,
    }]

    const next = markDashboardNotificationTargetRead(records, { routeId: 'machine-1:ide:cursor-1' }, 250)
    expect(next[0]?.readAt).toBe(250)

    const stateBySessionId = buildDashboardNotificationStateBySessionId(next)
    expect(stateBySessionId.get('machine-1:ide:cursor-1')?.unreadCount).toBe(0)
  })

  it('does not clear sibling notifications on the same route when a more specific session target is present', () => {
    const records = [
      {
        id: 'task_complete|provider-1|hash-1|100',
        dedupKey: 'task_complete|provider-1|hash-1|100',
        type: 'task_complete' as const,
        routeId: 'machine-1:ide:cursor-1',
        sessionId: 'runtime-a',
        providerSessionId: 'provider-1',
        tabKey: 'tab-a',
        title: 'Codex A',
        preview: 'Done A',
        createdAt: 100,
        updatedAt: 100,
        lastEventAt: 100,
      },
      {
        id: 'task_complete|provider-2|hash-2|101',
        dedupKey: 'task_complete|provider-2|hash-2|101',
        type: 'task_complete' as const,
        routeId: 'machine-1:ide:cursor-1',
        sessionId: 'runtime-b',
        providerSessionId: 'provider-2',
        tabKey: 'tab-b',
        title: 'Codex B',
        preview: 'Done B',
        createdAt: 101,
        updatedAt: 101,
        lastEventAt: 101,
      },
    ]

    const next = markDashboardNotificationTargetRead(records, {
      sessionId: 'runtime-a',
      providerSessionId: 'provider-1',
      tabKey: 'tab-a',
      routeId: 'machine-1:ide:cursor-1',
    }, 250)

    expect(next.find(record => record.id === 'task_complete|provider-1|hash-1|100')?.readAt).toBe(250)
    expect(next.find(record => record.id === 'task_complete|provider-2|hash-2|101')?.readAt).toBeUndefined()
  })

  it('keeps only the latest notification per conversation target like a messenger inbox', () => {
    const existing = [
      {
        id: 'task_complete|provider-1|hash-1|100',
        dedupKey: 'task_complete|provider-1|hash-1|100',
        type: 'task_complete' as const,
        routeId: 'machine-1',
        sessionId: 'runtime-a',
        providerSessionId: 'provider-1',
        tabKey: 'tab-a',
        title: 'Hermes',
        preview: 'Older reply',
        createdAt: 100,
        updatedAt: 100,
        lastEventAt: 100,
      },
      {
        id: 'task_complete|provider-2|hash-9|190',
        dedupKey: 'task_complete|provider-2|hash-9|190',
        type: 'task_complete' as const,
        routeId: 'machine-2',
        sessionId: 'runtime-z',
        providerSessionId: 'provider-2',
        tabKey: 'tab-z',
        title: 'Codex',
        preview: 'Other conversation',
        createdAt: 190,
        updatedAt: 190,
        lastEventAt: 190,
      },
    ]
    const incoming = [
      {
        id: 'task_complete|provider-1|hash-2|200',
        dedupKey: 'task_complete|provider-1|hash-2|200',
        type: 'task_complete' as const,
        routeId: 'machine-1',
        sessionId: 'runtime-b',
        providerSessionId: 'provider-1',
        tabKey: 'tab-b',
        title: 'Hermes',
        preview: 'Newest reply',
        createdAt: 200,
        updatedAt: 200,
        lastEventAt: 200,
      },
      {
        id: 'task_complete|provider-2|hash-9|190',
        dedupKey: 'task_complete|provider-2|hash-9|190',
        type: 'task_complete' as const,
        routeId: 'machine-2',
        sessionId: 'runtime-z',
        providerSessionId: 'provider-2',
        tabKey: 'tab-z',
        title: 'Codex',
        preview: 'Other conversation',
        createdAt: 190,
        updatedAt: 190,
        lastEventAt: 190,
      },
    ]

    const next = reduceDashboardNotifications(existing, incoming)

    expect(next).toHaveLength(2)
    expect(next.map(record => record.id)).toEqual([
      'task_complete|provider-1|hash-2|200',
      'task_complete|provider-2|hash-9|190',
    ])
    expect(next.find(record => record.providerSessionId === 'provider-1')?.preview).toBe('Newest reply')
  })

  it('drops local-only notifications that are no longer present in daemon-derived candidates', () => {
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
    }]

    const next = reduceDashboardNotifications(existing, [])

    expect(next).toEqual([])
  })

  it('applies overlay-only read state onto current daemon-derived candidates without keeping old presentation records', () => {
    const incoming = [{
      id: 'task_complete|provider-1|hash-2|200',
      dedupKey: 'task_complete|provider-1|hash-2|200',
      type: 'task_complete' as const,
      routeId: 'machine-1',
      sessionId: 'runtime-b',
      providerSessionId: 'provider-1',
      tabKey: 'tab-b',
      title: 'Hermes fresh',
      preview: 'Newest reply',
      createdAt: 200,
      updatedAt: 200,
      lastEventAt: 200,
    }]
    const overlays = [{
      id: 'task_complete|provider-1|hash-2|200',
      readAt: 250,
    }]

    const next = applyDashboardNotificationOverlays(incoming, overlays)

    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({
      id: 'task_complete|provider-1|hash-2|200',
      title: 'Hermes fresh',
      preview: 'Newest reply',
      readAt: 250,
      createdAt: 200,
      updatedAt: 200,
    })
  })

  it('serializes only local overlay metadata for current notifications', () => {
    const records = [
      {
        id: 'task_complete|provider-1|hash-1|100',
        dedupKey: 'task_complete|provider-1|hash-1|100',
        type: 'task_complete' as const,
        routeId: 'machine-1',
        sessionId: 'runtime-a',
        providerSessionId: 'provider-1',
        tabKey: 'tab-a',
        title: 'Hermes',
        preview: 'Done',
        createdAt: 100,
        updatedAt: 100,
        lastEventAt: 100,
        readAt: 150,
      },
      {
        id: 'needs_attention|provider-2|hash-2|200',
        dedupKey: 'needs_attention|provider-2|hash-2|200',
        type: 'needs_attention' as const,
        routeId: 'machine-2',
        sessionId: 'runtime-b',
        providerSessionId: 'provider-2',
        tabKey: 'tab-b',
        title: 'Codex',
        preview: 'Approve',
        createdAt: 200,
        updatedAt: 200,
        lastEventAt: 200,
      },
    ]

    expect(buildDashboardNotificationOverlays(records)).toEqual([
      { id: 'task_complete|provider-1|hash-1|100', readAt: 150 },
    ])
  })

  it('drops stale overlay-only state when daemon-derived candidates disappear', () => {
    const overlays = [
      { id: 'task_complete|provider-1|hash-1|100', readAt: 150 },
      { id: 'needs_attention|provider-2|hash-2|200', deletedAt: 250 },
    ]

    expect(reduceDashboardNotificationOverlays(overlays, [])).toEqual([])
  })
})
