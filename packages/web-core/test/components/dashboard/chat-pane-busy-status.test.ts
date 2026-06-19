import { describe, expect, it } from 'vitest'
import { buildBusyChatInputStatusMessage } from '../../../src/components/dashboard/ChatPane'

describe('ChatPane busy input status copy', () => {
  it('reports the generating status without the send/force guidance', () => {
    expect(buildBusyChatInputStatusMessage({ status: 'generating' } as any))
      .toBe('Agent is generating.')
  })

  it('surfaces no-progress context for no_progress sessions', () => {
    expect(buildBusyChatInputStatusMessage({ status: 'no_progress' } as any))
      .toBe('Agent shows no progress.')
  })

  it('still recognizes the legacy long_generating status alias', () => {
    expect(buildBusyChatInputStatusMessage({ status: 'long_generating' } as any))
      .toBe('Agent shows no progress.')
  })

  it('shows waiting context when approval buttons are not available yet', () => {
    expect(buildBusyChatInputStatusMessage({ status: 'waiting_approval', modalButtons: undefined } as any))
      .toBe('Agent is waiting for approval. Approval controls will appear when available.')
  })
})
