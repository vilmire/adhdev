/**
 * 2026-10-06: cursor-cli draws the command it wants to run ABOVE its
 * "Run this command?" question, so the approval card and push said only
 * "Run this command?" — `rm -rf` and `touch` looked the same. The title now
 * appends the `$ …` block under the box rule (extract.title.detail_section).
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSections } from '../../../src/providers/spec/evaluator.js'
import { deriveModal } from '../../../src/providers/spec/fsm-driver-modal.js'
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SPEC_PATH = path.resolve(HERE, '../../../../../../adhdev-providers/cli/cursor-cli/specs/1.0.json')
const maybe = fs.existsSync(SPEC_PATH) ? describe : describe.skip
const RULE = '─'.repeat(80)

// Captured from a live Cursor Agent approval (standalone, 2026-10-06).
const SCREEN = [
  '  Run this shell command exactly once: touch .adhdev-cmdtext-check && rm',
  '  .adhdev-cmdtext-check — then reply with only the word done.',
  '',
  '',
  '  $ touch .adhdev-cmdtext-check && rm .adhdev-cmdtext-check 3.4s',
  '',
  '  done',
  '',
  '',
  '  $ touch .adhdev-cmdtext-two && rm .adhdev-cmdtext-two Waiting for',
  '    approval...',
  '',
  RULE,
  ' $  touch .adhdev-cmdtext-two && rm .adhdev-cmdtext-two in .',
  '',
  ' Run this command?',
  ' Not in allowlist: rm, touch',
  '  → Run (once) (y)',
  '    Add Shell(touch), Shell(rm) to allowlist? (tab)',
  '    Run Everything (shift+tab)',
  '    Skip & tell the agent what to do instead (esc or n)',
]

maybe('cursor-cli approval title carries the command', () => {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'))
  const state = spec.states.find((s: any) => s.id === 'approval')

  it('the spec validates', () => {
    expect(validateFsmSpec(spec)).toEqual([])
  })

  it('appends the boxed `$` command under the question', () => {
    const modal = deriveModal(state, resolveSections(spec.sections, SCREEN), SCREEN.join('\n'), () => {})
    expect(modal?.title).toBe('Run this command?\n$  touch .adhdev-cmdtext-two && rm .adhdev-cmdtext-two in .')
    expect(modal?.buttons.map((b: any) => b.label)).toEqual([
      'Run (once)',
      'Add Shell(touch), Shell(rm) to allowlist?',
      'Run Everything',
      'Skip & tell the agent what to do instead',
    ])
  })

  it('keeps a wrapped command whole and ignores transcript `$` lines', () => {
    const wrapped = [
      '  $ ls 1.2s',
      RULE,
      ' $  git push --force origin main && rm -rf build/very/long/path/that/wraps',
      '    /onto/a/second/line in .',
      '',
      ' Run this command?',
      '  → Run (once) (y)',
      '    Skip (esc or n)',
    ]
    const modal = deriveModal(state, resolveSections(spec.sections, wrapped), wrapped.join('\n'), () => {})
    expect(modal?.title).toBe([
      'Run this command?',
      '$  git push --force origin main && rm -rf build/very/long/path/that/wraps',
      '/onto/a/second/line in .',
    ].join('\n'))
  })

  it('leaves a modal with no command block as the bare question', () => {
    const trust = [' Do you trust the contents of this directory?', '  → Trust (y)', '    Quit (esc or n)']
    const modal = deriveModal(state, resolveSections(spec.sections, trust), trust.join('\n'), () => {})
    expect(modal?.title).toBe('Do you trust the contents of this directory?')
  })
})
