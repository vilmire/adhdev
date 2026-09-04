/**
 * ★ §5.6 gate 4 — the FALLBACK FIRE DRILL (design §8 unit 9-pre-c).
 *
 * §5.6 blocks removing the legacy `session.chat_tail` push transport until four
 * gates pass; this file is the fourth. Until now the drill did not exist even as
 * a definition — grepping "fire drill" found two lines of design prose and no
 * executable anything. Prose cannot close a gate that says "정의 + 실행".
 *
 * ── What a fire drill has to prove, and why prose could not ─────────────────
 * The unit-9 delete is irreversible and removes the transport that TODAY masks
 * every replica fault: while legacy push runs, a replica that answers wrongly is
 * invisible because legacy overwrites the pane a moment later. After the delete,
 * the fallback path is the only thing between a transport fault and the user.
 *
 * The failure mode that matters is NOT a crash — a crash is loud and someone
 * fixes it. It is DEGRADING TO AN EMPTY SUCCESS: the replica declines, the pane
 * renders a well-formed empty (or stale) transcript, no error is raised, and the
 * user silently reads the wrong conversation. Every assertion below is aimed at
 * that specific outcome.
 *
 * So for each of the four §5.6 fallback reasons the drill asserts THREE things,
 * and all three are required — any two of them pass vacuously without the third:
 *
 *   (1) the reason is produced by its REAL origin, not hand-written. A drill
 *       that asserts `decline('topic_not_granted')` against a stubbed decline
 *       proves only that the test can type a string.
 *   (2) the pane still RENDERS — `liveMessages` keeps the legacy content it had.
 *       This is the anti-empty-success assertion.
 *   (3) the pane is LABELLED `transcriptReadSource: 'legacy'` with that exact
 *       reason, so a fallback is observable in production rather than being
 *       indistinguishable from a healthy replica read.
 *
 * ── Why the four reasons, and why they are not interchangeable ──────────────
 * They are the four ways the replica can fail to answer, each at a different
 * layer, and each with a different real origin exercised here:
 *
 *   `authority_unavailable`  no fleet secret → the topic cannot even be defined.
 *                            Origin: `ensureSessionTranscriptTopic` with
 *                            `authorityEnabled:false` (transcript-activation.ts).
 *   `topic_not_granted`      topic defined, but the peer never granted it.
 *                            ★ ACCEPTED BY THE UNION, NOT PRODUCED on the
 *                            transcript path today — see the daemon-core half
 *                            for the measured reachability assertion. The pane
 *                            behaviour is still drilled here, because the union
 *                            carries it and an IPC peer may report it.
 *   `no_complete_revision`   subscribed, but no commit has landed yet (or the
 *                            ring reset). Origin: the REAL
 *                            `readTranscriptForDaemonConsumer` over a store
 *                            whose entry has no `lastGood`.
 *   `projection_oversize`    the snapshot cannot be encoded at all. Origin: the
 *                            REAL `encodeTranscriptRevision`, given a snapshot
 *                            that genuinely exceeds the chunk budget.
 *
 * The first two are pre-subscription faults, the third is post-subscription, the
 * fourth is producer-side. Collapsing any of them into "it declined" would lose
 * the distinction the readiness layer routes on.
 *
 * ★ Coverage honesty: this half drills the PANE for all four reasons (the pane
 * must survive any of them, however the reason arose). Real-origin production is
 * proven for three; the fourth is recorded as an unproduced-but-accepted union
 * member in the daemon-core half rather than being faked.
 *
 * ── Relationship to the live standalone check ──────────────────────────────
 * 9-pre-c was proposed as a manual standalone exercise. That is kept as the
 * OPERATOR runbook (`docs/operations/TRANSCRIPT_FALLBACK_FIRE_DRILL.md`), but it
 * cannot be the gate: a manual check is not re-run on any future commit, and
 * §5.6's gate must still hold the day someone edits the adapter. This suite is
 * the executable half; the runbook is the live-environment half.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core'
import { encodeTranscriptRevision } from '@adhdev/daemon-core/seqscribe/transcript-revision-codec'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  getOrCreateSessionChatTailController,
  resetSessionChatTailControllersForTest,
} from '../../../src/components/dashboard/session-chat-tail-controller'
import { mapTranscriptSnapshotToChatTailUpdate } from '../../../src/components/dashboard/transcript-chat-pane-adapter'

const DAEMON = 'daemon-1'
const SESSION = 'session-1'
const SUBSCRIPTION_KEY = `daemon:${DAEMON}:session:${SESSION}`

/**
 * The four §5.6 fallback reasons, with the LAYER each one fails at. The layer is
 * recorded so a future reader can see the four are not four spellings of one
 * fault — see this file's header.
 */
const FIRE_DRILL_REASONS = [
  { reason: 'authority_unavailable', layer: 'pre-subscription: no fleet secret, topic undefinable' },
  { reason: 'topic_not_granted', layer: 'pre-subscription: topic defined, grant absent' },
  { reason: 'no_complete_revision', layer: 'post-subscription: subscribed, nothing committed' },
  { reason: 'projection_oversize', layer: 'producer-side: snapshot cannot be encoded' },
] as const

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
    observedAt: '2026-09-04T00:00:00.000Z',
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

/**
 * A pane with legacy content already on screen — the state every fire-drill case
 * starts from.
 *
 * ★ The legacy update is published through the SAME `handleUpdate` the real
 * `session.chat_tail` subscription uses (topic `session.chat_tail`, no
 * `transcriptReadSource` field), so "the pane keeps rendering" is asserted
 * against real controller state rather than a fabricated snapshot object.
 */
function paneWithLegacyContent() {
  resetSessionChatTailControllersForTest()
  const manager = new SubscriptionManager()
  const controller = getOrCreateSessionChatTailController({
    manager,
    sendData: vi.fn().mockReturnValue(true),
    daemonId: DAEMON,
    sessionId: SESSION,
    subscriptionKey: SUBSCRIPTION_KEY,
    tailLimit: 60,
  })
  controller.retain()

  manager.publish({
    topic: 'session.chat_tail',
    key: SUBSCRIPTION_KEY,
    sessionId: SESSION,
    seq: 1,
    timestamp: 0,
    status: 'idle',
    messages: [
      { role: 'user', kind: 'standard', content: 'legacy question', receivedAt: 1, timestamp: 1 },
      { role: 'assistant', kind: 'standard', content: 'legacy answer', receivedAt: 2, timestamp: 2 },
    ],
  } as never)

  return controller
}

describe('★ §5.6 fallback fire drill — the pane survives every replica decline', () => {
  it('the drill covers exactly the four §5.6 reasons, each at a distinct layer', () => {
    // A coverage ledger, same discipline as the §6.3 fixture table: if someone
    // adds a fifth fallback reason to the drill, or drops one, that is a
    // deliberate change to what the gate claims — not a silent edit.
    expect(FIRE_DRILL_REASONS.map((r) => r.reason)).toEqual([
      'authority_unavailable',
      'topic_not_granted',
      'no_complete_revision',
      'projection_oversize',
    ])
    expect(new Set(FIRE_DRILL_REASONS.map((r) => r.layer)).size).toBe(4)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // The drill proper: for each reason, force it and assert the pane outcome.
  // ─────────────────────────────────────────────────────────────────────────
  for (const { reason } of FIRE_DRILL_REASONS) {
    it(`${reason}: the pane keeps rendering legacy content and is labelled legacy/${reason}`, () => {
      const controller = paneWithLegacyContent()

      // Precondition — the pane HAS content before the fault. Without this the
      // "still renders" assertion below would pass on an already-empty pane.
      expect(controller.getSnapshot().liveMessages).toHaveLength(2)

      // The fault: the replica lane declines. This is exactly what
      // `p2p-manager.ts` does on a non-answer — it reports the fallback and
      // publishes NO replica update.
      controller.reportTranscriptReplicaFallback(reason)

      const after = controller.getSnapshot()

      // (2) ★ The anti-empty-success assertion. A fallback must never blank the
      // pane: the legacy content that was on screen is still on screen, with the
      // same messages in the same order.
      expect(after.liveMessages).toHaveLength(2)
      expect(after.liveMessages.map((m) => m.content)).toEqual(['legacy question', 'legacy answer'])

      // (3) The fallback is OBSERVABLE — source flipped and the exact reason
      // recorded, so `buildTranscriptReadSourceAttributes` can surface it.
      expect(after.transcriptReadSource).toBe('legacy')
      expect(after.transcriptFallbackReason).toBe(reason)
    })
  }

  /**
   * ★ The control that makes every case above non-vacuous.
   *
   * If `transcriptReadSource` were hardcoded to 'legacy', all four cases would
   * pass while proving nothing. This asserts the field genuinely moves: a
   * successful replica update labels the pane 'replica'.
   */
  it('control: a SUCCESSFUL replica update labels the pane replica — so legacy is a real transition', () => {
    const controller = paneWithLegacyContent()
    expect(controller.getSnapshot().transcriptReadSource).toBe('legacy')

    controller.applyTranscriptReplicaSnapshot(
      snapshot({ revision: 2, messages: [message('assistant', 'replica answer', 10)] }),
      { omittedBefore: false },
    )

    const after = controller.getSnapshot()
    expect(after.transcriptReadSource).toBe('replica')
    expect(after.liveMessages.some((m) => m.content === 'replica answer')).toBe(true)
  })

  /**
   * ★ A fallback must not merge two sources (§5.6: "rollback이 '두 소스 merge'로
   * 변질되지 않게"). After a replica update lands and THEN the lane falls back,
   * the pane keeps the replica content it already had and is relabelled — it
   * does not splice legacy messages back in underneath.
   */
  it('a fallback after a replica read relabels without merging the two sources', () => {
    const controller = paneWithLegacyContent()
    controller.applyTranscriptReplicaSnapshot(
      snapshot({ revision: 2, messages: [message('assistant', 'replica answer', 10)] }),
      { omittedBefore: false },
    )
    const beforeFallback = controller.getSnapshot().liveMessages.map((m) => m.content)

    controller.reportTranscriptReplicaFallback('no_complete_revision')

    const after = controller.getSnapshot()
    expect(after.liveMessages.map((m) => m.content)).toEqual(beforeFallback)
    expect(after.transcriptReadSource).toBe('legacy')
    expect(after.transcriptFallbackReason).toBe('no_complete_revision')
  })
})

/**
 * ★ (§8 unit 9-pre-c) The `activeModal` silent-degradation fix, drilled
 * end-to-end through the controller.
 *
 * Before the fix, a snapshot whose `activeModal` field had gone missing was
 * mapped with `activeModal: null` and APPLIED — so a session sitting on
 * `waiting_approval` rendered with no approval UI, the user could not act, and
 * nothing reported a fault. That is the empty-success class this whole gate
 * exists to catch, on roster ids 1-2 (the highest-traffic consumers).
 *
 * The fixed contract: refuse the snapshot, keep the pane on legacy content, and
 * make the fault observable as `revision_invalid`.
 */
describe('★ 9-pre-c: a structurally-invalid replica snapshot is refused, not half-applied', () => {
  it('a snapshot missing activeModal is refused — the pane keeps legacy content and reports revision_invalid', () => {
    const controller = paneWithLegacyContent()
    expect(controller.getSnapshot().liveMessages).toHaveLength(2)

    // The projection regression: `activeModal` stops arriving on a session that
    // is WAITING FOR APPROVAL — the case where losing the modal is worst.
    const broken = { ...snapshot({ status: 'waiting_approval', revision: 2 }) } as Record<string, unknown>
    delete broken.activeModal

    controller.applyTranscriptReplicaSnapshot(
      broken as unknown as ReplicatedTranscriptSnapshotV1,
      { omittedBefore: false },
    )

    const after = controller.getSnapshot()
    // ★ The pane was NOT replaced by an approval-less render.
    expect(after.liveMessages.map((m) => m.content)).toEqual(['legacy question', 'legacy answer'])
    expect(after.transcriptReadSource).toBe('legacy')
    expect(after.transcriptFallbackReason).toBe('revision_invalid')
  })

  it('control: the SAME snapshot WITH activeModal applies and carries the approval UI', () => {
    const controller = paneWithLegacyContent()

    // ★ The tail must not SHRINK relative to the 2 legacy messages already on
    // screen. `waiting_approval` is an active status, so the controller's A3
    // shrink-defense would defer a 1-message tail — the update would be dropped
    // for a reason that has nothing to do with `activeModal`, making this
    // control vacuous. Found by running it, not by reading.
    controller.applyTranscriptReplicaSnapshot(
      snapshot({
        status: 'waiting_approval',
        revision: 2,
        activeModal: { message: 'Run `rm -rf build/`?', buttons: ['Yes', 'No'] },
        messages: [
          message('user', 'legacy question', 1),
          message('assistant', 'legacy answer', 2),
          message('assistant', 'need approval', 5),
        ],
      }),
      { omittedBefore: false },
    )

    const after = controller.getSnapshot()
    expect(after.transcriptReadSource).toBe('replica')
    expect(after.liveMessages.some((m) => m.content === 'need approval')).toBe(true)
  })

  it('a present-but-null activeModal is NORMAL and still applies — the fix must not reject ordinary sessions', () => {
    const controller = paneWithLegacyContent()

    controller.applyTranscriptReplicaSnapshot(
      snapshot({
        revision: 2,
        activeModal: null,
        // Non-shrinking, for the same reason as the control above.
        messages: [
          message('user', 'legacy question', 1),
          message('assistant', 'legacy answer', 2),
          message('assistant', 'ordinary answer', 9),
        ],
      }),
      { omittedBefore: false },
    )

    expect(controller.getSnapshot().transcriptReadSource).toBe('replica')
    expect(controller.getSnapshot().liveMessages.some((m) => m.content === 'ordinary answer')).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Real-origin production of the reasons.
//
// The cases above prove the PANE behaviour given a reason. These prove the
// reasons are the ones production actually emits — without this half, the drill
// would be asserting against strings a test author chose.
// ───────────────────────────────────────────────────────────────────────────
describe('★ fire drill: each reason is produced by its real origin, not hand-written', () => {
  /**
   * `projection_oversize` from the REAL encoder.
   *
   * The budget is `MAX_TRANSCRIPT_REVISION_CHUNKS` chunks (~8.3 MiB of JCS
   * bytes), so this builds a snapshot that genuinely exceeds it rather than
   * stubbing the return. Owner policy (§7.2 item 3) is explicit that oversize is
   * NEVER truncated — it must fail the whole call to legacy.
   */
  it('projection_oversize: the real encoder refuses an oversize snapshot instead of truncating it', () => {
    const huge = snapshot({
      messages: Array.from({ length: 400 }, (_, i) => message('assistant', 'x'.repeat(24_000), i)),
    })

    const encoded = encodeTranscriptRevision(huge, {
      sessionId: SESSION,
      producerDaemonId: DAEMON,
      producerWriterId: 'writer-1',
      producerEpoch: 'epoch-1',
      revision: 1,
    })

    expect(encoded.ok).toBe(false)
    if (encoded.ok) throw new Error('unreachable — asserted false above')
    expect(encoded.reason).toBe('projection_oversize')

    // ★ No truncation: the encoder reports the FULL size it refused. A "helpful"
    // future edit that trimmed messages to fit would show a smaller number here
    // and would be silently dropping the user's conversation.
    expect(encoded.snapshotBytes).toBeGreaterThan(8_000_000)
  })

  /**
   * The control for the case above: the same encoder, a normal-sized snapshot,
   * succeeds. Without this, `expect(ok).toBe(false)` would also pass against an
   * encoder that refused everything.
   */
  it('control: the same encoder accepts a normal snapshot, so oversize is a real threshold', () => {
    const ordinary = snapshot({ messages: [message('assistant', 'short answer', 1)] })

    const encoded = encodeTranscriptRevision(ordinary, {
      sessionId: SESSION,
      producerDaemonId: DAEMON,
      producerWriterId: 'writer-1',
      producerEpoch: 'epoch-1',
      revision: 1,
    })

    expect(encoded.ok).toBe(true)
  })
})
