import { afterEach, describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// FALSEIDLE-a — structural approval-resolution gate for the waiting_approval→idle
// completion path.
//
// Root cause this guards: the spec's approval→idle transition is text-based and can
// false-trip — the modal text fails to match its negative patterns (e.g. claude-cli's
// cd / "untrusted hooks" prompt) so the PTY parser reports idle while the approval modal
// is still on screen and unresolved. The old code treated previousStatus==='waiting_approval'
// as proof the approval was resolved (approvalResolvedIdle) and emitted a completion — a
// false idle that flips a delegated worker terminal while it is genuinely parked on a modal.
//
// The gate requires POSITIVE structural evidence (the engine's lastResolvedEntrySeq, advanced
// by every resolveModal — auto-approve / dashboard / mesh_approve) before confirming the
// transition, and only for delegated mesh/coordinator sessions (an interactive local session
// may have the human answer the PTY directly, leaving no resolveModal record).
//
// These exercise the gate helpers directly (constructed via Object.create to skip the native
// terminal backend), driving the adapter's seq counters and session settings manually.

type SeqStatus = { approvalEntrySeq?: number; lastResolvedEntrySeq?: number }

function makeInstance(settings: Record<string, unknown>, seq: SeqStatus | (() => SeqStatus)): any {
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = 'claude-cli'
  instance.provider = { name: 'Claude', settings: {} }
  instance.settings = settings
  instance.adapter = {
    getStatus: () => ({ status: 'idle', ...(typeof seq === 'function' ? seq() : seq) }),
  }
  return instance
}

const MESH = { meshActiveTaskId: 't-1', meshNodeFor: 'mesh-1', autoApprove: true }
const LOCAL = { autoApprove: true }

describe('FALSEIDLE-a hasApprovalResolutionEvidence', () => {
  it('false when the latest approval entry is unresolved (resolvedSeq < entrySeq)', () => {
    const inst = makeInstance(MESH, { approvalEntrySeq: 2, lastResolvedEntrySeq: 1 })
    expect(inst.hasApprovalResolutionEvidence()).toBe(false)
  })

  it('true when the latest approval entry was resolved (resolvedSeq >= entrySeq)', () => {
    const inst = makeInstance(MESH, { approvalEntrySeq: 2, lastResolvedEntrySeq: 2 })
    expect(inst.hasApprovalResolutionEvidence()).toBe(true)
  })

  it('true (defensive) when no approval was ever entered (entrySeq <= 0)', () => {
    const inst = makeInstance(MESH, { approvalEntrySeq: 0, lastResolvedEntrySeq: -1 })
    expect(inst.hasApprovalResolutionEvidence()).toBe(true)
  })

  it('fails OPEN (true) when the adapter does not surface lastResolvedEntrySeq', () => {
    const inst = makeInstance(MESH, { approvalEntrySeq: 3 })
    expect(inst.hasApprovalResolutionEvidence()).toBe(true)
  })

  it('fails OPEN (true) when getStatus throws', () => {
    const inst = makeInstance(MESH, { approvalEntrySeq: 2, lastResolvedEntrySeq: 1 })
    inst.adapter.getStatus = () => { throw new Error('adapter gone') }
    expect(inst.hasApprovalResolutionEvidence()).toBe(true)
  })
})

describe('FALSEIDLE-a approvalResolutionFinalizationBlock', () => {
  it('HOLDS a mesh waiting_approval→idle with no resolution evidence (non-terminal, bounded)', () => {
    const inst = makeInstance(MESH, { approvalEntrySeq: 1, lastResolvedEntrySeq: -1 })
    const block = inst.approvalResolutionFinalizationBlock({ previousStatus: 'waiting_approval' })
    expect(block).toEqual({ reason: 'approval_resolution_unconfirmed', terminal: false })
  })

  it('passes (null) a mesh waiting_approval→idle that has resolution evidence', () => {
    const inst = makeInstance(MESH, { approvalEntrySeq: 1, lastResolvedEntrySeq: 1 })
    expect(inst.approvalResolutionFinalizationBlock({ previousStatus: 'waiting_approval' })).toBeNull()
  })

  it('passes (null) when previousStatus is generating — the normal resolution path', () => {
    // resolveModal sets status→generating, so a genuinely resolved approval completes with
    // previousStatus==='generating'. The gate must never fire for it even without seq evidence.
    const inst = makeInstance(MESH, { approvalEntrySeq: 1, lastResolvedEntrySeq: -1 })
    expect(inst.approvalResolutionFinalizationBlock({ previousStatus: 'generating' })).toBeNull()
  })

  it('passes (null) for a non-mesh (interactive local) session even with no evidence', () => {
    // A human may answer the PTY prompt directly — no resolveModal record — so the gate is
    // scoped to delegated sessions and must not wedge a local interactive completion.
    const inst = makeInstance(LOCAL, { approvalEntrySeq: 1, lastResolvedEntrySeq: -1 })
    expect(inst.approvalResolutionFinalizationBlock({ previousStatus: 'waiting_approval' })).toBeNull()
  })

  it('applies to coordinator-launched sessions too', () => {
    const inst = makeInstance({ launchedByCoordinator: true, autoApprove: true }, { approvalEntrySeq: 1, lastResolvedEntrySeq: -1 })
    expect(inst.approvalResolutionFinalizationBlock({ previousStatus: 'waiting_approval' })?.reason)
      .toBe('approval_resolution_unconfirmed')
  })
})

describe('FALSEIDLE-a getCompletedFinalizationBlock integration', () => {
  // Build a finalization-block harness whose parsed status is idle with a confirmed final
  // assistant message, so the only thing that can block is the new structural gate.
  function makeFinalizationInstance(settings: Record<string, unknown>, seq: SeqStatus): any {
    const inst = Object.create(CliProviderInstance.prototype) as any
    inst.type = 'claude-cli'
    inst.provider = { name: 'Claude', settings: {} }
    inst.settings = settings
    inst.adapter = {
      getPartialResponse: () => '',
      getScriptParsedStatus: () => ({ status: 'idle', messages: [{ role: 'assistant', content: 'done' }] }),
      getStatus: () => ({ status: 'idle', ...seq }),
      getScreenText: () => '',
      chatMessagesOwnedExternally: false,
    }
    // Force "final assistant present" so we isolate the approval-resolution gate from the
    // transcript-evidence machinery.
    inst.completionFinalAssistantEvidence = () => ({ present: true, messages: [], source: 'parsed' })
    return inst
  }
  const PENDING = (previousStatus: string) => ({ previousStatus, firstObservedAt: 0, timestamp: 0, duration: 1 })

  it('mesh worker false idle (no resolution evidence) is held with approval_resolution_unconfirmed', () => {
    const inst = makeFinalizationInstance(MESH, { approvalEntrySeq: 1, lastResolvedEntrySeq: -1 })
    const block = inst.getCompletedFinalizationBlock('idle', PENDING('waiting_approval'))
    expect(block).toEqual({ reason: 'approval_resolution_unconfirmed', terminal: false })
  })

  it('mesh worker with resolution evidence finalizes cleanly (no block)', () => {
    const inst = makeFinalizationInstance(MESH, { approvalEntrySeq: 1, lastResolvedEntrySeq: 1 })
    expect(inst.getCompletedFinalizationBlock('idle', PENDING('waiting_approval'))).toBeNull()
  })

  it('normal generating→idle completion finalizes cleanly (no block)', () => {
    const inst = makeFinalizationInstance(MESH, { approvalEntrySeq: 0, lastResolvedEntrySeq: -1 })
    expect(inst.getCompletedFinalizationBlock('idle', PENDING('generating'))).toBeNull()
  })
})
