import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import {
  COMPLETED_FINALIZATION_MAX_WAIT_MS,
  ANTIGRAVITY_HOLD_QUIET_DWELL_MS,
  ANTIGRAVITY_HOLD_HARD_CAP_MS,
} from '../../src/providers/cli-provider-instance-types.js'

// ANTIGRAVITY-30S-CAP-PREMATURE (mission 29912a6f, RCA task d92da929).
//
// Antigravity is a native-source provider (assistant answer in native-history) whose
// idle/generating verdict is PTY-screen-derived. A generating→idle screen blip (or a long
// tool phase) arms completedDebounce; the evidence gate correctly withholds via the antigravity
// `holdForTranscript` block. BUT that hold was bounded ONLY by COMPLETED_FINALIZATION_MAX_WAIT_MS
// (30s) — once waitedMs>=30s the hold released and fell through to the forced weak emit, firing a
// premature completed/idle to the coordinator WHILE THE PTY WAS STILL GENERATING. The 30s cap
// released on ELAPSED TIME, not proof-of-idle, and antigravity's proof (native-history bubble)
// can legitimately lag past 30s on a long turn.
//
// FIX: gate the 30s-cap release of an antigravity holdForTranscript block on the PTY being
// genuinely quiet (antigravityHoldPtyStillActive()===false: no adapter pending response AND no
// raw PTY output within ANTIGRAVITY_HOLD_QUIET_DWELL_MS). If the PTY is still active, KEEP HOLDING
// past 30s (up to the absolute ANTIGRAVITY_HOLD_HARD_CAP_MS bound). A genuinely quiescent tool-only
// turn still force-emits. Scoped to antigravity-cli so claude/codex timing is unchanged.

const NOW = 1_000_000
const HOLD_BLOCK = { reason: 'missing_final_assistant', terminal: false, holdForTranscript: true }
// A non-terminal block WITHOUT holdForTranscript: releases at the 30s cap in the original path.
const PLAIN_NONTERMINAL_BLOCK = { reason: 'missing_final_assistant', terminal: false }

// The completion-timing spec each real manifest declares (mission f2f6da1b root 2): the 30s-cap
// hold reads `holdCompletionForTranscript`, so the fixture's provider spec must match its manifest.
//   antigravity-cli → holdCompletionForTranscript: true (HOLD class)
//   codex-cli/kimi/cursor-cli/opencode → requiresFinalAssistantBeforeIdle: true (FLOOR class)
//   claude-cli → neither (IMMEDIATE write-lag class)
function completionTimingProvider(type: string): Record<string, unknown> {
  if (type === 'antigravity-cli') return { holdCompletionForTranscript: true }
  if (['codex-cli', 'kimi', 'cursor-cli', 'opencode'].includes(type)) return { requiresFinalAssistantBeforeIdle: true }
  return {} // claude-cli and any other: write-lag immediate
}

type FlushOutcome = { emitted: boolean; heldReason: string | null; scheduledRetry: boolean }

/**
 * Build a CliProviderInstance whose flush path can be driven deterministically:
 * - getCompletedFinalizationBlock returns the supplied block
 * - Date.now() is pinned via the pending.firstObservedAt offset (waitedMs = NOW - firstObservedAt)
 * - adapter.getStatus reports idle + a controllable lastOutputAt
 * - adapter pending-response signals are controllable
 * - emitGeneratingCompleted / scheduleCompletedDebounceFlush are captured (never real)
 */
function makeInstance(opts: {
  type: string
  block: any
  waitedMs: number
  lastOutputQuietMs: number // how long the PTY has been quiet (NOW - lastOutputAt)
  adapterPending?: boolean
}): { instance: any; outcome: FlushOutcome } {
  const outcome: FlushOutcome = { emitted: false, heldReason: null, scheduledRetry: false }
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = opts.type
  // SPEC-DRIVEN completion timing (mission f2f6da1b root 2): the 30s-cap PTY-active hold is now
  // gated on the manifest flag holdCompletionForTranscript, NOT the provider name. Give each
  // fixture the provider spec its real manifest declares: antigravity holds (flag true), codex
  // floors (requiresFinalAssistantBeforeIdle), claude emits immediately (neither).
  instance.provider = completionTimingProvider(opts.type)
  instance.instanceId = 'sess-x'
  instance.busyEpoch = 0
  instance.generatingStartedAt = NOW - opts.waitedMs
  instance.lastApprovalEventFingerprint = ''
  instance.settings = { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' }

  const lastOutputAt = NOW - opts.lastOutputQuietMs
  instance.adapter = {
    getStatus: () => ({ status: 'idle', lastOutputAt }),
    getScriptParsedStatus: () => ({ messages: [] }),
    getPartialResponse: () => '',
    isProcessing: () => false,
    isWaitingForResponse: opts.adapterPending === true,
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

  // Silence trace/log-only side channels (no decision logic).
  instance.isMeshWorkerSession = () => false
  instance.completionTraceOn = () => false
  instance.recordCompletionGateTrace = () => {}
  instance.meshTraceCtx = () => ({})

  // Capture the two terminal outcomes of the flush.
  instance.scheduleCompletedDebounceFlush = () => { outcome.scheduledRetry = true }
  instance.emitGeneratingCompleted = () => { outcome.emitted = true }
  instance.buildCompletedFinalizationDiagnostic = () => ({})
  instance.completionFinalSummary = () => ''
  instance.cachedInTurnCompletionSummaryContent = () => ''

  // Pin wall-clock. Date.now is banned in workflow scripts, not in vitest.
  const realNow = Date.now
  ;(instance as any).__restoreNow = () => { Date.now = realNow }
  Date.now = () => NOW

  // Intercept loggedBlockReason writes so the test can read which hold path was taken.
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

describe('CliProviderInstance — ANTIGRAVITY 30s-cap premature-completion hold', () => {
  it('(a) long antigravity turn, PTY still active at 30s → NO premature emit, keeps holding', () => {
    // waited past the 30s cap, but the PTY produced output well within the quiet dwell → still generating.
    const h = makeInstance({
      type: 'antigravity-cli',
      block: HOLD_BLOCK,
      waitedMs: COMPLETED_FINALIZATION_MAX_WAIT_MS + 5_000,
      lastOutputQuietMs: 200, // 200ms < ANTIGRAVITY_HOLD_QUIET_DWELL_MS → PTY still active
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(false)
    expect(out.scheduledRetry).toBe(true)
    expect(out.heldReason).toBe('antigravity_hold_pty_active')
  })

  it('(a2) long antigravity turn, adapter reports pending response at 30s → NO premature emit', () => {
    const h = makeInstance({
      type: 'antigravity-cli',
      block: HOLD_BLOCK,
      waitedMs: COMPLETED_FINALIZATION_MAX_WAIT_MS + 20_000,
      lastOutputQuietMs: ANTIGRAVITY_HOLD_QUIET_DWELL_MS + 10_000, // screen quiet...
      adapterPending: true, // ...but adapter still owns an in-flight response
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(false)
    expect(out.scheduledRetry).toBe(true)
    expect(out.heldReason).toBe('antigravity_hold_pty_active')
  })

  it('(b) genuinely quiescent tool-only antigravity turn (PTY quiet past dwell) → force-emits after 30s', () => {
    const h = makeInstance({
      type: 'antigravity-cli',
      block: HOLD_BLOCK,
      waitedMs: COMPLETED_FINALIZATION_MAX_WAIT_MS + 1_000,
      lastOutputQuietMs: ANTIGRAVITY_HOLD_QUIET_DWELL_MS + 2_000, // PTY quiescent → no assistant bubble coming
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })

  it('(b2) hard cap reached with PTY still active → force-emits (cannot wedge forever)', () => {
    const h = makeInstance({
      type: 'antigravity-cli',
      block: HOLD_BLOCK,
      waitedMs: ANTIGRAVITY_HOLD_HARD_CAP_MS + 1_000, // past the absolute upper bound
      lastOutputQuietMs: 100, // PTY STILL emitting, but the hard cap wins
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })

  it('under the 30s cap the standard hold still applies (unchanged) — antigravity', () => {
    const h = makeInstance({
      type: 'antigravity-cli',
      block: HOLD_BLOCK,
      waitedMs: COMPLETED_FINALIZATION_MAX_WAIT_MS - 5_000, // still inside the standard hold
      lastOutputQuietMs: ANTIGRAVITY_HOLD_QUIET_DWELL_MS + 5_000, // even with a quiet PTY
    })
    const out = runFlush(h)
    // Held by the ORIGINAL (waitedMs < 30s) branch, not the new PTY-active branch.
    expect(out.emitted).toBe(false)
    expect(out.scheduledRetry).toBe(true)
    expect(out.heldReason).toBe('missing_final_assistant')
  })

  it('(c) codex-cli: PTY-active-at-30s is NOT protected by the antigravity hold → force-emits (no regression)', () => {
    // A codex holdForTranscript-shaped block with the PTY still active past 30s must NOT enter
    // the antigravity-scoped hold — codex completion timing is unchanged (releases at the 30s cap).
    const h = makeInstance({
      type: 'codex-cli',
      block: HOLD_BLOCK,
      waitedMs: COMPLETED_FINALIZATION_MAX_WAIT_MS + 5_000,
      lastOutputQuietMs: 200, // PTY still active — antigravity would hold, codex must NOT
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })

  it('(c) claude-cli: PTY-active-at-30s is NOT protected by the antigravity hold → force-emits (no regression)', () => {
    const h = makeInstance({
      type: 'claude-cli',
      block: HOLD_BLOCK,
      waitedMs: COMPLETED_FINALIZATION_MAX_WAIT_MS + 5_000,
      lastOutputQuietMs: 200,
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })

  it('(c) antigravity with a non-holdForTranscript block is NOT protected (only the transcript-hold path)', () => {
    // A plain non-terminal block (not the holdForTranscript inter-turn hold) releases at the cap
    // as before, even with the PTY active — the new hold is scoped to holdForTranscript only.
    const h = makeInstance({
      type: 'antigravity-cli',
      block: PLAIN_NONTERMINAL_BLOCK,
      waitedMs: COMPLETED_FINALIZATION_MAX_WAIT_MS + 5_000,
      lastOutputQuietMs: 200,
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })

  // SPEC-DRIVEN completion-timing partition (mission f2f6da1b root 2). The 30s-cap PTY-active hold
  // is gated on the manifest flag holdCompletionForTranscript, NOT the provider name. This asserts
  // the full built-in partition through the flag-driven fixtures — the HOLD class (antigravity)
  // keeps holding while the PTY is active past the cap; the FLOOR (codex/kimi/cursor/opencode) and
  // IMMEDIATE (claude) classes both release at the cap because they never declare the hold flag.
  it('completion-timing partition: HOLD class holds past cap; FLOOR + IMMEDIATE classes release', () => {
    const holdClass = ['antigravity-cli']
    const releaseClass = ['codex-cli', 'kimi', 'cursor-cli', 'opencode', 'claude-cli']
    for (const type of holdClass) {
      const out = runFlush(makeInstance({ type, block: HOLD_BLOCK, waitedMs: COMPLETED_FINALIZATION_MAX_WAIT_MS + 5_000, lastOutputQuietMs: 200 }))
      expect(out.emitted, `${type} (HOLD class) must NOT emit past the cap while PTY active`).toBe(false)
      expect(out.heldReason, `${type} hold reason`).toBe('antigravity_hold_pty_active')
    }
    for (const type of releaseClass) {
      const out = runFlush(makeInstance({ type, block: HOLD_BLOCK, waitedMs: COMPLETED_FINALIZATION_MAX_WAIT_MS + 5_000, lastOutputQuietMs: 200 }))
      expect(out.emitted, `${type} (FLOOR/IMMEDIATE class) must release at the cap`).toBe(true)
    }
  })
})

describe('CliProviderInstance — antigravityHoldPtyStillActive discriminator', () => {
  function makeProbe(opts: { adapterPending?: boolean; lastOutputQuietMs: number }): any {
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.type = 'antigravity-cli'
    const lastOutputAt = NOW - opts.lastOutputQuietMs
    instance.adapter = {
      getStatus: () => ({ status: 'idle', lastOutputAt }),
      getPartialResponse: () => '',
      isProcessing: () => false,
      isWaitingForResponse: opts.adapterPending === true,
      currentTurnScope: null,
    }
    return instance
  }

  it('true when PTY output arrived within the quiet dwell', () => {
    const inst = makeProbe({ lastOutputQuietMs: ANTIGRAVITY_HOLD_QUIET_DWELL_MS - 100 })
    const realNow = Date.now
    Date.now = () => NOW
    try {
      expect((CliProviderInstance.prototype as any).antigravityHoldPtyStillActive.call(inst)).toBe(true)
    } finally { Date.now = realNow }
  })

  it('false when the PTY has been quiet past the dwell and no adapter pending response', () => {
    const inst = makeProbe({ lastOutputQuietMs: ANTIGRAVITY_HOLD_QUIET_DWELL_MS + 500 })
    const realNow = Date.now
    Date.now = () => NOW
    try {
      expect((CliProviderInstance.prototype as any).antigravityHoldPtyStillActive.call(inst)).toBe(false)
    } finally { Date.now = realNow }
  })

  it('true when the adapter still reports a pending response even if the screen is quiet', () => {
    const inst = makeProbe({ adapterPending: true, lastOutputQuietMs: ANTIGRAVITY_HOLD_QUIET_DWELL_MS + 5_000 })
    const realNow = Date.now
    Date.now = () => NOW
    try {
      expect((CliProviderInstance.prototype as any).antigravityHoldPtyStillActive.call(inst)).toBe(true)
    } finally { Date.now = realNow }
  })
})
