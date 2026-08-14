import { describe, expect, it, vi } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import {
  CANCELLED_COMPLETION_RECHECK_MS,
  CANCELLED_COMPLETION_RECHECK_MAX_ATTEMPTS,
} from '../../src/providers/cli-provider-instance-types.js'

// CANCEL-BLIP-ORPHAN — a continuity cancel deleted the completion arm and NOTHING ever
// re-examined it, so a sub-second PTY blip after a genuine turn end orphaned the completion
// permanently.
//
// Live incident (daemon-19223-2026-08-14.1.log, task 631c310b, codex-cli):
//   14:07:27.670  busy → idle                 ← the turn genuinely ended
//   14:07:27.670  status: generating → idle
//   14:07:27.751  idle → busy                 ← an 81ms PTY blip
//   14:07:27.751  cancelled pending completed (resumed generating)
// codex kept working and finished ~14:17, but the coordinator's queue row read 'generating'
// until 14:28 — only a fresh idle→generating FSM edge could re-arm, and a blip that settles
// straight back to idle produces no such edge.
//
// The cancel itself is CORRECT and unchanged (a resumed turn must never emit the completion
// armed before it). The fix hands the deleted arm to a bounded RE-VERIFICATION watch, so the
// blip-vs-real-resume question is answered LATER, when the session's state is observable,
// instead of guessed from a point sample. Every rule is re-applied on the retry — the watch
// grants no exemption, it only restores the chance to be judged.
//
// The load-bearing regression guard is the second test: a REAL resume must still not emit.

const TURN_START = 1_700_000_000_000

interface Harness {
  instance: any
  emitted: any[]
  /** Mutable live state the re-check reads on its retry (the blip settling, or not). */
  live: { status: string; lastOutputAt: number; busyEpoch: number }
}

/**
 * Builds an instance armed exactly as the generating→idle edge leaves it, then drives the
 * flush. `live` is mutated by the test between the first flush and the timer firing, which is
 * what lets us model "the blip settled back to idle" vs "the worker really resumed".
 */
function makeHarness(opts: {
  pending: any
  parsedMessages: any[]
  live: { status: string; lastOutputAt: number; busyEpoch: number }
}): Harness {
  const emitted: any[] = []
  const live = opts.live
  const instance = Object.create(CliProviderInstance.prototype) as any

  instance.type = 'codex-cli'
  instance.instanceId = 'sess-cancel-blip'
  instance.provider = { name: 'Codex', settings: {} }
  instance.workingDir = '/repo/worktree'
  // Mesh worker context — this defect only matters where a coordinator awaits the completion.
  instance.settings = { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-631c310b' }
  instance.generatingStartedAt = TURN_START
  instance.lastApprovalEventFingerprint = ''
  instance.autoApproveBusy = false
  instance.completedDebounceTimer = null
  instance.completedDebouncePending = opts.pending
  instance.cancelledCompletionRecheck = null
  instance.cancelledCompletionRecheckTimer = null

  // busyEpoch is read live so a test can bump it to model a busy re-entry.
  Object.defineProperty(instance, 'busyEpoch', {
    get: () => live.busyEpoch,
    set: (v: number) => { live.busyEpoch = v },
    configurable: true,
  })

  instance.adapter = {
    chatMessagesOwnedExternally: false, // codex is PTY-parsed, not a native-history source
    getStatus: () => ({ status: live.status, lastOutputAt: live.lastOutputAt }),
    getPartialResponse: () => '',
    getScriptParsedStatus: () => ({ status: live.status, messages: opts.parsedMessages }),
    getScreenText: () => '',
    isWaitingForResponse: false,
  }

  instance.shouldAutoApprove = () => false
  instance.pushEvent = (e: any) => { emitted.push(e) }
  instance.markCurrentTurnStartupGraceCollapseSatisfied = () => {}
  instance.readExternalCompletionMessages = () => opts.parsedMessages

  return { instance, emitted, live }
}

function assistantMsg(text: string, timestampMs: number) {
  return { role: 'assistant', content: text, timestamp: timestampMs }
}

function armedPending(overrides: Record<string, unknown> = {}) {
  return {
    chatTitle: 'Codex · worktree',
    duration: 788,
    timestamp: TURN_START + 788_000,
    firstObservedAt: TURN_START + 788_000,
    previousStatus: 'generating',
    turnStartedAt: TURN_START,
    busyEpochAtArm: 7,
    lastOutputAtArm: TURN_START + 787_900,
    ...overrides,
  }
}

const completions = (emitted: any[]) => emitted.filter(e => e.event === 'agent:generating_completed')

describe('CliProviderInstance — CANCEL-BLIP-ORPHAN completion re-verification', () => {
  it('recovers the completion when a sub-second busy blip cancelled the arm (the live codex defect)', () => {
    vi.useFakeTimers()
    try {
      // The turn genuinely ended and a final assistant bubble is on screen, quiet well past
      // the PTY dwell — a completion is genuinely owed.
      const live = { status: 'idle', lastOutputAt: TURN_START + 787_900, busyEpoch: 8 }
      const { instance, emitted } = makeHarness({
        pending: armedPending({ busyEpochAtArm: 7 }), // epoch bumped 7→8 by the 81ms blip
        parsedMessages: [assistantMsg('done — all tests pass', TURN_START + 780_000)],
        live,
      })

      // First flush: the blip already bumped the epoch, so the engine cancels (unchanged).
      ;(instance as any).flushCompletedDebounceIfFinalized()
      expect(completions(emitted)).toHaveLength(0)
      expect(instance.completedDebouncePending).toBeNull()
      // ...but the arm is no longer ORPHANED — a watch now owes it a re-check.
      expect(instance.cancelledCompletionRecheck).not.toBeNull()
      expect(instance.cancelledCompletionRecheck.reason).toBe('busy_reentry')

      // The blip settled: the session is idle again and stays idle. Nothing else happens —
      // no new FSM edge, which is precisely why the old code lost the completion forever.
      vi.advanceTimersByTime(CANCELLED_COMPLETION_RECHECK_MS + 1)

      const fired = completions(emitted)
      expect(fired).toHaveLength(1)
      // The recovered completion still reports the turn that actually ended, not the blip.
      expect(fired[0].duration).toBe(788)
      expect(instance.completedDebouncePending).toBeNull()
      expect(instance.cancelledCompletionRecheck).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // ★THE LOAD-BEARING GUARD. The whole risk of this fix is emitting a completion for a turn
  // that is still running. A real resume differs from a blip in exactly one observable way:
  // it STAYS busy. The re-check therefore re-runs the full gate and re-cancels every time.
  it('does NOT emit when the worker GENUINELY resumed — the re-check re-cancels and gives up', () => {
    vi.useFakeTimers()
    try {
      // Still generating at re-check time, and it keeps printing: a real new turn.
      const live = { status: 'generating', lastOutputAt: TURN_START + 790_000, busyEpoch: 8 }
      const { instance, emitted } = makeHarness({
        pending: armedPending({ busyEpochAtArm: 7 }),
        parsedMessages: [assistantMsg('working on it...', TURN_START + 789_000)],
        live,
      })

      ;(instance as any).flushCompletedDebounceIfFinalized()
      expect(completions(emitted)).toHaveLength(0)

      // Drive the watch well past its budget, keeping the session busy throughout and
      // advancing the PTY clock as a live turn would.
      for (let i = 0; i < CANCELLED_COMPLETION_RECHECK_MAX_ATTEMPTS + 3; i++) {
        live.lastOutputAt += 1_000
        vi.advanceTimersByTime(CANCELLED_COMPLETION_RECHECK_MS + 1)
      }

      // No premature completion, ever — and the watch stopped re-arming itself rather than
      // polling for the life of the turn.
      expect(completions(emitted)).toHaveLength(0)
      expect(instance.cancelledCompletionRecheck).toBeNull()
      expect(instance.cancelledCompletionRecheckTimer).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('yields to a FRESH arm — a real generating→idle edge outranks the stale watch', () => {
    vi.useFakeTimers()
    try {
      const live = { status: 'idle', lastOutputAt: TURN_START + 787_900, busyEpoch: 8 }
      const { instance, emitted } = makeHarness({
        pending: armedPending({ busyEpochAtArm: 7 }),
        parsedMessages: [assistantMsg('first turn done', TURN_START + 780_000)],
        live,
      })

      ;(instance as any).flushCompletedDebounceIfFinalized()
      expect(instance.cancelledCompletionRecheck).not.toBeNull()

      // The FSM observed a real edge and armed a completion for the CURRENT turn before the
      // watch fired. The watch must not touch it (no duplicate, no overwrite).
      const freshPending = armedPending({ busyEpochAtArm: 8, duration: 42 })
      instance.completedDebouncePending = freshPending

      vi.advanceTimersByTime(CANCELLED_COMPLETION_RECHECK_MS + 1)

      expect(instance.completedDebouncePending).toBe(freshPending)
      expect(instance.cancelledCompletionRecheck).toBeNull()
      expect(completions(emitted)).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT arm the watch for a new_pty_output cancel (the KIMI cosmetic-repaint path)', () => {
    vi.useFakeTimers()
    try {
      // Epoch unchanged, but the PTY kept printing → new_pty_output. The session is
      // demonstrably still producing output; the FSM edge re-arms this case correctly.
      const live = { status: 'idle', lastOutputAt: TURN_START + 788_500, busyEpoch: 7 }
      const { instance, emitted } = makeHarness({
        pending: armedPending({ busyEpochAtArm: 7, lastOutputAtArm: TURN_START + 787_900 }),
        parsedMessages: [assistantMsg('partial', TURN_START + 788_400)],
        live,
      })

      ;(instance as any).flushCompletedDebounceIfFinalized()

      expect(completions(emitted)).toHaveLength(0)
      expect(instance.cancelledCompletionRecheck).toBeNull()

      vi.advanceTimersByTime(CANCELLED_COMPLETION_RECHECK_MS * 5)
      expect(completions(emitted)).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the watch on shutdown so no flush runs against a dead adapter', () => {
    vi.useFakeTimers()
    try {
      const live = { status: 'idle', lastOutputAt: TURN_START + 787_900, busyEpoch: 8 }
      const { instance, emitted } = makeHarness({
        pending: armedPending({ busyEpochAtArm: 7 }),
        parsedMessages: [assistantMsg('done', TURN_START + 780_000)],
        live,
      })

      ;(instance as any).flushCompletedDebounceIfFinalized()
      expect(instance.cancelledCompletionRecheck).not.toBeNull()

      ;(instance as any).clearCancelledCompletionRecheck()
      vi.advanceTimersByTime(CANCELLED_COMPLETION_RECHECK_MS * 5)

      expect(completions(emitted)).toHaveLength(0)
      expect(instance.cancelledCompletionRecheckTimer).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
