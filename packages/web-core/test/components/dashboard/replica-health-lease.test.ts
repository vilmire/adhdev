/**
 * ★ Replica health as a LEASE, and legacy retirement gated on ACTUAL APPLY.
 *
 * ── The defect these pin ──────────────────────────────────────────────────
 * `replicaHealthy` was a one-shot latch. The first verified replica snapshot
 * set it true, the legacy `session.chat_tail` subscription was torn down, and
 * nothing ever re-examined the decision — health was never a function of
 * revision AGE or ADVANCEMENT. So a replica that fell silent (host wedged,
 * producer stalled, revisions simply stopped) still read "healthy" forever:
 *
 *   ① first valid replica snapshot arrives
 *   ② replicaHealthy = true
 *   ③ legacy session.chat_tail unsubscribed
 *   ④ replica quietly stops advancing
 *   ⑤ nothing checks revision age / advancement → still "healthy"
 *   ⑥ legacy gone + no browser poll → the pane is frozen indefinitely
 *
 * The liveness watchdog cannot rescue this: `shouldRefreshForLiveness()`
 * refuses outright while `replicaHealthy` is true, because a legacy read_chat
 * landing after a newer replica revision is the last-writer-wins hazard. The
 * latch itself had to become a lease.
 *
 * Separately, `applyTranscriptReplicaSnapshot` flipped the flag on a `void`
 * contract — it could not observe whether `handleUpdate` had actually applied
 * the snapshot. A snapshot that arrived but was DEFERRED (busy/shrink defense)
 * therefore retired legacy without ever rendering replica content.
 *
 * ── The one thing that makes this hard ────────────────────────────────────
 * Detecting silence is trivial. Telling a STALLED replica apart from an IDLE
 * agent is not — both produce exactly no new revisions. Idle is the steady
 * state of nearly every session on a dashboard, so a lease that expires on
 * quiet alone would resubscribe legacy on all of them, permanently. That is a
 * broader regression than the freeze it fixes, which is why ② below carries as
 * much weight as ①.
 *
 * Assertions read the real `subscribe`/`unsubscribe` wire frames rather than an
 * internal flag, so "legacy came back" is a claim about the transport.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  getOrCreateSessionChatTailController,
  resetSessionChatTailControllersForTest,
} from '../../../src/components/dashboard/session-chat-tail-controller'

const DAEMON = 'daemon-1'
const SESSION = 'session-1'
const SUBSCRIPTION_KEY = `daemon:${DAEMON}:session:${SESSION}`

/**
 * The lease window. Deliberately identical to the watchdog's busy quiet period
 * — the two answer the same question ("this session claims to be generating but
 * has produced nothing") and are pinned together so they cannot drift.
 */
const LEASE_MS = 20_000

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

/** A replica snapshot carrying real content — enough to mark the lane healthy. */
function healthySnapshot(revision: number, status: string, ...contents: string[]) {
  return snapshot({
    revision,
    status: status as ReplicatedTranscriptSnapshotV1['status'],
    messages: contents.map((c, i) => message(i % 2 === 0 ? 'user' : 'assistant', c, 10 + i)),
  })
}

function setup() {
  resetSessionChatTailControllersForTest()
  const manager = new SubscriptionManager()
  const sendData = vi.fn().mockReturnValue(true)
  let clock = 1_000_000
  const controller = getOrCreateSessionChatTailController({
    manager,
    sendData,
    daemonId: DAEMON,
    sessionId: SESSION,
    subscriptionKey: SUBSCRIPTION_KEY,
    tailLimit: 60,
    now: () => clock,
  })
  return {
    manager,
    sendData,
    controller,
    advance: (ms: number) => { clock += ms },
  }
}

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
function publishLegacy(manager: SubscriptionManager, seq: number, status: string, contents: string[]) {
  manager.publish({
    topic: 'session.chat_tail',
    key: SUBSCRIPTION_KEY,
    sessionId: SESSION,
    seq,
    timestamp: 0,
    status,
    messages: contents.map((content, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      kind: 'standard',
      content,
      receivedAt: i + 1,
      timestamp: i + 1,
    })),
  } as never)
}

beforeEach(() => {
  resetSessionChatTailControllersForTest()
})

// ───────────────────────────────────────────────────────────────────────────
// ① ★ THE DEFECT — a busy replica that goes silent must lose its lease.
// ───────────────────────────────────────────────────────────────────────────
describe('★ A①: a stalled replica lane loses health and legacy comes back', () => {
  it('★ expires the lease and re-subscribes legacy when a BUSY replica stops advancing', () => {
    const { sendData, controller, advance } = setup()
    controller.retain()
    expect(subscribeFrames(sendData)).toHaveLength(1)

    // The replica takes over on a session that is actively generating.
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'generating', 'q', 'a'), {
      omittedBefore: false,
    })
    // Legacy has stood down — this is the state the old latch made permanent.
    expect(unsubscribeFrames(sendData)).toHaveLength(1)
    expect(subscribeFrames(sendData)).toHaveLength(1)

    // The lane goes silent while still claiming to generate. No further
    // snapshot arrives; no visibility edge ever fires.
    advance(LEASE_MS - 1)
    controller.shouldRefreshForLiveness()
    expect(subscribeFrames(sendData)).toHaveLength(1) // not yet — still within lease

    advance(1)
    controller.shouldRefreshForLiveness()

    // ★ Without the lease this stays 1 forever and the pane is frozen: legacy
    // is gone, the replica is dead, and nothing polls.
    expect(subscribeFrames(sendData)).toHaveLength(2)
    expect(controller.getSnapshot().transcriptFallbackReason).toBe('replica_lease_expired')
    expect(controller.getSnapshot().transcriptReadSource).toBe('legacy')
  })

  it('★ the recovered legacy transport actually DELIVERS again — not merely resubscribed', () => {
    // A resubscribe frame with a dead pane behind it would pass the assertion
    // above. Only rendering new content proves the recovery is real.
    const { sendData, manager, controller, advance } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'generating', 'q', 'a'), {
      omittedBefore: false,
    })

    advance(LEASE_MS)
    controller.shouldRefreshForLiveness()
    expect(subscribeFrames(sendData)).toHaveLength(2)

    publishLegacy(manager, 1, 'idle', ['q', 'a', 'q2', 'legacy rescued this pane'])
    expect(controller.getSnapshot().liveMessages.map((m) => m.content))
      .toContain('legacy rescued this pane')
  })

  it('a replica that keeps ADVANCING renews the lease and legacy stays retired', () => {
    // The lease must not expire on a working lane — that would resubscribe
    // legacy under a healthy replica and reintroduce cross-source interleaving.
    const { sendData, controller, advance } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'generating', 'q', 'a'), {
      omittedBefore: false,
    })

    for (let i = 0; i < 5; i += 1) {
      advance(LEASE_MS - 1)
      controller.shouldRefreshForLiveness()
      controller.applyTranscriptReplicaSnapshot(
        healthySnapshot(3 + i, 'generating', 'q', 'a', `chunk-${i}`),
        { omittedBefore: false },
      )
    }
    advance(LEASE_MS - 1)
    controller.shouldRefreshForLiveness()

    expect(subscribeFrames(sendData)).toHaveLength(1)
    expect(unsubscribeFrames(sendData)).toHaveLength(1)
  })

  it('★ re-delivering the SAME revision does NOT renew the lease', () => {
    // A lane stuck re-emitting one frozen revision is the stall itself. If
    // arrival renewed the lease, the stall would renew its own health and the
    // lease could never expire — the latch bug with extra steps.
    const { sendData, controller, advance } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'generating', 'q', 'a'), {
      omittedBefore: false,
    })

    advance(LEASE_MS - 1)
    // Same revision 2, re-delivered.
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'generating', 'q', 'a'), {
      omittedBefore: false,
    })
    advance(1)
    controller.shouldRefreshForLiveness()

    expect(subscribeFrames(sendData)).toHaveLength(2)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ② ★ THE FALSE-POSITIVE GUARD — an idle agent is not a stalled replica.
//
// This is the assertion that keeps the fix from being worse than the bug. An
// idle session produces no revisions BY DESIGN; expiring its lease would revive
// legacy on every settled session in the workspace, forever.
// ───────────────────────────────────────────────────────────────────────────
describe('★ A②: a genuinely idle session never revives legacy', () => {
  it('★ does NOT resubscribe legacy for an IDLE session that is simply quiet', () => {
    const { sendData, controller, advance } = setup()
    controller.retain()

    // Replica takes over on a settled, idle session.
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'idle', 'q', 'a'), {
      omittedBefore: false,
    })
    expect(unsubscribeFrames(sendData)).toHaveLength(1)

    // Long silence — the correct and expected state for an idle session.
    for (let i = 0; i < 40; i += 1) {
      advance(LEASE_MS)
      controller.shouldRefreshForLiveness()
    }

    // ★ Still exactly one subscribe (the pre-replica one). If the lease expired
    // on quiet alone, this would climb once per lease window on every idle
    // session in the fleet.
    expect(subscribeFrames(sendData)).toHaveLength(1)
    expect(controller.getSnapshot().transcriptFallbackReason).not.toBe('replica_lease_expired')
  })

  it('a session that WAS busy but has since settled to idle does not expire either', () => {
    // The busy stamp must age out with the lease, not latch. Otherwise every
    // session that ever generated would eventually trip the expiry once quiet.
    const { sendData, controller, advance } = setup()
    controller.retain()

    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'generating', 'q', 'a'), {
      omittedBefore: false,
    })
    // The turn finishes: the replica reports idle and then legitimately rests.
    advance(1_000)
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(3, 'idle', 'q', 'a', 'done'), {
      omittedBefore: false,
    })

    for (let i = 0; i < 20; i += 1) {
      advance(LEASE_MS)
      controller.shouldRefreshForLiveness()
    }

    expect(subscribeFrames(sendData)).toHaveLength(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ③ ★ B — legacy is retired only by a snapshot that was ACTUALLY APPLIED.
// ───────────────────────────────────────────────────────────────────────────
describe('★ B: a snapshot that never reached the screen cannot retire legacy', () => {
  it('★ a NON-APPLIED first snapshot leaves replicaHealthy false and legacy running', () => {
    const { sendData, manager, controller } = setup()
    controller.retain()

    // Legacy has hydrated a full window on a busy session.
    publishLegacy(manager, 1, 'generating', ['q1', 'a1', 'q2', 'a2', 'q3', 'a3'])
    expect(controller.getSnapshot().liveMessages).toHaveLength(6)
    expect(unsubscribeFrames(sendData)).toHaveLength(0)

    // (REPLICA-PROVENANCE-SCALAR-LOSS) This case used to be driven by a SHORT
    // replica snapshot during the active window, because back then the
    // shrink-defense's count heuristic deferred every replica snapshot — that
    // was the wedge, not a contract. A replica snapshot is authoritative and now
    // always reaches the screen, so a structurally-invalid snapshot (rejected
    // before it can apply) is the correct vehicle for "never reached the screen".
    // The INVARIANT under test is unchanged: only an APPLIED snapshot retires legacy.
    const broken = { ...healthySnapshot(2, 'generating', 'only one') }
    delete (broken as Record<string, unknown>).activeModal
    controller.applyTranscriptReplicaSnapshot(broken as ReplicatedTranscriptSnapshotV1, {
      omittedBefore: false,
    })

    // ★ Nothing replica-authored is on screen...
    expect(controller.getSnapshot().liveMessages).toHaveLength(6)
    // ★ ...so legacy must NOT have been torn down. Under the old arrival-gated
    // flag this was an unsubscribe, stranding the pane on legacy's last frame
    // with no source able to correct it.
    expect(unsubscribeFrames(sendData)).toHaveLength(0)
    expect(subscribeFrames(sendData)).toHaveLength(1)
  })

  it('★ a SHORT replica snapshot during generation now APPLIES (wedge regression)', () => {
    // The converse of the case above, pinned here so the two cannot be confused
    // again: shortness alone is not grounds to withhold an authoritative snapshot.
    const { manager, controller } = setup()
    controller.retain()
    publishLegacy(manager, 1, 'generating', ['q1', 'a1', 'q2', 'a2', 'q3', 'a3'])

    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'generating', 'only one'), {
      omittedBefore: false,
    })

    expect(controller.getSnapshot().liveMessages.map((m) => m.content)).toEqual(['only one'])
  })

  it('the NEXT snapshot that genuinely applies does retire legacy', () => {
    // The deferral must delay retirement, not prevent it forever.
    const { sendData, manager, controller } = setup()
    controller.retain()
    publishLegacy(manager, 1, 'generating', ['q1', 'a1', 'q2', 'a2', 'q3', 'a3'])

    // Non-applied for the same reason as the case above: rejected on validation,
    // so it cannot retire legacy.
    const broken = { ...healthySnapshot(2, 'generating', 'only one') }
    delete (broken as Record<string, unknown>).activeModal
    controller.applyTranscriptReplicaSnapshot(broken as ReplicatedTranscriptSnapshotV1, {
      omittedBefore: false,
    })
    expect(unsubscribeFrames(sendData)).toHaveLength(0)

    // A full, non-shrinking replica window lands for real.
    controller.applyTranscriptReplicaSnapshot(
      healthySnapshot(3, 'generating', 'q1', 'a1', 'q2', 'a2', 'q3', 'replica answer'),
      { omittedBefore: false },
    )

    expect(controller.getSnapshot().liveMessages.map((m) => m.content)).toContain('replica answer')
    expect(unsubscribeFrames(sendData)).toHaveLength(1)
  })

  it('a structurally-invalid snapshot still cannot retire legacy', () => {
    // The pre-existing refusal contract, re-asserted alongside the new gate so
    // neither can be relaxed on the assumption the other still covers it.
    const { sendData, controller } = setup()
    controller.retain()

    const broken = { ...healthySnapshot(2, 'generating', 'q', 'a') }
    delete (broken as Record<string, unknown>).activeModal

    controller.applyTranscriptReplicaSnapshot(broken as ReplicatedTranscriptSnapshotV1, {
      omittedBefore: false,
    })

    expect(unsubscribeFrames(sendData)).toHaveLength(0)
    expect(controller.getSnapshot().transcriptFallbackReason).toBe('revision_invalid')
  })
})
