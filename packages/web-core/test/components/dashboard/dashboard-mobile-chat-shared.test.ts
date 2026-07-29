import { describe, expect, it } from 'vitest'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { DaemonData } from '../../../src/types'
import type { LiveSessionInboxState } from '../../../src/components/dashboard/DashboardMobileChatShared'
import {
  buildLiveSessionInboxStateMap,
  countGeneratingConversations,
  getConversationInboxSurfaceState,
  getConversationViewStates,
  isConversationGenerating,
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
    completionMarker: 'turn:1',
    seenCompletionMarker: '',
    ...overrides,
  }
}

describe('DashboardMobileChatShared', () => {
  it('treats daemon live unread state as the only task-complete unread authority across surfaces', () => {
    const conversation = createConversation()
    const liveState = new Map<string, LiveSessionInboxState>([
      ['session-1', createLiveState({ unread: false })],
    ])

    const surfaceState = getConversationInboxSurfaceState(conversation, liveState)

    expect(surfaceState.unread).toBe(false)
    expect(surfaceState.inboxBucket).toBe('idle')
    expect(isConversationTaskCompleteUnread(conversation, liveState)).toBe(false)
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

  it('treats no_progress (and legacy long_generating) and streaming statuses as working states', () => {
    expect(getConversationViewStates({ status: 'no_progress' }).isGenerating).toBe(true)
    expect(getConversationViewStates({ status: 'long_generating' }).isGenerating).toBe(true)
    expect(getConversationViewStates({ status: 'streaming' }).isGenerating).toBe(true)
  })

  it('centralizes the generating predicate across the full status set (desktop hidden indicator uses this)', () => {
    for (const status of ['generating', 'no_progress', 'long_generating', 'streaming']) {
      expect(isConversationGenerating(createConversation({ status }))).toBe(true)
    }
    expect(isConversationGenerating(createConversation({ status: 'idle' }))).toBe(false)
    expect(isConversationGenerating(createConversation({ status: 'waiting_approval' }))).toBe(false)
  })

  it('counts generating conversations for collapsed/hidden surfaces', () => {
    const conversations = [
      createConversation({ status: 'generating' }),
      createConversation({ status: 'streaming' }),
      createConversation({ status: 'idle' }),
      createConversation({ status: 'no_progress' }),
    ]
    expect(countGeneratingConversations(conversations)).toBe(3)
    expect(countGeneratingConversations([])).toBe(0)
    expect(countGeneratingConversations([createConversation({ status: 'idle' })])).toBe(0)
  })
})

/**
 * Dedupe contract for buildLiveSessionInboxStateMap: the same sessionId can
 * appear twice in `ides` (a stale duplicate entry plus the fresh one, or a
 * top-level entry plus a `childSessions` child). Registration used to be plain
 * last-write-wins, so a stale duplicate carrying `inboxBucket: 'working'`
 * registered AFTER the fresh idle copy pinned the mobile machine-card badge to
 * working. The deterministic rule: newer remote `lastUpdated` wins, timestamp
 * ties break toward the copy with richer explicit evidence, and full ties keep
 * the FIRST registered copy (stable input order).
 */
function createInboxEntry(overrides: Record<string, unknown> = {}): DaemonData {
  return {
    id: 'machine-1:cli:term-1',
    daemonId: 'machine-1',
    type: 'cli',
    sessionId: 'session-1',
    ...overrides,
  } as unknown as DaemonData
}

describe('buildLiveSessionInboxStateMap — duplicate sessionId dedupe', () => {
  it('stale working copy can never override a fresher idle copy, in either registration order', () => {
    const staleWorking = createInboxEntry({ inboxBucket: 'working', lastUpdated: 100 })
    const freshIdle = createInboxEntry({ inboxBucket: 'idle', lastUpdated: 200 })

    for (const ides of [[staleWorking, freshIdle], [freshIdle, staleWorking]]) {
      const map = buildLiveSessionInboxStateMap(ides)
      expect(map.get('session-1')?.inboxBucket).toBe('idle')
      expect(map.get('session-1')?.lastUpdated).toBe(200)
      expect(map.size).toBe(1)
    }
  })

  it('stale working copy without lastUpdated cannot override a fresh idle copy', () => {
    const staleWorking = createInboxEntry({ inboxBucket: 'working' })
    const freshIdle = createInboxEntry({ inboxBucket: 'idle', lastUpdated: 50 })

    for (const ides of [[staleWorking, freshIdle], [freshIdle, staleWorking]]) {
      const map = buildLiveSessionInboxStateMap(ides)
      expect(map.get('session-1')?.inboxBucket).toBe('idle')
      expect(map.get('session-1')?.lastUpdated).toBe(50)
    }
  })

  it('a genuinely fresher working copy still overrides an older idle copy', () => {
    const olderIdle = createInboxEntry({ inboxBucket: 'idle', lastUpdated: 100 })
    const fresherWorking = createInboxEntry({ inboxBucket: 'working', lastUpdated: 200 })

    for (const ides of [[olderIdle, fresherWorking], [fresherWorking, olderIdle]]) {
      const map = buildLiveSessionInboxStateMap(ides)
      expect(map.get('session-1')?.inboxBucket).toBe('working')
      expect(map.get('session-1')?.lastUpdated).toBe(200)
    }
  })

  it('keeps the FIRST registered copy when timestamps and evidence tie (stable input order)', () => {
    const working = createInboxEntry({ inboxBucket: 'working', lastUpdated: 100 })
    const idle = createInboxEntry({ inboxBucket: 'idle', lastUpdated: 100 })

    expect(buildLiveSessionInboxStateMap([working, idle]).get('session-1')?.inboxBucket).toBe('working')
    expect(buildLiveSessionInboxStateMap([idle, working]).get('session-1')?.inboxBucket).toBe('idle')
  })

  it('breaks timestamp ties toward the copy carrying richer explicit evidence, in either order', () => {
    const defaultsOnly = createInboxEntry({ lastUpdated: 100 })
    const explicit = createInboxEntry({ lastUpdated: 100, inboxBucket: 'working' })

    for (const ides of [[defaultsOnly, explicit], [explicit, defaultsOnly]]) {
      const map = buildLiveSessionInboxStateMap(ides)
      expect(map.get('session-1')?.inboxBucket).toBe('working')
    }
  })

  it('registers distinct sessions and child sessions, skips daemon entries, drops nothing', () => {
    const parent = createInboxEntry({
      sessionId: 'parent-1',
      inboxBucket: 'idle',
      lastUpdated: 10,
      childSessions: [{ id: 'child-1', inboxBucket: 'working', lastUpdated: 20 }],
    })
    const other = createInboxEntry({
      id: 'machine-1:cli:term-2',
      sessionId: 'session-2',
      inboxBucket: 'task_complete',
      lastUpdated: 30,
      unread: true,
    })
    const daemon = { id: 'machine-1', type: 'adhdev-daemon' } as unknown as DaemonData

    const map = buildLiveSessionInboxStateMap([parent, other, daemon])
    expect(map.size).toBe(3)
    expect(map.get('parent-1')?.inboxBucket).toBe('idle')
    expect(map.get('child-1')?.inboxBucket).toBe('working')
    expect(map.get('session-2')?.inboxBucket).toBe('task_complete')
    expect(map.get('session-2')?.unread).toBe(true)
  })

  it('dedupes a top-level entry against a childSessions copy of the same sessionId by freshness', () => {
    const staleTopLevel = createInboxEntry({ inboxBucket: 'working', lastUpdated: 100 })
    const parentCarryingFreshChild = createInboxEntry({
      id: 'machine-1:cli:term-9',
      sessionId: 'parent-9',
      inboxBucket: 'idle',
      lastUpdated: 10,
      childSessions: [{ id: 'session-1', inboxBucket: 'idle', lastUpdated: 200 }],
    })

    const map = buildLiveSessionInboxStateMap([staleTopLevel, parentCarryingFreshChild])
    expect(map.get('session-1')?.inboxBucket).toBe('idle')
    expect(map.get('session-1')?.lastUpdated).toBe(200)
  })
})
