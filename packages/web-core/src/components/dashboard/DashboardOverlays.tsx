import React from 'react'

import type { DaemonData } from '../../types'
import OnboardingModal from '../OnboardingModal'
import DashboardRemoteDialog from './DashboardRemoteDialog'
import type { ActiveConversation } from './types'
import { isAcpConv, isCliConv } from './types'
import HistoryModal, { type SavedSessionHistoryEntry } from './HistoryModal'
import CliStopDialog from './CliStopDialog'
import ToastContainer, { type Toast } from './ToastContainer'

interface DashboardOverlaysProps {
    historyModalOpen: boolean
    historyTargetConv?: ActiveConversation
    ides: DaemonData[]
    isHistoryCreatingChat: boolean
    isHistoryRefreshingHistory: boolean
    savedHistorySessions: SavedSessionHistoryEntry[]
    isSavedHistoryLoading: boolean
    isResumingSavedHistorySessionId: string | null
    onCloseHistory: () => void
    onNewHistoryChat: () => void
    onSwitchHistorySession: (ideId: string, sessionId: string) => void
    onRefreshHistory: () => void
    onResumeSavedHistorySession: (session: SavedSessionHistoryEntry) => void
    remoteDialogConv: ActiveConversation | null
    remoteDialogIdeEntry?: DaemonData
    connectionStates: Record<string, any>
    actionLogs: { ideId: string; text: string; timestamp: number }[]
    localUserMessages: Record<string, { role: string; content: string; timestamp: number; _localId: string }[]>
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setLocalUserMessages: React.Dispatch<React.SetStateAction<Record<string, { role: string; content: string; timestamp: number; _localId: string }[]>>>
    setActionLogs: React.Dispatch<React.SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
    userName?: string
    onOpenRemoteHistory: (conversation?: ActiveConversation) => void
    onRemoteConversationChange: React.Dispatch<React.SetStateAction<ActiveConversation | null>>
    onCloseRemoteDialog: () => void
    cliStopDialogOpen: boolean
    cliStopTargetConv?: ActiveConversation | null
    onCancelCliStop: () => void
    onStopCliNow: () => void | Promise<void>
    onSaveCliAndStop: () => void | Promise<void>
    toasts: Toast[]
    onDismissToast: (id: number) => void
    onClickToast?: (toast: Toast) => void
    showOnboarding: boolean
    onCloseOnboarding: () => void
}

export default function DashboardOverlays({
    historyModalOpen,
    historyTargetConv,
    ides,
    isHistoryCreatingChat,
    isHistoryRefreshingHistory,
    savedHistorySessions,
    isSavedHistoryLoading,
    isResumingSavedHistorySessionId,
    onCloseHistory,
    onNewHistoryChat,
    onSwitchHistorySession,
    onRefreshHistory,
    onResumeSavedHistorySession,
    remoteDialogConv,
    remoteDialogIdeEntry,
    connectionStates,
    actionLogs,
    localUserMessages,
    sendDaemonCommand,
    setLocalUserMessages,
    setActionLogs,
    isStandalone,
    userName,
    onOpenRemoteHistory,
    onRemoteConversationChange,
    onCloseRemoteDialog,
    cliStopDialogOpen,
    cliStopTargetConv,
    onCancelCliStop,
    onStopCliNow,
    onSaveCliAndStop,
    toasts,
    onDismissToast,
    onClickToast,
    showOnboarding,
    onCloseOnboarding,
}: DashboardOverlaysProps) {
    return (
        <>
            {historyModalOpen && historyTargetConv && (
                <HistoryModal
                    activeConv={historyTargetConv}
                    ides={ides}
                    isCreatingChat={isHistoryCreatingChat}
                    isRefreshingHistory={isHistoryRefreshingHistory}
                    savedSessions={savedHistorySessions}
                    isSavedSessionsLoading={isSavedHistoryLoading}
                    isResumingSavedSessionId={isResumingSavedHistorySessionId}
                    onClose={onCloseHistory}
                    onNewChat={onNewHistoryChat}
                    onSwitchSession={onSwitchHistorySession}
                    onRefreshHistory={onRefreshHistory}
                    onResumeSavedSession={onResumeSavedHistorySession}
                />
            )}

            {remoteDialogConv && (
                <DashboardRemoteDialog
                    activeConv={remoteDialogConv}
                    ideEntry={remoteDialogIdeEntry}
                    ides={ides}
                    connectionStates={connectionStates}
                    actionLogs={actionLogs}
                    localUserMessages={localUserMessages}
                    sendDaemonCommand={sendDaemonCommand}
                    setLocalUserMessages={setLocalUserMessages}
                    setActionLogs={setActionLogs}
                    isStandalone={isStandalone}
                    userName={userName}
                    onOpenHistory={onOpenRemoteHistory}
                    onConversationChange={onRemoteConversationChange}
                    onClose={onCloseRemoteDialog}
                />
            )}

            {cliStopDialogOpen && cliStopTargetConv && isCliConv(cliStopTargetConv) && !isAcpConv(cliStopTargetConv) && (
                <CliStopDialog
                    activeConv={cliStopTargetConv}
                    onCancel={onCancelCliStop}
                    onStopNow={onStopCliNow}
                    onSaveAndStop={onSaveCliAndStop}
                />
            )}

            <ToastContainer
                toasts={toasts}
                onDismiss={onDismissToast}
                onClickToast={onClickToast}
            />

            {showOnboarding && <OnboardingModal onClose={onCloseOnboarding} />}
        </>
    )
}
