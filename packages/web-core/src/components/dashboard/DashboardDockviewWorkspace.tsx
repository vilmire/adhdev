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
import RemoteView from '../RemoteView'
import { useDashboardConversationCommands } from '../../hooks/useDashboardConversationCommands'
import { useIdeRemoteStream } from '../../hooks/useIdeRemoteStream'
import {
    getDashboardLayoutProfile,
    readDashboardDockviewStoredLayout,
    writeDashboardDockviewStoredLayout,
} from '../../utils/dashboardLayoutStorage'
import { buildLiveSessionInboxStateMap, getConversationInboxSurfaceState, type LiveSessionInboxState } from './DashboardMobileChatShared'
import { getPreferredConversationForIde } from './conversation-sort'
import { getCliConversationViewMode, isAcpConv } from './types'
import { useTransport } from '../../context/TransportContext'
import { useTheme } from '../../hooks/useTheme'
import { useTabShortcuts } from '../../hooks/useTabShortcuts'

interface DashboardDockviewWorkspaceProps {
    visibleConversations: ActiveConversation[]
    clearedTabs: Record<string, number>
    ides: DaemonData[]
    actionLogs: { ideId: string; text: string; timestamp: number }[]
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>
    setActionLogs: Dispatch<SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
    hasRegisteredMachines: boolean
    initialDataLoaded: boolean
    userName?: string
    detectedIdes?: { type: string; name: string; running: boolean; id?: string }[]
    handleLaunchIde?: (ideType: string) => void
    toggleHiddenTab: (tabKey: string) => void
    registerActionHandlers?: (handlers: {
        setShortcutForActiveTab: () => void
        activatePreviousTabInGroup: () => void
        activateNextTabInGroup: () => void
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
    } | null) => void
    onActiveTabChange: (tabKey: string | null) => void
    requestedActiveTabKey?: string | null
    requestedRemoteIdeId?: string | null
    onRequestedActiveTabConsumed?: () => void
    scrollToBottomRequest?: { tabKey: string; nonce: number } | null
}

interface DashboardDockviewContextValue {
    actionLogs: { ideId: string; text: string; timestamp: number }[]
    clearedTabs: Record<string, number>
    conversationsByTabKey: Map<string, ActiveConversation>
    detectedIdes?: { type: string; name: string; running: boolean; id?: string }[]
    handleLaunchIde?: (ideType: string) => void
    ides: DaemonData[]
    isStandalone: boolean
    hasRegisteredMachines: boolean
    liveSessionInboxState: Map<string, LiveSessionInboxState>
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setActionLogs: Dispatch<SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>
    toggleHiddenTab: (tabKey: string) => void
    userName?: string
    scrollToBottomRequest?: { tabKey: string; nonce: number } | null
    tabShortcuts: Record<string, string>
    openTabContextMenu: (args: { x: number; y: number; tabKey: string }) => void
}

interface DashboardDockviewPanelParams {
    kind: 'conversation'
    tabKey: string
}

interface DashboardDockviewRemotePanelParams {
    kind: 'remote'
    ideId: string
}

type DockviewPaneDirection = 'left' | 'right' | 'above' | 'below'

const DashboardDockviewContext = createContext<DashboardDockviewContextValue | null>(null)

function useDashboardDockviewContext() {
    const value = useContext(DashboardDockviewContext)
    if (!value) throw new Error('DashboardDockviewContext missing')
    return value
}

function getDockviewTitle(conversation: ActiveConversation) {
    return conversation.displayPrimary || conversation.title || conversation.agentName || conversation.tabKey
}

function getRemotePanelId(ideId: string) {
    return `remote:${ideId}`
}

function isRemotePanelId(panelId: string) {
    return panelId.startsWith('remote:')
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

function buildInitialDockviewLayout(
    api: DockviewApi,
    visibleConversations: ActiveConversation[],
    requestedActiveTabKey?: string | null,
) {
    const groups = [visibleConversations]
    let previousGroupAnchorId: string | undefined

    for (const group of groups) {
        let groupAnchorId: string | undefined
        for (const conversation of group) {
            const panel = api.addPanel<DashboardDockviewPanelParams>({
                id: conversation.tabKey,
                component: 'conversation',
                title: getDockviewTitle(conversation),
                params: { kind: 'conversation', tabKey: conversation.tabKey },
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
        ?? visibleConversations[0]?.tabKey
        ?? null
    if (!preferredActiveTabKey) return
    const preferredPanel = api.getPanel(preferredActiveTabKey)
    if (preferredPanel) preferredPanel.group.model.openPanel(preferredPanel)
}

function syncDockviewPanels(api: DockviewApi, visibleConversations: ActiveConversation[]) {
    const visibleKeys = new Set(visibleConversations.map(conversation => conversation.tabKey))

    for (const panel of [...api.panels]) {
        if (isRemotePanelId(panel.id)) continue
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
            params: { kind: 'conversation', tabKey: conversation.tabKey },
            ...(api.activePanel
                ? { position: { referencePanel: api.activePanel.id, direction: 'within' as const }, inactive: true }
                : api.panels[0]
                    ? { position: { referencePanel: api.panels[0].id, direction: 'within' as const }, inactive: true }
                    : {}),
        })
    }
}

function syncRemotePanels(
    api: DockviewApi,
    visibleConversations: ActiveConversation[],
    requestedRemoteIdeId?: string | null,
) {
    const desiredPanelId = requestedRemoteIdeId ? getRemotePanelId(requestedRemoteIdeId) : null

    for (const panel of [...api.panels]) {
        if (!isRemotePanelId(panel.id)) continue
        if (!desiredPanelId || panel.id !== desiredPanelId) {
            api.removePanel(panel)
        }
    }

    if (!requestedRemoteIdeId || !desiredPanelId) return

    const preferredConversation = getPreferredConversationForIde(visibleConversations, requestedRemoteIdeId)
    if (!preferredConversation && api.totalPanels === 0) return

    const existing = api.getPanel(desiredPanelId)
    const nextTitle = preferredConversation
        ? `Remote · ${preferredConversation.displayPrimary || preferredConversation.workspaceName || preferredConversation.agentName}`
        : 'Remote'

    if (existing) {
        if (existing.title !== nextTitle) {
            existing.api.setTitle(nextTitle)
        }
        return
    }

    const referencePanelId = preferredConversation?.tabKey
        ?? api.activePanel?.id
        ?? api.panels.find(panel => !isRemotePanelId(panel.id))?.id

    api.addPanel<DashboardDockviewRemotePanelParams>({
        id: desiredPanelId,
        component: 'remote',
        title: nextTitle,
        params: { kind: 'remote', ideId: requestedRemoteIdeId },
        ...(referencePanelId
            ? { position: { referencePanel: referencePanelId, direction: 'right' as const }, inactive: true }
            : {}),
    })
}

function DashboardDockviewPanel({ params, api }: IDockviewPanelProps<DashboardDockviewPanelParams>) {
    const ctx = useDashboardDockviewContext()
    const terminalRef = useRef<CliTerminalHandle>(null)
    const [isPanelActive, setIsPanelActive] = useState(api.isActive)
    const activeConv = ctx.conversationsByTabKey.get(params.tabKey)
    const cmds = useDashboardConversationCommands({
        sendDaemonCommand: ctx.sendDaemonCommand,
        activeConv,
        setLocalUserMessages: ctx.setLocalUserMessages,
        setActionLogs: ctx.setActionLogs,
        isStandalone: ctx.isStandalone,
    })

    useEffect(() => {
        setIsPanelActive(api.isActive)
        const disposables = [
            api.onDidActiveChange(event => setIsPanelActive(event.isActive)),
            api.onDidActiveGroupChange(event => {
                if (!api.isActive && !event.isActive) {
                    setIsPanelActive(false)
                    return
                }
                setIsPanelActive(api.isActive)
            }),
        ]
        return () => {
            for (const disposable of disposables) disposable.dispose()
        }
    }, [api])

    const activeIdeEntry = useMemo(
        () => activeConv ? ctx.ides.find(ide => ide.id === activeConv.ideId) : undefined,
        [ctx.ides, activeConv],
    )
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
                    hasRegisteredMachines={ctx.hasRegisteredMachines}
                    detectedIdes={ctx.detectedIdes}
                    handleLaunchIde={ctx.handleLaunchIde}
                />
            </div>
        )
    }

    const isCliTerminal = !isAcpConv(activeConv)
        && getCliConversationViewMode(activeConv) === 'terminal'

    return (
        <div className="h-full min-h-0 min-w-0 flex flex-col overflow-hidden">
            <PaneGroupContent
                activeConv={activeConv}
                clearToken={ctx.clearedTabs[activeConv.tabKey] || 0}
                isCliTerminal={isCliTerminal}
                ideEntry={activeIdeEntry}
                terminalRef={terminalRef}
                handleModalButton={cmds.handleModalButton}
                handleRelaunch={cmds.handleRelaunch}
                handleSendChat={cmds.handleSendChat}
                isSendingChat={cmds.isSendingChat}
                handleFocusAgent={cmds.handleFocusAgent}
                isFocusingAgent={cmds.isFocusingAgent}
                actionLogs={activeActionLogs}
                userName={ctx.userName}
                scrollToBottomRequestNonce={ctx.scrollToBottomRequest?.tabKey === activeConv.tabKey ? ctx.scrollToBottomRequest.nonce : undefined}
                isInputActive={isPanelActive}
            />
        </div>
    )
}

function DashboardDockviewRemotePanel({ params }: IDockviewPanelProps<DashboardDockviewRemotePanelParams>) {
    const ctx = useDashboardDockviewContext()
    const activeConv = useMemo(
        () => getPreferredConversationForIde([...ctx.conversationsByTabKey.values()], params.ideId),
        [ctx.conversationsByTabKey, params.ideId],
    )
    const ideEntry = useMemo(
        () => ctx.ides.find(ide => ide.id === params.ideId),
        [ctx.ides, params.ideId],
    )
    const daemonRouteId = activeConv?.daemonId || activeConv?.ideId?.split(':')[0] || params.ideId.split(':')[0] || params.ideId
    const { connScreenshot, screenshotUsage, handleRemoteAction } = useIdeRemoteStream({
        doId: daemonRouteId,
        ideId: params.ideId,
        ideType: activeConv?.ideType || ideEntry?.type,
        connState: activeConv?.connectionState || 'new',
        viewMode: 'remote',
        instanceId: ideEntry?.instanceId,
    })

    if (!activeConv) {
        return (
            <div className="h-full min-h-0 min-w-0 flex items-center justify-center text-sm text-text-muted">
                Remote view unavailable
            </div>
        )
    }

    return (
        <div className="h-full min-h-0 min-w-0 flex flex-col overflow-hidden bg-black">
            <RemoteView
                addLog={() => {}}
                connState={(activeConv.connectionState || 'new') as any}
                connScreenshot={connScreenshot}
                screenshotUsage={screenshotUsage}
                transportType={activeConv.transport}
                onAction={handleRemoteAction}
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
                hasRegisteredMachines={ctx.hasRegisteredMachines}
                detectedIdes={ctx.detectedIdes}
                handleLaunchIde={ctx.handleLaunchIde}
            />
        </div>
    )
}

function DashboardDockviewTab(props: IDockviewPanelHeaderProps<DashboardDockviewPanelParams | DashboardDockviewRemotePanelParams>) {
    useDockviewHeaderRenderTick(props)
    const ctx = useDashboardDockviewContext()
    const activatePanel = useCallback((event: React.MouseEvent | React.PointerEvent | React.TouchEvent) => {
        if ('button' in event && event.button !== 0) return
        props.api.setActive()
    }, [props.api])

    if (props.params.kind === 'remote') {
        const remoteConversation = getPreferredConversationForIde([...ctx.conversationsByTabKey.values()], props.params.ideId)
        const isActive = props.api.group.activePanel?.id === props.api.id
        const isGroupActive = props.api.isGroupActive
        return (
            <div
                className={`adhdev-dockview-tab${isActive ? ' is-active' : ''}${isGroupActive ? ' is-group-active' : ''}`}
                title={props.api.title || 'Remote'}
                data-tab-key={remoteConversation?.tabKey || ''}
                onMouseDown={activatePanel}
                onTouchStart={activatePanel}
            >
                <div className="adhdev-dockview-tab-status" aria-hidden="true">
                    <span className="adhdev-dockview-tab-status-text is-connected">◫</span>
                </div>
                <div className="adhdev-dockview-tab-copy">
                    <div className="adhdev-dockview-tab-primary">{props.api.title || 'Remote'}</div>
                    <div className="adhdev-dockview-tab-meta">
                        {remoteConversation?.machineName ? (
                            <>
                                <span>Live remote view</span>
                                <span className="adhdev-dockview-tab-dot">·</span>
                                <span className="adhdev-dockview-tab-machine">{remoteConversation.machineName}</span>
                            </>
                        ) : (
                            <span>Live remote view</span>
                        )}
                    </div>
                </div>
            </div>
        )
    }

    const conversation = ctx.conversationsByTabKey.get(props.params.tabKey)

    if (!conversation) {
        return (
            <div
                className="adhdev-dockview-tab adhdev-dockview-tab-empty"
                data-tab-key={props.params.tabKey || ''}
            >
                <div className="adhdev-dockview-tab-copy">
                    <div className="adhdev-dockview-tab-primary">{props.api.title || props.params.tabKey}</div>
                </div>
            </div>
        )
    }

    const isActive = props.api.group.activePanel?.id === props.api.id
    const isGroupActive = props.api.isGroupActive

    const surfaceState = getConversationInboxSurfaceState(conversation, ctx.liveSessionInboxState, {
        isOpenConversation: isActive,
    })
    
    const isReconnecting = surfaceState.isReconnecting
    const isConnecting = surfaceState.isConnecting
    const isGenerating = surfaceState.isGenerating
    const isWaiting = surfaceState.isWaiting
    const isTaskCompleteUnread = surfaceState.unread
    const shortcut = ctx.tabShortcuts[conversation.tabKey]

    return (
        <div
            className={`adhdev-dockview-tab${isActive ? ' is-active' : ''}${isGroupActive ? ' is-group-active' : ''}${isReconnecting ? ' is-reconnecting' : ''}`}
            title={conversation.displayPrimary}
            data-tab-key={props.params.tabKey}
            onMouseDown={activatePanel}
            onTouchStart={activatePanel}
            onContextMenu={(event) => {
                event.preventDefault()
                activatePanel(event)
                ctx.openTabContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    tabKey: conversation.tabKey,
                })
            }}
        >
            {isTaskCompleteUnread && <span className="adhdev-dockview-tab-unread-dot" aria-hidden="true" />}
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
            {shortcut && (
                <span className="text-[9px] opacity-50 font-mono ml-0.5 shrink-0 bg-bg-secondary px-1 rounded" title={shortcut}>
                    {shortcut}
                </span>
            )}
        </div>
    )
}

export default function DashboardDockviewWorkspace({
    visibleConversations,
    clearedTabs,
    ides,
    actionLogs,
    sendDaemonCommand,
    setLocalUserMessages,
    setActionLogs,
    isStandalone,
    hasRegisteredMachines,
    initialDataLoaded,
    userName,
    detectedIdes,
    handleLaunchIde,
    toggleHiddenTab,
    registerActionHandlers,
    onActiveTabChange,
    requestedActiveTabKey,
    requestedRemoteIdeId,
    onRequestedActiveTabConsumed,
    scrollToBottomRequest,
}: DashboardDockviewWorkspaceProps) {
    const { theme } = useTheme()
    const { sendCommand } = useTransport()
    const apiRef = useRef<DockviewApi | null>(null)
    const dockviewContainerRef = useRef<HTMLDivElement | null>(null)
    const hasInitializedRef = useRef(false)
    const awaitingInitialLayoutHydrationRef = useRef(false)
    const hasRestoredStoredActiveTabRef = useRef(false)
    const storedActiveTabIdRef = useRef<string | null>(null)
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabKey: string } | null>(null)
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
    const liveSessionInboxState = useMemo(
        () => buildLiveSessionInboxStateMap(ides),
        [ides],
    )
    const focusDockview = useCallback(() => {
        apiRef.current?.focus()
    }, [])
    const selectTabByShortcut = useCallback((tabKey: string) => {
        const api = apiRef.current
        if (!api) return
        const panel = api.getPanel(tabKey)
        if (!panel) return
        panel.group.model.openPanel(panel)
        panel.api.setActive()
    }, [])
    const activateRelativeTabInGroup = useCallback((direction: -1 | 1) => {
        const api = apiRef.current
        const activePanel = api?.activePanel
        const group = api?.activeGroup || activePanel?.group
        if (!api || !activePanel || !group) return
        const panels = group.panels || []
        if (panels.length <= 1) return
        const currentIndex = panels.findIndex(panel => panel.id === activePanel.id)
        if (currentIndex < 0) return
        const nextIndex = (currentIndex + direction + panels.length) % panels.length
        const nextPanel = panels[nextIndex]
        if (!nextPanel) return
        nextPanel.group.model.openPanel(nextPanel)
        nextPanel.api.setActive()
    }, [])
    const getAdjacentGroup = useCallback((direction: DockviewPaneDirection) => {
        const api = apiRef.current
        const activeGroup = api?.activeGroup || api?.activePanel?.group
        if (!api || !activeGroup) return
        const groups = api.groups || []
        const activeEntry = groups.find(group => group.id === activeGroup.id)
        if (!activeEntry) return

        const activeRect = activeEntry.element.getBoundingClientRect()
        const activeCenterX = activeRect.left + activeRect.width / 2
        const activeCenterY = activeRect.top + activeRect.height / 2

        const getOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
        const getDistanceScore = (candidate: typeof activeEntry) => {
            const rect = candidate.element.getBoundingClientRect()
            const centerX = rect.left + rect.width / 2
            const centerY = rect.top + rect.height / 2

            let primaryGap = 0
            let crossAxisDistance = 0
            let overlap = 0
            let isValidDirection = false

            if (direction === 'left') {
                isValidDirection = centerX < activeCenterX
                primaryGap = Math.max(0, activeRect.left - rect.right)
                crossAxisDistance = Math.abs(centerY - activeCenterY)
                overlap = getOverlap(activeRect.top, activeRect.bottom, rect.top, rect.bottom)
            } else if (direction === 'right') {
                isValidDirection = centerX > activeCenterX
                primaryGap = Math.max(0, rect.left - activeRect.right)
                crossAxisDistance = Math.abs(centerY - activeCenterY)
                overlap = getOverlap(activeRect.top, activeRect.bottom, rect.top, rect.bottom)
            } else if (direction === 'above') {
                isValidDirection = centerY < activeCenterY
                primaryGap = Math.max(0, activeRect.top - rect.bottom)
                crossAxisDistance = Math.abs(centerX - activeCenterX)
                overlap = getOverlap(activeRect.left, activeRect.right, rect.left, rect.right)
            } else {
                isValidDirection = centerY > activeCenterY
                primaryGap = Math.max(0, rect.top - activeRect.bottom)
                crossAxisDistance = Math.abs(centerX - activeCenterX)
                overlap = getOverlap(activeRect.left, activeRect.right, rect.left, rect.right)
            }

            if (!isValidDirection) return Number.POSITIVE_INFINITY

            const overlapPenalty = overlap > 0 ? 0 : 120
            return (primaryGap * 3) + crossAxisDistance + overlapPenalty
        }

        let bestGroup: typeof activeEntry | null = null
        let bestScore = Number.POSITIVE_INFINITY
        for (const group of groups) {
            if (group.id === activeEntry.id) continue
            const score = getDistanceScore(group)
            if (!Number.isFinite(score)) continue
            if (score >= bestScore) continue
            bestScore = score
            bestGroup = group
        }

        return bestGroup || undefined
    }, [])
    const focusAdjacentGroup = useCallback((direction: DockviewPaneDirection) => {
        const nextGroup = getAdjacentGroup(direction)
        if (!nextGroup) return
        const nextPanel = nextGroup.activePanel || nextGroup.panels[0]
        if (!nextPanel) return
        nextGroup.model.openPanel(nextPanel)
        nextPanel.api.setActive()
    }, [getAdjacentGroup])
    const moveActivePanelToDirection = useCallback((direction: DockviewPaneDirection, options?: { createGroupIfMissing?: boolean }) => {
        const api = apiRef.current
        const activePanel = api?.activePanel
        const activeGroup = api?.activeGroup || activePanel?.group
        if (!api || !activePanel || !activeGroup) return
        let targetGroup = getAdjacentGroup(direction)
        if (!targetGroup && options?.createGroupIfMissing) {
            targetGroup = api.addGroup({
                referenceGroup: activeGroup,
                direction,
            })
        }
        if (!targetGroup) return
        activePanel.api.moveTo({ group: targetGroup, position: 'center' })
        activePanel.group.model.openPanel(activePanel)
        activePanel.api.setActive()
    }, [getAdjacentGroup])
    const {
        isMac,
        tabShortcuts,
        shortcutListening,
        setShortcutListening,
        saveShortcuts,
    } = useTabShortcuts({
        sortedTabKeys: visibleConversations.map(conv => conv.tabKey),
        onFocus: focusDockview,
        onSelectTab: selectTabByShortcut,
    })
    const startShortcutListeningForActiveTab = useCallback(() => {
        const api = apiRef.current
        if (!api) return
        const activePanel = api.activePanel
        if (!activePanel) return
        if (isRemotePanelId(activePanel.id)) {
            const remoteIdeId = (activePanel.params as DashboardDockviewRemotePanelParams | undefined)?.ideId || activePanel.id.slice('remote:'.length)
            const relatedConversation = getPreferredConversationForIde(visibleConversations, remoteIdeId)
            if (relatedConversation?.tabKey) {
                setShortcutListening(relatedConversation.tabKey)
            }
            return
        }
        if (!conversationsByTabKey.has(activePanel.id)) return
        setShortcutListening(activePanel.id)
    }, [conversationsByTabKey, setShortcutListening, visibleConversations])

    useEffect(() => {
        registerActionHandlers?.({
            setShortcutForActiveTab: startShortcutListeningForActiveTab,
            activatePreviousTabInGroup: () => activateRelativeTabInGroup(-1),
            activateNextTabInGroup: () => activateRelativeTabInGroup(1),
            splitActiveTabRight: () => moveActivePanelToDirection('right', { createGroupIfMissing: true }),
            splitActiveTabDown: () => moveActivePanelToDirection('below', { createGroupIfMissing: true }),
            focusLeftPane: () => focusAdjacentGroup('left'),
            focusRightPane: () => focusAdjacentGroup('right'),
            focusUpPane: () => focusAdjacentGroup('above'),
            focusDownPane: () => focusAdjacentGroup('below'),
            moveActiveTabToLeftPane: () => moveActivePanelToDirection('left'),
            moveActiveTabToRightPane: () => moveActivePanelToDirection('right'),
            moveActiveTabToUpPane: () => moveActivePanelToDirection('above'),
            moveActiveTabToDownPane: () => moveActivePanelToDirection('below'),
        })
        return () => registerActionHandlers?.(null)
    }, [activateRelativeTabInGroup, focusAdjacentGroup, moveActivePanelToDirection, registerActionHandlers, startShortcutListeningForActiveTab])

    useEffect(() => {
        if (!ctxMenu) return
        const close = (event: MouseEvent) => {
            const menu = document.querySelector('[data-dockview-tab-context-menu]')
            if (menu && menu.contains(event.target as Node)) return
            setCtxMenu(null)
        }
        window.addEventListener('mousedown', close, true)
        return () => window.removeEventListener('mousedown', close, true)
    }, [ctxMenu])
    const contextValue = useMemo<DashboardDockviewContextValue>(() => ({
        actionLogs,
        clearedTabs,
        conversationsByTabKey,
        detectedIdes,
        handleLaunchIde,
        ides,
        isStandalone,
        hasRegisteredMachines,
        liveSessionInboxState,
        sendDaemonCommand,
        setActionLogs,
        setLocalUserMessages,
        toggleHiddenTab,
        userName,
        scrollToBottomRequest,
        tabShortcuts,
        openTabContextMenu: ({ x, y, tabKey }) => setCtxMenu({ x, y, tabKey }),
    }), [
        actionLogs,
        clearedTabs,
        conversationsByTabKey,
        detectedIdes,
        handleLaunchIde,
        ides,
        isStandalone,
        hasRegisteredMachines,
        liveSessionInboxState,
        sendDaemonCommand,
        setActionLogs,
        setLocalUserMessages,
        toggleHiddenTab,
        userName,
        scrollToBottomRequest,
        tabShortcuts,
    ])

    const activateRequestedTab = useCallback((tabKey: string | null | undefined) => {
        if (!tabKey) return false
        const api = apiRef.current
        if (!api) return false
        const panel = api.getPanel(tabKey)
        if (!panel) return false
        panel.group.model.openPanel(panel)
        panel.api.setActive()
        onRequestedActiveTabConsumed?.()
        return true
    }, [onRequestedActiveTabConsumed])

    const activateStoredActiveTab = useCallback(() => {
        if (hasRestoredStoredActiveTabRef.current) return false
        const activated = activateRequestedTab(storedActiveTabIdRef.current)
        if (activated) hasRestoredStoredActiveTabRef.current = true
        return activated
    }, [activateRequestedTab])

    const persistDockviewLayout = useCallback(() => {
        const api = apiRef.current
        if (!api) return
        writeDashboardDockviewStoredLayout(layoutProfile, {
            activeTabId: api.activePanel?.id ?? null,
            layout: api.toJSON(),
        })
    }, [layoutProfile])

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
        storedActiveTabIdRef.current = stored?.activeTabId ?? null
        if (stored?.layout) {
            event.api.fromJSON(stored.layout, { reuseExistingPanels: false })
        }

        awaitingInitialLayoutHydrationRef.current = !!stored?.layout && !initialDataLoaded && visibleConversations.length === 0

        if (!awaitingInitialLayoutHydrationRef.current) {
            syncDockviewPanels(event.api, visibleConversations)
            syncRemotePanels(event.api, visibleConversations, requestedRemoteIdeId)
        }

        if (event.api.totalPanels === 0 && visibleConversations.length > 0) {
            buildInitialDockviewLayout(event.api, visibleConversations, requestedActiveTabKey)
        } else if (!awaitingInitialLayoutHydrationRef.current && !activateRequestedTab(requestedActiveTabKey)) {
            activateStoredActiveTab()
        }

        hasInitializedRef.current = true

        event.api.onDidActivePanelChange(panel => {
            storedActiveTabIdRef.current = panel?.id ?? null
            hasRestoredStoredActiveTabRef.current = true
            if (panel && isRemotePanelId(panel.id)) {
                const remoteIdeId = (panel.params as DashboardDockviewRemotePanelParams | undefined)?.ideId || panel.id.slice('remote:'.length)
                const relatedConversation = getPreferredConversationForIde(visibleConversations, remoteIdeId)
                onActiveTabChange(relatedConversation?.tabKey ?? null)
                persistDockviewLayout()
                return
            }
            onActiveTabChange(panel?.id ?? null)
            persistDockviewLayout()
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
            persistDockviewLayout()
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
        initialDataLoaded,
        layoutProfile,
        markDockviewOverlaysHidden,
        removeDockviewOverlayNodes,
        onActiveTabChange,
        persistDockviewLayout,
        requestedActiveTabKey,
        requestedRemoteIdeId,
        sendCommand,
        visibleConversations,
    ])

    useEffect(() => {
        const api = apiRef.current
        if (!api || !hasInitializedRef.current) return

        if (awaitingInitialLayoutHydrationRef.current && !initialDataLoaded) return
        if (awaitingInitialLayoutHydrationRef.current) {
            awaitingInitialLayoutHydrationRef.current = false
        }

        syncDockviewPanels(api, visibleConversations)
        syncRemotePanels(api, visibleConversations, requestedRemoteIdeId)

        if (requestedActiveTabKey && activateRequestedTab(requestedActiveTabKey)) {
            return
        }

        if (!api.activePanel && api.panels[0]) {
            api.panels[0].group.model.openPanel(api.panels[0])
            api.panels[0].api.setActive()
        }

        const activePanelStillExists = !!(api.activePanel && api.getPanel(api.activePanel.id))
        if (!activePanelStillExists) {
            activateStoredActiveTab()
        }
    }, [activateRequestedTab, activateStoredActiveTab, initialDataLoaded, requestedActiveTabKey, requestedRemoteIdeId, visibleConversations])

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

    useEffect(() => {
        const handleDragStart = (e: DragEvent) => {
            const target = e.target as HTMLElement
            if (!target) return
            const tabNode = target.querySelector('[data-tab-key]') || target.closest('[data-tab-key]')
            if (tabNode) {
                const tabKey = tabNode.getAttribute('data-tab-key')
                if (tabKey && e.dataTransfer) {
                    e.dataTransfer.setData('text/tab-key', tabKey)
                }
            }
        }
        window.addEventListener('dragstart', handleDragStart)
        return () => window.removeEventListener('dragstart', handleDragStart)
    }, [])

    const dockviewTheme = theme === 'light' ? themeLight : themeDark

    return (
        <DashboardDockviewContext.Provider value={contextValue}>
            <div ref={dockviewContainerRef} className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <DockviewReact
                    className={`h-full min-h-0 min-w-0 adhdev-dockview${isDraggingDockview ? ' is-dragging-dockview' : ''}${isShowingDockviewOverlay ? ' is-showing-dockview-overlay' : ''}`}
                    components={{ conversation: DashboardDockviewPanel, remote: DashboardDockviewRemotePanel }}
                    defaultTabComponent={DashboardDockviewTab}
                    watermarkComponent={DashboardDockviewWatermark}
                    onReady={handleReady}
                    singleTabMode="default"
                    tabAnimation="smooth"
                    theme={dockviewTheme}
                />
            </div>
            {ctxMenu && (
                <div
                    data-dockview-tab-context-menu
                    className="fixed z-50 bg-bg-primary border border-border-subtle rounded-lg shadow-lg py-1 min-w-[160px]"
                    style={{ left: ctxMenu.x, top: ctxMenu.y }}
                >
                    <button
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors"
                        onClick={(event) => {
                            event.stopPropagation()
                            setShortcutListening(ctxMenu.tabKey)
                            setCtxMenu(null)
                        }}
                    >
                        ⌨ {tabShortcuts[ctxMenu.tabKey] ? `Change shortcut (${tabShortcuts[ctxMenu.tabKey]})` : 'Set shortcut'}
                    </button>
                    {tabShortcuts[ctxMenu.tabKey] && (
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors text-text-muted"
                            onClick={() => {
                                const next = { ...tabShortcuts }
                                delete next[ctxMenu.tabKey]
                                saveShortcuts(next)
                                setCtxMenu(null)
                            }}
                        >
                            ✕ Remove shortcut
                        </button>
                    )}
                </div>
            )}
            {shortcutListening && (
                <div
                    className="fixed inset-0 z-[60] flex items-center justify-center"
                    style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
                    onClick={() => setShortcutListening(null)}
                >
                    <div
                        className="bg-bg-primary border border-border-subtle rounded-xl px-8 py-6 text-center shadow-xl"
                        onClick={event => event.stopPropagation()}
                    >
                        <div className="text-sm font-bold text-text-primary mb-2">⌨ Set shortcut</div>
                        <div className="text-xs text-text-secondary mb-4">
                            Press a key combo (e.g. {isMac ? '⌘+1' : 'Ctrl+1'}, {isMac ? '⌥+A' : 'Alt+A'})
                        </div>
                        <div className="text-lg font-mono text-accent animate-pulse">Listening...</div>
                        <div className="text-[10px] text-text-muted mt-3">Press Esc to cancel</div>
                    </div>
                </div>
            )}
        </DashboardDockviewContext.Provider>
    )
}
