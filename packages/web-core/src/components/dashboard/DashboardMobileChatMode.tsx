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
import { useDashboardMobileMachineActions } from './useDashboardMobileMachineActions'
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
    const machineActions = useDashboardMobileMachineActions({
        sendDaemonCommand,
        navigate,
        ides,
        conversations,
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
        machineActions.resetMachineAction()
        setSection('machines')
        setMachineBackTarget('inbox')
        setScreen('machine')
        onRequestedMachineConsumed?.()
    }, [machineActions, machineEntries, onRequestedMachineConsumed, requestedMachineId])

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
        machineActions.resetMachineAction()
        setSection('machines')
        setMachineBackTarget('inbox')
        setScreen('machine')
    }, [machineActions])

    const handleOpenConversationMachine = useCallback((conversation: ActiveConversation) => {
        const machineId = getConversationMachineId(conversation)
        if (!machineId) return
        setSelectedMachineId(machineId)
        machineActions.resetMachineAction()
        setSection('machines')
        setMachineBackTarget('chat')
        setScreen('machine')
    }, [machineActions])

    const handleBackFromMachine = useCallback(() => {
        machineActions.resetMachineAction()
        setScreen(machineBackTarget)
    }, [machineActions, machineBackTarget])

    const handleOpenRecent = useCallback(async (session: MachineRecentLaunch) => {
        if (!selectedMachineEntry) return
        await machineActions.handleOpenRecent(selectedMachineEntry.id, session)
    }, [machineActions, selectedMachineEntry])

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
                    machineAction={machineActions.machineAction}
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
                    onMachineUpgrade={() => machineActions.handleMachineUpgrade(selectedMachineEntry.id)}
                    onLaunchDetectedIde={(ideType, opts) => machineActions.handleLaunchDetectedIde(selectedMachineEntry.id, ideType, opts)}
                    onAddWorkspace={(path, opts) => machineActions.handleAddWorkspace(selectedMachineEntry.id, path, opts)}
                    onBrowseDirectory={(path) => machineActions.handleBrowseDirectory(selectedMachineEntry.id, path)}
                    onLaunchWorkspaceProvider={(kind, providerType, opts) => machineActions.handleLaunchWorkspaceProvider(selectedMachineEntry.id, kind, providerType, opts)}
                    onListSavedSessions={(providerType) => machineActions.handleListSavedSessions(selectedMachineEntry.id, providerType)}
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
