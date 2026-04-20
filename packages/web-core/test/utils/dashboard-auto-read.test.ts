import { describe, expect, it } from 'vitest'
import {
  getDesktopAutoReadPlan,
  getDesktopAutoReadScheduleDecision,
} from '../../src/utils/dashboard-auto-read'

describe('dashboard auto-read plan', () => {
  it('only auto-marks task_complete conversations when daemon completion marker is still unseen', () => {
    const plan = getDesktopAutoReadPlan({
      tabKey: 'tab-1',
      historySessionId: 'hist-1',
      lastMessageHash: 'hash-1',
      lastMessageAt: 100,
      timestamp: 120,
      liveState: {
        unread: true,
        inboxBucket: 'task_complete',
        lastUpdated: 130,
        completionMarker: 'done-1',
        seenCompletionMarker: '',
      },
    })

    expect(plan.shouldMarkSeen).toBe(true)
    expect(plan.autoReadKey).toBe('tab-1:hist-1:done-1::task_complete:1')
    expect(plan.readAt).toBeGreaterThanOrEqual(130)
  })

  it('skips auto-read once the daemon reports the completion marker as seen', () => {
    const plan = getDesktopAutoReadPlan({
      tabKey: 'tab-1',
      historySessionId: 'hist-1',
      lastMessageHash: 'hash-1',
      lastMessageAt: 100,
      timestamp: 120,
      liveState: {
        unread: false,
        inboxBucket: 'idle',
        lastUpdated: 131,
        completionMarker: 'done-1',
        seenCompletionMarker: 'done-1',
      },
    })

    expect(plan.shouldMarkSeen).toBe(false)
    expect(plan.autoReadKey).toBe('tab-1:hist-1:done-1:done-1:idle:0')
    expect(plan.readAt).toBeGreaterThanOrEqual(131)
  })

  it('does not auto-mark generating or needs-attention sessions', () => {
    expect(getDesktopAutoReadPlan({
      tabKey: 'tab-2',
      historySessionId: 'hist-2',
      lastMessageHash: '',
      lastMessageAt: 0,
      timestamp: 200,
      liveState: {
        unread: false,
        inboxBucket: 'working',
        lastUpdated: 210,
        completionMarker: '',
        seenCompletionMarker: '',
      },
    }).shouldMarkSeen).toBe(false)

    expect(getDesktopAutoReadPlan({
      tabKey: 'tab-3',
      historySessionId: 'hist-3',
      lastMessageHash: '',
      lastMessageAt: 0,
      timestamp: 200,
      liveState: {
        unread: false,
        inboxBucket: 'needs_attention',
        lastUpdated: 210,
        completionMarker: '',
        seenCompletionMarker: '',
      },
    }).shouldMarkSeen).toBe(false)
  })

  it('keeps an existing pending auto-read timer for the same unread completion key across rerenders', () => {
    expect(getDesktopAutoReadScheduleDecision({
      autoReadKey: 'tab-1:hist-1:done-1::task_complete:1',
      shouldMarkSeen: true,
      completedKey: null,
      pendingKey: 'tab-1:hist-1:done-1::task_complete:1',
    })).toEqual({
      nextPendingKey: 'tab-1:hist-1:done-1::task_complete:1',
      shouldCancelPending: false,
      shouldSchedule: false,
    })
  })

  it('cancels an old pending timer and schedules a new one when the unread completion key changes', () => {
    expect(getDesktopAutoReadScheduleDecision({
      autoReadKey: 'tab-1:hist-1:done-2::task_complete:1',
      shouldMarkSeen: true,
      completedKey: null,
      pendingKey: 'tab-1:hist-1:done-1::task_complete:1',
    })).toEqual({
      nextPendingKey: 'tab-1:hist-1:done-2::task_complete:1',
      shouldCancelPending: true,
      shouldSchedule: true,
    })
  })
})
