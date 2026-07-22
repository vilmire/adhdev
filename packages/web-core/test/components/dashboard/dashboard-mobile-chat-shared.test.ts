import { describe, expect, it } from 'vitest'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { LiveSessionInboxState } from '../../../src/components/dashboard/DashboardMobileChatShared'
import {
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
