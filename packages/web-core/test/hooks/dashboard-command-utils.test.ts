import { describe, expect, it } from 'vitest'
import {
  getConversationSendBlockMessage,
  getConversationSendBlockedPlaceholder,
  getInlineSendFailureMessage,
} from '../../src/hooks/dashboardCommandUtils'

describe('dashboard command utils send-state helpers', () => {
  it('does not pre-block active generation in the input layer', () => {
    expect(getConversationSendBlockMessage({ status: 'generating', modalButtons: undefined } as any))
      .toBeNull()
  })

  it('maps pending approval to a non-transcript input warning when actionable modal buttons are present', () => {
    expect(getConversationSendBlockMessage({ status: 'idle', modalButtons: ['Approve'] } as any))
      .toBe('Approve or reject the pending request above.')
  })

  it('labels waiting_choice as an answer instead of an approval in both blocked surfaces', () => {
    const conversation = { status: 'waiting_choice', modalButtons: ['Yes', 'No'] } as any

    expect(getConversationSendBlockMessage(conversation))
      .toBe('Answer the pending question above.')
    expect(getConversationSendBlockedPlaceholder(conversation))
      .toBe('Waiting for your answer…')
  })

  it('keeps the approval placeholder for actionable waiting_approval state', () => {
    expect(getConversationSendBlockedPlaceholder({
      status: 'waiting_approval',
      modalButtons: ['Approve', 'Reject'],
    } as any)).toBe('Waiting for approval…')
  })

  it('does not pre-block sends from status alone when waiting approval state has no actionable modal buttons', () => {
    expect(getConversationSendBlockMessage({ status: 'waiting_approval', modalButtons: undefined } as any))
      .toBeNull()
  })

  it('does not mislabel waiting_for_user_input as a pending approval block', () => {
    expect(getConversationSendBlockMessage({ status: 'waiting_for_user_input', modalButtons: undefined } as any))
      .toBeNull()
  })

  it('normalizes PTY not-ready errors into friendly inline copy', () => {
    expect(getInlineSendFailureMessage('pty send failed: runtime is not ready'))
      .toBe('Wait for the runtime to finish starting up before sending a message.')
  })

  it('falls back to the raw message for unrecognized errors', () => {
    expect(getInlineSendFailureMessage('pty send failed: something unexpected'))
      .toBe('pty send failed: something unexpected')
  })
})
