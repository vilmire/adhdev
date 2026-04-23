import { useCallback, useMemo, useState } from 'react'
import type { SetURLSearchParams } from 'react-router-dom'

import type { ActiveConversation } from '../components/dashboard/types'
import {
  buildDashboardScrollToBottomRequest,
  type DashboardScrollToBottomIntent,
  type DashboardScrollToBottomRequest,
} from '../components/dashboard/dashboard-scroll-to-bottom'
import { getConversationActiveTabTarget } from '../components/dashboard/conversation-selectors'

interface UseDashboardDesktopWorkspaceStateOptions {
  isMobile: boolean
  conversations: ActiveConversation[]
  visibleConversations: ActiveConversation[]
  groupActiveTabIds: Record<number, string | null>
  focusedGroup: number
  groupedConvs: ActiveConversation[][]
  setSearchParams: SetURLSearchParams
}

export function useDashboardDesktopWorkspaceState({
  isMobile,
  conversations,
  visibleConversations,
  groupActiveTabIds,
  focusedGroup,
  groupedConvs,
  setSearchParams,
}: UseDashboardDesktopWorkspaceStateOptions) {
  const [desktopActiveTabKey, setDesktopActiveTabKey] = useState<string | null>(null)
  const [scrollToBottomRequest, setScrollToBottomRequest] = useState<DashboardScrollToBottomRequest | null>(null)

  const activeConv = useMemo(() => {
    if (!isMobile) {
      if (desktopActiveTabKey) {
        const found = conversations.find(conversation => conversation.tabKey === desktopActiveTabKey)
        if (found) return found
      }
      return visibleConversations[0]
    }

    const focusedTabKey = groupActiveTabIds[focusedGroup]
    if (focusedTabKey) {
      const found = conversations.find(conversation => conversation.tabKey === focusedTabKey)
      if (found) return found
    }

    return groupedConvs[focusedGroup]?.[0] || groupedConvs[0]?.[0]
  }, [conversations, desktopActiveTabKey, focusedGroup, groupActiveTabIds, groupedConvs, isMobile, visibleConversations])

  const setDesktopActiveTab = useCallback((tabKey: string | null) => {
    setDesktopActiveTabKey(tabKey)
  }, [])

  const openDesktopConversation = useCallback((conversation: ActiveConversation) => {
    setDesktopActiveTabKey(conversation.tabKey)
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const activeTabTarget = getConversationActiveTabTarget(conversation)
      if (activeTabTarget) next.set('activeTab', activeTabTarget)
      else next.delete('activeTab')
      return next
    }, { replace: true })
  }, [setSearchParams])

  const requestScrollToBottom = useCallback((tabKey: string | null | undefined, intent: DashboardScrollToBottomIntent) => {
    const request = buildDashboardScrollToBottomRequest(tabKey, intent)
    if (!request) return
    setScrollToBottomRequest(request)
  }, [])

  return {
    activeConv,
    openDesktopConversation,
    requestScrollToBottom,
    scrollToBottomRequest,
    setDesktopActiveTab,
  }
}
