import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import {
  CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS,
  MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS,
} from '../../src/providers/cli-provider-instance-types.js'

// TRANSCRIPT-GROWTH-HOLD — CODEX-FSM-DEGENERATE-STABLE RCA, upper safety net.
//
// The FLOOR-class completion (missing_final_assistant + noExternalTranscriptSource:
// codex-cli / kimi / cursor-cli / opencode) releases its weak emit once the idle has
// been "continuously quiet" past the floor/cap — quiet as judged by the SAME screen
// parsing whose lie armed the completion (spinner escaped the status window;
// degenerate stable region). The daemon already observes an independent liveness
// signal — the native transcript advancing (the stall watchdog logs "PTY quiet 365s
// but transcript advancing") — but it was never wired into the completion judgment.
// The hold engages ONLY on positive growth evidence (fresh source mtime): a growing
// transcript blocks the emit; absent/stale/quiet transcript information NEVER does.

const NOW = 1_000_000_000

type FlushOutcome = { emitted: boolean; heldReason: string | null; scheduledRetry: boolean }

function makeInstance(opts: {
  type: string
  waitedMs: number
  nativeSample: { msgCount: number; sourceMtimeMs: number } | null
}): { instance: any; outcome: FlushOutcome } {
  const outcome: FlushOutcome = { emitted: false, heldReason: null, scheduledRetry: false }
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = opts.type
  instance.instanceId = 'sess-growth-hold'
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

  // Pin the block decision — the block STAMPING is exercised by the CANON-C floor
  // tests; here we exercise what the flush does with the floored block.
  instance.getCompletedFinalizationBlock = () => ({
    reason: 'missing_final_assistant',
    terminal: true,
    allowTimeout: true,
    noExternalTranscriptSource: true,
  })
  // The signal under test: the native transcript progress fingerprint.
  instance.sampleNativeTranscriptProgress = () => opts.nativeSample
  instance.shouldAutoApprove = () => false
  instance.autoApproveBusy = false
  instance.shouldSuppressStaleParsedBusyStatus = () => false
  instance.antigravityHoldPtyStillActive = () => false

  instance.isMeshWorkerSession = () => true
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

// waitedMs past BOTH the CANON-C floor and the 30s finalization cap: without the
// growth hold every case below would emit — the hold is the only thing deciding.
const PAST_ALL_FLOORS = Math.max(CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS, 30_000) + 5_000

describe('CliProviderInstance — transcript-growth hold (floor-class completion)', () => {
  it('HOLDS a floored missing_final_assistant emit while the native transcript is still growing', () => {
    // The RCA frame: codex rollout appended 5s ago (well within the growth-quiet
    // window) while the screen read idle for minutes — the turn is alive.
    const h = makeInstance({
      type: 'codex-cli',
      waitedMs: PAST_ALL_FLOORS,
      nativeSample: { msgCount: 87, sourceMtimeMs: NOW - 5_000 },
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(false)
    expect(out.scheduledRetry).toBe(true)
    expect(out.heldReason).toBe('native_transcript_advancing')
  })

  it('holds at the exact boundary minus one ms and releases at the boundary', () => {
    const held = runFlush(makeInstance({
      type: 'codex-cli',
      waitedMs: PAST_ALL_FLOORS,
      nativeSample: { msgCount: 87, sourceMtimeMs: NOW - (MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS - 1) },
    }))
    expect(held.emitted).toBe(false)
    expect(held.heldReason).toBe('native_transcript_advancing')

    const released = runFlush(makeInstance({
      type: 'codex-cli',
      waitedMs: PAST_ALL_FLOORS,
      nativeSample: { msgCount: 87, sourceMtimeMs: NOW - MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS },
    }))
    expect(released.emitted).toBe(true)
  })

  it('RELEASES once the transcript has been quiet past the growth-quiet window (genuine turn end)', () => {
    const h = makeInstance({
      type: 'codex-cli',
      waitedMs: PAST_ALL_FLOORS,
      nativeSample: { msgCount: 87, sourceMtimeMs: NOW - 120_000 },
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })

  it('NEVER holds a pure-PTY provider (no native source → sample null → unchanged behavior)', () => {
    // Conservative axis: missing transcript information must not block an idle
    // verdict (false-busy wedge guard).
    const h = makeInstance({
      type: 'some-pty-only-cli',
      waitedMs: PAST_ALL_FLOORS,
      nativeSample: null,
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })

  it('NEVER holds on an unknown transcript mtime (sourceMtimeMs=0 → no freshness evidence)', () => {
    const h = makeInstance({
      type: 'codex-cli',
      waitedMs: PAST_ALL_FLOORS,
      nativeSample: { msgCount: 87, sourceMtimeMs: 0 },
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })

  it('also covers kimi (native-source floor class) — growing transcript holds', () => {
    const h = makeInstance({
      type: 'kimi',
      waitedMs: PAST_ALL_FLOORS,
      nativeSample: { msgCount: 12, sourceMtimeMs: NOW - 2_000 },
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(false)
    expect(out.heldReason).toBe('native_transcript_advancing')
  })
})
