import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import type {
  DashboardNotificationLiveState,
  DashboardNotificationOverlayRecord,
} from '../utils/dashboard-notifications'
import {
  MAX_DASHBOARD_NOTIFICATIONS,
  applyDashboardNotificationOverlays,
  buildDashboardNotificationCandidates,
  buildDashboardNotificationOverlayById,
  buildDashboardNotificationStateBySessionId,
  deleteDashboardNotificationOverlay,
  getDashboardNotificationUnreadCount,
  markDashboardNotificationOverlayRead,
  markDashboardNotificationTargetOverlayRead,
  markDashboardNotificationOverlayUnread,
  readDashboardNotificationOverlays,
  reduceDashboardNotificationOverlays,
  writeDashboardNotificationOverlays,
} from '../utils/dashboard-notifications'

function areNotificationOverlayListsEqual(left: DashboardNotificationOverlayRecord[], right: DashboardNotificationOverlayRecord[]) {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((record, index) => {
    const other = right[index]
    if (!other) return false
    return record.id === other.id
      && record.readAt === other.readAt
      && record.deletedAt === other.deletedAt
      && record.forceUnread === other.forceUnread
  })
}

/**
 * Notification state policy:
 * - daemon/live conversation state defines which inbox candidates currently exist
 * - browser persistence stores overlay intent only (`readAt`, `deletedAt`, `forceUnread`)
 * - local overlay is intentionally thin and should not become an alternate source of truth
 */
export function useDashboardNotifications(args: {
  conversations: ActiveConversation[]
  liveSessionInboxState: Map<string, DashboardNotificationLiveState>
  maxItems?: number
}) {
  const { conversations, liveSessionInboxState, maxItems = MAX_DASHBOARD_NOTIFICATIONS } = args
  const [notificationOverlays, setNotificationOverlays] = useState<DashboardNotificationOverlayRecord[]>(() => readDashboardNotificationOverlays())
  const overlayById = useMemo(
    () => buildDashboardNotificationOverlayById(notificationOverlays),
    [notificationOverlays],
  )
  const candidates = useMemo(
    () => buildDashboardNotificationCandidates(conversations, liveSessionInboxState, undefined, overlayById),
    [conversations, liveSessionInboxState, overlayById],
  )
  const notifications = useMemo(
    () => applyDashboardNotificationOverlays(candidates, notificationOverlays, maxItems),
    [candidates, notificationOverlays, maxItems],
  )
  const notificationStateBySessionId = useMemo(
    () => buildDashboardNotificationStateBySessionId(notifications),
    [notifications],
  )

  useEffect(() => {
    setNotificationOverlays(previous => {
      const next = reduceDashboardNotificationOverlays(previous, candidates, maxItems)
      return areNotificationOverlayListsEqual(previous, next) ? previous : next
    })
  }, [candidates, maxItems])

  useEffect(() => {
    writeDashboardNotificationOverlays(notificationOverlays)
  }, [notificationOverlays])

  const unreadCount = useMemo(
    () => getDashboardNotificationUnreadCount(notifications),
    [notifications],
  )

  const markRead = useCallback((id: string, readAt?: number) => {
    setNotificationOverlays(previous => markDashboardNotificationOverlayRead(previous, id, readAt))
  }, [])

  const markUnread = useCallback((id: string) => {
    setNotificationOverlays(previous => markDashboardNotificationOverlayUnread(previous, id))
  }, [])

  const markTargetRead = useCallback((target: { sessionId?: string; providerSessionId?: string; tabKey?: string }, readAt?: number) => {
    setNotificationOverlays(previous => markDashboardNotificationTargetOverlayRead(previous, notifications, target, readAt))
  }, [notifications])

  const remove = useCallback((id: string) => {
    setNotificationOverlays(previous => deleteDashboardNotificationOverlay(previous, id))
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
