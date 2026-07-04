import { afterEach, describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { ManualAttendanceTracker } from '../../src/providers/manual-attendance.js'

// AUTOAPPROVE-SETTLE-FLAP — the settle signature must anchor on the modal
// message plus the STABLE (normalized) affirmative label only, never the raw
// button set.
//
// Root cause this guards: on a TALL Write/Edit diff claude's TUI repaints the
// button block between frames — the captured region shows 3 buttons one frame,
// 5 the next (a "Yes, allow … this session" / "Always allow" / "Cancel" scroll
// in and out), while the underlying consent question and the affirmative the
// auto-approve will press ("Yes") are invariant. The old signature folded in
// buttons.join('|') and the positional buttonIndex, so every repaint minted a
// new signature → the 600ms settle clock restarted → firing was delayed 4–9s
// and only mask-stalled episodes leaked a coordinator relay. Anchoring on the
// normalized affirmative label collapses the flap to one settle clock.
//
// Exercises maybeAutoApproveStatus() directly (Object.create to skip the native
// terminal backend), driving `now` manually so the settle math is deterministic.

const SETTLE_MS = 600

type Harness = {
  instance: any
  fires: Array<{ message?: string }>
  resolves: number[]
  call: (status: any, now: number) => void
}

const liveInstances: any[] = []

function makeHarness(): Harness {
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
  }
}

afterEach(() => {
  for (const inst of liveInstances.splice(0)) {
    if (inst.autoApproveSettleTimer) clearTimeout(inst.autoApproveSettleTimer)
    if (inst.autoApproveBusyTimer) clearTimeout(inst.autoApproveBusyTimer)
  }
})

const MESSAGE = 'Edit src/very/large/file.ts — apply this diff?'
// The three button-set shapes a tall Write/Edit diff cycles through as its
// button block scrolls in and out of the captured frame. All three keep the
// same picked affirmative ("Yes" via pickApprovalButton) and a reliable consent
// anchor (a No/decline, or a scoped grant-affirmative that stands in for an
// off-frame decline), so all three must yield ONE stable settle signature.
const BUTTONS_3 = ['1. Yes', '2. Yes, allow during this session', '3. No']
const BUTTONS_5 = [
  '1. Yes',
  '2. Yes, allow during this session',
  '3. No',
  '4. Always allow',
  '5. Cancel',
]
const APPROVAL = (seq: number, buttons: string[], message = MESSAGE) => ({
  status: 'waiting_approval',
  approvalEntrySeq: seq,
  activeModal: { kind: 'approval', message, buttons },
})

describe('cli-provider auto-approve settle — button-set flap stability', () => {
  it('does not restart the 600ms settle clock when the button set flaps 3↔5↔3 (message + affirmative unchanged)', () => {
    const h = makeHarness()

    h.call(APPROVAL(1, BUTTONS_3), 1000) // clock starts at 1000
    expect(h.fires.length).toBe(0)
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)
    const sigAfter3 = h.instance.pendingAutoApprovalSignature

    // Button block repaints to 5 entries (+ a bumped seq). Old code changed
    // buttons.join('|') and the positional buttonIndex, restarting the clock.
    h.call(APPROVAL(2, BUTTONS_5), 1400)
    expect(h.fires.length).toBe(0)
    expect(h.instance.pendingAutoApprovalSince).toBe(1000) // NOT restarted
    expect(h.instance.pendingAutoApprovalSignature).toBe(sigAfter3) // identity unchanged

    // Repaints back to 3.
    h.call(APPROVAL(3, BUTTONS_3), 1550)
    expect(h.fires.length).toBe(0)
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)
    expect(h.instance.pendingAutoApprovalSignature).toBe(sigAfter3)

    // Cumulative 700ms ≥ 600 → single fire despite the flapping button set.
    h.call(APPROVAL(4, BUTTONS_5), 1700)
    expect(h.fires.length).toBe(1)
  })

  it('signature does change when the consent MESSAGE differs (no over-collapse / false positive)', () => {
    const h = makeHarness()

    h.call(APPROVAL(1, BUTTONS_3, 'Edit fileA.ts?'), 1000)
    const sigA = h.instance.pendingAutoApprovalSignature
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)

    // A genuinely different consent question (distinct file) must NOT reuse the
    // prior settle clock — its identity differs so the clock restarts.
    h.call(APPROVAL(2, BUTTONS_3, 'Edit fileB.ts?'), 1300)
    const sigB = h.instance.pendingAutoApprovalSignature
    expect(sigB).not.toBe(sigA)
    expect(h.instance.pendingAutoApprovalSince).toBe(1300) // restarted for the new modal
  })

  it('signature does change when the picked affirmative differs (e.g. Yes → Continue)', () => {
    const h = makeHarness()

    h.call(APPROVAL(1, ['1. Yes', '2. No'], MESSAGE), 1000)
    const sigYes = h.instance.pendingAutoApprovalSignature

    // Same message, but the affirmative the auto-approve would press is now
    // "Continue" — a different consent shape, so the identity must differ.
    h.call(APPROVAL(2, ['1. Continue', '2. No'], MESSAGE), 1300)
    const sigContinue = h.instance.pendingAutoApprovalSignature
    expect(sigContinue).not.toBe(sigYes)
    expect(h.instance.pendingAutoApprovalSince).toBe(1300)
  })

  it('normalizes numbering/position so "1. Yes" and "3. Yes" collapse to one identity', () => {
    const h = makeHarness()

    // Affirmative in slot 1.
    h.call(APPROVAL(1, ['1. Yes', '2. No'], MESSAGE), 1000)
    const sig1 = h.instance.pendingAutoApprovalSignature

    // Same affirmative "Yes" but now in slot 3 (buttons reordered by a repaint).
    // Normalization strips the leading number → same identity → clock preserved.
    h.call(APPROVAL(2, ['1. Always allow', '2. No', '3. Yes'], MESSAGE), 1300)
    expect(h.instance.pendingAutoApprovalSignature).toBe(sig1)
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)
  })
})
