import { describe, expect, it } from 'vitest'
import {
  classifyHotChatSessionsForSubscriptionFlush,
  detectNewlySettledCompletedSessions,
  DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS,
} from '../../src/status/chat-tail-hot-sessions.js'

describe('classifyHotChatSessionsForSubscriptionFlush', () => {
  it('treats actively generating sessions as hot', () => {
    const result = classifyHotChatSessionsForSubscriptionFlush([
      { id: 'session-active', status: 'generating', lastMessageAt: 0 },
    ], new Set(), { now: 1_000 })

    expect(Array.from(result.active)).toEqual(['session-active'])
    expect(Array.from(result.finalizing)).toEqual([])
  })

  it('keeps recently completed unread sessions hot long enough to flush the completion tail', () => {
    const now = 10_000
    const result = classifyHotChatSessionsForSubscriptionFlush([
      {
        id: 'session-complete',
        status: 'idle',
        unread: true,
        inboxBucket: 'task_complete',
        lastMessageAt: now - (DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS - 500),
      },
    ], new Set(), { now })

    expect(Array.from(result.active)).toEqual(['session-complete'])
    expect(Array.from(result.finalizing)).toEqual([])
  })

  it('does not keep recently updated idle sessions hot after the completion marker has already been seen', () => {
    const now = 15_000
    const result = classifyHotChatSessionsForSubscriptionFlush([
      {
        id: 'session-seen-complete',
        status: 'idle',
        unread: false,
        inboxBucket: 'idle',
        lastMessageAt: now - 500,
      },
    ], new Set(), { now })

    expect(Array.from(result.active)).toEqual([])
    expect(Array.from(result.finalizing)).toEqual([])
  })

  it('does not keep stale idle sessions hot forever', () => {
    const now = 20_000
    const result = classifyHotChatSessionsForSubscriptionFlush([
      {
        id: 'session-stale',
        status: 'idle',
        lastMessageAt: now - (DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS + 1_000),
      },
    ], new Set(), { now })

    expect(Array.from(result.active)).toEqual([])
    expect(Array.from(result.finalizing)).toEqual([])
  })

  it('treats subscribed sessions with recent PTY output as hot even when parsed status is idle', () => {
    const now = 25_000
    const result = classifyHotChatSessionsForSubscriptionFlush([
      {
        id: 'session-output-active',
        status: 'idle',
        unread: false,
        inboxBucket: 'idle',
        lastMessageAt: 0,
      },
    ], new Set(), {
      now,
      activeSessionIds: new Set(['session-output-active']),
    })

    expect(Array.from(result.active)).toEqual(['session-output-active'])
    expect(Array.from(result.finalizing)).toEqual([])
  })

  it('does not revive stopped recovery snapshots via explicit output activity', () => {
    const now = 26_000
    const result = classifyHotChatSessionsForSubscriptionFlush([
      {
        id: 'session-output-recovery',
        status: 'idle',
        runtimeLifecycle: 'stopped',
        runtimeSurfaceKind: 'recovery_snapshot',
        runtimeRestoredFromStorage: true,
      },
    ], new Set(['session-output-recovery']), {
      now,
      activeSessionIds: new Set(['session-output-recovery']),
    })

    expect(Array.from(result.active)).toEqual([])
    expect(Array.from(result.finalizing)).toEqual([])
  })

  it('marks previous hot sessions as finalizing once they fall out of the grace window', () => {
    const now = 30_000
    const result = classifyHotChatSessionsForSubscriptionFlush([
      {
        id: 'session-finalizing',
        status: 'idle',
        lastMessageAt: now - (DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS + 1_000),
      },
    ], new Set(['session-finalizing']), { now })

    expect(Array.from(result.active)).toEqual([])
    expect(Array.from(result.finalizing)).toEqual(['session-finalizing'])
  })

  it('does not classify stopped recovery snapshots as hot even when they were updated recently', () => {
    const now = 40_000
    const result = classifyHotChatSessionsForSubscriptionFlush([
      {
        id: 'session-recovery-snapshot',
        status: 'idle',
        lastMessageAt: now - 500,
        runtimeLifecycle: 'stopped',
        runtimeSurfaceKind: 'recovery_snapshot',
        runtimeRestoredFromStorage: true,
        runtimeRecoveryState: 'orphan_snapshot',
      },
    ], new Set(), { now })

    expect(Array.from(result.active)).toEqual([])
    expect(Array.from(result.finalizing)).toEqual([])
  })

  it('does not keep previously hot stopped recovery snapshots in the finalizing set', () => {
    const now = 50_000
    const result = classifyHotChatSessionsForSubscriptionFlush([
      {
        id: 'session-recovery-finalizing',
        status: 'idle',
        lastMessageAt: now - 500,
        runtimeLifecycle: 'stopped',
        runtimeSurfaceKind: 'recovery_snapshot',
        runtimeRestoredFromStorage: true,
        runtimeRecoveryState: 'snapshot',
      },
    ], new Set(['session-recovery-finalizing']), { now })

    expect(Array.from(result.active)).toEqual([])
    expect(Array.from(result.finalizing)).toEqual([])
  })

  it('still keeps explicitly recovered live runtimes hot during the grace window', () => {
    const now = 60_000
    const result = classifyHotChatSessionsForSubscriptionFlush([
      {
        id: 'session-recovered-live',
        status: 'idle',
        lastMessageAt: now - 500,
        runtimeLifecycle: 'running',
        runtimeSurfaceKind: 'live_runtime',
        runtimeRestoredFromStorage: true,
        runtimeRecoveryState: 'orphan_snapshot',
      },
    ], new Set(), { now })

    expect(Array.from(result.active)).toEqual(['session-recovered-live'])
    expect(Array.from(result.finalizing)).toEqual([])
  })

  it('does not keep ordinary recently updated idle sessions hot unless they are still unread', () => {
    const now = 70_000
    const result = classifyHotChatSessionsForSubscriptionFlush([
      {
        id: 'session-ordinary-stopped',
        status: 'idle',
        unread: false,
        inboxBucket: 'idle',
        lastMessageAt: now - 500,
        runtimeLifecycle: 'stopped',
      },
      {
        id: 'session-inactive-record',
        status: 'idle',
        unread: false,
        inboxBucket: 'idle',
        lastMessageAt: now - 500,
        runtimeLifecycle: 'stopped',
        runtimeSurfaceKind: 'inactive_record',
      },
    ], new Set(), { now })

    expect(Array.from(result.active)).toEqual([])
    expect(Array.from(result.finalizing)).toEqual([])
  })

  describe('guaranteed delivery of a slow-finalizing completion tail', () => {
    it('keeps a task_complete session hot for delivery even when its tail finalized long after the 8s window', () => {
      const now = 3_000_000
      const result = classifyHotChatSessionsForSubscriptionFlush([
        {
          id: 'session-late-complete',
          status: 'idle',
          unread: true,
          inboxBucket: 'task_complete',
          // 46 minutes ago — far outside DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS.
          lastMessageAt: now - 46 * 60_000,
        },
      ], new Set(), { now, deliveredCompletionTailAt: new Map() })

      expect(Array.from(result.active)).toEqual(['session-late-complete'])
      expect(Array.from(result.guaranteedDelivery)).toEqual(['session-late-complete'])
    })

    it('keeps a stale unread session hot for delivery via the guaranteed-delivery path', () => {
      const now = 100_000
      const result = classifyHotChatSessionsForSubscriptionFlush([
        {
          id: 'session-unread-late',
          status: 'idle',
          unread: true,
          inboxBucket: 'idle',
          lastMessageAt: now - 60_000,
        },
      ], new Set(), { now, deliveredCompletionTailAt: new Map() })

      expect(result.active.has('session-unread-late')).toBe(true)
      expect(result.guaranteedDelivery.has('session-unread-late')).toBe(true)
    })

    it('does NOT re-push a completion tail that has already been delivered (bounded, no thrash)', () => {
      const now = 3_000_000
      const lastMessageAt = now - 46 * 60_000
      const delivered = new Map<string, number>([['session-delivered', lastMessageAt]])
      const result = classifyHotChatSessionsForSubscriptionFlush([
        {
          id: 'session-delivered',
          status: 'idle',
          unread: true,
          inboxBucket: 'task_complete',
          lastMessageAt,
        },
      ], new Set(), { now, deliveredCompletionTailAt: delivered })

      expect(result.active.has('session-delivered')).toBe(false)
      expect(Array.from(result.guaranteedDelivery)).toEqual([])
    })

    it('re-arms delivery when a newer turn produces a newer tail than the delivered watermark', () => {
      const now = 3_000_000
      const delivered = new Map<string, number>([['session-newturn', now - 200_000]])
      const result = classifyHotChatSessionsForSubscriptionFlush([
        {
          id: 'session-newturn',
          status: 'idle',
          unread: true,
          inboxBucket: 'task_complete',
          // Newer than the delivered watermark → a fresh completion to deliver.
          lastMessageAt: now - 60_000,
        },
      ], new Set(), { now, deliveredCompletionTailAt: delivered })

      expect(result.active.has('session-newturn')).toBe(true)
      expect(result.guaranteedDelivery.has('session-newturn')).toBe(true)
    })

    it('does not enter the guaranteed-delivery path at all when no delivered map is provided (preserves recency-only callers)', () => {
      const now = 3_000_000
      const result = classifyHotChatSessionsForSubscriptionFlush([
        {
          id: 'session-no-optin',
          status: 'idle',
          unread: true,
          inboxBucket: 'task_complete',
          lastMessageAt: now - 46 * 60_000,
        },
      ], new Set(), { now })

      expect(result.active.has('session-no-optin')).toBe(false)
      expect(Array.from(result.guaranteedDelivery)).toEqual([])
    })

    it('does not treat an active in-window session as guaranteed-delivery (it stays hot the normal way)', () => {
      const now = 10_000
      const result = classifyHotChatSessionsForSubscriptionFlush([
        {
          id: 'session-in-window',
          status: 'idle',
          unread: true,
          inboxBucket: 'task_complete',
          lastMessageAt: now - (DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS - 500),
        },
      ], new Set(), { now, deliveredCompletionTailAt: new Map() })

      expect(result.active.has('session-in-window')).toBe(true)
      // In-window sessions are handled by the recency path, not guaranteed-delivery.
      expect(result.guaranteedDelivery.has('session-in-window')).toBe(false)
    })

    it('does not revive a stale idle SEEN session via the guaranteed-delivery path', () => {
      const now = 3_000_000
      const result = classifyHotChatSessionsForSubscriptionFlush([
        {
          id: 'session-seen-stale',
          status: 'idle',
          unread: false,
          inboxBucket: 'idle',
          lastMessageAt: now - 46 * 60_000,
        },
      ], new Set(), { now, deliveredCompletionTailAt: new Map() })

      expect(result.active.has('session-seen-stale')).toBe(false)
      expect(Array.from(result.guaranteedDelivery)).toEqual([])
    })
  })

  it('excludes restored stopped sessions even when surface kind is missing', () => {
    const now = 80_000
    const result = classifyHotChatSessionsForSubscriptionFlush([
      {
        id: 'session-restored-stopped',
        status: 'idle',
        lastMessageAt: now - 500,
        runtimeLifecycle: 'stopped',
        runtimeRestoredFromStorage: true,
      },
      {
        id: 'session-auto-resumed-stopped',
        status: 'idle',
        lastMessageAt: now - 500,
        runtimeLifecycle: 'stopped',
        runtimeRestoredFromStorage: true,
        runtimeRecoveryState: 'auto_resumed',
      },
    ], new Set(['session-restored-stopped', 'session-auto-resumed-stopped']), { now })

    expect(Array.from(result.active)).toEqual([])
    expect(Array.from(result.finalizing)).toEqual([])
  })
})

describe('detectNewlySettledCompletedSessions', () => {
  it('flags a session that flipped generating→idle with a completion bucket', () => {
    const prev = new Map<string, string>([['s1', 'generating']])
    const { settled, nextStatus } = detectNewlySettledCompletedSessions([
      { id: 's1', status: 'idle', unread: true, inboxBucket: 'task_complete' },
    ], prev)

    expect(Array.from(settled)).toEqual(['s1'])
    expect(nextStatus.get('s1')).toBe('idle')
  })

  it('does not flag a session that was already idle (no active→settled transition)', () => {
    const prev = new Map<string, string>([['s1', 'idle']])
    const { settled } = detectNewlySettledCompletedSessions([
      { id: 's1', status: 'idle', unread: true, inboxBucket: 'task_complete' },
    ], prev)

    expect(Array.from(settled)).toEqual([])
  })

  it('does not flag a session that settled but is not completed-unseen', () => {
    const prev = new Map<string, string>([['s1', 'generating']])
    const { settled } = detectNewlySettledCompletedSessions([
      { id: 's1', status: 'idle', unread: false, inboxBucket: 'idle' },
    ], prev)

    expect(Array.from(settled)).toEqual([])
  })

  it('does not flag a session that is still generating', () => {
    const prev = new Map<string, string>([['s1', 'generating']])
    const { settled } = detectNewlySettledCompletedSessions([
      { id: 's1', status: 'generating', unread: true, inboxBucket: 'working' },
    ], prev)

    expect(Array.from(settled)).toEqual([])
  })

  it('drops status records for sessions no longer present in the snapshot', () => {
    const prev = new Map<string, string>([['gone', 'generating'], ['s1', 'generating']])
    const { nextStatus } = detectNewlySettledCompletedSessions([
      { id: 's1', status: 'idle', unread: true, inboxBucket: 'task_complete' },
    ], prev)

    expect(nextStatus.has('gone')).toBe(false)
    expect(nextStatus.has('s1')).toBe(true)
  })

  it('flags via unread even when inboxBucket is not task_complete', () => {
    const prev = new Map<string, string>([['s1', 'waiting_approval']])
    const { settled } = detectNewlySettledCompletedSessions([
      { id: 's1', status: 'idle', unread: true, inboxBucket: 'idle' },
    ], prev)

    expect(Array.from(settled)).toEqual(['s1'])
  })
})