import { useState, useCallback, useMemo, useEffect } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'

import { useDaemons } from '../compat'
import { useTransport } from '../context/TransportContext'
import { useDaemonMetadataLoader } from '../hooks/useDaemonMetadataLoader'
import { useDaemonMachineRuntimeLoader } from '../hooks/useDaemonMachineRuntimeLoader'
import type { DaemonData } from '../types'
import { isCliConv, isAcpConv, getCliConversationViewMode } from '../components/dashboard/types'
import {
    applyCliViewModeOverrides,
    reconcileCliViewModeOverrides,
} from '../components/dashboard/cliViewModeOverrides'
import { useWarmSessionChatTailControllers } from '../components/dashboard/session-chat-tail-controller'
import { useHiddenTabs, isConversationHidden, getAutoHiddenConversationTargets } from '../hooks/useHiddenTabs'
import { useDashboardConversationMeta } from '../hooks/useDashboardConversationMeta'
import { useDashboardConversations } from '../hooks/useDashboardConversations'
import { useDashboardActiveTabRequests } from '../hooks/useDashboardActiveTabRequests'
import { useDashboardEventManager } from '../hooks/useDashboardEventManager'
import { useDashboardGroupState } from '../hooks/useDashboardGroupState'
import { useDashboardPageEffects } from '../hooks/useDashboardPageEffects'
import { useDashboardSessionCommands } from '../hooks/useDashboardSessionCommands'
import { useDashboardSplitView } from '../hooks/useDashboardSplitView'
import { useDashboardVersionBanner } from '../hooks/useDashboardVersionBanner'
import { useDevRenderTrace } from '../hooks/useDevRenderTrace'
import { useDashboardNotifications } from '../hooks/useDashboardNotifications'
import { useDashboardNotificationActions } from '../hooks/useDashboardNotificationActions'
import { useDashboardCommandActions } from '../hooks/useDashboardCommandActions'
import { useDashboardDesktopWorkspaceState } from '../hooks/useDashboardDesktopWorkspaceState'
import { useDashboardDesktopAutoRead } from '../hooks/useDashboardDesktopAutoRead'
import { useDashboardHistoryModalState } from '../hooks/useDashboardHistoryModalState'
import { useDashboardOverlayDialogsState } from '../hooks/useDashboardOverlayDialogsState'
import { useDashboardPendingLaunch } from '../hooks/useDashboardPendingLaunch'
import { useInteractivePrompt } from '../hooks/useInteractivePrompt'

import DashboardMainView from '../components/dashboard/DashboardMainView'
import DashboardOverlays from '../components/dashboard/DashboardOverlays'
import DashboardVersionBanner from '../components/dashboard/DashboardVersionBanner'
import type { Toast } from '../components/dashboard/ToastContainer'
import type { DashboardMobileSection } from '../components/dashboard/DashboardMobileBottomNav'
import { getMobileDashboardMode, subscribeMobileDashboardMode } from '../components/settings/MobileDashboardModeSection'
import { getDashboardWarmChatTailOptions } from '../utils/dashboard-warm-chat-tail'
import { buildLiveSessionInboxStateMap } from '../components/dashboard/DashboardMobileChatShared'
import { compareMachineEntries } from '../utils/daemon-utils'
import { getDashboardMachineRefreshTargets } from '../utils/dashboard-machine-refresh'


export default function Dashboard() {
    const { sendCommand: sendDaemonCommand } = useTransport()
    const loadDaemonMetadata = useDaemonMetadataLoader()
    const loadMachineRuntime = useDaemonMachineRuntimeLoader()
    const location = useLocation()
    const navigate = useNavigate()
    const [searchParams, setSearchParams] = useSearchParams()
    const urlActiveTab = searchParams.get('activeTab')
    const requestedRemoteTabTarget = (location.state as { openRemoteForTabKey?: string } | null)?.openRemoteForTabKey || null
    const requestedMachineId = (location.state as { openMachineId?: string } | null)?.openMachineId || null
    const requestedMobileSection = (location.state as { mobileSection?: DashboardMobileSection } | null)?.mobileSection || null

    const daemonCtx = useDaemons()
    const ides: DaemonData[] = daemonCtx.ides || []
    const initialLoaded: boolean = daemonCtx.initialLoaded ?? true
    const { updateRouteChats, setToasts } = daemonCtx
    const [showOnboarding, setShowOnboarding] = useState(() => {
        try { return !localStorage.getItem('adhdev_onboarding_v1') } catch { return false }
    })
    const toasts: Toast[] = daemonCtx.toasts || []
    // Abstract connection state (injected by platform)
    const wsStatus = daemonCtx.wsStatus || 'connected'
    const isConnected = daemonCtx.isConnected ?? true
    const connectionStates = daemonCtx.connectionStates || {}
    const showReconnected = daemonCtx.showReconnected || false
    const {
        layoutProfile,
        groupAssignments,
        updateGroupAssignments,
        focusedGroup,
        updateFocusedGroup,
        focusGroup,
        groupActiveTabIds,
        updateGroupActiveTabIds,
        setGroupActiveTab,
        groupTabOrders,
        updateGroupTabOrders,
        setGroupTabOrder,
        groupSizes,
        updateGroupSizes,
        isMobile,
        hasHydratedStoredLayout,
        hydrateStoredLayout,
        focusConversationTab,
    } = useDashboardGroupState()

    const [mobileViewMode, setMobileViewMode] = useState<'chat' | 'workspace'>(() => getMobileDashboardMode())
    useEffect(() => subscribeMobileDashboardMode(setMobileViewMode), [])
    const warmChatTailOptions = useMemo(
        () => getDashboardWarmChatTailOptions({ isMobile, mobileViewMode }),
        [isMobile, mobileViewMode],
    )
    const [actionLogs, setActionLogs] = useState<{ routeId: string; text: string; timestamp: number }[]>([])
    const [cliViewModeOverrides, setCliViewModeOverrides] = useState<Record<string, 'chat' | 'terminal'>>({})
    const [clearedTabs, setClearedTabs] = useState<Record<string, number>>({})
    useDevRenderTrace('Dashboard', {
        ideCount: ides.length,
        toastCount: toasts.length,
        focusedGroup,
        groupCount: Object.keys(groupAssignments).length,
        actionLogCount: actionLogs.length,
    })

    const machineEntries = useMemo(
        () => ides
            .filter((entry) => entry.type === 'adhdev-daemon')
            .sort(compareMachineEntries),
        [ides],
    )
    const daemonEntry = machineEntries[0]
    const isStandalone = !!daemonEntry
    useEffect(() => {
        const { metadataDaemonIds, runtimeDaemonIds } = getDashboardMachineRefreshTargets(machineEntries)

        for (const daemonId of metadataDaemonIds) {
            void loadDaemonMetadata(daemonId, { minFreshMs: 30_000 }).catch(() => {})
        }

        for (const daemonId of runtimeDaemonIds) {
            void loadMachineRuntime(daemonId, { minFreshMs: 30_000 }).catch(() => {})
        }
    }, [loadDaemonMetadata, loadMachineRuntime, machineEntries])

    const effectiveIdes = useMemo(
        () => applyCliViewModeOverrides(ides, cliViewModeOverrides),
        [ides, cliViewModeOverrides],
    )
    // ─── Hidden Tabs ───
    const {
        hiddenTabs,
        autoHiddenTabs,
        autoHideTarget: autoHideConversation,
        hideTarget: hideHiddenConversation,
        toggleTarget: toggleHiddenConversation,
        showTarget: showHiddenConversation,
        showAllTabs: showAllHiddenTabs,
    } = useHiddenTabs();
    const {
        conversations,
        visibleConversations,
        visibleTabKeys,
        resolveConversationBySessionId,
        resolveConversationByTarget,
    } = useDashboardConversations({
        ides: effectiveIdes,
        connectionStates,
        clearedTabs,
        hiddenTabs,
    })
    const conversationByTabKey = useMemo(
        () => new Map(conversations.map(conversation => [conversation.tabKey, conversation])),
        [conversations],
    )
    const autoHiddenConversationTargets = useMemo(
        () => getAutoHiddenConversationTargets(conversations, hiddenTabs, autoHiddenTabs),
        [conversations, hiddenTabs, autoHiddenTabs],
    )
    useEffect(() => {
        for (const conversation of autoHiddenConversationTargets) {
            autoHideConversation(conversation)
        }
    }, [autoHiddenConversationTargets, autoHideConversation])
    useWarmSessionChatTailControllers(visibleConversations, warmChatTailOptions)
    useEffect(() => {
        if (Object.keys(cliViewModeOverrides).length === 0) return
        setCliViewModeOverrides((prev) => reconcileCliViewModeOverrides(prev, ides))
    }, [ides, cliViewModeOverrides])
    const liveSessionInboxState = useMemo(
        () => buildLiveSessionInboxStateMap(ides),
        [ides],
    )
    const {
        notifications,
        unreadCount: notificationUnreadCount,
    } = useDashboardNotifications({
        conversations: conversations,
        liveSessionInboxState,
    })
    const {
        handleMarkDashboardNotificationRead,
        handleMarkDashboardNotificationUnread,
        handleDeleteDashboardNotification,
    } = useDashboardNotificationActions({
        notifications,
        sendDaemonCommand,
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
        updateGroupAssignments,
        updateFocusedGroup,
        updateGroupActiveTabIds,
        updateGroupTabOrders,
        groupSizes,
        updateGroupSizes,
        isMobile,
        visibleConversations: visibleConversations,
        visibleTabKeys,
    })

    const {
        activeConv,
        openDesktopConversation,
        requestScrollToBottom,
        scrollToBottomRequest,
        setDesktopActiveTab,
    } = useDashboardDesktopWorkspaceState({
        isMobile,
        conversations: conversations,
        visibleConversations: visibleConversations,
        groupActiveTabIds,
        focusedGroup,
        groupedConvs,
        setSearchParams,
    })

    useDashboardDesktopAutoRead({
        activeConv,
        isMobile,
        liveSessionInboxState,
        sendDaemonCommand,
    })

    const {
        requestedDesktopTabKey,
        requestedMobileTabKey,
        consumeRequestedActiveTab,
    } = useDashboardActiveTabRequests({
        isMobile,
        urlActiveTab,
        resolveConversationBySessionId,
        setSearchParams,
    })

    const {
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
    } = useDashboardOverlayDialogsState({
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
    })

    const {
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
        missingWorkspaceResumePath,
        isSavedHistoryLoading,
        resumingSavedHistorySessionId,
        handleRefreshSavedHistory,
        handleResumeSavedHistorySession,
    } = useDashboardHistoryModalState({
        activeConv,
        remoteDialogConv,
        remoteDialogActiveConv,
        ides,
        sendDaemonCommand,
        updateRouteChats,
        setToasts,
        setClearedTabs,
        setSearchParams,
    })

    const mobileChatConversations = useMemo(
        () => visibleConversations,
        [visibleConversations],
    )
    const showMobileChatMode = isMobile && mobileViewMode === 'chat'
    const hiddenConversations = useMemo(
        () => conversations.filter(conversation => isConversationHidden(hiddenTabs, conversation)),
        [conversations, hiddenTabs],
    )

    const handleRequestOpenSession = useCallback((sessionId: string) => {
        const next = new URLSearchParams(searchParams)
        next.set('activeTab', sessionId)
        setSearchParams(next, { replace: true })
    }, [searchParams, setSearchParams])

    const {
        trackPendingLaunch,
    } = useDashboardPendingLaunch({
        ides,
        conversations,
        onOpenSession: handleRequestOpenSession,
    })

    const {
        handleBrowseMachineDirectory,
        handleSaveMachineWorkspace,
        handleLaunchMachineIde,
        handleLaunchMachineProvider,
        handleListMachineMeshes,
        handleLaunchMeshCoordinator,
        handleListMachineSavedSessions,
        setActiveCliViewMode,
    } = useDashboardCommandActions({
        sendDaemonCommand,
        trackPendingLaunch,
        onOpenSession: handleRequestOpenSession,
        activeConv,
        ides,
        setCliViewModeOverrides,
    })

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
        resolveConversationByTarget,
    })
    const interactivePrompt = useInteractivePrompt()

    // ─── Command Handlers (header/history use activeConv) ──────
    const {
        isRefreshingHistory,
        handleRefreshHistory,
    } = useDashboardSessionCommands({
        sendDaemonCommand,
        activeConv,
        chats: ides.find(entry => entry.id === activeConv?.routeId)?.chats,
        updateRouteChats,
        setToasts,
        setClearedTabs,
    })

    useDashboardPageEffects({
        urlActiveTab: isMobile && !showMobileChatMode ? urlActiveTab : null,
        conversations,
        resolveConversationBySessionId,
        normalizedGroupAssignments,
        hasHydratedStoredLayout: isMobile && !showMobileChatMode ? hasHydratedStoredLayout : true,
        hydrateStoredLayout: isMobile && !showMobileChatMode ? hydrateStoredLayout : (() => {}),
        focusConversationTab,
        setSearchParams,
        historyModalOpen,
        activeConv,
        isRefreshingHistory,
        ides,
        handleRefreshHistory,
    })

    const activeCliViewMode = useMemo(() => {
        if (!activeConv || !isCliConv(activeConv) || isAcpConv(activeConv)) return null
        return getCliConversationViewMode(activeConv)
    }, [activeConv])

    const {
        versionMismatchDaemons,
        hasRequiredVersionDaemons,
        targetVersion,
        versionBannerDismissed,
        setVersionBannerDismissed,
        upgradingDaemons,
        handleBannerUpgrade,
    } = useDashboardVersionBanner({
        ides,
        sendDaemonCommand,
    })

    const handleShowHiddenConversation = useCallback((conversation: import('../components/dashboard/types').ActiveConversation) => {
        showHiddenConversation(conversation)
        openDesktopConversation(conversation)
    }, [openDesktopConversation, showHiddenConversation])

    const handleHideConversation = useCallback((conversation: import('../components/dashboard/types').ActiveConversation) => {
        hideHiddenConversation(conversation)
    }, [hideHiddenConversation])

    return (
        <div className="page-dashboard flex-1 min-h-0 bg-bg-primary text-text-primary flex flex-col overflow-hidden">


            {(!versionBannerDismissed || hasRequiredVersionDaemons) && (
                <DashboardVersionBanner
                    daemons={versionMismatchDaemons}
                    targetVersion={targetVersion}
                    required={hasRequiredVersionDaemons}
                    upgradingDaemons={upgradingDaemons}
                    onUpgrade={handleBannerUpgrade}
                    onDismiss={() => setVersionBannerDismissed(true)}
                />
            )}
            <DashboardMainView
                showMobileChatMode={showMobileChatMode}
                isMobile={isMobile}
                activeConv={activeConv}
                wsStatus={wsStatus}
                isConnected={isConnected}
                onOpenHistory={(conversation) => {
                    if (conversation) setRemoteDialogActiveConv(conversation)
                    openHistoryModal()
                }}
                onOpenRemote={openRemoteDialog}
                onStopCli={requestCliStop}
                activeCliViewMode={activeCliViewMode}
                onSetActiveCliViewMode={setActiveCliViewMode}
                mobileChatConversations={mobileChatConversations}
                ides={ides}
                actionLogs={actionLogs}
                sendDaemonCommand={sendDaemonCommand}
                setActionLogs={setActionLogs}
                setCliViewModeOverrides={setCliViewModeOverrides}
                isStandalone={isStandalone}
                initialDataLoaded={initialLoaded}
                userName={daemonCtx.userName}
                requestedMobileTabKey={requestedMobileTabKey}
                onRequestedMobileTabConsumed={consumeRequestedActiveTab}
                requestedMachineId={requestedMachineId}
                onRequestedMachineConsumed={() => {
                    navigate(location.pathname + location.search, { replace: true, state: null })
                }}
                requestedMobileSection={requestedMobileSection}
                onRequestedMobileSectionConsumed={() => {
                    navigate(location.pathname + location.search, { replace: true, state: null })
                }}
                containerRef={containerRef}
                isSplitMode={isSplitMode}
                numGroups={numGroups}
                groupSizes={groupSizes}
                groupedConvs={groupedConvs}
                clearedTabs={clearedTabs}
                focusedGroup={focusedGroup}
                focusGroup={focusGroup}
                moveTabToGroup={moveTabToGroup}
                splitTabRelative={splitTabRelative}
                closeGroup={closeGroup}
                handleResizeStart={handleResizeStart}
                groupActiveTabIds={groupActiveTabIds}
                setGroupActiveTab={setGroupActiveTab}
                groupTabOrders={groupTabOrders}
                setGroupTabOrder={setGroupTabOrder}
                toggleHiddenTab={(tabKey) => toggleHiddenConversation(conversationByTabKey.get(tabKey) || { tabKey })}
                visibleConversations={visibleConversations}
                hiddenConversations={hiddenConversations}
                requestedDesktopTabKey={requestedDesktopTabKey}
                onRequestedDesktopTabConsumed={consumeRequestedActiveTab}
                onDesktopActiveTabChange={setDesktopActiveTab}
                onRequestScrollToBottom={requestScrollToBottom}
                onHideConversation={handleHideConversation}
                onShowHiddenConversation={handleShowHiddenConversation}
                onShowAllHiddenConversations={showAllHiddenTabs}
                scrollToBottomRequest={scrollToBottomRequest}
                machineEntries={machineEntries}
                layoutProfile={layoutProfile}
                onBrowseMachineDirectory={handleBrowseMachineDirectory}
                onSaveMachineWorkspace={handleSaveMachineWorkspace}
                onLaunchMachineIde={handleLaunchMachineIde}
                onLaunchMachineProvider={handleLaunchMachineProvider}
                onListMachineMeshes={handleListMachineMeshes}
                onLaunchMeshCoordinator={handleLaunchMeshCoordinator}
                onListMachineSavedSessions={handleListMachineSavedSessions}
                notifications={notifications}
                notificationUnreadCount={notificationUnreadCount}
                liveSessionInboxState={liveSessionInboxState}
                onMarkNotificationRead={handleMarkDashboardNotificationRead}
                onMarkNotificationUnread={handleMarkDashboardNotificationUnread}
                onDeleteNotification={handleDeleteDashboardNotification}
            />

            <style>{`
                body { overflow: hidden; overscroll-behavior: none; }
`}</style>
            <DashboardOverlays
                historyModal={{
                    open: historyModalOpen,
                    targetConv: historyTargetConv,
                    ides,
                    isCreatingChat: isHistoryCreatingChat,
                    isRefreshingHistory: isSavedSessionHistoryTarget ? false : isHistoryRefreshingHistory,
                    savedSessions: savedHistorySessions,
                    savedHistoryFilters,
                    missingWorkspaceResumePath: missingWorkspaceResumePath || null,
                    onSavedHistoryFiltersChange: setSavedHistoryFilters,
                    isSavedSessionsLoading: isSavedHistoryLoading,
                    isResumingSavedSessionId: resumingSavedHistorySessionId,
                    onClose: closeHistoryModal,
                    onNewChat: handleHistoryNewChat,
                    onSwitchSession: handleHistorySwitchSession,
                    onRefreshHistory: isSavedSessionHistoryTarget ? handleRefreshSavedHistory : handleHistoryRefresh,
                    onResumeSavedSession: handleResumeSavedHistorySession,
                }}
                remoteDialog={{
                    conversation: remoteDialogConv,
                    ideEntry: remoteDialogIdeEntry,
                    ides,
                    connectionStates,
                    actionLogs,
                    sendDaemonCommand,
                    setActionLogs,
                    isStandalone,
                    userName: daemonCtx.userName,
                    onOpenHistory: (conversation) => {
                        if (conversation) setRemoteDialogActiveConv(conversation)
                        openHistoryModal()
                    },
                    onConversationChange: setRemoteDialogActiveConv,
                    onClose: closeRemoteDialog,
                }}
                cliStopDialog={{
                    open: cliStopDialogOpen,
                    targetConv: cliStopTargetConv,
                    onCancel: cancelCliStop,
                    onStopNow: async () => {
                        await confirmCliStop('hard')
                    },
                    onSaveAndStop: async () => {
                        await confirmCliStop('save')
                    },
                }}
                connectionBanner={{
                    wsStatus,
                    showReconnected,
                    loginUrl: daemonCtx.connectionLoginUrl,
                    onReconnect: daemonCtx.retryServerConnection,
                }}
                toastOverlay={{
                    toasts,
                    onDismiss: (id) => setToasts(prev => prev.filter(t => t.id !== id)),
                    onClick: (toast) => {
                        if (toast.targetKey) {
                            const matchedConv = resolveConversationByTarget(toast.targetKey)
                            if (matchedConv) {
                                focusConversationTab(matchedConv.tabKey, normalizedGroupAssignments)
                                handleShowHiddenConversation(matchedConv)
                                requestScrollToBottom(matchedConv.tabKey, 'toast-open')
                            }
                        }
                    },
                }}
                onboarding={{
                    open: showOnboarding,
                    onClose: () => {
                        try { localStorage.setItem('adhdev_onboarding_v1', 'done') } catch {}
                        setShowOnboarding(false)
                    },
                }}
                interactivePrompt={interactivePrompt}
            />
        </div>
    )
}
