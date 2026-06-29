import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { ManualAttendanceTracker } from '../../src/providers/manual-attendance.js'

// NOTIF-HELD-DRAIN (Fix 1): modal-park classification. A busy mesh coordinator/worker running
// with auto-approve OFF surfaces a routine `waiting_approval` tool-consent on every tool call
// while a turn is in flight. That transient consent is driven to resolution by the
// harness/operator as part of the in-flight turn — it is NOT a session genuinely wedged
// awaiting a human's modal answer. resolveModalParkStatus() must therefore NOT classify it as
// modal-parked (which is what wedged the mesh's pending completion events under `modal_parked`
// and stalled delivery). The genuine-modal cases (no turn in flight, manual attendance, an
// AskUserQuestion prompt) still park.

type Stub = CliProviderInstance & {
  activeInteractivePrompt: any
  adapter: any
  settings: Record<string, any>
}

function makeStub(opts: {
  adapterStatus?: string
  isWaitingForResponse?: boolean
  settings?: Record<string, any>
  attended?: boolean
  activeInteractivePrompt?: any
}): Stub {
  const instance = Object.create(CliProviderInstance.prototype) as Stub
  ;(instance as any).type = 'claude-cli'
  instance.activeInteractivePrompt = opts.activeInteractivePrompt ?? null
  instance.adapter = {
    getStatus: () => ({ status: opts.adapterStatus ?? 'waiting_approval' }),
    isWaitingForResponse: opts.isWaitingForResponse === true,
  }
  instance.settings = { autoApprove: false, ...(opts.settings ?? {}) }
  const tracker = new ManualAttendanceTracker()
  if (opts.attended) tracker.note(Date.now())
  ;(instance as any).manualAttendance = tracker
  return instance
}

describe('resolveModalParkStatus — mesh transient tool-consent classification', () => {
  it('does NOT park a mesh coordinator on an in-flight tool-consent (transient, unattended)', () => {
    const inst = makeStub({
      adapterStatus: 'waiting_approval',
      isWaitingForResponse: true,
      settings: { meshCoordinatorFor: 'mesh-1' },
    })
    expect(inst.resolveModalParkStatus()).toBeNull()
    expect(inst.isModalParked()).toBe(false)
  })

  it('does NOT park a mesh WORKER on an in-flight tool-consent (transient, unattended)', () => {
    const inst = makeStub({
      adapterStatus: 'waiting_approval',
      isWaitingForResponse: true,
      settings: { meshActiveTaskId: 'task-1' },
    })
    expect(inst.resolveModalParkStatus()).toBeNull()
  })

  it('STILL parks a mesh coordinator with NO turn in flight (genuine human-await)', () => {
    const inst = makeStub({
      adapterStatus: 'waiting_approval',
      isWaitingForResponse: false, // no in-flight turn → not a transient consent
      settings: { meshCoordinatorFor: 'mesh-1' },
    })
    expect(inst.resolveModalParkStatus()).toBe('waiting_approval')
    expect(inst.isModalParked()).toBe(true)
  })

  it('STILL parks a mesh coordinator that is manually attended (human is driving the modal)', () => {
    const inst = makeStub({
      adapterStatus: 'waiting_approval',
      isWaitingForResponse: true,
      settings: { meshCoordinatorFor: 'mesh-1' },
      attended: true,
    })
    expect(inst.resolveModalParkStatus()).toBe('waiting_approval')
  })

  it('STILL parks a NON-mesh session on a tool-consent (regression: ordinary CLI is unchanged)', () => {
    const inst = makeStub({
      adapterStatus: 'waiting_approval',
      isWaitingForResponse: true,
      settings: {}, // not a mesh session
    })
    expect(inst.resolveModalParkStatus()).toBe('waiting_approval')
  })

  it('parks on an AskUserQuestion prompt regardless of mesh/turn state (waiting_choice)', () => {
    const inst = makeStub({
      adapterStatus: 'generating',
      isWaitingForResponse: true,
      settings: { meshCoordinatorFor: 'mesh-1' },
      activeInteractivePrompt: { promptId: 'ask-1', questions: [{ question: 'pick', options: [] }] },
    })
    expect(inst.resolveModalParkStatus()).toBe('waiting_choice')
  })

  it('is not parked when idle', () => {
    const inst = makeStub({ adapterStatus: 'idle', settings: { meshCoordinatorFor: 'mesh-1' } })
    expect(inst.resolveModalParkStatus()).toBeNull()
  })
})
