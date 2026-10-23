import { describe, expect, it } from 'vitest'
// TERMINAL-ADMISSION-ALL-PATHS — regression suite for the three paths that
// reached a terminal decision WITHOUT consulting evaluateTerminalAdmission.
//
// THE MEASUREMENT THIS SUITE PINS
// -------------------------------
// The admission gate landed guarding the transcript POLL. Live logs then showed
// it had never once run: 49/49 polls declined UPSTREAM of the gate
// (poll_terminal_evidence_timestamp_unusable), 0 completions produced. Every
// real false completion came from a path the gate did not cover.
//
//   (2) provider_event — the 10:49 incident. agent:generating_completed →
//       terminal `completed` committed 296ms later, while the SAME session had
//       logged native_transcript_advancing (msgCount=542) one second earlier.
//   (1) poll — a hard pre-return on an unusable timestamp made the gate
//       unreachable. The real cause was SHAPE (no final assistant selected in a
//       tool-heavy tail), reported as a timestamp verdict.
//   (3) acked-hold synth — fail-OPEN on the same freshness evidence the poll
//       treats as fail-CLOSED, inside the same file.
//
// The contracts under test, in order of importance:
//   A. a MOVING transcript cannot be promoted to terminal on ANY path
//   B. a GENUINE completion still passes on every path (if this breaks, every
//      task in the fleet wedges — it is tested first-class, not incidentally)
//   C. RECLAIM of a dead session still works — a timeout is not completion
//      evidence, but recovery is still owed
// ---------------------------------------------------------------------------

import {
  evaluateTerminalAdmission,
  TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS,
} from '../../src/mesh/mesh-terminal-admission.js'
// The (1) poll-path and (3) acked-hold-synth describes retired 2026-09-23 with
// mesh-completion-synthesis.ts (wiring-unification C4): the coordinator probe now
// only produces transcript_final evidence (turn-ledger/probe.ts) and the reducer's
// admission rules (turn-ledger/admission.ts) decide — pinned in
// test/turn-ledger/probe.test.ts and the C-W1 admission/reducer tables.

const NOW = 1_760_000_000_000

// ── (1) + (3): the rules the other two paths now share ────────────────────

describe('(1)+(3) shared freshness contract — a timeout is never completion evidence', () => {
  const base = {
    producer: 'unit',
    providerType: 'kimi',
    providerHasNativeMarker: false,
    nativeMarkersFieldPresent: false,
    providerObservedStatus: 'idle',
    activeModalPresent: false,
    finalAssistantPresent: true,
    trailingActivityCount: 0,
    turnStartedAtMs: NOW - 60_000,
    nowMs: NOW,
  }

  it('★no deadline, however old, bypasses the transcript_growing veto', () => {
    // (3)'s death-deadline case: 8 minutes past the ack is NOT evidence the turn
    // ended. Freshness — not the age of the row — decides.
    const v = evaluateTerminalAdmission({
      ...base,
      turnStartedAtMs: NOW - 8 * 60_000,
      newestActivityAtMs: NOW - 1_000,
    })
    expect(v.admit).toBe(false)
    expect(!v.admit && v.reason).toBe('transcript_growing')
  })

  it('★RECLAIM PRESERVED: a DEAD session (no fresh activity) is NOT vetoed by freshness', () => {
    // The distinction that keeps recovery alive: a dead worker's transcript does
    // not grow, so the veto never engages for it and the death-deadline synth /
    // reclaim path proceeds exactly as before. Only a MOVING tail is refused.
    const v = evaluateTerminalAdmission({ ...base, newestActivityAtMs: NOW - 15_518_000 })
    expect(v.admit).toBe(true)
  })

  it('★an unobservable tail (no timestamps at all) never manufactures a veto', () => {
    const v = evaluateTerminalAdmission({ ...base, newestActivityAtMs: undefined })
    expect(v.admit).toBe(true)
  })

  it('the boundary is exactly the quiet window, shared by both paths', () => {
    const justInside = evaluateTerminalAdmission({
      ...base, newestActivityAtMs: NOW - (TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS - 1),
    })
    expect(justInside.admit).toBe(false)

    const justOutside = evaluateTerminalAdmission({
      ...base, newestActivityAtMs: NOW - TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS,
    })
    expect(justOutside.admit).toBe(true)
  })
})

// ── (1) poll path — the timestamp-unusable demotion, end to end ───────────

// ── (3) acked-hold synth — fail-open/fail-closed symmetry ─────────────────
