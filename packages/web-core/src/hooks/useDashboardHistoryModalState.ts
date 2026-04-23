import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { SetURLSearchParams } from 'react-router-dom'

import type { ActiveConversation } from '../components/dashboard/types'
import { isAcpConv, isCliConv } from '../components/dashboard/types'
import type { SavedSessionHistoryEntry } from '../components/dashboard/HistoryModal'
import { createSavedHistoryFilterState, type SavedHistoryFilterState } from '../utils/saved-history-filter-state'
import { getProviderSummaryValue } from '../utils/daemon-utils'
import { getConversationProviderType } from '../components/dashboard/conversation-selectors'
import type { DaemonData } from '../types'
import type { DashboardToastSetter } from './dashboardCommandUtils'
import { useDashboardSessionCommands } from './useDashboardSessionCommands'

interface UseDashboardHistoryModalStateOptions {
  activeConv: ActiveConversation | undefined
  remoteDialogConv: ActiveConversation | null
  remoteDialogActiveConv: ActiveConversation | null
  ides: DaemonData[]
  sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
  updateRouteChats: (routeId: string, chats: DaemonData['chats']) => void
  setToasts: DashboardToastSetter
  setClearedTabs: Dispatch<SetStateAction<Record<string, number>>>
  setSearchParams: SetURLSearchParams
}

export function useDashboardHistoryModalState({
  activeConv,
  remoteDialogConv,
  remoteDialogActiveConv,
  ides,
  sendDaemonCommand,
  updateRouteChats,
  setToasts,
  setClearedTabs,
  setSearchParams,
}: UseDashboardHistoryModalStateOptions) {
  const [historyModalOpen, setHistoryModalOpen] = useState(false)
  const [savedHistorySessions, setSavedHistorySessions] = useState<SavedSessionHistoryEntry[]>([])
  const [savedHistoryFilters, setSavedHistoryFilters] = useState<SavedHistoryFilterState>(() => createSavedHistoryFilterState())
  const [isSavedHistoryLoading, setIsSavedHistoryLoading] = useState(false)
  const [resumingSavedHistorySessionId, setResumingSavedHistorySessionId] = useState<string | null>(null)
  const savedHistoryRefreshKeyRef = useRef<string | null>(null)

  const historyTargetConv = useMemo(
    () => (remoteDialogActiveConv || remoteDialogConv) || activeConv,
    [activeConv, remoteDialogActiveConv, remoteDialogConv],
  )

  const isSavedSessionHistoryTarget = !!historyTargetConv && isCliConv(historyTargetConv) && !isAcpConv(historyTargetConv)

  const savedHistoryRefreshKey = useMemo(() => {
    if (!historyTargetConv || !isSavedSessionHistoryTarget) return null
    const routeTarget = historyTargetConv.daemonId || historyTargetConv.routeId || ''
    const providerType = getConversationProviderType(historyTargetConv)
    return `${routeTarget}:${providerType}`
  }, [historyTargetConv, isSavedSessionHistoryTarget])

  const {
    isCreatingChat: isHistoryCreatingChat,
    isRefreshingHistory: isHistoryRefreshingHistory,
    handleSwitchSession: handleHistorySwitchSession,
    handleNewChat: handleHistoryNewChat,
    handleRefreshHistory: handleHistoryRefresh,
  } = useDashboardSessionCommands({
    sendDaemonCommand,
    activeConv: historyTargetConv,
    chats: ides.find(entry => entry.id === historyTargetConv?.routeId)?.chats,
    updateRouteChats,
    setToasts,
    setClearedTabs,
  })

  const openHistoryModal = useCallback(() => {
    setHistoryModalOpen(true)
  }, [])

  const closeHistoryModal = useCallback(() => {
    setHistoryModalOpen(false)
  }, [])

  const handleRefreshSavedHistory = useCallback(async () => {
    if (!historyTargetConv || !isSavedSessionHistoryTarget || isSavedHistoryLoading) return
    setIsSavedHistoryLoading(true)
    try {
      const routeTarget = historyTargetConv.daemonId || historyTargetConv.routeId
      const providerType = getConversationProviderType(historyTargetConv)
      const raw: any = await sendDaemonCommand(routeTarget, 'list_saved_sessions', {
        agentType: providerType,
        providerType,
        kind: 'cli',
        limit: 50,
      })
      const result = raw?.result ?? raw
      setSavedHistorySessions(Array.isArray(result?.sessions) ? result.sessions : [])
    } catch (error) {
      console.error('Refresh saved sessions failed', error)
      setSavedHistorySessions([])
    } finally {
      setIsSavedHistoryLoading(false)
    }
  }, [historyTargetConv, isSavedHistoryLoading, isSavedSessionHistoryTarget, sendDaemonCommand])

  useEffect(() => {
    if (!historyModalOpen) {
      savedHistoryRefreshKeyRef.current = null
      return
    }
    if (!isSavedSessionHistoryTarget) {
      savedHistoryRefreshKeyRef.current = null
      setSavedHistorySessions([])
      setIsSavedHistoryLoading(false)
      return
    }
    if (!savedHistoryRefreshKey || isSavedHistoryLoading) return
    if (savedHistoryRefreshKeyRef.current === savedHistoryRefreshKey) return
    savedHistoryRefreshKeyRef.current = savedHistoryRefreshKey
    void handleRefreshSavedHistory()
  }, [handleRefreshSavedHistory, historyModalOpen, isSavedHistoryLoading, isSavedSessionHistoryTarget, savedHistoryRefreshKey])

  const handleResumeSavedHistorySession = useCallback(async (session: SavedSessionHistoryEntry) => {
    if (!historyTargetConv || !isSavedSessionHistoryTarget) return
    if (!session.providerSessionId || !session.workspace) return
    const routeTarget = historyTargetConv.daemonId || historyTargetConv.routeId
    const cliType = getConversationProviderType(historyTargetConv)
    try {
      setResumingSavedHistorySessionId(session.providerSessionId)
      const raw: any = await sendDaemonCommand(routeTarget, 'launch_cli', {
        cliType,
        dir: session.workspace,
        resumeSessionId: session.providerSessionId,
        initialModel: getProviderSummaryValue(session.summaryMetadata, 'model', { preferShortValue: true }) || undefined,
      })
      const result = raw?.result ?? raw
      const nextSessionId = typeof result?.sessionId === 'string' ? result.sessionId : typeof result?.id === 'string' ? result.id : ''
      if (nextSessionId) {
        setSearchParams(prev => {
          const next = new URLSearchParams(prev)
          next.set('activeTab', nextSessionId)
          return next
        }, { replace: true })
      }
      closeHistoryModal()
    } catch (error) {
      console.error('Resume saved session failed', error)
    } finally {
      setResumingSavedHistorySessionId(null)
    }
  }, [closeHistoryModal, historyTargetConv, isSavedSessionHistoryTarget, sendDaemonCommand, setSearchParams])

  return {
    historyModalOpen,
    openHistoryModal,
    closeHistoryModal,
    historyTargetConv,
    isSavedSessionHistoryTarget,
    isHistoryCreatingChat,
    isHistoryRefreshingHistory,
    handleHistorySwitchSession,
    handleHistoryNewChat,
    handleHistoryRefresh,
    savedHistorySessions,
    savedHistoryFilters,
    setSavedHistoryFilters,
    isSavedHistoryLoading,
    resumingSavedHistorySessionId,
    handleRefreshSavedHistory,
    handleResumeSavedHistorySession,
  }
}
