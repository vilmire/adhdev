import { useEffect, useRef } from 'react'

import type { ActiveConversation } from '../components/dashboard/types'
import {
  getConversationLiveInboxState,
  type InboxSurfaceStateSource,
} from '../components/dashboard/DashboardMobileChatShared'
import { getConversationHistorySessionId } from '../components/dashboard/conversation-identity'
import { getConversationTimestamp } from '../components/dashboard/conversation-sort'
import {
  getDesktopAutoReadPlan,
  getDesktopAutoReadScheduleDecision,
} from '../utils/dashboard-auto-read'

interface UseDashboardDesktopAutoReadOptions {
  activeConv: ActiveConversation | undefined
  isMobile: boolean
  liveSessionInboxState: Map<string, InboxSurfaceStateSource>
  sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
}

export function useDashboardDesktopAutoRead({
  activeConv,
  isMobile,
  liveSessionInboxState,
  sendDaemonCommand,
}: UseDashboardDesktopAutoReadOptions) {
  const lastDesktopAutoReadKeyRef = useRef<string | null>(null)
  const pendingDesktopAutoReadKeyRef = useRef<string | null>(null)
  const pendingDesktopAutoReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingDesktopAutoReadVisibleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingDesktopAutoReadVisibilityHandlerRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const clearPendingDesktopAutoRead = () => {
      if (pendingDesktopAutoReadTimerRef.current) {
        clearTimeout(pendingDesktopAutoReadTimerRef.current)
        pendingDesktopAutoReadTimerRef.current = null
      }
      if (pendingDesktopAutoReadVisibleTimerRef.current) {
        clearTimeout(pendingDesktopAutoReadVisibleTimerRef.current)
        pendingDesktopAutoReadVisibleTimerRef.current = null
      }
      if (pendingDesktopAutoReadVisibilityHandlerRef.current) {
        document.removeEventListener('visibilitychange', pendingDesktopAutoReadVisibilityHandlerRef.current)
        pendingDesktopAutoReadVisibilityHandlerRef.current = null
      }
      pendingDesktopAutoReadKeyRef.current = null
    }

    if (isMobile) {
      clearPendingDesktopAutoRead()
      lastDesktopAutoReadKeyRef.current = null
      return
    }
    if (!activeConv?.sessionId) {
      clearPendingDesktopAutoRead()
      lastDesktopAutoReadKeyRef.current = null
      return
    }

    const liveState = getConversationLiveInboxState(activeConv, liveSessionInboxState)
    const autoReadPlan = getDesktopAutoReadPlan({
      tabKey: activeConv.tabKey,
      historySessionId: getConversationHistorySessionId(activeConv) || '',
      lastMessageHash: activeConv.lastMessageHash || '',
      lastMessageAt: Number(activeConv.lastMessageAt || 0),
      timestamp: getConversationTimestamp(activeConv),
      liveState,
    })
    const autoReadKey = autoReadPlan.autoReadKey
    const scheduleDecision = getDesktopAutoReadScheduleDecision({
      autoReadKey,
      shouldMarkSeen: autoReadPlan.shouldMarkSeen,
      completedKey: lastDesktopAutoReadKeyRef.current,
      pendingKey: pendingDesktopAutoReadKeyRef.current,
    })

    if (!autoReadPlan.shouldMarkSeen) {
      if (scheduleDecision.shouldCancelPending) clearPendingDesktopAutoRead()
      lastDesktopAutoReadKeyRef.current = autoReadKey
      return
    }
    if (!scheduleDecision.shouldSchedule) return
    if (scheduleDecision.shouldCancelPending) clearPendingDesktopAutoRead()

    const doMarkSeen = () => {
      if (document.visibilityState !== 'visible') return
      if (lastDesktopAutoReadKeyRef.current === autoReadKey) return
      lastDesktopAutoReadKeyRef.current = autoReadKey
      pendingDesktopAutoReadKeyRef.current = null
      pendingDesktopAutoReadTimerRef.current = null
      pendingDesktopAutoReadVisibleTimerRef.current = null
      if (pendingDesktopAutoReadVisibilityHandlerRef.current) {
        document.removeEventListener('visibilitychange', pendingDesktopAutoReadVisibilityHandlerRef.current)
        pendingDesktopAutoReadVisibilityHandlerRef.current = null
      }

      const readAt = autoReadPlan.readAt
      void sendDaemonCommand(activeConv.daemonId || activeConv.routeId, 'mark_session_seen', {
        sessionId: activeConv.sessionId,
        providerSessionId: activeConv.providerSessionId,
        seenAt: readAt,
        completionMarker: autoReadPlan.completionMarker,
      }).catch(() => {})
    }

    pendingDesktopAutoReadKeyRef.current = scheduleDecision.nextPendingKey

    if (document.visibilityState === 'visible') {
      pendingDesktopAutoReadTimerRef.current = setTimeout(doMarkSeen, 1500)
      const onVisChange = () => {
        if (document.visibilityState === 'visible') return
        if (pendingDesktopAutoReadTimerRef.current) {
          clearTimeout(pendingDesktopAutoReadTimerRef.current)
          pendingDesktopAutoReadTimerRef.current = null
        }
      }
      pendingDesktopAutoReadVisibilityHandlerRef.current = onVisChange
      document.addEventListener('visibilitychange', onVisChange)
      return
    }

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (pendingDesktopAutoReadVisibleTimerRef.current) {
        clearTimeout(pendingDesktopAutoReadVisibleTimerRef.current)
      }
      pendingDesktopAutoReadVisibleTimerRef.current = setTimeout(doMarkSeen, 800)
      if (pendingDesktopAutoReadVisibilityHandlerRef.current) {
        document.removeEventListener('visibilitychange', pendingDesktopAutoReadVisibilityHandlerRef.current)
        pendingDesktopAutoReadVisibilityHandlerRef.current = null
      }
    }
    pendingDesktopAutoReadVisibilityHandlerRef.current = onVisible
    document.addEventListener('visibilitychange', onVisible)
  }, [activeConv, isMobile, liveSessionInboxState, sendDaemonCommand])

  useEffect(() => () => {
    if (pendingDesktopAutoReadTimerRef.current) clearTimeout(pendingDesktopAutoReadTimerRef.current)
    if (pendingDesktopAutoReadVisibleTimerRef.current) clearTimeout(pendingDesktopAutoReadVisibleTimerRef.current)
    if (pendingDesktopAutoReadVisibilityHandlerRef.current) {
      document.removeEventListener('visibilitychange', pendingDesktopAutoReadVisibilityHandlerRef.current)
    }
  }, [])
}
