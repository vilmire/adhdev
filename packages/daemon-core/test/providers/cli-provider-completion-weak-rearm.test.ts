import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// COMPLETION-WEAK-REARM (fix1). The worker-side double-emit latch used to short-circuit
// the three transcript re-emit paths (flushMeshCompletionBeforeCleanup, the pure-PTY and
// native-source stall reconciles) on ANY prior emit for the taskId, regardless of the
// first emit's evidence. So after a WEAK completion (CANON-C decoupled-immediate
// missing_final_assistant, or a startup-grace fast-collapse synth), the same session
// reaching a GENUINE idle later (final assistant present) was silently swallowed — the
// worker never emitted the genuine completion and the coordinator held until the acked-
// death deadline (~8 min).
//
// Fix1 makes the latch evidence-aware: a WEAK prior emit is re-armable ONCE, across a real
// generating→idle transition (busyEpoch advanced), and the genuine re-emit overwrites the
// latch with weak=false so no third emit ever fires. A GENUINE prior emit stays single-shot.
//
// These tests drive flushMeshCompletionBeforeCleanup as the re-emit path (it runs the real
// emitGeneratingCompleted, so the latch is stamped exactly as production does). The evidence
// GATE (in-turn transcript summary) is stubbed — what is exercised here is the double-emit
// latch's evidence/epoch awareness, not the summary parser.

describe('CliProviderInstance completion weak re-arm (fix1)', () => {
  function makeInstance(opts: {
    settings?: Record<string, any>
    turnStartedAt?: number
    meshTaskInjectedAt?: number
    finalSummary?: string | undefined
    lastEmittedCompletion?: { taskId: string; at: number; evidenceLevel?: string; weak: boolean; emittedAtEpoch: number } | null
    busyEpoch?: number
  } = {}) {
    const emitted: any[] = []
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.instanceId = 'sess-1'
    instance.type = 'kimi'
    instance.workingDir = '/work/repo'
    instance.providerSessionId = 'prov-sess-1'
    instance.settings = opts.settings ?? { meshNodeFor: 'mesh-abc', meshNodeId: 'node-1', meshActiveTaskId: 'task-1' }
    instance.events = []
    instance.startedAt = 1_000
    instance.busyEpoch = opts.busyEpoch ?? 0
    instance.meshTaskInjectedAt = opts.meshTaskInjectedAt ?? 2_000
    instance.lastCompletionSummary = null
    instance.lastEmittedCompletion = opts.lastEmittedCompletion ?? null
    const adapter = {
      currentTurnTaskId: undefined as string | undefined,
      currentTurnStartedAt: opts.turnStartedAt ?? 3_000, // AFTER injection → injected task ran
      getScriptParsedStatus() { return { messages: [] } },
    }
    instance.adapter = adapter
    instance.context = { emitProviderEvent: (e: any) => emitted.push(e) }
    // The evidence gate reads the native transcript; stub the turn-scoped summary so the
    // gate PASSES (a genuine turn-end) and the latch behavior is what's under test.
    instance.completionFinalSummary = () => (opts.finalSummary === undefined ? 'done: finished the turn' : opts.finalSummary)
    return { instance, emitted }
  }

  // A weak latch as production would stamp it from the CANON-C decoupled-immediate emit:
  // missing_final_assistant → isWeakCompletionEvidence()=true → weak:true, at epoch 0.
  const weakLatch = { taskId: 'task-1', at: 5_000, evidenceLevel: undefined as string | undefined, weak: true, emittedAtEpoch: 0 }

  it('RE-ARMS: a WEAK prior emit + a genuine idle after a generating transition emits a SECOND (genuine) completion — no acked-death wait', () => {
    const { instance, emitted } = makeInstance({
      lastEmittedCompletion: { ...weakLatch },
      busyEpoch: 1, // a real generating phase opened AFTER the weak emit (epoch advanced 0→1)
    })
    const result = instance.flushMeshCompletionBeforeCleanup()
    expect(result).toBe(true)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].event).toBe('agent:generating_completed')
    expect(emitted[0].taskId).toBe('task-1')
    // The genuine re-emit carries strong evidence → the coordinator fingerprint surfaces it
    // as ::genuine (not collapsed against the ::weak first emit).
    expect(emitted[0].evidenceLevel).toBe('reported')
    // ONE-SHOT CAP: the latch is overwritten with the now-genuine (weak=false) evidence.
    expect(instance.lastEmittedCompletion.weak).toBe(false)
    expect(instance.lastEmittedCompletion.evidenceLevel).toBe('reported')
  })

  it('ONE-SHOT: after the weak→genuine re-emit, a further idle tick emits NOTHING (never a third emit)', () => {
    const { instance, emitted } = makeInstance({
      lastEmittedCompletion: { ...weakLatch },
      busyEpoch: 1,
    })
    // First re-emit (the genuine, second overall emission).
    expect(instance.flushMeshCompletionBeforeCleanup()).toBe(true)
    expect(emitted).toHaveLength(1)
    // A subsequent idle tick — even if the busyEpoch advances again — must NOT re-fire:
    // the latch is now genuine (weak=false) → single-shot. Re-stamp membership (the emit
    // detached the task markers) so the suppression is genuinely the latch, not detachment.
    instance.settings = { meshNodeFor: 'mesh-abc', meshNodeId: 'node-1', meshActiveTaskId: 'task-1' }
    instance.busyEpoch = 5
    expect(instance.flushMeshCompletionBeforeCleanup()).toBe(false)
    expect(emitted).toHaveLength(1)
  })

  it('does NOT re-arm off a STATIC idle: a weak latch with NO intervening generating transition (busyEpoch unchanged) stays suppressed', () => {
    const { instance, emitted } = makeInstance({
      lastEmittedCompletion: { ...weakLatch, emittedAtEpoch: 3 },
      busyEpoch: 3, // no generating phase opened since the weak emit → same frame
    })
    expect(instance.flushMeshCompletionBeforeCleanup()).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('GENUINE prior emit stays single-shot: a non-weak latch is never re-emitted (no spurious re-arm)', () => {
    const { instance, emitted } = makeInstance({
      lastEmittedCompletion: { taskId: 'task-1', at: 5_000, evidenceLevel: 'reported', weak: false, emittedAtEpoch: 0 },
      busyEpoch: 9, // even with epochs advanced, a genuine emit does not re-arm
    })
    expect(instance.flushMeshCompletionBeforeCleanup()).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('a FIRST sufficient (genuine) emit yields exactly ONE emission and arms a single-shot latch', () => {
    const { instance, emitted } = makeInstance({ lastEmittedCompletion: null, busyEpoch: 1 })
    // First flush → genuine emit (no prior latch).
    expect(instance.flushMeshCompletionBeforeCleanup()).toBe(true)
    expect(emitted).toHaveLength(1)
    expect(instance.lastEmittedCompletion.weak).toBe(false)
    // Second flush for the same turn → suppressed by the genuine latch. Re-stamp membership
    // (the emit detached the task markers) so the latch is what suppresses. Exactly ONE total.
    instance.settings = { meshNodeFor: 'mesh-abc', meshNodeId: 'node-1', meshActiveTaskId: 'task-1' }
    expect(instance.flushMeshCompletionBeforeCleanup()).toBe(false)
    expect(emitted).toHaveLength(1)
  })

  it('end-to-end sequence: weak first emit → generating → genuine idle yields exactly TWO emissions (not three)', () => {
    // Simulate the production weak first emit: drive emitGeneratingCompleted directly with the
    // CANON-C weak shape (missing_final_assistant) so the latch is stamped weak=true, at epoch 0.
    const { instance, emitted } = makeInstance({ lastEmittedCompletion: null, busyEpoch: 0 })
    instance.emitGeneratingCompleted({
      chatTitle: '',
      duration: undefined,
      timestamp: 10_000,
      taskId: 'task-1',
      finalSummary: undefined,
      completionDiagnostic: { blockReason: 'missing_final_assistant', finalAssistantPresent: false },
    })
    expect(emitted).toHaveLength(1) // emission #1 (weak)
    expect(instance.lastEmittedCompletion.weak).toBe(true)

    // The weak emit's pushEvent detaches the task-level mesh markers (terminal event). The
    // worker then RESUMES the same assigned task — re-stamp the active mesh binding, exactly
    // as attachMeshAssignment does on the resumed turn — and a real generating phase opens
    // (busyEpoch advances).
    instance.settings = { meshNodeFor: 'mesh-abc', meshNodeId: 'node-1', meshActiveTaskId: 'task-1' }
    instance.busyEpoch = 1

    // Genuine idle with a final assistant reaches the pre-cleanup flush → emission #2 (genuine).
    expect(instance.flushMeshCompletionBeforeCleanup()).toBe(true)
    expect(emitted).toHaveLength(2)
    expect(emitted[1].evidenceLevel).toBe('reported')
    // The latch is now genuine (weak=false) — the one-shot cap is armed.
    expect(instance.lastEmittedCompletion.weak).toBe(false)

    // Re-stamp membership (as if the session lingered assigned) and advance the epoch again:
    // the now-GENUINE latch suppresses any further idle tick → exactly TWO, never a third.
    instance.settings = { meshNodeFor: 'mesh-abc', meshNodeId: 'node-1', meshActiveTaskId: 'task-1' }
    instance.busyEpoch = 2
    expect(instance.flushMeshCompletionBeforeCleanup()).toBe(false)
    expect(emitted).toHaveLength(2)
  })
})
