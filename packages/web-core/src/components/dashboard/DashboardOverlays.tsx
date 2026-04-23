import React from 'react'

import type { DaemonData } from '../../types'
import OnboardingModal from '../OnboardingModal'
import DashboardRemoteDialog from './DashboardRemoteDialog'
import type { ActiveConversation } from './types'
import { isAcpConv, isCliConv } from './types'
import HistoryModal, { type SavedSessionHistoryEntry } from './HistoryModal'
import type { SavedHistoryFilterState } from '../../utils/saved-history-filter-state'
import CliStopDialog from './CliStopDialog'
import ToastContainer, { type Toast } from './ToastContainer'

interface DashboardOverlaysProps {
    historyModal: {
        open: boolean
        targetConv?: ActiveConversation
        ides: DaemonData[]
        isCreatingChat: boolean
        isRefreshingHistory: boolean
        savedSessions: SavedSessionHistoryEntry[]
        savedHistoryFilters: SavedHistoryFilterState
        onSavedHistoryFiltersChange: (next: SavedHistoryFilterState) => void
        isSavedSessionsLoading: boolean
        isResumingSavedSessionId: string | null
        onClose: () => void
        onNewChat: () => void
        onSwitchSession: (routeId: string, sessionId: string) => void
        onRefreshHistory: () => void
        onResumeSavedSession: (session: SavedSessionHistoryEntry) => void
    }
    remoteDialog: {
        conversation: ActiveConversation | null
        ideEntry?: DaemonData
        ides: DaemonData[]
        connectionStates: Record<string, any>
        actionLogs: { routeId: string; text: string; timestamp: number }[]
        sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
        setActionLogs: React.Dispatch<React.SetStateAction<{ routeId: string; text: string; timestamp: number }[]>>
        isStandalone: boolean
        userName?: string
        onOpenHistory: (conversation?: ActiveConversation) => void
        onConversationChange: React.Dispatch<React.SetStateAction<ActiveConversation | null>>
        onClose: () => void
    }
    cliStopDialog: {
        open: boolean
        targetConv?: ActiveConversation | null
        onCancel: () => void
        onStopNow: () => void | Promise<void>
        onSaveAndStop: () => void | Promise<void>
    }
    toastOverlay: {
        toasts: Toast[]
        onDismiss: (id: number) => void
        onClick?: (toast: Toast) => void
    }
    onboarding: {
        open: boolean
        onClose: () => void
    }
}

export default function DashboardOverlays({
    historyModal,
    remoteDialog,
    cliStopDialog,
    toastOverlay,
    onboarding,
}: DashboardOverlaysProps) {
    return (
        <>
            {historyModal.open && historyModal.targetConv && (
                <HistoryModal
                    activeConv={historyModal.targetConv}
                    ides={historyModal.ides}
                    isCreatingChat={historyModal.isCreatingChat}
                    isRefreshingHistory={historyModal.isRefreshingHistory}
                    savedSessions={historyModal.savedSessions}
                    isSavedSessionsLoading={historyModal.isSavedSessionsLoading}
                    isResumingSavedSessionId={historyModal.isResumingSavedSessionId}
                    savedHistoryFilters={historyModal.savedHistoryFilters}
                    onSavedHistoryFiltersChange={historyModal.onSavedHistoryFiltersChange}
                    onClose={historyModal.onClose}
                    onNewChat={historyModal.onNewChat}
                    onSwitchSession={historyModal.onSwitchSession}
                    onRefreshHistory={historyModal.onRefreshHistory}
                    onResumeSavedSession={historyModal.onResumeSavedSession}
                />
            )}

            {remoteDialog.conversation && (
                <DashboardRemoteDialog
                    activeConv={remoteDialog.conversation}
                    ideEntry={remoteDialog.ideEntry}
                    ides={remoteDialog.ides}
                    connectionStates={remoteDialog.connectionStates}
                    actionLogs={remoteDialog.actionLogs}
                    sendDaemonCommand={remoteDialog.sendDaemonCommand}
                    setActionLogs={remoteDialog.setActionLogs}
                    isStandalone={remoteDialog.isStandalone}
                    userName={remoteDialog.userName}
                    onOpenHistory={remoteDialog.onOpenHistory}
                    onConversationChange={remoteDialog.onConversationChange}
                    onClose={remoteDialog.onClose}
                />
            )}

            {cliStopDialog.open && cliStopDialog.targetConv && (isCliConv(cliStopDialog.targetConv) || isAcpConv(cliStopDialog.targetConv)) && (
                <CliStopDialog
                    activeConv={cliStopDialog.targetConv}
                    canSaveAndStop={isCliConv(cliStopDialog.targetConv) && !isAcpConv(cliStopDialog.targetConv) && !!cliStopDialog.targetConv.resume?.supported}
                    onCancel={cliStopDialog.onCancel}
                    onStopNow={cliStopDialog.onStopNow}
                    onSaveAndStop={cliStopDialog.onSaveAndStop}
                />
            )}

            <ToastContainer
                toasts={toastOverlay.toasts}
                onDismiss={toastOverlay.onDismiss}
                onClickToast={toastOverlay.onClick}
            />

            {onboarding.open && <OnboardingModal onClose={onboarding.onClose} />}
        </>
    )
}
