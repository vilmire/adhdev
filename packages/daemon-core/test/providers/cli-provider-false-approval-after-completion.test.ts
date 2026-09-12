import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// FALSE-AWAITING-APPROVAL (live 2026-09-12, observed repeatedly: coordinator approval
// notifications + worker sessions frozen showing an approval/choice that no mesh_approve
// could resolve).
//
// A worker's turn COMPLETED — the genuine (non-weak) completion was emitted — and then the
// PTY parser misread the settled screen as a consent modal: the completed prompt area
// repaints into text the modal extractor scores as an approval. detectStatusTransition's
// waiting_approval arm ran for that frame and did three harmful things in order:
//   1. cancelled the pending completion (completedDebouncePending = null),
//   2. bumped busyEpoch — so the false approval WINS over the real completion,
//   3. emitted agent:waiting_approval, re-pinning every coordinator projection with an
//      approval the provider exposes no modal for ("Not in approval state").
//
// THE INVARIANT: once a completion is CONFIRMED for the current turn, an approval must not
// be emitted for it. Nothing enforced it — the approval arm had no terminal gate at all,
// and the only downstream guard (mesh-event-forwarding's hasTerminalAuthorityForTask) is
// keyed on a taskId that the completion itself clears via detachMeshAssignment().
//
// FIX A: gate the approval arm on !hasEmittedGenuineCompletionForCurrentEpoch() — the same
// latch the sticky-approval overlay already reads (approval-gate.ts). Scoped so that:
//   • a WEAK / false-idle completion does NOT latch (a genuine mid-turn approval following
//     a false-idle must still surface), and
//   • a new busy phase (busyEpoch advanced past the latch) re-enables approval surfacing.

type Emitted = { event: string; modalMessage?: string }

function makeInstance(): {
  instance: CliProviderInstance
  events: Emitted[]
  setAdapterStatus: (status: any) => void
  detect: () => void
  raw: any
} {
  let adapterStatus: any = { status: 'generating', activeModal: null, approvalEntrySeq: 0 }
  const events: Emitted[] = []

  const instance = Object.create(CliProviderInstance.prototype) as any
  // ── minimal field surface that detectStatusTransition() touches ──
  instance.type = 'claude-cli'
  instance.instanceId = 'session-false-approval'
  instance.provider = { name: 'Claude', settings: {} }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = ''
  instance.settings = { autoApprove: false } // keep maybeAutoApproveStatus a no-op
  instance.runtimeMessages = []
  instance.lastStatus = 'generating'
  instance.lastApprovalEventFingerprint = ''
  instance.generatingStartedAt = 1
  instance.generatingDebouncePending = null
  instance.generatingDebounceTimer = null
  instance.completedDebouncePending = null
  instance.completedDebounceTimer = null
  instance.suppressIdleHistoryReplay = false
  instance.autoApproveBusy = false
  instance.busyEpoch = 4
  instance.lastEmittedCompletion = null
  instance.monitor = { check: () => [] }
  instance.adapter = {
    getStatus: () => adapterStatus,
    getPartialResponse: () => '',
    getScriptParsedStatus: () => null,
  }
  instance.events = []
  instance.context = {
    emitProviderEvent: (e: any) => { events.push({ event: e.event, modalMessage: e.modalMessage }) },
  }
  instance.appendRuntimeSystemMessage = () => {}
  instance.applyProviderResponse = () => {}

  return {
    instance: instance as CliProviderInstance,
    events,
    setAdapterStatus: (status: any) => { adapterStatus = status },
    detect: () => (instance as any).detectStatusTransition(),
    raw: instance,
  }
}

const APPROVAL = (seq: number) => ({
  status: 'waiting_approval',
  approvalEntrySeq: seq,
  activeModal: { message: 'Allow Bash command?', buttons: ['1. Yes', '2. No'] },
})
const GENERATING = { status: 'generating', approvalEntrySeq: 0, activeModal: null }

/** The genuine (non-weak) completion latch, emitted for the CURRENT busy epoch. */
function latchGenuineCompletion(raw: any) {
  raw.lastEmittedCompletion = {
    taskId: 'task-1',
    at: Date.now(),
    evidenceLevel: 'reported',
    weak: false,
    emittedAtEpoch: raw.busyEpoch,
  }
}

describe('FALSE-AWAITING-APPROVAL — a confirmed completion suppresses a following approval', () => {
  it('(the live defect) a raw waiting_approval frame AFTER a genuine completion emits NO agent:waiting_approval', () => {
    const { events, setAdapterStatus, detect, raw } = makeInstance()

    // The turn completed and the genuine completion was emitted for this epoch.
    latchGenuineCompletion(raw)

    // The PTY now misreads the settled screen as a consent modal.
    setAdapterStatus(APPROVAL(1))
    detect()

    expect(events.filter(e => e.event === 'agent:waiting_approval')).toHaveLength(0)
  })

  it('the suppressed frame does not let the false approval WIN over the real completion', () => {
    const { setAdapterStatus, detect, raw } = makeInstance()
    latchGenuineCompletion(raw)

    // A completion is armed and waiting to flush; the false approval must not cancel it.
    const pending = { chatTitle: 'Claude · worktree', timestamp: Date.now() } as any
    raw.completedDebouncePending = pending
    const epochBefore = raw.busyEpoch

    setAdapterStatus(APPROVAL(1))
    detect()

    // Arm skipped entirely: pending completion intact, epoch not bumped.
    expect(raw.completedDebouncePending).toBe(pending)
    expect(raw.busyEpoch).toBe(epochBefore)
    // lastStatus still advances on the fall-through, so later frames read normally.
    expect(raw.lastStatus).toBe('waiting_approval')
  })

  it('(reverse regression) a GENUINE mid-turn approval — no completion latched — is still emitted', () => {
    const { events, setAdapterStatus, detect } = makeInstance()

    // No completion for this turn: the ordinary case must be untouched by the gate.
    setAdapterStatus(APPROVAL(1))
    detect()

    const approvals = events.filter(e => e.event === 'agent:waiting_approval')
    expect(approvals).toHaveLength(1)
    expect(approvals[0].modalMessage).toBe('Allow Bash command?')
  })

  it('(reverse regression) a WEAK / false-idle completion does NOT latch — the following approval still surfaces', () => {
    const { events, setAdapterStatus, detect, raw } = makeInstance()

    // A weak (false-idle) completion: the worker may genuinely still be mid-turn, so a
    // following approval can be real and must NOT be suppressed.
    raw.lastEmittedCompletion = {
      taskId: 'task-1',
      at: Date.now(),
      evidenceLevel: 'insufficient',
      weak: true,
      emittedAtEpoch: raw.busyEpoch,
    }

    setAdapterStatus(APPROVAL(1))
    detect()

    expect(events.filter(e => e.event === 'agent:waiting_approval')).toHaveLength(1)
  })

  it('(reverse regression) a NEW busy phase re-opens approval surfacing for the next turn', () => {
    const { events, setAdapterStatus, detect, raw } = makeInstance()
    latchGenuineCompletion(raw)

    // First: suppressed while the completed epoch stands.
    setAdapterStatus(APPROVAL(1))
    detect()
    expect(events.filter(e => e.event === 'agent:waiting_approval')).toHaveLength(0)

    // A new turn opens — busyEpoch advances past the latch (the real path bumps it on
    // idle→generating; the suppressed arm above deliberately did not).
    raw.lastStatus = 'idle'
    raw.generatingStartedAt = 0
    setAdapterStatus(GENERATING)
    detect()
    expect(raw.busyEpoch).toBeGreaterThan(raw.lastEmittedCompletion.emittedAtEpoch)

    // The next turn's approval is genuine and must emit.
    setAdapterStatus(APPROVAL(2))
    detect()
    expect(events.filter(e => e.event === 'agent:waiting_approval')).toHaveLength(1)
  })
})
