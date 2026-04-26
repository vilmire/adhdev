import { describe, expect, it, vi } from 'vitest'
import type { SessionChatTailUpdate } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  applyWarmSessionChatTailSnapshots,
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

  it('overlays newer warm chat-tail messages onto conversations used by mobile inbox previews', () => {
    const conversations = [createConversation({
      messages: [{ role: 'assistant', content: 'old inbox preview', id: 'old-1', receivedAt: 1000 }],
    })]
    const snapshots = new Map([
      ['daemon-1::session-1', {
        liveMessages: [{ role: 'assistant', content: 'actual last message in chat', id: 'new-1', receivedAt: 2000 }],
        cursor: { knownMessageCount: 1, lastMessageSignature: 'sig-new', tailLimit: 60 },
        historyMessages: [],
        historyOffset: 0,
        hasMoreHistory: true,
        historyError: null,
      }],
    ])

    const merged = applyWarmSessionChatTailSnapshots(conversations as any, snapshots as any)

    expect(merged).not.toBe(conversations)
    expect(merged[0]?.messages).toEqual([
      { role: 'assistant', content: 'actual last message in chat', id: 'new-1', receivedAt: 2000 },
    ])
    expect(merged[0]?.lastMessagePreview).toBe('actual last message in chat')
    expect(merged[0]?.lastMessageAt).toBe(2000)
  })

  it('keeps conversation messages when the warm chat-tail snapshot is older', () => {
    const conversations = [createConversation({
      messages: [{ role: 'assistant', content: 'current conversation message', id: 'new-1', receivedAt: 2000 }],
    })]
    const snapshots = new Map([
      ['daemon-1::session-1', {
        liveMessages: [{ role: 'assistant', content: 'older cached message', id: 'old-1', receivedAt: 1000 }],
        cursor: { knownMessageCount: 1, lastMessageSignature: 'sig-old', tailLimit: 60 },
        historyMessages: [],
        historyOffset: 0,
        hasMoreHistory: true,
        historyError: null,
      }],
    ])

    const merged = applyWarmSessionChatTailSnapshots(conversations as any, snapshots as any)

    expect(merged).toBe(conversations)
    expect(merged[0]?.messages).toEqual([
      { role: 'assistant', content: 'current conversation message', id: 'new-1', receivedAt: 2000 },
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

  it('subscribes with a tail request when no prior live cursor exists', () => {
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
    expect(sendData.mock.calls[0]?.[1]).toMatchObject({
      type: 'subscribe',
      topic: 'session.chat_tail',
      key: 'daemon:daemon-1:session:session-1',
      params: {
        targetSessionId: 'session-1',
        historySessionId: 'history-1',
        knownMessageCount: 0,
        lastMessageSignature: '',
        tailLimit: 60,
      },
    })
  })

  it('does not advance the live cursor beyond the messages actually hydrated from a truncated tail snapshot', () => {
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

    expect(controller.getSnapshot().cursor).toMatchObject({
      knownMessageCount: 60,
      lastMessageSignature: 'sig-tail-60',
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
    expect(subscribeCalls.at(-1)?.[1]).toMatchObject({
      topic: 'session.chat_tail',
      key: 'daemon:daemon-1:session:session-1',
      params: {
        targetSessionId: 'session-1',
        historySessionId: 'history-1',
        knownMessageCount: 60,
        lastMessageSignature: 'sig-tail-60',
        tailLimit: 200,
      },
    })
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
        cursor: {
          knownMessageCount: 1,
          lastMessageSignature: 'sig-1',
          tailLimit: 60,
        },
      }),
    )
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

    controller.hydrateLiveMessages([
      { role: 'user', content: 'old-1', id: 'old-1', timestamp: 1 } as any,
      { role: 'assistant', content: 'old-2', id: 'old-2', timestamp: 2 } as any,
      { role: 'user', content: 'new-1', id: 'new-1', timestamp: 3 } as any,
      { role: 'assistant', content: 'new-2', id: 'new-2', timestamp: 4 } as any,
    ])
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
})
