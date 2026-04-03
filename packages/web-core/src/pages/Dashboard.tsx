import React, { useState, useCallback, useMemo } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'

import { useDaemons } from '../compat'
import { useTransport } from '../context/TransportContext'
import type { DaemonData } from '../types'
import { isCliConv, isAcpConv } from '../components/dashboard/types'
import { useHiddenTabs } from '../hooks/useHiddenTabs'
import { useDashboardConversationMeta } from '../hooks/useDashboardConversationMeta'
import { useDashboardConversations } from '../hooks/useDashboardConversations'
import { useDashboardActiveTabRequests } from '../hooks/useDashboardActiveTabRequests'
import { useDashboardEventManager } from '../hooks/useDashboardEventManager'
import { useDashboardGroupState } from '../hooks/useDashboardGroupState'
import { useDashboardPageEffects } from '../hooks/useDashboardPageEffects'
import { useDashboardRemoteDialogState } from '../hooks/useDashboardRemoteDialogState'
import { useDashboardSessionCommands } from '../hooks/useDashboardSessionCommands'
import { useDashboardSplitView } from '../hooks/useDashboardSplitView'
import { useDashboardVersionBanner } from '../hooks/useDashboardVersionBanner'
import { useDevRenderTrace } from '../hooks/useDevRenderTrace'

import ConnectionBanner from '../components/dashboard/ConnectionBanner'
import TerminalBackendBanner from '../components/dashboard/TerminalBackendBanner'
import DashboardMainView from '../components/dashboard/DashboardMainView'
import DashboardOverlays from '../components/dashboard/DashboardOverlays'
import DashboardVersionBanner from '../components/dashboard/DashboardVersionBanner'
import type { Toast } from '../components/dashboard/ToastContainer'
import { getMobileDashboardMode } from '../components/settings/MobileDashboardModeSection'

export default function Dashboard() {
    const { sendCommand: sendDaemonCommand } = useTransport()
    const location = useLocation()
    const navigate = useNavigate()
    const [searchParams, setSearchParams] = useSearchParams()
    const urlActiveTab = searchParams.get('activeTab')
    const requestedRemoteTabTarget = (location.state as { openRemoteForTabKey?: string } | null)?.openRemoteForTabKey || null

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
        hasHydratedStoredLayout,
        hydrateStoredLayout,
    } = useDashboardGroupState()

    const [historyModalOpen, setHistoryModalOpen] = useState(false)
    const [cliStopDialogOpen, setCliStopDialogOpen] = useState(false)
    const [mobileViewMode] = useState<'chat' | 'workspace'>(() => getMobileDashboardMode())
    const [actionLogs, setActionLogs] = useState<{ ideId: string; text: string; timestamp: number }[]>([])
    const [localUserMessages, setLocalUserMessages] = useState<Record<string, { role: string; content: string; timestamp: number; _localId: string }[]>>({})
    const [clearedTabs, setClearedTabs] = useState<Record<string, number>>({})
    const [desktopActiveTabKey, setDesktopActiveTabKey] = useState<string | null>(null)
    useDevRenderTrace('Dashboard', {
        ideCount: ides.length,
        toastCount: toasts.length,
        focusedGroup,
        groupCount: Object.keys(groupAssignments).length,
        localMessageTabs: Object.keys(localUserMessages).length,
        actionLogCount: actionLogs.length,
    })

    // Extract detectedIdes from machine-level entry (for standalone)
    const daemonEntry = ides.find(ide => ide.type === 'adhdev-daemon')
    const detectedIdes: { type: string; name: string; running: boolean; id?: string }[] = (daemonEntry as any)?.detectedIdes || []
    const isStandalone = !!daemonEntry
    const terminalBackend = (daemonEntry as any)?.terminalBackend || null
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
    }, [desktopActiveTabKey, isMobile, groupActiveTabIds, focusedGroup, conversations, groupedConvs, visibleConversations])

    const {
        requestedDesktopTabKey,
        requestedMobileTabKey,
        consumeRequestedActiveTab,
    } = useDashboardActiveTabRequests({
        isMobile,
        urlActiveTab,
        resolveConversationByTarget,
        setSearchParams,
    })

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

    const historyTargetConv = (remoteDialogActiveConv || remoteDialogConv) || activeConv
    const mobileChatConversations = useMemo(
        () => visibleConversations,
        [visibleConversations],
    )
    const showMobileChatMode = isMobile && mobileViewMode === 'chat'

    useDashboardConversationMeta({
        visibleConversations,
        clearedTabs,
        setClearedTabs,
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
        isRefreshingHistory,
        handleLaunchIde,
        handleRefreshHistory,
    } = useDashboardSessionCommands({
        sendDaemonCommand,
        activeConv,
        updateIdeChats,
        setToasts,
        setLocalUserMessages,
        setClearedTabs,
    })

    const {
        isCreatingChat: isHistoryCreatingChat,
        isRefreshingHistory: isHistoryRefreshingHistory,
        handleSwitchSession: handleHistorySwitchSession,
        handleNewChat: handleHistoryNewChat,
        handleRefreshHistory: handleHistoryRefresh,
    } = useDashboardSessionCommands({
        sendDaemonCommand,
        activeConv: historyTargetConv,
        updateIdeChats,
        setToasts,
        setLocalUserMessages,
        setClearedTabs,
    })

    useDashboardPageEffects({
        urlActiveTab: isMobile && !showMobileChatMode ? urlActiveTab : null,
        conversations,
        resolveConversationByTarget,
        normalizedGroupAssignments,
        hasHydratedStoredLayout: isMobile && !showMobileChatMode ? hasHydratedStoredLayout : true,
        hydrateStoredLayout: isMobile && !showMobileChatMode ? hydrateStoredLayout : (() => {}),
        setGroupActiveTabIds,
        setFocusedGroup,
        setSearchParams,
        historyModalOpen,
        activeConv,
        isRefreshingHistory,
        ides,
        handleRefreshHistory,
    })

    const performActiveCliStop = useCallback(async (mode: 'hard' | 'save') => {
        if (!activeConv || !isCliConv(activeConv) || isAcpConv(activeConv)) return
        const cliType = activeConv.ideType || activeConv.agentType || ''
        const daemonId = activeConv.ideId || activeConv.daemonId || ''
        try {
            await sendDaemonCommand(daemonId, 'stop_cli', {
                cliType,
                targetSessionId: activeConv.sessionId,
                mode,
            })
        } catch (e: any) {
            console.error('Stop CLI failed:', e)
        }
    }, [activeConv, sendDaemonCommand])

    const handleActiveCliStop = useCallback(async () => {
        if (!activeConv || !isCliConv(activeConv) || isAcpConv(activeConv)) return
        if (activeConv.resume?.supported) {
            setCliStopDialogOpen(true)
            return
        }
        const cliType = activeConv.ideType || activeConv.agentType || 'CLI'
        if (!window.confirm(`Stop ${cliType}?\nThis will terminate the CLI process.`)) return
        await performActiveCliStop('hard')
    }, [activeConv, performActiveCliStop])

    const handleActiveCliFit = useCallback(() => {
        if (!activeConv || !isCliConv(activeConv) || isAcpConv(activeConv) || !activeConv.sessionId) return
        window.dispatchEvent(new CustomEvent('adhdev:fit-cli-terminal', {
            detail: { sessionId: activeConv.sessionId },
        }))
    }, [activeConv])

    const {
        versionMismatchDaemons,
        appVersion,
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
            <TerminalBackendBanner terminalBackend={terminalBackend} isStandalone={isStandalone} />

            {!versionBannerDismissed && (
                <DashboardVersionBanner
                    daemons={versionMismatchDaemons}
                    targetVersion={appVersion}
                    upgradingDaemons={upgradingDaemons}
                    onUpgrade={handleBannerUpgrade}
                    onDismiss={() => setVersionBannerDismissed(true)}
                />
            )}
            <DashboardMainView
                showMobileChatMode={showMobileChatMode}
                isMobile={isMobile}
                activeConv={activeConv}
                chatIdes={chatIdes}
                wsStatus={wsStatus}
                isConnected={isConnected}
                onOpenHistory={(conversation) => {
                    if (conversation) setRemoteDialogActiveConv(conversation)
                    setHistoryModalOpen(true)
                }}
                onOpenRemote={openRemoteDialog}
                onFitCli={handleActiveCliFit}
                onStopCli={handleActiveCliStop}
                mobileChatConversations={mobileChatConversations}
                ides={ides}
                actionLogs={actionLogs}
                sendDaemonCommand={sendDaemonCommand}
                setLocalUserMessages={setLocalUserMessages}
                setActionLogs={setActionLogs}
                isStandalone={isStandalone}
                userName={daemonCtx.userName}
                requestedMobileTabKey={requestedMobileTabKey}
                onRequestedMobileTabConsumed={consumeRequestedActiveTab}
                containerRef={containerRef}
                isSplitMode={isSplitMode}
                numGroups={numGroups}
                groupSizes={groupSizes}
                groupedConvs={groupedConvs}
                clearedTabs={clearedTabs}
                screenshotMap={screenshotMap}
                setScreenshotMap={setScreenshotMap}
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
                visibleConversations={visibleConversations}
                requestedDesktopTabKey={requestedDesktopTabKey}
                onRequestedDesktopTabConsumed={consumeRequestedActiveTab}
                onDesktopActiveTabChange={setDesktopActiveTabKey}
            />

            <style>{`
                body { overflow: hidden; overscroll-behavior: none; }
`}</style>
            <DashboardOverlays
                historyModalOpen={historyModalOpen}
                historyTargetConv={historyTargetConv}
                ides={ides}
                isHistoryCreatingChat={isHistoryCreatingChat}
                isHistoryRefreshingHistory={isHistoryRefreshingHistory}
                onCloseHistory={() => setHistoryModalOpen(false)}
                onNewHistoryChat={handleHistoryNewChat}
                onSwitchHistorySession={handleHistorySwitchSession}
                onRefreshHistory={handleHistoryRefresh}
                remoteDialogConv={remoteDialogConv}
                remoteDialogIdeEntry={remoteDialogIdeEntry}
                connectionStates={connectionStates}
                actionLogs={actionLogs}
                localUserMessages={localUserMessages}
                sendDaemonCommand={sendDaemonCommand}
                setLocalUserMessages={setLocalUserMessages}
                setActionLogs={setActionLogs}
                isStandalone={isStandalone}
                userName={daemonCtx.userName}
                onOpenRemoteHistory={(conversation) => {
                    if (conversation) setRemoteDialogActiveConv(conversation)
                    setHistoryModalOpen(true)
                }}
                onRemoteConversationChange={setRemoteDialogActiveConv}
                onCloseRemoteDialog={closeRemoteDialog}
                cliStopDialogOpen={cliStopDialogOpen}
                activeConv={activeConv}
                onCancelCliStop={() => setCliStopDialogOpen(false)}
                onStopCliNow={async () => {
                    setCliStopDialogOpen(false)
                    await performActiveCliStop('hard')
                }}
                onSaveCliAndStop={async () => {
                    setCliStopDialogOpen(false)
                    await performActiveCliStop('save')
                }}
                toasts={toasts}
                onDismissToast={(id) => setToasts(prev => prev.filter(t => t.id !== id))}
                onClickToast={(toast) => {
                    if (toast.targetKey) {
                        const matchedConv = resolveConversationByTarget(toast.targetKey)
                        if (matchedConv) {
                            setFocusedGroup(normalizedGroupAssignments.get(matchedConv.tabKey) ?? 0)
                        }
                    }
                }}
                showOnboarding={showOnboarding}
                onCloseOnboarding={() => {
                    try { localStorage.setItem('adhdev_onboarding_v1', 'done') } catch {}
                    setShowOnboarding(false)
                }}
            />
        </div>
    )
}
