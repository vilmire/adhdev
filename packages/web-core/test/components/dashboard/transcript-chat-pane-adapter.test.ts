import { describe, expect, it, vi } from 'vitest'
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  getOrCreateSessionChatTailController,
  resetSessionChatTailControllersForTest,
} from '../../../src/components/dashboard/session-chat-tail-controller'
import {
  buildTranscriptReadSourceAttributes,
  mapTranscriptSnapshotToChatTailUpdate,
} from '../../../src/components/dashboard/transcript-chat-pane-adapter'

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
    // `_turnKey` only — `bubbleId` is deliberately NOT populated from turnKey.
    // turnKey is turn-grained, so using it as per-bubble identity collapsed every
    // bubble of one turn onto a single React key (see
    // transcript-adapter-bubble-identity.test.ts).
    expect(update.messages[0]).toMatchObject({ role: 'user', content: 'hi', _turnKey: 'turn-1' })
    expect(update.messages[1]).toMatchObject({ role: 'assistant', content: 'hello', _turnKey: 'turn-2' })
    expect(update.messages[0]).not.toHaveProperty('bubbleId')
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

  it('routes on the caller subscriptionKey — a mismatched key never reaches the controller', () => {
    // Guards the `key: options.subscriptionKey` projection. SubscriptionManager
    // routes strictly on `${topic}:${key}`, so if the adapter stopped carrying
    // the caller's subscriptionKey the update would be published into the void
    // and the pane would silently stay empty forever.
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
        { role: 'assistant', kind: 'standard', content: 'routed', receivedAt: 1, timestamp: 1, turnKey: 't1', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
      ],
    })
    const update = mapTranscriptSnapshotToChatTailUpdate(snapshot, {
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      omittedBefore: false,
      stale: false,
    })
    expect(update.key).toBe('daemon:daemon-1:session:session-1')

    manager.publish(update)
    expect(controller.getSnapshot().liveMessages).toHaveLength(1)

    // Negative half: the same payload under any other key must not land.
    resetSessionChatTailControllersForTest()
    const manager2 = new SubscriptionManager()
    const controller2 = getOrCreateSessionChatTailController({
      manager: manager2,
      sendData: vi.fn().mockReturnValue(true),
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      tailLimit: 60,
    })
    controller2.retain()
    manager2.publish({ ...update, key: 'some-other-key' })
    expect(controller2.getSnapshot().liveMessages).toHaveLength(0)
  })

  it('carries snapshot.sessionId — a wrong/missing sessionId is dropped by the controller identity gate', () => {
    // Guards the `sessionId: snapshot.sessionId` projection. handleUpdate
    // compares the update's sessionId against its own and returns early on a
    // mismatch, so dropping this field routes another session's transcript into
    // this pane (or, if it became undefined, silently disables the guard).
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
      sessionId: 'session-1',
      messages: [
        { role: 'assistant', kind: 'standard', content: 'mine', receivedAt: 1, timestamp: 1, turnKey: 't1', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
      ],
    })
    const update = mapTranscriptSnapshotToChatTailUpdate(snapshot, {
      subscriptionKey: 'daemon:daemon-1:session:session-1',
      omittedBefore: false,
      stale: false,
    })
    expect(update.sessionId).toBe('session-1')
    manager.publish(update)
    expect(controller.getSnapshot().liveMessages).toHaveLength(1)

    // A foreign-session snapshot mapped onto the same subscription key must be
    // rejected by the identity gate rather than overwriting this pane.
    const foreign = mapTranscriptSnapshotToChatTailUpdate(
      buildSnapshot({
        sessionId: 'session-OTHER',
        messages: [
          { role: 'assistant', kind: 'standard', content: 'not mine', receivedAt: 9, timestamp: 9, turnKey: 'tX', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
        ],
      }),
      { subscriptionKey: 'daemon:daemon-1:session:session-1', omittedBefore: false, stale: false },
    )
    manager.publish(foreign)
    expect(controller.getSnapshot().liveMessages).toHaveLength(1)
    expect(controller.getSnapshot().liveMessages[0]).toMatchObject({ content: 'mine' })
  })

  it('carries turnKey→_turnKey and messageSource so the native-history force-apply gate can fire on a shrinking tail', () => {
    // Guards the D6 force-apply path. A native-history [user, assistant] tail
    // that is SHORTER than the rendered busy tail must still be applied.
    //
    // Verified by injection: dropping the mapMessageSource projection makes
    // isNativeHistorySource() false, the gate never fires, and the shrink-
    // defense rejects the corrective tail (3 stale messages instead of 2).
    // messageSource is therefore behaviorally load-bearing here.
    //
    // The turnKey→_turnKey assertion below is a STRUCTURAL guard only. It feeds
    // lastSubstantiveAssistantIdentity, but in this scenario force-apply keys on
    // the role transition alone, so removing it does NOT change the outcome of
    // this particular case — the explicit assertion is what catches that
    // projection. Don't read this test as proving it gates the gate.
    // (Was `bubbleId` until the per-bubble identity fix: turnKey is turn-grained
    // and must never be assigned to a per-bubble field.)
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

    // Busy phase: a long PTY-ish tail ending on the USER prompt (no assistant yet).
    manager.publish(mapTranscriptSnapshotToChatTailUpdate(
      buildSnapshot({
        status: 'generating',
        messages: [
          { role: 'user', kind: 'standard', content: 'q1', receivedAt: 1, timestamp: 1, turnKey: 'u1', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
          { role: 'assistant', kind: 'thought', content: 'thinking', receivedAt: 2, timestamp: 2, turnKey: 'x1', bubbleState: 'partial', senderName: null, toolName: null, streaming: null },
          { role: 'user', kind: 'standard', content: 'q2', receivedAt: 3, timestamp: 3, turnKey: 'u2', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
        ],
      }),
      { subscriptionKey: 'daemon:daemon-1:session:session-1', omittedBefore: false, stale: false },
    ))
    expect(controller.getSnapshot().liveMessages).toHaveLength(3)

    // Corrective native-history tail: SHORTER, but finally carries the answer.
    const corrective = mapTranscriptSnapshotToChatTailUpdate(
      buildSnapshot({
        status: 'generating',
        provenance: { messageSource: 'native-history', transcriptProvenance: null },
        messages: [
          { role: 'user', kind: 'standard', content: 'q2', receivedAt: 3, timestamp: 3, turnKey: 'u2', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
          { role: 'assistant', kind: 'standard', content: 'the answer', receivedAt: 4, timestamp: 4, turnKey: 'a1', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
        ],
      }),
      { subscriptionKey: 'daemon:daemon-1:session:session-1', omittedBefore: false, stale: false },
    )
    // Both projections must be present for the gate to be reachable at all.
    expect(corrective.messageSource).toEqual({ selected: 'native-history' })
    expect(corrective.messages[1]).toMatchObject({ _turnKey: 'a1' })

    manager.publish(corrective)

    const result = controller.getSnapshot()
    expect(result.liveMessages).toHaveLength(2)
    expect(result.liveMessages[1]).toMatchObject({ role: 'assistant', content: 'the answer' })
  })

  it('carries per-message receivedAt/timestamp — a re-emitted same bubble at a later arrival time is not swallowed as a no-op', () => {
    // Guards `mapped.receivedAt` / `mapped.timestamp`. The controller's no-op
    // short-circuit fires only when BOTH buildChatSnapshotSignature AND
    // lastSubstantiveAssistantIdentity match. The latter keys on
    // bubbleId + content length, so to isolate receivedAt the two tails must
    // share turnKey AND content and differ ONLY in arrival time — i.e. the same
    // bubble re-emitted later. receivedAt is then the sole discriminator in
    // buildChatSnapshotSignature; drop the projection and both tails hash
    // identically, the second is suppressed, and the pane keeps the stale
    // timestamp forever.
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

    // Identical bubble identity ('a1') and identical content — arrival time is
    // the ONLY difference between the two tails.
    const tailAt = (receivedAt: number) => mapTranscriptSnapshotToChatTailUpdate(
      buildSnapshot({
        messages: [
          { role: 'assistant', kind: 'standard', content: 'same text', receivedAt, timestamp: receivedAt, turnKey: 'a1', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
        ],
      }),
      { subscriptionKey: 'daemon:daemon-1:session:session-1', omittedBefore: false, stale: false },
    )

    manager.publish(tailAt(100))
    expect(controller.getSnapshot().liveMessages[0]).toMatchObject({ receivedAt: 100 })

    manager.publish(tailAt(200))

    // Behavioral assertion: the later arrival must have been APPLIED, not
    // short-circuited as an unchanged snapshot.
    const result = controller.getSnapshot()
    expect(result.liveMessages).toHaveLength(1)
    expect(result.liveMessages[0]).toMatchObject({ receivedAt: 200, timestamp: 200 })
  })

  it('carries snapshot.revision as seq — the wire ordering field must not silently become undefined', () => {
    // Guards `seq: snapshot.revision`. Every consumer of a chat_tail envelope
    // treats `seq` as the monotonic revision; if the adapter dropped it the
    // field would read `undefined` rather than fail loudly.
    const update = mapTranscriptSnapshotToChatTailUpdate(
      buildSnapshot({ revision: 42 }),
      { subscriptionKey: 'key-1', omittedBefore: false, stale: false },
    )
    expect(update.seq).toBe(42)
    expect(update.seq).not.toBeUndefined()
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

/**
 * (§8 unit 4c) Making the §5.6 read-source decision observable.
 *
 * The field was computed and stored by units 4b/5 but read by NOTHING, so
 * replica and legacy rendered identically — there was no way, short of a
 * debugger, to tell whether the replica lane was feeding the pane or had
 * silently fallen back to legacy. Live verification of the rollout depends
 * entirely on this readout, so it is pinned rather than left to the component.
 */
describe('buildTranscriptReadSourceAttributes (unit 4c)', () => {
  it('always reports the source, so a pane is never unlabelled', () => {
    expect(buildTranscriptReadSourceAttributes({ transcriptReadSource: 'legacy' }))
      .toEqual({ 'data-transcript-read-source': 'legacy' })
    expect(buildTranscriptReadSourceAttributes({ transcriptReadSource: 'replica' }))
      .toEqual({ 'data-transcript-read-source': 'replica' })
  })

  it('★ carries the fallback reason, which is what distinguishes "never tried" from "fell back"', () => {
    expect(buildTranscriptReadSourceAttributes({
      transcriptReadSource: 'legacy',
      transcriptFallbackReason: 'no_node',
    })).toEqual({
      'data-transcript-read-source': 'legacy',
      'data-transcript-fallback-reason': 'no_node',
    })
  })

  it('OMITS the reason when there is none — absence is meaningful, not an empty string', () => {
    const attributes = buildTranscriptReadSourceAttributes({ transcriptReadSource: 'legacy' })
    expect('data-transcript-fallback-reason' in attributes).toBe(false)
  })

  it('flags a stale replica tail (design §5.5), and omits the flag when fresh', () => {
    expect(buildTranscriptReadSourceAttributes({ transcriptReadSource: 'replica', stale: true }))
      .toHaveProperty('data-transcript-stale', 'true')
    expect('data-transcript-stale' in buildTranscriptReadSourceAttributes({
      transcriptReadSource: 'replica',
      stale: false,
    })).toBe(false)
  })

  it('★ accepts a controller snapshot directly, so the pane cannot drift from the controller', () => {
    // Structural: the helper's input must stay assignable from the real
    // snapshot shape, or the pane would need a hand-maintained mapping that
    // could silently stop tracking the controller's own fields.
    const controller = getOrCreateSessionChatTailController({
      manager: new SubscriptionManager(),
      daemonId: 'daemon-attr',
      sessionId: 'session-attr',
      subscriptionKey: 'daemon:daemon-attr:session:session-attr',
      sendData: vi.fn(() => true),
    })
    expect(buildTranscriptReadSourceAttributes(controller.getSnapshot()))
      .toEqual({ 'data-transcript-read-source': 'legacy' })
    resetSessionChatTailControllersForTest()
  })
})
