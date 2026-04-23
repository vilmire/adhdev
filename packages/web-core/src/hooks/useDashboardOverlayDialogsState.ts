import { useCallback, useState } from 'react'
import type { NavigateFunction, Location } from 'react-router-dom'

import type { DaemonData } from '../types'
import type { ActiveConversation } from '../components/dashboard/types'
import { getConversationProviderType } from '../components/dashboard/conversation-selectors'
import { isAcpConv, isCliConv } from '../components/dashboard/types'
import { useDashboardRemoteDialogState } from './useDashboardRemoteDialogState'

interface UseDashboardOverlayDialogsStateOptions {
  isMobile: boolean
  location: Location
  navigate: NavigateFunction
  requestedRemoteTabTarget: string | null
  requestedDesktopTabKey: string | null
  conversations: ActiveConversation[]
  ides: DaemonData[]
  resolveConversationByTarget: (target: string | null | undefined) => ActiveConversation | undefined
  activeConv: ActiveConversation | undefined
  sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
}

export function useDashboardOverlayDialogsState({
  isMobile,
  location,
  navigate,
  requestedRemoteTabTarget,
  requestedDesktopTabKey,
  conversations,
  ides,
  resolveConversationByTarget,
  activeConv,
  sendDaemonCommand,
}: UseDashboardOverlayDialogsStateOptions) {
  const {
    remoteDialogConv,
    remoteDialogIdeEntry,
    remoteDialogActiveConv,
    setRemoteDialogActiveConv,
    openRemoteDialog,
    closeRemoteDialog,
  } = useDashboardRemoteDialogState({
    isMobile,
    location,
    navigate,
    requestedRemoteTabTarget,
    requestedDesktopTabKey,
    conversations,
    ides,
    resolveConversationByTarget,
  })

  const [cliStopDialogOpen, setCliStopDialogOpen] = useState(false)
  const [cliStopTargetConv, setCliStopTargetConv] = useState<ActiveConversation | null>(null)

  const requestCliStop = useCallback(async (conversation?: ActiveConversation) => {
    const targetConv = conversation || activeConv
    if (!targetConv || (!isCliConv(targetConv) && !isAcpConv(targetConv))) return
    setCliStopTargetConv(targetConv)
    setCliStopDialogOpen(true)
  }, [activeConv])

  const cancelCliStop = useCallback(() => {
    setCliStopDialogOpen(false)
    setCliStopTargetConv(null)
  }, [])

  const confirmCliStop = useCallback(async (mode: 'hard' | 'save') => {
    const targetConv = cliStopTargetConv || activeConv
    if (!targetConv || (!isCliConv(targetConv) && !isAcpConv(targetConv))) {
      cancelCliStop()
      return
    }

    setCliStopDialogOpen(false)
    try {
      const cliType = getConversationProviderType(targetConv)
      const daemonId = targetConv.routeId || targetConv.daemonId || ''
      await sendDaemonCommand(daemonId, 'stop_cli', {
        cliType,
        targetSessionId: targetConv.sessionId,
        mode,
      })
    } catch (error) {
      console.error('Stop CLI failed:', error)
    } finally {
      setCliStopTargetConv(null)
    }
  }, [activeConv, cancelCliStop, cliStopTargetConv, sendDaemonCommand])

  return {
    remoteDialogConv,
    remoteDialogIdeEntry,
    remoteDialogActiveConv,
    setRemoteDialogActiveConv,
    openRemoteDialog,
    closeRemoteDialog,
    cliStopDialogOpen,
    cliStopTargetConv,
    requestCliStop,
    cancelCliStop,
    confirmCliStop,
  }
}
