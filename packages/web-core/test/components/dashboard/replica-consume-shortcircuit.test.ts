/**
 * ★ Consume-path short-circuits: performance only, behaviour identical.
 *
 * Three optimizations landed on the browser consume path, each of which
 * REPLACES WORK WHOSE OUTCOME IS ALREADY DETERMINED and must therefore be
 * indistinguishable from the unoptimized path in every observable respect:
 *
 *   ① codec re-decode short-circuit — a commit whose `snapshotSha256` equals
 *      the hash of the complete revision already held skips
 *      concat → UTF-8 → SHA-256 → JSON.parse and returns the held snapshot.
 *   ② controller map-skip — a re-delivered identical snapshot skips the O(N)
 *      `mapTranscriptSnapshotToChatTailUpdate` allocation.
 *   ③ fan-out sharing — the pane controller and the warm inbox controller
 *      receive ONE mapping instead of computing it twice.
 *
 * ── What these tests are actually for ──────────────────────────────────────
 * The risk in ② is not the skip, it is the SIDE EFFECTS the skipped path used
 * to perform. `handleUpdate` stamps liveness (`lastInboundAt`,
 * `lastKnownStatus`, `lastActiveStatusAt`) BEFORE deciding to apply or discard,
 * deliberately: a stream of correctly-discarded no-op updates is still proof
 * the lane is alive, and dropping those stamps would convert a healthy
 * frozen-but-alive lane into a watchdog re-pull storm. So the interesting
 * assertions below are not "the result is the same" but "the CLOCKS moved the
 * same" — §④.
 *
 * The injection check (§⑤) is the gate-authoring requirement: disabling a
 * short-circuit must break only a performance claim, never a correctness one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core'
import {
  TranscriptRevisionAssembler,
  encodeTranscriptRevision,
  type TranscriptRevisionIdentity,
  type TranscriptRevisionRow,
} from '@adhdev/daemon-core/seqscribe/transcript-revision-codec'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  applyTranscriptReplicaSnapshotToControllers,
  getOrCreateSessionChatTailController,
  resetSessionChatTailControllersForTest,
} from '../../../src/components/dashboard/session-chat-tail-controller'

const DAEMON = 'daemon-1'
const SESSION = 'session-1'
const SUBSCRIPTION_KEY = `daemon:${DAEMON}:session:${SESSION}`

const IDENTITY: TranscriptRevisionIdentity = {
  sessionId: SESSION,
  producerDaemonId: DAEMON,
  producerWriterId: 'writer-1',
  producerEpoch: 'epoch-1',
  revision: 7,
}

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
    revision: 7,
    observedAt: '2026-09-06T00:00:00.000Z',
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
  } as ReplicatedTranscriptSnapshotV1
}

function message(role: 'user' | 'assistant', content: string, receivedAt: number) {
  return {
    role,
    kind: 'standard',
    content,
    receivedAt,
    timestamp: receivedAt,
    turnKey: `${role}-${receivedAt}`,
    sequence: receivedAt,
    bubbleState: 'final',
    senderName: null,
    toolName: null,
    streaming: null,
  } as ReplicatedTranscriptSnapshotV1['messages'][number]
}

function withMessages(revision: number, status: string, ...contents: string[]) {
  return snapshot({
    revision,
    status: status as ReplicatedTranscriptSnapshotV1['status'],
    messages: contents.map((c, i) => message(i % 2 === 0 ? 'user' : 'assistant', c, 10 + i)),
  })
}

/** Encode a snapshot and hand every row to `assembler`, returning the results. */
function ingestRevision(
  assembler: TranscriptRevisionAssembler,
  body: ReplicatedTranscriptSnapshotV1,
  identity: TranscriptRevisionIdentity = IDENTITY,
) {
  const encoded = encodeTranscriptRevision(body, identity, () => '2026-09-06T00:00:00.000Z')
  if (!encoded.ok) throw new Error('fixture snapshot is oversize')
  const rows: TranscriptRevisionRow[] = [
    { writer: identity.producerWriterId, seq: 1, kind: 'transcript.revision.begin.v1', payload: encoded.begin },
    ...encoded.chunks.map((chunk, i) => ({
      writer: identity.producerWriterId,
      seq: 2 + i,
      kind: 'transcript.revision.chunk.v1',
      payload: chunk,
    })),
    {
      writer: identity.producerWriterId,
      seq: 2 + encoded.chunks.length,
      kind: 'transcript.revision.commit.v1',
      payload: encoded.commit,
    },
  ]
  return rows.map((row) => assembler.ingestRow(row))
}

function setup(sessionSuffix = '') {
  const manager = new SubscriptionManager()
  const sendData = vi.fn().mockReturnValue(true)
  let clock = 1_000_000
  const controller = getOrCreateSessionChatTailController({
    manager,
    sendData,
    daemonId: DAEMON,
    sessionId: SESSION,
    historySessionId: sessionSuffix || undefined,
    subscriptionKey: SUBSCRIPTION_KEY,
    tailLimit: 60,
    now: () => clock,
  })
  return { manager, sendData, controller, advance: (ms: number) => { clock += ms } }
}

beforeEach(() => {
  resetSessionChatTailControllersForTest()
})

// ───────────────────────────────────────────────────────────────────────────
// ① ★ The codec short-circuit returns a snapshot EQUAL to the full decode.
// ───────────────────────────────────────────────────────────────────────────
describe('★ ①: codec re-decode short-circuit is result-identical', () => {
  it('★ returns the same snapshot content on a repeat commit as on the first', () => {
    const body = withMessages(7, 'idle', 'question', 'answer', 'more')
    const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId)

    const first = ingestRevision(assembler, body).at(-1)
    const second = ingestRevision(assembler, body).at(-1)

    expect(first?.status).toBe('complete')
    expect(second?.status).toBe('complete')
    // The whole point: the second delivery skipped the decode, and still
    // produced content indistinguishable from the first.
    expect(second && 'snapshot' in second ? second.snapshot : null)
      .toEqual(first && 'snapshot' in first ? first.snapshot : undefined)
    // A control assembler that never saw the first delivery (so its
    // short-circuit cannot arm) must agree with both.
    const cold = new TranscriptRevisionAssembler(IDENTITY.producerWriterId)
    const coldResult = ingestRevision(cold, body).at(-1)
    expect(coldResult && 'snapshot' in coldResult ? coldResult.snapshot : null)
      .toEqual(second && 'snapshot' in second ? second.snapshot : undefined)
  })

  it('★ never skips a revision whose CONTENT actually changed', () => {
    const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId)
    ingestRevision(assembler, withMessages(7, 'idle', 'q'))

    // Same identity shape, different body — different hash, so the gate (which
    // keys on the hash, never on `revision`) must miss and decode in full.
    const changed = withMessages(7, 'idle', 'q', 'a')
    const result = ingestRevision(assembler, changed).at(-1)
    expect(result?.status).toBe('complete')
    expect(result && 'snapshot' in result ? result.snapshot.messages : []).toHaveLength(2)
  })

  it('★ still rejects identical BYTES committed under a different identity', () => {
    // The short-circuit skips the DECODE, never the body-vs-envelope check.
    // Identical content under a bumped epoch must fail exactly as it would on
    // the full path — this is the check that would silently vanish if the
    // optimization returned the cached snapshot unvalidated.
    const body = withMessages(7, 'idle', 'q', 'a')
    const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId)
    ingestRevision(assembler, body)

    const foreign = { ...IDENTITY, producerEpoch: 'epoch-2' }
    const results = ingestRevision(assembler, body, foreign)
    const commit = results.at(-1)
    expect(commit?.status).toBe('rejected')
    expect(commit && 'reason' in commit ? commit.reason : '').toBe('wrong_owner')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ② ★ Controller map-skip does not change what lands on screen.
// ───────────────────────────────────────────────────────────────────────────
describe('★ ②: controller map-skip is screen-identical', () => {
  it('★ a repeat delivery leaves the rendered snapshot untouched', () => {
    const { controller } = setup()
    controller.retain()
    const body = withMessages(7, 'idle', 'q', 'a')

    controller.applyTranscriptReplicaSnapshot(body, { omittedBefore: false })
    const afterFirst = controller.getSnapshot()

    controller.applyTranscriptReplicaSnapshot(body, { omittedBefore: false })
    const afterRepeat = controller.getSnapshot()

    expect(afterRepeat.liveMessages.map((m) => m.content)).toEqual(['q', 'a'])
    // Same object identity: a no-op must not churn a new snapshot object, or
    // every `useSyncExternalStore` consumer re-renders on a frozen lane.
    expect(afterRepeat).toBe(afterFirst)
  })

  it('★ a genuinely NEW revision is never skipped', () => {
    const { controller } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(withMessages(7, 'idle', 'q', 'a'), { omittedBefore: false })
    controller.applyTranscriptReplicaSnapshot(withMessages(8, 'idle', 'q', 'a', 'next'), { omittedBefore: false })
    expect(controller.getSnapshot().liveMessages.map((m) => m.content)).toEqual(['q', 'a', 'next'])
  })

  it('★ a repeat snapshot with a FLIPPED omittedBefore behaves as the unoptimized path did', () => {
    // `omittedBefore`/`stale` are the caller's per-delivery decision, not a
    // property of the snapshot, so they are part of the skip key — the skip
    // does NOT fire here and the update is mapped and re-evaluated in full.
    //
    // ★ It nonetheless does not land, and that is CORRECT rather than a
    // regression: `handleUpdate` short-circuits on an unchanged message
    // signature ('noop') before it writes any of the snapshot's label fields,
    // so a flag-only change has never been able to move the rendered snapshot.
    // Pinned as a DIFFERENTIAL against a controller that cannot take the skip
    // at all (distinct objects each time), so this asserts equivalence with the
    // pre-optimization path rather than blessing the flag behaviour itself.
    const skipping = setup('history-flag-skip')
    const mapping = setup('history-flag-map')
    skipping.controller.retain()
    mapping.controller.retain()

    const shared = withMessages(7, 'idle', 'q', 'a')
    skipping.controller.applyTranscriptReplicaSnapshot(shared, { omittedBefore: false })
    skipping.controller.applyTranscriptReplicaSnapshot(shared, { omittedBefore: true })

    mapping.controller.applyTranscriptReplicaSnapshot(withMessages(7, 'idle', 'q', 'a'), { omittedBefore: false })
    mapping.controller.applyTranscriptReplicaSnapshot(withMessages(7, 'idle', 'q', 'a'), { omittedBefore: true })

    expect(skipping.controller.getSnapshot().omittedBefore)
      .toBe(mapping.controller.getSnapshot().omittedBefore)
    expect(skipping.controller.getSnapshot().liveMessages.map((m) => m.content))
      .toEqual(mapping.controller.getSnapshot().liveMessages.map((m) => m.content))
  })

  it('★ a cleared pane re-applies the SAME revision instead of skipping it', () => {
    // `clearLiveSnapshot` blanks the screen, which invalidates the skip key's
    // claim that "re-delivering this would change nothing". Skipping here
    // would leave a permanently empty pane.
    const { controller } = setup()
    controller.retain()
    const body = withMessages(7, 'idle', 'q', 'a')
    controller.applyTranscriptReplicaSnapshot(body, { omittedBefore: false })
    controller.clearLiveSnapshot()
    expect(controller.getSnapshot().liveMessages).toHaveLength(0)

    controller.applyTranscriptReplicaSnapshot(body, { omittedBefore: false })
    expect(controller.getSnapshot().liveMessages.map((m) => m.content)).toEqual(['q', 'a'])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ③ ★ Fan-out sharing feeds every warm controller the same content.
// ───────────────────────────────────────────────────────────────────────────
describe('★ ③: shared fan-out mapping reaches every warm controller', () => {
  it('★ pane and warm-inbox controllers both render the shared mapping', () => {
    const pane = setup('history-1')
    const inbox = setup()
    pane.controller.retain()
    inbox.controller.retain()

    const applied = applyTranscriptReplicaSnapshotToControllers(
      DAEMON,
      SESSION,
      withMessages(7, 'idle', 'q', 'a'),
      { omittedBefore: false },
    )

    expect(applied).toBe(2)
    expect(pane.controller.getSnapshot().liveMessages.map((m) => m.content)).toEqual(['q', 'a'])
    expect(inbox.controller.getSnapshot().liveMessages.map((m) => m.content)).toEqual(['q', 'a'])
    // Both read 'replica' — the shared object did not lose the telemetry field
    // that distinguishes the lane.
    expect(pane.controller.getSnapshot().transcriptReadSource).toBe('replica')
    expect(inbox.controller.getSnapshot().transcriptReadSource).toBe('replica')
  })

  it('★ a structurally-invalid snapshot still declines per controller', () => {
    // The fan-out builds the shared mapping only for a mappable snapshot; an
    // invalid one must still reach each controller's own structural refusal
    // rather than being mapped on a best-effort basis.
    const { controller } = setup()
    controller.retain()
    const broken = withMessages(7, 'idle', 'q') as unknown as Record<string, unknown>
    delete broken.activeModal

    applyTranscriptReplicaSnapshotToControllers(
      DAEMON,
      SESSION,
      broken as unknown as ReplicatedTranscriptSnapshotV1,
      { omittedBefore: false },
    )
    expect(controller.getSnapshot().transcriptFallbackReason).toBe('revision_invalid')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ④ ★★ THE ACTUAL RISK — liveness/lease side effects on the skipped path.
// ───────────────────────────────────────────────────────────────────────────
describe('★★ ④: the map-skip preserves every side effect the noop path had', () => {
  it('★ stamps liveness on a SKIPPED repeat exactly as on a mapped no-op', () => {
    const { controller, advance } = setup()
    controller.retain()
    const body = withMessages(7, 'generating', 'q', 'a')

    controller.applyTranscriptReplicaSnapshot(body, { omittedBefore: false })
    const afterFirst = controller.getLivenessStateForTest()

    advance(5_000)
    // This delivery takes the SKIP path. If it failed to stamp, the lane would
    // look silent to the watchdog and trigger a spurious re-pull.
    controller.applyTranscriptReplicaSnapshot(body, { omittedBefore: false })
    const afterSkip = controller.getLivenessStateForTest()

    expect(afterSkip.lastInboundAt).toBe(afterFirst.lastInboundAt + 5_000)
    expect(afterSkip.lastKnownStatus).toBe('generating')
    // `lastAppliedAt` measures RENDERED CONTENT and must NOT move on a no-op —
    // moving it would mask a genuinely frozen screen from the watchdog.
    expect(afterSkip.lastAppliedAt).toBe(afterFirst.lastAppliedAt)
  })

  it('★ the skipped path matches an equivalent NON-skipped no-op stamp-for-stamp', () => {
    // Differential check against the unoptimized behaviour: a controller fed a
    // fresh-but-equal snapshot object each time can never take the skip (the
    // key is reference-based), so it exercises the original mapped-noop path.
    // Its clocks must end up identical to the skipping controller's.
    const skipping = setup('history-skip')
    const mapping = setup('history-map')
    skipping.controller.retain()
    mapping.controller.retain()

    const shared = withMessages(7, 'generating', 'q', 'a')
    skipping.controller.applyTranscriptReplicaSnapshot(shared, { omittedBefore: false })
    mapping.controller.applyTranscriptReplicaSnapshot(withMessages(7, 'generating', 'q', 'a'), { omittedBefore: false })

    skipping.advance(3_000)
    mapping.advance(3_000)
    skipping.controller.applyTranscriptReplicaSnapshot(shared, { omittedBefore: false })
    mapping.controller.applyTranscriptReplicaSnapshot(withMessages(7, 'generating', 'q', 'a'), { omittedBefore: false })

    const a = skipping.controller.getLivenessStateForTest()
    const b = mapping.controller.getLivenessStateForTest()
    expect(a.lastInboundAt).toBe(b.lastInboundAt)
    expect(a.lastAppliedAt).toBe(b.lastAppliedAt)
    expect(a.lastKnownStatus).toBe(b.lastKnownStatus)
  })

  it('★★ a DEFERRED-then-retried snapshot resolves identically with and without the skip', () => {
    // `deferred` means "this update may legitimately be decided differently
    // next time" (the busy window lapses, a force-apply becomes eligible), so
    // the skip is armed ONLY on a `noop`. This is the scenario that would
    // freeze forever if that rule were wrong.
    //
    // Differential rather than absolute: the `mapping` controller is fed a
    // fresh object every time so it can never take the skip, and therefore
    // executes exactly the pre-optimization path. Whatever the shrink-defense
    // decides, both controllers must decide it the same way.
    const skipping = setup('history-defer-skip')
    const mapping = setup('history-defer-map')
    skipping.controller.retain()
    mapping.controller.retain()

    const long = () => withMessages(7, 'generating', 'a', 'b', 'c', 'd')
    const short = withMessages(8, 'generating', 'a')

    skipping.controller.applyTranscriptReplicaSnapshot(long(), { omittedBefore: false })
    mapping.controller.applyTranscriptReplicaSnapshot(long(), { omittedBefore: false })

    skipping.controller.applyTranscriptReplicaSnapshot(short, { omittedBefore: false })
    mapping.controller.applyTranscriptReplicaSnapshot(withMessages(8, 'generating', 'a'), { omittedBefore: false })
    expect(skipping.controller.getSnapshot().liveMessages.map((m) => m.content))
      .toEqual(mapping.controller.getSnapshot().liveMessages.map((m) => m.content))

    // Re-delivered well past the shrink-defense window: the skipping controller
    // must RE-EVALUATE rather than replay a remembered decision.
    skipping.advance(600_000)
    mapping.advance(600_000)
    skipping.controller.applyTranscriptReplicaSnapshot(short, { omittedBefore: false })
    mapping.controller.applyTranscriptReplicaSnapshot(withMessages(8, 'generating', 'a'), { omittedBefore: false })

    expect(skipping.controller.getSnapshot().liveMessages.map((m) => m.content))
      .toEqual(mapping.controller.getSnapshot().liveMessages.map((m) => m.content))
    expect(skipping.controller.getLivenessStateForTest().lastAppliedAt)
      .toBe(mapping.controller.getLivenessStateForTest().lastAppliedAt)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ⑤ ★ Injection: disabling a short-circuit must break PERFORMANCE only.
// ───────────────────────────────────────────────────────────────────────────
describe('★ ⑤: the short-circuits are provably work-skipping, not result-changing', () => {
  it('★ the codec skips the decode on a repeat, and is result-identical either way', () => {
    const body = withMessages(7, 'idle', 'q', 'a', 'and more content to decode')

    // Instrumented: count how often the expensive JSON.parse actually runs.
    const parse = JSON.parse
    let parses = 0
    const spy = vi.spyOn(JSON, 'parse').mockImplementation(((text: string, reviver?: never) => {
      // Only snapshot-sized payloads count; the per-row envelope parses in the
      // subscription layer are not what this measures.
      if (text.includes('"schemaVersion"')) parses += 1
      return parse(text, reviver)
    }) as typeof JSON.parse)

    try {
      const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId)
      const first = ingestRevision(assembler, body).at(-1)
      const parsesAfterFirst = parses
      expect(parsesAfterFirst).toBe(1)

      const second = ingestRevision(assembler, body).at(-1)
      // ★ The performance claim: the repeat did NO snapshot parse at all.
      expect(parses).toBe(parsesAfterFirst)
      // ★ The correctness claim, which holds regardless: same result.
      expect(second && 'snapshot' in second ? second.snapshot : null)
        .toEqual(first && 'snapshot' in first ? first.snapshot : undefined)
    } finally {
      spy.mockRestore()
    }
  })

  it('★ the fan-out maps once for two controllers, not twice', () => {
    const pane = setup('history-1')
    const inbox = setup()
    pane.controller.retain()
    inbox.controller.retain()

    const body = withMessages(7, 'idle', 'q', 'a')
    applyTranscriptReplicaSnapshotToControllers(DAEMON, SESSION, body, { omittedBefore: false })

    // Both controllers rendered from ONE mapping, so their message arrays are
    // the very same object — the observable signature of the shared map.
    expect(pane.controller.getSnapshot().liveMessages)
      .toBe(inbox.controller.getSnapshot().liveMessages)
  })
})
