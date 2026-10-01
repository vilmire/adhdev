/**
 * Live defect (2026-10-01, claude-cli spec 4.0, mesh coordinator): while an
 * AskUserQuestion picker was open, the session reported the buttons of an old
 * numbered list from the assistant's own earlier message. The modal section's
 * "line followed by `1.`" anchor also matched that list in scrollback, and the
 * `❯` user-message line between it and the picker ended the section there.
 * A choice block always carries the cursor; a written list never does.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSections } from '../../../src/providers/spec/evaluator.js'
import { deriveModal } from '../../../src/providers/spec/fsm-driver-modal.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SPEC_PATH = path.resolve(HERE, '../../../../../../adhdev-providers/cli/claude-cli/specs/4.0.json')
const maybe = fs.existsSync(SPEC_PATH) ? describe : describe.skip
const RULE = '─'.repeat(80)

const SCROLLBACK = [
  '  Remaining work, in order:',
  '  1. Commit dark-mode files on its own worktree',
  '  2. Resolve the base node file.',
  '  3. Land all three with mesh_refine_batch',
  '',
  '❯ Operator: go ahead',
  '',
  '⏺ Given that, confirm which you want:',
  RULE,
  ' ☐ Confirm push',
  '',
  'Confirm the push to origin/main?',
  '',
  '❯ 1. Yes, push all 4 to origin/main',
  '     Fast-forward push of main to origin/main.',
  '  2. Diagnose first, then push if confirmed',
  '     Spend one read-only worker confirming the gate.',
  '  3. Push, but I want to see the diff first',
  '  4. Type something.',
  RULE,
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
]

maybe('claude-cli picker with an old numbered list in scrollback', () => {
  it('takes the buttons from the cursor-bearing picker rows', () => {
    const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'))
    const state = spec.states.find((s: any) => s.id === 'picker')
    const modal = deriveModal(state, resolveSections(spec.sections, SCROLLBACK), SCROLLBACK.join('\n'), () => {})
    expect(modal?.buttons.map(b => b.label)).toEqual([
      'Yes, push all 4 to origin/main',
      'Diagnose first, then push if confirmed',
      'Push, but I want to see the diff first',
      'Type something.',
      'Chat about this',
    ])
    expect(modal?.buttons[0].current).toBe(true)
  })
})
