import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// Regression: consecutive delegated-worker approvals with IDENTICAL modal
// content (very common with claude-cli's repeated "Allow Bash command?") must
// each emit an agent:waiting_approval event. The emit gate fingerprints the
// modal; without the FSM's approvalEntrySeq in that fingerprint, the second
// approval collides with the first and is SILENTLY DROPPED — it never emits, so
// it cannot even land in the pending inbox for a read_chat reconcile to recover.
// The fix mirrors the auto-approve path / FSM resolveModal seq guard.

type Emitted = { event: string; modalMessage?: string }

function makeInstance(): {
  instance: CliProviderInstance
  events: Emitted[]
  setAdapterStatus: (status: any) => void
} {
  let adapterStatus: any = { status: 'generating', activeModal: null, approvalEntrySeq: 0 }
  const events: Emitted[] = []

  const instance = Object.create(CliProviderInstance.prototype) as any
  // ── minimal field surface that detectStatusTransition() touches ──
  instance.type = 'claude-cli'
  instance.instanceId = 'session-approval-seq'
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
  instance.monitor = { check: () => [] }
  instance.adapter = {
    getStatus: () => adapterStatus,
    getPartialResponse: () => '',
    getScriptParsedStatus: () => null,
  }
  // Capture emitted provider events (default sink is this.events when no
  // context.emitProviderEvent is wired).
  instance.events = []
  instance.context = {
    emitProviderEvent: (e: any) => { events.push({ event: e.event, modalMessage: e.modalMessage }) },
  }
  // Stub the collaborators the emit path calls so the test isolates the
  // fingerprint/emit decision (not history I/O or rich parsing).
  instance.appendRuntimeSystemMessage = () => {}
  instance.applyProviderResponse = () => {}

  return {
    instance: instance as CliProviderInstance,
    events,
    setAdapterStatus: (status: any) => { adapterStatus = status },
  }
}

const APPROVAL = (seq: number) => ({
  status: 'waiting_approval',
  approvalEntrySeq: seq,
  activeModal: { message: 'Allow Bash command?', buttons: ['Yes', 'No'] },
})
const GENERATING = { status: 'generating', approvalEntrySeq: 1, activeModal: null }

describe('CliProviderInstance approval emit gate — seq separates identical back-to-back approvals', () => {
  it('emits a second agent:waiting_approval for an identical modal carrying a fresh approvalEntrySeq', () => {
    const { instance, events, setAdapterStatus } = makeInstance()
    const detect = (instance as any).detectStatusTransition.bind(instance)

    // First approval (entry seq 1) — identical content, fresh entry.
    setAdapterStatus(APPROVAL(1))
    detect()

    // Approval resolved → agent resumes (waiting_approval → generating).
    setAdapterStatus(GENERATING)
    detect()

    // Second approval with the SAME message/buttons but a bumped entry seq.
    setAdapterStatus(APPROVAL(2))
    detect()

    const approvals = events.filter((e) => e.event === 'agent:waiting_approval')
    expect(approvals.length).toBe(2)
    expect(approvals.every((e) => e.modalMessage === 'Allow Bash command?')).toBe(true)
  })

  it('Fix #1 in isolation: a fresh seq separates the fingerprint even when the prior fingerprint was NOT reset', () => {
    // Isolates the seq contribution from the defense-in-depth reset (Fix #2):
    // pre-load lastApprovalEventFingerprint with the CONTENT-ONLY fingerprint the
    // pre-fix gate would have stored for the first approval (no seq, exactly the
    // shape `JSON.stringify({message, buttons})`), simulating a path where no
    // reset ran. Then drive a seq-2 approval with byte-identical message/buttons.
    //
    // With the fix, the gate now appends seq → the new fingerprint differs from
    // the pre-loaded content-only one → the event emits. Without the fix, the
    // gate would reproduce the identical content-only fingerprint → collision →
    // the second approval would be SILENTLY DROPPED (length 0). So this test
    // fails if the seq is removed from the fingerprint.
    const { instance, events, setAdapterStatus } = makeInstance()
    const detect = (instance as any).detectStatusTransition.bind(instance)
    ;(instance as any).lastApprovalEventFingerprint = JSON.stringify({
      message: 'Allow Bash command?',
      buttons: ['Yes', 'No'],
    })
    ;(instance as any).lastStatus = 'generating'
    setAdapterStatus(APPROVAL(2))
    detect()

    const approvals = events.filter((e) => e.event === 'agent:waiting_approval')
    expect(approvals.length).toBe(1)
    expect(approvals[0].modalMessage).toBe('Allow Bash command?')
  })

  it('still dedups true PTY redraw repeats of one approval (same seq, same content)', () => {
    const { instance, events, setAdapterStatus } = makeInstance()
    const detect = (instance as any).detectStatusTransition.bind(instance)

    setAdapterStatus(APPROVAL(1))
    detect()
    // Same entry re-observed across a paint flap: lastStatus is now
    // waiting_approval; a same-seq re-entry must NOT double-emit.
    ;(instance as any).lastStatus = 'generating' // force the branch to re-evaluate
    setAdapterStatus(APPROVAL(1))
    detect()

    const approvals = events.filter((e) => e.event === 'agent:waiting_approval')
    expect(approvals.length).toBe(1)
  })
})
