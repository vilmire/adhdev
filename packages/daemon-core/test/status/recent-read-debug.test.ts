import { describe, expect, it } from 'vitest'
import { shouldEmitRecentReadDebugLog } from '../../src/status/snapshot.js'

describe('RecentRead debug logging', () => {
  it('suppresses repeated identical idle snapshots for the same session', () => {
    const cache = new Map<string, string>()
    const snapshot = {
      sessionId: 'session-1',
      providerType: 'codex',
      status: 'idle',
      inboxBucket: 'idle',
      unread: false,
      lastSeenAt: 100,
      completionMarker: 'turn:1',
      seenCompletionMarker: 'turn:1',
      lastUpdated: 200,
      lastUsedAt: 150,
      lastRole: 'assistant',
      messageUpdatedAt: 150,
    } as const

    expect(shouldEmitRecentReadDebugLog(cache, snapshot)).toBe(true)
    expect(shouldEmitRecentReadDebugLog(cache, snapshot)).toBe(false)
  })

  it('emits again when the unread/completion state changes', () => {
    const cache = new Map<string, string>()

    expect(shouldEmitRecentReadDebugLog(cache, {
      sessionId: 'session-1',
      providerType: 'codex',
      status: 'idle',
      inboxBucket: 'idle',
      unread: false,
      lastSeenAt: 100,
      completionMarker: 'turn:1',
      seenCompletionMarker: 'turn:1',
      lastUpdated: 200,
      lastUsedAt: 150,
      lastRole: 'assistant',
      messageUpdatedAt: 150,
    })).toBe(true)

    expect(shouldEmitRecentReadDebugLog(cache, {
      sessionId: 'session-1',
      providerType: 'codex',
      status: 'idle',
      inboxBucket: 'needs_reply',
      unread: true,
      lastSeenAt: 100,
      completionMarker: 'turn:2',
      seenCompletionMarker: 'turn:1',
      lastUpdated: 250,
      lastUsedAt: 150,
      lastRole: 'assistant',
      messageUpdatedAt: 250,
    })).toBe(true)
  })
})