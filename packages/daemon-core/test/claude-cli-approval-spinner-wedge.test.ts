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
 * clause never matched the active form → the approval resume path
 * (spinner-authenticated resolving state) and `→idle` exit both
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

  it('unsticks approval through the resolving gate when ✻ spinner carries active tokens', () => {
    const candidate = evaluateFsm(
      spec, 'approval', wedgeScreen, { row: 7, col: 0 }, undefined, clock(5_000))
    expect(candidate.fired?.to).toBe('approval_resolving')
    const settled = evaluateFsm(
      spec, 'approval_resolving', wedgeScreen, { row: 7, col: 0 }, undefined, clock(1_300))
    expect(settled.fired?.to).toBe('busy')
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

  it('still recognizes the legacy ✢-class spinner through the resolving gate', () => {
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
    const candidate = evaluateFsm(
      spec, 'approval', legacyScreen, { row: 5, col: 0 }, undefined, clock(5_000))
    expect(candidate.fired?.to).toBe('approval_resolving')
    const settled = evaluateFsm(
      spec, 'approval_resolving', legacyScreen, { row: 5, col: 0 }, undefined, clock(1_300))
    expect(settled.fired?.to).toBe('busy')
  })

  /**
   * APPROVAL-WEDGE (residual-spinner-while-modal-open, observed 2026-07-17):
   * the INVERSE of the answered-resume wedge above. The approval modal is still
   * fully open — the numbered choice block `❯ 1. Yes … 2. No` and the
   * "Do you want to …" question are on screen — but a spinner line from the
   * PRIOR turn (`✳ Tinkering…`) still lingers in the body. The unsectioned
   * busy-spinner arm matched that stale spinner and (with the footer/modal
   * section anchors momentarily flickering under repaint) the FSM left
   * `approval` for `busy` within ~10s, so the modal never surfaced in
   * mesh_list_pending_approvals and the worker wedged at the prompt.
   *
   * The numbered-choice-block NOT-guard keeps the FSM in `approval` while the
   * `1. … 2. …` choices are on the raw screen, independent of section anchoring.
   */
  it('does NOT leave approval when the choice block is still on screen (stale prior-turn spinner)', () => {
    const modalOpenWithResidualSpinner = [
      '⏺ Reading the workflow file.',
      '',
      '✳ Tinkering… (1m 12s · ↓ 4.0k tokens)',
      '',
      '────────────────────────────────────────────────────────────────────────────────',
      ' Do you want to run this command?',
      '',
      ' ❯ 1. Yes',
      '   2. No, and tell Claude what to do differently',
      '────────────────────────────────────────────────────────────────────────────────',
      '  ➜ spec-notif-magi-manual git:(spec/notif-magi-manual)',
    ].join('\n')
    // Held well past approval→busy's min_hold; the choice block + question keep
    // it parked in approval even though the residual ✳ spinner matches.
    const r = evaluateFsm(spec, 'approval', modalOpenWithResidualSpinner, { row: 7, col: 0 }, undefined, clock(6_000))
    expect(r.fired?.to).not.toBe('busy')
  })

  it('holds approval on the choice block alone when the question text has scrolled off (guard is load-bearing)', () => {
    // Stricter than the case above: the "Do you want …" question has scrolled
    // out of the captured frame (so the whole-screen + modal-section question
    // NOT-guards no longer fire) and the footer section's last `❯` line is the
    // shell prompt rather than the choice row — yet the numbered choice block
    // `1. … 2. …` is still visible with a residual spinner. Only the new
    // choice-block NOT-guard keeps this parked in approval.
    const questionScrolledOff = [
      ' ❯ 1. Yes',
      '   2. No, and tell Claude what to do differently',
      '',
      '✳ Tinkering… (1m 12s · ↓ 4.0k tokens)',
      '',
      '────────────────────────────────────────────────────────────────────────────────',
      '❯',
      '────────────────────────────────────────────────────────────────────────────────',
      '  ➜ spec-notif-magi-manual git:(spec/notif-magi-manual)',
    ].join('\n')
    const r = evaluateFsm(spec, 'approval', questionScrolledOff, { row: 6, col: 0 }, undefined, clock(6_000))
    expect(r.fired?.to).not.toBe('busy')
  })

  /**
   * APPROVAL-ENTRY-WEDGE (busy→approval blocked by residual spinner, observed
   * 2026-07-18, session 52e5df0a). The exact MIRROR of the approval→busy cases
   * above: the FSM is still in `busy` from the prior turn when a fresh edit-
   * approval modal renders. The footer section correctly carries the choice
   * block (`❯ 1. Yes`) and the "Do you want to make this edit …" question, so
   * the entry transition's cond 1 & 2 match — but a prior-turn spinner line
   * (`✶ Galloping… ↓ 24.8k tokens`) that the CLI never cleared still lingers on
   * the corrupted grid. The unsectioned busy-spinner NOT-guard (cond 3) matched
   * that stale spinner, so `busy→approval` never fired: the FSM stayed in
   * `busy`/`generating`, `activeModal` was never populated, the approval never
   * reached mesh_list_pending_approvals, delegatedWorkerAutoApprove never fired,
   * and mesh_approve rejected with "Not in approval state".
   *
   * Fix: cond 3 became an `any` — the definitive numbered choice block
   * (`1. … 2. …`, the same discriminator the approval→busy guards trust) now
   * DOMINATES a co-rendered residual spinner, so an open approval modal enters
   * `approval` regardless of leftover generating cues. cond 1 & 2 still gate
   * entry, so a bare spinner without a real modal cannot spuriously enter.
   */
  it('ENTERS busy → approval when the choice block is open despite a residual prior-turn spinner', () => {
    // Reconstructed from the live wedge screen (debug bundle
    // chat-debug-20260718T063214420Z-…-52e5df0a): a fresh Edit-approval modal
    // with two stale prior-turn spinner lines (⏺ Tempering…, ✶ Galloping…) still
    // painted above it on the corrupted grid.
    const modalOpenFromBusy = [
      '⏺ Tempering… (7m 52s · ↓ 24.3k tokens)',
      '',
      '❯       Read: ~/Work/.adhdev-worktrees/s ·743.6k tokens',
      '─'.repeat(80),
      ' Edit file',
      '✶ Galloping… (8m 15s · ↓ 24.8k tokens)',
      '─'.repeat(80),
      ' ../../packages/web-cloud/src/pages/admin/AdminAudit.tsx',
      '╌'.repeat(80),
      ' 79 +                    {t(\'cloud.adminAudit.filter\')}',
      '╌'.repeat(80),
      ' Do you want to make this edit to AdminAudit.tsx?',
      ' ❯ 1. Yes',
      '   2. Yes, allow all edits during this session (shift+tab)',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
    ].join('\n')
    // Held past the entry transition's hold; cursor on the choice row.
    const r = evaluateFsm(spec, 'busy', modalOpenFromBusy, { row: 12, col: 3 }, undefined, clock(5_000))
    expect(r.fired?.to).toBe('approval')
  })

  it('does NOT enter busy → approval on a bare residual spinner with no real modal (entry guard intact)', () => {
    // Only a generating spinner + shell prompt, no choice block / question. The
    // any-guard must not open approval here — cond 1 & 2 (footer `1.`/`Esc`/`Do
    // you want`) fail, so the transition stays closed.
    const spinnerNoModal = [
      '⏺ Working on the edit.',
      '',
      '✶ Galloping… (1m 02s · ↓ 4.0k tokens)',
      '',
      '─'.repeat(80),
      '❯',
      '─'.repeat(80),
      '  ➜ spec-notif-magi-manual git:(spec/notif-magi-manual)',
    ].join('\n')
    const r = evaluateFsm(spec, 'busy', spinnerNoModal, { row: 5, col: 0 }, undefined, clock(5_000))
    expect(r.fired?.to).not.toBe('approval')
  })

  it('resumes through the settling gate once the choice block is gone even if a body numbered list remains', () => {
    // Answered/resumed: the modal choice block is gone (footer is a bare ❯) and
    // generation resumed with a live spinner. A lone `1.`-style numbered list in
    // the transcript body without a following `2.` must NOT re-wedge approval —
    // the guard requires BOTH `1.` and `2.` choice lines.
    const answeredWithBodyList = [
      '⏺ Step 1. checked the runs; the workflow re-triggered.',
      '',
      '✻ Moonwalking… (2m 03s · ↓ 6.0k tokens)',
      '',
      '────────────────────────────────────────────────────────────────────────────────',
      '❯',
      '────────────────────────────────────────────────────────────────────────────────',
      '  ➜ spec-notif-magi-manual git:(spec/notif-magi-manual)',
    ].join('\n')
    const candidate = evaluateFsm(
      spec, 'approval', answeredWithBodyList, { row: 5, col: 0 }, undefined, clock(6_000))
    expect(candidate.fired?.to).toBe('approval_resolving')
    const settled = evaluateFsm(
      spec, 'approval_resolving', answeredWithBodyList, { row: 5, col: 0 }, undefined, clock(1_300))
    expect(settled.fired?.to).toBe('busy')
  })
})
