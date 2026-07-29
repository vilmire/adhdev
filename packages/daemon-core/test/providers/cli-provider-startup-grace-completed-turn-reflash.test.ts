import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// STANDALONE STATUS GENERATING-REFLASH (startup-grace collapse misclassification).
//
// maybeSynthesizeStartupGraceCollapse runs on the next idle-stayed poll inside
// the 12s startup-grace window. After a NORMAL genuine completion the adapter's
// currentTurnTaskId persists past the turn and the completion flush resets
// generatingStartedAt=0 (and clears generatingDebouncePending), while
// fastCollapseSynthesizedTaskId was never stamped — so every fastCollapsed
// predicate (turn bound, nothing pending, generating "never armed") reads TRUE
// for the ALREADY-COMPLETED turn, and the rescue synthesized a back-to-back
// WEAK agent:generating_started + agent:generating_completed pair: one
// ~120-130ms surface generating blip on a session that was done.
//
// THE FIX stamps the current turn as already-satisfied for the startup-grace
// collapse synth on every genuine completion path that resets
// generatingStartedAt (the clean flush, the forced-timeout flush, and the
// non-mesh short-generating inline fire), via
// markCurrentTurnStartupGraceCollapseSatisfied(). The intended rescue for a
// turn that TRULY completed without ever arming generating is preserved: that
// turn never gets stamped by a completion path, so its synth still fires.
//
// Unlike cli-provider-startup-grace-generating-miss.test.ts (which stubs the
// flush), this harness drives the REAL detectStatusTransition() + the REAL
// flushCompletedDebounceIfFinalized() — the stamp lives inside the real flush.
//
// Case (4) — reducer/status projection: NOT PRACTICAL inside daemon-core. The
// daemon has no generating/idle reducer; src/status/reporter.ts only FORWARDS
// the phase events, and the surface projection that rendered the blip lives in
// the web/server layer outside this package. The PROJECTION-PROXY case below
// therefore asserts the projection's INPUT instead: the event stream carries
// no generating_started after the genuine completion (a reducer fed this
// stream settles idle and stays there).

type Harness = {
  instance: any
  events: any[]
  setAdapterStatus: (status: string) => void
  setAdapterWaiting: (waiting: boolean) => void
}

function makeInstance(): Harness {
  const events: any[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any

  let adapterStatus = 'idle'
  let adapterWaiting = false

  instance.type = 'claude-cli'
  instance.instanceId = 'sess-reflash-1'
  instance.provider = { name: 'Claude', type: 'claude-cli', settings: {}, nativeHistory: {} }
  instance.workingDir = '/repo/worktree-standalone'
  instance.providerSessionId = 'psess-reflash-1'
  // STANDALONE session — no mesh context (the surface the reflash was seen on).
  instance.settings = {}

  // FSM bookkeeping — an already-idle session inside the startup-grace window.
  instance.lastStatus = 'idle'
  instance.generatingStartedAt = 0
  instance.generatingDebouncePending = null
  instance.generatingDebounceTimer = null
  instance.completedDebouncePending = null
  instance.completedDebounceTimer = null
  instance.lastApprovalEventFingerprint = ''
  instance.autoApproveBusy = false
  instance.agentReadyEmitted = true // keep agent:ready noise out of the assertions
  instance.suppressIdleHistoryReplay = false
  instance.startedAt = Date.now()
  instance.startupGraceCollapseAt = Date.now() // grace window OPEN
  instance.fastCollapseSynthesizedTaskId = null
  instance.busyEpoch = 0

  instance.adapter = {
    getStatus: () => ({ status: adapterStatus }),
    getPartialResponse: () => '',
    // A confirmed final assistant message exists (the turn genuinely finished).
    getScriptParsedStatus: () => ({
      status: 'idle',
      messages: [{ role: 'assistant', content: 'Done — standalone turn finished.' }],
    }),
    getScreenText: () => '',
    get isWaitingForResponse() { return adapterWaiting },
    chatMessagesOwnedExternally: true,
    // Set by onTurnStarted on a real dispatch; PERSISTS past completion — the
    // field the rescue misread as "turn started, generating never armed".
    currentTurnTaskId: 'task-reflash-1',
    currentTurnStartedAt: Date.now(),
  }

  // ── Minimal stubs for collaborators; the flush + synth stay REAL ──
  instance.maybeAutoApproveStatus = () => false
  instance.promoteProviderSessionId = () => {}
  instance.applyProviderResponse = () => {}
  instance.completionFinalAssistantEvidence = (msgs: any) => ({
    present: true,
    messages: Array.isArray(msgs) ? msgs : [],
    source: 'external-native',
  })
  instance.completionHasFinalAssistantMessage = () => true
  instance.hasAdapterPendingResponse = () => adapterWaiting
  instance.completionFinalSummary = () => 'Done — standalone turn finished.'
  instance.getCompletedFinalizationBlock = () => null // clean-emit path
  instance.shouldAutoApprove = () => false
  // Flush synchronously — production flushDelay is 0 for a non-mesh
  // native-history session, so this is the real timing too.
  instance.scheduleCompletedDebounceFlush = () => { ;(instance as any).flushCompletedDebounceIfFinalized() }
  instance.monitor = { check: () => [] }
  instance.context = { emitProviderEvent: (e: any) => events.push(e) }
  instance.events = []

  return {
    instance,
    events,
    setAdapterStatus: (status: string) => { adapterStatus = status },
    setAdapterWaiting: (waiting: boolean) => { adapterWaiting = waiting },
  }
}

function completions(events: any[]): any[] {
  return events.filter((e) => e.event === 'agent:generating_completed')
}

function started(events: any[]): any[] {
  return events.filter((e) => e.event === 'agent:generating_started')
}

/** Drive a NORMAL turn through the real transition layer: idle → generating
 *  (armed), debounce-fired started, generating → idle → real flush (genuine
 *  completion). Returns after the genuine completion has been emitted. */
function driveNormalTurnToGenuineCompletion(h: Harness): void {
  const { instance, setAdapterStatus, setAdapterWaiting } = h

  setAdapterStatus('generating')
  setAdapterWaiting(true)
  instance.detectStatusTransition() // idle → generating (arms generatingStartedAt + started debounce)
  expect(instance.generatingStartedAt).toBeGreaterThan(0)

  // The turn outlasts the 1s started-debounce: the debounce timer fires
  // agent:generating_started (emulated deterministically — real timers are
  // cleared so nothing fires asynchronously mid-test).
  const startedPending = instance.generatingDebouncePending
  expect(startedPending).not.toBeNull()
  if (instance.generatingDebounceTimer) { clearTimeout(instance.generatingDebounceTimer); instance.generatingDebounceTimer = null }
  instance.generatingDebouncePending = null
  instance.pushEvent({ event: 'agent:generating_started', ...startedPending })

  setAdapterStatus('idle')
  setAdapterWaiting(false)
  instance.detectStatusTransition() // generating → idle → arms + REAL flush emits the genuine completion
}

describe('CliProviderInstance — standalone startup-grace generating reflash', () => {
  it('(1) REGRESSION: normal generating→genuine completion inside grace, then idle-stayed poll emits NO synthesized pair', () => {
    const h = makeInstance()
    driveNormalTurnToGenuineCompletion(h)

    // The genuine completion landed via the real flush.
    const genuine = completions(h.events)
    expect(genuine.length).toBe(1)
    expect(genuine[0].evidenceLevel).toBe('transcript') // genuine, not the weak synth
    expect(h.instance.generatingStartedAt).toBe(0) // consumed by the flush — the misfire precondition
    // The completed-turn guard stamped the turn as satisfied for the synth.
    expect(h.instance.fastCollapseSynthesizedTaskId).toBe('task-reflash-1')

    // The late idle-stayed polls inside the grace window: pre-fix these
    // misclassified the already-completed turn as a never-armed fast-collapse
    // and emitted a back-to-back WEAK started+completed pair (the reflash).
    h.instance.detectStatusTransition() // idle → idle
    h.instance.detectStatusTransition() // idle → idle again

    expect(completions(h.events).length).toBe(1)
    expect(started(h.events).length).toBe(1)
    expect(completions(h.events).some((e) => e.completionDiagnostic?.reason === 'startup_grace_idle_turn_collapse')).toBe(false)
    expect(completions(h.events).some((e) => e.evidenceLevel === 'weak')).toBe(false)
  })

  it('(2) PRESERVED: a never-armed genuine fast-collapse still synthesizes exactly one pair', () => {
    const h = makeInstance()
    // The turn STARTED+FINISHED while status stayed 'idle' the whole time — no
    // generating frame was ever armed (the intended startup-grace rescue).
    h.setAdapterWaiting(false)
    h.setAdapterStatus('idle')
    h.instance.detectStatusTransition() // idle → idle — rescue fires

    const synth = completions(h.events)
    expect(synth.length).toBe(1)
    expect(synth[0].completionDiagnostic?.reason).toBe('startup_grace_idle_turn_collapse')
    expect(synth[0].evidenceLevel).toBe('weak')
    expect(started(h.events).length).toBe(1)
    expect(h.instance.fastCollapseSynthesizedTaskId).toBe('task-reflash-1')
  })

  it('(3) IDEMPOTENT: a second idle-stayed poll emits nothing — after EITHER the rescue or a genuine completion', () => {
    // After the rescue synth: re-polls stay quiet.
    const rescued = makeInstance()
    rescued.instance.detectStatusTransition()
    rescued.instance.detectStatusTransition()
    rescued.instance.detectStatusTransition()
    expect(completions(rescued.events).length).toBe(1)
    expect(started(rescued.events).length).toBe(1)

    // After a normal genuine completion: re-polls stay quiet (the reflash guard).
    const completed = makeInstance()
    driveNormalTurnToGenuineCompletion(completed)
    completed.instance.detectStatusTransition()
    completed.instance.detectStatusTransition()
    expect(completions(completed.events).length).toBe(1)
    expect(started(completed.events).length).toBe(1)
  })

  it('(4) PROJECTION PROXY: the event stream a status reducer consumes ends idle (no generating_started after the completion)', () => {
    // daemon-core has no generating/idle reducer (see file header); assert the
    // projection's input stream instead — a reducer fed this stream settles
    // idle at the completion and never re-enters generating.
    const h = makeInstance()
    driveNormalTurnToGenuineCompletion(h)
    h.instance.detectStatusTransition()
    h.instance.detectStatusTransition()

    const phaseEvents = h.events.filter(
      (e) => e.event === 'agent:generating_started' || e.event === 'agent:generating_completed',
    )
    expect(phaseEvents.length).toBe(2)
    expect(phaseEvents[phaseEvents.length - 1].event).toBe('agent:generating_completed')
  })
})
