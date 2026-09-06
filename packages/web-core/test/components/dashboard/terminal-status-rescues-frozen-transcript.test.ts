/**
 * (D1 + D3) ★ The surviving lane vouches for the dead one, and "quiet" means the
 * SCREEN is quiet — not that the wire is.
 *
 * ── The defect these pin ──────────────────────────────────────────────────
 * The chat-tail liveness watchdog was armed correctly (rc.86) and still could
 * not rescue a frozen pane, because the PULL DECISION was refused one line
 * later. Two independent traps did it:
 *
 * ① SELF-REFERENCE. `shouldRefreshForLiveness` refuses outright while
 *    `replicaHealthy` is true. The only thing that clears that flag is
 *    `expireStaleReplicaLease`, which returns early unless `lastReplicaBusyAt`
 *    is set — and that stamp is written ONLY from an inbound replica snapshot.
 *    So a replica lane that dies takes with it the very evidence that it died:
 *    the lease never arms, the veto never lifts, and a running watchdog is
 *    indistinguishable from an absent one.
 *
 * ② LANE TRAFFIC ≠ SCREEN PROGRESS. The quiet window was measured against
 *    `lastInboundAt`, which is stamped on EVERY inbound update before the apply
 *    decision (deliberately: a correctly-discarded no-op does prove the lane is
 *    alive). But repeated or regressing snapshots that change the rendered tail
 *    by nothing at all then hold the quiet clock at zero permanently, so the
 *    watchdog never fires on the one failure mode where nothing else can help.
 *
 * ── The escape hatch ──────────────────────────────────────────────────────
 * `onStatusEvent` and `onSnapshot` are sibling handlers on the SAME P2P
 * DataChannel (`p2p-manager.ts`). The owner's screenshot is the proof this is
 * exploitable: completion toasts kept arriving on the same screen as the frozen
 * transcript, so the status lane outlives the replica lane. A terminal status
 * event is therefore out-of-band evidence that this session settled, and it
 * cannot be silenced by the failure it reports on.
 *
 * ★ The bypass is scoped to that instant and no further. At a terminal event the
 * replica is by definition not producing, so the last-writer-wins race the veto
 * guards against is not open. Test ② below is the one that keeps this honest:
 * it asserts the veto is still doing its job in every other situation. Without
 * it, "the fix" would be indistinguishable from deleting the race protection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplicatedTranscriptSnapshotV1, SessionChatTailUpdate } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  getOrCreateSessionChatTailController,
  isTerminalChatTailStatusEvent,
  noteTerminalStatusEventForControllers,
  resetSessionChatTailControllersForTest,
} from '../../../src/components/dashboard/session-chat-tail-controller'

const DAEMON = 'daemon-1'
const SESSION = 'session-1'
const SUBSCRIPTION_KEY = `daemon:${DAEMON}:session:${SESSION}`

const BUSY_QUIET_MS = 20_000
const IDLE_QUIET_MS = 120_000

function createUpdate(overrides: Partial<SessionChatTailUpdate> = {}): SessionChatTailUpdate {
  return {
    topic: 'session.chat_tail',
    key: SUBSCRIPTION_KEY,
    sessionId: SESSION,
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

/** A replica snapshot carrying real content — enough to mark the lane healthy. */
function healthySnapshot(revision: number, status: string, ...contents: string[]) {
  return replicaSnapshot({
    revision,
    status: status as ReplicatedTranscriptSnapshotV1['status'],
    messages: contents.map((c, i) => replicaMessage(i % 2 === 0 ? 'user' : 'assistant', c, 10 + i)),
  })
}

function createHarness() {
  resetSessionChatTailControllersForTest()
  const manager = new SubscriptionManager()
  let clock = 1_000_000
  const controller = getOrCreateSessionChatTailController({
    manager,
    sendData: () => true,
    daemonId: DAEMON,
    sessionId: SESSION,
    subscriptionKey: SUBSCRIPTION_KEY,
    now: () => clock,
  })
  controller.retain()
  return {
    controller,
    deliver: (update: Partial<SessionChatTailUpdate> = {}) => {
      manager.publish(createUpdate(update) as never)
    },
    advance: (ms: number) => { clock += ms },
  }
}

/**
 * Drive the controller into the exact wedged state the owner observed: the
 * replica lane took over (legacy retired, `replicaHealthy` true) and then went
 * silent WITHOUT ever having reported itself busy — so the lease can never arm.
 */
function wedgeReplicaLane(h: ReturnType<typeof createHarness>) {
  h.deliver({ status: 'idle' })
  // Idle status, so `lastReplicaBusyAt` is never stamped. This is not a contrived
  // corner: a session whose snapshots arrive between turns, or whose busy
  // snapshot was itself the one that got lost, lands here.
  h.controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'idle', 'q', 'a'), {
    omittedBefore: false,
  })
  expect(h.controller.getSnapshot().transcriptReadSource).toBe('replica')
}

beforeEach(() => {
  resetSessionChatTailControllersForTest()
})

// ───────────────────────────────────────────────────────────────────────────
// ① ★ THE DEFECT — a terminal status event re-pulls a pane the veto had frozen.
// ───────────────────────────────────────────────────────────────────────────
describe('★ D1: the status lane rescues a transcript the replica lane abandoned', () => {
  it('★ refuses forever once the replica lane wedges — the state before the fix', () => {
    // Establishes that the trap is real and load-bearing, so ② is not measuring
    // an already-open door. No terminal event here.
    const h = createHarness()
    wedgeReplicaLane(h)

    // Silence far beyond every quiet threshold, and beyond the lease window too.
    h.advance(IDLE_QUIET_MS * 10)

    // ★ The lease cannot arm (`lastReplicaBusyAt === 0`), so the veto never
    // lifts. A running watchdog and an absent one are indistinguishable here.
    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(false)
  })

  it('★ a terminal status event makes the SAME wedged controller ask for a re-pull', () => {
    const h = createHarness()
    wedgeReplicaLane(h)
    h.advance(IDLE_QUIET_MS * 10)
    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(false)

    // The sibling lane reports the turn finished — the signal the replica lane
    // could not deliver because it is the thing that died.
    noteTerminalStatusEventForControllers(DAEMON, SESSION, 'agent:generating_completed')

    // ★ INJECTION POINT: delete the `terminalStatusRefreshPending` bypass in
    // `shouldRefreshForLiveness` and this flips to false — the pane stays frozen.
    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(true)
  })

  it('★ acts on the terminal event IMMEDIATELY, without waiting out a quiet window', () => {
    // A terminal event is evidence, not a guess. Making the user wait 20-120s
    // after the toast already fired is the frozen pane they reported.
    const h = createHarness()
    wedgeReplicaLane(h)

    // No time passes at all: the update landed a moment ago.
    noteTerminalStatusEventForControllers(DAEMON, SESSION, 'agent:generating_completed')
    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(true)
  })

  it('rescues both the pane and the warm inbox controller for one session', () => {
    // Prefix fan-out, same rationale as the replica delivery path: a session can
    // have a pane controller and a warm mobile controller alive at once.
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    let clock = 1_000_000
    const common = {
      manager,
      sendData: () => true,
      daemonId: DAEMON,
      sessionId: SESSION,
      now: () => clock,
    }
    const pane = getOrCreateSessionChatTailController({
      ...common,
      subscriptionKey: SUBSCRIPTION_KEY,
      historySessionId: 'history-1',
    })
    const warm = getOrCreateSessionChatTailController({
      ...common,
      subscriptionKey: SUBSCRIPTION_KEY,
    })
    expect(pane).not.toBe(warm)

    const notified = noteTerminalStatusEventForControllers(
      DAEMON,
      SESSION,
      'agent:generating_completed',
    )
    expect(notified).toBe(2)
  })

  it('ignores a terminal event for a DIFFERENT session', () => {
    const h = createHarness()
    wedgeReplicaLane(h)
    h.advance(IDLE_QUIET_MS * 10)

    noteTerminalStatusEventForControllers(DAEMON, 'some-other-session', 'agent:generating_completed')

    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ② ★ THE COUNTERWEIGHT — the veto must still protect every other case.
// ───────────────────────────────────────────────────────────────────────────
describe('★ D1 scope: `replicaHealthy` still vetoes outside the terminal instant', () => {
  it('★ still refuses a healthy replica lane after ANY amount of silence', () => {
    // Without this assertion the fix is indistinguishable from deleting the
    // last-writer-wins protection entirely.
    const h = createHarness()
    wedgeReplicaLane(h)
    h.advance(IDLE_QUIET_MS * 10)

    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(false)
  })

  it('★ does NOT bypass on a mid-generation status event', () => {
    // `agent:generating_started` is precisely the window where a legacy
    // read_chat can land behind a newer replica revision. Bypassing there would
    // reintroduce the hazard the veto exists for.
    const h = createHarness()
    wedgeReplicaLane(h)
    h.advance(IDLE_QUIET_MS * 10)

    noteTerminalStatusEventForControllers(DAEMON, SESSION, 'agent:generating_started')
    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(false)

    // Nor on the still-generating monitor events.
    noteTerminalStatusEventForControllers(DAEMON, SESSION, 'monitor:no_progress')
    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(false)
    noteTerminalStatusEventForControllers(DAEMON, SESSION, 'monitor:long_generating')
    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(false)
  })

  it('★ the bypass is ONE-SHOT — the veto is back on the very next tick', () => {
    // A standing exemption would leave the race window open for the rest of the
    // session. The latch is consumed, not latched.
    const h = createHarness()
    wedgeReplicaLane(h)
    h.advance(IDLE_QUIET_MS * 10)

    noteTerminalStatusEventForControllers(DAEMON, SESSION, 'agent:generating_completed')
    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(true)

    // ★ Next tick: the veto is doing its job again.
    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(false)
    h.advance(IDLE_QUIET_MS * 10)
    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(false)
  })

  it('parked-on-a-human states DO qualify — the agent is not producing there either', () => {
    // waiting_approval / waiting_choice are exactly when the user needs the tail:
    // the modal text is the thing being decided. The replica is not generating,
    // so the race window is equally closed.
    for (const event of ['agent:waiting_approval', 'agent:waiting_choice', 'agent:stopped']) {
      const h = createHarness()
      wedgeReplicaLane(h)
      noteTerminalStatusEventForControllers(DAEMON, SESSION, event)
      expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(true)
    }
  })

  it('the terminal-event predicate is the single definition of what qualifies', () => {
    expect(isTerminalChatTailStatusEvent('agent:generating_completed')).toBe(true)
    expect(isTerminalChatTailStatusEvent('agent:stopped')).toBe(true)
    expect(isTerminalChatTailStatusEvent('agent:waiting_approval')).toBe(true)
    expect(isTerminalChatTailStatusEvent('agent:waiting_choice')).toBe(true)

    expect(isTerminalChatTailStatusEvent('agent:generating_started')).toBe(false)
    expect(isTerminalChatTailStatusEvent('monitor:no_progress')).toBe(false)
    expect(isTerminalChatTailStatusEvent('monitor:long_generating')).toBe(false)
    expect(isTerminalChatTailStatusEvent(undefined)).toBe(false)
    expect(isTerminalChatTailStatusEvent(42)).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ③ ★ D3 — the quiet clock tracks the SCREEN, not the wire.
// ───────────────────────────────────────────────────────────────────────────
describe('★ D3: repeated no-op updates must not hold the quiet clock at zero', () => {
  it('★ a no-op update stream keeps the lane alive but does NOT postpone the watchdog', () => {
    // The legacy lane here is re-delivering a tail that changes nothing on
    // screen. Under `lastInboundAt` the quiet clock reset on every one of these
    // and the watchdog could never fire; under `lastAppliedAt` it does.
    const h = createHarness()
    h.deliver({ status: 'idle', seq: 1 })
    const applied = h.controller.getLivenessStateForTest().lastAppliedAt
    expect(applied).toBeGreaterThan(0)

    // Re-deliver the identical signature repeatedly across the whole quiet
    // window. Each one is inbound traffic; none of them changes the render.
    for (let i = 0; i < 12; i += 1) {
      h.advance(IDLE_QUIET_MS / 10)
      h.deliver({ status: 'idle', seq: 2 + i })
    }

    const state = h.controller.getLivenessStateForTest()
    // The lane IS alive, and `lastInboundAt` correctly says so — that field's
    // meaning is unchanged by this fix.
    expect(state.lastInboundAt).toBeGreaterThan(applied)
    // ★ But the screen has not moved since the first update.
    expect(state.lastAppliedAt).toBe(applied)

    // ★ INJECTION POINT: revert the quiet clock to `lastInboundAt` and this
    // flips to false — the frozen pane is never re-pulled.
    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(true)
  })

  it('an update that DOES change the screen postpones the watchdog as before', () => {
    // The counterweight for ③: real progress must still be treated as health,
    // or the watchdog degenerates into the fixed-interval poll it exists to
    // avoid.
    const h = createHarness()
    h.deliver({ status: 'idle', seq: 1 })

    for (let i = 0; i < 12; i += 1) {
      h.advance(IDLE_QUIET_MS / 10)
      h.deliver({
        status: 'idle',
        seq: 2 + i,
        messages: [
          { role: 'user', content: 'hi', id: 'msg-1', timestamp: 1 },
          { role: 'assistant', content: `answer-${i}`, id: `msg-a-${i}`, timestamp: 2 + i },
        ] as any,
        totalMessages: 2,
        lastMessageSignature: `sig-a-${i}`,
      })
    }

    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(false)
  })

  it('a dead lane still backs off to one pull per quiet period, not one per tick', () => {
    // `lastAppliedAt` does not advance on a re-pull that returns nothing — the
    // screen genuinely did not change — so the backoff needs its own stamp.
    // Without it the watchdog would re-qualify on every 5s tick: an RPC storm.
    const h = createHarness()
    h.deliver({ status: 'idle' })
    h.advance(IDLE_QUIET_MS)
    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(true)

    // The watchdog spends its pull; the daemon has nothing new to give.
    return h.controller
      .refreshAuthoritativeTail(async () => null, { force: true })
      .then(() => {
        h.advance(5_000) // one tick
        expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(false)
        h.advance(IDLE_QUIET_MS)
        expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(true)
      })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ④ ★ Single-flight — a burst of terminal events costs ONE read_chat.
// ───────────────────────────────────────────────────────────────────────────
describe('★ single-flight: consecutive terminal events do not stack read_chat calls', () => {
  it('★ spends exactly one read_chat for a burst of terminal events', async () => {
    const h = createHarness()
    wedgeReplicaLane(h)

    let resolveFetch: (v: SessionChatTailUpdate | null) => void = () => {}
    const fetcher = vi.fn(() => new Promise<SessionChatTailUpdate | null>((resolve) => {
      resolveFetch = resolve
    }))

    // Simulate the watchdog tick loop against a burst of terminal events. The
    // controller's existing `authoritativeRefreshPromise` guard is what must
    // hold here — nothing new was invented for this.
    const pulls: Promise<void>[] = []
    for (const event of [
      'agent:generating_completed',
      'agent:stopped',
      'agent:generating_completed',
      'agent:waiting_approval',
    ]) {
      noteTerminalStatusEventForControllers(DAEMON, SESSION, event)
      if (h.controller.shouldRefreshForLiveness({ visible: true })) {
        pulls.push(h.controller.refreshAuthoritativeTail(fetcher))
      }
    }

    // ★ One in-flight request, not four.
    expect(fetcher).toHaveBeenCalledTimes(1)

    resolveFetch(null)
    await Promise.all(pulls)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('★ shouldRefreshForLiveness refuses while a pull is already in flight', () => {
    // The single-flight guard sits AHEAD of the terminal bypass, so a terminal
    // event arriving mid-pull cannot punch through it.
    const h = createHarness()
    wedgeReplicaLane(h)

    let resolveFetch: (v: SessionChatTailUpdate | null) => void = () => {}
    const pull = h.controller.refreshAuthoritativeTail(
      () => new Promise<SessionChatTailUpdate | null>((resolve) => { resolveFetch = resolve }),
      { force: true },
    )

    noteTerminalStatusEventForControllers(DAEMON, SESSION, 'agent:generating_completed')
    expect(h.controller.shouldRefreshForLiveness({ visible: true })).toBe(false)

    resolveFetch(null)
    return pull
  })
})
