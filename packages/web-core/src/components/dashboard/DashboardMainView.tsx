import React from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { DaemonData } from '../../types'
import type { ActiveConversation, CliConversationViewMode } from './types'
import { isAcpConv, isCliConv } from './types'
import DashboardHeader from './DashboardHeader'
import DashboardMobileChatMode from './DashboardMobileChatMode'
import DashboardPaneWorkspace from './DashboardPaneWorkspace'
import DashboardDockviewWorkspace from './DashboardDockviewWorkspace'
import DashboardNewSessionDialog from './DashboardNewSessionDialog'
import DashboardMeshGraphDialog from './DashboardMeshGraphDialog'
import GitStatusDialog from '../git/GitStatusDialog'
import type { DashboardMobileSection } from './DashboardMobileBottomNav'
import { useActionShortcuts, getDefaultShortcut, type DashboardActionShortcutDefinition } from '../../hooks/useActionShortcuts'
import { getProviderArgs, getRouteTarget } from '../../hooks/dashboardCommandUtils'
import type { BrowseDirectoryResult } from '../machine/workspaceBrowse'
import { IconX } from '../Icons'
import ModalPortal from '../ui/ModalPortal'
import type { DashboardNotificationRecord } from '../../utils/dashboard-notifications'
import type { DashboardLayoutProfile } from '../../utils/dashboardLayoutStorage'
import { useDashboardMainViewUiState, type DashboardMainViewShortcutSectionId } from '../../hooks/useDashboardMainViewUiState'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import type { LiveSessionInboxState } from './DashboardMobileChatShared'
import { conversationMatchesTarget } from './conversation-identity'
import type { DashboardScrollToBottomIntent } from './dashboard-scroll-to-bottom'
import type { LaunchResult, MeshLaunchOption } from '../../hooks/useDashboardCommandActions'

type ShortcutSectionId = DashboardMainViewShortcutSectionId

function getShortcutSection(action: DashboardActionShortcutDefinition): ShortcutSectionId {
    switch (action.id) {
        case 'triggerPrimaryApprovalAction':
        case 'triggerSecondaryApprovalAction':
        case 'triggerTertiaryApprovalAction':
            return 'approvals'
        case 'splitActiveTabRight':
        case 'splitActiveTabDown':
        case 'focusLeftPane':
        case 'focusRightPane':
        case 'focusUpPane':
        case 'focusDownPane':
        case 'moveActiveTabToLeftPane':
        case 'moveActiveTabToRightPane':
        case 'moveActiveTabToUpPane':
        case 'moveActiveTabToDownPane':
            return 'panes'
        default:
            return 'workspace'
    }
}

function getCommandErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error || '')
}

function isExpectedResolveActionFailure(error: unknown): boolean {
    const message = getCommandErrorMessage(error).toLowerCase()
    return message.includes('button not found')
        || message.includes('not in approval state')
        || message.includes('command failed')
}

interface DashboardMainViewProps {
    showMobileChatMode: boolean
    isMobile: boolean
    activeConv?: ActiveConversation
    wsStatus: string
    isConnected: boolean
    onOpenHistory: (conversation?: ActiveConversation) => void
    onOpenRemote: (conversation: ActiveConversation) => void
    onStopCli: (conversation?: ActiveConversation) => void | Promise<void>
    activeCliViewMode: CliConversationViewMode | null
    onSetActiveCliViewMode: (mode: CliConversationViewMode) => void
    mobileChatConversations: ActiveConversation[]
    hiddenConversations: ActiveConversation[]
    ides: DaemonData[]
    actionLogs: { routeId: string; text: string; timestamp: number }[]
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    setActionLogs: React.Dispatch<React.SetStateAction<{ routeId: string; text: string; timestamp: number }[]>>
    setCliViewModeOverrides: React.Dispatch<React.SetStateAction<Record<string, 'chat' | 'terminal'>>>
    isStandalone: boolean
    initialDataLoaded: boolean
    userName?: string
    requestedMobileTabKey: string | null
    onRequestedMobileTabConsumed: () => void
    requestedMachineId: string | null
    onRequestedMachineConsumed: () => void
    // Route-level request to open the new-session dialog preselected on a
    // machine (and optionally one of its saved workspaces) — e.g. the launch
    // shortcut on the machine page's workspace list. mode 'mesh' opens the
    // coordinator flow with the mesh rooted at meshWorkspacePath preselected.
    requestedNewSessionLaunch?: {
        machineId: string
        workspaceId?: string | null
        mode?: 'workspace' | 'mesh'
        meshWorkspacePath?: string | null
    } | null
    onRequestedNewSessionLaunchConsumed?: () => void
    requestedMobileSection: DashboardMobileSection | null
    onRequestedMobileSectionConsumed: () => void
    containerRef: React.RefObject<HTMLDivElement>
    isSplitMode: boolean
    numGroups: number
    groupSizes: number[]
    groupedConvs: ActiveConversation[][]
    clearedTabs: Record<string, number>
    focusedGroup: number
    focusGroup: (groupIndex: number) => void
    moveTabToGroup: (tabKey: string, nextGroupIndex: number) => void
    splitTabRelative: (tabKey: string, targetGroup: number, side: 'left' | 'right') => void
    closeGroup: (groupIndex: number) => void
    handleResizeStart: (dividerIdx: number, event: React.MouseEvent) => void
    groupActiveTabIds: Record<number, string | null>
    setGroupActiveTab: (groupIndex: number, tabKey: string | null) => void
    groupTabOrders: Record<number, string[]>
    setGroupTabOrder: (groupIndex: number, order: string[]) => void
    toggleHiddenTab: (tabKey: string) => void
    visibleConversations: ActiveConversation[]
    requestedDesktopTabKey: string | null
    onRequestedDesktopTabConsumed: () => void
    onDesktopActiveTabChange: (tabKey: string | null) => void
    onRequestScrollToBottom: (tabKey: string | null | undefined, intent: DashboardScrollToBottomIntent) => void
    onHideConversation: (conversation: ActiveConversation) => void
    onShowHiddenConversation: (conversation: ActiveConversation) => void
    onShowAllHiddenConversations: () => void
    scrollToBottomRequest?: { tabKey: string; nonce: number } | null
    machineEntries: DaemonData[]
    layoutProfile: DashboardLayoutProfile
    onBrowseMachineDirectory: (machineId: string, path: string) => Promise<BrowseDirectoryResult>
    onSaveMachineWorkspace: (machineId: string, path: string) => Promise<{ ok: boolean; error?: string }>
    onLaunchMachineIde: (machineId: string, ideType: string, opts?: { workspacePath?: string | null }) => Promise<{ ok: boolean; error?: string }>
    onLaunchMachineProvider: (
        machineId: string,
        kind: 'cli' | 'acp',
        providerType: string,
        opts?: {
            workspaceId?: string | null
            workspacePath?: string | null
            resumeSessionId?: string | null
            cliArgs?: string[]
            initialModel?: string | null
            initialThinkingLevel?: string | null
            settings?: {
                autoApprove?: boolean
                autoApproveMode?: string
            }
        },
    ) => Promise<{ ok: boolean; error?: string }>
    onListMachineMeshes: (machineId: string) => Promise<MeshLaunchOption[]>
    onLaunchMeshCoordinator: (
        machineId: string,
        meshId: string,
        cliType: string,
        opts?: { initialModel?: string | null; initialThinkingLevel?: string | null },
    ) => Promise<LaunchResult>
    onListMachineSavedSessions: (machineId: string, providerType: string) => Promise<Array<{
        id: string
        providerSessionId: string
        providerType: string
        providerName: string
        kind: 'cli' | 'acp'
        title: string
        workspace?: string | null
        summaryMetadata?: DaemonData['summaryMetadata']
        preview?: string
        messageCount: number
        firstMessageAt: number
        lastMessageAt: number
        canResume: boolean
    }>>
    notifications: DashboardNotificationRecord[]
    notificationUnreadCount: number
    liveSessionInboxState: Map<string, LiveSessionInboxState>
    onMarkNotificationRead: (notificationId: string) => void
    onMarkNotificationUnread: (notificationId: string) => void
    onDeleteNotification: (notificationId: string) => void
}

export default function DashboardMainView({
    showMobileChatMode,
    isMobile,
    activeConv,
    wsStatus,
    isConnected,
    onOpenHistory,
    onOpenRemote,
    onStopCli,
    activeCliViewMode,
    onSetActiveCliViewMode,
    mobileChatConversations,
    hiddenConversations,
    ides,
    actionLogs,
    sendDaemonCommand,
    setActionLogs,
    setCliViewModeOverrides,
    isStandalone,
    initialDataLoaded,
    userName,
    requestedMobileTabKey,
    onRequestedMobileTabConsumed,
    requestedMachineId,
    onRequestedMachineConsumed,
    requestedNewSessionLaunch,
    onRequestedNewSessionLaunchConsumed,
    requestedMobileSection,
    onRequestedMobileSectionConsumed,
    containerRef,
    isSplitMode,
    numGroups,
    groupSizes,
    groupedConvs,
    clearedTabs,
    focusedGroup,
    focusGroup,
    moveTabToGroup,
    splitTabRelative,
    closeGroup,
    handleResizeStart,
    groupActiveTabIds,
    setGroupActiveTab,
    groupTabOrders,
    setGroupTabOrder,
    toggleHiddenTab,
    visibleConversations,
    requestedDesktopTabKey,
    onRequestedDesktopTabConsumed,
    onDesktopActiveTabChange,
    onRequestScrollToBottom,
    onHideConversation,
    onShowHiddenConversation,
    onShowAllHiddenConversations,
    scrollToBottomRequest,
    machineEntries,
    layoutProfile,
    onBrowseMachineDirectory,
    onSaveMachineWorkspace,
    onLaunchMachineIde,
    onLaunchMachineProvider,
    onListMachineMeshes,
    onLaunchMeshCoordinator,
    onListMachineSavedSessions,
    notifications,
    notificationUnreadCount,
    liveSessionInboxState,
    onMarkNotificationRead,
    onMarkNotificationUnread,
    onDeleteNotification,
}: DashboardMainViewProps) {
    const { t } = useTranslation()
    const dockviewActionHandlersRef = React.useRef<{
        setShortcutForActiveTab: () => void
        restoreHiddenTabToSavedLocation: (tabKey: string) => void
        activateConversationTab: (tabKey: string) => void
        resetAllPanelsToMain: () => void
        activatePreviousTabInGroup: () => void
        activateNextTabInGroup: () => void
        floatActiveTab: () => void
        popoutActiveTab: () => void
        dockActiveTab: () => void
        splitActiveTabRight: () => void
        splitActiveTabDown: () => void
        focusLeftPane: () => void
        focusRightPane: () => void
        focusUpPane: () => void
        focusDownPane: () => void
        moveActiveTabToLeftPane: () => void
        moveActiveTabToRightPane: () => void
        moveActiveTabToUpPane: () => void
        moveActiveTabToDownPane: () => void
    } | null>(null)
    const {
        inboxOpen,
        hiddenOpen,
        shortcutHelpOpen,
        newSessionOpen,
        guideNudgeVisible,
        guideTab,
        shortcutSection,
        isDesktopDashboard,
        setGuideTab,
        setShortcutSection,
        handleInboxOpenChange,
        handleHiddenOpenChange,
        handleOpenShortcutHelp,
        closeShortcutHelp,
        openNewSession,
        closeNewSession,
    } = useDashboardMainViewUiState({
        isMobile,
        showMobileChatMode,
        visibleConversationCount: visibleConversations.length,
    })

    // Preselect target for the new-session dialog (machine-page launch shortcut).
    // Copied out of the route request before it is consumed/cleared, dropped when
    // the dialog closes so the plain header "+" opens with defaults again.
    const [newSessionInitialTarget, setNewSessionInitialTarget] = React.useState<{
        machineId: string
        workspaceId?: string | null
        mode?: 'workspace' | 'mesh'
        meshWorkspacePath?: string | null
    } | null>(null)
    React.useEffect(() => {
        if (!requestedNewSessionLaunch) return
        setNewSessionInitialTarget({
            machineId: requestedNewSessionLaunch.machineId,
            workspaceId: requestedNewSessionLaunch.workspaceId ?? null,
            mode: requestedNewSessionLaunch.mode || 'workspace',
            meshWorkspacePath: requestedNewSessionLaunch.meshWorkspacePath ?? null,
        })
        openNewSession()
        onRequestedNewSessionLaunchConsumed?.()
    }, [requestedNewSessionLaunch, openNewSession, onRequestedNewSessionLaunchConsumed])
    const handleCloseNewSession = React.useCallback(() => {
        setNewSessionInitialTarget(null)
        closeNewSession()
    }, [closeNewSession])

    // In-app confirm (window.confirm is auto-dismissed in embedded browsers).
    const { confirm: confirmAction, confirmDialog: actionConfirmDialog } = useConfirmDialog()

    const [gitDialogTarget, setGitDialogTarget] = React.useState<{ daemonId: string; workspace: string } | null>(null)
    const [meshGraphConversation, setMeshGraphConversation] = React.useState<ActiveConversation | null>(null)
    const handleOpenGitDialog = React.useCallback((daemonId: string, workspace: string) => {
        setGitDialogTarget({ daemonId, workspace })
    }, [])
    const handleOpenMeshGraph = React.useCallback((conversation: ActiveConversation) => {
        setMeshGraphConversation(conversation)
    }, [])

    const handleShowHiddenConversationWithRestore = React.useCallback((conversation: ActiveConversation) => {
        flushSync(() => {
            onShowHiddenConversation(conversation)
        })
        dockviewActionHandlersRef.current?.restoreHiddenTabToSavedLocation(conversation.tabKey)
    }, [onShowHiddenConversation])
    const handleOpenNotification = React.useCallback((notification: DashboardNotificationRecord) => {
        const targetConversation = mobileChatConversations.find(conversation => conversationMatchesTarget(conversation, notification))
            || hiddenConversations.find(conversation => conversationMatchesTarget(conversation, notification))

        if (targetConversation) {
            if (hiddenConversations.some(conversation => conversation.tabKey === targetConversation.tabKey)) {
                handleShowHiddenConversationWithRestore(targetConversation)
            }
            onDesktopActiveTabChange(targetConversation.tabKey)
            dockviewActionHandlersRef.current?.activateConversationTab(targetConversation.tabKey)
            onRequestScrollToBottom(targetConversation.tabKey, 'notification-open')
        }

        onMarkNotificationRead(notification.id)
        handleInboxOpenChange(false)
    }, [
        handleShowHiddenConversationWithRestore,
        hiddenConversations,
        mobileChatConversations,
        onDesktopActiveTabChange,
        onMarkNotificationRead,
        onRequestScrollToBottom,
    ])
    const handleResetAllPanelsToMain = React.useCallback(async () => {
        const confirmed = await confirmAction({
            title: t('common.confirmTitle'),
            description: 'Move every floating or popout panel back into the main dashboard grid?',
            confirmLabel: t('common.confirm'),
        })
        if (!confirmed) return
        dockviewActionHandlersRef.current?.resetAllPanelsToMain()
        handleHiddenOpenChange(false)
    }, [confirmAction, handleHiddenOpenChange, t])

    const handleApprovalShortcut = React.useCallback(async (buttonIndex: number) => {
        if (!activeConv) return
        const buttonText = activeConv.modalButtons?.[buttonIndex]
        if (!buttonText) return
        const routeTarget = getRouteTarget(activeConv)
        if (!routeTarget) return
        const clean = buttonText.replace(/[⌥⏎⇧⌫⌘⌃↵]/g, '').trim().toLowerCase()
        const isApprove = /^(run|approve|accept|yes|allow|always|proceed|save)/.test(clean)

        try {
            await sendDaemonCommand(routeTarget, 'resolve_action', {
                button: buttonText,
                action: isApprove ? 'approve' : 'reject',
                buttonIndex,
                ...getProviderArgs(activeConv),
            })
        } catch (error) {
            if (!isExpectedResolveActionFailure(error)) {
                console.error('[Shortcut approval] Failed:', error)
            }
        }
    }, [activeConv, sendDaemonCommand])

    const {
        isMac,
        actionDefinitions,
        actionShortcuts,
        shortcutListening,
        shortcutListeningDraft,
        setShortcutListening,
        setShortcutListeningDraft,
        saveShortcuts,
    } = useActionShortcuts({
        enabled: isDesktopDashboard && !shortcutHelpOpen,
        onTrigger: actionId => {
            if (actionId === 'openShortcutHelp') {
                handleOpenShortcutHelp()
                return
            }
            if (actionId === 'openNewSession') {
                openNewSession()
                return
            }
            if (actionId === 'hideCurrentTab') {
                if (activeConv) onHideConversation(activeConv)
                return
            }
            if (actionId === 'toggleHiddenTabs') {
                handleHiddenOpenChange(!hiddenOpen)
                return
            }
            if (actionId === 'openHistoryForActiveTab') {
                if (activeConv && !isAcpConv(activeConv)) onOpenHistory(activeConv)
                return
            }
            if (actionId === 'openRemoteForActiveTab') {
                if (activeConv && !isCliConv(activeConv) && !isAcpConv(activeConv)) onOpenRemote(activeConv)
                return
            }
            if (actionId === 'splitActiveTabRight') {
                dockviewActionHandlersRef.current?.splitActiveTabRight()
                return
            }
            if (actionId === 'splitActiveTabDown') {
                dockviewActionHandlersRef.current?.splitActiveTabDown()
                return
            }
            if (actionId === 'floatActiveTab') {
                dockviewActionHandlersRef.current?.floatActiveTab()
                return
            }
            if (actionId === 'popoutActiveTab') {
                dockviewActionHandlersRef.current?.popoutActiveTab()
                return
            }
            if (actionId === 'dockActiveTab') {
                dockviewActionHandlersRef.current?.dockActiveTab()
                return
            }
            if (actionId === 'focusLeftPane') {
                dockviewActionHandlersRef.current?.focusLeftPane()
                return
            }
            if (actionId === 'focusRightPane') {
                dockviewActionHandlersRef.current?.focusRightPane()
                return
            }
            if (actionId === 'focusUpPane') {
                dockviewActionHandlersRef.current?.focusUpPane()
                return
            }
            if (actionId === 'focusDownPane') {
                dockviewActionHandlersRef.current?.focusDownPane()
                return
            }
            if (actionId === 'moveActiveTabToLeftPane') {
                dockviewActionHandlersRef.current?.moveActiveTabToLeftPane()
                return
            }
            if (actionId === 'moveActiveTabToRightPane') {
                dockviewActionHandlersRef.current?.moveActiveTabToRightPane()
                return
            }
            if (actionId === 'moveActiveTabToUpPane') {
                dockviewActionHandlersRef.current?.moveActiveTabToUpPane()
                return
            }
            if (actionId === 'moveActiveTabToDownPane') {
                dockviewActionHandlersRef.current?.moveActiveTabToDownPane()
                return
            }
            if (actionId === 'triggerPrimaryApprovalAction') {
                void handleApprovalShortcut(0)
                return
            }
            if (actionId === 'triggerSecondaryApprovalAction') {
                void handleApprovalShortcut(1)
                return
            }
            if (actionId === 'triggerTertiaryApprovalAction') {
                void handleApprovalShortcut(2)
                return
            }
            if (actionId === 'setActiveTabShortcut') {
                dockviewActionHandlersRef.current?.setShortcutForActiveTab()
                return
            }
            if (actionId === 'selectPreviousGroupTab') {
                dockviewActionHandlersRef.current?.activatePreviousTabInGroup()
                return
            }
            if (actionId === 'selectNextGroupTab') {
                dockviewActionHandlersRef.current?.activateNextTabInGroup()
                return
            }
            if (!activeConv || !isCliConv(activeConv) || isAcpConv(activeConv)) return
            if (actionId === 'toggleCliView') {
                void onSetActiveCliViewMode(activeCliViewMode === 'chat' ? 'terminal' : 'chat')
            }
        },
    })

    const handleCloseShortcutHelp = React.useCallback(() => {
        closeShortcutHelp()
        setShortcutListening(null)
        setShortcutListeningDraft([])
    }, [closeShortcutHelp, setShortcutListening, setShortcutListeningDraft])

    const filteredActionDefinitions = React.useMemo(
        () => shortcutSection === 'all'
            ? actionDefinitions
            : actionDefinitions.filter(action => getShortcutSection(action) === shortcutSection),
        [actionDefinitions, shortcutSection],
    )

    // Derive the approval-button hint from the live default shortcuts so the
    // guide stays correct if the defaults change (previously hardcoded to
    // ⌥J/⌥K/⌥L, which did not match the real ⌥A/⌥D/⌥L defaults).
    const approvalShortcutHint = React.useMemo(
        () => [
            getDefaultShortcut('triggerPrimaryApprovalAction', isMac),
            getDefaultShortcut('triggerSecondaryApprovalAction', isMac),
            getDefaultShortcut('triggerTertiaryApprovalAction', isMac),
        ].filter(Boolean).join(' / '),
        [isMac],
    )
    const modifierShortcutHint = isMac
        ? '⌘⇧Enter, ⌘⇧→, ⌘Ctrl⇧↓'
        : 'Ctrl+Shift+Enter, Ctrl+Shift+→, Ctrl+Alt+Shift+↓'

    const handleDisableAllShortcuts = React.useCallback(() => {
        const next = Object.fromEntries(
            actionDefinitions.map(action => [action.id, '']),
        ) as Record<(typeof actionDefinitions)[number]['id'], string>
        saveShortcuts(next)
    }, [actionDefinitions, saveShortcuts])

    const handleResetShortcutsToDefaults = React.useCallback(async () => {
        const confirmed = await confirmAction({
            title: t('common.confirmTitle'),
            description: t('dashboard.guide.shortcuts.resetConfirm'),
            confirmLabel: t('common.confirm'),
        })
        if (!confirmed) return
        const next = Object.fromEntries(
            actionDefinitions.map(action => [action.id, action.defaultShortcut]),
        ) as Record<(typeof actionDefinitions)[number]['id'], string>
        saveShortcuts(next)
    }, [actionDefinitions, confirmAction, saveShortcuts, t])

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
            const isClose = isMac ? (e.metaKey && e.key.toLowerCase() === 'w') : (e.ctrlKey && e.key.toLowerCase() === 'w')
            if (isClose) {
                e.preventDefault()
                if (activeConv && onHideConversation) {
                    onHideConversation(activeConv)
                }
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [activeConv, onHideConversation])

    React.useEffect(() => {
        if (!shortcutHelpOpen || shortcutListening) return

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            handleCloseShortcutHelp()
        }

        window.addEventListener('keydown', handleKeyDown, true)
        return () => window.removeEventListener('keydown', handleKeyDown, true)
    }, [handleCloseShortcutHelp, shortcutHelpOpen, shortcutListening])

    return (
        <>
            {!showMobileChatMode && (
                <DashboardHeader
                    activeConv={activeConv}
                    wsStatus={wsStatus}
                    isConnected={isConnected}
                    conversations={visibleConversations}
                    hiddenConversations={hiddenConversations}
                    onOpenHistory={onOpenHistory}
                    onHideConversation={onHideConversation}
                    onShowConversation={handleShowHiddenConversationWithRestore}
                    onShowAllHidden={onShowAllHiddenConversations}
                    onResetPanelsToMain={handleResetAllPanelsToMain}
                    notifications={notifications}
                    notificationUnreadCount={notificationUnreadCount}
                    onOpenNotification={handleOpenNotification}
                    onMarkNotificationRead={onMarkNotificationRead}
                    onMarkNotificationUnread={onMarkNotificationUnread}
                    onDeleteNotification={onDeleteNotification}
                    inboxOpen={inboxOpen}
                    onInboxOpenChange={handleInboxOpenChange}
                    hiddenOpen={hiddenOpen}
                    onHiddenOpenChange={handleHiddenOpenChange}
                    onOpenNewSession={!isMobile ? openNewSession : undefined}
                    onOpenDashboardGuide={handleOpenShortcutHelp}
                    guideNudgeVisible={guideNudgeVisible}
                    actionShortcuts={actionShortcuts}
                    onOpenRemote={() => {
                        if (!activeConv || isCliConv(activeConv) || isAcpConv(activeConv)) return
                        onOpenRemote(activeConv)
                    }}
                    onStopCli={onStopCli}
                    activeCliViewMode={activeCliViewMode}
                    onSetCliViewMode={onSetActiveCliViewMode}
                    onOpenGitDialog={handleOpenGitDialog}
                    onOpenMeshGraph={handleOpenMeshGraph}
                />
            )}

            {showMobileChatMode ? (
                <DashboardMobileChatMode
                    conversations={mobileChatConversations}
                    hiddenConversations={hiddenConversations}
                    ides={ides}
                    actionLogs={actionLogs}
                    sendDaemonCommand={sendDaemonCommand}
                    setActionLogs={setActionLogs}
                    setCliViewModeOverrides={setCliViewModeOverrides}
                    isStandalone={isStandalone}
                    userName={userName}
                    requestedActiveTabKey={requestedMobileTabKey}
                    onRequestedActiveTabConsumed={onRequestedMobileTabConsumed}
                    requestedMachineId={requestedMachineId}
                    onRequestedMachineConsumed={onRequestedMachineConsumed}
                    requestedMobileSection={requestedMobileSection}
                    onRequestedMobileSectionConsumed={onRequestedMobileSectionConsumed}
                    onOpenHistory={onOpenHistory}
                    onOpenRemote={onOpenRemote}
                    onStopCli={onStopCli}
                    wsStatus={wsStatus}
                    isConnected={isConnected}
                    initialDataLoaded={initialDataLoaded}
                    onShowAllHiddenConversations={onShowAllHiddenConversations}
                    onHideConversation={onHideConversation}
                    onOpenMeshGraph={handleOpenMeshGraph}
                    onOpenNewSession={openNewSession}
                    liveSessionInboxState={liveSessionInboxState}
                />
            ) : isMobile ? (
                <DashboardPaneWorkspace
                    containerRef={containerRef}
                    isSplitMode={isSplitMode}
                    numGroups={numGroups}
                    groupSizes={groupSizes}
                    groupedConvs={groupedConvs}
                    clearedTabs={clearedTabs}
                    ides={ides}
                    actionLogs={actionLogs}
                    sendDaemonCommand={sendDaemonCommand}
                    setActionLogs={setActionLogs}
                    isStandalone={isStandalone}
                    hasRegisteredMachines={machineEntries.length > 0}
                    initialDataLoaded={initialDataLoaded}
                    userName={userName}
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
                    toggleHiddenTab={toggleHiddenTab}
                    onOpenNewSession={openNewSession}
                    allowTabShortcuts={false}
                    liveSessionInboxState={liveSessionInboxState}
                />
            ) : (
                <DashboardDockviewWorkspace
                    visibleConversations={visibleConversations}
                    clearedTabs={clearedTabs}
                    ides={ides}
                    actionLogs={actionLogs}
                    sendDaemonCommand={sendDaemonCommand}
                    setActionLogs={setActionLogs}
                    isStandalone={isStandalone}
                    hasRegisteredMachines={machineEntries.length > 0}
                    initialDataLoaded={initialDataLoaded}
                    userName={userName}
                    toggleHiddenTab={toggleHiddenTab}
                    actionShortcuts={actionShortcuts}
                    registerActionHandlers={handlers => {
                        dockviewActionHandlersRef.current = handlers
                    }}
                    onActiveTabChange={onDesktopActiveTabChange}
                    requestedActiveTabKey={requestedDesktopTabKey}
                    onRequestedActiveTabConsumed={onRequestedDesktopTabConsumed}
                    onRequestScrollToBottom={onRequestScrollToBottom}
                    scrollToBottomRequest={scrollToBottomRequest}
                    onOpenNewSession={openNewSession}
                    liveSessionInboxState={liveSessionInboxState}
                    layoutProfile={layoutProfile}
                />
            )}
            {newSessionOpen && (
                <DashboardNewSessionDialog
                    key={newSessionInitialTarget ? `${newSessionInitialTarget.machineId}:${newSessionInitialTarget.workspaceId || ''}:${newSessionInitialTarget.mode || ''}:${newSessionInitialTarget.meshWorkspacePath || ''}` : 'default'}
                    machines={machineEntries}
                    ides={ides}
                    initialMachineId={newSessionInitialTarget?.machineId || null}
                    initialWorkspaceId={newSessionInitialTarget?.workspaceId || null}
                    initialLaunchMode={newSessionInitialTarget?.mode || null}
                    initialMeshWorkspacePath={newSessionInitialTarget?.meshWorkspacePath || null}
                    onClose={handleCloseNewSession}
                    onBrowseDirectory={onBrowseMachineDirectory}
                    onSaveWorkspace={onSaveMachineWorkspace}
                    onLaunchIde={onLaunchMachineIde}
                    onLaunchProvider={onLaunchMachineProvider}
                    onListMeshes={onListMachineMeshes}
                    onLaunchMeshCoordinator={onLaunchMeshCoordinator}
                    onListSavedSessions={onListMachineSavedSessions}
                />
            )}
            {meshGraphConversation && (
                <DashboardMeshGraphDialog
                    activeConv={meshGraphConversation}
                    sendDaemonCommand={sendDaemonCommand}
                    onClose={() => setMeshGraphConversation(null)}
                />
            )}
            {actionConfirmDialog}
            {gitDialogTarget && (
                <GitStatusDialog
                    daemonId={gitDialogTarget.daemonId}
                    workspace={gitDialogTarget.workspace}
                    onClose={() => setGitDialogTarget(null)}
                />
            )}
            {shortcutHelpOpen && (
                <ModalPortal>
                <div
                    className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/50"
                    style={{ backdropFilter: 'blur(2px)' }}
                    onClick={handleCloseShortcutHelp}
                >
                    <div
                        className="bg-bg-primary border border-border-subtle rounded-xl w-[min(560px,calc(100vw-32px))] max-h-[min(80vh,720px)] overflow-y-auto px-6 py-5 shadow-xl"
                        onClick={event => event.stopPropagation()}
                    >
                        <div className="flex items-start justify-between gap-4 mb-5">
                            <div>
                                <div className="text-sm font-bold text-text-primary">{t('dashboard.guide.title')}</div>
                                <div className="text-xs text-text-secondary mt-1">
                                    {t('dashboard.guide.subtitle')}
                                </div>
                            </div>
                            <button
                                type="button"
                                className="btn btn-secondary btn-sm inline-flex items-center justify-center w-8 px-0"
                                onClick={handleCloseShortcutHelp}
                                aria-label={t('dashboard.guide.close')}
                            >
                                <IconX size={14} />
                            </button>
                        </div>

                        <div className="flex gap-2 mb-4 overflow-x-auto">
                            {([
                                { id: 'overview', label: t('dashboard.guide.tabs.overview') },
                                { id: 'quickstart', label: t('dashboard.guide.tabs.quickstart') },
                                { id: 'shortcuts', label: t('dashboard.guide.tabs.shortcuts') },
                            ] as const).map(tab => (
                                <button
                                    key={tab.id}
                                    type="button"
                                    className={`btn btn-sm ${guideTab === tab.id ? 'btn-primary' : 'btn-secondary'}`}
                                    onClick={() => setGuideTab(tab.id)}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>

                        {guideTab === 'overview' && (
                            <>
                                <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 px-4 py-3 mb-4">
                                    <div className="text-sm font-semibold text-text-primary">{t('dashboard.guide.overview.whatLivesWhere.title')}</div>
                                    <div className="text-xs text-text-secondary mt-2 space-y-2">
                                        <div><span className="font-semibold text-text-primary">{t('dashboard.guide.overview.whatLivesWhere.tabsLabel')}</span> {t('dashboard.guide.overview.whatLivesWhere.tabsText')}</div>
                                        <div><span className="font-semibold text-text-primary">{t('dashboard.guide.overview.whatLivesWhere.hiddenLabel')}</span> {t('dashboard.guide.overview.whatLivesWhere.hiddenText')}</div>
                                        <div><span className="font-semibold text-text-primary">{t('dashboard.guide.overview.whatLivesWhere.inboxLabel')}</span> {t('dashboard.guide.overview.whatLivesWhere.inboxText')}</div>
                                        <div><span className="font-semibold text-text-primary">{t('dashboard.guide.overview.whatLivesWhere.cliToggleLabel')}</span> {t('dashboard.guide.overview.whatLivesWhere.cliToggleText')}</div>
                                    </div>
                                </div>

                                <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 px-4 py-3">
                                    <div className="text-sm font-semibold text-text-primary">{t('dashboard.guide.overview.usefulFlows.title')}</div>
                                    <div className="text-xs text-text-secondary mt-2 space-y-2">
                                        <div><span className="font-semibold text-text-primary">{t('dashboard.guide.overview.usefulFlows.reviewLabel')}</span> {t('dashboard.guide.overview.usefulFlows.reviewText')}</div>
                                        <div><span className="font-semibold text-text-primary">{t('dashboard.guide.overview.usefulFlows.clutterLabel')}</span> {t('dashboard.guide.overview.usefulFlows.clutterText')}</div>
                                        <div><span className="font-semibold text-text-primary">{t('dashboard.guide.overview.usefulFlows.splitLabel')}</span> {t('dashboard.guide.overview.usefulFlows.splitText')}</div>
                                        <div><span className="font-semibold text-text-primary">{t('dashboard.guide.overview.usefulFlows.detachedLabel')}</span> {t('dashboard.guide.overview.usefulFlows.detachedText')}</div>
                                        <div><span className="font-semibold text-text-primary">{t('dashboard.guide.overview.usefulFlows.dockingLabel')}</span> {t('dashboard.guide.overview.usefulFlows.dockingText')}</div>
                                        <div><span className="font-semibold text-text-primary">{t('dashboard.guide.overview.usefulFlows.perTabLabel')}</span> {t('dashboard.guide.overview.usefulFlows.perTabText')}</div>
                                        <div><span className="font-semibold text-text-primary">{t('dashboard.guide.overview.usefulFlows.approvalLabel')}</span> {t('dashboard.guide.overview.usefulFlows.approvalText', { keys: approvalShortcutHint })}</div>
                                    </div>
                                </div>
                            </>
                        )}

                        {guideTab === 'quickstart' && (
                            <div className="space-y-4">
                                <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 px-4 py-3">
                                    <div className="text-sm font-semibold text-text-primary">{t('dashboard.guide.quickstart.desktop.title')}</div>
                                    <div className="text-xs text-text-secondary mt-2 space-y-2">
                                        <div><span className="font-semibold text-text-primary">1.</span> {t('dashboard.guide.quickstart.desktop.step1')}</div>
                                        <div><span className="font-semibold text-text-primary">2.</span> {t('dashboard.guide.quickstart.desktop.step2')}</div>
                                        <div><span className="font-semibold text-text-primary">3.</span> {t('dashboard.guide.quickstart.desktop.step3')}</div>
                                        <div><span className="font-semibold text-text-primary">4.</span> {t('dashboard.guide.quickstart.desktop.step4')}</div>
                                    </div>
                                </div>

                                <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 px-4 py-3">
                                    <div className="text-sm font-semibold text-text-primary">{t('dashboard.guide.quickstart.mobile.title')}</div>
                                    <div className="text-xs text-text-secondary mt-2 space-y-2">
                                        <div><span className="font-semibold text-text-primary">1.</span> {t('dashboard.guide.quickstart.mobile.step1')}</div>
                                        <div><span className="font-semibold text-text-primary">2.</span> {t('dashboard.guide.quickstart.mobile.step2')}</div>
                                        <div><span className="font-semibold text-text-primary">3.</span> {t('dashboard.guide.quickstart.mobile.step3')}</div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {guideTab === 'shortcuts' && (
                            <>
                                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                                    <div className="flex flex-wrap gap-2">
                                        {([
                                            { id: 'all', label: t('dashboard.guide.shortcuts.sections.all') },
                                            { id: 'workspace', label: t('dashboard.guide.shortcuts.sections.workspace') },
                                            { id: 'panes', label: t('dashboard.guide.shortcuts.sections.panes') },
                                            { id: 'approvals', label: t('dashboard.guide.shortcuts.sections.approvals') },
                                        ] as const).map(section => (
                                            <button
                                                key={section.id}
                                                type="button"
                                                className={`btn btn-sm ${shortcutSection === section.id ? 'btn-primary' : 'btn-secondary'}`}
                                                onClick={() => setShortcutSection(section.id)}
                                            >
                                                {section.label}
                                            </button>
                                        ))}
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            className="btn btn-secondary btn-sm"
                                            onClick={handleDisableAllShortcuts}
                                        >
                                            {t('dashboard.guide.shortcuts.disableAll')}
                                        </button>
                                        <button
                                            type="button"
                                            className="btn btn-sm"
                                            style={{
                                                color: 'var(--status-error, #ef4444)',
                                                borderColor: 'color-mix(in srgb, var(--status-error, #ef4444) 25%, var(--border-subtle, transparent))',
                                                background: 'color-mix(in srgb, var(--status-error, #ef4444) 8%, var(--bg-primary, transparent))',
                                            }}
                                            onClick={handleResetShortcutsToDefaults}
                                        >
                                            {t('dashboard.guide.shortcuts.resetToDefaults')}
                                        </button>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    {filteredActionDefinitions.map(action => (
                                        <div
                                            key={action.id}
                                            className={`rounded-xl border px-4 py-3 ${shortcutListening === action.id ? 'border-accent bg-bg-secondary/70' : 'border-border-subtle bg-bg-secondary/30'}`}
                                        >
                                            <div className="flex items-start justify-between gap-4">
                                                <div className="min-w-0">
                                                    <div className="text-sm font-semibold text-text-primary">{t(`dashboard.shortcutDefs.${action.id}.label`, action.label)}</div>
                                                    <div className="text-xs text-text-secondary mt-1">{t(`dashboard.shortcutDefs.${action.id}.description`, action.description)}</div>
                                                    <div className="text-2xs text-text-muted mt-2">
                                                        {t('dashboard.guide.shortcuts.default')} <span className="font-mono">{action.defaultShortcut}</span>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2 shrink-0">
                                                    <span className="text-2xs font-mono px-2 py-1 rounded bg-surface-secondary border border-border-subtle min-w-[72px] text-center">
                                                        {shortcutListening === action.id
                                                            ? (shortcutListeningDraft.length > 0 ? `${shortcutListeningDraft.join(' ')} ...` : t('dashboard.guide.shortcuts.listening'))
                                                            : (actionShortcuts[action.id] || t('dashboard.guide.shortcuts.off'))}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        className="btn btn-secondary btn-sm"
                                                        onClick={() => {
                                                            setShortcutListening(action.id)
                                                            setShortcutListeningDraft([])
                                                        }}
                                                    >
                                                        {shortcutListening === action.id ? t('dashboard.guide.shortcuts.setListening') : t('dashboard.guide.shortcuts.set')}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="btn btn-secondary btn-sm"
                                                        onClick={() => {
                                                            const next = { ...actionShortcuts }
                                                            next[action.id] = ''
                                                            saveShortcuts(next)
                                                        }}
                                                    >
                                                        {t('dashboard.guide.shortcuts.disable')}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                <div className="text-2xs text-text-muted mt-4">
                                    {t('dashboard.guide.shortcuts.footer', { keys: modifierShortcutHint })}
                                </div>
                            </>
                        )}
                    </div>
                </div>
                </ModalPortal>
            )}
        </>
    )
}
