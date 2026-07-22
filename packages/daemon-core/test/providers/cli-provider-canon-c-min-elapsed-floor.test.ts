import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS } from '../../src/providers/cli-provider-instance-types.js'

// FIX 2 (primary) — CANON-C early-emit min-elapsed floor.
//
// The CANON-C transcript-evidence gate (allowTimeout missing_final_assistant blocks) emits its
// decoupled-immediate completion at ANY waitedMs. For a native-source provider (claude-cli,
// external-native) that is correct — the transcript merely trails the idle transition by a write
// and a reconcile upgrades the weak emit. But a PTY-parsed provider (codex-cli) has NO external
// transcript to trail, so an immediate emit at the ~13s first-poll waitedMs is a pure timing guess
// that stamps a weak evidenceLevel=insufficient completion, racing before the 180s stall watchdog
// can arm. FIX: a missing_final_assistant block carrying noExternalTranscriptSource must observe
// the CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS floor — hold under it, emit once met. A native-source
// block (no noExternalTranscriptSource) is unaffected.

const NOW = 1_000_000

type FlushOutcome = { emitted: boolean; heldReason: string | null; scheduledRetry: boolean }

function makeInstance(opts: { type: string; block: any; waitedMs: number }): { instance: any; outcome: FlushOutcome } {
  const outcome: FlushOutcome = { emitted: false, heldReason: null, scheduledRetry: false }
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = opts.type
  instance.instanceId = 'sess-floor'
  instance.busyEpoch = 0
  instance.generatingStartedAt = NOW - opts.waitedMs
  instance.lastApprovalEventFingerprint = ''
  instance.settings = { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' }

  instance.adapter = {
    getStatus: () => ({ status: 'idle', lastOutputAt: NOW }),
    getScriptParsedStatus: () => ({ messages: [] }),
    getPartialResponse: () => '',
    isProcessing: () => false,
    isWaitingForResponse: false,
    currentTurnScope: null,
  }

  instance.completedDebouncePending = {
    firstObservedAt: NOW - opts.waitedMs,
    turnStartedAt: NOW - opts.waitedMs,
    busyEpochAtArm: 0,
    previousStatus: 'generating',
    chatTitle: '',
    duration: 1,
    timestamp: NOW,
    taskId: 'task-1',
    loggedBlockReason: undefined,
  }
  instance.completedDebounceTimer = null

  // Pin the block decision — the finalization-evidence machinery is exercised by its own tests.
  instance.getCompletedFinalizationBlock = () => opts.block
  instance.shouldAutoApprove = () => false
  instance.autoApproveBusy = false
  instance.shouldSuppressStaleParsedBusyStatus = () => false
  instance.antigravityHoldPtyStillActive = () => false

  instance.isMeshWorkerSession = () => false
  instance.completionTraceOn = () => false
  instance.recordCompletionGateTrace = () => {}
  instance.meshTraceCtx = () => ({})

  instance.scheduleCompletedDebounceFlush = () => { outcome.scheduledRetry = true }
  instance.emitGeneratingCompleted = () => { outcome.emitted = true }
  instance.buildCompletedFinalizationDiagnostic = () => ({})
  instance.completionFinalSummary = () => ''
  instance.cachedInTurnCompletionSummaryContent = () => ''

  const realNow = Date.now
  ;(instance as any).__restoreNow = () => { Date.now = realNow }
  Date.now = () => NOW

  const pending = instance.completedDebouncePending
  let heldReason: string | null = null
  Object.defineProperty(pending, 'loggedBlockReason', {
    get() { return heldReason },
    set(v) { heldReason = v; outcome.heldReason = v },
  })

  return { instance, outcome }
}

function runFlush(h: { instance: any; outcome: FlushOutcome }): FlushOutcome {
  try {
    ;(CliProviderInstance.prototype as any).flushCompletedDebounceIfFinalized.call(h.instance)
  } finally {
    h.instance.__restoreNow()
  }
  return h.outcome
}

// A codex-shaped no-external-transcript missing_final_assistant block (the RCA target).
const NO_TRANSCRIPT_BLOCK = {
  reason: 'missing_final_assistant',
  terminal: true,
  allowTimeout: true,
  noExternalTranscriptSource: true,
}
// A native-source (claude-cli external-native) block: allowTimeout but NO noExternalTranscriptSource.
const NATIVE_SOURCE_BLOCK = {
  reason: 'missing_final_assistant',
  terminal: true,
  allowTimeout: true,
}

describe('CliProviderInstance — CANON-C min-elapsed floor', () => {
  it('(b, floor NOT met) holds a no-transcript missing_final_assistant emit under the floor', () => {
    const h = makeInstance({
      type: 'codex-cli',
      block: NO_TRANSCRIPT_BLOCK,
      waitedMs: CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS - 5_000, // ~13s-style early poll
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(false)
    expect(out.scheduledRetry).toBe(true)
    expect(out.heldReason).toBe('canon_c_min_elapsed_floor')
  })

  it('(b, floor met) emits the no-transcript missing_final_assistant completion at/after the floor', () => {
    const h = makeInstance({
      type: 'codex-cli',
      block: NO_TRANSCRIPT_BLOCK,
      waitedMs: CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS + 1_000,
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })

  it('does NOT floor a native-source (external-native) block — immediate CANON-C emit preserved', () => {
    // The claude-cli native path must still emit immediately at a tiny waitedMs; its transcript
    // legitimately trails the idle transition and a reconcile upgrades the weak emit.
    const h = makeInstance({
      type: 'claude-cli',
      block: NATIVE_SOURCE_BLOCK,
      waitedMs: 500, // well under the floor
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })
})
