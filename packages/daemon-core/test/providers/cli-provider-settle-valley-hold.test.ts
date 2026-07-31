import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// (SETTLE-VALLEY) A native-history (claude-cli) mesh worker resolves an approval and falls
// briefly idle (waiting_approval→idle) BEFORE the next approval turn resumes. The live
// inter-approval idle valley (~3s) can exceed NATIVE_HISTORY_MESH_IDLE_SETTLE_MS (4000ms), so
// flushCompletedDebounceIfFinalized runs while the append-only transcript's final assistant
// turn is not yet written (finalAssistantPresent=false; coordinator labels workerResult.source
// ='default' → evidenceLevel=insufficient). The pre-fix CANON-C decoupled-immediate emit would
// fire here, freezing a TRUNCATED preamble summary into the append-only ledger before the
// worker picks the turn back up.
//
// The fix HOLDS that approval-resolved missing_final_assistant completion (terminal:false, no
// allowTimeout) instead of emitting immediately, so:
//   (1) the truncated weak summary is never emitted during the valley,
//   (2) the resume guard catches the worker resuming, and
//   (3) a GENUINE completion fires once the transcript's final assistant arrives.
// This is independent of the valley's length — unlike merely widening the settle window.

type FlushHarness = {
  instance: any
  events: any[]
  rescheduleCalls: number[]
}

function makeFlushInstance(opts: {
  evidencePresent: boolean
  finalSummary?: string
  previousStatus: 'generating' | 'waiting_approval'
  meshContext?: boolean
  adapterStatus?: string
}): FlushHarness {
  const events: any[] = []
  const rescheduleCalls: number[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any

  instance.type = 'claude-cli'
  instance.instanceId = 'sess-valley'
  instance.provider = { name: 'Claude', settings: {}, nativeHistory: {} }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = 'psess-1'
  instance.settings = opts.meshContext === false ? {} : { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' }
  instance.lastStatus = 'generating'
  instance.generatingStartedAt = 1000
  instance.lastApprovalEventFingerprint = ''
  instance.autoApproveBusy = false
  instance.completedDebounceTimer = null
  instance.completedDebouncePending = {
    chatTitle: 'task',
    duration: 5,
    timestamp: 111,
    firstObservedAt: Date.now(), // waitedMs ≈ 0 — well under the 30s force-emit cap
    previousStatus: opts.previousStatus,
  }

  const adapterStatus = opts.adapterStatus ?? 'idle'
  instance.adapter = {
    chatMessagesOwnedExternally: true, // native-source provider
    getStatus: () => ({ status: adapterStatus }),
    getPartialResponse: () => '',
    getScriptParsedStatus: () => ({ status: 'idle', messages: [] }),
    getScreenText: () => '',
    isWaitingForResponse: false,
  }

  instance.shouldAutoApprove = () => false
  instance.hasApprovalResolutionEvidence = () => true // not exercising the approval-resolution gate
  instance.completionFinalAssistantEvidence = () => ({
    present: opts.evidencePresent,
    messages: [],
    source: 'external-native',
  })
  instance.completionFinalSummary = () => opts.finalSummary
  instance.recordPendingTranscriptProbe = () => null
  instance.scheduleCompletedDebounceFlush = (delayMs: number) => { rescheduleCalls.push(delayMs) }

  instance.context = { emitProviderEvent: (e: any) => events.push(e) }
  instance.events = []

  return { instance, events, rescheduleCalls }
}

describe('CliProviderInstance — SETTLE-VALLEY inter-approval idle hold', () => {
  it('HOLDS (does not emit a truncated weak completion) for an approval-resolved native-history mesh worker whose transcript is unwritten', () => {
    const { instance, events, rescheduleCalls } = makeFlushInstance({
      evidencePresent: false,
      finalSummary: "I'll verify the two fixes...", // the truncated preamble that must NOT be emitted
      previousStatus: 'waiting_approval',
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    // No completion emitted during the valley — the weak insufficient summary is suppressed.
    expect(events).toHaveLength(0)
    // Held: a retry was scheduled (bounded by COMPLETED_FINALIZATION_MAX_WAIT_MS).
    expect(rescheduleCalls.length).toBeGreaterThan(0)
    // The pending completion is still alive so the retry can observe resume / transcript arrival.
    expect((instance as any).completedDebouncePending).not.toBeNull()
  })

  it('emits a GENUINE completion once the transcript final assistant arrives on a later flush', () => {
    const { instance, events, rescheduleCalls } = makeFlushInstance({
      evidencePresent: true,
      finalSummary: 'Verified both fixes; tests pass; 2 files changed.',
      previousStatus: 'waiting_approval',
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(rescheduleCalls).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('agent:generating_completed')
    expect(events[0].finalSummary).toBe('Verified both fixes; tests pass; 2 files changed.')
    // Genuine: no missing-final-assistant weakness marker. Transcript-authoritative
    // completions now carry a diagnostic describing the evidence they were judged on,
    // so "genuine" is asserted on that evidence rather than on the diagnostic's absence.
    expect(events[0].completionDiagnostic).toMatchObject({
      evidenceWeak: false,
      finalAssistantPresent: true,
    })
    expect((instance as any).completedDebouncePending).toBeNull()
  })

  it('cancels the pending completion when the worker RESUMES during the hold (no spurious emit)', () => {
    const { instance, events, rescheduleCalls } = makeFlushInstance({
      evidencePresent: false,
      finalSummary: "I'll verify the two fixes...",
      previousStatus: 'waiting_approval',
      adapterStatus: 'generating', // worker resumed into the next approval turn
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    // Resume guard: no completion emitted, pending cleared, nothing rescheduled.
    expect(events).toHaveLength(0)
    expect(rescheduleCalls).toEqual([])
    expect((instance as any).completedDebouncePending).toBeNull()
  })

  it('still emits IMMEDIATELY (CANON-C unchanged) for a generating→idle background-child completion', () => {
    // previousStatus='generating' is the background-child false-idle the CANON-C decoupled
    // immediate emit was designed for — the transcript trails by a write, not a whole resume.
    const { instance, events, rescheduleCalls } = makeFlushInstance({
      evidencePresent: false,
      previousStatus: 'generating',
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(rescheduleCalls).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0].completionDiagnostic.blockReason).toBe('missing_final_assistant')
    expect(events[0].completionDiagnostic.finalAssistantPresent).toBe(false)
    expect(events[0].completionDiagnostic.decoupledImmediateEmit).toBe(true)
    expect((instance as any).completedDebouncePending).toBeNull()
  })

  it('still HOLDS for a NON-mesh approval-resolved session (plain terminal hold, no decouple)', () => {
    const { instance, events, rescheduleCalls } = makeFlushInstance({
      evidencePresent: false,
      previousStatus: 'waiting_approval',
      meshContext: false,
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(events).toHaveLength(0)
    expect(rescheduleCalls.length).toBeGreaterThan(0)
  })
})
