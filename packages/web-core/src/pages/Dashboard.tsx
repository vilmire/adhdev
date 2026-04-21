import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'

import { useDaemons } from '../compat'
import { useTransport } from '../context/TransportContext'
import { useDaemonMetadataLoader } from '../hooks/useDaemonMetadataLoader'
import { useDaemonMachineRuntimeLoader } from '../hooks/useDaemonMachineRuntimeLoader'
import type { DaemonData } from '../types'
import { isCliConv, isAcpConv, getCliConversationViewMode } from '../components/dashboard/types'
import {
    applyCliViewModeOverrides,
    getCliViewModeForSession,
    isExpectedCliViewModeTransportError,
    reconcileCliViewModeOverrides,
    shouldRetainOptimisticCliViewModeOverrideOnError,
} from '../components/dashboard/cliViewModeOverrides'
import { useWarmSessionChatTailControllers } from '../components/dashboard/session-chat-tail-controller'
import { useHiddenTabs, getHiddenConversationStorageKey, isConversationHidden } from '../hooks/useHiddenTabs'
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
import { useDashboardNotifications } from '../hooks/useDashboardNotifications'

import ConnectionBanner from '../components/dashboard/ConnectionBanner'
import TerminalBackendBanner from '../components/dashboard/TerminalBackendBanner'
import DashboardMainView from '../components/dashboard/DashboardMainView'
import DashboardOverlays from '../components/dashboard/DashboardOverlays'
import type { SavedSessionHistoryEntry } from '../components/dashboard/HistoryModal'
import DashboardVersionBanner from '../components/dashboard/DashboardVersionBanner'
import type { Toast } from '../components/dashboard/ToastContainer'
import type { DashboardMobileSection } from '../components/dashboard/DashboardMobileBottomNav'
import { getMobileDashboardMode, subscribeMobileDashboardMode } from '../components/settings/MobileDashboardModeSection'
import { getDashboardWarmChatTailOptions } from '../utils/dashboard-warm-chat-tail'
import { buildLiveSessionInboxStateMap, getConversationLiveInboxState } from '../components/dashboard/DashboardMobileChatShared'
import { buildConversationIdentity, getConversationHistorySessionId } from '../components/dashboard/conversation-identity'
import { getConversationActiveTabTarget, getConversationMachineId, getConversationProviderType } from '../components/dashboard/conversation-selectors'
import { getConversationTimestamp } from '../components/dashboard/conversation-sort'
import { compareMachineEntries, getMachineDisplayName, getProviderSummaryValue, isAcpEntry, isCliEntry } from '../utils/daemon-utils'
import { resolveDashboardSessionTargetFromEntry } from '../utils/dashboard-route-paths'
import { getDesktopAutoReadPlan, getDesktopAutoReadScheduleDecision } from '../utils/dashboard-auto-read'
import { browseMachineDirectories } from '../components/machine/workspaceBrowse'
import type { WorkspaceLaunchKind } from './machine/types'

interface PendingDashboardLaunch {
    machineId: string
    kind: WorkspaceLaunchKind
    providerType: string
    workspacePath?: string | null
    resumeSessionId?: string | null
    startedAt: number
}

function getRouteMachineId(id: string | null | undefined) {
    if (!id) return ''
    const value = String(id)
    return value.includes(':') ? value.split(':')[0] || value : value
}

function normalizeWorkspacePath(path: string | null | undefined) {
    return String(path || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase()
}

function isP2PLaunchTimeout(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '')
    return message.includes('P2P command timeout')
}

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
    const [cliStopTargetConv, setCliStopTargetConv] = useState<import('../components/dashboard/types').ActiveConversation | null>(null)
    const [savedHistorySessions, setSavedHistorySessions] = useState<SavedSessionHistoryEntry[]>([])
    const [isSavedHistoryLoading, setIsSavedHistoryLoading] = useState(false)
    const [resumingSavedHistorySessionId, setResumingSavedHistorySessionId] = useState<string | null>(null)
    const [mobileViewMode, setMobileViewMode] = useState<'chat' | 'workspace'>(() => getMobileDashboardMode())
    useEffect(() => subscribeMobileDashboardMode(setMobileViewMode), [])
    const warmChatTailOptions = useMemo(
        () => getDashboardWarmChatTailOptions({ isMobile, mobileViewMode }),
        [isMobile, mobileViewMode],
    )
    const [actionLogs, setActionLogs] = useState<{ routeId: string; text: string; timestamp: number }[]>([])
    const [localUserMessages, setLocalUserMessages] = useState<Record<string, { role: string; content: string; timestamp: number; _localId: string }[]>>({})
    const [cliViewModeOverrides, setCliViewModeOverrides] = useState<Record<string, 'chat' | 'terminal'>>({})
    const [clearedTabs, setClearedTabs] = useState<Record<string, number>>({})
    const [desktopActiveTabKey, setDesktopActiveTabKey] = useState<string | null>(null)
    const [scrollToBottomRequest, setScrollToBottomRequest] = useState<{ tabKey: string; nonce: number } | null>(null)
    const [pendingDashboardLaunch, setPendingDashboardLaunch] = useState<PendingDashboardLaunch | null>(null)
    const savedHistoryRefreshKeyRef = useRef<string | null>(null)
    useDevRenderTrace('Dashboard', {
        ideCount: ides.length,
        toastCount: toasts.length,
        focusedGroup,
        groupCount: Object.keys(groupAssignments).length,
        localMessageTabs: Object.keys(localUserMessages).length,
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
        for (const entry of machineEntries) {
            const needsMetadata = !entry.detectedIdes
                || !entry.availableProviders
                || !entry.recentLaunches
                || !entry.workspaces
            if (needsMetadata) {
                void loadDaemonMetadata(entry.id, { minFreshMs: 30_000 }).catch(() => {})
            }

            const info = entry.machine
            const needsRuntime = typeof info?.cpus !== 'number'
                || typeof info?.totalMem !== 'number'
                || typeof info?.arch !== 'string'
                || typeof info?.release !== 'string'
            if (needsRuntime) {
                void loadMachineRuntime(entry.id, { minFreshMs: 30_000 }).catch(() => {})
            }
        }
    }, [loadDaemonMetadata, loadMachineRuntime, machineEntries])

    const terminalBackend = daemonEntry?.terminalBackend || null
    const terminalBackendMachineLabel = daemonEntry
        ? getMachineDisplayName(daemonEntry, { fallbackId: daemonEntry.id })
        : null
    const terminalBackendMachineKey = daemonEntry?.id || null
    const effectiveIdes = useMemo(
        () => applyCliViewModeOverrides(ides, cliViewModeOverrides),
        [ides, cliViewModeOverrides],
    )
    // ─── Hidden Tabs ───
    const {
        hiddenTabs,
        hideTab: hideDashboardTab,
        toggleTab: toggleHiddenTab,
        showTab: showHiddenTab,
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
        localUserMessages,
        clearedTabs,
        hiddenTabs,
    })
    const hiddenConversationKeyByTabKey = useMemo(
        () => new Map(conversations.map(conversation => [conversation.tabKey, getHiddenConversationStorageKey(conversation)])),
        [conversations],
    )
    const hideConversationByTabKey = useCallback((tabKey: string) => {
        const targetKey = hiddenConversationKeyByTabKey.get(tabKey) || getHiddenConversationStorageKey({ tabKey })
        hideDashboardTab(targetKey)
    }, [hiddenConversationKeyByTabKey, hideDashboardTab])
    const toggleHiddenConversationByTabKey = useCallback((tabKey: string) => {
        const targetKey = hiddenConversationKeyByTabKey.get(tabKey) || getHiddenConversationStorageKey({ tabKey })
        toggleHiddenTab(targetKey)
    }, [hiddenConversationKeyByTabKey, toggleHiddenTab])
    const showConversationByTabKey = useCallback((tabKey: string) => {
        const targetKey = hiddenConversationKeyByTabKey.get(tabKey) || getHiddenConversationStorageKey({ tabKey })
        showHiddenTab(targetKey)
    }, [hiddenConversationKeyByTabKey, showHiddenTab])
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
        notificationStateBySessionId,
        markRead: markDashboardNotificationRead,
        markUnread: markDashboardNotificationUnread,
        markTargetRead: markDashboardNotificationTargetRead,
        deleteNotification: deleteDashboardNotification,
    } = useDashboardNotifications({
        conversations,
        liveSessionInboxState,
    })
    const handleMarkDashboardNotificationRead = useCallback((notificationId: string) => {
        const notification = notifications.find(record => record.id === notificationId)
        const readAt = Math.max(Date.now(), notification?.updatedAt || 0)
        markDashboardNotificationRead(notificationId, readAt)
        if (!notification?.sessionId) return
        void sendDaemonCommand(notification.machineId || notification.routeId, 'mark_session_seen', {
            sessionId: notification.sessionId,
            seenAt: readAt,
        }).catch(() => {})
    }, [markDashboardNotificationRead, notifications, sendDaemonCommand])
    const handleMarkDashboardNotificationUnread = useCallback((notificationId: string) => {
        const notification = notifications.find(record => record.id === notificationId)
        markDashboardNotificationUnread(notificationId)
        if (!notification?.sessionId) return
        void sendDaemonCommand(notification.machineId || notification.routeId, 'mark_notification_unread', {
            sessionId: notification.sessionId,
            notificationId: notification.id,
        }).catch(() => {})
    }, [markDashboardNotificationUnread, notifications, sendDaemonCommand])
    const handleDeleteDashboardNotification = useCallback((notificationId: string) => {
        const notification = notifications.find(record => record.id === notificationId)
        deleteDashboardNotification(notificationId)
        if (!notification?.sessionId) return
        void sendDaemonCommand(notification.machineId || notification.routeId, 'delete_notification', {
            sessionId: notification.sessionId,
            notificationId: notification.id,
        }).catch(() => {})
    }, [deleteDashboardNotification, notifications, sendDaemonCommand])
    const lastDesktopAutoReadKeyRef = useRef<string | null>(null)
    const pendingDesktopAutoReadKeyRef = useRef<string | null>(null)
    const pendingDesktopAutoReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const pendingDesktopAutoReadVisibleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const pendingDesktopAutoReadVisibilityHandlerRef = useRef<(() => void) | null>(null)

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
        const clearPendingDesktopAutoRead = () => {
            if (pendingDesktopAutoReadTimerRef.current) {
                clearTimeout(pendingDesktopAutoReadTimerRef.current)
                pendingDesktopAutoReadTimerRef.current = null
            }
            if (pendingDesktopAutoReadVisibleTimerRef.current) {
                clearTimeout(pendingDesktopAutoReadVisibleTimerRef.current)
                pendingDesktopAutoReadVisibleTimerRef.current = null
            }
            if (pendingDesktopAutoReadVisibilityHandlerRef.current) {
                document.removeEventListener('visibilitychange', pendingDesktopAutoReadVisibilityHandlerRef.current)
                pendingDesktopAutoReadVisibilityHandlerRef.current = null
            }
            pendingDesktopAutoReadKeyRef.current = null
        }

        if (isMobile) {
            clearPendingDesktopAutoRead()
            lastDesktopAutoReadKeyRef.current = null
            return
        }
        if (!activeConv?.sessionId) {
            clearPendingDesktopAutoRead()
            lastDesktopAutoReadKeyRef.current = null
            return
        }

        const liveState = getConversationLiveInboxState(activeConv, liveSessionInboxState)
        const autoReadPlan = getDesktopAutoReadPlan({
            tabKey: activeConv.tabKey,
            historySessionId: getConversationHistorySessionId(activeConv) || '',
            lastMessageHash: activeConv.lastMessageHash || '',
            lastMessageAt: Number(activeConv.lastMessageAt || 0),
            timestamp: getConversationTimestamp(activeConv),
            liveState,
        })
        const autoReadKey = autoReadPlan.autoReadKey
        const scheduleDecision = getDesktopAutoReadScheduleDecision({
            autoReadKey,
            shouldMarkSeen: autoReadPlan.shouldMarkSeen,
            completedKey: lastDesktopAutoReadKeyRef.current,
            pendingKey: pendingDesktopAutoReadKeyRef.current,
        })

        if (!autoReadPlan.shouldMarkSeen) {
            if (scheduleDecision.shouldCancelPending) clearPendingDesktopAutoRead()
            lastDesktopAutoReadKeyRef.current = autoReadKey
            return
        }
        if (!scheduleDecision.shouldSchedule) return
        if (scheduleDecision.shouldCancelPending) clearPendingDesktopAutoRead()

        const activeConvIdentity = buildConversationIdentity(activeConv)
        const doMarkSeen = () => {
            if (document.visibilityState !== 'visible') return
            if (lastDesktopAutoReadKeyRef.current === autoReadKey) return
            lastDesktopAutoReadKeyRef.current = autoReadKey
            pendingDesktopAutoReadKeyRef.current = null
            pendingDesktopAutoReadTimerRef.current = null
            pendingDesktopAutoReadVisibleTimerRef.current = null
            if (pendingDesktopAutoReadVisibilityHandlerRef.current) {
                document.removeEventListener('visibilitychange', pendingDesktopAutoReadVisibilityHandlerRef.current)
                pendingDesktopAutoReadVisibilityHandlerRef.current = null
            }

            const readAt = autoReadPlan.readAt
            markDashboardNotificationTargetRead({
                ...activeConvIdentity,
            }, readAt)

            void sendDaemonCommand(activeConv.daemonId || activeConv.routeId, 'mark_session_seen', {
                sessionId: activeConv.sessionId,
                seenAt: readAt,
            }).catch(() => {})
        }

        pendingDesktopAutoReadKeyRef.current = scheduleDecision.nextPendingKey

        if (document.visibilityState === 'visible') {
            pendingDesktopAutoReadTimerRef.current = setTimeout(doMarkSeen, 1500)
            const onVisChange = () => {
                if (document.visibilityState === 'visible') return
                if (pendingDesktopAutoReadTimerRef.current) {
                    clearTimeout(pendingDesktopAutoReadTimerRef.current)
                    pendingDesktopAutoReadTimerRef.current = null
                }
            }
            pendingDesktopAutoReadVisibilityHandlerRef.current = onVisChange
            document.addEventListener('visibilitychange', onVisChange)
            return
        }

        const onVisible = () => {
            if (document.visibilityState !== 'visible') return
            if (pendingDesktopAutoReadVisibleTimerRef.current) {
                clearTimeout(pendingDesktopAutoReadVisibleTimerRef.current)
            }
            pendingDesktopAutoReadVisibleTimerRef.current = setTimeout(doMarkSeen, 800)
            if (pendingDesktopAutoReadVisibilityHandlerRef.current) {
                document.removeEventListener('visibilitychange', pendingDesktopAutoReadVisibilityHandlerRef.current)
                pendingDesktopAutoReadVisibilityHandlerRef.current = null
            }
        }
        pendingDesktopAutoReadVisibilityHandlerRef.current = onVisible
        document.addEventListener('visibilitychange', onVisible)
    }, [activeConv, isMobile, liveSessionInboxState, markDashboardNotificationTargetRead, sendDaemonCommand])

    useEffect(() => () => {
        if (pendingDesktopAutoReadTimerRef.current) clearTimeout(pendingDesktopAutoReadTimerRef.current)
        if (pendingDesktopAutoReadVisibleTimerRef.current) clearTimeout(pendingDesktopAutoReadVisibleTimerRef.current)
        if (pendingDesktopAutoReadVisibilityHandlerRef.current) {
            document.removeEventListener('visibilitychange', pendingDesktopAutoReadVisibilityHandlerRef.current)
        }
    }, [])

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
        const routeTarget = historyTargetConv.daemonId || historyTargetConv.routeId || ''
        const providerType = getConversationProviderType(historyTargetConv)
        return `${routeTarget}:${providerType}`
    }, [historyTargetConv, isSavedSessionHistoryTarget])
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

    const handleBrowseMachineDirectory = useCallback(async (machineId: string, path: string) => (
        browseMachineDirectories(sendDaemonCommand, machineId, path)
    ), [sendDaemonCommand])

    const handleSaveMachineWorkspace = useCallback(async (machineId: string, path: string) => {
        if (!path.trim()) return { ok: false, error: 'Choose a workspace path first.' }
        try {
            const res: any = await sendDaemonCommand(machineId, 'workspace_add', { path: path.trim() })
            if (res?.success) return { ok: true }
            return { ok: false, error: res?.error || 'Could not save workspace' }
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Could not save workspace' }
        }
    }, [sendDaemonCommand])

    const handleLaunchMachineIde = useCallback(async (machineId: string, ideType: string, opts?: { workspacePath?: string | null }) => {
        try {
            const payload: Record<string, unknown> = { ideType, enableCdp: true }
            if (opts?.workspacePath?.trim()) payload.workspace = opts.workspacePath.trim()
            const res: any = await sendDaemonCommand(machineId, 'launch_ide', payload)
            if (!res?.success && res?.success !== undefined) {
                return { ok: false, error: res?.error || 'Could not launch IDE' }
            }
            setPendingDashboardLaunch({
                machineId,
                kind: 'ide',
                providerType: ideType,
                workspacePath: opts?.workspacePath || null,
                startedAt: Date.now(),
            })
            return { ok: true }
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Could not launch IDE' }
        }
    }, [sendDaemonCommand])

    const handleLaunchMachineProvider = useCallback(async (
        machineId: string,
        kind: 'cli' | 'acp',
        providerType: string,
        opts?: {
            workspaceId?: string | null
            workspacePath?: string | null
            resumeSessionId?: string | null
            cliArgs?: string[]
            initialModel?: string | null
        },
    ) => {
        const startedAt = Date.now()
        try {
            const payload: Record<string, unknown> = { cliType: providerType }
            if (opts?.workspacePath?.trim()) payload.dir = opts.workspacePath.trim()
            else if (opts?.workspaceId) payload.workspaceId = opts.workspaceId
            if (opts?.resumeSessionId?.trim()) payload.resumeSessionId = opts.resumeSessionId.trim()
            if (Array.isArray(opts?.cliArgs) && opts.cliArgs.length > 0) payload.cliArgs = opts.cliArgs
            if (opts?.initialModel?.trim()) payload.initialModel = opts.initialModel.trim()
            const res: any = await sendDaemonCommand(machineId, 'launch_cli', payload)
            const result = res?.result || res
            const launchedSessionId = result?.sessionId || result?.id
            if (res?.success && launchedSessionId) {
                handleRequestOpenSession(launchedSessionId)
                return { ok: true }
            }
            if (res?.success) {
                setPendingDashboardLaunch({
                    machineId,
                    kind,
                    providerType,
                    workspacePath: opts?.workspacePath || null,
                    resumeSessionId: opts?.resumeSessionId || null,
                    startedAt,
                })
                return { ok: true }
            }
            return { ok: false, error: res?.error || result?.error || `Could not launch ${kind.toUpperCase()} session` }
        } catch (error) {
            if (isP2PLaunchTimeout(error)) {
                setPendingDashboardLaunch({
                    machineId,
                    kind,
                    providerType,
                    workspacePath: opts?.workspacePath || null,
                    resumeSessionId: opts?.resumeSessionId || null,
                    startedAt,
                })
                return { ok: true }
            }
            return { ok: false, error: error instanceof Error ? error.message : `Could not launch ${kind.toUpperCase()} session` }
        }
    }, [handleRequestOpenSession, sendDaemonCommand])

    const handleListMachineSavedSessions = useCallback(async (
        machineId: string,
        providerType: string,
    ): Promise<SavedSessionHistoryEntry[]> => {
        if (!machineId || !providerType) return []
        try {
            const raw: any = await sendDaemonCommand(machineId, 'list_saved_sessions', {
                providerType,
                kind: 'cli',
                limit: 30,
            })
            const result = raw?.result ?? raw
            return Array.isArray(result?.sessions) ? result.sessions : []
        } catch (error) {
            console.error('List saved sessions failed', error)
            return []
        }
    }, [sendDaemonCommand])

    useEffect(() => {
        if (!pendingDashboardLaunch) return

        const normalizedTargetWorkspace = normalizeWorkspacePath(pendingDashboardLaunch.workspacePath)
        const matchingEntry = ides.find((entry) => {
            if (!entry || entry.type === 'adhdev-daemon') return false
            const entryMachineId = getRouteMachineId(entry.daemonId || entry.id)
            if (entryMachineId !== pendingDashboardLaunch.machineId) return false

            const entryKind: WorkspaceLaunchKind = isCliEntry(entry)
                ? 'cli'
                : isAcpEntry(entry)
                    ? 'acp'
                    : 'ide'
            if (entryKind !== pendingDashboardLaunch.kind) return false

            const entryProviderType = String(entry.agentType || entry.type || '')
            if (entryProviderType !== pendingDashboardLaunch.providerType) return false

            if (pendingDashboardLaunch.resumeSessionId) {
                const entryProviderSessionId = String(entry.providerSessionId || '')
                return entryProviderSessionId === pendingDashboardLaunch.resumeSessionId
            }

            if (normalizedTargetWorkspace) {
                const entryWorkspace = normalizeWorkspacePath(entry.workspace || entry.runtimeWorkspaceLabel)
                if (!entryWorkspace) return false
                return entryWorkspace === normalizedTargetWorkspace
            }

            const activityAt = Number(
                entry.lastUpdated
                || entry._lastUpdate
                || entry.timestamp
                || entry.activeChat?.messages?.at?.(-1)?.timestamp
                || 0,
            )
            return activityAt >= (pendingDashboardLaunch.startedAt - 5_000)
        })

        if (!matchingEntry) return

        const targetSessionId = resolveDashboardSessionTargetFromEntry({
            entrySessionId: matchingEntry.sessionId,
            entryInstanceId: matchingEntry.instanceId,
            entryRouteId: matchingEntry.id,
            conversations,
        })

        if (!targetSessionId) return

        setPendingDashboardLaunch(null)
        handleRequestOpenSession(targetSessionId)
    }, [conversations, handleRequestOpenSession, ides, pendingDashboardLaunch])

    useEffect(() => {
        if (!pendingDashboardLaunch) return
        const timeout = window.setTimeout(() => {
            setPendingDashboardLaunch(current => {
                if (!current || current.startedAt !== pendingDashboardLaunch.startedAt) return current
                return null
            })
        }, 45_000)
        return () => window.clearTimeout(timeout)
    }, [pendingDashboardLaunch])

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
        handleRefreshHistory,
    } = useDashboardSessionCommands({
        sendDaemonCommand,
        activeConv,
        chats: ides.find(entry => entry.id === activeConv?.routeId)?.chats,
        updateRouteChats,
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
        chats: ides.find(entry => entry.id === historyTargetConv?.routeId)?.chats,
        updateRouteChats,
        setToasts,
        setLocalUserMessages,
        setClearedTabs,
    })

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

    const performActiveCliStop = useCallback(async (
        mode: 'hard' | 'save',
        conversation?: import('../components/dashboard/types').ActiveConversation | null,
    ) => {
        const targetConv = conversation || cliStopTargetConv || activeConv
        if (!targetConv || (!isCliConv(targetConv) && !isAcpConv(targetConv))) return
        const cliType = getConversationProviderType(targetConv)
        const daemonId = targetConv.routeId || targetConv.daemonId || ''
        try {
            await sendDaemonCommand(daemonId, 'stop_cli', {
                cliType,
                targetSessionId: targetConv.sessionId,
                mode,
            })
        } catch (e: any) {
            console.error('Stop CLI failed:', e)
        }
    }, [activeConv, cliStopTargetConv, sendDaemonCommand])

    const handleActiveCliStop = useCallback(async (conversation?: import('../components/dashboard/types').ActiveConversation) => {
        const targetConv = conversation || activeConv
        if (!targetConv || (!isCliConv(targetConv) && !isAcpConv(targetConv))) return
        setCliStopTargetConv(targetConv)
        setCliStopDialogOpen(true)
    }, [activeConv])

    const activeCliViewMode = useMemo(() => {
        if (!activeConv || !isCliConv(activeConv) || isAcpConv(activeConv)) return null
        return getCliConversationViewMode(activeConv)
    }, [activeConv])

    const setActiveCliViewMode = useCallback(async (mode: 'chat' | 'terminal') => {
        if (!activeConv || !isCliConv(activeConv) || isAcpConv(activeConv)) return
        const currentMode = getCliConversationViewMode(activeConv)
        if (currentMode === mode) return
        const sessionId = activeConv.sessionId
        if (sessionId) {
            setCliViewModeOverrides((prev) => ({ ...prev, [sessionId]: mode }))
        }
        try {
            await sendDaemonCommand(getConversationMachineId(activeConv) || activeConv.routeId, 'set_cli_view_mode', {
                targetSessionId: activeConv.sessionId,
                cliType: getConversationProviderType(activeConv),
                mode,
            })
        } catch (error) {
            const shouldRetainOverride = shouldRetainOptimisticCliViewModeOverrideOnError(error)
            if (sessionId && !shouldRetainOverride) {
                setCliViewModeOverrides((prev) => {
                    const next = { ...prev }
                    if (currentMode === getCliViewModeForSession(ides, sessionId)) {
                        delete next[sessionId]
                    } else {
                        next[sessionId] = currentMode
                    }
                    return next
                })
            }
            if (!isExpectedCliViewModeTransportError(error)) {
                console.error('Failed to switch CLI view mode:', error)
            } else {
                console.warn(
                    shouldRetainOverride
                        ? 'CLI view mode result was lost after send; keeping optimistic mode override:'
                        : 'Skipped CLI view mode switch:',
                    error instanceof Error ? error.message : String(error),
                )
            }
        }
    }, [activeConv, ides, sendDaemonCommand])

    const {
        versionMismatchDaemons,
        hasRequiredVersionDaemons,
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
            const activeTabTarget = getConversationActiveTabTarget(conversation)
            if (activeTabTarget) next.set('activeTab', activeTabTarget)
            else next.delete('activeTab')
            return next
        }, { replace: true })
    }, [setSearchParams])

    const handleShowHiddenConversation = useCallback((conversation: import('../components/dashboard/types').ActiveConversation) => {
        showConversationByTabKey(conversation.tabKey)
        handleOpenDesktopConversation(conversation)
    }, [handleOpenDesktopConversation, showConversationByTabKey])

    const handleHideConversation = useCallback((conversation: import('../components/dashboard/types').ActiveConversation) => {
        hideConversationByTabKey(conversation.tabKey)
    }, [hideConversationByTabKey])

    return (
        <div className="page-dashboard flex-1 min-h-0 bg-bg-primary text-text-primary flex flex-col overflow-hidden">

            <ConnectionBanner wsStatus={wsStatus} showReconnected={showReconnected} />
            <TerminalBackendBanner
                terminalBackend={terminalBackend}
                isStandalone={isStandalone}
                machineLabel={terminalBackendMachineLabel}
                machineKey={terminalBackendMachineKey}
            />

            {(!versionBannerDismissed || hasRequiredVersionDaemons) && (
                <DashboardVersionBanner
                    daemons={versionMismatchDaemons}
                    targetVersion={appVersion}
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
                setFocusedGroup={setFocusedGroup}
                moveTabToGroup={moveTabToGroup}
                splitTabRelative={splitTabRelative}
                closeGroup={closeGroup}
                handleResizeStart={handleResizeStart}
                groupActiveTabIds={groupActiveTabIds}
                setGroupActiveTabIds={setGroupActiveTabIds}
                groupTabOrders={groupTabOrders}
                setGroupTabOrders={setGroupTabOrders}
                toggleHiddenTab={toggleHiddenConversationByTabKey}
                visibleConversations={visibleConversations}
                hiddenConversations={hiddenConversations}
                requestedDesktopTabKey={requestedDesktopTabKey}
                onRequestedDesktopTabConsumed={consumeRequestedActiveTab}
                onDesktopActiveTabChange={setDesktopActiveTabKey}
                onHideConversation={handleHideConversation}
                onShowHiddenConversation={handleShowHiddenConversation}
                onShowAllHiddenConversations={showAllHiddenTabs}
                scrollToBottomRequest={scrollToBottomRequest}
                machineEntries={machineEntries}
                onBrowseMachineDirectory={handleBrowseMachineDirectory}
                onSaveMachineWorkspace={handleSaveMachineWorkspace}
                onLaunchMachineIde={handleLaunchMachineIde}
                onLaunchMachineProvider={handleLaunchMachineProvider}
                onListMachineSavedSessions={handleListMachineSavedSessions}
                notifications={notifications}
                notificationUnreadCount={notificationUnreadCount}
                notificationStateBySessionId={notificationStateBySessionId}
                liveSessionInboxState={liveSessionInboxState}
                onMarkNotificationRead={handleMarkDashboardNotificationRead}
                onMarkNotificationUnread={handleMarkDashboardNotificationUnread}
                onDeleteNotification={handleDeleteDashboardNotification}
                onMarkNotificationTargetRead={markDashboardNotificationTargetRead}
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
                cliStopTargetConv={cliStopTargetConv}
                onCancelCliStop={() => {
                    setCliStopDialogOpen(false)
                    setCliStopTargetConv(null)
                }}
                onStopCliNow={async () => {
                    setCliStopDialogOpen(false)
                    await performActiveCliStop('hard', cliStopTargetConv)
                    setCliStopTargetConv(null)
                }}
                onSaveCliAndStop={async () => {
                    setCliStopDialogOpen(false)
                    await performActiveCliStop('save', cliStopTargetConv)
                    setCliStopTargetConv(null)
                }}
                toasts={toasts}
                onDismissToast={(id) => setToasts(prev => prev.filter(t => t.id !== id))}
                onClickToast={(toast) => {
                    if (toast.targetKey) {
                        const matchedConv = resolveConversationByTarget(toast.targetKey)
                        if (matchedConv) {
                            setFocusedGroup(normalizedGroupAssignments.get(matchedConv.tabKey) ?? 0)
                            handleShowHiddenConversation(matchedConv)
                            setScrollToBottomRequest({ tabKey: matchedConv.tabKey, nonce: Date.now() })
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
