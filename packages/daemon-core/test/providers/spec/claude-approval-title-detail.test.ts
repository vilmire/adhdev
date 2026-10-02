/**
 * 2026-10-02: the dashboard approval card (and the push) for a claude-cli Bash
 * approval read only "Bash command" — the command being approved sat below the
 * title and was dropped, so `rm -rf` and `git push --force` looked the same.
 * The approval title now keeps the lines under it up to the question.
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

// Captured from a live claude-cli approval (rows as rendered at 80 columns).
const SCREEN = [
  '⏺ Bash(rm -rf dist && ls -la | grep -c dist)',
  '  ⎿  Waiting…',
  '',
  RULE,
  ' Bash command',
  '',
  '   rm -rf dist && ls -la | grep -c dist; echo "dist removed (exit grep count',
  '   above, 0 = gone)"',
  '   Delete dist folder',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to dist/ from this project',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend · ctrl+e to explain',
]

maybe('claude-cli approval title carries the command', () => {
  it('keeps the command and description under "Bash command"', () => {
    const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'))
    const state = spec.states.find((s: any) => s.id === 'approval')
    const modal = deriveModal(state, resolveSections(spec.sections, SCREEN), SCREEN.join('\n'), () => {})
    expect(modal?.title).toBe([
      'Bash command',
      'rm -rf dist && ls -la | grep -c dist; echo "dist removed (exit grep count',
      'above, 0 = gone)"',
      'Delete dist folder',
    ].join('\n'))
    expect(modal?.buttons.map(b => b.label)).toEqual(['Yes', 'Yes, and always allow access to dist/ from this project', 'No'])
  })
})
