/**
 * SessionChatController — the chat pane's single live source (keyed chat lane,
 * design 2026-09-28 §5.4, §6.4). Covers: committed-view application and bubble
 * identity, structural refusal, the "Load older" history contract (keyed view
 * coverage → explicit chat_history pages), clear, the keyed-lane rescue on a
 * status-lane contradiction, transcript session interest, and warm descriptors.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReplicatedTranscriptViewV2 } from '@adhdev/daemon-core'
import {
  applyTranscriptViewToControllers,
  buildWarmSessionChatDescriptorState,
  clearSessionChatControllerSnapshot,
  collectRetainedTranscriptSessionInterest,
  getOrCreateSessionChatController,
  getSessionChatSnapshotForConversation,
  getWarmSessionChatDescriptorRefreshMs,
  noteTerminalStatusEventForControllers,
  requestTranscriptBaseForSession,
  resetSessionChatControllersForTest,
} from '../../../src/components/dashboard/session-chat-controller'

type Message = ReplicatedTranscriptViewV2['messages'][number]

function msg(messageId: string, ord: string, rev: number, content: string, role = 'assistant'): Message {
  return {
    role, kind: 'standard', content, receivedAt: 1, timestamp: 1, turnKey: 't1', bubbleState: 'final',
    senderName: null, toolName: null, streaming: null, messageId, ord, rev, expandable: false, srcId: null,
  } as Message
}

function view(overrides: Partial<ReplicatedTranscriptViewV2> = {}): ReplicatedTranscriptViewV2 {
  return {
    schemaVersion: 2,
    sessionId: 'session-1',
    historySessionId: null,
    providerType: 'claude-cli',
    providerSessionId: null,
    producerDaemonId: 'daemon-1',
    producerWriterId: 'writer-1',
    epoch: 'epoch-1',
    frame: 1,
    observedAt: '2026-09-29T00:00:00.000Z',
    status: 'idle',
    providerObservedStatus: null,
    title: null,
    activeModal: null,
    activeInteractivePrompt: null,
    turn: null,
    provenance: { messageSource: null, transcriptProvenance: null },
    messages: [],
    terminalMarkers: [],
    coverage: { mode: 'full', totalMessageCount: 0, returnedMessageCount: 0, omittedBefore: false },
    ...overrides,
  } as ReplicatedTranscriptViewV2
}

function controller(overrides: Record<string, unknown> = {}) {
  return getOrCreateSessionChatController({
    daemonId: 'daemon-1',
    sessionId: 'session-1',
    sendData: vi.fn().mockReturnValue(true),
    ...overrides,
  } as any)
}

function createConversation(overrides: Record<string, any> = {}) {
  return {
    routeId: 'route-1',
    sessionId: 'session-1',
    providerSessionId: 'provider-1',
    daemonId: 'daemon-1',
    transport: 'pty',
    mode: 'chat',
    agentName: 'Hermes',
    agentType: 'hermes-cli',
    status: 'idle',
    title: 'Hermes Agent',
    messages: [],
    workspaceName: '/repo',
    displayPrimary: 'Hermes',
    displaySecondary: 'M4-L',
    streamSource: 'native',
    tabKey: 'daemon-1:session:session-1',
    ...overrides,
  } as any
}

afterEach(() => {
  resetSessionChatControllersForTest()
})

describe('committed keyed views', () => {
  it('starts empty and without a live snapshot (the pane falls back to status-meta rows)', () => {
    const snapshot = controller().getSnapshot()
    expect(snapshot.hasLiveSnapshot).toBe(false)
    expect(snapshot.liveMessages).toEqual([])
    expect(snapshot.hasMoreHistory).toBe(true)
  })

  it('applies a committed view as the live window, in ord order, keyed by messageId', () => {
    const c = controller()
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({
      messages: [msg('m1', 'a0', 1, 'question', 'user'), msg('m2', 'a1', 1, 'answer')],
    }))
    const snapshot = c.getSnapshot()
    expect(snapshot.hasLiveSnapshot).toBe(true)
    expect(snapshot.liveMessages.map((m) => m.content)).toEqual(['question', 'answer'])
    expect(snapshot.liveMessages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('keeps unchanged bubbles by identity and emits nothing for an identical re-delivery', () => {
    const c = controller()
    const listener = vi.fn()
    c.subscribe(listener)
    const m1 = msg('m1', 'a0', 1, 'question', 'user')
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({ messages: [m1, msg('m2', 'a1', 1, 'draft')] }))
    const first = c.getSnapshot().liveMessages
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({ frame: 2, messages: [m1, msg('m2', 'a1', 2, 'final')] }))
    const second = c.getSnapshot().liveMessages
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    const calls = listener.mock.calls.length
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({ frame: 3, messages: [m1, msg('m2', 'a1', 2, 'final')] }))
    expect(c.getSnapshot().liveMessages).toBe(second)
    expect(listener.mock.calls.length).toBe(calls)
  })

  it('a shorter committed view is applied as-is (the keyed commit is authoritative — no shrink heuristic)', () => {
    const c = controller()
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({
      status: 'generating',
      messages: [msg('m1', 'a0', 1, 'q', 'user'), msg('m2', 'a1', 1, 'partial'), msg('m3', 'a2', 1, 'dup')],
    }))
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({
      frame: 2, status: 'generating', messages: [msg('m1', 'a0', 1, 'q', 'user'), msg('m2', 'a1', 2, 'merged')],
    }))
    expect(c.getSnapshot().liveMessages.map((m) => m.content)).toEqual(['q', 'merged'])
  })

  it('refuses a structurally incomplete view (activeModal missing) instead of mapping it best-effort', () => {
    const c = controller()
    const broken = view({ messages: [msg('m1', 'a0', 1, 'x')] }) as any
    delete broken.activeModal
    applyTranscriptViewToControllers('daemon-1', 'session-1', broken)
    expect(c.getSnapshot().hasLiveSnapshot).toBe(false)
    // Control: the same view with the field present applies.
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({ messages: [msg('m1', 'a0', 1, 'x')] }))
    expect(c.getSnapshot().hasLiveSnapshot).toBe(true)
  })

  it('fans one view out to every controller of the session (pane + warm inbox), mapping it once', () => {
    const pane = controller({ historySessionId: 'history-1' })
    const warm = controller()
    const applied = applyTranscriptViewToControllers('daemon-1', 'session-1', view({ messages: [msg('m1', 'a0', 1, 'hi')] }))
    expect(applied).toBe(2)
    expect(pane.getSnapshot().liveMessages[0]).toBe(warm.getSnapshot().liveMessages[0])
    expect(applyTranscriptViewToControllers('daemon-1', 'nobody', view())).toBe(0)
  })

  it('clear blanks the live window until the next committed view', () => {
    const c = controller()
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({ messages: [msg('m1', 'a0', 1, 'old')] }))
    clearSessionChatControllerSnapshot('daemon-1', 'session-1')
    expect(c.getSnapshot()).toMatchObject({ hasLiveSnapshot: true, liveMessages: [] })
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({ frame: 2, messages: [msg('m9', 'b0', 1, 'fresh')] }))
    expect(c.getSnapshot().liveMessages.map((m) => m.content)).toEqual(['fresh'])
  })
})

describe('older history ("Load older messages")', () => {
  it('is offered only when the keyed view does not reach the start of the conversation', () => {
    const c = controller()
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({ messages: [msg('m1', 'a0', 1, 'x')] }))
    expect(c.getSnapshot()).toMatchObject({ hasMoreHistory: false, omittedBefore: false })
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({
      frame: 2,
      messages: [msg('m1', 'a0', 1, 'x')],
      coverage: { mode: 'full', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: true },
    }))
    expect(c.getSnapshot()).toMatchObject({ hasMoreHistory: true, omittedBefore: true })
  })

  it('pages strictly older than the live window: excludeRecentCount = live bubbles, offset advances', async () => {
    const c = controller()
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({
      messages: [msg('m1', 'a0', 1, 'a'), msg('m2', 'a1', 1, 'b')],
      coverage: { mode: 'full', totalMessageCount: 2, returnedMessageCount: 2, omittedBefore: true },
    }))
    const loader = vi.fn().mockResolvedValue({ messages: [{ role: 'user', content: 'older' }], hasMore: false })
    await c.loadHistoryPage(loader)
    expect(loader).toHaveBeenCalledWith({ offset: 0, excludeRecentCount: 2, excludeFromIdentity: '' })
    const snapshot = c.getSnapshot()
    expect(snapshot.historyMessages.map((m) => m.content)).toEqual(['older'])
    expect(snapshot.historyOffset).toBe(1)
    expect(snapshot.hasMoreHistory).toBe(false)
    // Once paged, a later view's coverage no longer owns the affordance.
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({
      frame: 2,
      messages: [msg('m1', 'a0', 1, 'a'), msg('m2', 'a1', 1, 'b'), msg('m3', 'a2', 1, 'c')],
      coverage: { mode: 'full', totalMessageCount: 3, returnedMessageCount: 3, omittedBefore: true },
    }))
    expect(c.getSnapshot().hasMoreHistory).toBe(false)
  })

  it('uses the status-meta count as the boundary before the first view lands', async () => {
    const c = controller({ fallbackRecentCount: 7 })
    const loader = vi.fn().mockResolvedValue({ messages: [], hasMore: true })
    await c.loadHistoryPage(loader)
    expect(loader).toHaveBeenCalledWith(expect.objectContaining({ excludeRecentCount: 7 }))
  })

  it('caps retained history at 500 rows while advancing historyOffset by the full fetched page size', async () => {
    const c = controller()
    const page = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => ({
      role: 'assistant', content: `row-${from + index}`, id: `row-${from + index}`, timestamp: from + index,
    }) as any)
    await c.loadHistoryPage(async () => ({ messages: page(300, 599), hasMore: true }))
    await c.loadHistoryPage(async () => ({ messages: page(0, 299), hasMore: true }))
    const snapshot = c.getSnapshot()
    expect(snapshot.historyMessages).toHaveLength(500)
    expect((snapshot.historyMessages[0] as any).content).toBe('row-100')
    expect(snapshot.historyOffset).toBe(600)
  })

  it('surfaces a failed page as historyError and keeps the live window', async () => {
    const c = controller()
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({ messages: [msg('m1', 'a0', 1, 'x')] }))
    await c.loadHistoryPage(async () => { throw new Error('offline') })
    expect(c.getSnapshot()).toMatchObject({ historyError: 'offline', hasLiveSnapshot: true })
  })
})

describe('keyed-lane recovery (never a second read path)', () => {
  it('requestTranscriptBaseForSession sends request_transcript_base on the command lane', () => {
    const sendData = vi.fn().mockReturnValue(true)
    controller({ sendData })
    expect(requestTranscriptBaseForSession('daemon-1', 'session-1')).toBe(true)
    expect(sendData).toHaveBeenCalledWith('daemon-1', {
      type: 'command', commandType: 'request_transcript_base', data: { rawSessionId: 'session-1' },
    })
    expect(requestTranscriptBaseForSession('daemon-1', 'nobody')).toBe(false)
  })

  it('a terminal status event that contradicts a "generating" view asks for one base frame, rate-limited', () => {
    let now = 1_000
    const sendData = vi.fn().mockReturnValue(true)
    const c = controller({ sendData, now: () => now })
    c.retain()
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({ status: 'generating', messages: [msg('m1', 'a0', 1, 'x')] }))
    expect(noteTerminalStatusEventForControllers('daemon-1', 'session-1', 'agent:generating_completed')).toBe(true)
    expect(sendData).toHaveBeenCalledTimes(1)
    now += 1_000
    expect(noteTerminalStatusEventForControllers('daemon-1', 'session-1', 'agent:generating_completed')).toBe(false)
    now += 20_000
    expect(noteTerminalStatusEventForControllers('daemon-1', 'session-1', 'agent:stopped')).toBe(true)
    expect(sendData).toHaveBeenCalledTimes(2)
  })

  it('does nothing when the view already agrees, or for a non-terminal event', () => {
    const sendData = vi.fn().mockReturnValue(true)
    const c = controller({ sendData })
    c.retain()
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({ status: 'idle' }))
    expect(noteTerminalStatusEventForControllers('daemon-1', 'session-1', 'agent:generating_completed')).toBe(false)
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({ frame: 2, status: 'generating' }))
    expect(noteTerminalStatusEventForControllers('daemon-1', 'session-1', 'agent:generating_started')).toBe(false)
    expect(sendData).not.toHaveBeenCalled()
  })
})

describe('transcript session interest', () => {
  it('reports only RETAINED controllers, deduped per session', () => {
    controller({ sessionId: 'registered-only' })
    expect(collectRetainedTranscriptSessionInterest().size).toBe(0)
    controller({ historySessionId: 'history-1' }).retain()
    controller().retain()
    expect(collectRetainedTranscriptSessionInterest()).toEqual(new Map([['daemon-1', ['session-1']]]))
  })

  it('narrows again on release', () => {
    const c = controller()
    c.retain()
    c.release()
    expect(collectRetainedTranscriptSessionInterest().size).toBe(0)
  })
})

describe('warm controllers / mobile preview', () => {
  it('uses a bounded refresh cadence for warm descriptor expiry checks', () => {
    expect(getWarmSessionChatDescriptorRefreshMs()).toBe(30_000)
    expect(getWarmSessionChatDescriptorRefreshMs(5_000)).toBe(5_000)
    expect(getWarmSessionChatDescriptorRefreshMs(500)).toBe(1_000)
  })

  it('omits historySessionId for an agy coordinator but carries a distinct provider id', () => {
    const now = 2_000_000
    const state = buildWarmSessionChatDescriptorState([
      createConversation({ sessionId: 'agy', providerSessionId: undefined, tabKey: 'daemon-1:session:agy', messages: [{ role: 'user', content: 'p' }], lastMessageAt: now - 5_000, lastUpdated: now - 5_000 }),
      createConversation({ sessionId: 'runtime', providerSessionId: 'real-conv', daemonId: 'daemon-2', routeId: 'route-2', tabKey: 'daemon-2:session:runtime', messages: [{ role: 'assistant', content: 'a' }], lastMessageAt: now - 5_000, lastUpdated: now - 5_000 }),
    ], { now })
    expect(state.descriptors.find((d) => d.sessionId === 'agy')?.historySessionId).toBeUndefined()
    expect(state.descriptors.find((d) => d.sessionId === 'runtime')?.historySessionId).toBe('real-conv')
  })

  it('can disable recent-idle warming while keeping generating and modal sessions warm', () => {
    const now = 2_000_000
    const state = buildWarmSessionChatDescriptorState([
      createConversation({ sessionId: 'idle-recent', tabKey: 't1', lastMessageAt: now - 5_000, lastUpdated: now - 5_000 }),
      createConversation({ sessionId: 'generating', tabKey: 't2', status: 'generating', lastMessageAt: now - 30_000, lastUpdated: now - 30_000 }),
      createConversation({ sessionId: 'modal', tabKey: 't3', modalMessage: 'Approve?', lastMessageAt: now - 30_000, lastUpdated: now - 30_000 }),
    ], { now, recentActivityMs: 0 })
    expect(state.descriptors.map((d) => d.sessionId)).toEqual(['generating', 'modal'])
  })

  it('keeps the warm signature stable when only non-identity fields change', () => {
    const now = 2_000_000
    const a = buildWarmSessionChatDescriptorState([createConversation({ lastMessageAt: now - 5_000, lastUpdated: now - 5_000 })], { now })
    const b = buildWarmSessionChatDescriptorState([createConversation({ title: 'changed', messages: [{ role: 'assistant', content: 'n' }], lastMessageAt: now - 5_000, lastUpdated: now - 5_000 })], { now })
    expect(b.signature).toBe(a.signature)
  })

  it('the mobile inbox preview reads the SAME warm snapshot the pane renders', () => {
    const conversation = createConversation({ providerSessionId: undefined })
    expect(getSessionChatSnapshotForConversation(conversation)).toBeUndefined()
    controller()
    applyTranscriptViewToControllers('daemon-1', 'session-1', view({ messages: [msg('m1', 'a0', 1, 'latest answer')] }))
    expect(getSessionChatSnapshotForConversation(conversation)?.liveMessages.map((m) => m.content)).toEqual(['latest answer'])
  })
})
