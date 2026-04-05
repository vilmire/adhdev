import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'

import { useDaemons } from '../compat'
import { useTransport } from '../context/TransportContext'
import type { DaemonData } from '../types'
import { isCliConv, isAcpConv, getCliConversationViewMode } from '../components/dashboard/types'
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
import type { SavedSessionHistoryEntry } from '../components/dashboard/HistoryModal'
import DashboardVersionBanner from '../components/dashboard/DashboardVersionBanner'
import type { Toast } from '../components/dashboard/ToastContainer'
import type { DashboardMobileSection } from '../components/dashboard/DashboardMobileBottomNav'
import { getMobileDashboardMode } from '../components/settings/MobileDashboardModeSection'
import { buildLiveSessionInboxStateMap, getConversationLiveInboxState } from '../components/dashboard/DashboardMobileChatShared'
import { getConversationTimestamp } from '../components/dashboard/conversation-sort'

export default function Dashboard() {
    const { sendCommand: sendDaemonCommand } = useTransport()
    const location = useLocation()
    const navigate = useNavigate()
    const [searchParams, setSearchParams] = useSearchParams()
    const urlActiveTab = searchParams.get('activeTab')
    const requestedRemoteTabTarget = (location.state as { openRemoteForTabKey?: string } | null)?.openRemoteForTabKey || null
    const requestedMachineId = (location.state as { openMachineId?: string } | null)?.openMachineId || null
    const requestedMobileSection = (location.state as { mobileSection?: DashboardMobileSection } | null)?.mobileSection || null

    const daemonCtx = useDaemons() as any
    const ides: DaemonData[] = daemonCtx.ides || []
    const { updateIdeChats } = daemonCtx
    const [showOnboarding, setShowOnboarding] = useState(() => {
        try { return !localStorage.getItem('adhdev_onboarding_v1') } catch { return false }
    })
    const toasts: Toast[] = daemonCtx.toasts || []
    const setToasts = (daemonCtx.setToasts || (() => {})) as React.Dispatch<React.SetStateAction<Toast[]>>
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
    const [savedHistorySessions, setSavedHistorySessions] = useState<SavedSessionHistoryEntry[]>([])
    const [isSavedHistoryLoading, setIsSavedHistoryLoading] = useState(false)
    const [resumingSavedHistorySessionId, setResumingSavedHistorySessionId] = useState<string | null>(null)
    const [mobileViewMode] = useState<'chat' | 'workspace'>(() => getMobileDashboardMode())
    const [actionLogs, setActionLogs] = useState<{ ideId: string; text: string; timestamp: number }[]>([])
    const [localUserMessages, setLocalUserMessages] = useState<Record<string, { role: string; content: string; timestamp: number; _localId: string }[]>>({})
    const [clearedTabs, setClearedTabs] = useState<Record<string, number>>({})
    const [desktopActiveTabKey, setDesktopActiveTabKey] = useState<string | null>(null)
    const savedHistoryRefreshKeyRef = useRef<string | null>(null)
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
    const {
        hiddenTabs,
        hideTab: hideDashboardTab,
        toggleTab: toggleHiddenTab,
        showTab: showHiddenTab,
        showAllTabs: showAllHiddenTabs,
    } = useHiddenTabs();
    const {
        chatIdes,
        conversations,
        visibleConversations,
        visibleTabKeys,
        resolveConversationBySessionId,
        resolveConversationByTarget,
    } = useDashboardConversations({
        ides,
        connectionStates,
        localUserMessages,
        clearedTabs,
        hiddenTabs,
    })
    const liveSessionInboxState = useMemo(
        () => buildLiveSessionInboxStateMap(ides),
        [ides],
    )
    const lastDesktopAutoReadKeyRef = useRef<string | null>(null)

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

    useEffect(() => {
        if (isMobile) {
            lastDesktopAutoReadKeyRef.current = null
            return
        }
        if (!activeConv?.sessionId) {
            lastDesktopAutoReadKeyRef.current = null
            return
        }

        const autoReadKey = `${activeConv.tabKey}:${activeConv.sessionId}`
        if (lastDesktopAutoReadKeyRef.current === autoReadKey) return
        lastDesktopAutoReadKeyRef.current = autoReadKey

        const liveState = getConversationLiveInboxState(activeConv, liveSessionInboxState)
        const readAt = Math.max(Date.now(), getConversationTimestamp(activeConv), liveState.lastUpdated || 0)

        void sendDaemonCommand(activeConv.daemonId || activeConv.ideId, 'mark_session_seen', {
            sessionId: activeConv.sessionId,
            seenAt: readAt,
        }).catch(() => {})
    }, [activeConv, isMobile, liveSessionInboxState, sendDaemonCommand])

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
    const isSavedSessionHistoryTarget = !!historyTargetConv && isCliConv(historyTargetConv) && !isAcpConv(historyTargetConv)
    const savedHistoryRefreshKey = useMemo(() => {
        if (!historyTargetConv || !isSavedSessionHistoryTarget) return null
        const routeTarget = historyTargetConv.daemonId || historyTargetConv.ideId || ''
        const providerType = historyTargetConv.agentType || historyTargetConv.ideType || ''
        return `${routeTarget}:${providerType}`
    }, [historyTargetConv, isSavedSessionHistoryTarget])
    const mobileChatConversations = useMemo(
        () => visibleConversations,
        [visibleConversations],
    )
    const showMobileChatMode = isMobile && mobileViewMode === 'chat'
    const hiddenConversations = useMemo(
        () => conversations.filter(conversation => hiddenTabs.has(conversation.tabKey)),
        [conversations, hiddenTabs],
    )

    useDashboardConversationMeta({
        visibleConversations,
        clearedTabs,
        setClearedTabs,
        setActionLogs,
    })

    useDashboardEventManager({
        ides,
        sendDaemonCommand,
        setToasts: setToasts as any,
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

    const handleRefreshSavedHistory = useCallback(async () => {
        if (!historyTargetConv || !isSavedSessionHistoryTarget || isSavedHistoryLoading) return
        setIsSavedHistoryLoading(true)
        try {
            const routeTarget = historyTargetConv.daemonId || historyTargetConv.ideId
            const providerType = historyTargetConv.agentType || historyTargetConv.ideType
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
        const routeTarget = historyTargetConv.daemonId || historyTargetConv.ideId
        const cliType = historyTargetConv.agentType || historyTargetConv.ideType
        try {
            setResumingSavedHistorySessionId(session.providerSessionId)
            const raw: any = await sendDaemonCommand(routeTarget, 'launch_cli', {
                cliType,
                dir: session.workspace,
                resumeSessionId: session.providerSessionId,
                initialModel: session.currentModel,
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
            setHistoryModalOpen(false)
        } catch (error) {
            console.error('Resume saved session failed', error)
        } finally {
            setResumingSavedHistorySessionId(null)
        }
    }, [historyTargetConv, isSavedSessionHistoryTarget, sendDaemonCommand, setSearchParams])

    useDashboardPageEffects({
        urlActiveTab: isMobile && !showMobileChatMode ? urlActiveTab : null,
        conversations,
        resolveConversationBySessionId,
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

    const activeCliViewMode = useMemo(() => {
        if (!activeConv || !isCliConv(activeConv) || isAcpConv(activeConv)) return null
        return getCliConversationViewMode(activeConv)
    }, [activeConv])

    const setActiveCliViewMode = useCallback(async (mode: 'chat' | 'terminal') => {
        if (!activeConv || !isCliConv(activeConv) || isAcpConv(activeConv)) return
        const currentMode = getCliConversationViewMode(activeConv)
        if (currentMode === mode) return
        try {
            await sendDaemonCommand(activeConv.daemonId || activeConv.ideId, 'set_cli_view_mode', {
                targetSessionId: activeConv.sessionId,
                cliType: activeConv.ideType || activeConv.agentType,
                mode,
            })
        } catch (error) {
            console.error('Failed to switch CLI view mode:', error)
        }
    }, [activeConv, sendDaemonCommand])

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

    const handleOpenDesktopConversation = useCallback((conversation: import('../components/dashboard/types').ActiveConversation) => {
        setDesktopActiveTabKey(conversation.tabKey)
        setSearchParams(prev => {
            const next = new URLSearchParams(prev)
            if (conversation.sessionId) next.set('activeTab', conversation.sessionId)
            else next.delete('activeTab')
            return next
        }, { replace: true })
    }, [setSearchParams])

    const handleShowHiddenConversation = useCallback((conversation: import('../components/dashboard/types').ActiveConversation) => {
        showHiddenTab(conversation.tabKey)
        handleOpenDesktopConversation(conversation)
    }, [handleOpenDesktopConversation, showHiddenTab])

    const handleHideConversation = useCallback((conversation: import('../components/dashboard/types').ActiveConversation) => {
        hideDashboardTab(conversation.tabKey)
    }, [hideDashboardTab])

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
                onStopCli={handleActiveCliStop}
                activeCliViewMode={activeCliViewMode}
                onSetActiveCliViewMode={setActiveCliViewMode}
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
                hiddenConversations={hiddenConversations}
                requestedDesktopTabKey={requestedDesktopTabKey}
                onRequestedDesktopTabConsumed={consumeRequestedActiveTab}
                onOpenAccount={!isStandalone ? () => navigate('/account') : undefined}
                onDesktopActiveTabChange={setDesktopActiveTabKey}
                onHideConversation={handleHideConversation}
                onShowHiddenConversation={handleShowHiddenConversation}
                onShowAllHiddenConversations={showAllHiddenTabs}
            />

            <style>{`
                body { overflow: hidden; overscroll-behavior: none; }
`}</style>
            <DashboardOverlays
                historyModalOpen={historyModalOpen}
                historyTargetConv={historyTargetConv}
                ides={ides}
                isHistoryCreatingChat={isHistoryCreatingChat}
                isHistoryRefreshingHistory={isSavedSessionHistoryTarget ? false : isHistoryRefreshingHistory}
                savedHistorySessions={savedHistorySessions}
                isSavedHistoryLoading={isSavedHistoryLoading}
                isResumingSavedHistorySessionId={resumingSavedHistorySessionId}
                onCloseHistory={() => setHistoryModalOpen(false)}
                onNewHistoryChat={handleHistoryNewChat}
                onSwitchHistorySession={handleHistorySwitchSession}
                onRefreshHistory={isSavedSessionHistoryTarget ? handleRefreshSavedHistory : handleHistoryRefresh}
                onResumeSavedHistorySession={handleResumeSavedHistorySession}
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
                            handleShowHiddenConversation(matchedConv)
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
