import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DaemonData } from '../../types'
import type { ActiveConversation } from './types'
import type { MachineRecentLaunch } from '../../pages/machine/types'
import { getCliConversationViewMode, isAcpConv, isCliConv } from './types'
import { switchCliConversationViewModeOptimistically } from './cliViewModeOverrides'
import { useDashboardConversationCommands } from '../../hooks/useDashboardConversationCommands'
import DashboardMobileChatRoom from './DashboardMobileChatRoom'
import DashboardMobileChatInbox from './DashboardMobileChatInbox'
import DashboardMobileMachineScreen from './DashboardMobileMachineScreen'
import type { DashboardMobileSection } from './DashboardMobileBottomNav'
import { getConversationTimestamp } from './conversation-sort'
import type { LiveSessionInboxState, MobileConversationListItem, MobileMachineCard } from './DashboardMobileChatShared'
import { getConversationInboxSurfaceState } from './DashboardMobileChatShared'
import { getConversationMachineId } from './conversation-selectors'
import { useConversationPrefs } from '../../hooks/useConversationPrefs'
import { getConversationPreviewText } from './conversation-presenters'
import { getSessionChatTailSnapshotForConversation, useWarmSessionChatTailSnapshotVersion } from './session-chat-tail-controller'
import { compareMachineEntries } from '../../utils/daemon-utils'
import {
    buildMobileMachineCards,
    buildSelectedMachineRecentLaunches,
    groupMobileInboxItems,
    type MobileInboxBuckets,
} from './dashboard-mobile-chat-mode-helpers'
import { useDashboardMobileChatEffects } from './useDashboardMobileChatEffects'
import { useDashboardMobileMachineActions } from './useDashboardMobileMachineActions'
import { useDashboardMobileNavigationController } from './useDashboardMobileNavigationController'
import { isLaunchableMachineProvider } from '../../utils/provider-activation'

declare const __APP_VERSION__: string

interface DashboardMobileChatModeProps {
    conversations: ActiveConversation[]
    hiddenConversations: ActiveConversation[]
    ides: DaemonData[]
    actionLogs: { routeId: string; text: string; timestamp: number }[]
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
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
    onShowAllHiddenConversations: () => void
    onHideConversation?: (conversation: ActiveConversation) => void
    onOpenMeshGraph?: (conversation: ActiveConversation) => void
    onOpenNewSession?: () => void
    liveSessionInboxState: Map<string, LiveSessionInboxState>
    setCliViewModeOverrides: Dispatch<SetStateAction<Record<string, 'chat' | 'terminal'>>>
}

function getAvatarText(primary: string) {
    const text = primary.trim()
    if (!text) return '?'
    return text[0]!.toUpperCase()
}

export default function DashboardMobileChatMode({
    conversations,
    hiddenConversations,
    ides,
    actionLogs,
    sendDaemonCommand,
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
    onShowAllHiddenConversations,
    onHideConversation,
    onOpenMeshGraph,
    onOpenNewSession,
    liveSessionInboxState,
    setCliViewModeOverrides,
}: DashboardMobileChatModeProps) {
    const [selectedTabKey, setSelectedTabKey] = useState<string | null>(() => conversations[0]?.tabKey || null)
    const [screen, setScreen] = useState<'inbox' | 'chat' | 'machine'>(() => (conversations[0] ? 'chat' : 'inbox'))
    const [section, setSection] = useState<DashboardMobileSection>('chats')
    const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null)
    const [machineBackTarget, setMachineBackTarget] = useState<'inbox' | 'chat'>('inbox')
    const liveWorkingOrderRef = useRef<string[]>([])
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
    const cmds = useDashboardConversationCommands({
        sendDaemonCommand,
        activeConv: selectedConversation || undefined,
            setActionLogs,
        isStandalone,
    })
    const machineActions = useDashboardMobileMachineActions({
        sendDaemonCommand,
        navigate,
        ides,
        conversations,
    })

    // Bumps when any warm chat_tail controller emits a new snapshot, so the
    // `items` memo below re-derives preview/timestamp from the updated snapshot
    // as soon as a message push lands — without requiring conversation re-entry.
    const warmChatTailVersion = useWarmSessionChatTailSnapshotVersion(conversations)

    const items = useMemo<MobileConversationListItem[]>(() => conversations.map(conversation => {
        const isOpenConversation = screen === 'chat' && selectedConversation?.tabKey === conversation.tabKey
        const surfaceState = getConversationInboxSurfaceState(conversation, liveSessionInboxState, {
            hideOpenTaskCompleteUnread: true,
            isOpenConversation,
        })
        const timestamp = getConversationTimestamp(conversation)
        // (B2) Feed the warm chat_tail snapshot into the preview so the inbox row
        // shows the same last message ChatPane renders (falls back to
        // conversation.messages when no warm snapshot exists for this session).
        const chatTailSnapshot = getSessionChatTailSnapshotForConversation(conversation)
        const preview = getConversationPreviewText(conversation, chatTailSnapshot)

        return {
            conversation,
            timestamp,
            preview,
            unread: surfaceState.unread,
            requiresAction: surfaceState.requiresAction,
            isWorking: surfaceState.isWorking,
            inboxBucket: surfaceState.inboxBucket,
        }
    }), [conversations, liveSessionInboxState, screen, selectedConversation, warmChatTailVersion])
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

    // Mute is daemon-owned (the muted flag rides the status snapshot; the
    // coordinator-spawned-worker default is computed daemon-side). useConversationPrefs
    // adds an optimistic overlay so the toggle flips instantly, then reconciles with
    // the daemon snapshot.
    const { isMuted: isConversationMuted, toggleMute } = useConversationPrefs(liveSessionInboxState, sendDaemonCommand)

    const {
        attentionItems,
        unreadItems,
        workingItems,
        completedItems,
    } = useMemo<MobileInboxBuckets>(
        () => groupMobileInboxItems(items, liveWorkingOrderRef.current),
        [items],
    )
    useEffect(() => {
        liveWorkingOrderRef.current = workingItems.map(item => item.conversation.tabKey)
    }, [workingItems])
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
            .filter(provider => isLaunchableMachineProvider(provider, 'cli'))
            .map(provider => ({
                type: provider.type,
                displayName: provider.displayName || provider.type,
                icon: provider.icon,
            })),
        [selectedMachineProviders],
    )
    const selectedMachineAcpProviders = useMemo(
        () => selectedMachineProviders
            .filter(provider => isLaunchableMachineProvider(provider, 'acp'))
            .map(provider => ({
                type: provider.type,
                displayName: provider.displayName || provider.type,
                icon: provider.icon,
            })),
        [selectedMachineProviders],
    )

    const machineCards = useMemo<MobileMachineCard[]>(
        () => buildMobileMachineCards(machineEntries, items, hiddenConversations),
        [items, machineEntries, hiddenConversations],
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
                    onOpenHistory={onOpenHistory}
                    onOpenRemote={onOpenRemote}
                    onOpenMeshGraph={onOpenMeshGraph}
                    onStopCli={onStopCli}
                    cliViewMode={selectedCliViewMode}
                    onSetCliViewMode={async mode => {
                        await switchCliConversationViewModeOptimistically({
                            conversation: selectedConversation,
                            mode,
                            ides,
                            sendDaemonCommand,
                            setCliViewModeOverrides,
                        })
                    }}
                    handleSendChat={cmds.handleSendChat}
                    handleForceSendChat={cmds.handleForceSendChat}
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
                    actionLogs={actionLogs}
                    sendDaemonCommand={sendDaemonCommand}
                    onOpenConversation={navigation.openConversation}
                    onShowAllHidden={onShowAllHiddenConversations}
                    onHideConversation={onHideConversation}
                    onOpenMeshGraph={onOpenMeshGraph}
                    onStopCli={onStopCli}
                    onOpenNewSession={onOpenNewSession}
                    onOpenMachine={navigation.openMachine}
                    onOpenSettings={() => navigate('/settings')}
                    onSectionChange={setSection}
                    wsStatus={wsStatus}
                    isConnected={isConnected}
                    isStandalone={isStandalone}
                    isConversationMuted={isConversationMuted}
                    onToggleMuteConversation={toggleMute}
                />
            )}
        </div>
    )
}
