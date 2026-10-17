import { describe, expect, it } from 'vitest'
import { buildBusyChatInputStatusMessage, buildOwnerAttentionSendBlock } from '../../../src/components/dashboard/ChatPane'

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

describe('ChatPane owner-attention send block', () => {
  it('blocks the chat composer while the session is parked for owner attention', () => {
    expect(buildOwnerAttentionSendBlock({ ownerAttention: { stateId: 'consent_banner', message: 'Help improve Grok?' } } as any, t))
      .toBe('approval.ownerAttentionPlaceholder')
  })

  it('does not block once the park clears', () => {
    expect(buildOwnerAttentionSendBlock({ ownerAttention: null } as any, t)).toBeNull()
    expect(buildOwnerAttentionSendBlock(undefined, t)).toBeNull()
  })
})
