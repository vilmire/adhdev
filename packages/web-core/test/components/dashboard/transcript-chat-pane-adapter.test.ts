import { describe, expect, it, vi } from 'vitest'
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  getOrCreateSessionChatTailController,
  resetSessionChatTailControllersForTest,
} from '../../../src/components/dashboard/session-chat-tail-controller'
import { mapTranscriptSnapshotToChatTailUpdate } from '../../../src/components/dashboard/transcript-chat-pane-adapter'

function buildSnapshot(overrides: Partial<ReplicatedTranscriptSnapshotV1> = {}): ReplicatedTranscriptSnapshotV1 {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    historySessionId: null,
    providerType: 'claude-cli',
    providerSessionId: null,
    producerDaemonId: 'daemon-1',
    producerWriterId: 'writer-1',
    producerEpoch: 'epoch-1',
    revision: 1,
    observedAt: '2026-08-30T00:00:00.000Z',
    status: 'idle',
    providerObservedStatus: null,
    title: null,
    activeModal: null,
    activeInteractivePrompt: null,
    turn: null,
    provenance: { messageSource: null, transcriptProvenance: null },
    messages: [],
    terminalMarkers: [],
    coverage: { mode: 'tail', totalMessageCount: 0, returnedMessageCount: 0, omittedBefore: false },
    ...overrides,
  }
}

describe('mapTranscriptSnapshotToChatTailUpdate', () => {
  it('maps identity/messages/status into the SessionChatTailUpdate shape', () => {
    const snapshot = buildSnapshot({
      sessionId: 'session-9',
      historySessionId: 'history-9',
      status: 'generating',
      messages: [
        { role: 'user', kind: 'standard', content: 'hi', receivedAt: 10, timestamp: 10, turnKey: 'turn-1', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
        { role: 'assistant', kind: 'standard', content: 'hello', receivedAt: 20, timestamp: 20, turnKey: 'turn-2', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
      ],
    })

    const update = mapTranscriptSnapshotToChatTailUpdate(snapshot, { subscriptionKey: 'key-1', omittedBefore: false, stale: false })

    expect(update.topic).toBe('session.chat_tail')
    expect(update.sessionId).toBe('session-9')
    expect(update.historySessionId).toBe('history-9')
    expect(update.status).toBe('generating')
    expect(update.transcriptReadSource).toBe('replica')
    expect(update.omittedBefore).toBe(false)
    expect(update.stale).toBe(false)
    expect(update.messages).toHaveLength(2)
    expect(update.messages[0]).toMatchObject({ role: 'user', content: 'hi', bubbleId: 'turn-1' })
    expect(update.messages[1]).toMatchObject({ role: 'assistant', content: 'hello', bubbleId: 'turn-2' })
  })

  it('reconstructs a narrow {selected} messageSource from the allow-listed scalar', () => {
    const snapshot = buildSnapshot({ provenance: { messageSource: 'native-history', transcriptProvenance: null } })
    const update = mapTranscriptSnapshotToChatTailUpdate(snapshot, { subscriptionKey: 'key-1', omittedBefore: false, stale: false })
    expect(update.messageSource).toEqual({ selected: 'native-history' })
  })

  it('omits messageSource entirely when the snapshot carries none', () => {
    const snapshot = buildSnapshot()
    const update = mapTranscriptSnapshotToChatTailUpdate(snapshot, { subscriptionKey: 'key-1', omittedBefore: false, stale: false })
    expect(update.messageSource).toBeUndefined()
  })

  it('maps activeModal 1:1 and leaves activeInteractivePrompt null (cannot round-trip from the allow-list)', () => {
    const snapshot = buildSnapshot({
      activeModal: { message: 'Run this command?', buttons: ['Approve', 'Deny'] },
      activeInteractivePrompt: { message: 'Pick one', options: ['a', 'b'] },
    })
    const update = mapTranscriptSnapshotToChatTailUpdate(snapshot, { subscriptionKey: 'key-1', omittedBefore: false, stale: false })
    expect(update.activeModal).toEqual({ message: 'Run this command?', buttons: ['Approve', 'Deny'] })
    expect(update.activeInteractivePrompt).toBeNull()
  })

  it('carries omittedBefore/stale straight through from the caller', () => {
    const snapshot = buildSnapshot()
    const update = mapTranscriptSnapshotToChatTailUpdate(snapshot, { subscriptionKey: 'key-1', omittedBefore: true, stale: true })
    expect(update.omittedBefore).toBe(true)
    expect(update.stale).toBe(true)
  })
})

describe('SessionChatTailController transcript replica integration', () => {
  it('a replica-mapped update composes with the existing dedup/shrink-defense path via manager.publish', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })
    controller.retain()

    const snapshot = buildSnapshot({
      status: 'idle',
      messages: [
        { role: 'user', kind: 'standard', content: 'hi', receivedAt: 1, timestamp: 1, turnKey: 't1', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
        { role: 'assistant', kind: 'standard', content: 'hello there', receivedAt: 2, timestamp: 2, turnKey: 't2', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
      ],
    })
    const update = mapTranscriptSnapshotToChatTailUpdate(snapshot, {
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      omittedBefore: true,
      stale: false,
    })

    manager.publish(update)

    const result = controller.getSnapshot()
    expect(result.transcriptReadSource).toBe('replica')
    expect(result.omittedBefore).toBe(true)
    expect(result.stale).toBe(false)
    expect(result.liveMessages).toHaveLength(2)
    expect(result.liveMessages[1]).toMatchObject({ role: 'assistant', content: 'hello there' })
  })

  it('a subsequent legacy update resets transcriptReadSource back to legacy and omittedBefore/stale to false', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })
    controller.retain()

    const snapshot = buildSnapshot({
      messages: [
        { role: 'assistant', kind: 'standard', content: 'from replica', receivedAt: 1, timestamp: 1, turnKey: 't1', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
      ],
    })
    manager.publish(mapTranscriptSnapshotToChatTailUpdate(snapshot, {
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      omittedBefore: true,
      stale: false,
    }))
    expect(controller.getSnapshot().transcriptReadSource).toBe('replica')

    manager.publish({
      topic: 'session.chat_tail',
      key: 'daemon:daemon-1:session:session-1',
      sessionId: 'session-1',
      seq: 2,
      timestamp: 2,
      messages: [{ role: 'assistant', content: 'from replica and more', id: 'm1', timestamp: 2 } as any],
      status: 'idle',
    } as any)

    const result = controller.getSnapshot()
    expect(result.transcriptReadSource).toBe('legacy')
    expect(result.omittedBefore).toBe(false)
    expect(result.stale).toBe(false)
  })

  it('reportTranscriptReplicaFallback flips the source label without touching liveMessages', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })
    controller.retain()

    const snapshot = buildSnapshot({
      messages: [
        { role: 'assistant', kind: 'standard', content: 'hi', receivedAt: 1, timestamp: 1, turnKey: 't1', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
      ],
    })
    manager.publish(mapTranscriptSnapshotToChatTailUpdate(snapshot, {
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      omittedBefore: false,
      stale: false,
    }))

    controller.reportTranscriptReplicaFallback('no_complete_revision')

    const result = controller.getSnapshot()
    expect(result.transcriptReadSource).toBe('legacy')
    expect(result.transcriptFallbackReason).toBe('no_complete_revision')
    // liveMessages untouched — never merges two sources by clearing on fallback.
    expect(result.liveMessages).toHaveLength(1)
    expect(result.liveMessages[0]).toMatchObject({ content: 'hi' })
  })
})
