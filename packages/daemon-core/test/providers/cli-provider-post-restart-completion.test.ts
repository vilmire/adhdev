import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import type { InteractivePrompt } from '../../src/providers/types/interactive-prompt.js'

// POST-RESTART COMPLETION WEDGE regression (worker side).
//
// After ANY daemon restart the rebound worker session is rebuilt by
// restoreHostedSessions with NO mesh envelope (attachMeshAssignment stamps are
// in-memory) and with fresh turn bookkeeping (generatingStartedAt===0,
// agentReadyEmitted=false). The durable authority (assigned queue row + turn
// attempt) survives, and the coordinator-side reconcile re-stamps the envelope
// (restampReboundMeshWorkerAssignment). Two worker-side lifecycle gaps then
// decided whether the SAME attempt could still complete:
//
//  1. waiting_choice resume never armed the turn: boot folds starting→waiting_choice
//     on the parked picker (no idle→generating arm), the answer resumes
//     waiting_choice→generating (also no arm), and the generating→idle transition
//     was suppressed as a "startup-phase blip" (generatingStartedAt===0, no
//     debounce) — NO completion event ever fired. The waiting_choice arm now
//     mirrors the waiting_approval arm: a parked question IS a busy phase of the
//     same turn.
//  2. agent:ready (a per-process one-shot that re-fires after restart) detached
//     the re-stamped envelope via TERMINAL_MESH_EVENTS on the SAME first-idle
//     frame that armed the debounced completion — stripping meshActiveTaskId /
//     attemptId before the flush emitted. agent:ready is a claim signal, not
//     terminal evidence: it now detaches ONLY when no turn is in flight and no
//     completion is pending.

type Emitted = {
  event: string
  taskId?: string
  attemptId?: string
  dispatchNonce?: number
  promptId?: string
}

const MESH_ID = 'mesh-restart-wedge'
const NODE_ID = 'nodeA'
const TASK_ID = 'task-restart-1'
const ATTEMPT_ID = 'attempt-restart-1'
const NONCE = 7

function makePostRestartInstance(lastStatus: string): {
  instance: any
  events: Emitted[]
  setAdapterStatus: (status: any) => void
} {
  let adapterStatus: any = { status: 'starting', activeModal: null, activeInteractivePrompt: null }
  const events: Emitted[] = []

  const instance = Object.create(CliProviderInstance.prototype) as any
  // ── minimal field surface that detectStatusTransition()/pushEvent() touch ──
  instance.type = 'claude-cli'
  instance.instanceId = 'session-restart-worker'
  instance.provider = { name: 'Claude', settings: {} }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = ''
  // Post-restart rebound: NO mesh envelope in settings (lost with the process).
  instance.settings = { autoApprove: false }
  instance.runtimeMessages = []
  instance.lastStatus = lastStatus
  instance.lastApprovalEventFingerprint = ''
  instance.lastInteractivePromptEventKey = ''
  instance.generatingStartedAt = 0
  instance.generatingDebouncePending = null
  instance.generatingDebounceTimer = null
  instance.completedDebouncePending = null
  instance.completedDebounceTimer = null
  instance.busyEpoch = 0
  instance.meshTaskInjectedAt = 0
  instance.suppressIdleHistoryReplay = false
  instance.autoApproveBusy = false
  instance.monitor = { check: () => [] }
  instance.adapter = {
    getStatus: () => adapterStatus,
    getPartialResponse: () => '',
    getScriptParsedStatus: () => null,
    updateRuntimeSettings: () => {},
  }
  instance.events = []
  instance.context = {
    emitProviderEvent: (e: any) => {
      events.push({
        event: e.event,
        taskId: e.taskId,
        attemptId: e.attemptId,
        dispatchNonce: e.dispatchNonce,
        promptId: e.promptId,
      })
    },
  }
  // Stub the collaborators the arm/emit paths call so the test isolates the
  // lifecycle bookkeeping (not history I/O or rich parsing).
  instance.appendRuntimeSystemMessage = () => {}
  instance.applyProviderResponse = () => {}

  // The coordinator-side reconcile re-stamps the rebound worker from the
  // durable ledger (restampReboundMeshWorkerAssignment) — same call shape.
  instance.attachMeshAssignment({
    meshId: MESH_ID,
    nodeId: NODE_ID,
    taskId: TASK_ID,
    dispatchNonce: NONCE,
    attemptId: ATTEMPT_ID,
    coordinatorDaemonId: 'daemon_mach_x',
    coordinatorSessionId: 'coordSess',
  })

  return {
    instance,
    events,
    setAdapterStatus: (status: any) => { adapterStatus = status },
  }
}

const PROMPT: InteractivePrompt = {
  promptId: 'ask-user-restart-1',
  origin: 'cli',
  providerType: 'claude-cli',
  createdAt: 1,
  questions: [
    {
      questionId: 'q1',
      question: 'Proceed with the plan?',
      header: 'Confirm',
      multiSelect: false,
      options: [{ label: 'yes' }, { label: 'no' }],
    },
  ],
}

// The claude FSM reports a parked AskUserQuestion picker as raw waiting_approval
// with kind='picker'; detectStatusTransition folds it to waiting_choice.
const PICKER_FRAME = {
  status: 'waiting_approval',
  approvalEntrySeq: 3,
  activeModal: { message: 'Confirm', buttons: ['yes', 'no'], kind: 'picker' },
  activeInteractivePrompt: PROMPT,
}
const APPROVAL_FRAME = {
  status: 'waiting_approval',
  approvalEntrySeq: 4,
  activeModal: { message: 'Allow Bash command?', buttons: ['Yes', 'No'], kind: 'approval' },
  activeInteractivePrompt: null,
}
const GENERATING = { status: 'generating', activeModal: null, activeInteractivePrompt: null }
const IDLE = { status: 'idle', activeModal: null, activeInteractivePrompt: null }

describe('CliProviderInstance post-restart completion wedge (worker side)', () => {
  it('waiting_choice restart → answer → the resumed turn arms its completion with the SAME task/attempt envelope', () => {
    const { instance, events, setAdapterStatus } = makePostRestartInstance('starting')
    const detect = instance.detectStatusTransition.bind(instance)

    // Rebound boot: the FSM folds starting→waiting_choice on the parked picker.
    // The suspended-turn arm must set generatingStartedAt (pre-fix it stayed 0,
    // which made the resume's generating→idle a suppressed "startup blip").
    setAdapterStatus(PICKER_FRAME)
    detect()
    expect(instance.generatingStartedAt).not.toBe(0)
    expect(events.filter((e) => e.event === 'agent:waiting_choice')).toHaveLength(1)

    // The user answers (mesh_answer_question): the SAME turn resumes generating.
    setAdapterStatus(GENERATING)
    detect()

    // The turn finishes: generating→idle must ARM the completion (debounced),
    // snapshotted with the re-stamped envelope's taskId — NOT suppressed.
    setAdapterStatus(IDLE)
    detect()
    const pending = instance.completedDebouncePending
    expect(pending).toBeTruthy()
    expect(pending.taskId).toBe(TASK_ID)

    // Cleanup the real debounce timer so the suite exits cleanly.
    if (instance.completedDebounceTimer) clearTimeout(instance.completedDebounceTimer)
    instance.completedDebounceTimer = null
    instance.completedDebouncePending = null
  })

  it('waiting_approval restart → approve → the resumed turn arms its completion with the SAME task/attempt envelope', () => {
    const { instance, events, setAdapterStatus } = makePostRestartInstance('starting')
    const detect = instance.detectStatusTransition.bind(instance)

    // Rebound boot parked on a real consent modal: the waiting_approval arm
    // already set generatingStartedAt pre-fix — this case wedged only on the
    // missing envelope (covered by the reconcile re-stamp), so parity here is
    // the regression guard.
    setAdapterStatus(APPROVAL_FRAME)
    detect()
    expect(instance.generatingStartedAt).not.toBe(0)
    expect(events.filter((e) => e.event === 'agent:waiting_approval')).toHaveLength(1)

    // The user approves (mesh_approve): resume → finish → completion armed.
    setAdapterStatus(GENERATING)
    detect()
    setAdapterStatus(IDLE)
    detect()
    const pending = instance.completedDebouncePending
    expect(pending).toBeTruthy()
    expect(pending.taskId).toBe(TASK_ID)

    if (instance.completedDebounceTimer) clearTimeout(instance.completedDebounceTimer)
    instance.completedDebounceTimer = null
    instance.completedDebouncePending = null
  })

  it('agent:ready while a turn is in flight or a completion is pending does NOT strip the task envelope', () => {
    const { instance } = makePostRestartInstance('starting')

    // Mid-turn: the queue-claim one-shot must not detach the active assignment.
    instance.generatingStartedAt = Date.now()
    instance.pushEvent({ event: 'agent:ready', timestamp: Date.now() })
    expect(instance.settings.meshActiveTaskId).toBe(TASK_ID)
    expect(instance.settings.meshActiveAttemptId).toBe(ATTEMPT_ID)
    expect(instance.settings.meshActiveDispatchNonce).toBe(NONCE)

    // Completion armed but not yet flushed (the debounce window): same guard.
    instance.generatingStartedAt = 0
    instance.completedDebouncePending = { chatTitle: 't', duration: 1, timestamp: Date.now(), firstObservedAt: Date.now(), previousStatus: 'generating', taskId: TASK_ID }
    instance.pushEvent({ event: 'agent:ready', timestamp: Date.now() })
    expect(instance.settings.meshActiveTaskId).toBe(TASK_ID)
    instance.completedDebouncePending = null

    // generating_started debounce pending (turn just started): same guard.
    instance.generatingDebouncePending = { chatTitle: 't', timestamp: Date.now() }
    instance.pushEvent({ event: 'agent:ready', timestamp: Date.now() })
    expect(instance.settings.meshActiveTaskId).toBe(TASK_ID)
    instance.generatingDebouncePending = null
  })

  it('agent:ready with NO turn in flight still detaches a stale envelope (pre-existing semantics preserved)', () => {
    const { instance } = makePostRestartInstance('idle')
    // Idle, no turn, no pendings: the historical TERMINAL_MESH_EVENTS detach.
    instance.pushEvent({ event: 'agent:ready', timestamp: Date.now() })
    expect(instance.settings.meshActiveTaskId).toBeUndefined()
    expect(instance.settings.meshActiveAttemptId).toBeUndefined()
    expect(instance.settings.meshActiveDispatchNonce).toBeUndefined()
    // Non-launched session: the full envelope clears (meshLastNodeId stays sticky).
    expect(instance.settings.meshNodeFor).toBeUndefined()
    expect(instance.settings.meshLastNodeId).toBe(NODE_ID)
  })

  it('a genuine agent:ready with no active task is inert (no detach, event still emitted)', () => {
    const { instance, events } = makePostRestartInstance('idle')
    // No active assignment at all — the genuine queue-claim ready.
    instance.settings = { autoApprove: false }
    instance.pushEvent({ event: 'agent:ready', timestamp: Date.now() })
    expect(instance.settings.meshActiveTaskId).toBeUndefined()
    expect(events.filter((e) => e.event === 'agent:ready')).toHaveLength(1)
  })

  it('the completion event itself detaches AFTER emit, carrying the SAME attempt identity (exactly-once terminal evidence)', () => {
    const { instance, events } = makePostRestartInstance('idle')
    instance.pushEvent({ event: 'agent:generating_completed', timestamp: Date.now() })
    const completions = events.filter((e) => e.event === 'agent:generating_completed')
    expect(completions).toHaveLength(1)
    // The emit observed the envelope (taskId/attemptId/nonce stamped)…
    expect(completions[0].taskId).toBe(TASK_ID)
    expect(completions[0].attemptId).toBe(ATTEMPT_ID)
    expect(completions[0].dispatchNonce).toBe(NONCE)
    // …and the detach ran after, so a later unrelated turn cannot impersonate it.
    expect(instance.settings.meshActiveTaskId).toBeUndefined()
  })
})
