import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import type { DashboardNotificationLiveState, DashboardNotificationRecord } from '../utils/dashboard-notifications'
import {
  MAX_DASHBOARD_NOTIFICATIONS,
  buildDashboardNotificationCandidates,
  buildDashboardNotificationStateBySessionId,
  deleteDashboardNotification,
  getDashboardNotificationUnreadCount,
  markDashboardNotificationRead,
  markDashboardNotificationTargetRead,
  markDashboardNotificationUnread,
  readDashboardNotifications,
  reduceDashboardNotifications,
  writeDashboardNotifications,
} from '../utils/dashboard-notifications'

function areNotificationListsEqual(left: DashboardNotificationRecord[], right: DashboardNotificationRecord[]) {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((record, index) => {
    const other = right[index]
    if (!other) return false
    return record.id === other.id
      && record.updatedAt === other.updatedAt
      && record.createdAt === other.createdAt
      && record.readAt === other.readAt
      && record.preview === other.preview
      && record.title === other.title
      && record.deletedAt === other.deletedAt
  })
}

export function useDashboardNotifications(args: {
  conversations: ActiveConversation[]
  liveSessionInboxState: Map<string, DashboardNotificationLiveState>
  maxItems?: number
}) {
  const { conversations, liveSessionInboxState, maxItems = MAX_DASHBOARD_NOTIFICATIONS } = args
  const candidates = useMemo(
    () => buildDashboardNotificationCandidates(conversations, liveSessionInboxState),
    [conversations, liveSessionInboxState],
  )
  const [notifications, setNotifications] = useState<DashboardNotificationRecord[]>(() => readDashboardNotifications())

  useEffect(() => {
    setNotifications(previous => {
      const next = reduceDashboardNotifications(previous, candidates, maxItems)
      return areNotificationListsEqual(previous, next) ? previous : next
    })
  }, [candidates, maxItems])

  useEffect(() => {
    writeDashboardNotifications(notifications)
  }, [notifications])

  const unreadCount = useMemo(
    () => getDashboardNotificationUnreadCount(notifications),
    [notifications],
  )
  const notificationStateBySessionId = useMemo(
    () => buildDashboardNotificationStateBySessionId(notifications),
    [notifications],
  )

  const markRead = useCallback((id: string, readAt?: number) => {
    setNotifications(previous => markDashboardNotificationRead(previous, id, readAt))
  }, [])

  const markUnread = useCallback((id: string) => {
    setNotifications(previous => markDashboardNotificationUnread(previous, id))
  }, [])

  const markTargetRead = useCallback((target: { sessionId?: string; providerSessionId?: string; tabKey?: string }, readAt?: number) => {
    setNotifications(previous => markDashboardNotificationTargetRead(previous, target, readAt))
  }, [])

  const remove = useCallback((id: string) => {
    setNotifications(previous => deleteDashboardNotification(previous, id))
  }, [])

  return {
    notifications,
    unreadCount,
    notificationStateBySessionId,
    markRead,
    markUnread,
    markTargetRead,
    deleteNotification: remove,
  }
}
