/**
 * ★ Roster ids 1-2 (`web_chat_pane`, `web_warm_mobile_preview`) —
 * projection-field injection (design §8 "각 consumer commit의 수용 체크리스트":
 * "consumer의 필수 field 하나를 projection에서 제거하면 test가 red다").
 *
 * ── Why this file exists (§5.6 gate, unit 9-pre-a) ──────────────────────────
 * Ids 3-8 each own an executing injection suite:
 *   - id 3       `daemon-core/test/mesh/transcript-read-chat-adapter.test.ts`
 *   - ids 4-5    `daemon-core/test/mesh/transcript-daemon-consumer-read.test.ts`
 *   - ids 6-8    `mcp-server/test/mesh-semantic-transcript-cutover.test.ts`
 * Ids 1-2 did NOT. The only injection evidence for the web adapter was a
 * COMMENT in `transcript-chat-pane-adapter.test.ts` ("Verified by injection:
 * dropping the mapMessageSource projection makes…") — a record of a past
 * manual check, not an assertion that executes. Nothing went red if the
 * projection regressed, and ids 1-2 are the production-facing consumers.
 * That is the same vacuous-green class that already cost this migration twice
 * (unit 4c's `bindTranscriptSessionInterest`, unit 5b-2's `if(false)` policy
 * tests), sitting on the highest-traffic path.
 *
 * §5.6 requires "모든 roster consumer의 injection tests" BEFORE the legacy
 * `session.chat_tail` push transport may be removed (unit 9). This file closes
 * ids 1-2, taking that gate from 6/8 to 8/8. It removes nothing and changes no
 * src — it only makes the existing projection's load-bearing fields provable.
 *
 * ── Method ─────────────────────────────────────────────────────────────────
 * Mirrors unit 6's pattern verbatim: `inject()` deletes ONE field from the
 * wire snapshot and the case asserts the resulting DEFECT, alongside the
 * present-field control. `delete` on the readonly wire type is exactly what a
 * projection regression looks like from the consumer's side — the field simply
 * stops arriving.
 *
 * ★ Each case asserts BOTH directions (present → good, removed → bad). A case
 * that only asserted the removed direction could pass against a mapper that
 * never worked at all.
 *
 * ── What is deliberately NOT claimed here ──────────────────────────────────
 * Two fields the adapter maps are STRUCTURAL rather than behaviour-gating in
 * the controller, and this file says so instead of manufacturing a scenario
 * that pretends otherwise:
 *   - `turnKey`→`bubbleId`: feeds lastSubstantiveAssistantIdentity, but the
 *     force-apply path keys on the role transition, per the note already in
 *     `transcript-chat-pane-adapter.test.ts`.
 *   - `title`: carried onto the update, but no controller gate reads it.
 * Asserting a fake behavioural consequence for either would be a worse test
 * than not asserting one.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  getOrCreateSessionChatTailController,
  resetSessionChatTailControllersForTest,
} from '../../../src/components/dashboard/session-chat-tail-controller'
import {
  isMappableTranscriptSnapshot,
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

function message(
  role: 'user' | 'assistant',
  content: string,
  receivedAt: number,
  turnKey: string,
): ReplicatedTranscriptSnapshotV1['messages'][number] {
  return {
    role,
    kind: 'standard',
    content,
    receivedAt,
    timestamp: receivedAt,
    turnKey,
    bubbleState: 'final',
    senderName: null,
    toolName: null,
    streaming: null,
  } as ReplicatedTranscriptSnapshotV1['messages'][number]
}

/** Delete ONE field from the wire snapshot — what a projection regression looks like. */
function inject(field: string, base: ReplicatedTranscriptSnapshotV1): ReplicatedTranscriptSnapshotV1 {
  const mutated = { ...base } as Record<string, unknown>
  delete mutated[field]
  return mutated as ReplicatedTranscriptSnapshotV1
}

const OPTS = { subscriptionKey: 'daemon:daemon-1:session:session-1', omittedBefore: false, stale: false }

// ───────────────────────────────────────────────────────────────────────────
// Pure-mapper injection: the fields the controller reads by name.
// ───────────────────────────────────────────────────────────────────────────
describe('mapTranscriptSnapshotToChatTailUpdate — required-field injection (roster id 1)', () => {
  it('messages: present → mapped tail; removed → the mapper throws instead of silently emitting an empty transcript', () => {
    const base = buildSnapshot({ messages: [message('assistant', 'answer', 10, 't1')] })

    expect(mapTranscriptSnapshotToChatTailUpdate(base, OPTS).messages).toHaveLength(1)

    // ★ Throwing is the CORRECT failure here. A mapper that emitted `[]` would
    // hand the controller a well-formed "this session has no messages" update,
    // which the pane renders as an empty transcript — a silent wrong answer.
    expect(() => mapTranscriptSnapshotToChatTailUpdate(inject('messages', base), OPTS)).toThrow()
  })

  it('status: present → mapped; removed → status is undefined, so the busy/shrink gates lose their input', () => {
    const base = buildSnapshot({ status: 'generating', messages: [message('user', 'q', 1, 'u1')] })

    expect(mapTranscriptSnapshotToChatTailUpdate(base, OPTS).status).toBe('generating')
    expect(mapTranscriptSnapshotToChatTailUpdate(inject('status', base), OPTS).status).toBeUndefined()
  })

  it('sessionId: present → mapped; removed → undefined, which the controller cross-session guard cannot match', () => {
    const base = buildSnapshot({ sessionId: 'session-1', messages: [message('user', 'q', 1, 'u1')] })

    expect(mapTranscriptSnapshotToChatTailUpdate(base, OPTS).sessionId).toBe('session-1')
    expect(mapTranscriptSnapshotToChatTailUpdate(inject('sessionId', base), OPTS).sessionId).toBeUndefined()
  })

  /**
   * ★ UPDATED by unit 9-pre-c — the gap this case used to PIN is now FIXED.
   *
   * 9-pre-a measured the then-current behaviour: a missing `activeModal`
   * mapped to `null`, indistinguishable from "no modal", so an
   * approval-waiting session rendered with no approval UI and nothing
   * reported it. That case was written against reality and flagged as a
   * robustness gap, with the explicit note that it should be updated if the
   * adapter later learned to fail closed. 9-pre-c is that change.
   *
   * The contract is now a DECLINE, not a throw — see
   * `isMappableTranscriptSnapshot`'s header for why a throw is wrong on this
   * path (it runs inside a MessagePort `onmessage` with no catch above it).
   * The mapper itself is unchanged and still maps best-effort; the REFUSAL
   * lives at the controller boundary, which is what the behavioural case in
   * `transcript-fallback-fire-drill.test.ts` drives end to end.
   */
  it('activeModal: present → mapped message/buttons; removed → the snapshot is no longer mappable (★ 9-pre-c fix)', () => {
    const base = buildSnapshot({
      status: 'waiting_approval',
      activeModal: { message: 'Run `rm -rf build/`?', buttons: ['Yes', 'No'] },
      messages: [message('assistant', 'need approval', 5, 'a1')],
    })

    const mapped = mapTranscriptSnapshotToChatTailUpdate(base, OPTS)
    expect(mapped.activeModal).toEqual({ message: 'Run `rm -rf build/`?', buttons: ['Yes', 'No'] })

    // ★ A present-but-null modal is a NORMAL, renderable state and must stay
    // mappable — otherwise every ordinary session would fall back.
    expect(isMappableTranscriptSnapshot(base)).toBe(true)
    expect(isMappableTranscriptSnapshot(buildSnapshot({ activeModal: null }))).toBe(true)

    // ★ A MISSING field is a projection regression and is now refused, so the
    // controller falls back to legacy instead of silently dropping the
    // approval UI.
    expect(isMappableTranscriptSnapshot(inject('activeModal', base))).toBe(false)

    // A structurally malformed modal is refused too — `magi_approval_probe`
    // and the pane both read `.message`/`.buttons` by name.
    expect(
      isMappableTranscriptSnapshot(
        buildSnapshot({ activeModal: { message: 'x' } as never }),
      ),
    ).toBe(false)
  })

  it('provenance: present → messageSource.selected; removed → the mapper throws rather than dropping the native-source signal', () => {
    const base = buildSnapshot({
      provenance: { messageSource: 'native-history', transcriptProvenance: 'claude_jsonl' },
      messages: [message('assistant', 'answer', 10, 'a1')],
    })

    expect(mapTranscriptSnapshotToChatTailUpdate(base, OPTS).messageSource).toEqual({ selected: 'native-history' })
    expect(() => mapTranscriptSnapshotToChatTailUpdate(inject('provenance', base), OPTS)).toThrow()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Behavioural injection: converts the line-273 COMMENT into an executing
// assertion. This is the case §5.6 actually needs — a field whose loss changes
// what the user sees, not merely what the object contains.
// ───────────────────────────────────────────────────────────────────────────
describe('messageSource projection — behavioural injection through the controller (roster id 1)', () => {
  /**
   * Drives the D6 native-history force-apply path end-to-end.
   *
   * Busy phase renders a 3-message tail ending on the user prompt. The
   * corrective native-history tail is SHORTER (2 messages) but ends on the
   * assistant answer — exactly the shape the shrink-defense would normally
   * reject. `messageSource.selected === 'native-history'` is what makes
   * `isNativeHistorySource()` true so force-apply overrides the shrink guard.
   *
   * ★ Two details that make this scenario actually exercise the gate, both
   * found by running it rather than by reading:
   *   1. The corrective tail keeps a BUSY status (`generating`). The
   *      shrink-defense only engages for an active/warm status or inside the
   *      generating→idle transition window; with a settled `idle` the tail is
   *      applied unconditionally and the test would pass no matter what the
   *      provenance said — i.e. vacuously.
   *   2. The enum is `'native-history'` (HYPHEN). `isNativeHistorySource()`
   *      compares against that exact string, so an underscore spelling makes
   *      the "present" case pass for the wrong reason.
   *
   * @param provenance the snapshot provenance for the corrective tail
   * @returns the rendered live messages after the corrective tail is published
   */
  function renderCorrectiveTail(provenance: ReplicatedTranscriptSnapshotV1['provenance']) {
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

    manager.publish(mapTranscriptSnapshotToChatTailUpdate(
      buildSnapshot({
        status: 'generating',
        messages: [
          message('user', 'q1', 1, 'u1'),
          message('assistant', 'partial', 2, 'a1'),
          message('user', 'q2', 3, 'u2'),
        ],
      }),
      OPTS,
    ))
    expect(controller.getSnapshot().liveMessages).toHaveLength(3)

    // ★ Still `generating` — see note (1) above. This is what keeps the
    // shrink-defense engaged so the provenance actually decides the outcome.
    manager.publish(mapTranscriptSnapshotToChatTailUpdate(
      buildSnapshot({
        status: 'generating',
        revision: 2,
        provenance,
        messages: [message('user', 'q2', 3, 'u2'), message('assistant', 'the real answer', 4, 'a2')],
      }),
      OPTS,
    ))

    return controller.getSnapshot().liveMessages
  }

  it('present → the shorter native-history tail is force-applied and the assistant answer renders', () => {
    const rendered = renderCorrectiveTail({ messageSource: 'native-history', transcriptProvenance: 'claude_jsonl' })

    expect(rendered).toHaveLength(2)
    expect(rendered[rendered.length - 1]).toMatchObject({ role: 'assistant', content: 'the real answer' })
  })

  it('★ removed → force-apply never fires, the shrink-defense wins, and the user is left on the STALE tail', () => {
    // The injection: same snapshot, but the provenance scalar is gone (as it
    // would be if the projection stopped carrying messageSource).
    const rendered = renderCorrectiveTail({ messageSource: null, transcriptProvenance: null })

    // ★ 3 stale messages instead of 2 — the assistant's real answer is NOT shown.
    expect(rendered).toHaveLength(3)
    expect(rendered.some((m) => m.content === 'the real answer')).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Roster id 2 — the warm mobile preview reads the SAME controller snapshot
// (§4: "별도 SUB를 만들지 않고 같은 worker replica selector 사용"), so its
// injection surface is the selector's substantive-message identity.
// ───────────────────────────────────────────────────────────────────────────
describe('warm preview projection — injection (roster id 2)', () => {
  function warmSnapshotAfter(snapshot: ReplicatedTranscriptSnapshotV1) {
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
    manager.publish(mapTranscriptSnapshotToChatTailUpdate(snapshot, OPTS))
    return controller.getSnapshot()
  }

  it('messages content: present → the preview has a last substantive message; emptied → it has none', () => {
    const withContent = warmSnapshotAfter(buildSnapshot({
      messages: [message('user', 'q', 1, 'u1'), message('assistant', 'preview me', 2, 'a1')],
    }))
    expect(withContent.hasLiveSnapshot).toBe(true)
    expect(withContent.liveMessages[withContent.liveMessages.length - 1]).toMatchObject({ content: 'preview me' })

    // ★ The injection: the projection carries the revision but no messages.
    // The preview must NOT invent a substantive message from an empty tail.
    const withoutContent = warmSnapshotAfter(buildSnapshot({ revision: 2, messages: [] }))
    expect(withoutContent.liveMessages).toHaveLength(0)
  })

  it('status: present → carried to the preview; removed → undefined, so the preview badge loses its input', () => {
    const base = buildSnapshot({ status: 'waiting_approval', messages: [message('assistant', 'x', 1, 'a1')] })

    expect(mapTranscriptSnapshotToChatTailUpdate(base, OPTS).status).toBe('waiting_approval')
    expect(mapTranscriptSnapshotToChatTailUpdate(inject('status', base), OPTS).status).toBeUndefined()
  })
})
