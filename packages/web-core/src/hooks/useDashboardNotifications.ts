import { useMemo } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import type { DashboardNotificationLiveState } from '../utils/dashboard-notifications'
import {
  MAX_DASHBOARD_NOTIFICATIONS,
  buildDashboardNotificationCandidates,
  getDashboardNotificationUnreadCount,
} from '../utils/dashboard-notifications'

/**
 * Notification state policy:
 * - daemon/live conversation state defines which inbox candidates currently exist
 * - frontend derives a view from daemon state only
 * - read/unread/delete actions round-trip through daemon commands; this hook does not keep a browser-local ledger
 */
export function useDashboardNotifications(args: {
  conversations: ActiveConversation[]
  liveSessionInboxState: Map<string, DashboardNotificationLiveState>
  maxItems?: number
}) {
  const { conversations, liveSessionInboxState, maxItems = MAX_DASHBOARD_NOTIFICATIONS } = args

  const notifications = useMemo(
    () => buildDashboardNotificationCandidates(conversations, liveSessionInboxState).slice(0, Math.max(0, maxItems)),
    [conversations, liveSessionInboxState, maxItems],
  )

  const unreadCount = useMemo(
    () => getDashboardNotificationUnreadCount(notifications),
    [notifications],
  )

  return {
    notifications,
    unreadCount,
  }
}
