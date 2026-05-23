import { describe, expect, it } from 'vitest'
import { pickApprovalButton } from '../../src/providers/approval-utils.js'

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

  it('marks all-destructive choices unsafe so auto-approve can leave them alone', () => {
    expect(pickApprovalButton([
      'Terminate current task',
      'Cancel',
    ])).toEqual({ index: 0, label: 'Terminate current task', unsafe: true })
  })

  it('falls back to a non-destructive choice when no positive hint matches', () => {
    expect(pickApprovalButton([
      'Terminate current task',
      'Keep waiting',
    ])).toEqual({ index: 1, label: 'Keep waiting' })
  })

  it('does not let positive words make a destructive button auto-approvable', () => {
    expect(pickApprovalButton([
      'Confirm termination',
      'Keep running',
    ])).toEqual({ index: 1, label: 'Keep running' })
  })
})
