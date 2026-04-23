import { useCallback } from 'react'

import type { DashboardNotificationRecord } from '../utils/dashboard-notifications'

interface UseDashboardNotificationActionsOptions {
  notifications: DashboardNotificationRecord[]
  sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
}

export function useDashboardNotificationActions({
  notifications,
  sendDaemonCommand,
}: UseDashboardNotificationActionsOptions) {
  const handleMarkDashboardNotificationRead = useCallback((notificationId: string) => {
    const notification = notifications.find(record => record.id === notificationId)
    const readAt = Math.max(Date.now(), notification?.updatedAt || 0)
    if (!notification?.sessionId) return
    void sendDaemonCommand(notification.machineId || notification.routeId, 'mark_session_seen', {
      sessionId: notification.sessionId,
      seenAt: readAt,
    }).catch(() => {})
  }, [notifications, sendDaemonCommand])

  const handleMarkDashboardNotificationUnread = useCallback((notificationId: string) => {
    const notification = notifications.find(record => record.id === notificationId)
    if (!notification?.sessionId) return
    void sendDaemonCommand(notification.machineId || notification.routeId, 'mark_notification_unread', {
      sessionId: notification.sessionId,
      notificationId: notification.id,
    }).catch(() => {})
  }, [notifications, sendDaemonCommand])

  const handleDeleteDashboardNotification = useCallback((notificationId: string) => {
    const notification = notifications.find(record => record.id === notificationId)
    if (!notification?.sessionId) return
    void sendDaemonCommand(notification.machineId || notification.routeId, 'delete_notification', {
      sessionId: notification.sessionId,
      notificationId: notification.id,
    }).catch(() => {})
  }, [notifications, sendDaemonCommand])

  return {
    handleMarkDashboardNotificationRead,
    handleMarkDashboardNotificationUnread,
    handleDeleteDashboardNotification,
  }
}
