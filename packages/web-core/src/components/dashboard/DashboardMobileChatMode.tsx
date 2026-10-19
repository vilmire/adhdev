import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { ProviderApprovalTarget } from '@adhdev/mesh-shared'
import type { DaemonData } from '../../types'
import type { ActiveConversation } from './types'
import type { MachineRecentLaunch } from '../../pages/machine/types'
import { getCliConversationViewMode, isCliConv } from './types'
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
import { getSessionChatSnapshotForConversation, useWarmSessionChatSnapshotVersion } from './session-chat-controller'
import { compareMachineEntries } from '../../utils/daemon-utils'
import {
    areConversationsLoaded,
    buildMobileMachineCards,
    buildSelectedMachineRecentLaunches,
    groupMobileInboxItems,
    type MobileInboxBuckets,
} from './dashboard-mobile-chat-mode-helpers'
import { findMatchingMobileConversation, useDashboardMobileChatEffects } from './useDashboardMobileChatEffects'
import { useDashboardMobileMachineActions } from './useDashboardMobileMachineActions'
import { useDashboardMobileNavigationController } from './useDashboardMobileNavigationController'
import PendingApprovalsInbox, {
    type PendingApprovalAction,
    type PendingApprovalExactButton,
    type PendingApprovalItem,
} from '../MeshGraph/PendingApprovalsInbox'
import { deriveProviderApprovalInbox } from '../MeshGraph/providerApprovalInbox'
import { DialogShell } from '../ui/Dialog'
import { IconX } from '../Icons'
import { isLaunchableMachineProvider } from '../../utils/provider-activation'
import { getDaemonUpdateTargetVersion } from '../../utils/daemon-update-policy'
import { isVersionMismatch } from '../../utils/version-update'
import type { StartAssistantState } from '../../hooks/useStartAssistant'

declare const __APP_VERSION__: string

const MOBILE_APPROVALS_WAIT_TICK_MS = 10_000

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
    /** False while the first daemon snapshot is still in flight (see DashboardMobileChatInbox). */
    initialDataLoaded?: boolean
    onShowAllHiddenConversations: () => void
    onHideConversation?: (conversation: ActiveConversation) => void
    /** Restores one hidden conversation back into the visible list without switching screens. */
    onRestoreHiddenConversation?: (conversation: ActiveConversation) => void
    /** Restores one hidden conversation (mobile hide → Undo toast). */
    onShowHiddenConversation?: (conversation: ActiveConversation) => void
    onOpenMeshGraph?: (conversation: ActiveConversation) => void
    onOpenNewSession?: () => void
    liveSessionInboxState: Map<string, LiveSessionInboxState>
    setCliViewModeOverrides: Dispatch<SetStateAction<Record<string, 'chat' | 'terminal'>>>
    /** The dashboard's one `useStartAssistant` state (shared with the desktop header). */
    startAssistant?: StartAssistantState | null
    connectionStates?: Record<string, string>
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
    initialDataLoaded = true,
    onShowAllHiddenConversations,
    onHideConversation,
    onRestoreHiddenConversation,
    onShowHiddenConversation,
    onOpenMeshGraph,
    onOpenNewSession,
    liveSessionInboxState,
    setCliViewModeOverrides,
    startAssistant = null,
    connectionStates = {},
}: DashboardMobileChatModeProps) {
    const { t } = useTranslation('common')
    const initialRequestedMatch = useMemo(
        () => requestedActiveTabKey
            ? findMatchingMobileConversation(
                conversations,
                hiddenConversations,
                { targetKey: requestedActiveTabKey },
                ides,
            )
            : null,
        // Intentionally only used for initial state; updates are handled by useDashboardMobileChatEffects.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    )
    const [selectedTabKey, setSelectedTabKey] = useState<string | null>(() => {
        if (requestedActiveTabKey) {
            return initialRequestedMatch?.conversation.tabKey || null
        }
        if (requestedMobileSection) {
            return null
        }
        return conversations[0]?.tabKey || null
    })
    const [screen, setScreen] = useState<'inbox' | 'chat' | 'machine'>(() => {
        if (requestedActiveTabKey) {
            return initialRequestedMatch ? 'chat' : 'inbox'
        }
        if (requestedMobileSection) {
            return 'inbox'
        }
        return conversations[0] ? 'chat' : 'inbox'
    })
    const [section, setSection] = useState<DashboardMobileSection>(() => requestedMobileSection || 'chats')
    const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null)
    const [machineBackTarget, setMachineBackTarget] = useState<'inbox' | 'chat'>('inbox')
    const [approvalsOpen, setApprovalsOpen] = useState(false)
    const [approvalsNowMs, setApprovalsNowMs] = useState(() => Date.now())
    const liveWorkingOrderRef = useRef<string[]>([])
    const navigate = useNavigate()
    const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null
    const pendingProviderApprovals = useMemo(() => {
        if (isStandalone) return []
        return deriveProviderApprovalInbox(ides, connectionStates)
    }, [connectionStates, ides, isStandalone])
    const pendingProviderApprovalCount = pendingProviderApprovals.length
    const openApprovals = useCallback(() => {
        setApprovalsNowMs(Date.now())
        setApprovalsOpen(true)
    }, [])
    const closeApprovals = useCallback(() => {
        setApprovalsOpen(false)
    }, [])
    useEffect(() => {
        if (pendingProviderApprovalCount === 0) {
            setApprovalsOpen(false)
        }
    }, [pendingProviderApprovalCount])
    useEffect(() => {
        if (!approvalsOpen) return
        setApprovalsNowMs(Date.now())
        const timer = setInterval(() => setApprovalsNowMs(Date.now()), MOBILE_APPROVALS_WAIT_TICK_MS)
        return () => clearInterval(timer)
    }, [approvalsOpen])
    const resolvePendingApproval = useCallback(
        async (
            nodeId: string,
            sessionId: string,
            action: PendingApprovalAction,
            approvalTarget?: ProviderApprovalTarget,
            exact?: PendingApprovalExactButton,
        ) => {
            if (!approvalTarget) return
            await sendDaemonCommand(nodeId, 'resolve_action', {
                action,
                sessionId,
                approvalTarget,
                ...(exact ? { button: exact.button, buttonIndex: exact.buttonIndex } : {}),
            })
        },
        [sendDaemonCommand],
    )

    const selectedConversation = useMemo(
        () => {
            if (!selectedTabKey) return null
            return conversations.find(conversation => conversation.tabKey === selectedTabKey)
                || hiddenConversations.find(conversation => conversation.tabKey === selectedTabKey)
                || null
        },
        [conversations, hiddenConversations, selectedTabKey],
    )
    const selectedIdeEntry = useMemo(
        () => selectedConversation ? ides.find(ide => ide.id === selectedConversation.routeId) : undefined,
        [ides, selectedConversation],
    )
    const selectedCliViewMode = useMemo(() => {
        if (!selectedConversation || !isCliConv(selectedConversation)) return null
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

    // Bumps when any warm chat controller emits a new snapshot, so the
    // `items` memo below re-derives preview/timestamp from the updated snapshot
    // as soon as a message push lands — without requiring conversation re-entry.
    const warmChatVersion = useWarmSessionChatSnapshotVersion(conversations)

    const items = useMemo<MobileConversationListItem[]>(() => conversations.map(conversation => {
        const isOpenConversation = screen === 'chat' && selectedConversation?.tabKey === conversation.tabKey
        const surfaceState = getConversationInboxSurfaceState(conversation, liveSessionInboxState, {
            hideOpenTaskCompleteUnread: true,
            isOpenConversation,
        })
        const timestamp = getConversationTimestamp(conversation)
        // (B2) Feed the warm keyed-chat snapshot into the preview so the inbox row
        // shows the same last message ChatPane renders (falls back to
        // conversation.messages when no warm snapshot exists for this session).
        const chatSnapshot = getSessionChatSnapshotForConversation(conversation)
        const preview = getConversationPreviewText(conversation, chatSnapshot)

        return {
            conversation,
            timestamp,
            preview,
            unread: surfaceState.unread,
            requiresAction: surfaceState.requiresAction,
            isWorking: surfaceState.isWorking,
            inboxBucket: surfaceState.inboxBucket,
        }
    }), [conversations, liveSessionInboxState, screen, selectedConversation, warmChatVersion])
    const { markConversationRead } = useDashboardMobileChatEffects({
        conversations,
        hiddenConversations,
        ides,
        machineEntries,
        items,
        selectedConversation,
        selectedTabKey,
        screen,
        liveSessionInboxState,
        sendDaemonCommand,
        requestedActiveTabKey,
        onRequestedActiveTabConsumed,
        onRestoreHiddenConversation,
        onShowHiddenConversation,
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
        assistantItems,
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
    // "Start assistant" from the inbox opens the assistant's room once its
    // session lands (the session arrives on the status lane after
    // `launch_assistant` answers). A failed launch drops the intent.
    const openAssistantOnArrivalRef = useRef(false)
    const mobileStartAssistant = useMemo<StartAssistantState | null>(() => startAssistant && {
        ...startAssistant,
        start: async (target) => {
            openAssistantOnArrivalRef.current = true
            await startAssistant.start(target)
        },
    }, [startAssistant])
    const openConversation = navigation.openConversation
    const arrivedAssistant = assistantItems[0]?.conversation ?? null
    const startAssistantError = startAssistant?.error ?? null
    useEffect(() => {
        if (startAssistantError) openAssistantOnArrivalRef.current = false
    }, [startAssistantError])
    useEffect(() => {
        if (!arrivedAssistant || !openAssistantOnArrivalRef.current) return
        openAssistantOnArrivalRef.current = false
        openConversation(arrivedAssistant)
    }, [arrivedAssistant, openConversation])
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
    // Direction-aware gate (same helper as the version banner): only offer the
    // upgrade when the machine is genuinely BEHIND the update target — a raw
    // !== would show "Update" to a machine already on a NEWER build than the
    // web app (e.g. daemon rc.19 vs app rc.18).
    const selectedMachineNeedsUpgrade = !!selectedMachineEntry
        && isVersionMismatch(selectedMachineEntry, getDaemonUpdateTargetVersion(selectedMachineEntry, appVersion))
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

    const machineCards = useMemo<MobileMachineCard[]>(
        () => buildMobileMachineCards(machineEntries, items, hiddenConversations, {
            isStandalone,
            connectionStates,
        }),
        [connectionStates, hiddenConversations, isStandalone, items, machineEntries],
    )

    // Conversations arrive over P2P after the daemon snapshot, so the conversation
    // empty state needs its own gate — `initialDataLoaded` alone turns true too early.
    const conversationsLoaded = useMemo(
        () => areConversationsLoaded(ides, initialDataLoaded, {
            isStandalone,
            connectionStates,
        }),
        [connectionStates, ides, initialDataLoaded, isStandalone],
    )

    const handleOpenRecent = useCallback(async (session: MachineRecentLaunch) => {
        if (!selectedMachineEntry) return
        await machineActions.handleOpenRecent(selectedMachineEntry.id, session)
    }, [machineActions, selectedMachineEntry])

    const handleOpenApprovalSession = useCallback(
        (item: PendingApprovalItem) => {
            setApprovalsOpen(false)
            const matched = findMatchingMobileConversation(
                conversations,
                hiddenConversations,
                { nodeId: item.nodeId, sessionId: item.sessionId },
                ides,
            )
            if (!matched) return
            if (matched.isHidden) {
                if (onRestoreHiddenConversation) {
                    onRestoreHiddenConversation(matched.conversation)
                } else if (onShowHiddenConversation) {
                    onShowHiddenConversation(matched.conversation)
                }
            }
            openConversation(matched.conversation)
        },
        [
            conversations,
            hiddenConversations,
            ides,
            onRestoreHiddenConversation,
            onShowHiddenConversation,
            openConversation,
        ],
    )

    return (
        <div className="dashboard-mobile-chat w-full min-w-0">
            {screen === 'chat' && selectedConversation ? (
                <DashboardMobileChatRoom
                    selectedConversation={selectedConversation}
                    isStandalone={isStandalone}
                    selectedIdeEntry={selectedIdeEntry}
                    actionLogs={actionLogs}
                    userName={userName}
                    commands={cmds}
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
                />
            ) : screen === 'machine' && selectedMachineEntry ? (
                <DashboardMobileMachineScreen
                    selectedMachineEntry={selectedMachineEntry}
                    selectedMachineConversations={selectedMachineConversations}
                    selectedMachineRecentLaunches={selectedMachineRecentLaunches}
                    cliProviders={selectedMachineCliProviders}
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
                    onBrowseDirectory={(path) => machineActions.handleBrowseDirectory(selectedMachineEntry.id, path)}
                    onListSavedSessions={(providerType) => machineActions.handleListSavedSessions(selectedMachineEntry.id, providerType)}
                />
            ) : (
                <DashboardMobileChatInbox
                    section={section}
                    assistantItems={assistantItems}
                    startAssistant={mobileStartAssistant}
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
                    onRestoreHiddenConversation={onRestoreHiddenConversation}
                    onShowHiddenConversation={onShowHiddenConversation}
                    onOpenMeshGraph={onOpenMeshGraph}
                    onStopCli={onStopCli}
                    onOpenNewSession={onOpenNewSession}
                    onOpenMachine={navigation.openMachine}
                    onOpenSettings={() => navigate('/settings')}
                    onSectionChange={setSection}
                    wsStatus={wsStatus}
                    isConnected={isConnected}
                    initialDataLoaded={initialDataLoaded}
                    conversationsLoaded={conversationsLoaded}
                    isStandalone={isStandalone}
                    isConversationMuted={isConversationMuted}
                    onToggleMuteConversation={toggleMute}
                    pendingProviderApprovalCount={pendingProviderApprovalCount}
                    onOpenApprovals={!isStandalone && pendingProviderApprovalCount > 0 ? openApprovals : undefined}
                />
            )}
            <DialogShell
                open={approvalsOpen && pendingProviderApprovalCount > 0}
                onClose={closeApprovals}
                align="sheet"
                size="lg"
                ariaLabel={t('approvals.pageTitle')}
                surfaceClassName="rounded-2xl"
            >
                <div
                    data-testid="mobile-approvals-sheet"
                    className="flex min-h-0 flex-1 flex-col overflow-hidden"
                >
                    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-default px-4 py-3.5">
                        <div className="min-w-0">
                            <h2 className="truncate text-base font-bold text-text-primary">
                                {t('approvals.pageTitle')}
                            </h2>
                            <p className="truncate text-2xs text-text-muted mt-0.5">
                                {t('approvals.pageSubtitle')}
                            </p>
                        </div>
                        <button
                            type="button"
                            data-testid="mobile-approvals-close"
                            onClick={closeApprovals}
                            className="-m-1.5 inline-flex h-11 w-11 shrink-0 items-center justify-center"
                            aria-label={t('common.closeDialog')}
                        >
                            <span className="btn btn-ghost btn-sm inline-flex h-8 w-8 items-center justify-center p-0">
                                <IconX size={16} />
                            </span>
                        </button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
                        <PendingApprovalsInbox
                            approvals={pendingProviderApprovals}
                            onResolve={resolvePendingApproval}
                            onOpenSession={handleOpenApprovalSession}
                            hideWhenEmpty={false}
                            nowMs={approvalsNowMs}
                        />
                    </div>
                </div>
            </DialogShell>
        </div>
    )
}
