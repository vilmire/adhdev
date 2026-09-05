/**
 * (LIVENESS) Regression tests for the continuously-visible chat pane going
 * permanently stale.
 *
 * Owner-reported symptom (rc.82 preview, iPad Safari): "messages don't update
 * unless I go to another tab and come back, or unless I send something."
 * Completion toasts kept arriving on the same screen, so P2P and React were
 * both alive — only the chat pane was frozen.
 *
 * Root cause: every `refreshAuthoritativeTail` trigger was an EDGE (mount,
 * Dockview hidden→visible, visibilitychange→visible, P2P reconnect). A pane
 * that stays visible therefore had no recovery path whatsoever: miss one push
 * and it renders that stale tail indefinitely. The user's "switch tabs and come
 * back" workaround was them manufacturing the `refreshEnabled` false→true edge
 * by hand.
 *
 * These tests pin the watchdog's decision logic — the part that must not
 * regress into either (a) no recovery, or (b) a fixed-interval RPC poll.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplicatedTranscriptSnapshotV1, SessionChatTailUpdate } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  getOrCreateSessionChatTailController,
  resetSessionChatTailControllersForTest,
} from '../../../src/components/dashboard/session-chat-tail-controller'

const BUSY_QUIET_MS = 20_000
const IDLE_QUIET_MS = 120_000
const AUTHORITATIVE_TAIL_REFRESH_DEBOUNCE_MS = 750

function createUpdate(overrides: Partial<SessionChatTailUpdate> = {}): SessionChatTailUpdate {
  return {
    topic: 'session.chat_tail',
    key: 'daemon:daemon-1:session:session-1',
    sessionId: 'session-1',
    seq: 1,
    timestamp: 1,
    messages: [{ role: 'user', content: 'hi', id: 'msg-1', timestamp: 1 } as any],
    status: 'idle',
    syncMode: 'full',
    replaceFrom: 0,
    totalMessages: 1,
    lastMessageSignature: 'sig-1',
    ...overrides,
  } as SessionChatTailUpdate
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

/**
 * Build a controller with an injectable clock, and deliver updates through the
 * SubscriptionManager exactly the way the live push lane does — so these tests
 * exercise the real `handleUpdate` stamping path rather than a stub.
 */
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
  const deliver = (update: Partial<SessionChatTailUpdate> = {}) => {
    manager.publish(createUpdate(update) as never)
  }
  return {
    controller,
    deliver,
    advance: (ms: number) => { clock += ms },
    now: () => clock,
  }
}

describe('chat tail liveness watchdog', () => {
  beforeEach(() => {
    resetSessionChatTailControllersForTest()
  })

  it('★ recovers a pane that stayed visible and simply stopped receiving updates', () => {
    // This is the owner-reported defect verbatim: the pane never changes
    // visibility (no edge ever fires again) and the push lane goes silent.
    const { controller, deliver, advance } = createHarness()
    deliver({ status: 'idle' })

    // Right after an update, nothing is owed.
    expect(controller.shouldRefreshForLiveness()).toBe(false)

    // Silence, with the pane still visible and no edge available to save it.
    advance(IDLE_QUIET_MS)

    // ★ Without the watchdog this stays false forever — the stale-forever bug.
    expect(controller.shouldRefreshForLiveness()).toBe(true)
  })

  it('uses a SHORT quiet period while generating and a LONG one while idle', () => {
    // Fixed short polling for every pane was explicitly rejected (RPC storm);
    // the threshold has to follow the state that makes silence suspicious.
    const busy = createHarness()
    busy.deliver({ status: 'generating' })
    busy.advance(BUSY_QUIET_MS - 1)
    expect(busy.controller.shouldRefreshForLiveness()).toBe(false)
    busy.advance(1)
    expect(busy.controller.shouldRefreshForLiveness()).toBe(true)

    resetSessionChatTailControllersForTest()

    const idle = createHarness()
    idle.deliver({ status: 'idle' })
    // An idle session silent for the BUSY window is normal, not stale.
    idle.advance(BUSY_QUIET_MS)
    expect(idle.controller.shouldRefreshForLiveness()).toBe(false)
    idle.advance(IDLE_QUIET_MS - BUSY_QUIET_MS)
    expect(idle.controller.shouldRefreshForLiveness()).toBe(true)
  })

  it('★ single-flight: 10 consecutive triggers produce exactly ONE read_chat', async () => {
    const { controller, deliver, advance } = createHarness()
    deliver({ status: 'generating' })
    advance(BUSY_QUIET_MS)

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetcher = vi.fn(async () => {
      await gate
      return null
    })

    // Ten watchdog ticks land while the first request is still in flight.
    //
    // ★ The clock is ADVANCED past the debounce window between every tick, on
    // purpose. Without that, `AUTHORITATIVE_TAIL_REFRESH_DEBOUNCE_MS` alone
    // absorbs all ten calls and this test passes even with the single-flight
    // guard deleted — it would be asserting the debounce, not single-flight.
    // Stepping the clock strips the debounce away so the in-flight guard is the
    // only thing left that can hold the count at one.
    const runs: Promise<void>[] = []
    for (let i = 0; i < 10; i += 1) {
      advance(AUTHORITATIVE_TAIL_REFRESH_DEBOUNCE_MS + 1)
      if (controller.shouldRefreshForLiveness()) {
        runs.push(controller.refreshAuthoritativeTail(fetcher))
      }
    }
    release?.()
    await Promise.all(runs)

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('backs off after a completed re-pull even when the response carried nothing', async () => {
    // A genuinely dead lane must cost ONE request per quiet period, not one per
    // tick — otherwise the watchdog degenerates into the fixed-interval poll it
    // was designed to avoid.
    const { controller, deliver, advance } = createHarness()
    deliver({ status: 'generating' })
    advance(BUSY_QUIET_MS)

    const fetcher = vi.fn(async () => null)
    await controller.refreshAuthoritativeTail(fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Clock reset by the completed pull: immediately after, nothing is owed.
    expect(controller.shouldRefreshForLiveness()).toBe(false)
    advance(BUSY_QUIET_MS - 1)
    expect(controller.shouldRefreshForLiveness()).toBe(false)
    advance(1)
    expect(controller.shouldRefreshForLiveness()).toBe(true)
  })

  it('backs off after a FAILED re-pull too', async () => {
    const { controller, deliver, advance } = createHarness()
    deliver({ status: 'generating' })
    advance(BUSY_QUIET_MS)

    const fetcher = vi.fn(async () => { throw new Error('daemon offline') })
    await controller.refreshAuthoritativeTail(fetcher)

    // An offline daemon must not be hammered once per tick.
    expect(controller.shouldRefreshForLiveness()).toBe(false)
  })

  it('treats discarded no-op updates as proof the lane is ALIVE', () => {
    // A session pushing updates we correctly discard (unchanged signature) is
    // healthy. Measuring quiet against "last APPLIED" instead of "last inbound"
    // would re-pull it needlessly, forever.
    const { controller, deliver, advance } = createHarness()
    deliver({ status: 'idle' })
    advance(IDLE_QUIET_MS - 1)

    // Identical payload — handleUpdate discards it as unchanged.
    deliver({ status: 'idle' })
    const applied = controller.getLivenessStateForTest()
    advance(2)

    // Still within quiet of the (discarded) inbound update.
    expect(controller.shouldRefreshForLiveness()).toBe(false)
    expect(applied.lastInboundAt).toBeGreaterThan(0)
  })

  it('★ never re-pulls while the transcript replica lane is healthy', () => {
    // Last-writer-wins hazard: a legacy read_chat landing after a newer replica
    // revision would overwrite current content with older content.
    const { controller, deliver, advance } = createHarness()
    deliver({ status: 'generating' })
    advance(BUSY_QUIET_MS * 10)
    expect(controller.shouldRefreshForLiveness()).toBe(true)

    controller.applyTranscriptReplicaSnapshot(
      replicaSnapshot({ revision: 5, messages: [replicaMessage('assistant', 'from replica', 10)] }),
      { omittedBefore: false },
    )
    // Sanity: the replica really did take over the pane (otherwise the refusal
    // below would pass vacuously).
    expect(controller.getSnapshot().transcriptReadSource).toBe('replica')

    // Replica healthy → refuse regardless of how long it has been quiet.
    advance(BUSY_QUIET_MS * 10)
    expect(controller.shouldRefreshForLiveness()).toBe(false)

    // ...and it re-arms once the replica lane reports a fallback, so a lost
    // replica does not leave the pane with no recovery path either.
    controller.reportTranscriptReplicaFallback('no_node')
    expect(controller.shouldRefreshForLiveness()).toBe(true)
  })

  it('does not fire before any update has ever arrived (mount pull owns that)', () => {
    const { controller, advance } = createHarness()
    advance(IDLE_QUIET_MS * 10)
    // No inbound ever → nothing to detect as "stopped"; firing here would race
    // the mount pull.
    expect(controller.shouldRefreshForLiveness()).toBe(false)
  })
})
