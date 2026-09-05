/**
 * ★ §8 unit 9 — retiring the legacy `session.chat_tail` PUSH transport, gated on
 * per-session replica health.
 *
 * ── Why the gate is replica health and not the build flag ──────────────────
 * The obvious gate is `isTranscriptWorkerEnabled()`. It is unusable, and this
 * suite exists largely to keep anyone from reintroducing it. That flag is a
 * BROWSER BUILD-TIME boolean — it says the transcript worker was wired into
 * this bundle, not that a daemon is producing revisions. A daemon with no
 * `ADHDEV_SEQSCRIBE_TRANSCRIPT` resolves to `shadow`
 * (`daemon-core/src/seqscribe/transcript-mode.ts:39`), which is the DEFAULT, so
 * "flag on + zero replica content" is the ordinary case, not an edge one.
 * Retiring legacy on that signal deletes the pane's only transport.
 *
 * The lane can also vanish at runtime, long after any flag was read
 * (`onSeqscribeTransport(null)` → `stopTranscriptHost` → `no_node`), which a
 * build-time constant cannot observe at all.
 *
 * So legacy is retired per session, only while a VERIFIED replica snapshot has
 * actually landed, and it is re-armed by any fallback. A shadow daemon, a
 * severed lane and a worker-less bundle are indistinguishable here — all read
 * `replicaHealthy === false`, all keep legacy running.
 *
 * ── What each assertion is worth ──────────────────────────────────────────
 * The subscription is observed through `sendData`, which receives the real
 * `subscribe`/`unsubscribe` wire frames the SubscriptionManager emits. Asserting
 * on those frames (rather than on an internal field) is what makes "legacy is
 * actually running / actually stopped" a claim about the transport instead of
 * about bookkeeping.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  getOrCreateSessionChatTailController,
  resetSessionChatTailControllersForTest,
} from '../../../src/components/dashboard/session-chat-tail-controller'

const DAEMON = 'daemon-1'
const SESSION = 'session-1'
const SUBSCRIPTION_KEY = `daemon:${DAEMON}:session:${SESSION}`

function snapshot(overrides: Partial<ReplicatedTranscriptSnapshotV1> = {}): ReplicatedTranscriptSnapshotV1 {
  return {
    schemaVersion: 1,
    sessionId: SESSION,
    historySessionId: null,
    providerType: 'claude-cli',
    providerSessionId: null,
    producerDaemonId: DAEMON,
    producerWriterId: 'writer-1',
    producerEpoch: 'epoch-1',
    revision: 1,
    observedAt: '2026-09-05T00:00:00.000Z',
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

function message(
  role: 'user' | 'assistant',
  content: string,
  receivedAt: number,
): ReplicatedTranscriptSnapshotV1['messages'][number] {
  return {
    role,
    kind: 'standard',
    content,
    receivedAt,
    timestamp: receivedAt,
    turnKey: `${role}-${receivedAt}`,
    bubbleState: 'final',
    senderName: null,
    toolName: null,
    streaming: null,
  } as ReplicatedTranscriptSnapshotV1['messages'][number]
}

/** A replica snapshot that carries real content — enough to mark the lane healthy. */
function healthySnapshot(revision: number, ...contents: string[]) {
  return snapshot({
    revision,
    messages: contents.map((c, i) => message(i % 2 === 0 ? 'user' : 'assistant', c, 10 + i)),
  })
}

function setup() {
  resetSessionChatTailControllersForTest()
  const manager = new SubscriptionManager()
  const sendData = vi.fn().mockReturnValue(true)
  const controller = getOrCreateSessionChatTailController({
    manager,
    sendData,
    daemonId: DAEMON,
    sessionId: SESSION,
    subscriptionKey: SUBSCRIPTION_KEY,
    tailLimit: 60,
  })
  return { manager, sendData, controller }
}

/** The wire frames actually emitted, in order. */
function frames(sendData: ReturnType<typeof vi.fn>): Array<{ type: string; topic?: string }> {
  return sendData.mock.calls.map((call) => call[1] as { type: string; topic?: string })
}

function subscribeFrames(sendData: ReturnType<typeof vi.fn>) {
  return frames(sendData).filter((f) => f.type === 'subscribe' && f.topic === 'session.chat_tail')
}

function unsubscribeFrames(sendData: ReturnType<typeof vi.fn>) {
  return frames(sendData).filter((f) => f.type === 'unsubscribe')
}

/** Publish a legacy `session.chat_tail` update through the production path. */
function publishLegacy(manager: SubscriptionManager, seq: number, contents: string[]) {
  manager.publish({
    topic: 'session.chat_tail',
    key: SUBSCRIPTION_KEY,
    sessionId: SESSION,
    seq,
    timestamp: 0,
    status: 'idle',
    messages: contents.map((content, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      kind: 'standard',
      content,
      receivedAt: i + 1,
      timestamp: i + 1,
    })),
  } as never)
}

// ───────────────────────────────────────────────────────────────────────────
// ① ★ THE PRODUCTION-SAFETY ASSERTION — an empty pane must be impossible.
//
// This is the case that a build-flag gate would have broken, and it is the one
// that matters most: the overwhelming majority of sessions in the fleet talk to
// a `shadow`-mode daemon and will NEVER receive a replica snapshot.
// ───────────────────────────────────────────────────────────────────────────
describe('★ unit 9 ①: a session that never sees a replica keeps legacy fully intact', () => {
  it('subscribes to legacy on retain when no replica has ever arrived', () => {
    const { sendData, controller } = setup()
    controller.retain()

    // The real subscribe frame went out — legacy is genuinely running, not
    // merely "not disabled".
    expect(subscribeFrames(sendData)).toHaveLength(1)
    expect(unsubscribeFrames(sendData)).toHaveLength(0)
  })

  it('★ renders legacy content with NO replica in play — the anti-empty-pane assertion', () => {
    const { manager, controller } = setup()
    controller.retain()

    publishLegacy(manager, 1, ['legacy question', 'legacy answer'])

    // ★ If unit 9 ever retires legacy unconditionally (or on a build flag),
    // this is the assertion that goes red: the pane would be empty.
    const after = controller.getSnapshot()
    expect(after.liveMessages).toHaveLength(2)
    expect(after.liveMessages.map((m) => m.content)).toEqual(['legacy question', 'legacy answer'])
    expect(after.transcriptReadSource).toBe('legacy')
  })

  it('★ keeps DELIVERING new legacy updates indefinitely — not merely holding the first one', () => {
    const { manager, controller } = setup()
    controller.retain()

    publishLegacy(manager, 1, ['q1', 'a1'])
    publishLegacy(manager, 2, ['q1', 'a1', 'q2', 'a2'])
    publishLegacy(manager, 3, ['q1', 'a1', 'q2', 'a2', 'q3', 'a3'])

    // A frozen-but-populated pane passes a single-update assertion. Only a
    // sequence proves the transport is still live.
    const after = controller.getSnapshot()
    expect(after.liveMessages).toHaveLength(6)
    expect(after.liveMessages.map((m) => m.content)).toContain('a3')
  })

  it('a structurally-invalid replica snapshot does NOT retire legacy', () => {
    const { sendData, manager, controller } = setup()
    controller.retain()
    publishLegacy(manager, 1, ['legacy question', 'legacy answer'])

    // The 9-pre-c refusal path: a snapshot missing `activeModal` is refused and
    // reported as a fallback. It must not count as replica health.
    const broken = { ...snapshot({ status: 'waiting_approval', revision: 2 }) } as Record<string, unknown>
    delete broken.activeModal
    controller.applyTranscriptReplicaSnapshot(broken as unknown as ReplicatedTranscriptSnapshotV1, {
      omittedBefore: false,
    })

    // Legacy never unsubscribed, and still delivers.
    expect(unsubscribeFrames(sendData)).toHaveLength(0)
    publishLegacy(manager, 2, ['legacy question', 'legacy answer', 'still arriving'])
    expect(controller.getSnapshot().liveMessages.map((m) => m.content)).toContain('still arriving')
    expect(controller.getSnapshot().transcriptFallbackReason).toBe('revision_invalid')
  })

  it('★ a disposed-then-retained controller re-arms legacy (health is not carried across dispose)', () => {
    const { sendData, controller } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'replica answer'), { omittedBefore: false })
    expect(unsubscribeFrames(sendData)).toHaveLength(1)

    // The registry recycles controllers by key, and the replica worker host does
    // NOT survive disposal. If health leaked across dispose, this controller
    // would come back with legacy suppressed and nothing feeding it.
    controller.dispose()
    sendData.mockClear()
    controller.retain()

    expect(subscribeFrames(sendData)).toHaveLength(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ② ★ RE-ARM — any fallback brings legacy straight back.
// ───────────────────────────────────────────────────────────────────────────
describe('★ unit 9 ②: any replica fallback re-arms the legacy transport', () => {
  const REASONS = [
    'authority_unavailable',
    'topic_not_granted',
    'no_complete_revision',
    'projection_oversize',
    'no_node',
    'revision_invalid',
  ] as const

  for (const reason of REASONS) {
    it(`${reason}: legacy resubscribes and delivers again`, () => {
      const { sendData, manager, controller } = setup()
      controller.retain()

      // Healthy replica → legacy stands down.
      controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'replica answer'), { omittedBefore: false })
      expect(unsubscribeFrames(sendData)).toHaveLength(1)
      expect(controller.getSnapshot().transcriptReadSource).toBe('replica')

      sendData.mockClear()
      controller.reportTranscriptReplicaFallback(reason)

      // ★ A real resubscribe frame — the transport is back on the wire.
      expect(subscribeFrames(sendData)).toHaveLength(1)
      expect(controller.getSnapshot().transcriptReadSource).toBe('legacy')
      expect(controller.getSnapshot().transcriptFallbackReason).toBe(reason)

      // ★ And it actually carries data again. This is the anti-frozen half:
      // resubscribing without delivering would still leave a dead pane.
      publishLegacy(manager, 9, ['recovered question', 'recovered answer'])
      expect(controller.getSnapshot().liveMessages.map((m) => m.content)).toContain('recovered answer')
    })
  }

  /**
   * ★ The dedup guard in `reportTranscriptReplicaFallback` returns early when
   * the pane is ALREADY labelled `legacy` with this same reason. If the re-arm
   * were placed behind that guard, this exact sequence would strand the pane:
   *
   *   1. fallback `no_node`     → label legacy/no_node, legacy resubscribes
   *   2. replica recovers       → legacy stands down (label back to replica)
   *   3. fallback `no_node`     → ★ label is legacy/no_node from step 1 only if
   *                               it were never relabelled … it WAS relabelled
   *                               in step 2, so the guard does not fire here.
   *
   * A plain "report the same reason twice" does NOT reach it: the first report
   * relabels the pane, so by the second one the transport is already back.
   *
   * The reachable case is a DEFERRED replica snapshot. `handleUpdate` may
   * decline to apply an update (shrink defense on an active session) — the
   * label then stays `legacy` with the previous reason while the lane is
   * demonstrably alive, so `replicaHealthy` flips true and legacy stands down.
   * The pane is now: label `legacy/no_node`, legacy transport OFF. If the
   * re-arm sat behind the dedup guard, the next `no_node` would return early
   * and the pane would be stranded with no transport at all — the exact silent
   * freeze this unit must not introduce.
   */
  it('★ a fallback after a DEFERRED replica snapshot still re-arms (dedup must not skip the re-arm)', () => {
    const { sendData, manager, controller } = setup()
    controller.retain()

    // Put the pane on a generating session with a healthy tail, so the shrink
    // defense is armed for what follows.
    publishLegacy(manager, 1, ['q1', 'a1', 'q2', 'a2'])
    manager.publish({
      topic: 'session.chat_tail',
      key: SUBSCRIPTION_KEY,
      sessionId: SESSION,
      seq: 2,
      timestamp: 0,
      status: 'generating',
      messages: [
        { role: 'user', kind: 'standard', content: 'q1', receivedAt: 1, timestamp: 1 },
        { role: 'assistant', kind: 'standard', content: 'a1', receivedAt: 2, timestamp: 2 },
        { role: 'user', kind: 'standard', content: 'q2', receivedAt: 3, timestamp: 3 },
        { role: 'assistant', kind: 'standard', content: 'a2', receivedAt: 4, timestamp: 4 },
      ],
    } as never)

    // First fallback — label becomes legacy/no_node.
    controller.reportTranscriptReplicaFallback('no_node')
    expect(controller.getSnapshot().transcriptFallbackReason).toBe('no_node')

    // A replica snapshot arrives but SHRINKS the tail on an active session, so
    // `handleUpdate` defers it: the label stays legacy/no_node, yet the lane is
    // alive so legacy stands down.
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(9, 'only one message'), { omittedBefore: false })
    expect(controller.getSnapshot().transcriptReadSource).toBe('legacy')
    expect(controller.getSnapshot().transcriptFallbackReason).toBe('no_node')

    sendData.mockClear()

    // ★ The same reason returns. The dedup guard fires here; the re-arm must
    // already have happened, or this pane has no transport at all.
    controller.reportTranscriptReplicaFallback('no_node')

    publishLegacy(manager, 3, ['q1', 'a1', 'q2', 'a2', 'delivered after the stranding window'])
    expect(controller.getSnapshot().liveMessages.map((m) => m.content)).toContain(
      'delivered after the stranding window',
    )
  })

  it('recovery is not one-way: replica → legacy → replica → legacy all re-arm correctly', () => {
    const { sendData, manager, controller } = setup()
    controller.retain()

    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'replica one'), { omittedBefore: false })
    controller.reportTranscriptReplicaFallback('no_node')
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(3, 'r1', 'replica two'), { omittedBefore: false })
    expect(controller.getSnapshot().transcriptReadSource).toBe('replica')

    sendData.mockClear()
    controller.reportTranscriptReplicaFallback('no_complete_revision')
    expect(subscribeFrames(sendData)).toHaveLength(1)

    publishLegacy(manager, 7, ['final legacy delivery'])
    expect(controller.getSnapshot().liveMessages.map((m) => m.content)).toContain('final legacy delivery')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ③ TARGET — legacy really is retired while the replica is healthy.
//
// Without this the whole change would be a no-op that still passes ① and ②.
// ───────────────────────────────────────────────────────────────────────────
describe('★ unit 9 ③: a healthy replica session stops running legacy', () => {
  it('unsubscribes from legacy once a verified replica snapshot lands', () => {
    const { sendData, controller } = setup()
    controller.retain()
    expect(subscribeFrames(sendData)).toHaveLength(1)

    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'replica answer'), { omittedBefore: false })

    expect(unsubscribeFrames(sendData)).toHaveLength(1)
    expect(controller.getSnapshot().transcriptReadSource).toBe('replica')
    expect(controller.getSnapshot().liveMessages.map((m) => m.content)).toContain('replica answer')
  })

  it('★ retaining again does NOT resubscribe legacy while the replica is healthy', () => {
    const { sendData, controller } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'replica answer'), { omittedBefore: false })

    sendData.mockClear()
    controller.retain()

    // `retain()` calls connect() directly — the gate has to hold there too.
    expect(subscribeFrames(sendData)).toHaveLength(0)
  })

  it('further replica snapshots do not churn the subscription', () => {
    const { sendData, controller } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'a'), { omittedBefore: false })
    sendData.mockClear()

    controller.applyTranscriptReplicaSnapshot(healthySnapshot(3, 'a', 'b'), { omittedBefore: false })
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(4, 'a', 'b', 'c'), { omittedBefore: false })

    expect(frames(sendData)).toHaveLength(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ④ §5.6 keeps `read_chat` and `chat_history` — unit 9 removes the PUSH
// transport only.
// ───────────────────────────────────────────────────────────────────────────
describe('★ unit 9 ④: read_chat and chat_history survive on a retired session', () => {
  it('the one-shot read_chat self-heal still applies while the replica is healthy', async () => {
    const { controller } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'replica answer'), { omittedBefore: false })

    // §5.6: "제거 후에도 seqscribe unavailable/oversize 시 one-shot/on-demand
    // legacy `read_chat` fallback은 남긴다." It does not travel over the
    // subscription, so retiring the push transport must not disarm it.
    await controller.refreshAuthoritativeTail(async () => ({
      topic: 'session.chat_tail',
      key: SUBSCRIPTION_KEY,
      sessionId: SESSION,
      seq: 0,
      timestamp: 0,
      status: 'idle',
      messages: [
        { role: 'user', kind: 'standard', content: 'q', receivedAt: 1, timestamp: 1 },
        { role: 'assistant', kind: 'standard', content: 'repulled answer', receivedAt: 2, timestamp: 2 },
      ],
    }) as never)

    expect(controller.getSnapshot().liveMessages.map((m) => m.content)).toContain('repulled answer')
  })

  it('`Load older` (chat_history) is unaffected on a retired session', async () => {
    const { controller } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'live one', 'live two'), { omittedBefore: false })

    const loader = vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'older question', id: 'h1', timestamp: 1 },
        { role: 'assistant', content: 'older answer', id: 'h2', timestamp: 2 },
      ],
      hasMore: false,
    })

    await controller.loadHistoryPage(loader)

    expect(loader).toHaveBeenCalledTimes(1)
    const after = controller.getSnapshot()
    expect(after.historyMessages.map((m) => m.content)).toEqual(['older question', 'older answer'])
    expect(after.hasMoreHistory).toBe(false)
  })
})
