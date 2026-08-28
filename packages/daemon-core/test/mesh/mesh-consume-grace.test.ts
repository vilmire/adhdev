import { describe, expect, it } from 'vitest'
import {
  resolveConsumeGraceMs,
  CONSUME_GRACE_FLOOR_MS,
  CONSUME_GRACE_NATIVE_SOURCE_MS,
} from '../../src/mesh/mesh-consume-grace.js'

// CONSUME-GRACE — the delivered-but-unconsumed redrive window.
//
// The window used to be a flat 25s. Measurement against the live ledger
// (mesh_turn_attempts, 1,094 successful delivered→consumed pairs, 2026-08-28) showed 25s sat
// BELOW the p95 boot→consume latency of every provider in the fleet:
//
//   claude-cli p95 21.4s (p99 30.3s) · codex-cli p95 31.6s (p99 247.6s)
//   kimi p95 28.7s (p99 907.4s) · grok-cli p95 23.2s · antigravity-cli p95 37.5s
//
// 77 of those 1,094 consumes (7%) took longer than 25s — every one a worker that was booting
// normally and would have been torn off its task had the watchdog reached it first. Live
// 2026-08-28: codex task 3cd41be4 re-driven 26s after its auto-launch completed, its session
// then unrecoverable ("Session not found").
//
// These are pure-policy tests over the sizing decision. The gate that CONSUMES this value
// (age >= grace, plus the liveness/evidence guards that can still hold a redrive back) is
// exercised end-to-end in mesh-reconcile-loop.test.ts.

describe('consume grace sizing', () => {
  // ── INJECTION TEST ────────────────────────────────────────────────────────
  // The load-bearing assertion. Restore the old flat 25s constant — as either the floor or a
  // provider's resolved value — and this goes RED. It is written against the MEASURED p95s
  // rather than the constant so it fails for the reason that actually matters: a grace that
  // no longer covers observed boot latency.
  it('covers the measured p95 boot latency of every provider in the fleet', () => {
    // The slowest measured p95 (antigravity-cli). A grace at or below this re-drives a
    // normally-booting worker at least 5% of the time.
    const SLOWEST_MEASURED_P95_MS = 37_500
    expect(CONSUME_GRACE_FLOOR_MS).toBeGreaterThan(SLOWEST_MEASURED_P95_MS)
    // And specifically clears the old constant that produced the incident.
    expect(CONSUME_GRACE_FLOOR_MS).toBeGreaterThan(25_000)
  })

  it('gives the widest window to providers whose turn start is not a PTY event', () => {
    // emitsPtyTurnEvents:false (codex-cli, cursor-cli, kimi, opencode, antigravity-cli) —
    // the ABSENCE of agent:generating_started proves nothing for this class, and they carry
    // the heaviest cold starts (codex p99 247.6s, kimi p99 907.4s).
    expect(resolveConsumeGraceMs({ emitsPtyTurnEvents: false })).toBe(CONSUME_GRACE_NATIVE_SOURCE_MS)
    expect(CONSUME_GRACE_NATIVE_SOURCE_MS).toBeGreaterThan(CONSUME_GRACE_FLOOR_MS)
  })

  it('gives a reliable-PTY-event provider the floor', () => {
    expect(resolveConsumeGraceMs({ emitsPtyTurnEvents: true })).toBe(CONSUME_GRACE_FLOOR_MS)
  })

  // ── UNKNOWN-PROFILE SAFETY ────────────────────────────────────────────────
  // An unresolvable profile is an older daemon's row, a direct dispatch, or a session this
  // coordinator cannot classify. "We cannot prove this worker is the fast kind" is a reason
  // for patience, not haste — the short window must never be the default for the unknown.
  describe('unknown profile takes the floor, never a shorter window', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['empty profile', {}],
      ['profile missing the flag', { emitsPtyTurnEvents: undefined }],
    ])('%s → floor', (_label, profile) => {
      expect(resolveConsumeGraceMs(profile as any)).toBe(CONSUME_GRACE_FLOOR_MS)
    })
  })

  // ── OVERCORRECTION GUARD ──────────────────────────────────────────────────
  // The grace covers spawn → interactive → first token. It is NOT a turn budget: that is
  // DELIVERED_NO_TURN_DEADLINE_MS (15min). If the grace ever grew past that, a genuinely lost
  // completion would be recovered by the wrong deadline and the short path would go dead —
  // trading a premature redrive for a task that hangs far longer than it used to.
  it('stays well below the delivered-no-turn turn budget it must not replace', () => {
    const DELIVERED_NO_TURN_DEADLINE_MS = 15 * 60_000
    expect(CONSUME_GRACE_NATIVE_SOURCE_MS).toBeLessThan(DELIVERED_NO_TURN_DEADLINE_MS)
    // And below the 5min confirm window the gate is bounded by, or it could never fire.
    expect(CONSUME_GRACE_NATIVE_SOURCE_MS).toBeLessThan(5 * 60_000)
  })
})
