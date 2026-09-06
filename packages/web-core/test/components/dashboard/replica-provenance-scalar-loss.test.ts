/**
 * (REPLICA-PROVENANCE-SCALAR-LOSS) The busy-tail shrink-defense must not veto an
 * authoritative replica snapshot.
 *
 * ── The defect this closes ─────────────────────────────────────────────────
 * `buildCliMessageSourceProvenance` produces messageSource as an OBJECT
 * ({selected, provider, fallbackReason, ...}). The wire projection encoded it
 * with `stringField`, which returns null for anything non-string — so the whole
 * object collapsed to null on every replica snapshot. Downstream,
 * `shouldDeferBusyTailUpdate`'s A3 escape hatch requires a messageSource object,
 * so it was skipped entirely and the decision fell through to the v1 count
 * heuristic (`nextMessages.length < existingCount`).
 *
 * While generating, the tail legitimately OSCILLATES (PTY and native bubbles
 * merge/split), and the baseline is fallback-inflated — so every shrink deferred.
 * A defer stamps `lastInboundAt` but never `lastAppliedAt`, so the screen froze
 * while the lane looked healthy, killing the replica apply, the watchdog veto and
 * the legacy-retirement path at once.
 *
 * These tests pin BOTH halves: the projection must carry `selected` as a scalar,
 * and the controller must apply a shrinking replica snapshot during generation.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ReplicatedTranscriptSnapshotV1, SessionChatTailUpdate } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  applyTranscriptReplicaSnapshotToControllers,
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
    messages: [],
    status: 'idle',
    syncMode: 'full',
    replaceFrom: 0,
    totalMessages: 0,
    lastMessageSignature: 'sig-1',
    ...overrides,
  } as SessionChatTailUpdate
}

function replicaMessage(
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

function replicaSnapshot(
  overrides: Partial<ReplicatedTranscriptSnapshotV1> = {},
): ReplicatedTranscriptSnapshotV1 {
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
    observedAt: '2026-09-06T00:00:00.000Z',
    status: 'generating',
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

function createHarness() {
  const manager = new SubscriptionManager()
  let clock = 1_000_000
  const controller = getOrCreateSessionChatTailController({
    manager,
    sendData: () => true,
    daemonId: 'daemon-1',
    sessionId: 'session-1',
    subscriptionKey: 'daemon:daemon-1:session:session-1',
    now: () => clock,
  })
  controller.retain()
  return {
    controller,
    deliver: (update: Partial<SessionChatTailUpdate> = {}) => {
      manager.publish(createUpdate(update) as never)
    },
    applyReplica: (snapshot: ReplicatedTranscriptSnapshotV1) => {
      applyTranscriptReplicaSnapshotToControllers('daemon-1', 'session-1', snapshot, {
        omittedBefore: false,
      })
    },
    advance: (ms: number) => { clock += ms },
    now: () => clock,
  }
}

/**
 * Hydrate the pane to `count` bubbles while GENERATING, so the shrink-defense is
 * armed against a real on-screen baseline — the exact live precondition.
 */
function hydrateGenerating(h: ReturnType<typeof createHarness>, count: number): void {
  h.deliver({
    status: 'generating',
    messages: Array.from({ length: count }, (_, i) =>
      ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`, id: `m${i}`, timestamp: i + 1 }),
    ) as never,
    totalMessages: count,
    lastMessageSignature: `sig-${count}`,
  })
}

describe('(STEP 0) oscillation-vs-wedge reproduction matrix', () => {
  beforeEach(() => {
    resetSessionChatTailControllersForTest()
  })

  it('applies a GROWING replica tail during generation (3 → 4)', () => {
    const h = createHarness()
    hydrateGenerating(h, 3)
    const before = h.controller.getLivenessStateForTest().lastAppliedAt

    h.advance(1_000)
    h.applyReplica(replicaSnapshot({
      revision: 2,
      messages: [1, 2, 3, 4].map((n) => replicaMessage(n % 2 ? 'user' : 'assistant', `r${n}`, n)),
      coverage: { mode: 'tail', totalMessageCount: 4, returnedMessageCount: 4, omittedBefore: false },
    }))

    expect(h.controller.getLivenessStateForTest().lastAppliedAt).toBeGreaterThan(before)
    expect(h.controller.getSnapshot().liveMessages).toHaveLength(4)
  })

  it('★ applies a SHRINKING replica tail during generation (4 → 3) — the wedge', () => {
    // This is the live defect. The replica is hash-verified and monotonically
    // revisioned; a shorter tail is a legitimate bubble merge, not a regression.
    // Before the fix this deferred forever and the screen froze.
    const h = createHarness()
    hydrateGenerating(h, 4)
    const before = h.controller.getLivenessStateForTest().lastAppliedAt

    h.advance(1_000)
    h.applyReplica(replicaSnapshot({
      revision: 2,
      messages: [1, 2, 3].map((n) => replicaMessage(n % 2 ? 'user' : 'assistant', `r${n}`, n)),
      coverage: { mode: 'tail', totalMessageCount: 3, returnedMessageCount: 3, omittedBefore: false },
    }))

    const state = h.controller.getLivenessStateForTest()
    expect(state.lastAppliedAt).toBeGreaterThan(before)
    expect(state.lastAppliedAt).toBe(state.lastInboundAt)
    expect(h.controller.getSnapshot().liveMessages).toHaveLength(3)
  })

  it('★ a shrinking replica tail carrying selected:native-history is applied', () => {
    // The provenance escape hatch must survive the wire. `selected` is the ONLY
    // field the gate reads, and it is a closed enum — no content crosses here.
    const h = createHarness()
    hydrateGenerating(h, 4)
    const before = h.controller.getLivenessStateForTest().lastAppliedAt

    h.advance(1_000)
    h.applyReplica(replicaSnapshot({
      revision: 2,
      provenance: { messageSource: 'native-history', transcriptProvenance: 'provider-native' },
      messages: [1, 2, 3].map((n) => replicaMessage(n % 2 ? 'user' : 'assistant', `r${n}`, n)),
      coverage: { mode: 'tail', totalMessageCount: 3, returnedMessageCount: 3, omittedBefore: false },
    }))

    expect(h.controller.getLivenessStateForTest().lastAppliedAt).toBeGreaterThan(before)
    expect(h.controller.getSnapshot().messageSource).toMatchObject({ selected: 'native-history' })
  })

  it('★ the gate reads a BARE STRING messageSource too (no re-wrap required)', () => {
    // Defense in depth for STEP 1's consumer-side normalization: a producer that
    // ships the scalar without the adapter's `{ selected }` re-wrap must still
    // get the escape hatch rather than silently hitting the count heuristic.
    const h = createHarness()
    hydrateGenerating(h, 4)
    const before = h.controller.getLivenessStateForTest().lastAppliedAt

    h.advance(1_000)
    h.deliver({
      status: 'generating',
      messageSource: 'native-history' as never,
      messages: [
        { role: 'user', content: 'm0', id: 'm0', timestamp: 1 },
        { role: 'assistant', content: 'm1', id: 'm1', timestamp: 2 },
      ] as never,
      totalMessages: 2,
      lastMessageSignature: 'sig-native-short',
    })

    expect(h.controller.getLivenessStateForTest().lastAppliedAt).toBeGreaterThan(before)
    expect(h.controller.getSnapshot().liveMessages).toHaveLength(2)
  })

  it('★ (STEP 3) a frozen SCREEN under a healthy replica lane raises a fallback', () => {
    // The class detector. The lease used to measure lane advance only, which is
    // exactly why this defect ran silent: snapshots kept arriving (~29.5/min) and
    // the lane looked healthy while nothing reached the screen. A busy session
    // whose rendered content has not moved for a full lease window is wedged
    // regardless of cause.
    const h = createHarness()
    h.applyReplica(replicaSnapshot({
      revision: 2,
      messages: [replicaMessage('user', 'q', 1)],
      coverage: { mode: 'tail', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
    }))
    expect(h.controller.getSnapshot().transcriptReadSource).toBe('replica')

    // The lane keeps reporting, but every report is a no-op: identical content,
    // so `lastAppliedAt` cannot advance while the lane looks perfectly alive.
    for (let i = 0; i < 8; i += 1) {
      h.advance(5_000)
      h.applyReplica(replicaSnapshot({
        revision: 2 + i + 1,
        messages: [replicaMessage('user', 'q', 1)],
        coverage: { mode: 'tail', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
      }))
      h.controller.shouldRefreshForLiveness()
    }

    expect(h.controller.getSnapshot().transcriptFallbackReason).toBe('replica_screen_stalled')
  })

  it('still defers a shrinking LEGACY (non-replica) tail with no provenance', () => {
    // STEP 2 narrows the count heuristic to non-replica sources ONLY. The legacy
    // lane keeps its existing shrink-defense — this pins that we did not widen
    // the fix into a blanket disable of the guard.
    const h = createHarness()
    hydrateGenerating(h, 4)
    const before = h.controller.getLivenessStateForTest().lastAppliedAt

    h.advance(1_000)
    h.deliver({
      status: 'generating',
      messages: [
        { role: 'user', content: 'm0', id: 'm0', timestamp: 1 },
        { role: 'assistant', content: 'm1', id: 'm1', timestamp: 2 },
      ] as never,
      totalMessages: 2,
      lastMessageSignature: 'sig-short',
    })

    expect(h.controller.getLivenessStateForTest().lastAppliedAt).toBe(before)
    expect(h.controller.getSnapshot().liveMessages).toHaveLength(4)
  })
})
