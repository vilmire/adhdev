import { afterEach, describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { ManualAttendanceTracker } from '../../src/providers/manual-attendance.js'

// NOTIF-APPROVAL-MASKED (Q1b) — a delegated worker's STALLED auto-approve modal must reach
// the mesh coordinator, decoupled from the dashboard visible-status mask.
//
// When auto-approve is configured but the episode never settles (a perpetually
// flapping/streaming prompt, or a modal that never parses), getState()/detectStatusTransition()
// fold the raw `waiting_approval` into `generating` to suppress dashboard flicker — so
// detectStatusTransition()'s waiting_approval arm never runs and NO agent:waiting_approval event
// is emitted. The coordinator's real-time approval-nudge delivery then has no input and the
// worker's stuck modal is never surfaced (the live ~25s stall). Once the episode ages past
// AUTO_APPROVE_MASK_STALL_MS, maybeEmitStalledApprovalNudge() emits the nudge exactly ONCE for a
// delegated worker session — the same moment the surface mask un-folds. A normally-resolving
// auto-approve fires long before the bound and emits nothing; a non-worker (foreground) session
// is never nudged (no coordinator to notify).
//
// These drive maybeAutoApproveStatus() directly with a manual `now` (Object.create skips the
// native backend), mirroring the mask-stall + settle-gate suites. pushEvent is stubbed to
// capture emissions.

const MASK_STALL_MS = 4500
// Worker flap-continuity window (AUTOAPPROVE-FLAP-RECUR Fix B): a delegated worker's
// settle+mask episode survives a busy/generating blip for this long before a modal
// that stays gone is treated as a genuine close. Kept in sync with
// CliProviderInstance.AUTO_APPROVE_FLAP_CONTINUITY_MS.
const FLAP_CONTINUITY_MS = 4000

const liveInstances: any[] = []

function makeHarness(opts: { worker?: boolean } = {}) {
  const worker = opts.worker !== false
  const events: any[] = []
  const fires: Array<{ message?: string }> = []
  const resolves: number[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = 'claude-cli'
  instance.provider = { name: 'Claude', settings: {} }
  instance.workingDir = '/work/repo'
  instance.instanceId = 'inst-1'
  instance.providerSessionId = ''
  instance.settings = worker
    ? { autoApprove: true, meshActiveTaskId: 'task-1', launchedByCoordinator: true }
    : { autoApprove: true }
  instance.autoApproveBusy = false
  instance.autoApproveBusyTimer = null
  instance.autoApproveSettleTimer = null
  instance.lastAutoApprovalSignature = ''
  instance.pendingAutoApprovalSignature = ''
  instance.pendingAutoApprovalSince = 0
  instance.autoApproveInactiveSince = 0
  instance.autoApproveMaskSince = 0
  instance.stalledApprovalNudgeEpisode = 0
  instance.manualAttendance = new ManualAttendanceTracker()
  instance.adapter = {
    resolveModal: (i: number) => resolves.push(i),
    getStatus: () => ({ status: 'idle' }),
    currentTurnTaskId: 'task-1',
  }
  instance.appendRuntimeSystemMessage = (content: string) => { fires.push({ message: content }) }
  instance.pushEvent = (event: any) => { events.push(event) }
  liveInstances.push(instance)
  return {
    instance,
    events,
    fires,
    resolves,
    call: (status: any, now: number) => instance.maybeAutoApproveStatus(status, now),
  }
}

afterEach(() => {
  for (const inst of liveInstances.splice(0)) {
    if (inst.autoApproveSettleTimer) clearTimeout(inst.autoApproveSettleTimer)
    if (inst.autoApproveBusyTimer) clearTimeout(inst.autoApproveBusyTimer)
  }
})

// Message varies per call → modal identity changes every frame → the settle clock restarts
// every call and never reaches SETTLE_MS: auto-approve can never fire and the episode stalls.
const UNSTABLE = (seq: number, msg: string) => ({
  status: 'waiting_approval',
  approvalEntrySeq: seq,
  activeModal: { message: msg, buttons: ['Yes', 'No'] },
})
// Constant identity → settles and fires within SETTLE_MS.
const STABLE = (seq: number) => ({
  status: 'waiting_approval',
  approvalEntrySeq: seq,
  activeModal: { message: 'Allow Bash command?', buttons: ['Yes', 'No'] },
})
const GENERATING = (seq = 9) => ({ status: 'generating', approvalEntrySeq: seq, activeModal: null })

const nudges = (events: any[]) => events.filter((e) => e.event === 'agent:waiting_approval')

describe('NOTIF-APPROVAL-MASKED: stalled auto-approve coordinator nudge', () => {
  it('emits agent:waiting_approval exactly ONCE for a delegated worker whose masked auto-approve stalls', () => {
    const h = makeHarness({ worker: true })

    // Fresh episode: mask clock armed, not yet stalled → no nudge.
    h.call(UNSTABLE(1, 'cmd A'), 1000)
    expect(h.instance.autoApproveMaskSince).toBe(1000)
    expect(nudges(h.events).length).toBe(0)

    // Still under the bound → no nudge.
    h.call(UNSTABLE(2, 'cmd B'), 1000 + MASK_STALL_MS)
    expect(nudges(h.events).length).toBe(0)

    // Past the bound → the mask un-folds and the coordinator nudge fires once, carrying the modal.
    h.call(UNSTABLE(3, 'cmd C'), 1000 + MASK_STALL_MS + 1)
    const fired = nudges(h.events)
    expect(fired.length).toBe(1)
    expect(fired[0].modalMessage).toBe('cmd C')
    expect(fired[0].modalButtons).toEqual(['Yes', 'No'])
    expect(fired[0].chatTitle).toBe('Claude · repo')
    expect(h.instance.stalledApprovalNudgeEpisode).toBe(1000)

    // Repeated stalled polls in the SAME episode must NOT re-emit.
    h.call(UNSTABLE(4, 'cmd D'), 1000 + MASK_STALL_MS + 3000)
    expect(nudges(h.events).length).toBe(1)
  })

  it('does NOT nudge when auto-approve resolves normally before the stall bound', () => {
    const h = makeHarness({ worker: true })
    h.call(STABLE(1), 1000)
    h.call(STABLE(1), 1700) // +700ms ≥ SETTLE_MS → auto-approve fires (recordAutoApproval)
    expect(h.fires.length).toBe(1)
    expect(h.instance.autoApproveMaskSince).toBe(0) // episode cleared on fire
    expect(nudges(h.events).length).toBe(0) // never stalled → coordinator sees no noise
  })

  it('does NOT nudge a non-worker (foreground) session even when the mask stalls', () => {
    const h = makeHarness({ worker: false })
    h.call(UNSTABLE(1, 'a'), 1000)
    h.call(UNSTABLE(2, 'b'), 1000 + MASK_STALL_MS + 1)
    expect(h.instance.autoApproveMaskStalled(1000 + MASK_STALL_MS + 1)).toBe(true) // stall reached...
    expect(nudges(h.events).length).toBe(0) // ...but no coordinator to notify → no emission
  })

  it('re-arms for a NEW stalled episode after the prior modal resolves', () => {
    const h = makeHarness({ worker: true })

    // Episode 1 stalls → nudge #1.
    h.call(UNSTABLE(1, 'a'), 1000)
    h.call(UNSTABLE(2, 'b'), 1000 + MASK_STALL_MS + 1)
    expect(nudges(h.events).length).toBe(1)

    // Modal genuinely goes away and STAYS gone past the worker flap-continuity window
    // (AUTO_APPROVE_FLAP_CONTINUITY_MS = 4000ms, measured from the first generating
    // frame) → the settle+mask episode ends, keys reset. The first generating frame
    // arms the continuity clock; the second, > 4000ms later, crosses it — this is a
    // genuine close, not a transient busy blip (which the continuity window bridges).
    h.call(GENERATING(3), 1000 + MASK_STALL_MS + 300)
    h.call(GENERATING(3), 1000 + MASK_STALL_MS + 300 + FLAP_CONTINUITY_MS + 20)
    expect(h.instance.autoApproveMaskSince).toBe(0)
    expect(h.instance.stalledApprovalNudgeEpisode).toBe(0)

    // Episode 2 arms fresh and stalls → nudge #2 (per-episode re-arm).
    const base = 20000
    h.call(UNSTABLE(4, 'c'), base)
    expect(nudges(h.events).length).toBe(1) // not yet stalled
    h.call(UNSTABLE(5, 'd'), base + MASK_STALL_MS + 1)
    expect(nudges(h.events).length).toBe(2)
  })
})
