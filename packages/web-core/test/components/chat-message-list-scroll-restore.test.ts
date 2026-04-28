import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildChatScrollFingerprint,
  getChatScrollJumpButtonState,
  isChatScrollSnapshotScrolledUp,
  shouldAutoScrollAfterChatContentChange,
  shouldAutoScrollOnChatResize,
  shouldAutoScrollOnChatVisibilityChange,
  shouldOpenBottomAutoScrollWindowOnInitialChatMount,
  shouldRestoreChatScrollOnVisibilityChange,
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

  it('uses a daemon-provided last message hash without walking message content', () => {
    const hostileContent = {
      toJSON() { throw new Error('content should not be stringified') },
      toString() { throw new Error('content should not be coerced') },
    }

    expect(buildChatScrollFingerprint([
      { role: 'assistant', id: 'msg-1', content: hostileContent } as any,
    ], 'daemon-hash-1')).toBe('1:daemon-hash-1')
  })

  it('preserves scroll when a hidden chat pane becomes visible again', () => {
    expect(shouldAutoScrollOnChatVisibilityChange(false, true)).toBe(false)
    expect(shouldAutoScrollOnChatVisibilityChange(true, true)).toBe(false)
    expect(shouldAutoScrollOnChatVisibilityChange(true, false)).toBe(false)
  })

  it('restores a saved tab scroll snapshot when a hidden pane becomes visible again', () => {
    const snapshot = {
      top: 2200,
      fromBottom: 5800,
      messageFingerprint: '80:same-signature',
    }

    expect(shouldRestoreChatScrollOnVisibilityChange(false, true, snapshot, '80:same-signature')).toBe(true)
    expect(shouldRestoreChatScrollOnVisibilityChange(true, true, snapshot, '80:same-signature')).toBe(false)
    expect(shouldRestoreChatScrollOnVisibilityChange(false, false, snapshot, '80:same-signature')).toBe(false)
    expect(shouldRestoreChatScrollOnVisibilityChange(false, true, snapshot, '80:new-signature')).toBe(false)
  })

  it('does not open an initial bottom-follow window when restoring a scrolled-up tab snapshot', () => {
    const scrolledUpSnapshot = {
      top: 2200,
      fromBottom: 5800,
      messageFingerprint: '80:same-signature',
    }
    const bottomSnapshot = {
      top: 8000,
      fromBottom: 0,
      messageFingerprint: '80:same-signature',
    }

    expect(shouldOpenBottomAutoScrollWindowOnInitialChatMount(scrolledUpSnapshot, '80:same-signature')).toBe(false)
    expect(shouldOpenBottomAutoScrollWindowOnInitialChatMount(bottomSnapshot, '80:same-signature')).toBe(true)
    expect(shouldOpenBottomAutoScrollWindowOnInitialChatMount(null, '80:same-signature')).toBe(true)
    expect(shouldOpenBottomAutoScrollWindowOnInitialChatMount(scrolledUpSnapshot, '80:new-signature')).toBe(true)
  })

  it('does not let tab cleanup overwrite the last visible scroll snapshot from hidden layout state', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/components/ChatMessageList.tsx'), 'utf8')

    expect(source).toContain('latestScrollSnapshotRef')
    expect(source).toContain('isVisibleRef.current')
    expect(source).toContain('const latestSnapshot = latestScrollSnapshotRef.current')
    expect(source).toContain('if (wasVisible && !isVisible)')
    expect(source).toContain('saveScrollSnapshot();')
    const hiddenTransitionIndex = source.indexOf('if (wasVisible && !isVisible)')
    expect(source.slice(hiddenTransitionIndex, hiddenTransitionIndex + 500)).toContain('isVisibleRef.current = isVisible')
    expect(source).not.toContain('useEffect(() => () => {\n        saveScrollSnapshot();')
  })

  it('does not scroll to the bottom for generation/status-only updates', () => {
    expect(shouldAutoScrollAfterChatContentChange({
      hasSelection: false,
      userScrolledUp: false,
      hasChatContentChanged: false,
      isNewMessage: false,
      isNearBottomAfterUpdate: true,
    })).toBe(false)
  })

  it('keeps following the bottom for streaming content even if the post-update distance is no longer near bottom', () => {
    expect(shouldAutoScrollAfterChatContentChange({
      hasSelection: false,
      userScrolledUp: false,
      hasChatContentChanged: true,
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

  it('shows explicit jump buttons instead of deriving an automatic edge-snap target from wheel distance', () => {
    expect(getChatScrollJumpButtonState({
      scrollTop: 0,
      scrollHeight: 2400,
      clientHeight: 600,
      bottomThresholdPx: 200,
      topThresholdPx: 80,
    })).toEqual({ showTop: false, showBottom: true })

    expect(getChatScrollJumpButtonState({
      scrollTop: 900,
      scrollHeight: 2400,
      clientHeight: 600,
      bottomThresholdPx: 200,
      topThresholdPx: 80,
    })).toEqual({ showTop: true, showBottom: true })

    expect(getChatScrollJumpButtonState({
      scrollTop: 1800,
      scrollHeight: 2400,
      clientHeight: 600,
      bottomThresholdPx: 200,
      topThresholdPx: 80,
    })).toEqual({ showTop: true, showBottom: false })
  })

  it('hides jump buttons when the transcript is not scrollable', () => {
    expect(getChatScrollJumpButtonState({
      scrollTop: 0,
      scrollHeight: 600,
      clientHeight: 600,
    })).toEqual({ showTop: false, showBottom: false })
  })
})
