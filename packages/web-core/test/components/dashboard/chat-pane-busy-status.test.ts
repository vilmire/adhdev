import { describe, expect, it } from 'vitest'
import { buildBusyChatInputStatusMessage } from '../../../src/components/dashboard/ChatPane'

describe('ChatPane busy input status copy', () => {
  it('explains queued send and force-send while generating', () => {
    expect(buildBusyChatInputStatusMessage({ status: 'generating' } as any))
      .toBe('Agent is generating. Send queues your message; Force sends it immediately.')
  })

  it('surfaces no-progress context for no_progress sessions', () => {
    expect(buildBusyChatInputStatusMessage({ status: 'no_progress' } as any))
      .toBe('Agent shows no progress. Send queues your message; Force sends it immediately.')
  })

  it('still recognizes the legacy long_generating status alias', () => {
    expect(buildBusyChatInputStatusMessage({ status: 'long_generating' } as any))
      .toBe('Agent shows no progress. Send queues your message; Force sends it immediately.')
  })

  it('shows waiting context when approval buttons are not available yet', () => {
    expect(buildBusyChatInputStatusMessage({ status: 'waiting_approval', modalButtons: undefined } as any))
      .toBe('Agent is waiting for approval. Approval controls will appear when available.')
  })
})
