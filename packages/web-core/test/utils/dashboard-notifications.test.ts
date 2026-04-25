import { describe, expect, it } from 'vitest'
import type { ActiveConversation } from '../../src/components/dashboard/types'
import type { LiveSessionInboxState } from '../../src/components/dashboard/DashboardMobileChatShared'
import {
  buildDashboardNotificationCandidates,
  getDashboardNotificationUnreadCount,
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
    completionMarker: 'turn:1',
    seenCompletionMarker: '',
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

  it('uses the rich transcript tail for notification preview when compact preview is stale', () => {
    const conversation = createConversation({
      lastMessagePreview: 'Older compact preview',
      lastMessageAt: 1000,
      messages: [
        { role: 'assistant', content: 'Latest transcript bubble', receivedAt: 2000 },
      ],
    })
    const stateBySessionId = new Map<string, LiveSessionInboxState>([
      ['session-1', createLiveState({ lastUpdated: 2000 })],
    ])

    const candidates = buildDashboardNotificationCandidates([conversation], stateBySessionId)

    expect(candidates[0]?.preview).toBe('Latest transcript bubble')
  })

  it('uses compact preview for notification preview only when it is newer than the local transcript tail', () => {
    const staleCompact = createConversation({
      sessionId: 'session-stale',
      tabKey: 'tab-stale',
      lastMessagePreview: 'Stale compact prompt',
      lastMessageAt: 3000,
      messages: [
        { role: 'assistant', content: 'Assistant reply at same timestamp', receivedAt: 3000 },
      ],
    })
    const newerCompact = createConversation({
      sessionId: 'session-newer',
      tabKey: 'tab-newer',
      lastMessagePreview: 'Newer compact summary',
      lastMessageAt: 4000,
      messages: [
        { role: 'assistant', content: 'Older transcript bubble', receivedAt: 3000 },
      ],
    })

    const candidates = buildDashboardNotificationCandidates(
      [staleCompact, newerCompact],
      new Map<string, LiveSessionInboxState>([
        ['session-stale', createLiveState({ sessionId: 'session-stale', lastUpdated: 3000 })],
        ['session-newer', createLiveState({ sessionId: 'session-newer', lastUpdated: 4000 })],
      ]),
    )

    expect(candidates.find(record => record.sessionId === 'session-stale')?.preview)
      .toBe('Assistant reply at same timestamp')
    expect(candidates.find(record => record.sessionId === 'session-newer')?.preview)
      .toBe('Newer compact summary')
  })

  it('does not keep task-complete candidates alive once daemon unread state cleared', () => {
    const conversation = createConversation({ providerSessionId: 'provider-1' })
    const stateBySessionId = new Map<string, LiveSessionInboxState>([
      ['session-1', createLiveState({ unread: false, inboxBucket: 'task_complete' })],
    ])

    const candidates = buildDashboardNotificationCandidates([conversation], stateBySessionId)

    expect(candidates).toEqual([])
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
  })

  it('keeps only the latest notification per conversation target like a messenger inbox', () => {
    const candidates = buildDashboardNotificationCandidates(
      [
        createConversation({
          sessionId: 'runtime-a',
          providerSessionId: 'provider-1',
          tabKey: 'tab-a',
          lastMessageHash: 'hash-1',
          lastMessageAt: 100,
          lastUpdated: 100,
          lastMessagePreview: 'Older reply',
        }),
        createConversation({
          sessionId: 'runtime-b',
          providerSessionId: 'provider-1',
          tabKey: 'tab-b',
          lastMessageHash: 'hash-2',
          lastMessageAt: 200,
          lastUpdated: 200,
          lastMessagePreview: 'Newest reply',
        }),
        createConversation({
          routeId: 'machine-2',
          sessionId: 'runtime-z',
          providerSessionId: 'provider-2',
          tabKey: 'tab-z',
          lastMessageHash: 'hash-9',
          lastMessageAt: 190,
          lastUpdated: 190,
          title: 'Codex',
          preview: 'Other conversation' as any,
          lastMessagePreview: 'Other conversation',
        }),
      ],
      new Map<string, LiveSessionInboxState>([
        ['runtime-a', createLiveState({ sessionId: 'runtime-a', lastUpdated: 100 })],
        ['runtime-b', createLiveState({ sessionId: 'runtime-b', lastUpdated: 200 })],
        ['runtime-z', createLiveState({ sessionId: 'runtime-z', lastUpdated: 190 })],
      ]),
    )

    expect(candidates).toHaveLength(2)
    expect(candidates.map(record => record.id)).toEqual([
      'task_complete|provider-1|hash-2|200',
      'task_complete|provider-2|hash-9|190',
    ])
    expect(candidates.find(record => record.providerSessionId === 'provider-1')?.preview).toBe('Newest reply')
  })

  it('counts unread notifications from daemon-derived records only', () => {
    const records = [
      {
        id: 'a',
        dedupKey: 'a',
        type: 'task_complete' as const,
        routeId: 'machine-1',
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
        title: 'Codex',
        preview: 'Approve',
        createdAt: 101,
        updatedAt: 101,
        lastEventAt: 101,
        readAt: 120,
      },
      {
        id: 'c',
        dedupKey: 'c',
        type: 'task_complete' as const,
        routeId: 'machine-3',
        title: 'Other',
        preview: 'Deleted',
        createdAt: 102,
        updatedAt: 102,
        lastEventAt: 102,
        deletedAt: 130,
      },
    ]

    expect(getDashboardNotificationUnreadCount(records)).toBe(1)
  })

  it('drops daemon candidates that are no longer present after the inbox state clears', () => {
    const first = buildDashboardNotificationCandidates(
      [createConversation()],
      new Map<string, LiveSessionInboxState>([['session-1', createLiveState()]]),
    )
    const second = buildDashboardNotificationCandidates(
      [createConversation()],
      new Map<string, LiveSessionInboxState>([['session-1', createLiveState({ unread: false, inboxBucket: 'idle' })]]),
    )

    expect(first).toHaveLength(1)
    expect(second).toEqual([])
  })
})
