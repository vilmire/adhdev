import React from 'react'
import { flushSync } from 'react-dom'
import type { DaemonData } from '../../types'
import type { ActiveConversation, CliConversationViewMode } from './types'
import { isAcpConv, isCliConv } from './types'
import DashboardHeader from './DashboardHeader'
import DashboardMobileChatMode from './DashboardMobileChatMode'
import DashboardPaneWorkspace from './DashboardPaneWorkspace'
import DashboardDockviewWorkspace from './DashboardDockviewWorkspace'
import DashboardNewSessionDialog from './DashboardNewSessionDialog'
import type { DashboardMobileSection } from './DashboardMobileBottomNav'
import { useActionShortcuts, type DashboardActionShortcutDefinition } from '../../hooks/useActionShortcuts'
import { getProviderArgs, getRouteTarget } from '../../hooks/dashboardCommandUtils'
import type { BrowseDirectoryResult } from '../machine/workspaceBrowse'
import { IconX } from '../Icons'

type GuideTabId = 'overview' | 'quickstart' | 'shortcuts'
type ShortcutSectionId = 'all' | 'workspace' | 'panes' | 'approvals'

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
    chatIdes: DaemonData[]
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
    setLocalUserMessages: React.Dispatch<React.SetStateAction<Record<string, any[]>>>
    setActionLogs: React.Dispatch<React.SetStateAction<{ routeId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
    initialDataLoaded: boolean
    userName?: string
    requestedMobileTabKey: string | null
    onRequestedMobileTabConsumed: () => void
    requestedMachineId: string | null
    onRequestedMachineConsumed: () => void
    requestedMobileSection: DashboardMobileSection | null
    onRequestedMobileSectionConsumed: () => void
    containerRef: React.RefObject<HTMLDivElement>
    isSplitMode: boolean
    numGroups: number
    groupSizes: number[]
    groupedConvs: ActiveConversation[][]
    clearedTabs: Record<string, number>
    focusedGroup: number
    setFocusedGroup: React.Dispatch<React.SetStateAction<number>>
    moveTabToGroup: (tabKey: string, nextGroupIndex: number) => void
    splitTabRelative: (tabKey: string, targetGroup: number, side: 'left' | 'right') => void
    closeGroup: (groupIndex: number) => void
    handleResizeStart: (dividerIdx: number, event: React.MouseEvent) => void
    groupActiveTabIds: Record<number, string | null>
    setGroupActiveTabIds: React.Dispatch<React.SetStateAction<Record<number, string | null>>>
    groupTabOrders: Record<number, string[]>
    setGroupTabOrders: React.Dispatch<React.SetStateAction<Record<number, string[]>>>
    toggleHiddenTab: (tabKey: string) => void
    visibleConversations: ActiveConversation[]
    requestedDesktopTabKey: string | null
    onRequestedDesktopTabConsumed: () => void
    onDesktopActiveTabChange: React.Dispatch<React.SetStateAction<string | null>>
    onHideConversation: (conversation: ActiveConversation) => void
    onShowHiddenConversation: (conversation: ActiveConversation) => void
    onShowAllHiddenConversations: () => void
    scrollToBottomRequest?: { tabKey: string; nonce: number } | null
    machineEntries: DaemonData[]
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
        },
    ) => Promise<{ ok: boolean; error?: string }>
    onListMachineSavedSessions: (machineId: string, providerType: string) => Promise<Array<{
        id: string
        providerSessionId: string
        providerType: string
        providerName: string
        kind: 'cli' | 'acp'
        title: string
        workspace?: string | null
        currentModel?: string
        preview?: string
        messageCount: number
        firstMessageAt: number
        lastMessageAt: number
        canResume: boolean
    }>>
}

export default function DashboardMainView({
    showMobileChatMode,
    isMobile,
    activeConv,
    chatIdes,
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
    setLocalUserMessages,
    setActionLogs,
    isStandalone,
    initialDataLoaded,
    userName,
    requestedMobileTabKey,
    onRequestedMobileTabConsumed,
    requestedMachineId,
    onRequestedMachineConsumed,
    requestedMobileSection,
    onRequestedMobileSectionConsumed,
    containerRef,
    isSplitMode,
    numGroups,
    groupSizes,
    groupedConvs,
    clearedTabs,
    focusedGroup,
    setFocusedGroup,
    moveTabToGroup,
    splitTabRelative,
    closeGroup,
    handleResizeStart,
    groupActiveTabIds,
    setGroupActiveTabIds,
    groupTabOrders,
    setGroupTabOrders,
    toggleHiddenTab,
    visibleConversations,
    requestedDesktopTabKey,
    onRequestedDesktopTabConsumed,
    onDesktopActiveTabChange,
    onHideConversation,
    onShowHiddenConversation,
    onShowAllHiddenConversations,
    scrollToBottomRequest,
    machineEntries,
    onBrowseMachineDirectory,
    onSaveMachineWorkspace,
    onLaunchMachineIde,
    onLaunchMachineProvider,
    onListMachineSavedSessions,
}: DashboardMainViewProps) {
    const dockviewActionHandlersRef = React.useRef<{
        setShortcutForActiveTab: () => void
        restoreHiddenTabToSavedLocation: (tabKey: string) => void
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
    const [inboxOpen, setInboxOpen] = React.useState(false)
    const [hiddenOpen, setHiddenOpen] = React.useState(false)
    const [shortcutHelpOpen, setShortcutHelpOpen] = React.useState(false)
    const [newSessionOpen, setNewSessionOpen] = React.useState(false)

    const handleShowHiddenConversationWithRestore = React.useCallback((conversation: ActiveConversation) => {
        flushSync(() => {
            onShowHiddenConversation(conversation)
        })
        dockviewActionHandlersRef.current?.restoreHiddenTabToSavedLocation(conversation.tabKey)
    }, [onShowHiddenConversation])
    const [guideNudgeVisible, setGuideNudgeVisible] = React.useState(false)
    const [guideTab, setGuideTab] = React.useState<GuideTabId>('quickstart')
    const [shortcutSection, setShortcutSection] = React.useState<ShortcutSectionId>('workspace')
    const isDesktopDashboard = !showMobileChatMode && !isMobile

    const handleInboxOpenChange = React.useCallback((next: boolean) => {
        setInboxOpen(next)
        if (next) setHiddenOpen(false)
    }, [])

    const handleHiddenOpenChange = React.useCallback((next: boolean) => {
        setHiddenOpen(next)
        if (next) setInboxOpen(false)
    }, [])

    const handleResetAllPanelsToMain = React.useCallback(() => {
        const confirmed = window.confirm('Move every floating or popout panel back into the main dashboard grid?')
        if (!confirmed) return
        dockviewActionHandlersRef.current?.resetAllPanelsToMain()
        setHiddenOpen(false)
    }, [])

    const handleOpenShortcutHelp = React.useCallback(() => {
        setGuideTab(visibleConversations.length === 0 ? 'quickstart' : 'shortcuts')
        setShortcutSection('workspace')
        setShortcutHelpOpen(true)
        setInboxOpen(false)
        setHiddenOpen(false)
    }, [visibleConversations.length])

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
        setShortcutHelpOpen(false)
        setShortcutListening(null)
        setShortcutListeningDraft([])
    }, [setShortcutListening, setShortcutListeningDraft])

    const filteredActionDefinitions = React.useMemo(
        () => shortcutSection === 'all'
            ? actionDefinitions
            : actionDefinitions.filter(action => getShortcutSection(action) === shortcutSection),
        [actionDefinitions, shortcutSection],
    )

    const handleDisableAllShortcuts = React.useCallback(() => {
        const next = Object.fromEntries(
            actionDefinitions.map(action => [action.id, '']),
        ) as Record<(typeof actionDefinitions)[number]['id'], string>
        saveShortcuts(next)
    }, [actionDefinitions, saveShortcuts])

    const handleResetShortcutsToDefaults = React.useCallback(() => {
        if (typeof window !== 'undefined') {
            const confirmed = window.confirm('Reset all dashboard shortcuts back to their default values?')
            if (!confirmed) return
        }
        const next = Object.fromEntries(
            actionDefinitions.map(action => [action.id, action.defaultShortcut]),
        ) as Record<(typeof actionDefinitions)[number]['id'], string>
        saveShortcuts(next)
    }, [actionDefinitions, saveShortcuts])

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

    React.useEffect(() => {
        if (!isDesktopDashboard) {
            setGuideNudgeVisible(false)
            return
        }
        setGuideNudgeVisible(true)
        const timer = window.setTimeout(() => {
            setGuideNudgeVisible(false)
        }, 10000)
        return () => window.clearTimeout(timer)
    }, [isDesktopDashboard])

    return (
        <>
            {!showMobileChatMode && (
                <DashboardHeader
                    activeConv={activeConv}
                    agentCount={chatIdes.length}
                    wsStatus={wsStatus}
                    isConnected={isConnected}
                    conversations={visibleConversations}
                    hiddenConversations={hiddenConversations}
                    onOpenHistory={onOpenHistory}
                    onOpenConversation={handleShowHiddenConversationWithRestore}
                    onHideConversation={onHideConversation}
                    onShowConversation={handleShowHiddenConversationWithRestore}
                    onShowAllHidden={onShowAllHiddenConversations}
                    onResetPanelsToMain={handleResetAllPanelsToMain}
                    inboxOpen={inboxOpen}
                    onInboxOpenChange={handleInboxOpenChange}
                    hiddenOpen={hiddenOpen}
                    onHiddenOpenChange={handleHiddenOpenChange}
                    onOpenNewSession={!isMobile ? () => setNewSessionOpen(true) : undefined}
                    actionShortcuts={actionShortcuts}
                    onOpenRemote={() => {
                        if (!activeConv || isCliConv(activeConv) || isAcpConv(activeConv)) return
                        onOpenRemote(activeConv)
                    }}
                    onStopCli={onStopCli}
                    activeCliViewMode={activeCliViewMode}
                    onSetCliViewMode={onSetActiveCliViewMode}
                />
            )}

            {showMobileChatMode ? (
                <DashboardMobileChatMode
                    conversations={mobileChatConversations}
                    hiddenConversations={hiddenConversations}
                    ides={ides}
                    actionLogs={actionLogs}
                    sendDaemonCommand={sendDaemonCommand}
                    setLocalUserMessages={setLocalUserMessages}
                    setActionLogs={setActionLogs}
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
                    onShowHiddenConversation={handleShowHiddenConversationWithRestore}
                    onShowAllHiddenConversations={onShowAllHiddenConversations}
                    onOpenNewSession={() => setNewSessionOpen(true)}
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
                    setLocalUserMessages={setLocalUserMessages}
                    setActionLogs={setActionLogs}
                    isStandalone={isStandalone}
                    hasRegisteredMachines={machineEntries.length > 0}
                    userName={userName}
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
                    toggleHiddenTab={toggleHiddenTab}
                    allowTabShortcuts={false}
                />
            ) : (
                <DashboardDockviewWorkspace
                    visibleConversations={visibleConversations}
                    clearedTabs={clearedTabs}
                    ides={ides}
                    actionLogs={actionLogs}
                    sendDaemonCommand={sendDaemonCommand}
                    setLocalUserMessages={setLocalUserMessages}
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
                    scrollToBottomRequest={scrollToBottomRequest}
                />
            )}
            {newSessionOpen && (
                <DashboardNewSessionDialog
                    machines={machineEntries}
                    conversations={mobileChatConversations}
                    ides={ides}
                    onClose={() => setNewSessionOpen(false)}
                    onBrowseDirectory={onBrowseMachineDirectory}
                    onSaveWorkspace={onSaveMachineWorkspace}
                    onLaunchIde={onLaunchMachineIde}
                    onLaunchProvider={onLaunchMachineProvider}
                    onListSavedSessions={onListMachineSavedSessions}
                    sendDaemonCommand={sendDaemonCommand}
                    onOpenConversation={(conversation) => {
                        setNewSessionOpen(false)
                        onShowHiddenConversation(conversation)
                        onDesktopActiveTabChange(conversation.tabKey)
                    }}
                />
            )}
            {shortcutHelpOpen && (
                <div
                    className="fixed inset-0 z-[60] flex items-center justify-center"
                    style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
                    onClick={handleCloseShortcutHelp}
                >
                    <div
                        className="bg-bg-primary border border-border-subtle rounded-xl w-[min(560px,calc(100vw-32px))] max-h-[min(80vh,720px)] overflow-y-auto px-6 py-5 shadow-xl"
                        onClick={event => event.stopPropagation()}
                    >
                        <div className="flex items-start justify-between gap-4 mb-5">
                            <div>
                                <div className="text-sm font-bold text-text-primary">Dashboard guide</div>
                                <div className="text-xs text-text-secondary mt-1">
                                    A quick guide to the dashboard flow, floating and popout tabs, plus grouped shortcuts you can tune.
                                </div>
                            </div>
                            <button
                                type="button"
                                className="btn btn-secondary btn-sm inline-flex items-center justify-center w-8 px-0"
                                onClick={handleCloseShortcutHelp}
                                aria-label="Close dashboard guide"
                            >
                                <IconX size={14} />
                            </button>
                        </div>

                        <div className="flex gap-2 mb-4 overflow-x-auto">
                            {([
                                { id: 'overview', label: 'Overview' },
                                { id: 'quickstart', label: 'Quick start' },
                                { id: 'shortcuts', label: 'Shortcuts' },
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
                                    <div className="text-sm font-semibold text-text-primary">What lives where</div>
                                    <div className="text-xs text-text-secondary mt-2 space-y-2">
                                        <div><span className="font-semibold text-text-primary">Tabs:</span> active sessions across IDE, CLI, and ACP agents.</div>
                                        <div><span className="font-semibold text-text-primary">Hidden tabs:</span> stash sessions you do not want in the main strip but still want to keep around.</div>
                                        <div><span className="font-semibold text-text-primary">Activity inbox:</span> sessions waiting for approval or finished tasks you have not reviewed yet.</div>
                                        <div><span className="font-semibold text-text-primary">CLI view toggle:</span> switch a PTY session between terminal and chat rendering without relaunching it.</div>
                                    </div>
                                </div>

                                <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 px-4 py-3">
                                    <div className="text-sm font-semibold text-text-primary">Useful flows</div>
                                    <div className="text-xs text-text-secondary mt-2 space-y-2">
                                        <div><span className="font-semibold text-text-primary">Review notifications:</span> open the inbox, jump to the session, then use the conversation or approval controls directly from the active pane.</div>
                                        <div><span className="font-semibold text-text-primary">Reduce clutter:</span> hide less important sessions instead of closing them, then restore from hidden tabs when needed.</div>
                                        <div><span className="font-semibold text-text-primary">Split work:</span> keep one pane active for input and let secondary panes stay read-only until you focus them.</div>
                                        <div><span className="font-semibold text-text-primary">Detached views:</span> float a tab for quick side-by-side work, or pop it into a new window when you want a separate monitor.</div>
                                        <div><span className="font-semibold text-text-primary">Docking:</span> use Dock to bring a floating tab back into the grid, or move a popped out tab back to the main dashboard.</div>
                                        <div><span className="font-semibold text-text-primary">Per-tab shortcuts:</span> right-click a Dockview tab to assign a direct shortcut for that specific session.</div>
                                        <div><span className="font-semibold text-text-primary">Approval buttons:</span> use {isMac ? '⌥J / ⌥K / ⌥L' : 'Ctrl+Alt+J / K / L'} for the first three visible approval actions on the active session.</div>
                                    </div>
                                </div>
                            </>
                        )}

                        {guideTab === 'quickstart' && (
                            <div className="space-y-4">
                                <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 px-4 py-3">
                                    <div className="text-sm font-semibold text-text-primary">Desktop quick start</div>
                                    <div className="text-xs text-text-secondary mt-2 space-y-2">
                                        <div><span className="font-semibold text-text-primary">1.</span> Start from the machine or workspace flow first. Pick or save a workspace before launching CLI or ACP sessions.</div>
                                        <div><span className="font-semibold text-text-primary">2.</span> Keep the main strip focused on active work and push overflow into Hidden tabs.</div>
                                        <div><span className="font-semibold text-text-primary">3.</span> Use the inbox for approval-required or completed sessions instead of scanning every tab.</div>
                                        <div><span className="font-semibold text-text-primary">4.</span> Split only when you need parallel reading; float or pop out a tab when you want to detach it without losing the main layout.</div>
                                    </div>
                                </div>

                                <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 px-4 py-3">
                                    <div className="text-sm font-semibold text-text-primary">Mobile quick start</div>
                                    <div className="text-xs text-text-secondary mt-2 space-y-2">
                                        <div><span className="font-semibold text-text-primary">1.</span> Stay in chat mode for review and replies; use workspace mode mainly to launch or reopen sessions.</div>
                                        <div><span className="font-semibold text-text-primary">2.</span> Start from the machine screen, choose a workspace, then launch IDE, CLI, or ACP from there.</div>
                                        <div><span className="font-semibold text-text-primary">3.</span> Treat mobile as the simpler control surface: no split workflow, fewer tab mechanics, faster session switching.</div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {guideTab === 'shortcuts' && (
                            <>
                                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                                    <div className="flex flex-wrap gap-2">
                                        {([
                                            { id: 'all', label: 'All' },
                                            { id: 'workspace', label: 'Workspace' },
                                            { id: 'panes', label: 'Panes' },
                                            { id: 'approvals', label: 'Approvals' },
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
                                            Disable all
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
                                            Reset to defaults
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
                                                    <div className="text-sm font-semibold text-text-primary">{action.label}</div>
                                                    <div className="text-xs text-text-secondary mt-1">{action.description}</div>
                                                    <div className="text-[11px] text-text-muted mt-2">
                                                        Default: <span className="font-mono">{action.defaultShortcut}</span>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2 shrink-0">
                                                    <span className="text-[11px] font-mono px-2 py-1 rounded bg-bg-tertiary border border-border-subtle min-w-[72px] text-center">
                                                        {shortcutListening === action.id
                                                            ? (shortcutListeningDraft.length > 0 ? `${shortcutListeningDraft.join(' ')} ...` : 'Listening...')
                                                            : (actionShortcuts[action.id] || 'Off')}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        className="btn btn-secondary btn-sm"
                                                        onClick={() => {
                                                            setShortcutListening(action.id)
                                                            setShortcutListeningDraft([])
                                                        }}
                                                    >
                                                        {shortcutListening === action.id ? 'Listening' : 'Set'}
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
                                                        Disable
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                <div className="text-[11px] text-text-muted mt-4">
                                    Use modifier shortcuts like {isMac ? '⌥S' : 'Ctrl+Alt+S'}. Press Esc to stop listening.
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}
            {!showMobileChatMode && (
                <button
                    type="button"
                    onClick={handleOpenShortcutHelp}
                    className={`fixed right-4 bottom-24 z-40 hidden md:inline-flex items-center rounded-full border border-border-subtle bg-bg-primary/88 backdrop-blur py-2 text-xs text-text-secondary hover:text-text-primary transition-all ${guideNudgeVisible ? 'gap-2 px-2.5' : 'justify-center w-10 px-0'}`}
                    style={{ boxShadow: '0 6px 18px rgba(0,0,0,0.12)' }}
                    title="Dashboard guide"
                    aria-label="Open dashboard guide"
                >
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-bg-secondary text-[11px] font-semibold text-text-primary shrink-0">?</span>
                    {guideNudgeVisible && <span>Guide</span>}
                </button>
            )}
        </>
    )
}
