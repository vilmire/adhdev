import { describe, expect, it, vi } from 'vitest'
import type { SessionChatTailUpdate } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  buildLastMessageSignature,
  buildWarmSessionChatTailDescriptorState,
  clearSessionChatTailControllerSnapshot,
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

  it('warm descriptor OMITS historySessionId for an agy coordinator (no surfaced providerSessionId) but SENDS a distinct provider id', () => {
    const now = 2_000_000
    const state = buildWarmSessionChatTailDescriptorState([
      // Agy coordinator: no providerSessionId surfaced → historySessionId would
      // fall back to the runtime sessionId (the poison). The descriptor must NOT
      // carry it (undefined → subscribe omits the arg → daemon self-resolves).
      createConversation({
        sessionId: 'agy-coordinator-session',
        providerSessionId: undefined,
        tabKey: 'daemon-1:session:agy-coordinator-session',
        status: 'idle',
        messages: [{ role: 'user', content: 'coordinator prompt' }],
        lastMessageAt: now - 5_000,
        lastUpdated: now - 5_000,
      }),
      // Normal session with a distinct provider id → sent as-is (exact-bind).
      createConversation({
        routeId: 'route-provider',
        sessionId: 'runtime-session',
        providerSessionId: 'real-conv-uuid',
        daemonId: 'daemon-2',
        tabKey: 'daemon-2:session:runtime-session',
        status: 'idle',
        messages: [{ role: 'assistant', content: 'answer' }],
        lastMessageAt: now - 5_000,
        lastUpdated: now - 5_000,
      }),
    ], { now })

    const coordinator = state.descriptors.find((d) => d.sessionId === 'agy-coordinator-session')
    const normal = state.descriptors.find((d) => d.sessionId === 'runtime-session')
    expect(coordinator?.historySessionId).toBeUndefined()
    expect(normal?.historySessionId).toBe('real-conv-uuid')
  })

  it('subscribe request OMITS historySessionId when the controller has none (coordinator poison avoided)', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const sendData = vi.fn().mockReturnValue(true)
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData,
      daemonId: 'daemon-1',
      sessionId: 'agy-coordinator-session',
      // No historySessionId — the read-safe value for a coordinator.
      subscriptionKey: 'daemon:daemon-1:session:agy-coordinator-session',
      tailLimit: 60,
    })
    controller.retain()

    const request = sendData.mock.calls[0]?.[1]
    expect(request.params).toMatchObject({ targetSessionId: 'agy-coordinator-session', tailLimit: 60 })
    expect(request.params).not.toHaveProperty('historySessionId')
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

  it('connects a retained controller when sendData becomes available after first render', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })

    controller.retain()

    const sendData = vi.fn().mockReturnValue(true)
    const reacquired = getOrCreateSessionChatTailController({
      manager,
      sendData,
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })

    expect(reacquired).toBe(controller)
    expect(sendData).toHaveBeenCalledOnce()
    expect(sendData.mock.calls[0]?.[1]).toMatchObject({
      type: 'subscribe',
      topic: 'session.chat_tail',
      key: 'daemon:daemon-1:session:session-1',
      params: {
        targetSessionId: 'session-1',
        historySessionId: 'history-1',
        tailLimit: 60,
      },
    })
  })

  it('re-subscribes when a Codex runtime session later resolves its provider history id', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const sendData = vi.fn().mockReturnValue(true)
    const runtimeController = getOrCreateSessionChatTailController({
      manager,
      sendData,
      daemonId: 'daemon-1',
      sessionId: 'runtime-session-1',
      historySessionId: 'runtime-session-1',
      subscriptionKey: 'daemon:daemon-1:session:runtime-session-1',
      tailLimit: 60,
    })

    runtimeController.retain()

    const providerController = getOrCreateSessionChatTailController({
      manager,
      sendData,
      daemonId: 'daemon-1',
      sessionId: 'runtime-session-1',
      historySessionId: '019ea459-712f-7eb2-84a5-d2e633c1ec45',
      subscriptionKey: 'daemon:daemon-1:session:runtime-session-1',
      tailLimit: 60,
    })

    providerController.retain()

    const subscribeCalls = sendData.mock.calls
      .map((call) => call[1])
      .filter((request) => request?.type === 'subscribe')

    expect(subscribeCalls).toHaveLength(2)
    expect(subscribeCalls[0]).toMatchObject({
      topic: 'session.chat_tail',
      key: 'daemon:daemon-1:session:runtime-session-1',
      params: {
        targetSessionId: 'runtime-session-1',
        historySessionId: 'runtime-session-1',
      },
    })
    expect(subscribeCalls[1]).toMatchObject({
      topic: 'session.chat_tail',
      key: 'daemon:daemon-1:session:runtime-session-1',
      params: {
        targetSessionId: 'runtime-session-1',
        historySessionId: '019ea459-712f-7eb2-84a5-d2e633c1ec45',
      },
    })
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

  it('keeps chat-tail snapshots isolated by active history session id', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const sendData = vi.fn().mockReturnValue(true)
    const oldController = getOrCreateSessionChatTailController({
      manager,
      sendData,
      daemonId: 'daemon-1',
      sessionId: 'runtime-1',
      historySessionId: 'chat-old',
      subscriptionKey: 'daemon:daemon-1:session:runtime-1',
      tailLimit: 60,
    })

    oldController.retain()
    manager.publish(createUpdate({
      sessionId: 'runtime-1',
      key: 'daemon:daemon-1:session:runtime-1',
      messages: [{ role: 'assistant', content: 'old transcript', id: 'old-1', timestamp: 1 } as any],
    }))

    const newController = getOrCreateSessionChatTailController({
      manager,
      sendData,
      daemonId: 'daemon-1',
      sessionId: 'runtime-1',
      historySessionId: 'chat-new',
      subscriptionKey: 'daemon:daemon-1:session:runtime-1',
      tailLimit: 60,
    })

    expect(newController).not.toBe(oldController)
    expect(newController.getSnapshot()).toMatchObject({
      liveMessages: [],
      hasLiveSnapshot: false,
    })
  })

  it('ignores chat-tail updates whose session id does not match the controller target', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-a',
      historySessionId: 'history-a',
      subscriptionKey: 'daemon:daemon-1:session:session-a',
      tailLimit: 60,
    })

    controller.retain()
    manager.publish(createUpdate({
      key: 'daemon:daemon-1:session:session-a',
      sessionId: 'session-b',
      historySessionId: 'history-b',
      messages: [{ role: 'assistant', content: 'session b should not bleed', id: 'b-1', timestamp: 1 } as any],
    }))

    expect(controller.getSnapshot()).toMatchObject({
      liveMessages: [],
      hasLiveSnapshot: false,
    })

    manager.publish(createUpdate({
      key: 'daemon:daemon-1:session:session-a',
      sessionId: 'session-a',
      historySessionId: 'history-a',
      messages: [{ role: 'assistant', content: 'session a transcript', id: 'a-1', timestamp: 2 } as any],
    }))

    expect(controller.getSnapshot()).toMatchObject({
      hasLiveSnapshot: true,
      liveMessages: [expect.objectContaining({ content: 'session a transcript' })],
    })
  })

  it('ignores chat-tail updates whose history session id does not match the active chat', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'runtime-1',
      historySessionId: 'chat-a',
      subscriptionKey: 'daemon:daemon-1:session:runtime-1',
      tailLimit: 60,
    })

    controller.retain()
    manager.publish(createUpdate({
      key: 'daemon:daemon-1:session:runtime-1',
      sessionId: 'runtime-1',
      historySessionId: 'chat-b',
      messages: [{ role: 'assistant', content: 'chat b should not overwrite chat a', id: 'b-1', timestamp: 1 } as any],
    }))

    expect(controller.getSnapshot()).toMatchObject({
      liveMessages: [],
      hasLiveSnapshot: false,
    })

    manager.publish(createUpdate({
      key: 'daemon:daemon-1:session:runtime-1',
      sessionId: 'runtime-1',
      historySessionId: 'chat-a',
      messages: [{ role: 'assistant', content: 'chat a transcript', id: 'a-1', timestamp: 2 } as any],
    }))

    expect(controller.getSnapshot()).toMatchObject({
      hasLiveSnapshot: true,
      liveMessages: [expect.objectContaining({ content: 'chat a transcript' })],
    })
  })

  it('can clear retained chat-tail snapshots immediately after an explicit new chat action', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'runtime-1',
      historySessionId: 'chat-old',
      subscriptionKey: 'daemon:daemon-1:session:runtime-1',
      tailLimit: 60,
    })

    controller.retain()
    manager.publish(createUpdate({
      sessionId: 'runtime-1',
      key: 'daemon:daemon-1:session:runtime-1',
      messages: [{ role: 'assistant', content: 'old transcript', id: 'old-1', timestamp: 1 } as any],
    }))

    clearSessionChatTailControllerSnapshot('daemon-1', 'runtime-1', 'chat-old')

    expect(controller.getSnapshot()).toMatchObject({
      liveMessages: [],
      hasLiveSnapshot: true,
    })
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

  it('renders tail-only Codex native-history updates during generation instead of clearing the live transcript', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'codex-runtime-session',
      historySessionId: '019e71fb-3cd1-76f1-9500-a7977eb2b374',
      subscriptionKey: 'daemon:daemon-1:session:codex-runtime-session',
      tailLimit: 60,
    })

    controller.retain()
    manager.publish({
      topic: 'session.chat_tail',
      key: 'daemon:daemon-1:session:codex-runtime-session',
      sessionId: 'codex-runtime-session',
      historySessionId: '019e71fb-3cd1-76f1-9500-a7977eb2b374',
      seq: 1,
      timestamp: 1,
      status: 'generating',
      messagesTail: [
        {
          role: 'user',
          kind: 'standard',
          content: '추가 범위',
          id: 'native-user-119',
          bubbleId: 'bubble:codex-cli:native:019e71fb-3cd1-76f1-9500-a7977eb2b374:119:user:standard:19486670',
          providerUnitKey: 'codex-cli:native:019e71fb-3cd1-76f1-9500-a7977eb2b374:119:user:standard:19486670',
          _turnKey: 'codex-cli:native-turn:019e71fb-3cd1-76f1-9500-a7977eb2b374:17',
        },
        {
          role: 'assistant',
          kind: 'standard',
          source: 'assistant_text',
          content: '조사하겠습니다.',
          id: 'native-assistant-120',
          bubbleId: 'bubble:codex-cli:native:019e71fb-3cd1-76f1-9500-a7977eb2b374:120:assistant:standard:7bbaf6c4',
          providerUnitKey: 'codex-cli:native:019e71fb-3cd1-76f1-9500-a7977eb2b374:120:assistant:standard:7bbaf6c4',
          _turnKey: 'codex-cli:native-turn:019e71fb-3cd1-76f1-9500-a7977eb2b374:17',
        },
      ],
    } as any)

    const snapshot = controller.getSnapshot()
    expect(snapshot.hasLiveSnapshot).toBe(true)
    expect(snapshot.liveMessages.map(message => (message as any).content)).toEqual([
      '추가 범위',
      '조사하겠습니다.',
    ])
    expect((snapshot.liveMessages[0] as any).providerUnitKey).toContain('codex-cli:native:019e71fb-3cd1-76f1-9500-a7977eb2b374')
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

  it('keeps fallback bubbles visible through transient native-unavailable empty idle updates', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'codex-runtime-session',
      historySessionId: 'codex-runtime-session',
      subscriptionKey: 'daemon:daemon-1:session:codex-runtime-session',
      tailLimit: 60,
      fallbackRecentCount: 2,
    })

    controller.retain()
    manager.publish(createUpdate({
      key: 'daemon:daemon-1:session:codex-runtime-session',
      sessionId: 'codex-runtime-session',
      historySessionId: 'codex-runtime-session',
      messages: [],
      status: 'idle',
      messageSource: {
        selected: 'pty-parser',
        fallbackReason: 'native_history_empty',
        nativeSource: 'native-unavailable',
      },
    } as any))

    expect(controller.getSnapshot()).toMatchObject({
      liveMessages: [],
      hasLiveSnapshot: false,
    })
  })

  it('keeps hydrated live bubbles visible through transient native-unavailable empty refreshes', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'codex-runtime-session',
      historySessionId: '019ea2ea-375b-7c62-946e-f63b4c04ba6e',
      subscriptionKey: 'daemon:daemon-1:session:codex-runtime-session',
      tailLimit: 60,
    })

    controller.retain()
    manager.publish(createUpdate({
      key: 'daemon:daemon-1:session:codex-runtime-session',
      sessionId: 'codex-runtime-session',
      historySessionId: '019ea2ea-375b-7c62-946e-f63b4c04ba6e',
      messages: [
        { role: 'user', content: 'visible prompt', id: 'msg-1', timestamp: 1 } as any,
        { role: 'assistant', content: 'visible answer', id: 'msg-2', timestamp: 2 } as any,
      ],
      status: 'idle',
      messageSource: {
        selected: 'native-history',
        nativeSource: 'provider-native',
      },
    } as any))

    manager.publish(createUpdate({
      key: 'daemon:daemon-1:session:codex-runtime-session',
      sessionId: 'codex-runtime-session',
      historySessionId: '019ea2ea-375b-7c62-946e-f63b4c04ba6e',
      messages: [],
      status: 'idle',
      messageSource: {
        selected: 'pty-parser',
        fallbackReason: 'native_history_empty',
        nativeSource: 'native-unavailable',
      },
    } as any))

    expect(controller.getSnapshot()).toMatchObject({
      hasLiveSnapshot: true,
      liveMessages: [
        expect.objectContaining({ content: 'visible prompt' }),
        expect.objectContaining({ content: 'visible answer' }),
      ],
    })
  })

  it('keeps hydrated live bubbles visible through a transient empty native-held tail (selected=native-history + native_history_transient_gap_held)', () => {
    // Defense in depth for the coordinator zero-bubble bug: a daemon running
    // the STICKY-NATIVE empty hold ships an EMPTY tail with selected
    // 'native-history' and fallbackReason 'native_history_transient_gap_held'.
    // Trusting `selected` alone would apply an authoritative empty live
    // snapshot and clobber the last real snapshot — this combination must be
    // treated as transient even though selected is native-history.
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'coordinator-session',
      historySessionId: '07f6ed3e-0000-7000-8000-000000000000',
      subscriptionKey: 'daemon:daemon-1:session:coordinator-session',
      tailLimit: 60,
    })

    controller.retain()
    manager.publish(createUpdate({
      key: 'daemon:daemon-1:session:coordinator-session',
      sessionId: 'coordinator-session',
      historySessionId: '07f6ed3e-0000-7000-8000-000000000000',
      messages: [
        { role: 'user', content: 'coordinator prompt', id: 'msg-1', timestamp: 1 } as any,
        { role: 'assistant', content: 'coordinator answer', id: 'msg-2', timestamp: 2 } as any,
      ],
      status: 'idle',
      messageSource: {
        selected: 'native-history',
        nativeSource: 'provider-native',
      },
    } as any))

    expect(controller.getSnapshot().liveMessages).toHaveLength(2)

    manager.publish(createUpdate({
      key: 'daemon:daemon-1:session:coordinator-session',
      sessionId: 'coordinator-session',
      historySessionId: '07f6ed3e-0000-7000-8000-000000000000',
      messages: [],
      status: 'idle',
      messageSource: {
        selected: 'native-history',
        fallbackReason: 'native_history_transient_gap_held',
        nativeSource: 'provider-native',
      },
    } as any))

    expect(controller.getSnapshot()).toMatchObject({
      hasLiveSnapshot: true,
      liveMessages: [
        expect.objectContaining({ content: 'coordinator prompt' }),
        expect.objectContaining({ content: 'coordinator answer' }),
      ],
    })
  })

  it('caps retained history at 500 rows while advancing historyOffset by the full fetched page size', async () => {
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

    const page = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => ({
      role: 'assistant',
      content: `row-${from + index}`,
      id: `row-${from + index}`,
      timestamp: from + index,
    }) as any)

    controller.retain()
    // Newest history page first (Load older walks backwards).
    await controller.loadHistoryPage(async () => ({ messages: page(300, 599), hasMore: true }))
    await controller.loadHistoryPage(async () => ({ messages: page(0, 299), hasMore: true }))

    const snapshot = controller.getSnapshot()
    // 600 merged rows capped to the newest 500; historyOffset still advances by
    // the full fetched size (300 + 300) so the next page request stays aligned.
    expect(snapshot.historyMessages).toHaveLength(500)
    expect((snapshot.historyMessages[0] as any).content).toBe('row-100')
    expect((snapshot.historyMessages[499] as any).content).toBe('row-599')
    expect(snapshot.historyOffset).toBe(600)
    expect(snapshot.hasMoreHistory).toBe(true)
  })

  it('preserves explicit empty clear state even when a transient empty update follows', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'codex-runtime-session',
      historySessionId: 'old-chat',
      subscriptionKey: 'daemon:daemon-1:session:codex-runtime-session',
      tailLimit: 60,
      fallbackRecentCount: 2,
    })

    controller.retain()
    manager.publish(createUpdate({
      key: 'daemon:daemon-1:session:codex-runtime-session',
      sessionId: 'codex-runtime-session',
      historySessionId: 'old-chat',
      messages: [
        { role: 'assistant', content: 'old chat', id: 'old-1', timestamp: 1 } as any,
      ],
    }))
    clearSessionChatTailControllerSnapshot('daemon-1', 'codex-runtime-session', 'old-chat')
    manager.publish(createUpdate({
      key: 'daemon:daemon-1:session:codex-runtime-session',
      sessionId: 'codex-runtime-session',
      historySessionId: 'old-chat',
      messages: [],
      status: 'idle',
      messageSource: {
        selected: 'pty-parser',
        fallbackReason: 'native_history_empty',
        nativeSource: 'native-unavailable',
      },
    } as any))

    expect(controller.getSnapshot()).toMatchObject({
      liveMessages: [],
      hasLiveSnapshot: true,
    })
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

  it('keeps the hydrated assistant bubble visible through a short partial tail while waiting_approval (no flicker)', () => {
    // CHATFLICKER regression: during approval the daemon can emit a short partial
    // tail (only the user prompt; assistant bubble briefly missing). Because the
    // session-chat-tail snapshot is the sole transcript authority, that shrink
    // would transiently erase the assistant bubble. waiting_approval is a warm/active
    // status, so the shrink-defense gate must defer it.
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
    // Hydrate a full tail with a visible assistant answer (idle applies immediately).
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'please run the command', id: 'msg-user', timestamp: 1 } as any,
        { role: 'assistant', content: 'here is the answer', id: 'msg-assistant', timestamp: 2 } as any,
      ],
      status: 'idle',
      totalMessages: 2,
      lastMessageSignature: 'sig-hydrated',
    }))

    expect(controller.getSnapshot().liveMessages.map(message => (message as any).content)).toEqual([
      'please run the command',
      'here is the answer',
    ])

    // Approval window: a short partial tail arrives carrying only the user prompt.
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'please run the command', id: 'msg-user', timestamp: 1 } as any,
      ],
      status: 'waiting_approval',
      totalMessages: 1,
      lastMessageSignature: 'sig-partial-approval',
    }))

    // Deferred: the hydrated assistant bubble must still be present.
    expect(controller.getSnapshot().liveMessages.map(message => (message as any).content)).toEqual([
      'please run the command',
      'here is the answer',
    ])
  })

  it('applies a SHORTER idle tail that finally carries the assistant answer when the on-screen tail is stuck on the user prompt (ANTIGRAVITY-TAIL-USER-ONLY)', () => {
    // Regression: an antigravity/MAGI coordinator whose native-history tail, on the
    // generating→idle transition, is SHORTER than the busy-phase tail (chrome/partial
    // bubbles collapse on finalization) but finally ends on the assistant answer.
    // The transition-window shrink-defense used to defer it on the length heuristic,
    // stranding the session showing only the user prompt until a full-page reload.
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
    // Hydrate a busy-phase tail that ends on the USER prompt (assistant not yet
    // in native-history) — longer because it carries partial/chrome bubbles.
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'MAGI 테스트', id: 'msg-user', timestamp: 1 } as any,
        { role: 'assistant', content: '─── working ───', id: 'msg-chrome-1', kind: 'tool', timestamp: 2 } as any,
        { role: 'assistant', content: '─── still working ───', id: 'msg-chrome-2', kind: 'tool', timestamp: 3 } as any,
        { role: 'user', content: '[System] node dispatched', id: 'msg-sys', kind: 'system', timestamp: 4 } as any,
      ],
      status: 'generating',
      totalMessages: 4,
      lastMessageSignature: 'sig-busy-userend',
      messageSource: { selected: 'native-history' } as any,
    }))

    // On-screen tail's last substantive bubble is the user/system prompt (chrome
    // bubbles are tool-kind and don't count as the answer).
    const beforeContents = controller.getSnapshot().liveMessages.map(message => (message as any).content)
    expect(beforeContents).toContain('MAGI 테스트')

    // generating→idle: finalized tail is SHORTER (2 rows) but ends on the real
    // assistant answer. antigravity has fallen back off native-history for this
    // read (idle >window → native_history_empty → PTY), so the source-trust
    // early-return does NOT fire and the count heuristic would otherwise defer
    // this shorter tail. The new-assistant guard must force it through anyway.
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'MAGI 테스트', id: 'msg-user', timestamp: 1 } as any,
        { role: 'assistant', content: '현재 git 상태 RCA 결과입니다', id: 'msg-final', timestamp: 5 } as any,
      ],
      status: 'idle',
      totalMessages: 2,
      lastMessageSignature: 'sig-final-answer',
      messageSource: { selected: 'pty', fallbackReason: 'native_history_empty' } as any,
    }))

    expect(controller.getSnapshot().liveMessages.map(message => (message as any).content)).toEqual([
      'MAGI 테스트',
      '현재 git 상태 RCA 결과입니다',
    ])
  })

  it('applies the immediately-following full tail normally after a deferred waiting_approval partial', () => {
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
        { role: 'user', content: 'please run the command', id: 'msg-user', timestamp: 1 } as any,
        { role: 'assistant', content: 'here is the answer', id: 'msg-assistant', timestamp: 2 } as any,
      ],
      status: 'idle',
      totalMessages: 2,
      lastMessageSignature: 'sig-hydrated',
    }))

    // Short partial during approval → deferred.
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'please run the command', id: 'msg-user', timestamp: 1 } as any,
      ],
      status: 'waiting_approval',
      totalMessages: 1,
      lastMessageSignature: 'sig-partial-approval',
    }))

    // Next full tail (assistant restored + approval continuation) applies as-is.
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'please run the command', id: 'msg-user', timestamp: 1 } as any,
        { role: 'assistant', content: 'here is the answer', id: 'msg-assistant', timestamp: 2 } as any,
        { role: 'assistant', content: 'command approved and finished', id: 'msg-final', timestamp: 3 } as any,
      ],
      status: 'idle',
      totalMessages: 3,
      lastMessageSignature: 'sig-final',
    }))

    expect(controller.getSnapshot().liveMessages.map(message => (message as any).content)).toEqual([
      'please run the command',
      'here is the answer',
      'command approved and finished',
    ])
  })

  it('applies an intentional empty clear immediately even though a transient empty update follows during new chat / switch', () => {
    // No-regression: the new_chat/reset/switchedConversation clear path must keep
    // working. clearLiveSnapshot sets an explicit empty live snapshot and a
    // following transient empty tail must NOT resurrect old rows; the empty stays.
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
        { role: 'user', content: 'old prompt', id: 'old-user', timestamp: 1 } as any,
        { role: 'assistant', content: 'old answer', id: 'old-assistant', timestamp: 2 } as any,
      ],
      status: 'waiting_approval',
      totalMessages: 2,
      lastMessageSignature: 'sig-old',
    }))

    // Explicit new-chat/reset.
    clearSessionChatTailControllerSnapshot('daemon-1', 'session-1', 'history-1')

    expect(controller.getSnapshot()).toMatchObject({
      liveMessages: [],
      hasLiveSnapshot: true,
    })

    // A transient empty native-unavailable tail right after the clear must stay empty.
    manager.publish(createUpdate({
      messages: [],
      status: 'waiting_approval',
      messageSource: {
        selected: 'pty-parser',
        fallbackReason: 'native_history_empty',
        nativeSource: 'native-unavailable',
      },
    } as any))

    expect(controller.getSnapshot()).toMatchObject({
      liveMessages: [],
      hasLiveSnapshot: true,
    })
  })

  it('still defers a short partial tail during streaming exactly as before (busy shrink-defense unchanged)', () => {
    // No-regression for the pre-existing busy shrink-defense: a short partial tail
    // during a strictly-busy status (streaming) must continue to be deferred. The
    // CHATFLICKER fix only ADDED waiting_approval coverage; busy behavior is intact.
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
    // Hydrate via idle so the baseline applies, then exercise the streaming shrink.
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'please run the command', id: 'msg-user', timestamp: 1 } as any,
        { role: 'assistant', content: 'streaming answer', id: 'msg-assistant', timestamp: 2 } as any,
      ],
      status: 'idle',
      totalMessages: 2,
      lastMessageSignature: 'sig-hydrated',
    }))

    // Short partial during streaming → deferred (unchanged busy behavior).
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'please run the command', id: 'msg-user', timestamp: 1 } as any,
      ],
      status: 'streaming',
      totalMessages: 1,
      lastMessageSignature: 'sig-partial-streaming',
    }))

    expect(controller.getSnapshot().liveMessages.map(message => (message as any).content)).toEqual([
      'please run the command',
      'streaming answer',
    ])
  })

  it('keeps hydrated bubbles visible through a short user-only tail at the generating→idle transition (within recent-activity window)', () => {
    // CHAT-DISAPPEAR-REAPPEAR: the daemon flips status to `idle` the instant
    // generating ends, but can still ship a stale short user-only tail. `idle` is
    // neither WARM_ACTIVE nor busy, so the pre-fix shrink-defense early-exited and
    // let that short tail overwrite the hydrated assistant/system bubbles, making
    // them disappear-then-reappear. Within the recent-activity window (just after a
    // generating update) the shrink-defense must now defer the short tail.
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    let nowMs = 1_000_000
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
      fallbackRecentCount: 4,
      now: () => nowMs,
    })

    controller.retain()
    // Hydrate the full transcript via idle (applies immediately — no active stamp yet).
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'please run the command', id: 'msg-user', timestamp: 1 } as any,
        { role: 'assistant', content: 'here is the answer', id: 'msg-assistant', timestamp: 2 } as any,
      ],
      status: 'idle',
      totalMessages: 2,
      lastMessageSignature: 'sig-hydrated',
    }))

    expect(controller.getSnapshot().liveMessages.map(message => (message as any).content)).toEqual([
      'please run the command',
      'here is the answer',
    ])

    // The session begins generating (re-emits the same hydrated tail) — this stamps
    // the last-active-status time used for the transition window.
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'please run the command', id: 'msg-user', timestamp: 1 } as any,
        { role: 'assistant', content: 'here is the answer', id: 'msg-assistant', timestamp: 2 } as any,
      ],
      status: 'generating',
      totalMessages: 2,
      lastMessageSignature: 'sig-generating',
    }))

    // 1s later: status flips to idle and a stale short user-only tail arrives.
    // Still inside the recent-activity window → deferred (bubbles preserved).
    nowMs += 1_000
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'please run the command', id: 'msg-user', timestamp: 1 } as any,
      ],
      status: 'idle',
      totalMessages: 1,
      lastMessageSignature: 'sig-idle-short',
    }))

    expect(controller.getSnapshot().liveMessages.map(message => (message as any).content)).toEqual([
      'please run the command',
      'here is the answer',
    ])
  })

  it('applies a short idle tail normally when the generating→idle window has elapsed (settled idle, no over-protection)', () => {
    // No-regression: a legitimate tail shrink on a genuinely-settled idle session
    // (e.g. the daemon re-windowed the tail long after generation finished) must
    // still apply. Outside DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS the
    // transition-window protection is OFF and `idle` behaves exactly as before.
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    let nowMs = 1_000_000
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
      fallbackRecentCount: 4,
      now: () => nowMs,
    })

    controller.retain()
    // Hydrate via idle, then a generating update to stamp the last-active time.
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'please run the command', id: 'msg-user', timestamp: 1 } as any,
        { role: 'assistant', content: 'here is the answer', id: 'msg-assistant', timestamp: 2 } as any,
      ],
      status: 'idle',
      totalMessages: 2,
      lastMessageSignature: 'sig-hydrated',
    }))
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'please run the command', id: 'msg-user', timestamp: 1 } as any,
        { role: 'assistant', content: 'here is the answer', id: 'msg-assistant', timestamp: 2 } as any,
      ],
      status: 'generating',
      totalMessages: 2,
      lastMessageSignature: 'sig-generating',
    }))

    // Far past the recent-activity window (120_000ms): the session is settled idle.
    nowMs += 5 * 60_000
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'please run the command', id: 'msg-user', timestamp: 1 } as any,
      ],
      status: 'idle',
      totalMessages: 1,
      lastMessageSignature: 'sig-idle-settled-short',
    }))

    // Applied (shrink allowed) — settled idle is not over-protected.
    expect(controller.getSnapshot().liveMessages.map(message => (message as any).content)).toEqual([
      'please run the command',
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

  it('force-applies a native-history [user, assistant] tail that adds a missing assistant EVEN AFTER the transition window has lapsed (D6)', () => {
    // D6 (generating→idle transition-window race): the view is stranded at a
    // user-only intermediate. A corrective native-history [user, assistant]
    // snapshot arrives, but the transition-window timer has already lapsed
    // (>DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS). Because it is the
    // daemon's locked native transcript adding an assistant the view lacks, it
    // must force-apply anyway — no full-page reload should be needed.
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    let nowMs = 1_000_000
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
      fallbackRecentCount: 4,
      now: () => nowMs,
    })

    controller.retain()
    // Generating stamps the transition-window clock and hydrates a user-only tail.
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: '코디 채팅에 무엇이 보이나', id: 'msg-user', timestamp: 1 } as any,
      ],
      status: 'generating',
      totalMessages: 1,
      lastMessageSignature: 'sig-user-only',
      messageSource: { selected: 'native-history' } as any,
    }))
    expect(controller.getSnapshot().liveMessages.map(m => (m as any).content)).toEqual([
      '코디 채팅에 무엇이 보이나',
    ])

    // Well past the recent-activity window (120_000ms): the transition-window
    // protection is OFF, so the ONLY thing that carries the corrective tail
    // through is the native-assistant force-apply.
    nowMs += 5 * 60_000
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: '코디 채팅에 무엇이 보이나', id: 'msg-user', timestamp: 1 } as any,
        { role: 'assistant', content: 'RCA 결과 정리했습니다', id: 'msg-assistant', timestamp: 2 } as any,
      ],
      status: 'idle',
      totalMessages: 2,
      lastMessageSignature: 'sig-user-assistant',
      messageSource: { selected: 'native-history' } as any,
    }))

    expect(controller.getSnapshot().liveMessages.map(m => (m as any).content)).toEqual([
      '코디 채팅에 무엇이 보이나',
      'RCA 결과 정리했습니다',
    ])
  })

  it('force-applies a native-history assistant tail even when the coarse last-message signature would match the stranded tail (D6 cause a)', () => {
    // D6 cause (a): the unchanged-signature short-circuit must not suppress a
    // user-only → [user, assistant] transition. Here both tails share the SAME
    // trailing chrome/activity bubble (so buildChatSnapshotSignature — which keys
    // on the last message — collides) but the incoming tail inserts the real
    // assistant answer the view lacks. The last-substantive-assistant identity in
    // the no-op check (plus the force-apply) must let it through.
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
    const trailingActivity = { role: 'assistant', kind: 'terminal', content: '$ git status', id: 'msg-activity', timestamp: 9 } as any

    controller.retain()
    // Stranded: user prompt + a trailing (non-substantive) activity bubble. The
    // last substantive role is the user prompt.
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: '무엇이 보이나', id: 'msg-user', timestamp: 1 } as any,
        trailingActivity,
      ],
      status: 'idle',
      totalMessages: 2,
      lastMessageSignature: 'sig-same-trailing',
      messageSource: { selected: 'native-history' } as any,
    }))
    expect(controller.getSnapshot().liveMessages.map(m => (m as any).content)).toEqual([
      '무엇이 보이나',
      '$ git status',
    ])

    // Corrective native tail: SAME last message (the activity bubble → same coarse
    // last-message signature and same length=... ) but inserts the assistant answer.
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: '무엇이 보이나', id: 'msg-user', timestamp: 1 } as any,
        { role: 'assistant', content: '어시스턴트 최종 답변', id: 'msg-assistant', timestamp: 5 } as any,
        trailingActivity,
      ],
      status: 'idle',
      totalMessages: 3,
      lastMessageSignature: 'sig-same-trailing',
      messageSource: { selected: 'native-history' } as any,
    }))

    expect(controller.getSnapshot().liveMessages.map(m => (m as any).content)).toEqual([
      '무엇이 보이나',
      '어시스턴트 최종 답변',
      '$ git status',
    ])
  })

  it('does NOT force-apply a short/stale busy PTY tail (selected !== native-history) — shrink-defense intact (D6 negative)', () => {
    // D6 negative: the force-apply is strictly gated on selected === 'native-history'.
    // A short PTY tail during generation that would end on an assistant bubble must
    // still be deferred by the shrink-defense; force-apply must NOT fire for it.
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    let nowMs = 1_000_000
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      historySessionId: 'history-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
      fallbackRecentCount: 4,
      now: () => nowMs,
    })

    controller.retain()
    // Hydrate a full tail ending on the user prompt via idle (applies immediately;
    // the on-screen tail lacks an assistant answer), then a generating re-emit to
    // stamp the transition-window clock.
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'q1', id: 'u1', timestamp: 1 } as any,
        { role: 'assistant', content: '─── working ───', id: 'chrome-1', kind: 'tool', timestamp: 2 } as any,
        { role: 'user', content: 'q2 follow-up longer prompt', id: 'u2', timestamp: 3 } as any,
      ],
      status: 'idle',
      totalMessages: 3,
      lastMessageSignature: 'sig-busy-long',
      messageSource: { selected: 'native-history' } as any,
    }))
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'q1', id: 'u1', timestamp: 1 } as any,
        { role: 'assistant', content: '─── working ───', id: 'chrome-1', kind: 'tool', timestamp: 2 } as any,
        { role: 'user', content: 'q2 follow-up longer prompt', id: 'u2', timestamp: 3 } as any,
      ],
      status: 'generating',
      totalMessages: 3,
      lastMessageSignature: 'sig-busy-long',
      messageSource: { selected: 'pty-parser' } as any,
    }))

    // A SHORTER PTY tail arrives during generation ending on an assistant bubble.
    // selected is pty-parser, NOT native-history → force-apply must NOT fire and the
    // busy shrink-defense must defer it (on-screen longer tail preserved).
    nowMs += 1_000
    manager.publish(createUpdate({
      messages: [
        { role: 'assistant', content: 'partial pty answer', id: 'a1', timestamp: 4 } as any,
      ],
      status: 'generating',
      totalMessages: 1,
      lastMessageSignature: 'sig-pty-short',
      messageSource: { selected: 'pty-parser', fallbackReason: 'native_history_empty' } as any,
    }))

    expect(controller.getSnapshot().liveMessages.map(m => (m as any).content)).toEqual([
      'q1',
      '─── working ───',
      'q2 follow-up longer prompt',
    ])
  })

  it('still short-circuits an identical repeat native-history snapshot (no thrash) (D6 no-op)', () => {
    // D6 no-thrash: the force-apply / identity signature must only fire when the
    // assistant is ADDED. An identical repeat native-history [user, assistant]
    // snapshot (no new assistant, already on screen) must still be a no-op — the
    // listener must not be re-emitted.
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
        { role: 'user', content: 'q', id: 'u1', timestamp: 1 } as any,
        { role: 'assistant', content: 'answer', id: 'a1', timestamp: 2 } as any,
      ],
      status: 'idle',
      totalMessages: 2,
      lastMessageSignature: 'sig-answer',
      messageSource: { selected: 'native-history' } as any,
    }))

    const listener = vi.fn()
    controller.subscribe(listener)
    listener.mockClear()

    // Identical repeat — same [user, assistant], assistant already present.
    manager.publish(createUpdate({
      messages: [
        { role: 'user', content: 'q', id: 'u1', timestamp: 1 } as any,
        { role: 'assistant', content: 'answer', id: 'a1', timestamp: 2 } as any,
      ],
      status: 'idle',
      totalMessages: 2,
      lastMessageSignature: 'sig-answer',
      messageSource: { selected: 'native-history' } as any,
    }))

    expect(listener).not.toHaveBeenCalled()
    expect(controller.getSnapshot().liveMessages.map(m => (m as any).content)).toEqual([
      'q',
      'answer',
    ])
  })
})

describe('SessionChatTailController.refreshAuthoritativeTail (D8 web self-heal)', () => {
  function makeController(nowRef: { value: number }) {
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
      now: () => nowRef.value,
    })
    controller.retain()
    return { controller, manager }
  }

  const userOnlyUpdate = () => createUpdate({
    messages: [{ role: 'user', content: 'q', id: 'u1', timestamp: 1 } as any],
    status: 'idle',
    totalMessages: 1,
    lastMessageSignature: 'sig-user-only',
    messageSource: { selected: 'native-history' } as any,
  })

  const userAssistantUpdate = () => createUpdate({
    messages: [
      { role: 'user', content: 'q', id: 'u1', timestamp: 1 } as any,
      { role: 'assistant', content: 'answer', id: 'a1', timestamp: 2 } as any,
    ],
    status: 'idle',
    totalMessages: 2,
    lastMessageSignature: 'sig-answer',
    messageSource: { selected: 'native-history' } as any,
  })

  it('replaces a stale user-only liveMessages with the re-pulled [user, assistant] tail', async () => {
    const nowRef = { value: 1_000 }
    const { controller, manager } = makeController(nowRef)
    // Browser is stranded on a user-only snapshot (the completion push never applied).
    manager.publish(userOnlyUpdate())
    expect(controller.getSnapshot().liveMessages.map(m => (m as any).role)).toEqual(['user'])

    // One-shot re-pull returns the daemon's authoritative [user, assistant] tail.
    const fetcher = vi.fn().mockResolvedValue(userAssistantUpdate())
    await controller.refreshAuthoritativeTail(fetcher, { force: true })

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().liveMessages.map(m => (m as any).role)).toEqual(['user', 'assistant'])
    // No duplicate assistant bubble.
    expect(controller.getSnapshot().liveMessages.map(m => (m as any).content)).toEqual(['q', 'answer'])
  })

  it('debounces near-simultaneous refreshes into a single read_chat (mount+reconnect+focus burst)', async () => {
    const nowRef = { value: 5_000 }
    const { controller, manager } = makeController(nowRef)
    manager.publish(userOnlyUpdate())

    const fetcher = vi.fn().mockResolvedValue(userAssistantUpdate())
    // First (forced, e.g. mount) fires. The next two land within the debounce
    // window (no time advance) and are suppressed.
    await controller.refreshAuthoritativeTail(fetcher, { force: true })
    await controller.refreshAuthoritativeTail(fetcher)
    await controller.refreshAuthoritativeTail(fetcher)

    expect(fetcher).toHaveBeenCalledTimes(1)

    // After the debounce window elapses, a later focus/reconnect re-pull fires again.
    nowRef.value += 1_000
    await controller.refreshAuthoritativeTail(fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not add a duplicate assistant bubble when the re-pull matches the already-applied tail', async () => {
    const nowRef = { value: 9_000 }
    const { controller, manager } = makeController(nowRef)
    manager.publish(userAssistantUpdate())
    const listener = vi.fn()
    controller.subscribe(listener)
    listener.mockClear()

    const fetcher = vi.fn().mockResolvedValue(userAssistantUpdate())
    await controller.refreshAuthoritativeTail(fetcher, { force: true })

    // Identical tail → no-op, no re-emit, no duplicate bubble.
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getSnapshot().liveMessages.map(m => (m as any).content)).toEqual(['q', 'answer'])
  })

  it('leaves the snapshot untouched when the re-pull fails', async () => {
    const nowRef = { value: 12_000 }
    const { controller, manager } = makeController(nowRef)
    manager.publish(userOnlyUpdate())

    const fetcher = vi.fn().mockRejectedValue(new Error('transport down'))
    await controller.refreshAuthoritativeTail(fetcher, { force: true })

    expect(controller.getSnapshot().liveMessages.map(m => (m as any).role)).toEqual(['user'])
  })
})
