export interface DesktopAutoReadLiveState {
  unread?: boolean
  inboxBucket?: string
  lastUpdated?: number
  completionMarker?: string
  seenCompletionMarker?: string
}

export interface DesktopAutoReadPlanInput {
  tabKey: string
  historySessionId: string
  lastMessageHash: string
  lastMessageAt: number
  timestamp: number
  liveState: DesktopAutoReadLiveState
}

export interface DesktopAutoReadPlan {
  shouldMarkSeen: boolean
  autoReadKey: string
  completionMarker: string
  readAt: number
}

export interface DesktopAutoReadScheduleDecisionInput {
  autoReadKey: string
  shouldMarkSeen: boolean
  completedKey?: string | null
  pendingKey?: string | null
}

export interface DesktopAutoReadScheduleDecision {
  shouldSchedule: boolean
  shouldCancelPending: boolean
  nextPendingKey: string | null
}

export function getDesktopAutoReadScheduleDecision(
  input: DesktopAutoReadScheduleDecisionInput,
): DesktopAutoReadScheduleDecision {
  const completedKey = input.completedKey || null
  const pendingKey = input.pendingKey || null

  if (!input.shouldMarkSeen) {
    return {
      shouldSchedule: false,
      shouldCancelPending: !!pendingKey,
      nextPendingKey: null,
    }
  }

  if (completedKey === input.autoReadKey) {
    return {
      shouldSchedule: false,
      shouldCancelPending: pendingKey !== null && pendingKey !== input.autoReadKey,
      nextPendingKey: pendingKey === input.autoReadKey ? pendingKey : null,
    }
  }

  if (pendingKey === input.autoReadKey) {
    return {
      shouldSchedule: false,
      shouldCancelPending: false,
      nextPendingKey: pendingKey,
    }
  }

  return {
    shouldSchedule: true,
    shouldCancelPending: pendingKey !== null && pendingKey !== input.autoReadKey,
    nextPendingKey: input.autoReadKey,
  }
}

export function getDesktopAutoReadPlan(input: DesktopAutoReadPlanInput): DesktopAutoReadPlan {
  const completionMarker = String(input.liveState.completionMarker || '')
  const seenCompletionMarker = String(input.liveState.seenCompletionMarker || '')
  const inboxBucket = String(input.liveState.inboxBucket || 'idle')
  const unread = !!input.liveState.unread
  const autoReadKey = [
    input.tabKey,
    input.historySessionId || '',
    completionMarker,
    seenCompletionMarker,
    inboxBucket,
    unread ? '1' : '0',
  ].join(':')

  const shouldMarkSeen = !!(
    inboxBucket === 'task_complete'
    && unread
    && completionMarker
    && completionMarker !== seenCompletionMarker
  )

  return {
    shouldMarkSeen,
    autoReadKey,
    completionMarker,
    readAt: Math.max(Date.now(), input.timestamp || 0, input.liveState.lastUpdated || 0),
  }
}
