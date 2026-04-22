import { describe, expect, it } from 'vitest'
import {
  getConversationSendBlockMessage,
  getInlineSendFailureMessage,
} from '../../src/hooks/dashboardCommandUtils'

describe('dashboard command utils send-state helpers', () => {
  it('does not pre-block active generation in the input layer', () => {
    expect(getConversationSendBlockMessage({ status: 'generating', modalButtons: undefined } as any))
      .toBeNull()
  })

  it('maps pending approval to a non-transcript input warning when actionable modal buttons are present', () => {
    expect(getConversationSendBlockMessage({ status: 'idle', modalButtons: ['Approve'] } as any))
      .toBe('Resolve the pending approval prompt before sending another message.')
  })

  it('does not pre-block sends from status alone when waiting approval state has no actionable modal buttons', () => {
    expect(getConversationSendBlockMessage({ status: 'waiting_approval', modalButtons: undefined } as any))
      .toBeNull()
  })

  it('does not mislabel waiting_for_user_input as a pending approval block', () => {
    expect(getConversationSendBlockMessage({ status: 'waiting_for_user_input', modalButtons: undefined } as any))
      .toBeNull()
  })

  it('normalizes PTY busy errors into friendly inline copy', () => {
    expect(getInlineSendFailureMessage('pty send failed: Hermes Agent is still processing the previous prompt'))
      .toBe('Wait for the current reply to finish before sending another message.')
  })
})
