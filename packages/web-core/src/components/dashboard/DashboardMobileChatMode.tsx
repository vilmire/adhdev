import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DaemonData } from '../../types'
import type { ActiveConversation } from './types'
import { getCliConversationViewMode, isAcpConv, isCliConv } from './types'
import { useDashboardConversationCommands } from '../../hooks/useDashboardConversationCommands'
import DashboardMobileChatRoom from './DashboardMobileChatRoom'
import DashboardMobileChatInbox from './DashboardMobileChatInbox'
import DashboardMobileMachineScreen from './DashboardMobileMachineScreen'
import type { DashboardMobileSection } from './DashboardMobileBottomNav'
import { getConversationTimestamp } from './conversation-sort'
import type { MobileConversationListItem, MobileMachineCard } from './DashboardMobileChatShared'
import { buildLiveSessionInboxStateMap, getConversationInboxSurfaceState, getConversationLiveInboxState } from './DashboardMobileChatShared'
import { getConversationMachineId, getConversationProviderType } from './conversation-selectors'
import { getConversationPreviewText, getConversationTitle } from './conversation-presenters'
import { compareMachineEntries } from '../../utils/daemon-utils'
import { buildMobileMachineCards, buildSelectedMachineRecentLaunches } from './dashboard-mobile-chat-mode-helpers'
import type { MachineRecentLaunch } from '../../pages/machine/types'

declare const __APP_VERSION__: string

interface DashboardMobileChatModeProps {
    conversations: ActiveConversation[]
    hiddenConversations: ActiveConversation[]
    ides: DaemonData[]
    actionLogs: { ideId: string; text: string; timestamp: number }[]
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>
    setActionLogs: Dispatch<SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
    userName?: string
    requestedActiveTabKey?: string | null
    onRequestedActiveTabConsumed?: () => void
    requestedMachineId?: string | null
    onRequestedMachineConsumed?: () => void
    requestedMobileSection?: DashboardMobileSection | null
    onRequestedMobileSectionConsumed?: () => void
    onOpenHistory: (conversation?: ActiveConversation) => void
    onOpenRemote: (conversation: ActiveConversation) => void
    onStopCli?: (conversation?: ActiveConversation) => void | Promise<void>
    wsStatus?: string
    isConnected?: boolean
    onShowHiddenConversation: (conversation: ActiveConversation) => void
    onShowAllHiddenConversations: () => void
    onHideConversation?: (conversation: ActiveConversation) => void
    onOpenNewSession?: () => void
}

interface PendingWorkspaceLaunch {
    machineId: string
    kind: 'cli' | 'acp'
    providerType: string
    workspaceId?: string | null
    workspacePath?: string | null
    resumeSessionId?: string | null
    startedAt: number
}

function getAvatarText(primary: string) {
    const text = primary.trim()
    if (!text) return '?'
    return text[0]!.toUpperCase()
}

function logMobileReadDebug(event: string, payload: Record<string, unknown>) {
    if (typeof window === 'undefined') return
    try {
        const meta = import.meta as ImportMeta & { env?: { DEV?: boolean } }
        const debugEnabled = !!meta.env?.DEV || window.localStorage.getItem('adhdev_mobile_debug') === '1'
        if (!debugEnabled) return
        console.debug(`[mobile-read] ${event}`, payload)
    } catch {
        // noop
    }
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

function isExpectedCliViewModeError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '')
    return message.includes('P2P command timeout')
        || message.includes('P2P not connected')
        || message.includes('CLI session not found')
        || message.includes('CLI_SESSION_NOT_FOUND')
}

export default function DashboardMobileChatMode({
    conversations,
    hiddenConversations,
    ides,
    actionLogs,
    sendDaemonCommand,
    setLocalUserMessages,
    setActionLogs,
    isStandalone,
    userName,
    requestedActiveTabKey,
    onRequestedActiveTabConsumed,
    requestedMachineId,
    onRequestedMachineConsumed,
    requestedMobileSection,
    onRequestedMobileSectionConsumed,
    onOpenHistory,
    onOpenRemote,
    onStopCli,
    wsStatus,
    isConnected,
    onShowHiddenConversation,
    onShowAllHiddenConversations,
    onHideConversation,
    onOpenNewSession,
}: DashboardMobileChatModeProps) {
    const [selectedTabKey, setSelectedTabKey] = useState<string | null>(() => conversations[0]?.tabKey || null)
    const [screen, setScreen] = useState<'inbox' | 'chat' | 'machine'>(() => (conversations[0] ? 'chat' : 'inbox'))
    const [section, setSection] = useState<DashboardMobileSection>('chats')
    const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null)
    const [machineBackTarget, setMachineBackTarget] = useState<'inbox' | 'chat'>('inbox')
    const [machineActionState, setMachineActionState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
    const [machineActionMessage, setMachineActionMessage] = useState('')
    const [pendingWorkspaceLaunch, setPendingWorkspaceLaunch] = useState<PendingWorkspaceLaunch | null>(null)
    const lastAutoReadKeyRef = useRef<string | null>(null)
    const navigate = useNavigate()
    const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null

    const selectedConversation = useMemo(
        () => conversations.find(conversation => conversation.tabKey === selectedTabKey) || conversations[0] || null,
        [conversations, selectedTabKey],
    )
    const selectedIdeEntry = useMemo(
        () => selectedConversation ? ides.find(ide => ide.id === selectedConversation.ideId) : undefined,
        [ides, selectedConversation],
    )
    const selectedCliViewMode = useMemo(() => {
        if (!selectedConversation || isAcpConv(selectedConversation) || !isCliConv(selectedConversation)) return null
        return getCliConversationViewMode(selectedConversation)
    }, [selectedConversation])
    const machineEntries = useMemo(
        () => ides
            .filter(entry => entry.type === 'adhdev-daemon' || entry.daemonMode)
            .sort(compareMachineEntries),
        [ides],
    )
    const selectedMachineEntry = useMemo(
        () => machineEntries.find(machine => machine.id === selectedMachineId) || null,
        [machineEntries, selectedMachineId],
    )
    const liveSessionInboxState = useMemo(
        () => buildLiveSessionInboxStateMap(ides),
        [ides],
    )
    const cmds = useDashboardConversationCommands({
        sendDaemonCommand,
        activeConv: selectedConversation || undefined,
        setLocalUserMessages,
        setActionLogs,
        isStandalone,
    })

    const markConversationRead = useCallback((conversation: ActiveConversation | null) => {
        if (!conversation) return
        if (!conversation.sessionId) return
        const liveState = getConversationLiveInboxState(conversation, liveSessionInboxState)
        const readAt = Math.max(Date.now(), getConversationTimestamp(conversation), liveState.lastUpdated || 0)
        logMobileReadDebug('mark_read:start', {
            tabKey: conversation.tabKey,
            sessionId: conversation.sessionId,
            displayPrimary: getConversationTitle(conversation),
            inboxBucket: liveState.inboxBucket,
            unread: liveState.unread,
            lastSeenAt: liveState.lastSeenAt,
            lastUpdated: liveState.lastUpdated,
            activityAt: getConversationTimestamp(conversation),
            readAt,
        })
        void sendDaemonCommand(getConversationMachineId(conversation) || conversation.ideId, 'mark_session_seen', {
            sessionId: conversation.sessionId,
            seenAt: readAt,
        }).then((result) => {
            logMobileReadDebug('mark_read:result', {
                tabKey: conversation.tabKey,
                sessionId: conversation.sessionId,
                result,
            })
        }).catch((error) => {
            logMobileReadDebug('mark_read:error', {
                tabKey: conversation.tabKey,
                sessionId: conversation.sessionId,
                error: error instanceof Error ? error.message : String(error),
            })
        })
    }, [liveSessionInboxState, sendDaemonCommand])

    useEffect(() => {
        if (!selectedConversation) {
            setScreen('inbox')
            setSelectedTabKey(conversations[0]?.tabKey || null)
            lastAutoReadKeyRef.current = null
            return
        }
        if (screen !== 'chat') {
            lastAutoReadKeyRef.current = null
            return
        }
        const autoReadKey = `${selectedConversation.tabKey}:${selectedConversation.sessionId || ''}`
        if (lastAutoReadKeyRef.current === autoReadKey) return
        lastAutoReadKeyRef.current = autoReadKey
        markConversationRead(selectedConversation)
    }, [conversations, markConversationRead, screen, selectedConversation])

    useEffect(() => {
        if (!requestedActiveTabKey) return
        const matched = conversations.find(conversation => conversation.tabKey === requestedActiveTabKey)
        if (!matched) return
        setSelectedTabKey(matched.tabKey)
        setScreen('chat')
        onRequestedActiveTabConsumed?.()
    }, [conversations, onRequestedActiveTabConsumed, requestedActiveTabKey])

    useEffect(() => {
        if (!requestedMachineId) return
        const matched = machineEntries.find(machine => machine.id === requestedMachineId)
        if (!matched) return
        setSelectedMachineId(matched.id)
        setMachineActionState('idle')
        setMachineActionMessage('')
        setSection('machines')
        setMachineBackTarget('inbox')
        setScreen('machine')
        onRequestedMachineConsumed?.()
    }, [machineEntries, onRequestedMachineConsumed, requestedMachineId])

    useEffect(() => {
        if (!requestedMobileSection) return
        setSection(requestedMobileSection)
        setScreen('inbox')
        onRequestedMobileSectionConsumed?.()
    }, [onRequestedMobileSectionConsumed, requestedMobileSection])

    const items = useMemo<MobileConversationListItem[]>(() => conversations.map(conversation => {
        const isOpenConversation = screen === 'chat' && selectedConversation?.tabKey === conversation.tabKey
        const surfaceState = getConversationInboxSurfaceState(conversation, liveSessionInboxState, {
            hideOpenTaskCompleteUnread: true,
            isOpenConversation,
        })
        const timestamp = getConversationTimestamp(conversation)
        const preview = getConversationPreviewText(conversation)
        return {
            conversation,
            timestamp,
            preview,
            unread: surfaceState.unread,
            requiresAction: surfaceState.requiresAction,
            isWorking: surfaceState.isWorking,
            inboxBucket: surfaceState.inboxBucket,
        }
    }), [conversations, liveSessionInboxState, screen, selectedConversation])

    useEffect(() => {
        const taskCompleteItems = items.filter(item => item.inboxBucket === 'task_complete' || item.unread)
        if (taskCompleteItems.length === 0) return
        logMobileReadDebug('inbox_state', {
            screen,
            selectedTabKey,
            items: taskCompleteItems.map(item => {
                const liveState = getConversationLiveInboxState(item.conversation, liveSessionInboxState)
                return {
                    liveState,
                    tabKey: item.conversation.tabKey,
                    sessionId: item.conversation.sessionId,
                    displayPrimary: getConversationTitle(item.conversation),
                    serverBucket: liveState.inboxBucket,
                    computedBucket: item.inboxBucket,
                    serverUnread: liveState.unread,
                    computedUnread: item.unread,
                    lastSeenAt: liveState.lastSeenAt,
                    lastUpdated: liveState.lastUpdated,
                    activityAt: getConversationTimestamp(item.conversation),
                }
            }),
        })
    }, [items, liveSessionInboxState, screen, selectedTabKey])

    const attentionItems = useMemo(
        () => items.filter(item => item.requiresAction),
        [items],
    )

    const unreadItems = useMemo(
        () => items.filter(item => item.unread && !item.requiresAction),
        [items],
    )
    const workingItems = useMemo(
        () => items.filter(item => !item.unread && !item.requiresAction && item.isWorking),
        [items],
    )
    const completedItems = useMemo(
        () => items.filter(item => !item.unread && !item.requiresAction && !item.isWorking),
        [items],
    )
    const selectedMachineConversations = useMemo(
        () => selectedMachineEntry
            ? items.filter(item => getConversationMachineId(item.conversation) === selectedMachineEntry.id)
            : [],
        [items, selectedMachineEntry],
    )
    const selectedMachineRecentLaunches = useMemo<MachineRecentLaunch[]>(
        () => buildSelectedMachineRecentLaunches(selectedMachineEntry, ides),
        [ides, selectedMachineEntry],
    )
    const selectedMachineVersion = selectedMachineEntry?.version || null
    const selectedMachineNeedsUpgrade = !!selectedMachineEntry && !!selectedMachineVersion && !!appVersion && selectedMachineVersion !== appVersion
    const selectedMachineProviders = useMemo(
        () => selectedMachineEntry?.availableProviders || [],
        [selectedMachineEntry],
    )
    const selectedMachineCliProviders = useMemo(
        () => selectedMachineProviders
            .filter(provider => provider.category === 'cli' && provider.installed !== false)
            .map(provider => ({
                type: provider.type,
                displayName: provider.displayName || provider.type,
                icon: provider.icon,
            })),
        [selectedMachineProviders],
    )
    const selectedMachineAcpProviders = useMemo(
        () => selectedMachineProviders
            .filter(provider => provider.category === 'acp' && provider.installed !== false)
            .map(provider => ({
                type: provider.type,
                displayName: provider.displayName || provider.type,
                icon: provider.icon,
            })),
        [selectedMachineProviders],
    )

    const machineCards = useMemo<MobileMachineCard[]>(
        () => buildMobileMachineCards(machineEntries, items),
        [items, machineEntries],
    )

    const handleOpenConversation = useCallback((conversation: ActiveConversation) => {
        setSelectedTabKey(conversation.tabKey)
        setScreen('chat')
        markConversationRead(conversation)
    }, [markConversationRead])

    const handleOpenNativeConversation = useCallback((conversation: ActiveConversation) => {
        const nativeConversation = conversations.find(candidate => (
            candidate.ideId === conversation.ideId
            && candidate.streamSource === 'native'
        ))
        if (!nativeConversation) return
        setSelectedTabKey(nativeConversation.tabKey)
        setScreen('chat')
        markConversationRead(nativeConversation)
    }, [conversations, markConversationRead])

    const handleBackFromConversation = useCallback(() => {
        markConversationRead(selectedConversation)
        setScreen('inbox')
    }, [markConversationRead, selectedConversation])

    const handleOpenMachine = useCallback((machineId: string) => {
        setSelectedMachineId(machineId)
        setMachineActionState('idle')
        setMachineActionMessage('')
        setPendingWorkspaceLaunch(null)
        setSection('machines')
        setMachineBackTarget('inbox')
        setScreen('machine')
    }, [])

    const handleOpenConversationMachine = useCallback((conversation: ActiveConversation) => {
        const machineId = getConversationMachineId(conversation)
        if (!machineId) return
        setSelectedMachineId(machineId)
        setMachineActionState('idle')
        setMachineActionMessage('')
        setPendingWorkspaceLaunch(null)
        setSection('machines')
        setMachineBackTarget('chat')
        setScreen('machine')
    }, [])

    const handleBackFromMachine = useCallback(() => {
        setPendingWorkspaceLaunch(null)
        setScreen(machineBackTarget)
    }, [machineBackTarget])

    const handleLaunchDetectedIde = useCallback(async (machineId: string, ideType: string, opts?: { workspacePath?: string | null }) => {
        try {
            setMachineActionState('loading')
            setMachineActionMessage(`Launching ${ideType}…`)
            const payload: Record<string, unknown> = {
                ideType,
                enableCdp: true,
            }
            if (opts?.workspacePath?.trim()) payload.workspace = opts.workspacePath.trim()
            await sendDaemonCommand(machineId, 'launch_ide', payload)
            setMachineActionState('done')
            setMachineActionMessage(`${ideType} launch requested`)
        } catch (error) {
            setMachineActionState('error')
            setMachineActionMessage(error instanceof Error ? error.message : 'Launch IDE failed')
            console.error('Launch IDE failed', error)
        }
    }, [sendDaemonCommand])

    const handleAddWorkspace = useCallback(async (
        machineId: string,
        path: string,
        opts?: { createIfMissing?: boolean },
    ) => {
        if (!path.trim()) return
        try {
            setMachineActionState('loading')
            setMachineActionMessage(opts?.createIfMissing ? 'Creating folder…' : 'Saving workspace…')
            const res: any = await sendDaemonCommand(machineId, 'workspace_add', {
                path: path.trim(),
                createIfMissing: opts?.createIfMissing === true,
            })
            if (res?.success) {
                setMachineActionState('done')
                setMachineActionMessage(opts?.createIfMissing ? 'Folder created and workspace saved' : 'Workspace saved')
                return
            }
            setMachineActionState('error')
            setMachineActionMessage(res?.error || 'Could not save workspace')
        } catch (error) {
            setMachineActionState('error')
            setMachineActionMessage(error instanceof Error ? error.message : 'Could not save workspace')
        }
    }, [sendDaemonCommand])

    const handleMachineUpgrade = useCallback(async (machineId: string) => {
        try {
            setMachineActionState('loading')
            setMachineActionMessage('Starting daemon upgrade…')
            const res: any = await sendDaemonCommand(machineId, 'daemon_upgrade', {})
            if (res?.result?.alreadyLatest) {
                setMachineActionState('done')
                setMachineActionMessage(`Already on v${res?.result?.version || 'latest'}.`)
                return
            }
            if (res?.result?.upgraded || res?.result?.success) {
                setMachineActionState('done')
                setMachineActionMessage(`Upgrade to v${res?.result?.version || 'latest'} started. Daemon is restarting…`)
                return
            }
            setMachineActionState('error')
            setMachineActionMessage(res?.result?.error || 'Upgrade failed')
        } catch (error) {
            setMachineActionState('error')
            setMachineActionMessage(error instanceof Error ? error.message : 'Upgrade failed')
        }
    }, [sendDaemonCommand])

    const handleLaunchWorkspaceProvider = useCallback(async (
        machineId: string,
        kind: 'cli' | 'acp',
        providerType: string,
        opts?: {
            workspaceId?: string | null
            workspacePath?: string | null
            resumeSessionId?: string | null
            args?: string | null
            model?: string | null
        },
    ) => {
        const startedAt = Date.now()
        const pendingLaunch: PendingWorkspaceLaunch = {
            machineId,
            kind,
            providerType,
            workspaceId: opts?.workspaceId || null,
            workspacePath: opts?.workspacePath || null,
            resumeSessionId: opts?.resumeSessionId || null,
            startedAt,
        }
        try {
            setMachineActionState('loading')
            setMachineActionMessage(`Launching ${providerType}…`)
            setPendingWorkspaceLaunch(pendingLaunch)
            const payload: Record<string, unknown> = { cliType: providerType }
            if (opts?.workspacePath?.trim()) payload.dir = opts.workspacePath.trim()
            else if (opts?.workspaceId) payload.workspaceId = opts.workspaceId
            if (opts?.resumeSessionId) payload.resumeSessionId = opts.resumeSessionId
            if (opts?.args?.trim()) payload.cliArgs = opts.args.trim().split(/\s+/).filter(Boolean)
            if (opts?.model?.trim()) payload.initialModel = opts.model.trim()
            const res: any = await sendDaemonCommand(machineId, 'launch_cli', payload)
            const result = res?.result || res
            const launchedSessionId = result?.sessionId || result?.id
            if (res?.success && launchedSessionId) {
                setPendingWorkspaceLaunch(null)
                setMachineActionState('done')
                setMachineActionMessage(`${providerType} launched`)
                navigate(`/dashboard?activeTab=${encodeURIComponent(launchedSessionId)}`)
                return
            }
            if (res?.success) {
                setMachineActionState('loading')
                setMachineActionMessage(`${providerType} launch requested — waiting for session…`)
                return
            }
            setPendingWorkspaceLaunch(null)
            setMachineActionState('error')
            setMachineActionMessage(res?.error || result?.error || `Could not launch ${kind.toUpperCase()} workspace`)
        } catch (error) {
            if (isP2PLaunchTimeout(error)) {
                setMachineActionState('loading')
                setMachineActionMessage(`${providerType} launch requested — waiting for session…`)
                return
            }
            setPendingWorkspaceLaunch(null)
            setMachineActionState('error')
            setMachineActionMessage(error instanceof Error ? error.message : `Could not launch ${kind.toUpperCase()} workspace`)
        }
    }, [navigate, sendDaemonCommand])

    const handleListSavedSessions = useCallback(async (machineId: string, providerType: string) => {
        try {
            const raw: any = await sendDaemonCommand(machineId, 'list_saved_sessions', {
                providerType,
                kind: 'cli',
                limit: 30,
            })
            const result = raw?.result ?? raw
            return Array.isArray(result?.sessions) ? result.sessions : []
        } catch (error) {
            console.error('Failed to list saved sessions on mobile:', error)
            return []
        }
    }, [sendDaemonCommand])

    useEffect(() => {
        if (!pendingWorkspaceLaunch) return

        const normalizedTargetWorkspace = normalizeWorkspacePath(pendingWorkspaceLaunch.workspacePath)
        const matchingEntry = ides.find(entry => {
            if (!entry || entry.type === 'adhdev-daemon' || entry.daemonMode) return false
            const entryMachineId = getRouteMachineId(entry.daemonId || entry.id)
            if (entryMachineId !== pendingWorkspaceLaunch.machineId) return false

            const entryKind = entry.transport === 'acp'
                ? 'acp'
                : entry.transport === 'pty'
                    ? 'cli'
                    : null
            if (entryKind !== pendingWorkspaceLaunch.kind) return false

            const entryProviderType = String(entry.agentType || entry.ideType || entry.type || '')
            if (entryProviderType !== pendingWorkspaceLaunch.providerType) return false

            const entryProviderSessionId = String(entry.providerSessionId || '')
            if (pendingWorkspaceLaunch.resumeSessionId && entryProviderSessionId) {
                return entryProviderSessionId === pendingWorkspaceLaunch.resumeSessionId
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
            return activityAt >= (pendingWorkspaceLaunch.startedAt - 5_000)
        })

        if (!matchingEntry) return

        const targetSessionId = typeof matchingEntry.sessionId === 'string' && matchingEntry.sessionId
            ? matchingEntry.sessionId
            : typeof matchingEntry.instanceId === 'string' && matchingEntry.instanceId
                ? matchingEntry.instanceId
                : conversations.find((conversation) => conversation.ideId === matchingEntry.id)?.sessionId

        if (!targetSessionId) return

        setPendingWorkspaceLaunch(null)
        setMachineActionState('done')
        setMachineActionMessage(`${pendingWorkspaceLaunch.providerType} launched`)
        navigate(`/dashboard?activeTab=${encodeURIComponent(targetSessionId)}`)
    }, [conversations, ides, navigate, pendingWorkspaceLaunch])

    useEffect(() => {
        if (!pendingWorkspaceLaunch) return
        const timeout = window.setTimeout(() => {
            setPendingWorkspaceLaunch((current) => {
                if (!current || current.startedAt !== pendingWorkspaceLaunch.startedAt) return current
                setMachineActionState('error')
                setMachineActionMessage('Launch response timed out. The session may already be running in Dashboard.')
                return null
            })
        }, 45_000)
        return () => window.clearTimeout(timeout)
    }, [pendingWorkspaceLaunch])

    const handleOpenRecent = useCallback(async (session: MachineRecentLaunch) => {
        if (!selectedMachineEntry) return
        if (session.kind === 'ide' && session.providerType) {
            await handleLaunchDetectedIde(selectedMachineEntry.id, session.providerType, {
                workspacePath: session.workspace || null,
            })
            return
        }
        if ((session.kind === 'cli' || session.kind === 'acp') && session.providerType) {
            await handleLaunchWorkspaceProvider(selectedMachineEntry.id, session.kind, session.providerType, {
                workspacePath: session.workspace || null,
                resumeSessionId: session.providerSessionId || null,
            })
            return
        }
    }, [handleLaunchDetectedIde, handleLaunchWorkspaceProvider, selectedMachineEntry])

    return (
        <div className="dashboard-mobile-chat w-full min-w-0">
            {screen === 'chat' && selectedConversation ? (
                <DashboardMobileChatRoom
                    selectedConversation={selectedConversation}
                    isAcp={isAcpConv(selectedConversation)}
                    isStandalone={isStandalone}
                    selectedIdeEntry={selectedIdeEntry}
                    actionLogs={actionLogs}
                    userName={userName}
                    isSendingChat={cmds.isSendingChat}
                    isFocusingAgent={cmds.isFocusingAgent}
                    handleModalButton={cmds.handleModalButton}
                    handleRelaunch={cmds.handleRelaunch}
                    onBack={handleBackFromConversation}
                    onOpenNativeConversation={handleOpenNativeConversation}
                    onOpenMachine={handleOpenConversationMachine}
                    onHideConversation={onHideConversation}
                    onOpenHistory={onOpenHistory}
                    onOpenRemote={onOpenRemote}
                    onStopCli={onStopCli}
                    cliViewMode={selectedCliViewMode}
                    onSetCliViewMode={async mode => {
                        if (!selectedConversation) return
                        if (selectedCliViewMode === mode) return
                        try {
                            await sendDaemonCommand(getConversationMachineId(selectedConversation) || selectedConversation.ideId, 'set_cli_view_mode', {
                                targetSessionId: selectedConversation.sessionId,
                                cliType: getConversationProviderType(selectedConversation),
                                mode,
                            })
                        } catch (error) {
                            if (!isExpectedCliViewModeError(error)) {
                                console.error('Failed to switch CLI view mode:', error)
                            } else {
                                console.warn('Skipped CLI view mode switch:', error instanceof Error ? error.message : String(error))
                            }
                        }
                    }}
                    handleSendChat={cmds.handleSendChat}
                    handleFocusAgent={cmds.handleFocusAgent}
                />
            ) : screen === 'machine' && selectedMachineEntry ? (
                <DashboardMobileMachineScreen
                    selectedMachineEntry={selectedMachineEntry}
                    selectedMachineConversations={selectedMachineConversations}
                    selectedMachineRecentLaunches={selectedMachineRecentLaunches}
                    cliProviders={selectedMachineCliProviders}
                    acpProviders={selectedMachineAcpProviders}
                    selectedMachineNeedsUpgrade={selectedMachineNeedsUpgrade}
                    appVersion={appVersion}
                    machineAction={{ state: machineActionState, message: machineActionMessage }}
                    isStandalone={isStandalone}
                    section={section}
                    showBottomNav={machineBackTarget === 'inbox'}
                    onBack={handleBackFromMachine}
                    onSectionChange={(nextSection) => {
                        setSection(nextSection)
                        setScreen('inbox')
                    }}
                    onOpenConversation={handleOpenConversation}
                    onOpenRecent={handleOpenRecent}
                    onOpenMachineDetails={() => navigate(`/machines/${selectedMachineEntry.id}`)}
                    onMachineUpgrade={() => handleMachineUpgrade(selectedMachineEntry.id)}
                    onLaunchDetectedIde={(ideType, opts) => handleLaunchDetectedIde(selectedMachineEntry.id, ideType, opts)}
                    onAddWorkspace={(path, opts) => handleAddWorkspace(selectedMachineEntry.id, path, opts)}
                    onBrowseDirectory={async (path) => {
                        const res: any = await sendDaemonCommand(selectedMachineEntry.id, 'file_list_browse', { path })
                        if (!res?.success) {
                            throw new Error(res?.error || 'Could not browse folder')
                        }
                        const currentPath = typeof res?.path === 'string' ? res.path : path
                        const separator = currentPath.includes('\\') ? '\\' : '/'
                        const joinPath = (base: string, name: string) => {
                            if (/^[A-Za-z]:\\?$/.test(base)) {
                                return `${base.replace(/\\?$/, '\\')}${name}`
                            }
                            if (base === '/' || base === '\\') return `${separator}${name}`
                            return `${base.replace(/[\\/]+$/, '')}${separator}${name}`
                        }
                        const directories = Array.isArray(res?.files)
                            ? res.files
                                .filter((entry: any) => entry?.type === 'directory' && typeof entry?.name === 'string')
                                .map((entry: any) => ({
                                    name: entry.name as string,
                                    path: joinPath(currentPath, entry.name as string),
                                }))
                                .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
                            : []
                        return { path: currentPath, directories }
                    }}
                    onLaunchWorkspaceProvider={(kind, providerType, opts) => handleLaunchWorkspaceProvider(selectedMachineEntry.id, kind, providerType, opts)}
                    onListSavedSessions={(providerType) => handleListSavedSessions(selectedMachineEntry.id, providerType)}
                />
            ) : (
                <DashboardMobileChatInbox
                    section={section}
                    attentionItems={attentionItems}
                    unreadItems={unreadItems}
                    workingItems={workingItems}
                    completedItems={completedItems}
                    hiddenConversations={hiddenConversations}
                    machineCards={machineCards}
                    getAvatarText={getAvatarText}
                    onOpenConversation={handleOpenConversation}
                    onShowConversation={onShowHiddenConversation}
                    onShowAllHidden={onShowAllHiddenConversations}
                    onOpenNewSession={onOpenNewSession}
                    onOpenMachine={handleOpenMachine}
                    onOpenSettings={() => navigate('/settings')}
                    onSectionChange={setSection}
                    wsStatus={wsStatus}
                    isConnected={isConnected}
                    isStandalone={isStandalone}
                />
            )}
        </div>
    )
}
