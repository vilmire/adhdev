import React from 'react'
import type { DaemonData } from '../../types'
import type { ActiveConversation, CliConversationViewMode } from './types'
import { isAcpConv, isCliConv } from './types'
import DashboardHeader from './DashboardHeader'
import DashboardMobileChatMode from './DashboardMobileChatMode'
import DashboardPaneWorkspace from './DashboardPaneWorkspace'
import DashboardDockviewWorkspace from './DashboardDockviewWorkspace'
import type { DashboardMobileSection } from './DashboardMobileBottomNav'

interface DashboardMainViewProps {
    showMobileChatMode: boolean
    isMobile: boolean
    activeConv?: ActiveConversation
    chatIdes: DaemonData[]
    wsStatus: string
    isConnected: boolean
    onOpenHistory: (conversation?: ActiveConversation) => void
    onOpenRemote: (conversation: ActiveConversation) => void
    onStopCli: () => void
    activeCliViewMode: CliConversationViewMode | null
    onSetActiveCliViewMode: (mode: CliConversationViewMode) => void
    mobileChatConversations: ActiveConversation[]
    hiddenConversations: ActiveConversation[]
    ides: DaemonData[]
    actionLogs: { ideId: string; text: string; timestamp: number }[]
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setLocalUserMessages: React.Dispatch<React.SetStateAction<Record<string, any[]>>>
    setActionLogs: React.Dispatch<React.SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
    userName?: string
    requestedMobileTabKey: string | null
    onRequestedMobileTabConsumed: () => void
    requestedMachineId: string | null
    onRequestedMachineConsumed: () => void
    requestedMobileSection: DashboardMobileSection | null
    onRequestedMobileSectionConsumed: () => void
    containerRef: React.RefObject<HTMLDivElement>
    isSplitMode: boolean
    numGroups: number
    groupSizes: number[]
    groupedConvs: ActiveConversation[][]
    clearedTabs: Record<string, number>
    focusedGroup: number
    setFocusedGroup: React.Dispatch<React.SetStateAction<number>>
    moveTabToGroup: (tabKey: string, nextGroupIndex: number) => void
    splitTabRelative: (tabKey: string, targetGroup: number, side: 'left' | 'right') => void
    closeGroup: (groupIndex: number) => void
    handleResizeStart: (dividerIdx: number, event: React.MouseEvent) => void
    detectedIdes: { type: string; name: string; running: boolean; id?: string }[]
    handleLaunchIde: (ideType: string) => Promise<void>
    groupActiveTabIds: Record<number, string | null>
    setGroupActiveTabIds: React.Dispatch<React.SetStateAction<Record<number, string | null>>>
    groupTabOrders: Record<number, string[]>
    setGroupTabOrders: React.Dispatch<React.SetStateAction<Record<number, string[]>>>
    toggleHiddenTab: (tabKey: string) => void
    visibleConversations: ActiveConversation[]
    requestedDesktopTabKey: string | null
    onRequestedDesktopTabConsumed: () => void
    onDesktopActiveTabChange: React.Dispatch<React.SetStateAction<string | null>>
    onHideConversation: (conversation: ActiveConversation) => void
    onShowHiddenConversation: (conversation: ActiveConversation) => void
    onShowAllHiddenConversations: () => void
}

export default function DashboardMainView({
    showMobileChatMode,
    isMobile,
    activeConv,
    chatIdes,
    wsStatus,
    isConnected,
    onOpenHistory,
    onOpenRemote,
    onStopCli,
    activeCliViewMode,
    onSetActiveCliViewMode,
    mobileChatConversations,
    hiddenConversations,
    ides,
    actionLogs,
    sendDaemonCommand,
    setLocalUserMessages,
    setActionLogs,
    isStandalone,
    userName,
    requestedMobileTabKey,
    onRequestedMobileTabConsumed,
    requestedMachineId,
    onRequestedMachineConsumed,
    requestedMobileSection,
    onRequestedMobileSectionConsumed,
    containerRef,
    isSplitMode,
    numGroups,
    groupSizes,
    groupedConvs,
    clearedTabs,
    focusedGroup,
    setFocusedGroup,
    moveTabToGroup,
    splitTabRelative,
    closeGroup,
    handleResizeStart,
    detectedIdes,
    handleLaunchIde,
    groupActiveTabIds,
    setGroupActiveTabIds,
    groupTabOrders,
    setGroupTabOrders,
    toggleHiddenTab,
    visibleConversations,
    requestedDesktopTabKey,
    onRequestedDesktopTabConsumed,
    onDesktopActiveTabChange,
    onHideConversation,
    onShowHiddenConversation,
    onShowAllHiddenConversations,
}: DashboardMainViewProps) {
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
            const isClose = isMac ? (e.metaKey && e.key.toLowerCase() === 'w') : (e.ctrlKey && e.key.toLowerCase() === 'w')
            if (isClose) {
                e.preventDefault()
                if (activeConv && onHideConversation) {
                    onHideConversation(activeConv)
                }
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [activeConv, onHideConversation])

    return (
        <>
            {!showMobileChatMode && (
                <DashboardHeader
                    activeConv={activeConv}
                    agentCount={chatIdes.length}
                    wsStatus={wsStatus}
                    isConnected={isConnected}
                    conversations={visibleConversations}
                    hiddenConversations={hiddenConversations}
                    onOpenHistory={onOpenHistory}
                    onOpenConversation={onShowHiddenConversation}
                    onHideConversation={onHideConversation}
                    onShowConversation={onShowHiddenConversation}
                    onShowAllHidden={onShowAllHiddenConversations}
                    onOpenRemote={() => {
                        if (!activeConv || isCliConv(activeConv) || isAcpConv(activeConv)) return
                        onOpenRemote(activeConv)
                    }}
                    onStopCli={onStopCli}
                    activeCliViewMode={activeCliViewMode}
                    onSetCliViewMode={onSetActiveCliViewMode}
                />
            )}

            {showMobileChatMode ? (
                <DashboardMobileChatMode
                    conversations={mobileChatConversations}
                    hiddenConversations={hiddenConversations}
                    ides={ides}
                    actionLogs={actionLogs}
                    sendDaemonCommand={sendDaemonCommand}
                    setLocalUserMessages={setLocalUserMessages}
                    setActionLogs={setActionLogs}
                    isStandalone={isStandalone}
                    userName={userName}
                    requestedActiveTabKey={requestedMobileTabKey}
                    onRequestedActiveTabConsumed={onRequestedMobileTabConsumed}
                    requestedMachineId={requestedMachineId}
                    onRequestedMachineConsumed={onRequestedMachineConsumed}
                    requestedMobileSection={requestedMobileSection}
                    onRequestedMobileSectionConsumed={onRequestedMobileSectionConsumed}
                    onOpenHistory={onOpenHistory}
                    onOpenRemote={onOpenRemote}
                    onStopCli={onStopCli}
                    wsStatus={wsStatus}
                    isConnected={isConnected}
                    onShowHiddenConversation={onShowHiddenConversation}
                    onShowAllHiddenConversations={onShowAllHiddenConversations}
                />
            ) : isMobile ? (
                <DashboardPaneWorkspace
                    containerRef={containerRef}
                    isSplitMode={isSplitMode}
                    numGroups={numGroups}
                    groupSizes={groupSizes}
                    groupedConvs={groupedConvs}
                    clearedTabs={clearedTabs}
                    ides={ides}
                    actionLogs={actionLogs}
                    sendDaemonCommand={sendDaemonCommand}
                    setLocalUserMessages={setLocalUserMessages}
                    setActionLogs={setActionLogs}
                    isStandalone={isStandalone}
                    userName={userName}
                    focusedGroup={focusedGroup}
                    setFocusedGroup={setFocusedGroup}
                    moveTabToGroup={moveTabToGroup}
                    splitTabRelative={splitTabRelative}
                    closeGroup={closeGroup}
                    handleResizeStart={handleResizeStart}
                    detectedIdes={detectedIdes}
                    handleLaunchIde={handleLaunchIde}
                    groupActiveTabIds={groupActiveTabIds}
                    setGroupActiveTabIds={setGroupActiveTabIds}
                    groupTabOrders={groupTabOrders}
                    setGroupTabOrders={setGroupTabOrders}
                    toggleHiddenTab={toggleHiddenTab}
                />
            ) : (
                <DashboardDockviewWorkspace
                    visibleConversations={visibleConversations}
                    clearedTabs={clearedTabs}
                    ides={ides}
                    actionLogs={actionLogs}
                    sendDaemonCommand={sendDaemonCommand}
                    setLocalUserMessages={setLocalUserMessages}
                    setActionLogs={setActionLogs}
                    isStandalone={isStandalone}
                    userName={userName}
                    detectedIdes={detectedIdes}
                    handleLaunchIde={handleLaunchIde}
                    toggleHiddenTab={toggleHiddenTab}
                    onActiveTabChange={onDesktopActiveTabChange}
                    requestedActiveTabKey={requestedDesktopTabKey}
                    onRequestedActiveTabConsumed={onRequestedDesktopTabConsumed}
                />
            )}
        </>
    )
}
