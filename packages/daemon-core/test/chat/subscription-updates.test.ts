import { describe, expect, it } from 'vitest'
import {
  prepareSessionModalUpdate,
} from '../../src/chat/subscription-updates'

describe('chat subscription update helpers', () => {
  it('suppresses duplicate modal updates after hashing the normalized modal payload', () => {
    const first = prepareSessionModalUpdate({
      key: 'modal-1',
      sessionId: 'session-1',
      seq: 0,
      timestamp: 111,
      lastDeliveredSignature: '',
      status: 'waiting_approval',
      title: 'Repo Thread',
      activeModal: {
        message: 'Approve?',
        buttons: ['Approve', 99, 'Reject'],
      },
    })

    expect(first.seq).toBe(1)
    expect(first.update).toMatchObject({
      topic: 'session.modal',
      key: 'modal-1',
      sessionId: 'session-1',
      status: 'waiting_approval',
      title: 'Repo Thread',
      modalMessage: 'Approve?',
      modalButtons: ['Approve', 'Reject'],
      seq: 1,
      timestamp: 111,
    })

    const duplicate = prepareSessionModalUpdate({
      key: 'modal-1',
      sessionId: 'session-1',
      seq: first.seq,
      timestamp: 222,
      lastDeliveredSignature: first.lastDeliveredSignature,
      status: 'waiting_approval',
      title: 'Repo Thread',
      activeModal: {
        message: 'Approve?',
        buttons: ['Approve', 'Reject'],
      },
    })

    expect(duplicate.seq).toBe(1)
    expect(duplicate.update).toBeNull()
    expect(duplicate.lastDeliveredSignature).toBe(first.lastDeliveredSignature)
  })

  it('normalizes modal updates to waiting_approval when actionable buttons exist', () => {
    const prepared = prepareSessionModalUpdate({
      key: 'modal-approval',
      sessionId: 'session-approval',
      seq: 0,
      timestamp: 333,
      lastDeliveredSignature: '',
      status: 'generating',
      title: 'Repo Thread',
      activeModal: {
        message: 'Approve dangerous command?',
        buttons: ['Allow once', 'Deny'],
      },
    })

    expect(prepared.update).toMatchObject({
      topic: 'session.modal',
      key: 'modal-approval',
      sessionId: 'session-approval',
      status: 'waiting_approval',
      title: 'Repo Thread',
      modalMessage: 'Approve dangerous command?',
      modalButtons: ['Allow once', 'Deny'],
      seq: 1,
      timestamp: 333,
    })
  })
})
