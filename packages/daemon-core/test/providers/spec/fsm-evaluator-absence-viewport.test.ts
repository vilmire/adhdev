/**
 * Live defect (2026-10-01, claude-cli spec 4.0, mesh coordinator): the turn
 * ended at an idle prompt, but the FSM stayed in `busy` for an hour. Every
 * queued send — mesh refine events, operator messages — waited for an idle
 * that never came.
 *
 * Transition guards read a scrollback-extended frame (200 lines above the
 * viewport) so a tall modal's off-screen top still counts as present. busy→idle
 * requires the spinner to be ABSENT (`not` + unscoped regex), and the redraw
 * nudge's SIGWINCH wiggles had left copies of the spinner line in scrollback,
 * so the absence check kept matching stale text. Absence is now judged on the
 * viewport.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateFsm } from '../../../src/providers/spec/fsm-evaluator.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SPEC_PATH = path.resolve(HERE, '../../../../../../adhdev-providers/cli/claude-cli/specs/4.0.json')
const maybe = fs.existsSync(SPEC_PATH) ? describe : describe.skip
const RULE = '─'.repeat(80)

const VIEWPORT = [
  '  Waiting on its terminal event.',
  '',
  '✻ Crunched for 24s',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏸ manual mode on · ← 2 agents',
]

function guardFrame(lookback: string[]): { screen: string; viewportStartRow: number } {
  const pad = new Array(200 - lookback.length).fill('')
  const lines = [...pad, ...lookback, ...VIEWPORT]
  return { screen: lines.join('\n'), viewportStartRow: 200 }
}

maybe('claude-cli busy→idle with a stale spinner above the viewport', () => {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'))
  const now = 10_000_000
  const clock = { now, stateEnteredAt: now - 600_000, regionLastChangedAt: new Map<number | string, number>() }
  const lookback = [
    '⏺ Re-running json-export-import to re-pin onto the current base.',
    '',
    '✢ Gusting… (esc to interrupt · ctrl+t to show todos)',
    '',
    '⏺ Accepted as refine_ix_muppda30_ti0uzg.',
  ]

  it('reaches idle when the spinner is only in scrollback', () => {
    const { screen, viewportStartRow } = guardFrame(lookback)
    const lines = screen.split('\n')
    const ev = evaluateFsm(spec, 'busy', screen, { row: lines.length - 3, col: 2 }, lines, clock, null, viewportStartRow)
    expect(ev.fired?.to).toBe('idle')
  })

  it('stays busy while the spinner is on screen', () => {
    const live = [...VIEWPORT]
    live[2] = '✢ Gusting… (esc to interrupt · ctrl+t to show todos)'
    const lines = [...new Array(200).fill(''), ...live]
    const screen = lines.join('\n')
    const ev = evaluateFsm(spec, 'busy', screen, { row: lines.length - 3, col: 2 }, lines, clock, null, 200)
    expect(ev.fired?.to).not.toBe('idle')
  })
})
