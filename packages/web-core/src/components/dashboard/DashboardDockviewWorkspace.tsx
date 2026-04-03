import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from 'react'
import {
    DockviewReact,
    themeDark,
    themeLight,
    type DockviewApi,
    type DockviewReadyEvent,
    type IDockviewPanelHeaderProps,
    type IDockviewPanelProps,
} from 'dockview'
import type { ActiveConversation } from './types'
import type { DaemonData } from '../../types'
import type { CliTerminalHandle } from '../CliTerminal'
import PaneGroupContent from './PaneGroupContent'
import PaneGroupEmptyState from './PaneGroupEmptyState'
import { useDashboardConversationCommands } from '../../hooks/useDashboardConversationCommands'
import {
    getDashboardLayoutProfile,
    readDashboardDockviewStoredLayout,
    readLegacyDashboardStoredLayout,
    writeDashboardDockviewStoredLayout,
} from '../../utils/dashboardLayoutStorage'
import { isAcpConv, isCliConv } from './types'
import { useTransport } from '../../context/TransportContext'
import { useTheme } from '../../hooks/useTheme'

interface DashboardDockviewWorkspaceProps {
    visibleConversations: ActiveConversation[]
    clearedTabs: Record<string, number>
    ides: DaemonData[]
    actionLogs: { ideId: string; text: string; timestamp: number }[]
    screenshotMap: Record<string, string>
    setScreenshotMap: (m: Record<string, string>) => void
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>
    setActionLogs: Dispatch<SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
    userName?: string
    detectedIdes?: { type: string; name: string; running: boolean; id?: string }[]
    handleLaunchIde?: (ideType: string) => void
    toggleHiddenTab: (tabKey: string) => void
    onActiveTabChange: (tabKey: string | null) => void
    requestedActiveTabKey?: string | null
    onRequestedActiveTabConsumed?: () => void
}

interface DashboardDockviewContextValue {
    actionLogs: { ideId: string; text: string; timestamp: number }[]
    clearedTabs: Record<string, number>
    conversationsByTabKey: Map<string, ActiveConversation>
    detectedIdes?: { type: string; name: string; running: boolean; id?: string }[]
    handleLaunchIde?: (ideType: string) => void
    ides: DaemonData[]
    isStandalone: boolean
    screenshotMap: Record<string, string>
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setActionLogs: Dispatch<SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>
    setScreenshotMap: (m: Record<string, string>) => void
    toggleHiddenTab: (tabKey: string) => void
    userName?: string
}

interface DashboardDockviewPanelParams {
    tabKey: string
}

const DashboardDockviewContext = createContext<DashboardDockviewContextValue | null>(null)

function useDashboardDockviewContext() {
    const value = useContext(DashboardDockviewContext)
    if (!value) throw new Error('DashboardDockviewContext missing')
    return value
}

function getDockviewTitle(conversation: ActiveConversation) {
    return conversation.displayPrimary || conversation.title || conversation.agentName || conversation.tabKey
}

function useDockviewHeaderRenderTick(props: Pick<IDockviewPanelHeaderProps, 'api' | 'containerApi'>) {
    const [, setTick] = useState(0)

    useEffect(() => {
        const bump = () => setTick(value => value + 1)
        const disposables = [
            props.api.onDidActiveGroupChange(bump),
            props.api.onDidTitleChange(bump),
            props.api.onDidGroupChange(bump),
            props.containerApi.onDidActivePanelChange(bump),
        ]

        return () => {
            for (const disposable of disposables) disposable.dispose()
        }
    }, [props.api, props.containerApi])
}

function groupConversationsFromLegacy(
    visibleConversations: ActiveConversation[],
    legacy: ReturnType<typeof readLegacyDashboardStoredLayout>,
) {
    if (!legacy) return [visibleConversations]

    const legacyAssignments = new Map(legacy.groupAssignments)
    const conversationsByTabKey = new Map(visibleConversations.map(conversation => [conversation.tabKey, conversation]))
    const assignedByGroup = new Map<number, ActiveConversation[]>()

    for (const conversation of visibleConversations) {
        const groupIndex = legacyAssignments.get(conversation.tabKey) ?? 0
        const bucket = assignedByGroup.get(groupIndex) ?? []
        bucket.push(conversation)
        assignedByGroup.set(groupIndex, bucket)
    }

    const sortedGroupIndexes = [...assignedByGroup.keys()].sort((a, b) => a - b)
    return sortedGroupIndexes.map(groupIndex => {
        const conversations = assignedByGroup.get(groupIndex) ?? []
        const preferredOrder = legacy.groupTabOrders[groupIndex] ?? []
        const ordered = preferredOrder
            .map(tabKey => conversationsByTabKey.get(tabKey))
            .filter((conversation): conversation is ActiveConversation => !!conversation)
        const seen = new Set(ordered.map(conversation => conversation.tabKey))
        for (const conversation of conversations) {
            if (!seen.has(conversation.tabKey)) ordered.push(conversation)
        }
        return ordered
    }).filter(group => group.length > 0)
}

function buildInitialDockviewLayout(
    api: DockviewApi,
    visibleConversations: ActiveConversation[],
    requestedActiveTabKey?: string | null,
) {
    const legacy = readLegacyDashboardStoredLayout()
    const groups = groupConversationsFromLegacy(visibleConversations, legacy)
    let previousGroupAnchorId: string | undefined

    for (const group of groups) {
        let groupAnchorId: string | undefined
        for (const conversation of group) {
            const panel = api.addPanel<DashboardDockviewPanelParams>({
                id: conversation.tabKey,
                component: 'conversation',
                title: getDockviewTitle(conversation),
                params: { tabKey: conversation.tabKey },
                ...(groupAnchorId
                    ? { position: { referencePanel: groupAnchorId, direction: 'within' as const }, inactive: true }
                    : previousGroupAnchorId
                        ? { position: { referencePanel: previousGroupAnchorId, direction: 'right' as const }, inactive: true }
                        : {}),
            })
            if (!groupAnchorId) groupAnchorId = panel.id
        }
        previousGroupAnchorId = groupAnchorId ?? previousGroupAnchorId
    }

    const preferredActiveTabKey = requestedActiveTabKey
        ?? (legacy ? legacy.groupActiveTabIds[legacy.focusedGroup] : null)
        ?? visibleConversations[0]?.tabKey
        ?? null
    if (!preferredActiveTabKey) return
    const preferredPanel = api.getPanel(preferredActiveTabKey)
    if (preferredPanel) preferredPanel.group.model.openPanel(preferredPanel)
}

function syncDockviewPanels(api: DockviewApi, visibleConversations: ActiveConversation[]) {
    const visibleKeys = new Set(visibleConversations.map(conversation => conversation.tabKey))

    for (const panel of [...api.panels]) {
        if (!visibleKeys.has(panel.id)) api.removePanel(panel)
    }

    for (const conversation of visibleConversations) {
        const existing = api.getPanel(conversation.tabKey)
        if (existing) {
            existing.update({ params: { tabKey: conversation.tabKey } })
            if (existing.title !== getDockviewTitle(conversation)) {
                existing.api.setTitle(getDockviewTitle(conversation))
            }
            continue
        }

        api.addPanel<DashboardDockviewPanelParams>({
            id: conversation.tabKey,
            component: 'conversation',
            title: getDockviewTitle(conversation),
            params: { tabKey: conversation.tabKey },
            ...(api.activePanel
                ? { position: { referencePanel: api.activePanel.id, direction: 'within' as const }, inactive: true }
                : api.panels[0]
                    ? { position: { referencePanel: api.panels[0].id, direction: 'within' as const }, inactive: true }
                    : {}),
        })
    }
}

function DashboardDockviewPanel({ params }: IDockviewPanelProps<DashboardDockviewPanelParams>) {
    const ctx = useDashboardDockviewContext()
    const terminalRef = useRef<CliTerminalHandle>(null)
    const activeConv = ctx.conversationsByTabKey.get(params.tabKey)
    const cmds = useDashboardConversationCommands({
        sendDaemonCommand: ctx.sendDaemonCommand,
        activeConv,
        setLocalUserMessages: ctx.setLocalUserMessages,
        setActionLogs: ctx.setActionLogs,
        isStandalone: ctx.isStandalone,
    })

    const activeIdeEntry = useMemo(
        () => activeConv ? ctx.ides.find(ide => ide.id === activeConv.ideId) : undefined,
        [ctx.ides, activeConv],
    )
    const activeScreenshotUrl = activeConv ? ctx.screenshotMap[activeConv.ideId] : undefined
    const clearActiveScreenshot = useCallback(() => {
        if (!activeConv) return
        if (!(activeConv.ideId in ctx.screenshotMap)) return
        const next = { ...ctx.screenshotMap }
        delete next[activeConv.ideId]
        ctx.setScreenshotMap(next)
    }, [activeConv, ctx])
    const activeActionLogs = useMemo(() => {
        if (!activeConv) return []
        return ctx.actionLogs.filter(log => log.ideId === activeConv.tabKey)
    }, [ctx.actionLogs, activeConv])

    if (!activeConv) {
        return (
            <div className="h-full min-h-0 min-w-0 flex flex-col">
                <PaneGroupEmptyState
                    conversationsCount={0}
                    isSplitMode={false}
                    isStandalone={ctx.isStandalone}
                    detectedIdes={ctx.detectedIdes}
                    handleLaunchIde={ctx.handleLaunchIde}
                />
            </div>
        )
    }

    const isCli = isCliConv(activeConv) && !isAcpConv(activeConv)

    return (
        <div className="h-full min-h-0 min-w-0 flex flex-col overflow-hidden">
            <PaneGroupContent
                activeConv={activeConv}
                clearToken={ctx.clearedTabs[activeConv.tabKey] || 0}
                isCli={isCli}
                ideEntry={activeIdeEntry}
                screenshotUrl={activeScreenshotUrl}
                clearScreenshot={clearActiveScreenshot}
                terminalRef={terminalRef}
                handleModalButton={cmds.handleModalButton}
                handleRelaunch={cmds.handleRelaunch}
                handleSendChat={cmds.handleSendChat}
                isSendingChat={cmds.isSendingChat}
                handleFocusAgent={cmds.handleFocusAgent}
                isFocusingAgent={cmds.isFocusingAgent}
                actionLogs={activeActionLogs}
                userName={ctx.userName}
            />
        </div>
    )
}

function DashboardDockviewWatermark() {
    const ctx = useDashboardDockviewContext()
    return (
        <div className="h-full min-h-0 min-w-0 flex flex-col items-center justify-center">
            <PaneGroupEmptyState
                conversationsCount={0}
                isSplitMode={false}
                isStandalone={ctx.isStandalone}
                detectedIdes={ctx.detectedIdes}
                handleLaunchIde={ctx.handleLaunchIde}
            />
        </div>
    )
}

function DashboardDockviewTab(props: IDockviewPanelHeaderProps<DashboardDockviewPanelParams>) {
    useDockviewHeaderRenderTick(props)
    const ctx = useDashboardDockviewContext()
    const conversation = ctx.conversationsByTabKey.get(props.params.tabKey)

    if (!conversation) {
        return (
            <div className="adhdev-dockview-tab adhdev-dockview-tab-empty">
                <div className="adhdev-dockview-tab-copy">
                    <div className="adhdev-dockview-tab-primary">{props.api.title || props.params.tabKey}</div>
                </div>
            </div>
        )
    }

    const isActive = props.api.group.activePanel?.id === props.api.id
    const isGroupActive = props.api.isGroupActive
    const isReconnecting = conversation.connectionState === 'failed' || conversation.connectionState === 'closed'
    const isConnecting = conversation.connectionState === 'connecting' || conversation.connectionState === 'new'
    const isGenerating = conversation.status === 'generating'
    const isWaiting = conversation.status === 'waiting_approval'

    return (
        <div
            className={`adhdev-dockview-tab${isActive ? ' is-active' : ''}${isGroupActive ? ' is-group-active' : ''}${isReconnecting ? ' is-reconnecting' : ''}`}
            title={conversation.displayPrimary}
        >
            <div className="adhdev-dockview-tab-status" aria-hidden="true">
                {isGenerating ? (
                    <div className="tab-spinner" />
                ) : isWaiting ? (
                    <span className="adhdev-dockview-tab-status-text is-waiting">▲</span>
                ) : isReconnecting ? (
                    <span className="adhdev-dockview-tab-status-text is-reconnecting">○</span>
                ) : isConnecting ? (
                    <div className="tab-connecting-spinner" />
                ) : conversation.connectionState === 'connected' ? (
                    <span className="adhdev-dockview-tab-status-text is-connected">●</span>
                ) : (
                    <span className="adhdev-dockview-tab-status-text is-idle">○</span>
                )}
            </div>
            <div className="adhdev-dockview-tab-copy">
                <div className="adhdev-dockview-tab-primary">{conversation.displayPrimary}</div>
                <div className="adhdev-dockview-tab-meta">
                    {isReconnecting ? (
                        <span className="adhdev-dockview-tab-reconnecting">Reconnecting…</span>
                    ) : isConnecting ? (
                        <span className="adhdev-dockview-tab-connecting">Connecting…</span>
                    ) : (
                        <>
                            <span>{conversation.displaySecondary}</span>
                            {conversation.machineName && (
                                <>
                                    <span className="adhdev-dockview-tab-dot">·</span>
                                    <span className="adhdev-dockview-tab-machine">🖥 {conversation.machineName}</span>
                                </>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}

export default function DashboardDockviewWorkspace({
    visibleConversations,
    clearedTabs,
    ides,
    actionLogs,
    screenshotMap,
    setScreenshotMap,
    sendDaemonCommand,
    setLocalUserMessages,
    setActionLogs,
    isStandalone,
    userName,
    detectedIdes,
    handleLaunchIde,
    toggleHiddenTab,
    onActiveTabChange,
    requestedActiveTabKey,
    onRequestedActiveTabConsumed,
}: DashboardDockviewWorkspaceProps) {
    const { theme } = useTheme()
    const { sendCommand } = useTransport()
    const apiRef = useRef<DockviewApi | null>(null)
    const dockviewContainerRef = useRef<HTMLDivElement | null>(null)
    const hasInitializedRef = useRef(false)
    const [isDraggingDockview, setIsDraggingDockview] = useState(false)
    const [isShowingDockviewOverlay, setIsShowingDockviewOverlay] = useState(false)
    const overlayCleanupTimeoutRef = useRef<number | null>(null)
    const layoutProfile = useMemo(
        () => getDashboardLayoutProfile(typeof window !== 'undefined' ? window.innerWidth : 1280),
        [],
    )
    const conversationsByTabKey = useMemo(
        () => new Map(visibleConversations.map(conversation => [conversation.tabKey, conversation])),
        [visibleConversations],
    )
    const contextValue = useMemo<DashboardDockviewContextValue>(() => ({
        actionLogs,
        clearedTabs,
        conversationsByTabKey,
        detectedIdes,
        handleLaunchIde,
        ides,
        isStandalone,
        screenshotMap,
        sendDaemonCommand,
        setActionLogs,
        setLocalUserMessages,
        setScreenshotMap,
        toggleHiddenTab,
        userName,
    }), [
        actionLogs,
        clearedTabs,
        conversationsByTabKey,
        detectedIdes,
        handleLaunchIde,
        ides,
        isStandalone,
        screenshotMap,
        sendDaemonCommand,
        setActionLogs,
        setLocalUserMessages,
        setScreenshotMap,
        toggleHiddenTab,
        userName,
    ])

    const activateRequestedTab = useCallback((tabKey: string | null | undefined) => {
        if (!tabKey) return false
        const api = apiRef.current
        if (!api) return false
        const panel = api.getPanel(tabKey)
        if (!panel) return false
        panel.group.model.openPanel(panel)
        onRequestedActiveTabConsumed?.()
        return true
    }, [onRequestedActiveTabConsumed])

    const markDockviewOverlaysHidden = useCallback(() => {
        const root = dockviewContainerRef.current
        if (!root) return
        const nodes = root.querySelectorAll<HTMLElement>(
            '.dv-drop-target-container, .dv-drop-target-anchor, .dv-drop-target-dropzone, .dv-drop-target-selection, .dv-render-overlay',
        )
        for (const node of nodes) {
            node.setAttribute('data-adhdev-force-hidden', 'true')
        }
    }, [])

    const clearDockviewOverlayHiddenMarks = useCallback(() => {
        const root = dockviewContainerRef.current
        if (!root) return
        const nodes = root.querySelectorAll<HTMLElement>('[data-adhdev-force-hidden="true"]')
        for (const node of nodes) {
            node.removeAttribute('data-adhdev-force-hidden')
        }
    }, [])

    const removeDockviewOverlayNodes = useCallback(() => {
        const root = dockviewContainerRef.current
        if (!root) return

        const dropTargetRoots = root.querySelectorAll<HTMLElement>('.dv-drop-target-container')
        for (const node of dropTargetRoots) {
            node.remove()
        }

        const dropzones = root.querySelectorAll<HTMLElement>('.dv-drop-target-dropzone')
        for (const node of dropzones) {
            node.remove()
        }

        const dropTargetParents = root.querySelectorAll<HTMLElement>('.dv-drop-target')
        for (const node of dropTargetParents) {
            node.classList.remove('dv-drop-target')
        }
    }, [])

    const cleanupDockviewOverlays = useCallback(() => {
        setIsDraggingDockview(false)
        setIsShowingDockviewOverlay(false)
        clearDockviewOverlayHiddenMarks()
        markDockviewOverlaysHidden()
        removeDockviewOverlayNodes()
        if (typeof window === 'undefined') return
        if (overlayCleanupTimeoutRef.current != null) {
            window.clearTimeout(overlayCleanupTimeoutRef.current)
        }
        window.requestAnimationFrame(() => {
            markDockviewOverlaysHidden()
            removeDockviewOverlayNodes()
        })
        overlayCleanupTimeoutRef.current = window.setTimeout(() => {
            markDockviewOverlaysHidden()
            removeDockviewOverlayNodes()
            overlayCleanupTimeoutRef.current = null
        }, 80)
    }, [clearDockviewOverlayHiddenMarks, markDockviewOverlaysHidden, removeDockviewOverlayNodes])

    const handleReady = useCallback((event: DockviewReadyEvent) => {
        apiRef.current = event.api

        const stored = readDashboardDockviewStoredLayout(layoutProfile)
        if (stored?.layout) {
            event.api.fromJSON(stored.layout, { reuseExistingPanels: false })
        }

        syncDockviewPanels(event.api, visibleConversations)

        if (event.api.totalPanels === 0 && visibleConversations.length > 0) {
            buildInitialDockviewLayout(event.api, visibleConversations, requestedActiveTabKey)
        } else if (!activateRequestedTab(requestedActiveTabKey)) {
            activateRequestedTab(stored?.activeTabId)
        }

        hasInitializedRef.current = true

        event.api.onDidActivePanelChange(panel => {
            onActiveTabChange(panel?.id ?? null)
            if (!panel) return
            const conversation = conversationsByTabKey.get(panel.id)
            if (conversation?.streamSource === 'agent-stream' && conversation.agentType) {
                sendCommand(conversation.ideId, 'focus_session', {
                    agentType: conversation.agentType,
                    ...(conversation.sessionId && { targetSessionId: conversation.sessionId }),
                }).catch(() => {})
            }
        })

        event.api.onDidLayoutChange(() => {
            writeDashboardDockviewStoredLayout(layoutProfile, {
                activeTabId: event.api.activePanel?.id ?? null,
                layout: event.api.toJSON(),
            })
        })

        event.api.onWillDragPanel(() => {
            setIsDraggingDockview(true)
            setIsShowingDockviewOverlay(false)
            markDockviewOverlaysHidden()
        })
        event.api.onWillDragGroup(() => {
            setIsDraggingDockview(true)
            setIsShowingDockviewOverlay(false)
            markDockviewOverlaysHidden()
        })
        event.api.onWillShowOverlay(() => {
            clearDockviewOverlayHiddenMarks()
            setIsShowingDockviewOverlay(true)
        })
        event.api.onDidMovePanel(cleanupDockviewOverlays)
        event.api.onDidDrop(cleanupDockviewOverlays)

        onActiveTabChange(event.api.activePanel?.id ?? null)
    }, [
        activateRequestedTab,
        cleanupDockviewOverlays,
        clearDockviewOverlayHiddenMarks,
        conversationsByTabKey,
        layoutProfile,
        markDockviewOverlaysHidden,
        removeDockviewOverlayNodes,
        onActiveTabChange,
        requestedActiveTabKey,
        sendCommand,
        visibleConversations,
    ])

    useEffect(() => {
        const api = apiRef.current
        if (!api || !hasInitializedRef.current) return

        syncDockviewPanels(api, visibleConversations)

        if (!api.activePanel && api.panels[0]) {
            api.panels[0].group.model.openPanel(api.panels[0])
        }
    }, [visibleConversations])

    useEffect(() => {
        if (!hasInitializedRef.current) return
        activateRequestedTab(requestedActiveTabKey)
    }, [activateRequestedTab, requestedActiveTabKey])

    useEffect(() => {
        if (!isDraggingDockview || typeof window === 'undefined') return
        const handlePointerUp = () => cleanupDockviewOverlays()
        window.addEventListener('pointerup', handlePointerUp)
        window.addEventListener('mouseup', handlePointerUp)
        window.addEventListener('dragend', handlePointerUp)
        return () => {
            window.removeEventListener('pointerup', handlePointerUp)
            window.removeEventListener('mouseup', handlePointerUp)
            window.removeEventListener('dragend', handlePointerUp)
        }
    }, [cleanupDockviewOverlays, isDraggingDockview])

    useEffect(() => {
        return () => {
            if (typeof window === 'undefined') return
            if (overlayCleanupTimeoutRef.current != null) {
                window.clearTimeout(overlayCleanupTimeoutRef.current)
            }
        }
    }, [])

    const dockviewTheme = theme === 'light' ? themeLight : themeDark

    return (
        <DashboardDockviewContext.Provider value={contextValue}>
            <div ref={dockviewContainerRef} className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <DockviewReact
                    className={`h-full min-h-0 min-w-0 adhdev-dockview${isDraggingDockview ? ' is-dragging-dockview' : ''}${isShowingDockviewOverlay ? ' is-showing-dockview-overlay' : ''}`}
                    components={{ conversation: DashboardDockviewPanel }}
                    defaultTabComponent={DashboardDockviewTab}
                    watermarkComponent={DashboardDockviewWatermark}
                    onReady={handleReady}
                    singleTabMode="default"
                    tabAnimation="smooth"
                    theme={dockviewTheme}
                />
            </div>
        </DashboardDockviewContext.Provider>
    )
}
