import { describe, expect, it } from 'vitest'
import {
  buildChatScrollFingerprint,
  isChatScrollSnapshotScrolledUp,
  shouldAutoScrollAfterChatContentChange,
  shouldAutoScrollOnChatResize,
  shouldAutoScrollOnChatVisibilityChange,
  shouldRestoreChatScrollSnapshot,
} from '../../src/components/ChatMessageList'

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

  it('keeps following the bottom for streaming content even if the post-update distance is no longer near bottom', () => {
    expect(shouldAutoScrollAfterChatContentChange({
      hasSelection: false,
      userScrolledUp: false,
      isNewMessage: false,
      isNearBottomAfterUpdate: false,
    })).toBe(true)
  })

  it('does not force streaming content to the bottom after restoring a deliberately scrolled-up snapshot', () => {
    const scrolledUpSnapshot = {
      top: 100,
      fromBottom: 420,
      messageFingerprint: '40:same-signature',
    }
    expect(isChatScrollSnapshotScrolledUp(scrolledUpSnapshot)).toBe(true)
    expect(shouldAutoScrollAfterChatContentChange({
      hasSelection: false,
      userScrolledUp: isChatScrollSnapshotScrolledUp(scrolledUpSnapshot),
      isNewMessage: false,
      isNearBottomAfterUpdate: false,
    })).toBe(false)
  })

  it('keeps a bottom-following chat at the bottom when split or pane resize changes the layout', () => {
    expect(shouldAutoScrollOnChatResize({
      hasSelection: false,
      userScrolledUp: false,
      contextAutoScrollActive: false,
    })).toBe(true)
    expect(shouldAutoScrollOnChatResize({
      hasSelection: false,
      userScrolledUp: true,
      contextAutoScrollActive: false,
    })).toBe(false)
    expect(shouldAutoScrollOnChatResize({
      hasSelection: false,
      userScrolledUp: true,
      contextAutoScrollActive: true,
    })).toBe(true)
  })
})
