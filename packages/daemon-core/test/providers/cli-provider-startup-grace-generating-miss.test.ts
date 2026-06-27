import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// GENERATING-MISSING (win32 fresh-worktree first-turn): a freshly-launched mesh worker
// session is in FSM state 'starting' (CliStateEngine.currentStatus defaults to 'starting';
// CliProviderInstance.lastStatus defaults to 'starting'). When the FIRST inject turn arrives
// while the session is still inside the startup-grace window and the turn is fast (a ~19s
// read-only task on win32), the engine's PTY-driven settle evaluation can flip the *adapter*
// status directly starting → generating (CliStateEngine.applyGenerating → setStatus('generating'))
// without the FSM ever having OBSERVED an intervening 'idle' frame in
// CliProviderInstance.detectStatusTransition().
//
// detectStatusTransition()'s transition table (cli-provider-instance.ts) handles:
//   idle → generating, * → waiting_approval, waiting_approval → generating,
//   (generating|waiting_approval) → idle, starting → idle, * → error, * → stopped.
// BEFORE the fix it did NOT handle starting → generating: that frame fell straight through to
// the bare `this.lastStatus = newStatus` update — generatingStartedAt stayed 0 and
// generatingDebouncePending stayed null (only the idle → generating arm set them). When the fast
// turn then completed (generating → idle), the (generating|waiting_approval)→idle arm's FIRST
// guard `if (!this.generatingStartedAt && !this.generatingDebouncePending) { /* suppress */ }`
// treated the completion as a "startup-phase generating→idle blip" and SUPPRESSED it — so NO
// agent:generating_started AND NO agent:generating_completed were emitted (the live win32
// first-turn miss) and the coordinator never learned the worker went idle.
//
// THE FIX widens the idle → generating arm to also fire on starting → generating. That edge is
// only ever observed when a turn is genuinely active (CliStateEngine.applyGenerating bails when
// !isWaitingForResponse && no turn scope), so it is never pure startup PTY noise — arming the
// generating bookkeeping on it is safe and makes the fast first-turn completion fire normally.
// The separate starting → idle arm (genuine startup with no input) is unaffected: that edge has
// newStatus 'idle', not 'generating'.
//
// This is a UNIT-level test: the behavior lives entirely inside detectStatusTransition()'s
// reaction to (adapterStatus.status, this.lastStatus), so a fake adapter that replays the
// status frames is sufficient to exercise it. It does NOT require a real PTY / native
// transcript. The CONTROL case (idle observed first) proves the harness emits completions on the
// normal path; the REGRESSION case proves the starting → generating → idle race now also emits.

type Harness = {
  instance: any
  events: any[]
  setAdapterStatus: (status: string) => void
  setAdapterWaiting: (waiting: boolean) => void
}

function makeInstance(initialLastStatus: string): Harness {
  const events: any[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any

  let adapterStatus = 'starting'
  // Models the adapter's in-flight-turn flag (CliStateEngine.isWaitingForResponse, set by
  // onTurnStarted on a real inject, cleared on finishResponse). hasAdapterPendingResponse()
  // reads this — it is the discriminator the fix uses to tell a genuine first-turn
  // starting→generating apart from benign startup PTY-noise blips (which leave it false).
  let adapterWaiting = false

  instance.type = 'claude-cli'
  instance.instanceId = 'sess-grace-1'
  instance.provider = { name: 'Claude', type: 'claude-cli', settings: {}, nativeHistory: {} }
  instance.workingDir = '/repo/worktree-fresh'
  instance.providerSessionId = 'psess-grace-1'
  // Mesh worker context: this is exactly the path that must report generating_completed back
  // to the coordinator. meshActiveTaskId arms hasMeshContext in the short-completion arm.
  instance.settings = { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-grace-1', meshNodeId: 'node-1' }

  // FSM bookkeeping — fresh-session defaults (see field initializers in cli-provider-instance.ts).
  instance.lastStatus = initialLastStatus
  instance.generatingStartedAt = 0
  instance.generatingDebouncePending = null
  instance.generatingDebounceTimer = null
  instance.completedDebouncePending = null
  instance.completedDebounceTimer = null
  instance.lastApprovalEventFingerprint = ''
  instance.autoApproveBusy = false
  instance.agentReadyEmitted = false
  instance.suppressIdleHistoryReplay = false
  // R4b: just-booted by default so the idle-stayed collapse window
  // (STARTUP_GRACE_IDLE_COLLAPSE_WINDOW_MS) is open. Tests that need the
  // grace window CLOSED override this to a stale boot time.
  instance.startedAt = Date.now()
  instance.fastCollapseSynthesizedTaskId = null

  instance.adapter = {
    getStatus: () => ({ status: adapterStatus }),
    getPartialResponse: () => '',
    // A confirmed final assistant message exists (the worker genuinely finished its turn) —
    // this is what makes the live miss so insidious: real work completed, but no event fired.
    getScriptParsedStatus: () => ({
      status: 'idle',
      messages: [{ role: 'assistant', content: 'Done — read 3 files, no changes needed.' }],
    }),
    getScreenText: () => '',
    get isWaitingForResponse() { return adapterWaiting },
    chatMessagesOwnedExternally: true,
  }

  // ── Minimal stubs for collaborators detectStatusTransition() touches ──
  instance.maybeAutoApproveStatus = () => false
  instance.promoteProviderSessionId = () => {}
  instance.applyProviderResponse = () => {}
  instance.isMeshWorkerSession = () => true
  instance.completionFinalAssistantEvidence = (msgs: any) => ({
    present: true,
    messages: Array.isArray(msgs) ? msgs : [],
    source: 'external-native',
  })
  instance.completionHasFinalAssistantMessage = () => true
  // Use the real discriminator semantics: a turn is "pending" exactly while the adapter's
  // isWaitingForResponse flag is set (driven via setAdapterWaiting in each test).
  instance.hasAdapterPendingResponse = () => adapterWaiting
  instance.scheduleCompletedDebounceFlush = () => {
    // For native-source mesh sessions the real flushDelay is short
    // (NATIVE_HISTORY_MESH_IDLE_SETTLE_MS); we flush synchronously here so the test asserts the
    // completedDebouncePending path emits without spinning real timers.
    ;(instance as any).flushCompletedDebounceIfFinalized?.()
  }
  // Real flush is exercised by the debounce-completed (slow) path; for these fast-turn cases the
  // SHORT-generating arm fires first (debounce still pending), so flush is rarely reached. Keep a
  // permissive flush that emits the completion the same way the real one would.
  instance.flushCompletedDebounceIfFinalized = function () {
    const pending = (this as any).completedDebouncePending
    if (!pending) return
    ;(this as any).completedDebouncePending = null
    ;(this as any).pushEvent({
      event: 'agent:generating_completed',
      chatTitle: pending.chatTitle,
      duration: pending.duration,
      timestamp: pending.timestamp,
      finalSummary: 'Done — read 3 files, no changes needed.',
    })
  }
  // monitor.check is invoked at the tail of detectStatusTransition; no-op it.
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

function completionEvents(events: any[]): any[] {
  return events.filter((e) => e.event === 'agent:generating_completed')
}

describe('CliProviderInstance — fresh-session startup-grace generating miss', () => {
  it('CONTROL: a turn that is observed idle BEFORE generating emits generating_completed', () => {
    // Normal path: the FSM sees starting → idle (agent:ready) → generating (turn start) →
    // idle (completion). generatingStartedAt is set by the idle→generating arm, so the
    // completion is NOT suppressed.
    const { instance, events, setAdapterStatus, setAdapterWaiting } = makeInstance('starting')

    setAdapterStatus('idle')
    instance.detectStatusTransition() // starting → idle  (emits agent:ready)
    setAdapterStatus('generating')
    setAdapterWaiting(true)           // real turn in flight
    instance.detectStatusTransition() // idle → generating (arms generatingStartedAt + debounce)
    setAdapterStatus('idle')
    setAdapterWaiting(false)           // turn finished
    instance.detectStatusTransition() // generating → idle (completion)

    const completions = completionEvents(events)
    expect(completions.length).toBeGreaterThanOrEqual(1)
  })

  it('REGRESSION: first turn during startup-grace (starting → generating → idle) still emits generating_completed', () => {
    // The win32 fresh-worktree race: the adapter reports status straight from 'starting' to
    // 'generating' because the inject landed inside the startup-grace window, so
    // detectStatusTransition never sees an 'idle' frame first. The turn IS real
    // (hasAdapterPendingResponse() true), so the new arm fires.
    const { instance, events, setAdapterStatus, setAdapterWaiting } = makeInstance('starting')

    setAdapterStatus('generating')
    setAdapterWaiting(true)            // genuine first inject — adapter is waiting on a response
    instance.detectStatusTransition() // starting → generating  (now armed, same as idle→generating)

    // The starting→generating arm now sets generatingStartedAt and queues the deferred
    // generating_started (generatingDebouncePending), exactly like the idle→generating edge.
    expect(instance.generatingStartedAt).toBeGreaterThan(0)
    expect(instance.generatingDebouncePending).not.toBeNull()
    expect(instance.lastStatus).toBe('generating')

    setAdapterStatus('idle')
    setAdapterWaiting(false)           // fast turn completed
    instance.detectStatusTransition() // generating → idle  (real completion — no longer suppressed)

    const completions = completionEvents(events)
    // FIXED: detectStatusTransition() now arms the generating bookkeeping on the
    // starting → generating edge (gated on a real in-flight turn), so the fast first-turn's
    // generating → idle completion is no longer swallowed by the startup-blip guard. The mesh
    // coordinator therefore receives agent:generating_completed and learns the worker is idle.
    // (Before the fix this asserted .toBe(0) — the live win32 first-turn miss.)
    expect(completions.length).toBeGreaterThanOrEqual(1)
  })

  it('GUARD: a startup-noise starting → generating → idle blip (no real turn) still emits NOTHING', () => {
    // The benign counterpart: the adapter script reports 'generating' from pure startup PTY
    // repaint noise, with NO task dispatched (hasAdapterPendingResponse() false). The new arm
    // must NOT fire here — otherwise we'd resurrect the spurious-completion regression that the
    // "startup-phase spurious completion suppression" tests guard against.
    const { instance, events, setAdapterStatus } = makeInstance('starting')
    // adapterWaiting stays false the whole time — no inject.

    setAdapterStatus('generating')
    instance.detectStatusTransition() // starting → generating  (UNARMED — falls through)

    // No turn → no arming. lastStatus advances but the bookkeeping stays clean.
    expect(instance.generatingStartedAt).toBe(0)
    expect(instance.generatingDebouncePending).toBeNull()
    expect(instance.lastStatus).toBe('generating')

    setAdapterStatus('idle')
    instance.detectStatusTransition() // generating → idle  (suppressed as a startup blip)

    expect(completionEvents(events).length).toBe(0)
  })

  // ── R4 GENERATING-BOUNDARY fast-collapse (starting → idle DIRECTLY, no generating frame) ──
  //
  // The deeper variant the REGRESSION case above can't reach: on a daemon whose claude-cli FSM
  // spec lacks the starting→busy edge, a fast turn dispatched into the startup-grace window
  // never moves the FSM to 'busy'/generating at all — the adapter reports starting → idle
  // DIRECTLY (the startup-grace elapsed_ms fires after the turn already finished). The
  // starting→generating arm above therefore never sees a 'generating' frame to arm on, and the
  // only matching arm (newStatus 'idle' && lastStatus 'starting') used to emit agent:ready ONLY.
  // The defense line synthesizes the started+completed pair when — and only when — a turn
  // actually STARTED this boot (adapter.currentTurnTaskId, set by onTurnStarted, persists past
  // completion) AND already FINISHED (hasAdapterPendingResponse() false), so it cannot fire on a
  // benign idle boot, a queued-pending first turn that only runs after grace, or a turn still
  // mid-flight at the grace expiry.

  it('FAST-COLLAPSE: starting → idle directly (no generating frame) with a finished turn emits started+completed', () => {
    const { instance, events, setAdapterStatus, setAdapterWaiting } = makeInstance('starting')
    // A turn STARTED and FINISHED inside the startup-grace window: onTurnStarted bound the
    // taskId (persists past completion), and the turn is no longer in flight.
    instance.adapter.currentTurnTaskId = 'task-grace-1'
    setAdapterWaiting(false)
    setAdapterStatus('idle')
    instance.detectStatusTransition() // starting → idle directly — FSM never reached generating

    const completions = completionEvents(events)
    expect(completions.length).toBe(1)
    expect(completions[0].completionDiagnostic?.reason).toBe('startup_grace_fast_collapse')
    // A well-formed started→completed pair (chat bubble + CANON-B dispatch ack).
    expect(events.some((e) => e.event === 'agent:generating_started')).toBe(true)
    // agent:ready is still emitted (preserved behavior).
    expect(events.some((e) => e.event === 'agent:ready')).toBe(true)
  })

  it('GUARD: a genuine idle boot (starting → idle, no turn ever started) emits ready only, no completion', () => {
    const { instance, events, setAdapterStatus } = makeInstance('starting')
    // No turn started this boot: adapter.currentTurnTaskId stays undefined, nothing in flight.
    setAdapterStatus('idle')
    instance.detectStatusTransition() // starting → idle — pure startup, prompt drawn

    expect(completionEvents(events).length).toBe(0)
    expect(events.some((e) => e.event === 'agent:ready')).toBe(true)
  })

  it('GUARD: starting → idle while the turn is STILL in flight emits no premature completion', () => {
    const { instance, events, setAdapterStatus, setAdapterWaiting } = makeInstance('starting')
    // A turn started but is STILL running when startup-grace expires (hasAdapterPendingResponse
    // true). Firing here would be a premature mid-turn completion; idle→busy self-corrects and
    // the real completion fires later. The queued-pending case (turn not yet started →
    // currentTurnTaskId undefined) is covered by the previous guard.
    instance.adapter.currentTurnTaskId = 'task-grace-1'
    setAdapterWaiting(true)
    setAdapterStatus('idle')
    instance.detectStatusTransition() // starting → idle mid-turn

    expect(completionEvents(events).length).toBe(0)
  })

  // ── R4b GENERATING-BOUNDARY idle-stayed collapse (already-idle session, NO status change) ──
  //
  // The residual variant the FAST-COLLAPSE case above can't reach (the live rc.403 Probe1 miss):
  // the launch settle already drained starting→idle BEFORE the first turn arrives, so the session
  // is ALREADY 'idle' (lastStatus 'idle') when the turn is dispatched. The turn runs+completes
  // inside the startup-grace window too fast for any poll to observe a 'generating' frame, so the
  // adapter status stays 'idle' the WHOLE turn — there is NO status change (idle→idle).
  // detectStatusTransition's change block is skipped entirely, so neither the starting→idle
  // fast-collapse arm nor the idle→generating arm ever runs. The idle-stayed defense line
  // (gated on the startup-grace age window) catches it and synthesizes the started+completed pair.

  it('IDLE-COLLAPSE: already-idle first turn that completes within grace (no status change) emits started+completed', () => {
    const { instance, events, setAdapterStatus, setAdapterWaiting } = makeInstance('idle')
    // A turn STARTED and FINISHED while status stayed 'idle' the whole time. onTurnStarted bound
    // the taskId (persists past completion); the turn is no longer in flight; generating was
    // never armed (generatingStartedAt 0, no debounce pending).
    instance.adapter.currentTurnTaskId = 'task-grace-1'
    setAdapterWaiting(false)
    setAdapterStatus('idle')
    instance.detectStatusTransition() // idle → idle — NO status change; idle-stayed arm fires

    const completions = completionEvents(events)
    expect(completions.length).toBe(1)
    expect(completions[0].completionDiagnostic?.reason).toBe('startup_grace_idle_turn_collapse')
    // A well-formed started→completed pair (chat bubble + CANON-B dispatch ack).
    expect(events.some((e) => e.event === 'agent:generating_started')).toBe(true)
  })

  it('IDLE-COLLAPSE IDEMPOTENT: re-polling the idle session does not re-emit the pair', () => {
    const { instance, events, setAdapterStatus, setAdapterWaiting } = makeInstance('idle')
    instance.adapter.currentTurnTaskId = 'task-grace-1'
    setAdapterWaiting(false)
    setAdapterStatus('idle')
    instance.detectStatusTransition() // synthesize once
    instance.detectStatusTransition() // re-poll — guarded by fastCollapseSynthesizedTaskId
    instance.detectStatusTransition() // re-poll again

    expect(completionEvents(events).length).toBe(1)
    expect(events.filter((e) => e.event === 'agent:generating_started').length).toBe(1)
  })

  it('GUARD: already-idle session with NO turn started emits nothing (benign idle boot)', () => {
    const { instance, setAdapterStatus, events } = makeInstance('idle')
    // No turn started: currentTurnTaskId undefined. A quiet idle session inside the grace window
    // must not synthesize a phantom completion.
    setAdapterStatus('idle')
    instance.detectStatusTransition()

    expect(completionEvents(events).length).toBe(0)
  })

  it('GUARD: a finished first turn OUTSIDE the grace window is NOT mislabelled a startup collapse', () => {
    const { instance, events, setAdapterStatus, setAdapterWaiting } = makeInstance('idle')
    // Boot was long ago — the startup-grace window is closed. A later unobservably-fast turn
    // must not be attributed to the startup-grace collapse here; the normal idle→busy→idle path
    // (or other reconciliation) owns post-grace turns.
    instance.startedAt = Date.now() - 30_000
    instance.adapter.currentTurnTaskId = 'task-late-1'
    setAdapterWaiting(false)
    setAdapterStatus('idle')
    instance.detectStatusTransition()

    expect(completionEvents(events).length).toBe(0)
  })

  it('GUARD: already-idle with the turn STILL in flight emits no premature completion', () => {
    const { instance, events, setAdapterStatus, setAdapterWaiting } = makeInstance('idle')
    // Turn started but still running inside the grace window — must not fire a mid-turn
    // completion. The real completion fires later via the normal generating→idle path.
    instance.adapter.currentTurnTaskId = 'task-grace-1'
    setAdapterWaiting(true)
    setAdapterStatus('idle')
    instance.detectStatusTransition()

    expect(completionEvents(events).length).toBe(0)
  })
})
