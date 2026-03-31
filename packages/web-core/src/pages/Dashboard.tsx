import React, { useState, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

import { useDaemons } from '../compat'
import { useTransport } from '../context/TransportContext'
import type { DaemonData } from '../types'
import { isCliConv, isAcpConv } from '../components/dashboard/types'
import { useHiddenTabs } from '../hooks/useHiddenTabs'
import { useDashboardConversationMeta } from '../hooks/useDashboardConversationMeta'
import { useDashboardConversations } from '../hooks/useDashboardConversations'
import { useDashboardEventManager } from '../hooks/useDashboardEventManager'
import { useDashboardGroupState } from '../hooks/useDashboardGroupState'
import { useDashboardPageEffects } from '../hooks/useDashboardPageEffects'
import { useDashboardSessionCommands } from '../hooks/useDashboardSessionCommands'
import { useDashboardSplitView } from '../hooks/useDashboardSplitView'
import { useDashboardVersionBanner } from '../hooks/useDashboardVersionBanner'

import ConnectionBanner from '../components/dashboard/ConnectionBanner'
import DashboardHeader from '../components/dashboard/DashboardHeader'
import DashboardPaneWorkspace from '../components/dashboard/DashboardPaneWorkspace'
import DashboardVersionBanner from '../components/dashboard/DashboardVersionBanner'
import HistoryModal from '../components/dashboard/HistoryModal'
import ToastContainer from '../components/dashboard/ToastContainer'
import OnboardingModal from '../components/OnboardingModal'

export default function Dashboard() {
    const { sendCommand: sendDaemonCommand } = useTransport()
    const [searchParams, setSearchParams] = useSearchParams()
    const urlActiveTab = searchParams.get('activeTab')

    type Toast = { id: number; message: string; type: 'success' | 'info' | 'warning'; timestamp: number; targetKey?: string }
    const daemonCtx = useDaemons() as any
    const { updateIdeChats, screenshotMap, setScreenshotMap } = daemonCtx
    const ides: DaemonData[] = daemonCtx.ides || []
    const [showOnboarding, setShowOnboarding] = useState(() => {
        try { return !localStorage.getItem('adhdev_onboarding_v1') } catch { return false }
    })
    const toasts: Toast[] = daemonCtx.toasts || []
    const setToasts: React.Dispatch<React.SetStateAction<Toast[]>> = daemonCtx.setToasts || (() => {})
    // Abstract connection state (injected by platform)
    const wsStatus = daemonCtx.wsStatus || 'connected'
    const isConnected = daemonCtx.isConnected ?? true
    const connectionStates = daemonCtx.connectionStates || {}
    const showReconnected = daemonCtx.showReconnected || false
    const {
        groupAssignments,
        setGroupAssignments,
        focusedGroup,
        setFocusedGroup,
        groupActiveTabIds,
        setGroupActiveTabIds,
        groupTabOrders,
        setGroupTabOrders,
        groupSizes,
        setGroupSizes,
        isMobile,
    } = useDashboardGroupState()

    const [messageReceivedAt, setMessageReceivedAt] = useState<Record<string, number>>({})
    const [historyModalOpen, setHistoryModalOpen] = useState(false)
    const [actionLogs, setActionLogs] = useState<{ ideId: string; text: string; timestamp: number }[]>([])
    const [localUserMessages, setLocalUserMessages] = useState<Record<string, { role: string; content: string; timestamp: number; _localId: string }[]>>({})
    const [clearedTabs, setClearedTabs] = useState<Record<string, number>>({})

    // Extract detectedIdes from machine-level entry (for standalone)
    const daemonEntry = ides.find(ide => ide.type === 'adhdev-daemon')
    const detectedIdes: { type: string; name: string; running: boolean; id?: string }[] = (daemonEntry as any)?.detectedIdes || []
    const isStandalone = !!daemonEntry
    // ─── Hidden Tabs ───
    const { hiddenTabs, toggleTab: toggleHiddenTab } = useHiddenTabs();
    const {
        chatIdes,
        conversations,
        visibleConversations,
        visibleTabKeys,
        resolveConversationByTarget,
    } = useDashboardConversations({
        ides,
        connectionStates,
        localUserMessages,
        clearedTabs,
        hiddenTabs,
    })

    const {
        containerRef,
        normalizedGroupAssignments,
        numGroups,
        isSplitMode,
        groupedConvs,
        moveTabToGroup,
        closeGroup,
        handleResizeStart,
        splitTabRelative,
        clearAllSplits,
    } = useDashboardSplitView({
        groupAssignments,
        setGroupAssignments,
        focusedGroup,
        setFocusedGroup,
        setGroupActiveTabIds,
        setGroupTabOrders,
        groupSizes,
        setGroupSizes,
        isMobile,
        visibleConversations,
        visibleTabKeys,
    })

    const activeConv = useMemo(() => {
        const focusedTabKey = groupActiveTabIds[focusedGroup]
        if (focusedTabKey) {
            const found = conversations.find(conversation => conversation.tabKey === focusedTabKey)
            if (found) return found
        }
        return groupedConvs[focusedGroup]?.[0] || groupedConvs[0]?.[0]
    }, [groupActiveTabIds, focusedGroup, conversations, groupedConvs])

    const { ptyBuffers } = useDashboardConversationMeta({
        conversations,
        visibleConversations,
        clearedTabs,
        setClearedTabs,
        setMessageReceivedAt,
        setActionLogs,
    })

    useDashboardEventManager({
        ides,
        sendDaemonCommand,
        setToasts,
        setLocalUserMessages,
        resolveConversationByTarget,
    })

    // ─── Command Handlers (header/history use activeConv) ──────
    const {
        isCreatingChat,
        isRefreshingHistory,
        handleLaunchIde,
        handleSwitchSession,
        handleNewChat,
        handleRefreshHistory,
    } = useDashboardSessionCommands({
        sendDaemonCommand,
        activeConv,
        updateIdeChats,
        setToasts,
        setLocalUserMessages,
        setClearedTabs,
    })

    useDashboardPageEffects({
        urlActiveTab,
        conversations,
        resolveConversationByTarget,
        normalizedGroupAssignments,
        setGroupActiveTabIds,
        setFocusedGroup,
        setSearchParams,
        historyModalOpen,
        activeConv,
        isRefreshingHistory,
        ides,
        handleRefreshHistory,
        isSplitMode,
        splitTabRelative,
        numGroups,
        clearAllSplits,
    })

    const handleActiveCliStop = useCallback(async () => {
        if (!activeConv || !isCliConv(activeConv) || isAcpConv(activeConv)) return
        const cliType = activeConv.ideType || activeConv.agentType || ''
        if (!window.confirm(`Stop ${cliType}?\nThis will terminate the CLI process.`)) return
        const daemonId = activeConv.ideId || activeConv.daemonId || ''
        try {
            await sendDaemonCommand(daemonId, 'stop_cli', { cliType, targetSessionId: activeConv.sessionId })
        } catch (e: any) {
            console.error('Stop CLI failed:', e)
        }
    }, [activeConv, sendDaemonCommand])

    const {
        versionMismatchDaemons,
        versionBannerDismissed,
        setVersionBannerDismissed,
        upgradingDaemons,
        handleBannerUpgrade,
    } = useDashboardVersionBanner({
        ides,
        sendDaemonCommand,
    })

    return (
        <div className="page-dashboard flex-1 min-h-0 bg-bg-primary text-text-primary flex flex-col overflow-hidden">

            <ConnectionBanner wsStatus={wsStatus} showReconnected={showReconnected} />

            {!versionBannerDismissed && (
                <DashboardVersionBanner
                    daemons={versionMismatchDaemons}
                    upgradingDaemons={upgradingDaemons}
                    onUpgrade={handleBannerUpgrade}
                    onDismiss={() => setVersionBannerDismissed(true)}
                />
            )}



            {/* 1. Header Area */}
            <DashboardHeader
                activeConv={activeConv}
                agentCount={chatIdes.length}
                wsStatus={wsStatus}
                isConnected={isConnected}
                onOpenHistory={() => setHistoryModalOpen(true)}
                onStopCli={handleActiveCliStop}
            />

            <DashboardPaneWorkspace
                containerRef={containerRef}
                isSplitMode={isSplitMode}
                numGroups={numGroups}
                groupSizes={groupSizes}
                groupedConvs={groupedConvs}
                ides={ides}
                messageReceivedAt={messageReceivedAt}
                actionLogs={actionLogs}
                ptyBuffers={ptyBuffers}
                screenshotMap={screenshotMap}
                setScreenshotMap={setScreenshotMap}
                sendDaemonCommand={sendDaemonCommand}
                setLocalUserMessages={setLocalUserMessages}
                setActionLogs={setActionLogs}
                isStandalone={isStandalone}
                userName={daemonCtx.userName}
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

            {/* History Modal */}
            {historyModalOpen && activeConv && (
                <HistoryModal
                    activeConv={activeConv}
                    ides={ides}
                    isCreatingChat={isCreatingChat}
                    isRefreshingHistory={isRefreshingHistory}
                    onClose={() => setHistoryModalOpen(false)}
                    onNewChat={handleNewChat}
                    onSwitchSession={handleSwitchSession}
                    onRefreshHistory={handleRefreshHistory}
                />
            )}

            <style>{`
                body { overflow: hidden; overscroll-behavior: none; }
`}</style>

            {/* Toast Notifications */}
            <ToastContainer
                toasts={toasts}
                onDismiss={(id) => setToasts(prev => prev.filter(t => t.id !== id))}
                onClickToast={(toast) => {
                    if (toast.targetKey) {
                        const matchedConv = resolveConversationByTarget(toast.targetKey);
                        if (matchedConv) {
                            setFocusedGroup(normalizedGroupAssignments.get(matchedConv.tabKey) ?? 0);
                        }
                    }
                }}
            />
            {showOnboarding && (
                <OnboardingModal onClose={() => {
                    try { localStorage.setItem('adhdev_onboarding_v1', 'done') } catch {}
                    setShowOnboarding(false)
                }} />
            )}
        </div>
    )
}
