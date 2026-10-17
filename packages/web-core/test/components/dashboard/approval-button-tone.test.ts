// 2026-10-02 (claude-cli Bash approval on the cloud dashboard): "Yes, and always
// allow access to dist/ from this project" was styled as the default choice
// because it starts with "yes", and "No" fell through to a neutral style that
// rendered white-on-white.
import { describe, expect, it } from 'vitest'
import { approvalButtonTone } from '../../../src/components/dashboard/ApprovalBanner'

describe('approvalButtonTone', () => {
  it('marks standing permissions as always-allow even when they start with "yes"', () => {
    expect(approvalButtonTone('yes, and always allow access to dist/ from this project')).toBe('always')
    expect(approvalButtonTone("yes, and don't ask again for similar commands")).toBe('always')
    expect(approvalButtonTone('allow all actions on localhost')).toBe('always')
    expect(approvalButtonTone('always allow')).toBe('always')
    expect(approvalButtonTone('yes, and allow access to dist/ and echo commands')).toBe('always')
    expect(approvalButtonTone('2. Yes, allow edits during this session')).toBe('always')
    expect(approvalButtonTone('Allow for this session')).toBe('always')
    expect(approvalButtonTone('Add Shell(git status) to allowlist?')).toBe('always')
    expect(approvalButtonTone('Run Everything')).toBe('always')
    expect(approvalButtonTone('Yes, and don’t ask again')).toBe('always')
  })

  it('keeps a one-time approval primary', () => {
    expect(approvalButtonTone('yes')).toBe('primary')
    expect(approvalButtonTone('allow')).toBe('primary')
    expect(approvalButtonTone('run')).toBe('primary')
    expect(approvalButtonTone('1. Run (once)')).toBe('primary')
    expect(approvalButtonTone('Yes, allow once')).toBe('primary')
    expect(approvalButtonTone('runtime info')).toBe('neutral')
  })

  it('treats "No" like the other safe exits', () => {
    expect(approvalButtonTone('no')).toBe('danger')
    expect(approvalButtonTone('deny')).toBe('danger')
    expect(approvalButtonTone('notify me later')).toBe('neutral')
  })
})
