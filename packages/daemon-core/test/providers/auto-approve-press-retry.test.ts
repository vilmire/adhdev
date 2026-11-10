/**
 * Live defect (codex-cli worker, PTY auto-approve): the approval was detected with 3 buttons,
 * the screen redrew ~120 ms later and the modal parse went to `none`, so the auto-approve press
 * resolved against an empty modal ("matched no button"). The FSM stayed in `approval`, the
 * adapter projected `generating` (modal-less approval), the mask hid it, and resolve_action
 * answered "Not in approval state". The press must re-read the live modal and retry, and a
 * surrender must unmask + give the coordinator an actionable approval.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { ManualAttendanceTracker } from '../../src/providers/manual-attendance.js'
import { APPROVAL_PRESS_RETRY_DELAYS_MS, APPROVAL_SETTLE_MS } from '../../src/providers/completion/approval-gate.js'

const BUTTONS = ['Yes, proceed (y)', 'Yes, and don\'t ask again for this command (p)', 'No, and tell Codex what to do differently (esc)']
const modal = { message: 'Would you like to run the following command?\n$ npm test', buttons: BUTTONS, kind: 'approval' }
const approvalStatus = { status: 'waiting_approval', approvalEntrySeq: 1, activeModal: modal }
const live: any[] = []

function harness(_opts: Record<string, never> = {}) {
  const events: any[] = []
  const messages: string[] = []
  const presses: number[] = []
  let screenModal: typeof modal | null = null // the redrawn screen: modal parse is empty
  let latched: typeof modal | null = null
  const instance = Object.create(CliProviderInstance.prototype) as any
  Object.assign(instance, {
    type: 'codex-cli', instanceId: 's1', workingDir: '/work/wt',
    provider: { name: 'Codex', settings: {} }, settings: { autoApprove: true },
    autoApproveBusy: false, autoApproveBusyTimer: null, autoApproveSettleTimer: null,
    lastAutoApprovalSignature: '', pendingAutoApprovalSignature: '', pendingAutoApprovalSince: 0,
    autoApproveInactiveSince: 0, autoApproveMaskSince: 0, stalledApprovalNudgeEpisode: 0,
    autoApproveLastModalSeenAt: 0, lastAutoApproveFiredAt: 0,
    manualAttendance: new ManualAttendanceTracker(),
  })
  instance.isMeshWorkerSession = () => true
  instance.isAutonomousMeshSession = () => true
  instance.appendRuntimeSystemMessage = (c: string) => { messages.push(c) }
  instance.pushEvent = (e: any) => { events.push(e) }
  instance.adapter = {
    getLastApprovalResolvedAt: () => 0,
    isFsmApprovalState: () => true,
    // A real refresh re-parses the (stable) screen into the latch.
    refreshModalNow: () => { latched = screenModal; return !!latched },
    getStatus: () => latched ? { ...approvalStatus, activeModal: latched } : { status: 'generating', activeModal: null },
    resolveModalMatched: (i: number) => {
      if (!latched || i < 0 || i >= latched.buttons.length) return false
      presses.push(i)
      return true
    },
  }
  live.push(instance)
  return { instance, events, messages, presses, reappear: () => { screenModal = modal }, showOther: (m: typeof modal) => { screenModal = m } }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  for (const i of live.splice(0)) { clearTimeout(i.autoApproveSettleTimer); clearTimeout(i.autoApproveBusyTimer) }
  vi.useRealTimers()
})

async function detectAndFire(instance: any) {
  const t0 = Date.now()
  instance.maybeAutoApproveStatus(approvalStatus, t0)
  vi.advanceTimersByTime(APPROVAL_SETTLE_MS + 10)
  instance.maybeAutoApproveStatus(approvalStatus, t0 + APPROVAL_SETTLE_MS + 10) // fires; press runs against empty latch
  vi.advanceTimersByTime(1)
}

describe('auto-approve press with a vanished modal', () => {
  it('a retry never presses a DIFFERENT prompt than the one the gate authorized', async () => {
    const h = harness()
    await detectAndFire(h.instance)
    // The screen now shows another consent prompt (different question) — not the authorized one.
    h.showOther({ ...modal, message: 'Would you like to run the following command?\n$ rm -rf build' })
    for (const d of APPROVAL_PRESS_RETRY_DELAYS_MS) vi.advanceTimersByTime(d + 5)
    expect(h.presses).toEqual([])
  })

  it('a retry never presses a sign-in / credential prompt', async () => {
    const h = harness()
    await detectAndFire(h.instance)
    h.showOther({ ...modal, buttons: ['1. Sign in with your account', 'No'] })
    for (const d of APPROVAL_PRESS_RETRY_DELAYS_MS) vi.advanceTimersByTime(d + 5)
    expect(h.presses).toEqual([])
  })

  it('re-reads the live modal and retries: the redrawn prompt is approved', async () => {
    const h = harness()
    await detectAndFire(h.instance)
    expect(h.presses).toEqual([])
    vi.advanceTimersByTime(APPROVAL_PRESS_RETRY_DELAYS_MS[0]) // 300ms: screen still blank
    expect(h.presses).toEqual([])
    h.reappear()
    vi.advanceTimersByTime(APPROVAL_PRESS_RETRY_DELAYS_MS[1]) // +800ms: modal parses again
    expect(h.presses).toEqual([0])
    expect(h.instance.autoApproveSurrenderedAt || 0).toBe(0)
    vi.advanceTimersByTime(10_000)
    expect(h.events).toEqual([])
  })

  it('retries exhausted: unmasks, exposes waiting_approval + buttons, and pages the coordinator', async () => {
    const h = harness()
    await detectAndFire(h.instance)
    for (const d of APPROVAL_PRESS_RETRY_DELAYS_MS) vi.advanceTimersByTime(d)
    expect(h.presses).toEqual([])
    expect(h.instance.autoApproveSurrenderedAt).toBeGreaterThan(0)
    // The screen finally parses again: status is no longer masked behind `generating`.
    ;(h.instance.adapter as any).refreshModalNow = () => true
    h.instance.adapter.getStatus = () => approvalStatus
    const active = h.instance.maybeAutoApproveStatus(approvalStatus, Date.now())
    expect(active).toBe(false)
    const state = h.instance.autoApproveMaskStalled(Date.now())
    expect(state).toBe(false)
    // No modal was parseable at surrender time → the coordinator got a direct approval notice.
    expect(h.events.filter(e => e.event === 'agent:waiting_approval')).toHaveLength(1)
    expect(h.messages.filter(m => /run the following command/.test(m))).toHaveLength(1)
  })

  it('retries exhausted but modal parsed at surrender: status path surfaces it (no duplicate direct notice)', async () => {
    const h = harness()
    await detectAndFire(h.instance)
    // Modal reappears only in the final refresh (screen was blank for every earlier press).
    let calls = 0
    h.instance.adapter.refreshModalNow = () => { calls++; return false }
    const base = h.instance.adapter.getStatus
    h.instance.adapter.getStatus = () => calls > APPROVAL_PRESS_RETRY_DELAYS_MS.length ? approvalStatus : base()
    for (const d of APPROVAL_PRESS_RETRY_DELAYS_MS) vi.advanceTimersByTime(d)
    expect(h.events).toEqual([])
    expect(h.instance.maybeAutoApproveStatus(approvalStatus, Date.now())).toBe(false)
  })
})
