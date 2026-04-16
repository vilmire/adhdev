import { describe, expect, it, vi } from 'vitest'
import type { SessionChatTailUpdate } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  getOrCreateSessionChatTailController,
  resetSessionChatTailControllersForTest,
} from '../../../src/components/dashboard/session-chat-tail-controller'

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
