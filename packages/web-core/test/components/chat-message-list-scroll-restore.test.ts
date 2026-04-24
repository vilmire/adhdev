import { describe, expect, it } from 'vitest'
import { buildChatScrollFingerprint, shouldRestoreChatScrollSnapshot, shouldAutoScrollOnChatVisibilityChange } from '../../src/components/ChatMessageList'

describe('ChatMessageList scroll snapshot restore', () => {
  it('does not restore an old scroll snapshot when newer chat content arrived for the same context', () => {
    expect(shouldRestoreChatScrollSnapshot(
      {
        top: 120,
        fromBottom: 480,
        messageFingerprint: '40:old-signature',
      },
      '40:new-signature',
    )).toBe(false)
  })

  it('restores the snapshot when the chat fingerprint is unchanged', () => {
    expect(shouldRestoreChatScrollSnapshot(
      {
        top: 120,
        fromBottom: 480,
        messageFingerprint: '40:same-signature',
      },
      '40:same-signature',
    )).toBe(true)
  })

  it('builds different fingerprints when the last message text changes but its length stays the same', () => {
    const first = buildChatScrollFingerprint([
      { role: 'assistant', id: 'msg-1', content: 'AAAAA11111' } as any,
    ])
    const second = buildChatScrollFingerprint([
      { role: 'assistant', id: 'msg-1', content: 'BBBBB22222' } as any,
    ])

    expect(first).not.toBe(second)
  })

  it('requests a bottom scroll when a hidden chat pane becomes visible again', () => {
    expect(shouldAutoScrollOnChatVisibilityChange(false, true)).toBe(true)
    expect(shouldAutoScrollOnChatVisibilityChange(true, true)).toBe(false)
    expect(shouldAutoScrollOnChatVisibilityChange(true, false)).toBe(false)
  })
})
