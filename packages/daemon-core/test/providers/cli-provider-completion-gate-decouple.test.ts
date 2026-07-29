import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// CANON-C (completion-gate decouple): for a native-source provider (claude-cli owns its
// chat history externally), the worker FSM reaches idle BEFORE the append-only transcript's
// final assistant turn is written. The completion event used to be held up to
// COMPLETED_FINALIZATION_MAX_WAIT_MS (30s) waiting for that transcript evidence — leaving the
// mesh coordinator false-generating, because agent:generating_completed is its ONLY path to
// learn the worker is idle. The fix decouples the idle NOTIFICATION from the transcript
// evidence: when the only block is the transcript-evidence gate (missing_final_assistant with
// allowTimeout, i.e. a mesh worker session), the completion is emitted IMMEDIATELY, marked
// weak. The finalSummary is enriched on a separate path (the mesh reconcile loop re-reads the
// transcript and re-emits a genuine completion — CANON-B weak→genuine).

type FlushHarness = {
  instance: any
  events: any[]
  rescheduleCalls: number[]
}

function makeFlushInstance(opts: {
  evidencePresent: boolean
  finalSummary?: string
  meshContext?: boolean
}): FlushHarness {
  const events: any[] = []
  const rescheduleCalls: number[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any

  instance.type = 'claude-cli'
  instance.instanceId = 'sess-canonc'
  instance.provider = { name: 'Claude', settings: {}, nativeHistory: {} }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = 'psess-1'
  // meshNodeFor → allowMissingAssistantTimeout=true (the gate's mesh-context arming). No
  // meshActiveTaskId so the terminal-event auto-detach path is not exercised.
  instance.settings = opts.meshContext === false ? {} : { meshNodeFor: 'mesh-1' }
  instance.lastStatus = 'generating'
  instance.generatingStartedAt = 1000
  instance.lastApprovalEventFingerprint = ''
  instance.autoApproveBusy = false
  instance.completedDebounceTimer = null
  instance.completedDebouncePending = {
    chatTitle: 'task',
    duration: 5,
    timestamp: 111,
    firstObservedAt: Date.now(), // waitedMs ≈ 0 → pre-fix this would reschedule, never emit
    previousStatus: 'generating',
  }

  instance.adapter = {
    chatMessagesOwnedExternally: true, // native-source provider
    getStatus: () => ({ status: 'idle' }),
    getPartialResponse: () => '',
    getScriptParsedStatus: () => ({ status: 'idle', messages: [] }),
    getScreenText: () => '',
    isWaitingForResponse: false,
  }

  instance.shouldAutoApprove = () => false
  // Transcript evidence: absent → missing_final_assistant gate; present → genuine completion.
  instance.completionFinalAssistantEvidence = () => ({
    present: opts.evidencePresent,
    messages: [],
    source: 'external-native',
  })
  instance.completionFinalSummary = () => opts.finalSummary
  instance.recordPendingTranscriptProbe = () => null
  // Spy on the hold/retry path: a reschedule means the completion was HELD, not emitted.
  instance.scheduleCompletedDebounceFlush = (delayMs: number) => { rescheduleCalls.push(delayMs) }

  instance.context = { emitProviderEvent: (e: any) => events.push(e) }
  instance.events = []

  return { instance, events, rescheduleCalls }
}

describe('CliProviderInstance — CANON-C completion-gate decouple', () => {
  it('emits agent:generating_completed IMMEDIATELY (no 30s hold) when the FSM is idle but the transcript is unwritten', () => {
    const { instance, events, rescheduleCalls } = makeFlushInstance({ evidencePresent: false })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    // The completion fired on the FIRST flush — it was not deferred to the 30s timeout.
    expect(rescheduleCalls).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('agent:generating_completed')
    // Marked weak so CANON-B's buildPendingEventFingerprint / isFalseIdleCompletion treat it
    // as a tentative false-idle (the direct dispatch stays active for the transcript reconcile).
    expect(events[0].completionDiagnostic.blockReason).toBe('missing_final_assistant')
    expect(events[0].completionDiagnostic.finalAssistantPresent).toBe(false)
    expect(events[0].completionDiagnostic.decoupledImmediateEmit).toBe(true)
    expect(events[0].completionDiagnostic.emittedAfterFinalizationTimeout).toBe(false)
    // The pending debounce is cleared — the session is idle, the notification is out.
    expect((instance as any).completedDebouncePending).toBeNull()
  })

  it('still emits a GENUINE completion carrying the transcript-derived finalSummary once the transcript is present', () => {
    const { instance, events, rescheduleCalls } = makeFlushInstance({
      evidencePresent: true,
      finalSummary: 'Refactored auth; 3 files changed; tests pass.',
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(rescheduleCalls).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('agent:generating_completed')
    // Enriched summary survives — the transcript path is the source of truth for the summary.
    expect(events[0].finalSummary).toBe('Refactored auth; 3 files changed; tests pass.')
    // A genuine completion carries the clean, strong transcript contract and
    // no missing-final-assistant weakness marker.
    expect(events[0].completionDiagnostic.blockReason).toBeUndefined()
    expect(events[0].completionDiagnostic.finalAssistantPresent).toBe(true)
    expect(events[0].completionDiagnostic.cleanPath).toBe(true)
    expect(events[0].completionDiagnostic.evidenceWeak).toBe(false)
  })

  it('does NOT decouple for a NON-mesh session: the transcript-evidence gate still holds (allowTimeout disarmed)', () => {
    // Without mesh context, allowMissingAssistantTimeout is false → the missing_final_assistant
    // block is a plain terminal hold, preserving the interactive (non-delegated) behavior.
    const { instance, events, rescheduleCalls } = makeFlushInstance({ evidencePresent: false, meshContext: false })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(events).toHaveLength(0)
    expect(rescheduleCalls.length).toBeGreaterThan(0) // held, will retry
  })
})
