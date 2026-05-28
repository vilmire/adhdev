import { describe, expect, it, vi } from 'vitest'
import type { SessionChatTailUpdate } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  buildLastMessageSignature,
  buildWarmSessionChatTailDescriptorState,
  getOrCreateSessionChatTailController,
  getWarmSessionChatTailDescriptorRefreshMs,
  resetSessionChatTailControllersForTest,
} from '../../../src/components/dashboard/session-chat-tail-controller'

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
  }
}

function createUpdate(overrides: Partial<SessionChatTailUpdate> = {}): SessionChatTailUpdate {
  return {
    topic: 'session.chat_tail',
    key: 'daemon:daemon-1:session:session-1',
    sessionId: 'session-1',
    seq: 1,
    timestamp: 1,
    messages: [{ role: 'assistant', content: 'hello from cache', id: 'msg-1', timestamp: 1 } as any],
    status: 'idle',
    syncMode: 'full',
    replaceFrom: 0,
    totalMessages: 1,
    lastMessageSignature: 'sig-1',
    ...overrides,
  }
}

describe('SessionChatTailController registry', () => {
  it('uses a bounded refresh cadence for warm descriptor expiry checks', () => {
    expect(getWarmSessionChatTailDescriptorRefreshMs()).toBe(30_000)
    expect(getWarmSessionChatTailDescriptorRefreshMs(5_000)).toBe(5_000)
    expect(getWarmSessionChatTailDescriptorRefreshMs(500)).toBe(1_000)
  })

  it('builds a stable warm-controller descriptor signature when conversation identities change but session targets stay the same', () => {
    const now = 2_000_000
    const first = buildWarmSessionChatTailDescriptorState([
      createConversation({
        sessionId: 'session-1',
        providerSessionId: 'provider-1',
        lastMessageAt: now - 5_000,
        lastUpdated: now - 5_000,
      }),
      createConversation({
        routeId: 'route-2',
        sessionId: 'session-2',
        providerSessionId: 'provider-2',
        daemonId: 'daemon-2',
        tabKey: 'daemon-2:session:session-2',
        lastMessageAt: now - 8_000,
        lastUpdated: now - 8_000,
      }),
    ], { now })

    const second = buildWarmSessionChatTailDescriptorState([
      createConversation({
        sessionId: 'session-1',
        providerSessionId: 'provider-1',
        messages: [{ role: 'assistant', content: 'new text' }],
        lastMessageAt: now - 5_000,
        lastUpdated: now - 5_000,
      }),
      createConversation({
        routeId: 'route-2',
        sessionId: 'session-2',
        providerSessionId: 'provider-2',
        daemonId: 'daemon-2',
        tabKey: 'daemon-2:session:session-2',
        title: 'Changed title only',
        lastMessageAt: now - 8_000,
        lastUpdated: now - 8_000,
      }),
    ], { now })

    expect(first.descriptors).toHaveLength(2)
    expect(second.signature).toBe(first.signature)
    expect(second.descriptors).toEqual(first.descriptors)
  })

  it('keeps conversations with cached messages even when activity timestamps are absent', () => {
    const now = 2_000_000
    const cachedTranscript = createConversation({
      sessionId: 'session-cached',
      providerSessionId: 'provider-cached',
      tabKey: 'daemon-1:session:session-cached',
      status: 'idle',
      messages: [{ role: 'assistant', content: 'still here' }],
      lastMessageAt: 0,
      lastUpdated: 0,
    })

    const state = buildWarmSessionChatTailDescriptorState([cachedTranscript], { now })

    expect(state.descriptors).toEqual([
      expect.objectContaining({ sessionId: 'session-cached' }),
    ])
  })

  it('can disable recent-idle warming while still keeping generating and modal sessions warm', () => {
    const now = 2_000_000
    const state = buildWarmSessionChatTailDescriptorState([
      createConversation({
        sessionId: 'session-idle-recent',
        providerSessionId: 'provider-idle-recent',
        tabKey: 'daemon-1:session:session-idle-recent',
        status: 'idle',
        lastMessageAt: now - 5_000,
        lastUpdated: now - 5_000,
      }),
      createConversation({
        sessionId: 'session-generating',
        providerSessionId: 'provider-generating',
        tabKey: 'daemon-1:session:session-generating',
        status: 'generating',
        lastMessageAt: now - 30_000,
        lastUpdated: now - 30_000,
      }),
      createConversation({
        sessionId: 'session-modal',
        providerSessionId: 'provider-modal',
        tabKey: 'daemon-1:session:session-modal',
        status: 'idle',
        modalMessage: 'Approve this command?',
        lastMessageAt: now - 30_000,
        lastUpdated: now - 30_000,
      }),
    ], { now, recentActivityMs: 0 })

    expect(state.descriptors.map((descriptor) => descriptor.sessionId)).toEqual([
      'session-generating',
      'session-modal',
    ])
  })

  it('subscribes with only the requested tail window, not a client transcript cursor', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const sendData = vi.fn().mockReturnValue(true)
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData,
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })

    controller.retain()

    expect(sendData).toHaveBeenCalledOnce()
    const request = sendData.mock.calls[0]?.[1]
    expect(request).toMatchObject({
      type: 'subscribe',
      topic: 'session.chat_tail',
      key: 'daemon:daemon-1:session:session-1',
      params: {
        targetSessionId: 'session-1',
        historySessionId: 'history-1',
        tailLimit: 60,
      },
    })
    expect(request.params).not.toHaveProperty('knownMessageCount')
    expect(request.params).not.toHaveProperty('lastMessageSignature')
  })

  it('keeps the live cursor limited to the requested tail window', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })

    controller.retain()
    manager.publish(createUpdate({
      messages: Array.from({ length: 60 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `msg-${index + 1}`,
        id: `msg-${index + 1}`,
        timestamp: index + 1,
      })) as any,
      totalMessages: 228,
      lastMessageSignature: 'sig-tail-60',
      syncMode: 'full',
      replaceFrom: 0,
    }))

    expect(controller.getSnapshot().cursor).toEqual({
      tailLimit: 60,
    })
  })

  it('re-subscribes with a larger tail request when an active session upgrades the hydrate window', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const sendData = vi.fn().mockReturnValue(true)
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData,
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })

    controller.retain()
    manager.publish(createUpdate({
      messages: Array.from({ length: 60 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `msg-${index + 1}`,
        id: `msg-${index + 1}`,
        timestamp: index + 1,
      })) as any,
      totalMessages: 228,
      lastMessageSignature: 'sig-tail-60',
      syncMode: 'full',
      replaceFrom: 0,
    }))

    const reacquired = getOrCreateSessionChatTailController({
      manager,
      sendData,
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 200,
    })

    expect(reacquired).toBe(controller)
    const subscribeCalls = sendData.mock.calls.filter((call) => call[1]?.type === 'subscribe')
    const request = subscribeCalls.at(-1)?.[1]
    expect(request).toMatchObject({
      topic: 'session.chat_tail',
      key: 'daemon:daemon-1:session:session-1',
      params: {
        targetSessionId: 'session-1',
        historySessionId: 'history-1',
        tailLimit: 200,
      },
    })
    expect(request.params).not.toHaveProperty('knownMessageCount')
    expect(request.params).not.toHaveProperty('lastMessageSignature')
  })

  it('does not re-subscribe when a render-cycle release is immediately followed by retain for the same controller', () => {
    resetSessionChatTailControllersForTest()
    vi.useFakeTimers()
    try {
      const manager = new SubscriptionManager()
      const sendData = vi.fn().mockReturnValue(true)
      const controller = getOrCreateSessionChatTailController({
        manager,
        sendData,
        daemonId: 'daemon-1',
        sessionId: 'session-1',
        historySessionId: 'history-1',
        subscriptionKey: 'daemon:daemon-1:session:session-1',
        tailLimit: 60,
      })

      controller.retain()
      expect(sendData).toHaveBeenCalledTimes(1)

      controller.release()
      controller.retain()
      vi.runAllTimers()

      expect(sendData).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries the initial subscribe send when the first chat-tail subscribe attempt is rejected by transport', () => {
    resetSessionChatTailControllersForTest()
    vi.useFakeTimers()
    try {
      const manager = new SubscriptionManager()
      const sendData = vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true)
      const controller = getOrCreateSessionChatTailController({
        manager,
        sendData,
        daemonId: 'daemon-1',
        sessionId: 'session-1',
        historySessionId: 'history-1',
        subscriptionKey: 'daemon:daemon-1:session:session-1',
        tailLimit: 60,
      })

      controller.retain()
      expect(sendData).toHaveBeenCalledTimes(1)
      expect(sendData.mock.calls[0]?.[1]).toMatchObject({
        type: 'subscribe',
        topic: 'session.chat_tail',
        key: 'daemon:daemon-1:session:session-1',
      })

      vi.advanceTimersByTime(1000)

      expect(sendData).toHaveBeenCalledTimes(2)
      expect(sendData.mock.calls[1]?.[1]).toMatchObject({
        type: 'subscribe',
        topic: 'session.chat_tail',
        key: 'daemon:daemon-1:session:session-1',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays cached transcript state after the background retain cycle releases and later reacquires the same session', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })

    controller.retain()
    manager.publish(createUpdate())
    controller.release()

    const reacquired = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })

    expect(reacquired).toBe(controller)

    const listener = vi.fn()
    reacquired.subscribe(listener)

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        liveMessages: [expect.objectContaining({ content: 'hello from cache' })],
        cursor: { tailLimit: 60 },
      }),
    )
  })

  it('does not expose a conversation hydrate API that can overwrite chat-tail topic authority', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })

    expect((controller as any).hydrateLiveMessages).toBeUndefined()
  })

  it('replaces the live transcript with the daemon-provided full tail refresh as-is', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })

    controller.retain()

    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'new-1', id: 'new-1', timestamp: 3 } as any,
        { role: 'assistant', content: 'new-2', id: 'new-2', timestamp: 4 } as any,
        { role: 'user', content: 'new-3', id: 'new-3', timestamp: 5 } as any,
      ],
      totalMessages: 5,
      lastMessageSignature: 'sig-3',
    }))

    expect(controller.getSnapshot().liveMessages.map(message => (message as any).content)).toEqual([
      'new-1',
      'new-2',
      'new-3',
    ])
  })

  it('treats legacy append payloads as complete parser tails instead of appending locally', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })
    const currentTail = { role: 'assistant', content: 'already hydrated', id: 'msg-2', timestamp: 2 } as any

    controller.retain()
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'hello', id: 'msg-1', timestamp: 1 } as any,
        currentTail,
      ],
      syncMode: 'full',
      totalMessages: 2,
      lastMessageSignature: buildLastMessageSignature(currentTail),
    }))

    manager.publish(createUpdate({
      messages: [currentTail],
      syncMode: 'append',
      totalMessages: 3,
      lastMessageSignature: buildLastMessageSignature(currentTail),
    }))

    const snapshot = controller.getSnapshot()
    expect(snapshot.liveMessages.map(message => (message as any).content)).toEqual([
      'already hydrated',
    ])
    expect(snapshot.cursor).toEqual({ tailLimit: 60 })
  })

  it('applies a tail refresh with the same last signature when it restores an earlier missing assistant answer', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })
    const restoredAnswer = { role: 'assistant', kind: 'standard', content: '완료했습니다. 최종 답변', id: 'msg-final', timestamp: 1 } as any
    const nextUser = { role: 'user', content: '이어서', id: 'msg-user-next', timestamp: 2 } as any
    const activityTail = { role: 'assistant', kind: 'terminal', content: '$ grep sendJsonMessage', id: 'msg-activity-tail', timestamp: 3 } as any

    controller.retain()
    manager.publish(createUpdate({
      messages: [
        nextUser,
        activityTail,
      ],
      syncMode: 'full',
      totalMessages: 2,
      lastMessageSignature: buildLastMessageSignature(activityTail),
    }))

    manager.publish(createUpdate({
      messages: [
        restoredAnswer,
        nextUser,
        activityTail,
      ],
      syncMode: 'replace_tail',
      replaceFrom: 0,
      totalMessages: 3,
      lastMessageSignature: buildLastMessageSignature(activityTail),
    }))

    const snapshot = controller.getSnapshot()
    expect(snapshot.liveMessages.map(message => (message as any).content)).toEqual([
      '완료했습니다. 최종 답변',
      '이어서',
      '$ grep sendJsonMessage',
    ])
    expect(snapshot.cursor).toEqual({ tailLimit: 60 })
  })

  it('replaces streaming bubble full-tail updates exactly as the daemon sends them', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })
    const duplicateUnitKey = 'hermes-cli:turn_1:assistant:standard:0'
    const firstChunk = {
      role: 'assistant',
      content: 'partial answer',
      id: 'hermes_1m3osyj',
      bubbleState: 'streaming',
      timestamp: 10,
    } as any
    const secondChunk = {
      ...firstChunk,
      bubbleId: 'hermes_1m3osyj',
      providerUnitKey: duplicateUnitKey,
      content: 'partial answer with more text',
      bubbleState: 'streaming',
      timestamp: 11,
    } as any
    const finalChunk = {
      ...firstChunk,
      bubbleId: 'hermes_1m3osyj',
      providerUnitKey: duplicateUnitKey,
      content: 'partial answer with more text done',
      bubbleState: 'final',
      timestamp: 12,
    } as any

    controller.retain()
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'hello', id: 'msg-1', timestamp: 1 } as any,
        firstChunk,
      ],
      syncMode: 'full',
      totalMessages: 2,
      lastMessageSignature: buildLastMessageSignature(firstChunk),
    }))

    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'hello', id: 'msg-1', timestamp: 1 } as any,
        secondChunk,
      ],
      syncMode: 'full',
      totalMessages: 2,
      lastMessageSignature: buildLastMessageSignature(secondChunk),
    }))
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'hello', id: 'msg-1', timestamp: 1 } as any,
        firstChunk,
        secondChunk,
        finalChunk,
      ],
      syncMode: 'full',
      totalMessages: 4,
      lastMessageSignature: buildLastMessageSignature(finalChunk),
    }))

    const snapshot = controller.getSnapshot()
    expect(snapshot.liveMessages.map(message => (message as any).content)).toEqual([
      'hello',
      'partial answer',
      'partial answer with more text',
      'partial answer with more text done',
    ])
    expect(snapshot.liveMessages.filter(message => (message as any).providerUnitKey === duplicateUnitKey)).toHaveLength(2)
    expect(snapshot.liveMessages[3]).toMatchObject({
      id: 'hermes_1m3osyj',
      bubbleState: 'final',
      timestamp: 12,
    })
  })

  it('has no hydrate path that normalizes duplicate streaming rows', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })

    expect((controller as any).hydrateLiveMessages).toBeUndefined()
  })

  it('preserves duplicate rows inside a full daemon tail refresh', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })
    const duplicateUnitKey = 'hermes-cli:turn_1_4ms0i2:assistant:standard:0'

    controller.retain()
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'question', id: 'user-1', timestamp: 1 } as any,
        { role: 'assistant', content: 'partial', id: 'hermes_olooqs', bubbleId: 'hermes_olooqs', providerUnitKey: duplicateUnitKey, bubbleState: 'streaming', timestamp: 2 } as any,
        { role: 'assistant', content: 'partial plus', id: 'hermes_olooqs', bubbleId: 'hermes_olooqs', providerUnitKey: duplicateUnitKey, bubbleState: 'streaming', timestamp: 2 } as any,
      ],
      syncMode: 'full',
      totalMessages: 3,
      lastMessageSignature: buildLastMessageSignature({ role: 'assistant', content: 'partial plus', id: 'hermes_olooqs', timestamp: 2 } as any),
    }))

    const snapshot = controller.getSnapshot()
    expect(snapshot.liveMessages.map(message => (message as any).content)).toEqual([
      'question',
      'partial',
      'partial plus',
    ])
    expect(snapshot.liveMessages.filter(message => (message as any).providerUnitKey === duplicateUnitKey)).toHaveLength(2)
  })

  it('passes the currently hydrated live tail length when loading older history', async () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 1000,
    })
    const hydratedTail = Array.from({ length: 1000 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `live-tail-${index + 1}`,
      id: `live-tail-${index + 1}`,
      timestamp: index + 1,
    })) as any
    const loadHistory = vi.fn().mockResolvedValue({ messages: [], hasMore: true })

    controller.retain()
    manager.publish(createUpdate({
      messages: hydratedTail,
      syncMode: 'full',
      totalMessages: hydratedTail.length,
      lastMessageSignature: buildLastMessageSignature(hydratedTail[hydratedTail.length - 1]),
    }))
    await controller.loadHistoryPage(loadHistory)

    expect(loadHistory).toHaveBeenCalledWith({
      offset: 0,
      excludeRecentCount: 1000,
    })
  })

  it('uses the active conversation fallback count for history paging before chat-tail hydrates', async () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 50,
      fallbackRecentCount: 50,
    })
    const loadHistory = vi.fn().mockResolvedValue({
      messages: [{ role: 'assistant', content: 'older row', id: 'history-older', timestamp: 1 }],
      hasMore: true,
    })

    controller.retain()
    await controller.loadHistoryPage(loadHistory)

    expect(loadHistory).toHaveBeenCalledWith({
      offset: 0,
      excludeRecentCount: 50,
    })
  })

  it('does not mark long-session history exhausted from an empty page before chat-tail hydrates', async () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 50,
      fallbackRecentCount: 50,
    })

    controller.retain()
    await controller.loadHistoryPage(async () => ({ messages: [], hasMore: false }))

    expect(controller.getSnapshot()).toMatchObject({
      liveMessages: [],
      hasLiveSnapshot: false,
      historyMessages: [],
      historyOffset: 0,
      hasMoreHistory: true,
      historyError: null,
    })
  })

  it('preserves history page rows even when they overlap with live messages that arrive while loading', async () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })
    const initialLive = [
      { role: 'user', content: 'live 1', id: 'live-1', timestamp: 1 } as any,
      { role: 'assistant', content: 'live 2', id: 'live-2', timestamp: 2 } as any,
    ]
    const liveArrivedDuringLoad = { role: 'assistant', content: 'live 3', id: 'live-3', timestamp: 3 } as any
    let resolveHistory!: (value: { messages: any[]; hasMore: boolean }) => void
    const loadHistory = vi.fn(() => new Promise<{ messages: any[]; hasMore: boolean }>((resolve) => {
      resolveHistory = resolve
    }))

    controller.retain()
    manager.publish(createUpdate({
      messages: initialLive,
      syncMode: 'full',
      totalMessages: initialLive.length,
      lastMessageSignature: buildLastMessageSignature(initialLive[initialLive.length - 1]),
    }))
    const pendingLoad = controller.loadHistoryPage(loadHistory)
    manager.publish(createUpdate({
      messages: [...initialLive, liveArrivedDuringLoad],
      syncMode: 'full',
      totalMessages: 3,
      lastMessageSignature: buildLastMessageSignature(liveArrivedDuringLoad),
    }))
    resolveHistory({
      messages: [
        { role: 'assistant', content: 'older history', id: 'history-1', timestamp: 0 } as any,
        liveArrivedDuringLoad,
      ],
      hasMore: true,
    })
    await pendingLoad

    const snapshot = controller.getSnapshot()
    expect(snapshot.historyMessages.map(message => (message as any).content)).toEqual(['older history', 'live 3'])
    expect(snapshot.historyOffset).toBe(2)
  })

  it('persists loaded history pages across controller reacquisition for the same session', async () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })

    await controller.loadHistoryPage(async () => ({
      messages: [{ role: 'user', content: 'older history', id: 'hist-1', timestamp: 0 } as any],
      hasMore: false,
    }))
    controller.release()

    const reacquired = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })

    expect(reacquired.getSnapshot()).toMatchObject({
      historyMessages: [expect.objectContaining({ content: 'older history' })],
      historyOffset: 1,
      hasMoreHistory: false,
    })
  })

  it('accepts a daemon full update whose last message has an older timestamp than an earlier message in the same batch', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 1000,
    })

    controller.retain()
    // Establish baseline: last message has ts=1000
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'prompt', id: 'msg-1', timestamp: 900 } as any,
        { role: 'assistant', content: 'terminal output', id: 'msg-2', timestamp: 1000 } as any,
      ],
      syncMode: 'full',
      replaceFrom: 0,
      totalMessages: 2,
      lastMessageSignature: 'sig-2',
    }))

    expect(controller.getSnapshot().liveMessages).toHaveLength(2)

    // New daemon update: a plan tool message with an older semantic timestamp (500) appears
    // after the terminal message in stream order. The controller keeps daemon order as-is.
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'prompt', id: 'msg-1', timestamp: 900 } as any,
        { role: 'assistant', content: 'terminal output', id: 'msg-2', timestamp: 1000 } as any,
        { role: 'assistant', content: 'plan update 1 task(s)', id: 'msg-3', kind: 'tool', timestamp: 500 } as any,
      ],
      syncMode: 'full',
      replaceFrom: 0,
      totalMessages: 3,
      lastMessageSignature: 'sig-3',
    }))

    expect(controller.getSnapshot().liveMessages).toHaveLength(3)
    expect(controller.getSnapshot().liveMessages[2]).toMatchObject({ id: 'msg-3', content: 'plan update 1 task(s)' })
  })

  it('keeps fallback bubbles visible through transient empty generating updates', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
      fallbackRecentCount: 4,
    })

    controller.retain()
    manager.publish(createUpdate({
      messages: [
        { role: 'assistant', content: '────────────', id: 'chrome-1', timestamp: 1 } as any,
      ],
      status: 'generating',
      totalMessages: 1,
      lastMessageSignature: 'sig-chrome',
    }))

    expect(controller.getSnapshot()).toMatchObject({
      liveMessages: [],
      hasLiveSnapshot: false,
    })

    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'real prompt', id: 'msg-1', timestamp: 2 } as any,
        { role: 'assistant', content: 'real answer', id: 'msg-2', timestamp: 3 } as any,
      ],
      status: 'idle',
      totalMessages: 2,
      lastMessageSignature: 'sig-real',
    }))

    expect(controller.getSnapshot()).toMatchObject({
      hasLiveSnapshot: true,
    })
    expect(controller.getSnapshot().liveMessages.map(message => (message as any).content)).toEqual([
      'real prompt',
      'real answer',
    ])
  })

  it('keeps fallback bubbles visible through short busy current-turn tails', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
      fallbackRecentCount: 8,
    })

    controller.retain()
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'new prompt', id: 'msg-new-user', timestamp: 10 } as any,
        { role: 'assistant', content: 'Thinking...', id: 'msg-new-assistant', timestamp: 11 } as any,
      ],
      status: 'generating',
      totalMessages: 2,
      lastMessageSignature: 'sig-short-busy',
    }))

    expect(controller.getSnapshot()).toMatchObject({
      liveMessages: [],
      hasLiveSnapshot: false,
    })

    manager.publish(createUpdate({
      messages: Array.from({ length: 10 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `full-${index + 1}`,
        id: `full-${index + 1}`,
        timestamp: index + 1,
      })) as any,
      status: 'idle',
      totalMessages: 10,
      lastMessageSignature: 'sig-full',
    }))

    expect(controller.getSnapshot().hasLiveSnapshot).toBe(true)
    expect(controller.getSnapshot().liveMessages.map(message => (message as any).content)).toEqual([
      'full-1',
      'full-2',
      'full-3',
      'full-4',
      'full-5',
      'full-6',
      'full-7',
      'full-8',
      'full-9',
      'full-10',
    ])
  })

  it('exposes historyOffset=0 after a truncated live tail update before any history page is loaded', () => {
    // Regression guard for long Hermes/CLI chat invisibility: when a session has 100
    // total messages and the subscription fires with a 20-msg tail window, the snapshot
    // must have hasLiveSnapshot=true and historyOffset=0. getConversationLiveMessages
    // uses historyOffset=0 to detect the unloaded state and keep fallback visible.
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 20,
      fallbackRecentCount: 50,
    })

    controller.retain()
    manager.publish(createUpdate({
      messages: Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `tail-${index + 81}`,
        id: `tail-${index + 81}`,
        timestamp: index + 81,
      })) as any,
      totalMessages: 100,
      syncMode: 'full',
      replaceFrom: 80,
      lastMessageSignature: 'sig-tail-20',
    }))

    const snapshot = controller.getSnapshot()
    expect(snapshot.hasLiveSnapshot).toBe(true)
    expect(snapshot.historyOffset).toBe(0)
    expect(snapshot.liveMessages).toHaveLength(20)
    // hasMoreHistory stays true — controller knows there is older history
    expect(snapshot.hasMoreHistory).toBe(true)
  })

  it('exposes historyOffset > 0 after a history page is loaded, signalling live tail is authoritative', async () => {
    // After the user scrolls up and history loads, historyOffset is incremented.
    // getConversationLiveMessages uses this to switch from fallback to live tail authority.
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 20,
      fallbackRecentCount: 50,
    })

    controller.retain()
    manager.publish(createUpdate({
      messages: Array.from({ length: 20 }, (_, index) => ({
        role: 'assistant',
        content: `tail-${index + 81}`,
        id: `tail-${index + 81}`,
        timestamp: index + 81,
      })) as any,
      totalMessages: 100,
      syncMode: 'full',
      replaceFrom: 80,
      lastMessageSignature: 'sig-tail-20',
    }))

    await controller.loadHistoryPage(async () => ({
      messages: Array.from({ length: 30 }, (_, index) => ({
        role: 'assistant',
        content: `history-${index + 50}`,
        id: `history-${index + 50}`,
        timestamp: index + 50,
      })),
      hasMore: true,
    }))

    const snapshot = controller.getSnapshot()
    expect(snapshot.historyOffset).toBe(30)
    expect(snapshot.hasLiveSnapshot).toBe(true)
  })
})
