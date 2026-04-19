import { useCallback, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DaemonData } from '../../types'
import type { ActiveConversation } from './types'
import { getCliConversationViewMode, isAcpConv, isCliConv } from './types'
import {
    isExpectedCliViewModeTransportError,
    shouldRetainOptimisticCliViewModeOverrideOnError,
} from './cliViewModeOverrides'
import { useDashboardConversationCommands } from '../../hooks/useDashboardConversationCommands'
import DashboardMobileChatRoom from './DashboardMobileChatRoom'
import DashboardMobileChatInbox from './DashboardMobileChatInbox'
import DashboardMobileMachineScreen from './DashboardMobileMachineScreen'
import type { DashboardMobileSection } from './DashboardMobileBottomNav'
import { getConversationTimestamp } from './conversation-sort'
import type { MobileConversationListItem, MobileMachineCard } from './DashboardMobileChatShared'
import { buildLiveSessionInboxStateMap, getConversationInboxSurfaceState } from './DashboardMobileChatShared'
import { getConversationMachineId, getConversationProviderType } from './conversation-selectors'
import { getConversationPreviewText } from './conversation-presenters'
import { compareMachineEntries } from '../../utils/daemon-utils'
import { buildMobileMachineCards, buildSelectedMachineRecentLaunches } from './dashboard-mobile-chat-mode-helpers'
import { useDashboardMobileChatEffects } from './useDashboardMobileChatEffects'
import { useDashboardMobileMachineActions } from './useDashboardMobileMachineActions'
import { useDashboardMobileNavigationController } from './useDashboardMobileNavigationController'
import type { MachineRecentLaunch } from '../../pages/machine/types'
import type { DashboardNotificationSessionState } from '../../utils/dashboard-notifications'

declare const __APP_VERSION__: string

interface DashboardMobileChatModeProps {
    conversations: ActiveConversation[]
    hiddenConversations: ActiveConversation[]
    ides: DaemonData[]
    actionLogs: { routeId: string; text: string; timestamp: number }[]
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>
    setActionLogs: Dispatch<SetStateAction<{ routeId: string; text: string; timestamp: number }[]>>
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
    notificationStateBySessionId: Map<string, DashboardNotificationSessionState>
    onMarkNotificationTargetRead: (target: { sessionId?: string; providerSessionId?: string; tabKey?: string; routeId?: string }) => void
}

function getAvatarText(primary: string) {
    const text = primary.trim()
    if (!text) return '?'
    return text[0]!.toUpperCase()
}

function sortInboxItems(items: MobileConversationListItem[]) {
    return [...items].sort((left, right) => {
        const timestampDiff = right.timestamp - left.timestamp
        if (timestampDiff !== 0) return timestampDiff
        return left.conversation.tabKey.localeCompare(right.conversation.tabKey)
    })
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
    notificationStateBySessionId,
    onMarkNotificationTargetRead,
}: DashboardMobileChatModeProps) {
    const [selectedTabKey, setSelectedTabKey] = useState<string | null>(() => conversations[0]?.tabKey || null)
    const [screen, setScreen] = useState<'inbox' | 'chat' | 'machine'>(() => (conversations[0] ? 'chat' : 'inbox'))
    const [section, setSection] = useState<DashboardMobileSection>('chats')
    const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null)
    const [machineBackTarget, setMachineBackTarget] = useState<'inbox' | 'chat'>('inbox')
    const navigate = useNavigate()
    const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null

    const selectedConversation = useMemo(
        () => conversations.find(conversation => conversation.tabKey === selectedTabKey) || conversations[0] || null,
        [conversations, selectedTabKey],
    )
    const selectedIdeEntry = useMemo(
        () => selectedConversation ? ides.find(ide => ide.id === selectedConversation.routeId) : undefined,
        [ides, selectedConversation],
    )
    const selectedCliViewMode = useMemo(() => {
        if (!selectedConversation || isAcpConv(selectedConversation) || !isCliConv(selectedConversation)) return null
        return getCliConversationViewMode(selectedConversation)
    }, [selectedConversation])
    const machineEntries = useMemo(
        () => ides
            .filter(entry => entry.type === 'adhdev-daemon')
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

    const items = useMemo<MobileConversationListItem[]>(() => conversations.map(conversation => {
        const isOpenConversation = screen === 'chat' && selectedConversation?.tabKey === conversation.tabKey
        const surfaceState = getConversationInboxSurfaceState(conversation, liveSessionInboxState, {
            hideOpenTaskCompleteUnread: true,
            isOpenConversation,
            notificationStateBySessionId,
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
    }), [conversations, liveSessionInboxState, notificationStateBySessionId, screen, selectedConversation])
    const { markConversationRead } = useDashboardMobileChatEffects({
        conversations,
        machineEntries,
        items,
        selectedConversation,
        selectedTabKey,
        screen,
        liveSessionInboxState,
        sendDaemonCommand,
        requestedActiveTabKey,
        onRequestedActiveTabConsumed,
        requestedMachineId,
        onRequestedMachineConsumed,
        requestedMobileSection,
        onRequestedMobileSectionConsumed,
        setSelectedTabKey,
        setScreen,
        setSelectedMachineId,
        setSection,
        setMachineBackTarget,
        resetMachineAction: machineActions.resetMachineAction,
        markNotificationTargetRead: onMarkNotificationTargetRead,
    })
    const navigation = useDashboardMobileNavigationController({
        conversations,
        selectedConversation,
        machineBackTarget,
        markConversationRead,
        resetMachineAction: machineActions.resetMachineAction,
        setSelectedTabKey,
        setScreen,
        setSelectedMachineId,
        setSection,
        setMachineBackTarget,
    })

    const attentionItems = useMemo(
        () => sortInboxItems(items.filter(item => item.requiresAction)),
        [items],
    )

    const unreadItems = useMemo(
        () => sortInboxItems(items.filter(item => item.unread && !item.requiresAction)),
        [items],
    )
    const workingItems = useMemo(
        () => sortInboxItems(items.filter(item => !item.unread && !item.requiresAction && item.isWorking)),
        [items],
    )
    const completedItems = useMemo(
        () => sortInboxItems(items.filter(item => !item.unread && !item.requiresAction && !item.isWorking)),
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
                    sendFeedbackMessage={cmds.sendFeedbackMessage}
                    isFocusingAgent={cmds.isFocusingAgent}
                    handleModalButton={cmds.handleModalButton}
                    handleRelaunch={cmds.handleRelaunch}
                    onBack={navigation.backFromConversation}
                    onOpenNativeConversation={navigation.openNativeConversation}
                    onOpenMachine={navigation.openConversationMachine}
                    onHideConversation={onHideConversation}
                    onOpenHistory={onOpenHistory}
                    onOpenRemote={onOpenRemote}
                    onStopCli={onStopCli}
                    cliViewMode={selectedCliViewMode}
                    onSetCliViewMode={async mode => {
                        if (!selectedConversation) return
                        if (selectedCliViewMode === mode) return
                        try {
                            await sendDaemonCommand(getConversationMachineId(selectedConversation) || selectedConversation.routeId, 'set_cli_view_mode', {
                                targetSessionId: selectedConversation.sessionId,
                                cliType: getConversationProviderType(selectedConversation),
                                mode,
                            })
                        } catch (error) {
                            const shouldRetainOverride = shouldRetainOptimisticCliViewModeOverrideOnError(error)
                            if (!isExpectedCliViewModeTransportError(error)) {
                                console.error('Failed to switch CLI view mode:', error)
                            } else {
                                console.warn(
                                    shouldRetainOverride
                                        ? 'CLI view mode result was lost after send; keeping optimistic mobile mode override:'
                                        : 'Skipped CLI view mode switch:',
                                    error instanceof Error ? error.message : String(error),
                                )
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
                    onBack={navigation.backFromMachine}
                    onSectionChange={navigation.changeMachineSection}
                    onOpenConversation={navigation.openConversation}
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
                    onOpenConversation={navigation.openConversation}
                    onShowConversation={onShowHiddenConversation}
                    onShowAllHidden={onShowAllHiddenConversations}
                    onOpenNewSession={onOpenNewSession}
                    onOpenMachine={navigation.openMachine}
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
