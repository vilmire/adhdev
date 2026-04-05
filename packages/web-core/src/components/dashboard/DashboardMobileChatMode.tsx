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
import { compareConversationRecency, getConversationActivityAt, getConversationSortTimestamp, getConversationTimestamp } from './conversation-sort'
import type { MobileConversationListItem, MobileMachineCard } from './DashboardMobileChatShared'
import { buildLiveSessionInboxStateMap, getConversationInboxSurfaceState, getConversationLiveInboxState } from './DashboardMobileChatShared'
import { compareMachineEntries, getDaemonEntryActivityAt, getMachineDisplayName, isAcpEntry, isCliEntry } from '../../utils/daemon-utils'
import { normalizeTextContent } from '../../utils/text'
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
    wsStatus?: string
    isConnected?: boolean
    onShowHiddenConversation: (conversation: ActiveConversation) => void
    onShowAllHiddenConversations: () => void
}

function normalizePreviewText(content: unknown) {
    return normalizeTextContent(content)
}

function getConversationPreview(conversation: ActiveConversation) {
    const lastMessage = [...conversation.messages].reverse().find((message: any) => !(message as any)?._localId) as any
        || conversation.messages[conversation.messages.length - 1] as any
    const preview = normalizePreviewText(lastMessage?.content)
    if (preview) return preview
    if (conversation.title) return conversation.title
    return conversation.displaySecondary || 'No messages yet'
}

function getAvatarText(primary: string) {
    const text = primary.trim()
    if (!text) return '?'
    return text[0]!.toUpperCase()
}

function logMobileReadDebug(event: string, payload: Record<string, unknown>) {
    if (typeof window === 'undefined') return
    try {
        const debugEnabled = (import.meta as any).env?.DEV || window.localStorage.getItem('adhdev_mobile_debug') === '1'
        if (!debugEnabled) return
        console.debug(`[mobile-read] ${event}`, payload)
    } catch {
        // noop
    }
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
    wsStatus,
    isConnected,
    onShowHiddenConversation,
    onShowAllHiddenConversations,
}: DashboardMobileChatModeProps) {
    const [selectedTabKey, setSelectedTabKey] = useState<string | null>(() => conversations[0]?.tabKey || null)
    const [screen, setScreen] = useState<'inbox' | 'chat' | 'machine'>(() => (conversations[0] ? 'chat' : 'inbox'))
    const [section, setSection] = useState<DashboardMobileSection>('chats')
    const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null)
    const [machineBackTarget, setMachineBackTarget] = useState<'inbox' | 'chat'>('inbox')
    const [machineActionState, setMachineActionState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
    const [machineActionMessage, setMachineActionMessage] = useState('')
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
            .filter((entry: any) => entry.type === 'adhdev-daemon' || entry.daemonMode)
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
            displayPrimary: conversation.displayPrimary,
            inboxBucket: liveState.inboxBucket,
            unread: liveState.unread,
            lastSeenAt: liveState.lastSeenAt,
            lastUpdated: liveState.lastUpdated,
            activityAt: getConversationActivityAt(conversation, liveState.lastUpdated),
            readAt,
        })
        void sendDaemonCommand(conversation.daemonId || conversation.ideId, 'mark_session_seen', {
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
        const timestamp = getConversationSortTimestamp(conversation)
        const preview = getConversationPreview(conversation)
        const isOpenConversation = screen === 'chat' && selectedConversation?.tabKey === conversation.tabKey
        const surfaceState = getConversationInboxSurfaceState(conversation, liveSessionInboxState, {
            hideOpenTaskCompleteUnread: true,
            isOpenConversation,
        })
        return {
            conversation,
            timestamp,
            preview,
            unread: surfaceState.unread,
            requiresAction: surfaceState.requiresAction,
            isWorking: surfaceState.isWorking,
            inboxBucket: surfaceState.inboxBucket,
        }
    }).sort((a, b) => {
        const timestampDiff = b.timestamp - a.timestamp
        if (timestampDiff !== 0) return timestampDiff
        return compareConversationRecency(a.conversation, b.conversation)
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
                    displayPrimary: item.conversation.displayPrimary,
                    serverBucket: liveState.inboxBucket,
                    computedBucket: item.inboxBucket,
                    serverUnread: liveState.unread,
                    computedUnread: item.unread,
                    lastSeenAt: liveState.lastSeenAt,
                    lastUpdated: liveState.lastUpdated,
                    activityAt: getConversationActivityAt(item.conversation, liveState.lastUpdated),
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
            ? items.filter(item => item.conversation.daemonId === selectedMachineEntry.id || item.conversation.ideId === selectedMachineEntry.id)
            : [],
        [items, selectedMachineEntry],
    )
    const selectedMachineRecentLaunches = useMemo<MachineRecentLaunch[]>(
        () => {
            if (!selectedMachineEntry) return []
            const recentLaunches = ((selectedMachineEntry as any).recentLaunches || []) as any[]
            if (recentLaunches.length > 0) {
                return recentLaunches.map((launch) => ({
                    id: launch.id,
                    label: launch.title || launch.providerName || launch.providerType,
                    kind: launch.kind,
                    providerType: launch.providerType,
                    providerSessionId: launch.providerSessionId,
                    subtitle: launch.currentModel || launch.workspace || undefined,
                    workspace: launch.workspace,
                    currentModel: launch.currentModel,
                }))
            }

            return ides
                .filter((entry: any) => !(entry as any).daemonMode && (entry as any).daemonId === selectedMachineEntry.id)
                .map((entry: any) => {
                    const kind: MachineRecentLaunch['kind'] = isCliEntry(entry) ? 'cli' : isAcpEntry(entry) ? 'acp' : 'ide'
                    return {
                        id: `${kind}:${entry.type}:${entry.workspace || ''}`,
                        label: entry.activeChat?.title
                            || (isCliEntry(entry)
                                ? ((entry as any).cliName || entry.type)
                                : isAcpEntry(entry)
                                    ? ((entry as any).cliName || entry.type)
                                    : entry.type),
                        kind,
                        providerType: entry.type,
                        providerSessionId: (entry as any).providerSessionId,
                        subtitle: isAcpEntry(entry)
                            ? ((entry as any).currentModel || (entry as any).workspace || undefined)
                            : ((entry as any).workspace || undefined),
                        workspace: (entry as any).workspace || undefined,
                        currentModel: (entry as any).currentModel,
                        timestamp: entry.activeChat?.messages?.at?.(-1)?.timestamp || 0,
                    }
                })
                .sort((a, b) => b.timestamp - a.timestamp)
                .map(({ timestamp, ...session }) => session)
        },
        [ides, selectedMachineEntry],
    )
    const selectedMachineVersion = selectedMachineEntry?.version || (selectedMachineEntry as any)?.daemonVersion || null
    const selectedMachineNeedsUpgrade = !!selectedMachineEntry && !!selectedMachineVersion && !!appVersion && selectedMachineVersion !== appVersion
    const selectedMachineProviders = useMemo(
        () => ((selectedMachineEntry as any)?.availableProviders || []) as Array<{
            type: string
            displayName?: string
            icon?: string
            category?: string
        }>,
        [selectedMachineEntry],
    )
    const selectedMachineCliProviders = useMemo(
        () => selectedMachineProviders
            .filter(provider => provider.category === 'cli')
            .map(provider => ({
                type: provider.type,
                displayName: provider.displayName || provider.type,
                icon: provider.icon,
            })),
        [selectedMachineProviders],
    )
    const selectedMachineAcpProviders = useMemo(
        () => selectedMachineProviders
            .filter(provider => provider.category === 'acp')
            .map(provider => ({
                type: provider.type,
                displayName: provider.displayName || provider.type,
                icon: provider.icon,
            })),
        [selectedMachineProviders],
    )

    const machineCards = useMemo<MobileMachineCard[]>(() => {
        const groupedItems = new Map<string, MobileConversationListItem[]>()

        for (const item of items) {
            const key = item.conversation.daemonId || item.conversation.ideId
            const bucket = groupedItems.get(key)
            if (bucket) bucket.push(item)
            else groupedItems.set(key, [item])
        }

        return machineEntries.map((machineEntry) => {
            const machineItems = groupedItems.get(machineEntry.id) || []
            const latestItem = [...machineItems].sort((a, b) => b.timestamp - a.timestamp)[0] || null
            const latestConversation = latestItem?.conversation || null
            const unread = machineItems.filter(item => item.unread || item.requiresAction).length
            const statusLabel = machineEntry.status === 'online'
                ? 'Connected'
                : machineEntry.status || 'Unknown'
            const subtitleParts = [
                machineEntry.platform || 'machine',
                statusLabel,
            ].filter(Boolean)

            return {
                id: machineEntry.id,
                label: getMachineDisplayName(machineEntry, { fallbackId: machineEntry.id }),
                subtitle: subtitleParts.join(' · '),
                unread,
                total: machineItems.length,
                latestConversation,
                preview: latestConversation
                    ? `${latestConversation.displayPrimary} · ${getConversationPreview(latestConversation)}`
                    : 'No active conversations yet. Open the machine to launch an IDE, CLI, or ACP session.',
            }
        }).sort((a, b) => {
            const aTs = Math.max(
                a.latestConversation ? getConversationSortTimestamp(a.latestConversation) : 0,
                getDaemonEntryActivityAt(machineEntries.find((entry) => entry.id === a.id) as any),
            )
            const bTs = Math.max(
                b.latestConversation ? getConversationSortTimestamp(b.latestConversation) : 0,
                getDaemonEntryActivityAt(machineEntries.find((entry) => entry.id === b.id) as any),
            )
            if (bTs !== aTs) return bTs - aTs
            return a.label.localeCompare(b.label)
        })
    }, [items, machineEntries])

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
        setSection('machines')
        setMachineBackTarget('inbox')
        setScreen('machine')
    }, [])

    const handleOpenConversationMachine = useCallback((conversation: ActiveConversation) => {
        const machineId = conversation.daemonId || conversation.ideId?.split(':')[0] || conversation.ideId
        if (!machineId) return
        setSelectedMachineId(machineId)
        setMachineActionState('idle')
        setMachineActionMessage('')
        setSection('machines')
        setMachineBackTarget('chat')
        setScreen('machine')
    }, [])

    const handleBackFromMachine = useCallback(() => {
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
        opts?: { workspaceId?: string | null; workspacePath?: string | null; resumeSessionId?: string | null },
    ) => {
        try {
            setMachineActionState('loading')
            setMachineActionMessage(`Launching ${providerType}…`)
            const payload: Record<string, unknown> = { cliType: providerType }
            if (opts?.workspacePath?.trim()) payload.dir = opts.workspacePath.trim()
            else if (opts?.workspaceId) payload.workspaceId = opts.workspaceId
            if (opts?.resumeSessionId) payload.resumeSessionId = opts.resumeSessionId
            const res: any = await sendDaemonCommand(machineId, 'launch_cli', payload)
            const result = res?.result || res
            const launchedSessionId = result?.sessionId || result?.id
            if (res?.success && launchedSessionId) {
                setMachineActionState('done')
                setMachineActionMessage(`${providerType} launched`)
                navigate(`/dashboard?activeTab=${encodeURIComponent(launchedSessionId)}`)
                return
            }
            setMachineActionState('error')
            setMachineActionMessage(res?.error || result?.error || `Could not launch ${kind.toUpperCase()} workspace`)
        } catch (error) {
            setMachineActionState('error')
            setMachineActionMessage(error instanceof Error ? error.message : `Could not launch ${kind.toUpperCase()} workspace`)
        }
    }, [navigate, sendDaemonCommand])

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
        <div className="dashboard-mobile-chat">
            {screen === 'chat' && selectedConversation ? (
                <DashboardMobileChatRoom
                    selectedConversation={selectedConversation}
                    isAcp={isAcpConv(selectedConversation)}
                    selectedIdeEntry={selectedIdeEntry}
                    actionLogs={actionLogs}
                    userName={userName}
                    isSendingChat={cmds.isSendingChat}
                    isFocusingAgent={cmds.isFocusingAgent}
                    onBack={handleBackFromConversation}
                    onOpenNativeConversation={handleOpenNativeConversation}
                    onOpenMachine={handleOpenConversationMachine}
                    onOpenHistory={onOpenHistory}
                    onOpenRemote={onOpenRemote}
                    cliViewMode={selectedCliViewMode}
                    onSetCliViewMode={async mode => {
                        if (!selectedConversation) return
                        if (selectedCliViewMode === mode) return
                        try {
                            await sendDaemonCommand(selectedConversation.daemonId || selectedConversation.ideId, 'set_cli_view_mode', {
                                targetSessionId: selectedConversation.sessionId,
                                cliType: selectedConversation.ideType || selectedConversation.agentType,
                                mode,
                            })
                        } catch (error) {
                            console.error('Failed to switch CLI view mode:', error)
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
                    onLaunchWorkspaceProvider={(kind, providerType, opts) => handleLaunchWorkspaceProvider(selectedMachineEntry.id, kind, providerType, opts)}
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
