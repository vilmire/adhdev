import { describe, expect, it } from 'vitest'
import { pickApprovalButton, pickAutoApprovalButton } from '../../src/providers/approval-utils.js'

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
