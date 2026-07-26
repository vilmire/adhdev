import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { TranscriptSignalSource } from '../../src/providers/transcript-signal-source.js'
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
//
// TX-FSM Stage 1: the freshness judgment is DELEGATED to the shared
// TranscriptSignalSource's transcript_growing signal. The harness below drives the
// flush through the REAL normalizer (buildSnapshot over the probe fingerprint) and
// stubs only the instance's probeNativeTranscriptSignals seam — so these cases pin
// both the delegation AND the source's freshness boundary.

const NOW = 1_000_000_000

type FlushOutcome = { emitted: boolean; heldReason: string | null; scheduledRetry: boolean }

function makeInstance(opts: {
  type: string
  waitedMs: number
  nativeSample: { msgCount: number; sourceMtimeMs: number } | null
  /** TX-FSM Stage 2: when set, the source is attached to the instance AND a
   *  live (in_turn_progress) sample is fed at this wall-clock BEFORE the flush
   *  — issuing the busy lease as of that moment. */
  liveSampleAt?: number
}): { instance: any; outcome: FlushOutcome; signalSource: TranscriptSignalSource } {
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
  // The signal under test, run through the REAL shared normalizer: the probe
  // fingerprint goes in, the normalized snapshot comes out, and the instance
  // seam (probeNativeTranscriptSignals) returns it. null models a
  // non-native-source class (the probe returns null — no native source).
  const signalSource = new TranscriptSignalSource({
    label: opts.type,
    profile: { class: 'native-source', timing: 'floor', providerOwnsTranscript: true, emitsPtyTurnEvents: false },
    finalAssistantPresent: () => false,
    growthQuietMs: MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS,
  })
  // TX-FSM Stage 2: attach the source and pre-feed a live sample (fresh mtime
  // at liveSampleAt → in_turn_progress=true → lease issued at liveSampleAt).
  // The pre-feed carries the SAME msgCount as the flush probe sample so the
  // probe itself does not count-advance and re-issue the lease — the lease
  // state under test is exactly the one the pre-feed issued.
  if (typeof opts.liveSampleAt === 'number') {
    instance.transcriptSignalSource = signalSource
    signalSource.buildSnapshot(
      { messages: [], probe: { msgCount: opts.nativeSample?.msgCount ?? 1, sourceMtimeMs: opts.liveSampleAt } },
      opts.liveSampleAt,
    )
  }
  instance.probeNativeTranscriptSignals = () => {
    if (!opts.nativeSample) return null
    return {
      snapshot: signalSource.buildSnapshot(
        { messages: [], probe: opts.nativeSample },
        NOW,
      ),
      messages: [],
    }
  }
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

// TX-FSM Stage 2 — bounded busy lease. The growth hold above releases as soon
// as the transcript's mtime ages past the growth-quiet window — but a
// PTY-quiet turn whose transcript proved live moments ago is in a valley, not
// finished. For lease-gated providers (the kimi/codex-cli canary) the emit
// stays HELD until the lease bound lapses after the LAST live sample; on
// expiry the judgment returns to the unchanged floor/cap logic, so the lease
// can never wedge a session busy forever (the agy failure mode).
describe('CliProviderInstance — bounded busy lease (TX-FSM Stage 2)', () => {
  it('HOLDS a floored emit while the lease is active (growth stopped, last live sample inside the bound)', () => {
    // Transcript last advanced 120s ago: past the 60s growth-quiet window (so
    // the Stage-1 growth hold would RELEASE) but inside the 180s lease bound.
    const h = makeInstance({
      type: 'kimi',
      waitedMs: PAST_ALL_FLOORS,
      nativeSample: { msgCount: 12, sourceMtimeMs: NOW - 120_000 },
      liveSampleAt: NOW - 120_000,
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(false)
    expect(out.scheduledRetry).toBe(true)
    expect(out.heldReason).toBe('busy_lease_active')
  })

  it('RELEASES to the normal floor/cap judgment once the lease EXPIRES (bounded — never an infinite busy)', () => {
    // Last live sample 200s ago → beyond the 180s bound. The lease must NOT
    // hold; the pre-Stage-2 release path runs unchanged and the emit fires.
    const h = makeInstance({
      type: 'kimi',
      waitedMs: PAST_ALL_FLOORS,
      nativeSample: { msgCount: 12, sourceMtimeMs: NOW - 200_000 },
      liveSampleAt: NOW - 200_000,
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })

  it('does NOT engage for a provider outside the canary gate (identical samples → unchanged release)', () => {
    // cursor-cli is in the growth-hold floor class but NOT in the Stage-2
    // canary — the lease branch is skipped before any lease state is read.
    const h = makeInstance({
      type: 'cursor-cli',
      waitedMs: PAST_ALL_FLOORS,
      nativeSample: { msgCount: 12, sourceMtimeMs: NOW - 120_000 },
      liveSampleAt: NOW - 120_000,
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })

  it('fails open when the signal source was never attached (lease unobtainable → unchanged release)', () => {
    // A gated provider whose probe yields no attached source (e.g. the read
    // path never produced one) must fall through exactly as before Stage 2.
    const h = makeInstance({
      type: 'kimi',
      waitedMs: PAST_ALL_FLOORS,
      nativeSample: { msgCount: 12, sourceMtimeMs: NOW - 120_000 },
      // no liveSampleAt → instance.transcriptSignalSource stays unset
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })
})
