import { afterEach, describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { ManualAttendanceTracker } from '../../src/providers/manual-attendance.js'

// STATUS-MISMATCH — bound the auto-approve → `generating` SURFACE mask.
//
// getState()/getStatusMetadata() rewrite a worker's waiting_approval to `generating` and
// null its activeModal while auto-approve is "active", on the theory auto-approve will
// resolve the modal momentarily. But when auto-approve STALLS without ever calling
// resolveModal — the modal signature never settles for AUTO_APPROVE_SETTLE_MS (a
// perpetually-streaming/flapping prompt whose message keeps changing) — the mask would
// persist forever and read_chat/mesh_status/the dashboard would NEVER see the pending
// approval. The fix tracks the true age of the unresolved auto-approve episode
// (autoApproveMaskSince, which — unlike the per-signature settle clock — is NOT reset on a
// signature change and survives hysteresis blips) and, once it exceeds
// AUTO_APPROVE_MASK_STALL_MS, drops the mask (autoApproveMaskStalled() → true) so the real
// waiting_approval surfaces. These drive maybeAutoApproveStatus() directly with a manual
// `now` (Object.create skips the native backend), mirroring the settle-gate suite.

const SETTLE_MS = 600
const MASK_STALL_MS = 4500

const liveInstances: any[] = []

function makeHarness() {
  const fires: Array<{ message?: string }> = []
  const resolves: number[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = 'claude-cli'
  instance.provider = { name: 'Claude', settings: {} }
  instance.settings = { autoApprove: true }
  instance.autoApproveBusy = false
  instance.autoApproveBusyTimer = null
  instance.autoApproveSettleTimer = null
  instance.lastAutoApprovalSignature = ''
  instance.pendingAutoApprovalSignature = ''
  instance.pendingAutoApprovalSince = 0
  instance.autoApproveInactiveSince = 0
  instance.autoApproveMaskSince = 0
  instance.manualAttendance = new ManualAttendanceTracker()
  instance.adapter = {
    resolveModal: (i: number) => resolves.push(i),
    getStatus: () => ({ status: 'idle' }),
  }
  instance.appendRuntimeSystemMessage = (content: string) => { fires.push({ message: content }) }
  liveInstances.push(instance)
  return {
    instance,
    fires,
    resolves,
    call: (status: any, now: number) => instance.maybeAutoApproveStatus(status, now),
    stalled: (now: number) => instance.autoApproveMaskStalled(now) as boolean,
  }
}

afterEach(() => {
  for (const inst of liveInstances.splice(0)) {
    if (inst.autoApproveSettleTimer) clearTimeout(inst.autoApproveSettleTimer)
    if (inst.autoApproveBusyTimer) clearTimeout(inst.autoApproveBusyTimer)
  }
})

// An approval whose message varies per call → modal *identity* changes every frame → the
// settle clock restarts every call and never reaches SETTLE_MS (a streaming/flapping prompt
// that auto-approve can never settle on — the stall).
const UNSTABLE = (seq: number, msg: string) => ({
  status: 'waiting_approval',
  approvalEntrySeq: seq,
  activeModal: { message: msg, buttons: ['Yes', 'No'] },
})
const STABLE = (seq: number) => ({
  status: 'waiting_approval',
  approvalEntrySeq: seq,
  activeModal: { message: 'Allow Bash command?', buttons: ['Yes', 'No'] },
})
const GENERATING = (seq = 9) => ({ status: 'generating', approvalEntrySeq: seq, activeModal: null })

describe('STATUS-MISMATCH: auto-approve mask-stall bound', () => {
  it('sets the mask-stall clock on first active observation and does NOT reset it on signature change', () => {
    const h = makeHarness()
    h.call(UNSTABLE(1, 'cmd A'), 1000)
    expect(h.instance.autoApproveMaskSince).toBe(1000)
    expect(h.fires.length).toBe(0)

    // New message → new settle signature → settle clock restarts, but the mask clock does NOT.
    h.call(UNSTABLE(2, 'cmd B'), 3000)
    expect(h.instance.autoApproveMaskSince).toBe(1000)
    expect(h.instance.pendingAutoApprovalSince).toBe(3000) // settle clock did restart
    expect(h.fires.length).toBe(0)
  })

  it('does NOT report stalled before the bound, and DOES once the episode exceeds it', () => {
    const h = makeHarness()
    h.call(UNSTABLE(1, 'a'), 1000)
    expect(h.stalled(1000)).toBe(false)
    expect(h.stalled(1000 + MASK_STALL_MS)).toBe(false) // exactly at bound — not yet
    h.call(UNSTABLE(2, 'b'), 1000 + MASK_STALL_MS + 1)
    expect(h.stalled(1000 + MASK_STALL_MS + 1)).toBe(true) // surfaced past the bound
    expect(h.fires.length).toBe(0) // never auto-approved (unstable prompt)
  })

  it('a stable prompt settles + fires BEFORE the stall bound and clears the mask clock', () => {
    const h = makeHarness()
    h.call(STABLE(1), 1000)
    expect(h.instance.autoApproveMaskSince).toBe(1000)
    h.call(STABLE(1), 1700) // +700ms ≥ SETTLE_MS → fire
    expect(h.fires.length).toBe(1)
    expect(h.instance.autoApproveMaskSince).toBe(0) // cleared on fire
    expect(h.stalled(1700)).toBe(false)
  })

  it('mask clock survives a hysteresis generating blip (measures true episode age)', () => {
    const h = makeHarness()
    h.call(STABLE(1), 1000)
    expect(h.instance.autoApproveMaskSince).toBe(1000)
    h.call(GENERATING(2), 1300) // brief flip within hysteresis
    expect(h.instance.autoApproveMaskSince).toBe(1000) // preserved
  })

  it('mask clock clears once the modal has genuinely stayed gone past the hysteresis bound', () => {
    const h = makeHarness()
    h.call(STABLE(1), 1000)
    h.call(GENERATING(2), 1300)
    h.call(GENERATING(2), 3000) // gone past 1300 + 1500 → real resolution
    expect(h.instance.autoApproveMaskSince).toBe(0)
  })

  it('constant: AUTO_APPROVE_MASK_STALL_MS is generously larger than settle + hysteresis', () => {
    const cap = (CliProviderInstance as any).AUTO_APPROVE_MASK_STALL_MS
    expect(cap).toBe(MASK_STALL_MS)
    expect(cap).toBeGreaterThan(
      (CliProviderInstance as any).AUTO_APPROVE_SETTLE_MS
      + (CliProviderInstance as any).AUTO_APPROVE_GATE_HYSTERESIS_MS,
    )
  })
})
