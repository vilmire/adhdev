// 2026-10-02: a manual-approval claude-cli session waited on `rm -rf dist`, and
// read_chat showed its three buttons, but the dashboard rendered no approval
// card: the status projection took the parsed status's `activeModal: null`
// over the screen adapter's modal (`??` keeps null).
import { describe, expect, it } from 'vitest'
import { resolveCliActiveModal } from '../../src/providers/cli-provider-state-projection.js'

const SCREEN = { message: 'Bash command', buttons: ['Yes', "Yes, and don't ask again", 'No'] }

describe('resolveCliActiveModal', () => {
  it('keeps the screen modal when the parsed status reports null', () => {
    expect(resolveCliActiveModal(null, SCREEN)).toBe(SCREEN)
  })

  it('prefers a parsed modal that has buttons', () => {
    const parsed = { message: 'Approve?', buttons: ['Allow', 'Deny'] }
    expect(resolveCliActiveModal(parsed, SCREEN)).toBe(parsed)
  })

  it('reports no modal when neither side has one', () => {
    expect(resolveCliActiveModal(null, null)).toBeNull()
    expect(resolveCliActiveModal(undefined, undefined)).toBeNull()
  })
})
