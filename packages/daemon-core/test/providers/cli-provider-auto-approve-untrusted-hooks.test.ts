import { afterEach, describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { ManualAttendanceTracker } from '../../src/providers/manual-attendance.js'
import { pickApprovalButton, hasNegativeApprovalOption } from '../../src/providers/approval-utils.js'

// APPROVESTUCK — regression lock for the claude-cli "cd / untrusted hooks" approval modal.
//
// Reported symptom: the modal "This command changes directory before running git, untrusted
// hooks could run… ❯ 1. Yes / 2. No" leaves auto-approve unfired and the session flaps
// approval↔busy. Live diagnosis of the running daemon was blocked, so this locks the parts
// that ARE statically confirmable so they cannot silently regress:
//
//   1. The claude spec tags this modal modal_kind='approval' (the footer-based →approval
//      transition fires on "❯ 1. …"; modalKindForState defaults a modal state to 'approval'),
//      so maybeAutoApproveStatus' modal-kind gate passes.
//   2. The approval-button heuristic resolves a "Yes" affirmative and detects the
//      "No, and tell Claude what to do differently" decline, so both structural gates pass.
//   3. The full settle path fires resolveModal(0) for this modal shape.
//
// What this CANNOT cover (requires a live PTY capture — reported, not patched): whether the
// FSM actually enters the approval state for the live screen, whether the modal SECTION is
// extracted so buttons are populated, and whether the win32 key write lands. Those are the
// remaining APPROVESTUCK candidates and are explicitly out of scope here.

const SETTLE_MS = 600

// Real claude-cli renders the cd/untrusted-hooks consent with a "Yes" plus a "don't ask again"
// variant and a verbose decline. The extraction strips the leading "N. " so labels are bare.
const BUTTONS = [
  'Yes',
  "Yes, and don't ask again for cd commands in this project",
  'No, and tell Claude what to do differently',
]
const MESSAGE = 'This command changes directory before running git. Untrusted hooks could run; do you want to proceed?'

const liveInstances: any[] = []

function makeHarness(modalKind?: string) {
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
  const modal: any = { message: MESSAGE, buttons: BUTTONS }
  if (modalKind !== undefined) modal.kind = modalKind
  const status = (seq: number) => ({ status: 'waiting_approval', approvalEntrySeq: seq, activeModal: modal })
  return {
    instance,
    fires,
    resolves,
    call: (seq: number, now: number) => instance.maybeAutoApproveStatus(status(seq), now),
  }
}

afterEach(() => {
  for (const inst of liveInstances.splice(0)) {
    if (inst.autoApproveSettleTimer) clearTimeout(inst.autoApproveSettleTimer)
    if (inst.autoApproveBusyTimer) clearTimeout(inst.autoApproveBusyTimer)
  }
})

describe('APPROVESTUCK — approval-button heuristic for the cd/untrusted-hooks modal', () => {
  it('picks the "Yes" affirmative (index 0) and detects a decline option', () => {
    const { index } = pickApprovalButton(BUTTONS, { approvalPositiveHints: undefined } as any)
    expect(index).toBe(0)
    expect(hasNegativeApprovalOption(BUTTONS)).toBe(true)
  })
})

describe('APPROVESTUCK — maybeAutoApproveStatus fires for the cd/untrusted-hooks modal', () => {
  it('fires resolveModal(0) once settled when modal_kind is explicitly approval', async () => {
    const h = makeHarness('approval')
    h.call(1, 1000)
    expect(h.fires.length).toBe(0)
    h.call(1, 1000 + SETTLE_MS + 1)
    expect(h.fires.length).toBe(1)
    await new Promise((r) => setTimeout(r, 10))
    expect(h.resolves).toEqual([0])
  })

  it('fires when modal kind is absent (legacy modal defaults to approval)', async () => {
    const h = makeHarness(undefined)
    h.call(1, 1000)
    h.call(1, 1000 + SETTLE_MS + 1)
    expect(h.fires.length).toBe(1)
    await new Promise((r) => setTimeout(r, 10))
    expect(h.resolves).toEqual([0])
  })

  it('does NOT fire when the modal is a picker (kind gate excludes it)', () => {
    const h = makeHarness('picker')
    h.call(1, 1000)
    h.call(1, 1000 + SETTLE_MS + 1)
    expect(h.fires.length).toBe(0)
    expect(h.resolves.length).toBe(0)
  })
})
