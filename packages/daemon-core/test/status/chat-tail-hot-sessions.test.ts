import { describe, expect, it } from 'vitest'
import {
  classifyHotChatSessionsForSubscriptionFlush,
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