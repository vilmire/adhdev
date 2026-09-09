import { describe, expect, it } from 'vitest'
import { buildBusyChatInputStatusMessage } from '../../../src/components/dashboard/ChatPane'

// Identity translator: pins which i18n KEY each status maps to, not English
// copy — the strings themselves now live in common.json (G8-15).
const t = (key: string) => key

describe('ChatPane busy input status copy', () => {
  it('reports the generating status without the send/force guidance', () => {
    expect(buildBusyChatInputStatusMessage({ status: 'generating' } as any, t))
      .toBe('chatPane.busyGenerating')
  })

  it('surfaces no-progress context for no_progress sessions', () => {
    expect(buildBusyChatInputStatusMessage({ status: 'no_progress' } as any, t))
      .toBe('chatPane.busyNoProgress')
  })

  it('still recognizes the legacy long_generating status alias', () => {
    expect(buildBusyChatInputStatusMessage({ status: 'long_generating' } as any, t))
      .toBe('chatPane.busyNoProgress')
  })

  it('shows waiting context when approval buttons are not available yet', () => {
    expect(buildBusyChatInputStatusMessage({ status: 'waiting_approval', modalButtons: undefined } as any, t))
      .toBe('chatPane.busyWaitingApproval')
  })
})
