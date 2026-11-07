/**
 * cursor-agent queues several shell approvals at once ("Approval 1 of 3",
 * footer "←/→ to switch approval"). Live 2026-11-06 (Prefex mesh worker,
 * cursor-agent on macOS): the screen below sat for 90 minutes while the FSM
 * reported `generating`, so auto-approve never answered and the attempt hit
 * the hard ceiling. The cursor was parked below the last row (row 33 on a
 * 32-row screen).
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSections } from '../../../src/providers/spec/evaluator.js'
import { deriveModal } from '../../../src/providers/spec/fsm-driver-modal.js'
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SPEC_PATH = path.resolve(HERE, '../../../../../../adhdev-providers/cli/cursor-cli/specs/1.0.json')
const maybe = fs.existsSync(SPEC_PATH) ? describe : describe.skip
const RULE = '─'.repeat(80)
const clk = (now: number): FsmClock => ({ now, stateEnteredAt: 0, regionLastChangedAt: new Map() })

const PENDING = [
  '  $ find "/work/feat/scripts/tests/fixtures/crossover-baseline" -type f | head -80',
  '    Waiting for approval...',
  '',
]
const SCREEN = [
  '    Read ...-wine-baseline/dlls/ntoskrnl.exe/tests/driver.c',
  '',
  ...PENDING, ...PENDING, ...PENDING,
  RULE,
  ' Approval 1 of 3',
  '',
  ' $  find',
  '    "/work/feat/scripts/tests/fixtures/crossover-baseline"',
  '    -type f | head -80 in .',
  '',
  ' Run this command?',
  ' Shell allowlist is empty',
  '  → Run (once) (y)',
  '    Add Shell(find), Shell(head) to allowlist? (tab)',
  '    Run Everything (shift+tab)',
  '    Skip & tell the agent what to do instead (esc or n)',
  '',
  ' ←/→ to switch approval',
]

maybe('cursor-cli queued multi-approval ("Approval 1 of 3")', () => {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'))
  const state = spec.states.find((s: any) => s.id === 'approval')

  for (const cursor of [{ row: SCREEN.length + 1, col: 0 }, { row: SCREEN.length - 1, col: 0 }, undefined]) {
    it(`fires → approval from busy (cursor ${JSON.stringify(cursor)})`, () => {
      const ev = evaluateFsm(spec, 'busy', SCREEN.join('\n'), cursor as any, undefined, clk(10000))
      expect(ev.fired?.to).toBe('approval')
    })
  }

  it('still rejects the parked cursor when anything is drawn below the switcher', () => {
    const below = [...SCREEN, '', '  → add a follow-up']
    const ev = evaluateFsm(spec, 'busy', below.join('\n'), { row: below.length + 1, col: 0 }, undefined, clk(10000))
    expect(ev.fired?.to).not.toBe('approval')
  })

  it('exposes the four options', () => {
    const modal = deriveModal(state, resolveSections(spec.sections, SCREEN), SCREEN.join('\n'), () => {})
    expect(modal?.buttons.map((b: any) => b.label)).toEqual([
      'Run (once)', 'Add Shell(find), Shell(head) to allowlist?', 'Run Everything', 'Skip & tell the agent what to do instead',
    ])
  })
})

/**
 * The single-approval form (live 2026-11-06, Prefex reviewer a9238ac9): no "Approval 1 of N"
 * and no switcher row — the prompt ends on its `Skip & tell … (esc or n)` option, with the
 * cursor parked two rows below the 32-row screen. The reviewer sat 10+ minutes as `generating`.
 */
const SINGLE = [
  '  $ cd /work/feat && git rev-parse HEAD && git merge-base HEAD 8ee262d7272f',
  '    2>/dev/null; git log --oneline 8ee262d..HEAD Waiting for approval...',
  '',
  RULE,
  ' $  cd /work/feat && git rev-parse HEAD && git merge-base HEAD 8ee262d7272f',
  '    2>/dev/null; git log --oneline 8ee262d..HEAD in .',
  '',
  ' Run this command?',
  ' Shell allowlist is empty',
  '  → Run (once) (y)',
  '    Add Shell(cd), Shell(git rev-parse), Shell(git merge-base), Shell(git log)',
  '  to allowlist? (tab)',
  '    Run Everything (shift+tab)',
  '    Skip & tell the agent what to do instead (esc or n)',
]

maybe('cursor-cli single approval with the cursor parked below the screen', () => {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'))

  for (const cursor of [{ row: SINGLE.length + 1, col: 0 }, { row: SINGLE.length, col: 0 }, undefined]) {
    it(`fires → approval from busy (cursor ${JSON.stringify(cursor)})`, () => {
      const ev = evaluateFsm(spec, 'busy', SINGLE.join('\n'), cursor as any, undefined, clk(10000))
      expect(ev.fired?.to).toBe('approval')
    })
  }

  it('still rejects the parked cursor when the prompt is followed by more output', () => {
    const quoted = [...SINGLE, '', '  ⬢ Ran the command.']
    const ev = evaluateFsm(spec, 'busy', quoted.join('\n'), { row: quoted.length + 1, col: 0 }, undefined, clk(10000))
    expect(ev.fired?.to).not.toBe('approval')
  })
})
