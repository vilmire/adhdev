import { describe, expect, it } from 'vitest'
import {
  pickApprovalButton,
  pickAutoApprovalButton,
  hasNegativeApprovalOption,
  hasReliableApprovalAffirmative,
  isNegativeApprovalLabel,
} from '../../src/providers/approval-utils.js'

describe('approval-utils', () => {
  it('prefers the least-permissive yes button over session-wide allow variants', () => {
    expect(pickApprovalButton([
      '1 Yes',
      '2 Yes, allow all edits this session',
      '3 No',
    ])).toEqual({ index: 0, label: '1 Yes' })
  })

  it('prefers allow once before always allow', () => {
    expect(pickApprovalButton([
      'Allow once',
      'Always allow',
      'Deny',
    ])).toEqual({ index: 0, label: 'Allow once' })
  })

  it('picks the run-once affirmative over an allowlist-grant on cursor Not-in-allowlist modal', () => {
    // Live cursor-cli defect (rc.539): the 'Not in allowlist: git status' modal
    // rendered ["Run (once)", "Add Shell(git status) to allowlist?",
    // "Run Everything", "Skip"] with cursor's custom hints. Approve landed on
    // index 1 ("Add … to allowlist?") — a scope-broadening grant that does NOT
    // execute the command — because the earlier `allow` hint substring-hit
    // "allow-LIST" before the later `run` hint prefix-hit "run once". Match
    // quality must dominate hint order, and substring hits must be whole-word.
    expect(pickApprovalButton([
      'Run (once)',
      'Add Shell(git status) to allowlist?',
      'Run Everything',
      'Skip',
    ], {
      approvalPositiveHints: ['trust', 'trust this workspace', 'allow', 'approve', 'accept', 'run', 'yes'],
    })).toEqual({ index: 0, label: 'Run (once)' })
  })

  it('recognizes cursor "Skip" as a decline so reject can find it', () => {
    // Live cursor-cli reject defect: the decline button is "Skip", which the
    // old reject matcher (/deny|reject|no/) missed → resolve_action(reject)
    // returned "did not match any visible button" and left the modal wedged.
    expect(isNegativeApprovalLabel('Skip')).toBe(true)
    expect(isNegativeApprovalLabel('Skip (esc or n)')).toBe(true)
    // The cursor allowlist modal's decline is index 3 among the four buttons.
    const buttons = ['Run (once)', 'Add Shell(git status) to allowlist?', 'Run Everything', 'Skip']
    expect(buttons.findIndex((b) => isNegativeApprovalLabel(b))).toBe(3)
    // And the positive buttons are NOT misread as declines.
    expect(isNegativeApprovalLabel('Run (once)')).toBe(false)
    expect(isNegativeApprovalLabel('Add Shell(git status) to allowlist?')).toBe(false)
  })

  it('does not let a substring buried in a word (allow → allowlist) win a match', () => {
    // Even when the allowlist grant sits FIRST, the whole-word include guard
    // must skip it so a real affirmative (run once) is still selected.
    expect(pickApprovalButton([
      'Add to allowlist?',
      'Run once',
      'Skip',
    ], {
      approvalPositiveHints: ['allow', 'run', 'yes'],
    })).toEqual({ index: 1, label: 'Run once' })
  })

  it('respects provider-specific positive hint ordering', () => {
    expect(pickApprovalButton([
      '1 Yes',
      '2 Yes, allow rm -f for this project (just you)',
      '3 No',
    ], {
      approvalPositiveHints: ['yes', 'allow', 'always allow'],
    })).toEqual({ index: 0, label: '1 Yes' })
  })

  it('auto-approval picks the first visible button, not the strongest positive label', () => {
    expect(pickAutoApprovalButton([
      'Yes',
      'Yes, allow all edits in tmp/ during this session (shift+tab)',
      'No',
    ])).toEqual({ index: 0, label: 'Yes' })
  })

  it('auto-approval keeps button index stable even when labels are malformed', () => {
    expect(pickAutoApprovalButton([
      '❯',
      'Yes, allow reading from etc/ from this project',
      'No',
    ])).toEqual({ index: 0, label: '❯' })
  })
})

describe('hasReliableApprovalAffirmative — tall-diff off-frame decline fallback (#137)', () => {
  it('recognizes a Write/Edit consent modal when "No" scrolled off-frame', () => {
    // Trailing "3. No" fell off the captured frame; only Yes + grant remain.
    const buttons = ['Yes', 'Yes, allow all edits in tmp/ during this session (shift+tab)']
    expect(hasNegativeApprovalOption(buttons)).toBe(false)      // decline gone
    expect(hasReliableApprovalAffirmative(buttons)).toBe(true)  // grant anchors it
    // The fire path still picks the least-permissive allow-once "Yes".
    expect(pickApprovalButton(buttons)).toEqual({ index: 0, label: 'Yes' })
  })

  it('recognizes "Yes, and don\'t ask again for X"', () => {
    expect(hasReliableApprovalAffirmative([
      'Yes',
      "Yes, and don't ask again for example.com",
    ])).toBe(true)
  })

  it('recognizes a standalone "Always allow"', () => {
    expect(hasReliableApprovalAffirmative(['Allow once', 'Always allow'])).toBe(true)
  })

  it('does NOT fire on a bare Yes/No pair (needs the explicit decline instead)', () => {
    // Plain "Yes" alone is not a reliable consent anchor — it is common to
    // pickers too. The decline anchor (hasNegativeApprovalOption) covers this.
    expect(hasReliableApprovalAffirmative(['Yes', 'No'])).toBe(false)
  })

  it('does NOT trip on a /model or /mode picker (no grant-scope option)', () => {
    expect(hasReliableApprovalAffirmative(['Default', 'Opus 4.8', 'Sonnet'])).toBe(false)
    expect(hasReliableApprovalAffirmative(['1. Default (recommended)', '2. Opus', '3. Sonnet'])).toBe(false)
  })

  it('does NOT trip on a decline that mentions a different verb', () => {
    expect(hasReliableApprovalAffirmative([
      'No, and tell Claude what to do differently (esc)',
    ])).toBe(false)
  })
})
