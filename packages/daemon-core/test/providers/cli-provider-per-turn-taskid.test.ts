import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { CliStateEngine } from '../../src/cli-adapters/cli-state-engine.js'

// ARCH-REFACTOR R1 (per-turn task identity) — master fix for NOTIF-MISDELIVER +
// TASK-MSG-MISROUTE.
//
// Root cause: a worker session held a SINGLE scalar (settings.meshActiveTaskId), written
// last-write-wins by attachMeshAssignment. When a second task attached BEFORE the first
// turn's completion fired, the first task's completion event read the scalar and shipped
// the SECOND task's id (and a stale/wrong finalSummary attribution). The fix binds the
// taskId to the TURN: the turn carries its taskId (TurnParseScope.taskId →
// engine.currentTurnTaskId), and the completion event reads the completing turn's id —
// snapshotted at the generating→idle transition for the debounce-delayed path — instead of
// the racy scalar. The scalar survives only as a backward-compat alias (lowest priority).
//
// These exercise the REAL instance/engine code (pushEvent, flushCompletedDebounceIfFinalized,
// engine.onTurnStarted) — not stubs of the binding logic.

// ── Instance harness (drives the real pushEvent / completion-flush methods) ──
function makeInstance(opts: {
  settings: Record<string, unknown>
  currentTurnTaskId: string | null
}): { instance: any; events: any[] } {
  const events: any[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = 'claude-cli'
  instance.instanceId = 'sess-r1'
  instance.provider = { name: 'Claude', settings: {}, nativeHistory: {} }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = 'psess-1'
  instance.settings = { ...opts.settings }
  instance.adapter = {
    currentTurnTaskId: opts.currentTurnTaskId,
    updateRuntimeSettings: () => {},
    getScriptParsedStatus: () => ({ status: 'idle', messages: [] }),
  }
  instance.context = { emitProviderEvent: (e: any) => events.push(e) }
  instance.events = []
  return { instance, events }
}

describe('ARCH-REFACTOR R1 — per-turn taskId binding (pushEvent resolution)', () => {
  it('completion carries the per-turn binding, NOT the racing last-write-wins scalar', () => {
    // The scalar was already overwritten by a second task that attached mid-turn
    // (meshActiveTaskId='task-2'), but the turn that is actually completing is task-1.
    const { instance, events } = makeInstance({
      settings: { meshNodeFor: 'mesh-1', meshNodeId: 'node-a', meshActiveTaskId: 'task-2' },
      currentTurnTaskId: 'task-1',
    })

    instance.pushEvent({ event: 'agent:generating_completed', timestamp: 1, chatTitle: 'task' })

    expect(events).toHaveLength(1)
    // The completion is attributed to the completing turn (task-1), not the scalar (task-2).
    expect(events[0].taskId).toBe('task-1')
  })

  it('an explicit event.taskId (captured at the idle-transition) wins over everything', () => {
    const { instance, events } = makeInstance({
      settings: { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-2' },
      currentTurnTaskId: 'task-3',
    })

    // The debounce-flush path stamps the taskId captured when the turn settled.
    instance.pushEvent({ event: 'agent:generating_completed', timestamp: 1, chatTitle: 'task', taskId: 'task-1' })

    expect(events[0].taskId).toBe('task-1')
  })

  it('falls back to the scalar alias when no per-turn binding exists (backward compat)', () => {
    const { instance, events } = makeInstance({
      settings: { meshNodeFor: 'mesh-1', meshActiveTaskId: 'legacy-task' },
      currentTurnTaskId: null,
    })

    instance.pushEvent({ event: 'agent:generating', timestamp: 1, chatTitle: 'task' })

    expect(events[0].taskId).toBe('legacy-task')
  })

  it('a non-mesh session is never stamped with a taskId (regression guard)', () => {
    const { instance, events } = makeInstance({
      settings: {},
      currentTurnTaskId: 'task-1',
    })

    instance.pushEvent({ event: 'agent:generating', timestamp: 1, chatTitle: 'task' })

    expect(events[0].taskId).toBeUndefined()
  })
})

// ── Completion-flush harness (debounce-delayed emit; the snapshot-vs-race path) ──
function makeFlushInstance(opts: {
  pendingTaskId?: string
  scalarTaskId?: string
  adapterTurnTaskId: string | null
  finalSummary: string
}): { instance: any; events: any[] } {
  const events: any[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = 'claude-cli'
  instance.instanceId = 'sess-r1-flush'
  instance.provider = { name: 'Claude', settings: {}, nativeHistory: {} }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = 'psess-1'
  instance.settings = {
    meshNodeFor: 'mesh-1',
    meshNodeId: 'node-a',
    ...(opts.scalarTaskId ? { meshActiveTaskId: opts.scalarTaskId } : {}),
  }
  instance.lastStatus = 'generating'
  instance.generatingStartedAt = 1000
  instance.lastApprovalEventFingerprint = ''
  instance.autoApproveBusy = false
  instance.completedDebounceTimer = null
  instance.completedDebouncePending = {
    chatTitle: 'task',
    duration: 5,
    timestamp: 111,
    firstObservedAt: Date.now(),
    previousStatus: 'generating',
    ...(opts.pendingTaskId ? { taskId: opts.pendingTaskId } : {}),
  }
  instance.adapter = {
    currentTurnTaskId: opts.adapterTurnTaskId,
    chatMessagesOwnedExternally: true,
    updateRuntimeSettings: () => {},
    getStatus: () => ({ status: 'idle' }),
    getPartialResponse: () => '',
    getScriptParsedStatus: () => ({ status: 'idle', messages: [] }),
    getScreenText: () => '',
    isWaitingForResponse: false,
  }
  instance.shouldAutoApprove = () => false
  instance.completionFinalAssistantEvidence = () => ({ present: true, messages: [], source: 'external-native' })
  instance.completionFinalSummary = () => opts.finalSummary
  instance.recordPendingTranscriptProbe = () => null
  instance.scheduleCompletedDebounceFlush = () => {}
  instance.context = { emitProviderEvent: (e: any) => events.push(e) }
  instance.events = []
  return { instance, events }
}

describe('ARCH-REFACTOR R1 — completion flush uses the snapshotted turn taskId', () => {
  it('emits the taskId captured at the idle-transition even after the next task started (scalar+turn moved on)', () => {
    // task-1 has just settled (its taskId was snapshotted onto completedDebouncePending),
    // and the follow-up task-2 has ALREADY started its turn — so BOTH the scalar and the
    // live engine binding now read task-2. The debounce-delayed completion for task-1 must
    // still carry task-1 (proving the snapshot, not a re-read at flush time).
    const { instance, events } = makeFlushInstance({
      pendingTaskId: 'task-1',
      scalarTaskId: 'task-2',
      adapterTurnTaskId: 'task-2',
      finalSummary: 'task-1 result: done',
    })

    instance.flushCompletedDebounceIfFinalized()

    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('agent:generating_completed')
    expect(events[0].taskId).toBe('task-1')
    expect(events[0].finalSummary).toBe('task-1 result: done')
  })
})

// ── Engine binding (the source of the per-turn id) ──
function makeEngine(): CliStateEngine {
  const provider: any = { type: 'claude-cli', name: 'Claude', timeouts: {} }
  const runner: any = { parseErrorMessage: null }
  const transport: any = { getSnapshot: () => ({}), writeRaw: () => {}, isAlive: () => true }
  const callbacks: any = { onStatusChange: () => {}, onApplyParsedSession: () => {}, onTurnCompleted: () => {} }
  const timeouts: any = { generatingIdle: 1000, outputSettle: 100, idleConfirmation: 100, approvalExit: 1000 }
  return new CliStateEngine(provider, runner, transport, callbacks, timeouts)
}

describe('ARCH-REFACTOR R1 — engine.onTurnStarted binds the turn taskId', () => {
  it('binds the turn taskId and persists it past turn settle, then rebinds on the next turn', () => {
    const engine = makeEngine()
    const scope = (taskId?: string) => ({ prompt: 'p', startedAt: 1, bufferStart: 0, rawBufferStart: 0, ...(taskId ? { taskId } : {}) })

    engine.onTurnStarted(scope('t1'))
    expect(engine.currentTurnTaskId).toBe('t1')

    // The turn settles: currentTurnScope is cleared, but the bound taskId must SURVIVE so
    // the (debounce-delayed) completion can still read it.
    engine.currentTurnScope = null
    expect(engine.currentTurnTaskId).toBe('t1')

    // The next task's turn rebinds.
    engine.onTurnStarted(scope('t2'))
    expect(engine.currentTurnTaskId).toBe('t2')

    // A task-less ad-hoc turn clears it so an ad-hoc completion is never stamped stale.
    engine.onTurnStarted(scope())
    expect(engine.currentTurnTaskId).toBeNull()
  })
})
