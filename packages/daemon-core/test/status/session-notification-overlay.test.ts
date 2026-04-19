import { describe, expect, it } from 'vitest'
import {
  applySessionNotificationOverlay,
  getSessionCurrentNotificationId,
} from '../../src/status/snapshot.js'

describe('session notification overlay', () => {
  it('builds a stable task-complete notification id from provider session and message fingerprint', () => {
    const id = getSessionCurrentNotificationId({
      id: 'runtime-a',
      providerSessionId: 'provider-1',
      status: 'idle',
      unread: true,
      inboxBucket: 'task_complete',
      lastMessageHash: 'hash-1',
      lastMessageAt: 100,
      lastUpdated: 100,
    } as any)

    expect(id).toBe('task_complete|provider-1|hash-1|100')
  })

  it('suppresses the current notification when the dismissal matches', () => {
    const next = applySessionNotificationOverlay({
      id: 'runtime-a',
      providerSessionId: 'provider-1',
      status: 'idle',
      unread: true,
      inboxBucket: 'task_complete',
      lastMessageHash: 'hash-1',
      lastMessageAt: 100,
      lastUpdated: 100,
    } as any, {
      dismissedNotificationId: 'task_complete|provider-1|hash-1|100',
    })

    expect(next.unread).toBe(false)
    expect(next.inboxBucket).toBe('idle')
  })

  it('forces the current notification back to unread when the unread override matches', () => {
    const next = applySessionNotificationOverlay({
      id: 'runtime-a',
      providerSessionId: 'provider-1',
      status: 'idle',
      unread: false,
      inboxBucket: 'idle',
      lastMessageHash: 'hash-1',
      lastMessageAt: 100,
      lastUpdated: 100,
    } as any, {
      unreadNotificationId: 'task_complete|provider-1|hash-1|100',
    })

    expect(next.unread).toBe(true)
    expect(next.inboxBucket).toBe('task_complete')
  })

  it('keeps newer notifications visible after an older dismissal', () => {
    const next = applySessionNotificationOverlay({
      id: 'runtime-a',
      providerSessionId: 'provider-1',
      status: 'idle',
      unread: true,
      inboxBucket: 'task_complete',
      lastMessageHash: 'hash-2',
      lastMessageAt: 200,
      lastUpdated: 200,
    } as any, {
      dismissedNotificationId: 'task_complete|provider-1|hash-1|100',
      unreadNotificationId: 'task_complete|provider-1|hash-1|100',
    })

    expect(next.unread).toBe(true)
    expect(next.inboxBucket).toBe('task_complete')
  })
})
