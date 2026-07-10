import { afterEach, describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { ManualAttendanceTracker } from '../../src/providers/manual-attendance.js'

// AUTOAPPROVE-FLAP-RECUR — a delegated worker whose Bash-approval FSM cycles the
// FULL state waiting_approval → busy → waiting_approval on a MULTI-SECOND period
// (not just a sub-hysteresis blip), and whose captured button block flaps
// modal=none ↔ N-buttons around the settle boundary, must still auto-approve on
// its own and NEVER page the coordinator (agent:waiting_approval nudge).
//
// Root cause this guards (two vectors):
//   Vector 1 (modal=none early bail): the buttons.length===0 guard used to bail
//     immediately on a button scroll-out frame — never advancing the settle gate
//     and arming no re-check. Fix A keeps the gate warm against the last-captured
//     modal for a bounded continuity window, treating a short scroll-out as a blip
//     rather than a close.
//   Vector 2 (FSM full-state cycling): a busy phase longer than the tight 1500ms
//     hysteresis wiped the settle clock, so the 600ms window never accumulated
//     across the flap and resolveModal fired 0 times → the mask-stall clock tripped
//     → coordinator nudge. Fix B widens the settle-continuity window to
//     AUTO_APPROVE_FLAP_CONTINUITY_MS for an ACTIVE delegated-worker mask episode.
//     The continuity/mask-stall constants must satisfy MASK_STALL_MS >
//     FLAP_CONTINUITY_MS + max_busy_phase + SETTLE_MS against the observed geometry
//     (approval ~1.5s, busy ~4.3–4.5s) so a bridged flap never leaks a nudge.
//   Fix C: even if the mask-stall bound trips, a concrete modal + in-progress
//     settle defers to the imminent fire rather than paging the coordinator.
//
// Exercises maybeAutoApproveStatus() directly (Object.create to skip the native
// terminal backend), driving `now` manually so the settle math is deterministic.

const FLAP_CONTINUITY_MS = 6000
const MASK_STALL_MS = 10500

type Harness = {
  instance: any
  fires: Array<{ message?: string }>
  resolves: number[]
  events: any[]
  call: (status: any, now: number) => void
}

const liveInstances: any[] = []

function makeHarness(settingsOverride?: Record<string, unknown>): Harness {
  const fires: Array<{ message?: string }> = []
  const resolves: number[] = []
  const events: any[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = 'claude-cli'
  instance.provider = { name: 'Claude', settings: {} }
  // Mesh worker markers: enables the extended flap-continuity window AND the
  // stalled-approval coordinator nudge path (both gated on isMeshWorkerSession).
  instance.settings = { autoApprove: true, meshActiveTaskId: 'task_abc', ...settingsOverride }
  instance.workingDir = '/tmp/worker-workspace'
  instance.autoApproveBusy = false
  instance.autoApproveBusyTimer = null
  instance.autoApproveSettleTimer = null
  instance.lastAutoApprovalSignature = ''
  instance.pendingAutoApprovalSignature = ''
  instance.pendingAutoApprovalSince = 0
  instance.autoApproveInactiveSince = 0
  instance.autoApproveMaskSince = 0
  instance.stalledApprovalNudgeEpisode = 0
  instance.autoApproveLastModalSeenAt = 0
  instance.manualAttendance = new ManualAttendanceTracker()
  instance.adapter = {
    resolveModal: (i: number) => resolves.push(i),
    getStatus: () => ({ status: 'idle' }),
  }
  instance.appendRuntimeSystemMessage = (content: string) => { fires.push({ message: content }) }
  instance.pushEvent = (evt: any) => { events.push(evt) }
  liveInstances.push(instance)
  return {
    instance,
    fires,
    resolves,
    events,
    call: (status: any, now: number) => instance.maybeAutoApproveStatus(status, now),
  }
}

afterEach(() => {
  for (const inst of liveInstances.splice(0)) {
    if (inst.autoApproveSettleTimer) clearTimeout(inst.autoApproveSettleTimer)
    if (inst.autoApproveBusyTimer) clearTimeout(inst.autoApproveBusyTimer)
  }
})

const MESSAGE = 'Allow Bash command `npm test`?'
const BUTTONS = ['1. Yes', '2. Yes, allow during this session', '3. No']
const APPROVAL = (seq: number, buttons = BUTTONS) => ({
  status: 'waiting_approval',
  approvalEntrySeq: seq,
  activeModal: { kind: 'approval', message: MESSAGE, buttons },
})
// The button block scrolled out of the captured frame — still waiting_approval,
// but activeModal is null (Vector 1).
const APPROVAL_NO_MODAL = (seq: number) => ({
  status: 'waiting_approval',
  approvalEntrySeq: seq,
  activeModal: null,
})
// A genuine multi-second busy phase between approval frames (Vector 2).
const GENERATING = (seq = 9) => ({ status: 'generating', approvalEntrySeq: seq, activeModal: null })

const isNudge = (evt: any) => evt?.event === 'agent:waiting_approval'

describe('cli-provider auto-approve — AUTOAPPROVE-FLAP-RECUR', () => {
  it('Vector 2: a busy phase POLLED across multiple frames past 1500ms does NOT wipe the settle clock for a worker episode', () => {
    const h = makeHarness()

    // Approval captured — settle clock + mask clock start.
    h.call(APPROVAL(1), 1000)
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)
    expect(h.instance.autoApproveMaskSince).toBe(1000)

    // The PTY heartbeat/getState polls REPEATEDLY during a multi-second busy phase.
    // The FIRST busy frame arms inactiveSince; a later busy frame measures
    // goneForMs from it. Pre-fix, once goneForMs crossed the tight 1500ms
    // hysteresis the settle clock (and the mask clock) were WIPED — the flap never
    // accumulated 600ms and resolveModal fired 0 times. The 4000ms flap-continuity
    // window (worker episode alive) keeps both clocks warm across the whole phase.
    h.call(GENERATING(2), 1400) // inactiveSince = 1400
    h.call(GENERATING(3), 3200) // goneForMs = 1800 > 1500 hysteresis, < 6000 continuity
    expect(h.instance.pendingAutoApprovalSince).toBe(1000) // NOT wiped
    expect(h.instance.autoApproveMaskSince).toBe(1000)     // NOT wiped

    // Approval returns; cumulative settle (now − 1000 = 2400ms) ≥ 600 → single fire.
    h.call(APPROVAL(4), 3400)
    expect(h.fires.length).toBe(1)
    expect(h.instance.autoApproveMaskSince).toBe(0) // episode resolved
  })

  it('Vector 1: a modal=none scroll-out frame keeps the settle gate AND arms a re-check so a silent PTY still fires', () => {
    const h = makeHarness()

    h.call(APPROVAL(1), 1000)
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)
    const sig = h.instance.pendingAutoApprovalSignature
    expect(h.instance.autoApproveLastModalSeenAt).toBe(1000)

    // Button block scrolls out — activeModal null — 300ms in. The settle gate MUST
    // survive AND a re-check timer MUST be armed: the PTY can go silent after the
    // scroll-out, so this timer is the only thing that re-drives the fire. Pre-fix
    // the buttons.length===0 guard bailed here with no timer armed, so a modal that
    // finished settling during a scroll-out silence never fired on its own.
    h.instance.autoApproveSettleTimer = null // simulate no timer currently armed
    h.call(APPROVAL_NO_MODAL(2), 1300)
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)
    expect(h.instance.pendingAutoApprovalSignature).toBe(sig)
    expect(h.instance.autoApproveSettleTimer).not.toBeNull() // re-check armed
    expect(h.fires.length).toBe(0)

    // Buttons repaint; cumulative settle (700ms) ≥ 600 → single fire.
    h.call(APPROVAL(3), 1700)
    expect(h.fires.length).toBe(1)
  })

  it('combined flap (none ↔ buttons + multi-second busy) fires ONCE and never nudges the coordinator', () => {
    const h = makeHarness()

    h.call(APPROVAL(1), 1000)          // capture, settle starts
    h.call(APPROVAL_NO_MODAL(2), 1400) // scroll-out blip
    h.call(GENERATING(3), 2200)        // 800ms busy phase
    h.call(APPROVAL(4), 3000)          // approval back, 2000ms cumulative ≥ 600 → fire
    expect(h.fires.length).toBe(1)

    // No coordinator nudge was ever emitted (mask-stall never tripped; auto-approve
    // resolved on its own).
    expect(h.events.filter(isNudge).length).toBe(0)
    expect(h.instance.autoApproveMaskSince).toBe(0)
  })

  it('behavior preserved: a modal that GENUINELY closes past the continuity window resets the settle gate', () => {
    const h = makeHarness()

    h.call(APPROVAL(1), 1000)
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)

    // Buttons gone and stay gone past the 6000ms continuity window — this is a
    // real close, not a blip. Approaching via modal=none while status is somehow
    // still waiting_approval: last-good-modal was 1000, now 7200 → 6200ms > 6000.
    h.call(APPROVAL_NO_MODAL(2), 7200)
    expect(h.instance.pendingAutoApprovalSince).toBe(0) // gate reset
    expect(h.fires.length).toBe(0)
  })

  it('behavior preserved: a worker approval that NEVER captures a modal still pages the coordinator at mask-stall', () => {
    const h = makeHarness()

    // waiting_approval reported, but the modal is never captured (parse miss the
    // whole time). The settle gate never engages (pendingAutoApprovalSince stays 0),
    // so Fix C does not suppress the nudge; the mask-stall bound trips and pages once.
    h.call(APPROVAL_NO_MODAL(1), 1000)
    expect(h.instance.autoApproveMaskSince).toBe(1000)

    h.call(APPROVAL_NO_MODAL(2), 1000 + MASK_STALL_MS + 10)
    expect(h.events.filter(isNudge).length).toBe(1)
    expect(h.fires.length).toBe(1) // the approval_request runtime message
  })

  it('Fix C: a captured modal mid-settle at mask-stall defers to the fire instead of nudging', () => {
    const h = makeHarness()

    // Keep the episode alive with a captured modal that keeps re-settling just shy
    // of firing, pushing the mask clock past the stall bound WITHOUT ever firing —
    // then a concrete modal + in-progress settle must suppress the nudge.
    h.call(APPROVAL(1), 1000) // mask + settle start at 1000
    // Jump the mask clock past the stall bound while a concrete modal is present
    // and the settle gate is in progress. pendingAutoApprovalSince is non-zero and
    // buttons are present → Fix C defers to the imminent fire.
    const past = 1000 + MASK_STALL_MS + 10
    // Signature unchanged, so settle accumulates → this call actually FIRES; assert
    // it fired and did NOT emit a nudge.
    h.call(APPROVAL(2), past)
    expect(h.events.filter(isNudge).length).toBe(0)
    expect(h.fires.length).toBe(1)
  })
})

describe('cli-provider auto-approve — FLAP-RECUR constants', () => {
  it('flap-continuity window sits between the tight hysteresis and the mask-stall bound', () => {
    const flap = (CliProviderInstance as any).AUTO_APPROVE_FLAP_CONTINUITY_MS
    const hyst = (CliProviderInstance as any).AUTO_APPROVE_GATE_HYSTERESIS_MS
    const mask = (CliProviderInstance as any).AUTO_APPROVE_MASK_STALL_MS
    expect(flap).toBe(FLAP_CONTINUITY_MS)
    expect(flap).toBeGreaterThan(hyst)
    expect(flap).toBeLessThan(mask)
  })

  it('mask-stall bound satisfies invariant for coordinator busy phase (2.85s): CONTINUITY + busy + SETTLE < MASK_STALL', () => {
    const mask = (CliProviderInstance as any).AUTO_APPROVE_MASK_STALL_MS
    const coordinatorBusyMs = 2850
    expect(FLAP_CONTINUITY_MS + coordinatorBusyMs + 600).toBeLessThan(mask)
  })
})

// AUTOAPPROVE-FLAP-RECUR defect A: the coordinator's own claude-cli session
// (settings: { meshCoordinatorFor } with NO worker flags) previously got the
// tight 1500ms continuity window because autoApproveContinuityWindowMs() only
// checked isMeshWorkerSession(). A coordinator busy phase of ~2.85s exceeded
// 1500ms → settle clock torn down → resolveModal never fired → mask-stall
// tripped → spurious agent:waiting_approval surfaced.
//
// Fix: gate on isAutonomousMeshSession() (worker || meshCoordinatorFor) so the
// coordinator's own session gets the 6000ms window exactly like a worker.
describe('cli-provider auto-approve — coordinator self-session continuity (defect A)', () => {
  // Creates a harness that mimics a coordinator's own claude-cli session:
  // meshCoordinatorFor is set; NO worker flags (meshActiveTaskId / meshNodeFor /
  // meshNodeId / launchedByCoordinator are absent).
  function makeCoordinatorHarness(): Harness {
    return makeHarness({ meshActiveTaskId: undefined, meshCoordinatorFor: 'coord_session_xyz' })
  }

  it('coordinator session gets 6000ms continuity window: busy phase of 2850ms does NOT wipe the settle clock', () => {
    const h = makeCoordinatorHarness()

    h.call(APPROVAL(1), 1000)
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)
    expect(h.instance.autoApproveMaskSince).toBe(1000)

    // Coordinator busy phase: 2850ms > 1500ms tight hysteresis, < 6000ms continuity.
    // Pre-fix (isMeshWorkerSession gate): coordinator took the tight 1500ms window
    // → inactiveSince armed, then goneForMs=2000 crossed 1500 → settle wiped.
    // Post-fix (isAutonomousMeshSession gate): coordinator takes the 6000ms window
    // → settle clock survives the whole busy phase.
    h.call(GENERATING(2), 1400) // inactiveSince = 1400
    h.call(GENERATING(3), 3400) // goneForMs = 2000 > 1500 but < 6000 → NOT wiped
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)
    expect(h.instance.autoApproveMaskSince).toBe(1000)

    // Approval returns; cumulative settle (3600 − 1000 = 2600ms) ≥ 600 → fires.
    h.call(APPROVAL(4), 3600)
    expect(h.fires.length).toBe(1)
    expect(h.instance.autoApproveMaskSince).toBe(0)
    expect(h.events.filter(isNudge).length).toBe(0)
  })

  it('coordinator session resolves on approval return after multi-frame busy and never nudges', () => {
    const h = makeCoordinatorHarness()

    h.call(APPROVAL(1), 1000)
    h.call(GENERATING(2), 1400)
    h.call(GENERATING(3), 2800) // 1400ms into busy
    h.call(GENERATING(4), 3500) // 2100ms into busy > 1500 tight, < 6000 continuity
    h.call(APPROVAL(5), 4200)   // approval back, 3200ms cumulative ≥ 600 → fire
    expect(h.fires.length).toBe(1)
    expect(h.events.filter(isNudge).length).toBe(0)
    expect(h.instance.autoApproveMaskSince).toBe(0)
  })

  it('worker session regression: meshActiveTaskId still gets 6000ms continuity window', () => {
    // Ensure the existing worker path is unaffected by the isAutonomousMeshSession change.
    const h = makeHarness() // default: meshActiveTaskId = 'task_abc'
    h.call(APPROVAL(1), 1000)
    h.call(GENERATING(2), 1400)
    h.call(GENERATING(3), 3200) // 1800ms > 1500 hysteresis
    expect(h.instance.pendingAutoApprovalSince).toBe(1000) // still warm
    h.call(APPROVAL(4), 3400)
    expect(h.fires.length).toBe(1)
    expect(h.events.filter(isNudge).length).toBe(0)
  })

  it('foreground session (no mesh flags) still gets the tight 1500ms window', () => {
    // Non-mesh session must NOT get the extended window — tight hysteresis preserved.
    const h = makeHarness({ meshActiveTaskId: undefined, meshCoordinatorFor: undefined })
    h.call(APPROVAL(1), 1000)
    h.call(GENERATING(2), 1400)         // inactiveSince = 1400
    h.call(GENERATING(3), 3200)         // goneForMs = 1800 > 1500 → settle wiped for foreground
    expect(h.instance.pendingAutoApprovalSince).toBe(0) // reset for foreground
  })
})
