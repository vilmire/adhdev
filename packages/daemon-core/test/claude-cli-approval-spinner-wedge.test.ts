/**
 * Regression: claude-cli 4.0 approval-state wedge on the ✻ spinner.
 *
 * Symptom (observed 2026-06-29, session 30e69f17): the inner Claude finished
 * its approval prompt and resumed generating — the spinner line on screen was
 *
 *     ✻ Moonwalking… (3m 47s · ↓ 9.0k tokens)
 *
 * — but the FSM stayed wedged in `approval`. Root cause: the spinner glyph
 * class `[✢✳✶✽✷✸✹⠀-⣿]` shared by every transition's spinner regex did NOT
 * include `✻` (U+273B). Claude Code uses `✻` BOTH as the active "generating"
 * glyph (`✻ Verb… ↓ N tokens`) AND as the settled "done" glyph
 * (`✻ Verb for Ns`, no tokens). So `approval→busy`'s "is it generating?"
 * clause never matched the active form → the only two approval exits
 * (`→busy` needs a spinner, `→idle` needs `cursor_above:5` stability) both
 * failed → wedge. Same defect class as APPROVAL-BUSY-WEDGE (commit 1fa6ec3),
 * recurring because that fix's glyph set omitted `✻`.
 *
 * Fix: spinner regexes gained a `✻ … ↑↓ N tokens` branch — `✻` only counts as
 * "generating" when an active-token marker rides along, so the settled
 * `✻ Verb for Ns` completion line is NOT mis-read as a spinner and busy→idle
 * stays intact.
 *
 * This test loads the SHIPPING spec from adhdev-providers (the SSOT the daemon
 * loads at runtime) and drives the pure `evaluateFsm` against the exact wedge
 * screen. It is skipped — not failed — when that sibling repo isn't checked
 * out, so daemon-core's own CI never depends on the providers repo layout.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadFsmSpec } from '../src/providers/spec/fsm-loader.js'
import { evaluateFsm, type FsmClock } from '../src/providers/spec/fsm-evaluator.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SPEC_PATH = path.resolve(
  HERE,
  '../../../../adhdev-providers/cli/claude-cli/specs/4.0.json',
)

const specAvailable = fs.existsSync(SPEC_PATH)
const maybe = specAvailable ? describe : describe.skip

function clock(stateAgeMs: number): FsmClock {
  const now = 1_000_000
  const entered = now - stateAgeMs
  // Everything has been on-screen / stable for the full state age — we want to
  // test the regex/cond outcome, not race a stability timer.
  return {
    now,
    stateEnteredAt: entered,
    regionLastChangedAt: new Map<number, number>([
      [-1, entered],
      [5, entered],
      [12, entered],
    ]),
  }
}

maybe('claude-cli 4.0 approval ✻-spinner wedge', () => {
  if (!specAvailable) return
  const loaded = loadFsmSpec(SPEC_PATH)
  if (!loaded.ok) throw new Error(`spec load failed: ${loaded.errors.join('; ')}`)
  const spec = loaded.spec

  // The exact wedge: approval modal已 dismissed (footer is a bare `❯`, no
  // `1. Y` / `Esc to cancel`), inner Claude generating with the ✻ + active
  // tokens spinner.
  const wedgeScreen = [
    '⏺ The new push re-triggered the workflow.',
    '  ⎿  === latest ghostty workflow runs ===',
    '',
    '✻ Moonwalking… (3m 47s · ↓ 9.0k tokens)',
    '  ⎿  Tip: Use /feedback to help us improve!',
    '',
    '────────────────────────────────────────────────────────────────────────────────',
    '❯',
    '────────────────────────────────────────────────────────────────────────────────',
    '  ➜ spec-notif-magi-manual git:(spec/notif-magi-manual)',
    '  1 shell',
  ].join('\n')

  it('unsticks approval → busy when ✻ spinner carries active tokens', () => {
    // Held well past approval→busy's 1500ms min_hold; cursor on the footer ❯
    // (row 7) so cursor_above:12 is satisfied.
    const r = evaluateFsm(spec, 'approval', wedgeScreen, { row: 7, col: 0 }, undefined, clock(5_000))
    expect(r.fired?.to).toBe('busy')
  })

  it('does NOT mis-read the ✻ "… for Ns" completion line as a spinner (busy→idle preserved)', () => {
    // Settled completion line: ✻ + "for Ns" but NO tokens / ↑↓. This must not
    // be treated as a live spinner, or busy could never fall to idle.
    const doneScreen = [
      '⏺ Done.',
      '',
      '✻ Pondering for 3m 47s',
      '',
      '────────────────────────────────────────────────────────────────────────────────',
      '❯',
      '────────────────────────────────────────────────────────────────────────────────',
      '  ➜ spec-notif-magi-manual git:(spec/notif-magi-manual)',
    ].join('\n')
    // busy→idle-quiet needs stable_ms:12000; give the screen a 13s age.
    const r = evaluateFsm(spec, 'busy', doneScreen, { row: 5, col: 0 }, undefined, clock(13_000))
    expect(r.fired?.to).toBe('idle')
  })

  it('still recognizes the legacy ✢-class spinner as generating (no regression)', () => {
    const legacyScreen = [
      '⏺ Working.',
      '',
      '✢ Blanching… (5s · ↑ 1.2k tokens)',
      '',
      '────────────────────────────────────────────────────────────────────────────────',
      '❯',
      '────────────────────────────────────────────────────────────────────────────────',
      '  ➜ spec-notif-magi-manual git:(spec/notif-magi-manual)',
    ].join('\n')
    const r = evaluateFsm(spec, 'approval', legacyScreen, { row: 5, col: 0 }, undefined, clock(5_000))
    expect(r.fired?.to).toBe('busy')
  })
})
