import { afterEach, describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { ManualAttendanceTracker } from '../../src/providers/manual-attendance.js'
import { collectPendingApprovals } from '../../src/mesh/mesh-active-work.js'

// AUTOAPPROVE-FLAP-INBOX-MISSING (live snapshot 2026-07-13).
//
// A claude-cli worker sitting at a Bash approval modal flaps waiting_approval↔busy on a
// ~2-3s period: the spec `approval→busy` transition fires whenever the footer/modal
// approval markers momentarily drop out of their parsed sections while the PRIOR command's
// residual spinner text still matches the busy regex. On the busy frame the adapter reports
// status='generating', activeModal=null, which corrupts THREE consumers:
//   (1) mesh_active_work samples 'generating' → collectPendingApprovals never sees
//       'awaiting_approval' → mesh_list_pending_approvals count:0 (inbox miss);
//   (2) the auto-approve settle gate is torn down each busy phase → never accrues 600ms →
//       auto-approve never fires;
//   (3) mesh_approve landing on a busy frame hits "Not in approval state".
//
// FIX: stabilizeFlappingApprovalStatus() — a sticky-approval overlay that re-presents the
// last concrete approval modal + status='waiting_approval' across a busy blip within
// APPROVAL_STICKY_FLAP_MS, unless the engine has genuinely RESOLVED the modal since
// (lastApprovalResolvedAt advanced). The stabilized status feeds getState (→ inbox),
// detectStatusTransition (→ emission), and maybeAutoApproveStatus (→ settle gate).

const SETTLE_MS = 600
const STICKY_MS = 4000 // APPROVAL_STICKY_FLAP_MS

const liveInstances: any[] = []

function makeInstance(opts: { autoApprove?: boolean; mesh?: boolean } = {}): any {
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = 'claude-cli'
  instance.provider = { name: 'Claude', settings: {} }
  instance.settings = {
    ...(opts.autoApprove !== false ? { autoApprove: true } : { autoApprove: false }),
    ...(opts.mesh !== false ? { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' } : {}),
  }
  instance.autoApproveBusy = false
  instance.autoApproveBusyTimer = null
  instance.autoApproveSettleTimer = null
  instance.lastAutoApprovalSignature = ''
  instance.pendingAutoApprovalSignature = ''
  instance.pendingAutoApprovalSince = 0
  instance.autoApproveInactiveSince = 0
  instance.autoApproveMaskSince = 0
  instance.autoApproveLastModalSeenAt = 0
  instance.stalledApprovalNudgeEpisode = 0
  // Sticky-overlay state
  instance.approvalStickyLastConcreteAt = 0
  instance.approvalStickyModal = null
  instance.approvalStickyEntrySeq = 0
  instance.manualAttendance = new ManualAttendanceTracker()
  instance.resolvedAt = 0
  instance.adapter = {
    resolveModal: (_i: number) => { /* fire recorded via resolves */ },
    get lastApprovalResolvedAt() { return instance.resolvedAt },
    getStatus: () => ({ status: 'idle' }),
  }
  instance.appendRuntimeSystemMessage = () => { /* noop */ }
  liveInstances.push(instance)
  return instance
}

afterEach(() => {
  for (const inst of liveInstances.splice(0)) {
    if (inst.autoApproveSettleTimer) clearTimeout(inst.autoApproveSettleTimer)
    if (inst.autoApproveBusyTimer) clearTimeout(inst.autoApproveBusyTimer)
  }
})

const MODAL = { kind: 'approval', message: 'Bash(npm run check:vendor) — proceed?', buttons: ['1. Yes', '2. No'] }
const APPROVAL = (seq: number) => ({ status: 'waiting_approval', approvalEntrySeq: seq, activeModal: MODAL })
const BUSY = () => ({ status: 'generating', activeModal: null }) // the flap's busy frame

describe('AUTOAPPROVE-FLAP-INBOX-MISSING — sticky-approval overlay', () => {
  it('(inbox) re-presents waiting_approval across a busy flap frame so the approval registers', () => {
    const inst = makeInstance()

    // Concrete approval seen at t=1000 → sticky anchored.
    const s1 = inst.stabilizeFlappingApprovalStatus(APPROVAL(1), 1000)
    expect(s1.status).toBe('waiting_approval')

    // Busy flap frame at t=2500 (within STICKY_MS): raw is 'generating', but the overlay
    // must re-present waiting_approval + the cached modal (else the inbox reads generating).
    const s2 = inst.stabilizeFlappingApprovalStatus(BUSY(), 2500)
    expect(s2.status).toBe('waiting_approval')
    expect(s2.activeModal).toEqual(MODAL)
    expect(s2.approvalStickyOverlay).toBe(true)

    // The mesh inbox derives 'awaiting_approval' from any status string containing "approval".
    // Confirm the stabilized status yields a pending-approval record.
    const record: any = {
      taskId: 'task-1', nodeId: 'mesh-1', sessionId: 'sess-1',
      status: s2.status.includes('approval') ? 'awaiting_approval' : 'generating',
      title: 't', summary: 's', dispatchedAt: '2026-07-13T00:00:00Z',
    }
    const pending = collectPendingApprovals([record])
    expect(pending).toHaveLength(1)
    expect(pending[0].status).toBe('awaiting_approval')
  })

  it('(auto-approve) settle clock accrues across the flap so auto-approve fires', async () => {
    const inst = makeInstance()
    const resolves: number[] = []
    inst.adapter.resolveModal = (i: number) => resolves.push(i)

    // t=1000 concrete approval → stabilize (anchor) → maybeAutoApprove starts settle clock.
    inst.maybeAutoApproveStatus(inst.stabilizeFlappingApprovalStatus(APPROVAL(1), 1000), 1000)
    expect(inst.pendingAutoApprovalSince).toBe(1000)
    expect(inst.autoApproveBusy).toBe(false) // not settled yet

    // t=1400 busy flap frame. WITHOUT the overlay maybeAutoApprove would see 'generating',
    // tear down the settle gate, and the clock would restart on the next approval frame. WITH
    // the overlay it still sees waiting_approval → the settle clock is preserved.
    inst.maybeAutoApproveStatus(inst.stabilizeFlappingApprovalStatus(BUSY(), 1400), 1400)
    expect(inst.pendingAutoApprovalSince).toBe(1000) // NOT restarted

    // t=1700 (≥600ms since 1000) → the accrued settle window fires. autoApproveBusy flips
    // synchronously; resolveModal is dispatched on a 0ms macrotask.
    inst.maybeAutoApproveStatus(inst.stabilizeFlappingApprovalStatus(BUSY(), 1700), 1700)
    expect(inst.autoApproveBusy).toBe(true)
    await new Promise(r => setTimeout(r, 5))
    expect(resolves).toEqual([0]) // pressed button index 0 ("1. Yes") exactly once
  })

  it('(no false-mask) a genuine resume after a resolution is NOT held as a lingering approval', () => {
    const inst = makeInstance()

    // Approval anchored at t=1000.
    inst.stabilizeFlappingApprovalStatus(APPROVAL(1), 1000)

    // The modal is genuinely RESOLVED at t=1200 (auto-approve/mesh_approve fired resolveModal
    // → adapter.lastApprovalResolvedAt advances). The subsequent busy/generating frame is a
    // real resume, NOT a flap — the overlay must NOT re-present waiting_approval.
    inst.resolvedAt = 1200
    const s = inst.stabilizeFlappingApprovalStatus(BUSY(), 1300)
    expect(s.status).toBe('generating')
    expect(s.approvalStickyOverlay).toBeUndefined()
    // Sticky cleared so a later approval re-anchors cleanly.
    expect(inst.approvalStickyLastConcreteAt).toBe(0)
  })

  it('(bounded) the overlay lapses after APPROVAL_STICKY_FLAP_MS — a stalled/absent approval surfaces the raw status', () => {
    const inst = makeInstance()

    inst.stabilizeFlappingApprovalStatus(APPROVAL(1), 1000)

    // A busy frame INSIDE the window is still masked...
    expect(inst.stabilizeFlappingApprovalStatus(BUSY(), 1000 + STICKY_MS - 100).status).toBe('waiting_approval')

    // ...but past the window the overlay lapses and the raw status surfaces (bounded — no
    // permanent mask; a truly absent approval is not pinned forever).
    const s = inst.stabilizeFlappingApprovalStatus(BUSY(), 1000 + STICKY_MS + 500)
    expect(s.status).toBe('generating')
    expect(s.approvalStickyOverlay).toBeUndefined()
  })

  it('(scope) a non-mesh / foreground session is never overlaid (raw status passes through)', () => {
    const inst = makeInstance({ mesh: false })

    inst.stabilizeFlappingApprovalStatus(APPROVAL(1), 1000)
    const s = inst.stabilizeFlappingApprovalStatus(BUSY(), 1500)
    // Non-autonomous session: the human answers the prompt, so no delegated flap masking.
    expect(s.status).toBe('generating')
  })
})
