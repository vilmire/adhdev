import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from 'react'
import { createPortal } from 'react-dom'
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
    readDashboardDockviewHiddenRestoreState,
    readDashboardDockviewStoredLayout,
    writeDashboardDockviewHiddenRestoreState,
    writeDashboardDockviewStoredLayout,
    type DashboardStoredHiddenTabLocation,
} from '../../utils/dashboardLayoutStorage'
import { buildLiveSessionInboxStateMap, getConversationInboxSurfaceState, type LiveSessionInboxState } from './DashboardMobileChatShared'
import { getPreferredConversationForIde } from './conversation-sort'
import { getCliConversationViewMode, isAcpConv } from './types'
import { useTransport } from '../../context/TransportContext'
import { useTheme } from '../../hooks/useTheme'
import { useTabShortcuts, readTabShortcuts } from '../../hooks/useTabShortcuts'
import { isEditableTarget, normalizeKey, readActionShortcuts, type DashboardActionShortcutId } from '../../hooks/useActionShortcuts'
import { getConversationTabMetaText, getConversationTitle, getRemotePanelTitle } from './conversation-presenters'
import { getConversationNativeTargetSessionId } from './conversation-selectors'
import { IconExternalWindow, IconArrowBack, IconKeyboard, IconX, IconEyeOff, IconFloat, IconDock } from '../Icons'

interface DashboardDockviewWorkspaceProps {
    visibleConversations: ActiveConversation[]
    clearedTabs: Record<string, number>
    ides: DaemonData[]
    actionLogs: { routeId: string; text: string; timestamp: number }[]
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>
    setActionLogs: Dispatch<SetStateAction<{ routeId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
    hasRegisteredMachines: boolean
    initialDataLoaded: boolean
    userName?: string
    detectedIdes?: { type: string; name: string; running: boolean; id?: string }[]
    handleLaunchIde?: (ideType: string) => void
    toggleHiddenTab: (tabKey: string) => void
    registerActionHandlers?: (handlers: {
        setShortcutForActiveTab: () => void
        restoreHiddenTabToSavedLocation: (tabKey: string) => void
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
    } | null) => void
    onActiveTabChange: (tabKey: string | null) => void
    requestedActiveTabKey?: string | null
    requestedRemoteIdeId?: string | null
    onRequestedActiveTabConsumed?: () => void
    scrollToBottomRequest?: { tabKey: string; nonce: number } | null
}

interface DashboardDockviewContextValue {
    actionLogs: { routeId: string; text: string; timestamp: number }[]
    clearedTabs: Record<string, number>
    conversationsByTabKey: Map<string, ActiveConversation>
    detectedIdes?: { type: string; name: string; running: boolean; id?: string }[]
    handleLaunchIde?: (ideType: string) => void
    ides: DaemonData[]
    isStandalone: boolean
    hasRegisteredMachines: boolean
    liveSessionInboxState: Map<string, LiveSessionInboxState>
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setActionLogs: Dispatch<SetStateAction<{ routeId: string; text: string; timestamp: number }[]>>
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>
    toggleHiddenTab: (tabKey: string) => void
    userName?: string
    scrollToBottomRequest?: { tabKey: string; nonce: number } | null
    tabShortcuts: Record<string, string>
    openTabContextMenu: (args: { x: number; y: number; tabKey: string; sourceDocument?: Document }) => void
    popoutTab: (tabKey: string) => void
    moveTabBackToMain: (tabKey: string) => void
    isTabInPopout: (tabKey: string) => boolean
    floatTab: (tabKey: string) => void
    isTabFloating: (tabKey: string) => boolean
}

interface DashboardDockviewPanelParams {
    kind: 'conversation'
    tabKey: string
}

interface DashboardDockviewRemotePanelParams {
    kind: 'remote'
    routeId: string
}

type DockviewPaneDirection = 'left' | 'right' | 'above' | 'below'

const DashboardDockviewContext = createContext<DashboardDockviewContextValue | null>(null)

function useDashboardDockviewContext() {
    const value = useContext(DashboardDockviewContext)
    if (!value) throw new Error('DashboardDockviewContext missing')
    return value
}

function getDockviewTitle(conversation: ActiveConversation) {
    return getConversationTitle(conversation) || conversation.tabKey
}

function getRemotePanelId(routeId: string) {
    return `remote:${routeId}`
}

function isRemotePanelId(panelId: string) {
    return panelId.startsWith('remote:')
}

function escapeHtml(value: string) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function focusOwnerWindow(ownerDoc: Document | null | undefined) {
    const ownerWindow = ownerDoc?.defaultView
    if (!ownerWindow) return
    try {
        ownerWindow.focus()
        ownerDoc?.body?.focus?.()
        ownerDoc?.documentElement?.focus?.()
        ownerWindow.requestAnimationFrame?.(() => {
            try {
                ownerWindow.focus()
                ownerDoc?.body?.focus?.()
            } catch {
                // noop
            }
        })
    } catch {
        // noop
    }
}

function applyDockviewThemeClass(target: HTMLElement, theme: 'light' | 'dark') {
    target.classList.remove(themeLight.className, themeDark.className)
    target.classList.add(theme === 'light' ? themeLight.className : themeDark.className)
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
    const nextTitle = getRemotePanelTitle(preferredConversation)

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
        params: { kind: 'remote', routeId: requestedRemoteIdeId },
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
        () => activeConv ? ctx.ides.find(ide => ide.id === activeConv.routeId) : undefined,
        [ctx.ides, activeConv],
    )
    const activeActionLogs = useMemo(() => {
        if (!activeConv) return []
        return ctx.actionLogs.filter(log => log.routeId === activeConv.tabKey)
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
        () => getPreferredConversationForIde([...ctx.conversationsByTabKey.values()], params.routeId),
        [ctx.conversationsByTabKey, params.routeId],
    )
    const ideEntry = useMemo(
        () => ctx.ides.find(ide => ide.id === params.routeId),
        [ctx.ides, params.routeId],
    )
    const daemonRouteId = activeConv?.daemonId || activeConv?.routeId?.split(':')[0] || params.routeId.split(':')[0] || params.routeId
    const { connScreenshot, screenshotUsage, handleRemoteAction } = useIdeRemoteStream({
        doId: daemonRouteId,
        targetSessionId: activeConv ? getConversationNativeTargetSessionId(activeConv) : (ideEntry?.sessionId || ideEntry?.instanceId),
        connState: activeConv?.connectionState || 'new',
        viewMode: 'remote',
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
                connState={(activeConv.connectionState || 'new') as 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed'}
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
        const remoteConversation = getPreferredConversationForIde([...ctx.conversationsByTabKey.values()], props.params.routeId)
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
            title={getConversationTitle(conversation)}
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
                    sourceDocument: (event.target as HTMLElement)?.ownerDocument ?? document,
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
                <div className="adhdev-dockview-tab-primary">{getConversationTitle(conversation)}</div>
                <div className="adhdev-dockview-tab-meta">
                    {isReconnecting ? (
                        <span className="adhdev-dockview-tab-reconnecting">{getConversationTabMetaText(conversation)}</span>
                    ) : isConnecting ? (
                        <span className="adhdev-dockview-tab-connecting">{getConversationTabMetaText(conversation)}</span>
                    ) : (
                        <span>{getConversationTabMetaText(conversation)}</span>
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
    const previousVisibleTabKeysRef = useRef<string[]>([])
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabKey: string; sourceDocument: Document } | null>(null)
    const [isDraggingDockview, setIsDraggingDockview] = useState(false)
    const [isShowingDockviewOverlay, setIsShowingDockviewOverlay] = useState(false)
    const [popoutWindowRevision, setPopoutWindowRevision] = useState(0)
    const overlayCleanupTimeoutRef = useRef<number | null>(null)
    const layoutProfile = useMemo(
        () => getDashboardLayoutProfile(typeof window !== 'undefined' ? window.innerWidth : 1280),
        [],
    )
    const hiddenRestoreStateRef = useRef<Record<string, DashboardStoredHiddenTabLocation>>(
        typeof window === 'undefined' ? {} : readDashboardDockviewHiddenRestoreState(layoutProfile),
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

    // ─── Popout Window (tear-off to separate browser window) ─────

    const injectThemeIntoPopoutWindow = useCallback((popoutWindow: Window) => {
        const parentDoc = document
        const popoutDoc = popoutWindow.document

        for (const link of parentDoc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
            const clone = popoutDoc.createElement('link')
            clone.rel = 'stylesheet'
            clone.href = link.href
            if (link.crossOrigin) clone.crossOrigin = link.crossOrigin
            popoutDoc.head.appendChild(clone)
        }

        for (const style of parentDoc.querySelectorAll<HTMLStyleElement>('style')) {
            const clone = popoutDoc.createElement('style')
            clone.textContent = style.textContent
            popoutDoc.head.appendChild(clone)
        }

        const cssVars: string[] = []
        for (const sheet of parentDoc.styleSheets) {
            try {
                for (const rule of sheet.cssRules) {
                    if (rule instanceof CSSStyleRule && (rule.selectorText === ':root' || rule.selectorText === 'html')) {
                        cssVars.push(rule.cssText)
                    }
                }
            } catch { /* cross-origin sheet, skip */ }
        }
        if (cssVars.length > 0) {
            const varStyle = popoutDoc.createElement('style')
            varStyle.textContent = cssVars.join('\n')
            popoutDoc.head.appendChild(varStyle)
        }

        const htmlTheme = parentDoc.documentElement.getAttribute('data-theme')
        if (htmlTheme) popoutDoc.documentElement.setAttribute('data-theme', htmlTheme)
        popoutDoc.documentElement.style.colorScheme = htmlTheme === 'light' ? 'light' : 'dark'
        popoutDoc.body.className = parentDoc.body.className

        const inlineRootStyle = parentDoc.documentElement.getAttribute('style')
        if (inlineRootStyle) popoutDoc.documentElement.setAttribute('style', inlineRootStyle)

        const mount = popoutDoc.getElementById('dv-popout-window')
        if (mount instanceof HTMLElement) {
            mount.classList.add('adhdev-dockview')
            applyDockviewThemeClass(mount, theme)
        }
    }, [theme])

    const syncThemeToOpenPopouts = useCallback(() => {
        const api = apiRef.current
        if (!api) return
        for (const group of api.groups) {
            try {
                const ownerDoc = group.element?.ownerDocument
                if (!ownerDoc || ownerDoc === document) continue
                const mount = ownerDoc.getElementById('dv-popout-window')
                if (mount instanceof HTMLElement) {
                    mount.classList.add('adhdev-dockview')
                    applyDockviewThemeClass(mount, theme)
                }
                const htmlTheme = document.documentElement.getAttribute('data-theme')
                if (htmlTheme) ownerDoc.documentElement.setAttribute('data-theme', htmlTheme)
                ownerDoc.documentElement.style.colorScheme = htmlTheme === 'light' ? 'light' : 'dark'
                ownerDoc.body.className = document.body.className
                const inlineRootStyle = document.documentElement.getAttribute('style')
                if (inlineRootStyle) ownerDoc.documentElement.setAttribute('style', inlineRootStyle)
                else ownerDoc.documentElement.removeAttribute('style')
            } catch {
                // ignore detached popout docs
            }
        }
    }, [theme])

    const syncPopoutContainerClasses = useCallback(() => {
        const api = apiRef.current
        if (!api) return
        for (const group of api.groups) {
            try {
                const ownerDoc = group.element?.ownerDocument
                if (!ownerDoc || ownerDoc === document) continue
                const mount = ownerDoc.getElementById('dv-popout-window')
                if (!(mount instanceof HTMLElement)) continue
                mount.classList.add('adhdev-dockview')
                applyDockviewThemeClass(mount, theme)
                mount.classList.toggle('is-showing-dockview-overlay', isShowingDockviewOverlay)
                mount.classList.toggle('is-dragging-dockview', isDraggingDockview)
            } catch {
                // ignore detached popout docs
            }
        }
    }, [isDraggingDockview, isShowingDockviewOverlay, theme])

    const popoutTab = useCallback((tabKey: string) => {
        const api = apiRef.current
        if (!api) return
        const panel = api.getPanel(tabKey)
        if (!panel) return

        void api.addPopoutGroup(panel, {
            popoutUrl: '/popout.html',
            onDidOpen: ({ window: popoutWin }) => {
                injectThemeIntoPopoutWindow(popoutWin)
                syncPopoutChrome()
                const conv = conversationsByTabKey.get(tabKey)
                popoutWin.document.title = conv
                    ? `${getConversationTitle(conv)} — ADHDev`
                    : 'ADHDev — Popout'
            },
        })
    }, [conversationsByTabKey, injectThemeIntoPopoutWindow])

    const moveTabBackToMain = useCallback((tabKey: string) => {
        const api = apiRef.current
        const panel = api?.getPanel(tabKey)
        if (!api || !panel) return

        const mainGroups = api.groups.filter(g => {
            try { return g.element?.ownerDocument === document } catch { return true }
        })
        if (mainGroups.length > 0) {
            panel.api.moveTo({ group: mainGroups[0], position: 'center' })
        } else {
            panel.api.moveTo({ position: 'center' })
        }
        panel.api.setActive()
    }, [])

    const isTabInPopout = useCallback((tabKey: string) => {
        const api = apiRef.current
        if (!api) return false
        const panel = api.getPanel(tabKey)
        if (!panel) return false
        try {
            return panel.group.element?.ownerDocument !== document
        } catch {
            return false
        }
    }, [])

    const hideConversationTab = useCallback((tabKey: string) => {
        if (isTabInPopout(tabKey)) {
            moveTabBackToMain(tabKey)
        }
        toggleHiddenTab(tabKey)
    }, [isTabInPopout, moveTabBackToMain, toggleHiddenTab])

    const floatTab = useCallback((tabKey: string) => {
        const api = apiRef.current
        const panel = api?.getPanel(tabKey)
        if (!api || !panel) return
        api.addFloatingGroup(panel, {
            width: 600,
            height: 500,
        })
    }, [])

    const isTabFloating = useCallback((tabKey: string) => {
        const panel = apiRef.current?.getPanel(tabKey)
        if (!panel) return false
        try {
            return panel.group.model.location.type === 'floating'
        } catch {
            return false
        }
    }, [])

    const getActiveConversationTabKey = useCallback(() => {
        const activePanelId = apiRef.current?.activePanel?.id
        if (!activePanelId || isRemotePanelId(activePanelId)) return null
        return conversationsByTabKey.has(activePanelId) ? activePanelId : null
    }, [conversationsByTabKey])

    const dockTabToWorkspaceGrid = useCallback((tabKey: string) => {
        const api = apiRef.current
        const panel = api?.getPanel(tabKey)
        if (!api || !panel) return
        const gridGroups = api.groups.filter(group => {
            try {
                return group.model.location.type === 'grid'
            } catch {
                return true
            }
        })
        if (gridGroups.length > 0) {
            panel.api.moveTo({ group: gridGroups[0], position: 'center' })
        } else {
            panel.api.moveTo({ position: 'center' })
        }
        panel.api.setActive()
    }, [])

    const syncPopoutChrome = useCallback(() => {
        const api = apiRef.current
        if (!api) return

        for (const group of api.groups) {
            const ownerDoc = group.element?.ownerDocument
            if (!ownerDoc || ownerDoc === document) continue

            const mount = ownerDoc.getElementById('dv-popout-window')
            if (!(mount instanceof HTMLElement)) continue

            let activePanelId: string | null = null
            let title = ownerDoc.title || 'ADHDev'
            let meta = 'Popout workspace'

            const activePanel = group.activePanel
            if (activePanel) {
                activePanelId = activePanel.id
                if (isRemotePanelId(activePanel.id)) {
                    const routeId = (activePanel.params as DashboardDockviewRemotePanelParams | undefined)?.routeId || activePanel.id.slice('remote:'.length)
                    const conversation = getPreferredConversationForIde([...conversationsByTabKey.values()], routeId)
                    title = getRemotePanelTitle(conversation)
                    meta = conversation?.machineName ? `Remote view · ${conversation.machineName}` : 'Remote view'
                } else {
                    const conversation = conversationsByTabKey.get(activePanel.id)
                    title = conversation ? getConversationTitle(conversation) : (activePanel.title || activePanel.id)
                    meta = conversation ? getConversationTabMetaText(conversation) : 'Dockview panel'
                }
            }

            ownerDoc.title = `${title} — ADHDev`

            let header = ownerDoc.getElementById('adhdev-popout-header')
            if (!(header instanceof HTMLElement)) {
                header = ownerDoc.createElement('div')
                header.id = 'adhdev-popout-header'
                ownerDoc.body.appendChild(header)
            }

            header.setAttribute('style', [
                'position:absolute',
                'top:0',
                'left:0',
                'right:0',
                'height:52px',
                'display:flex',
                'align-items:center',
                'justify-content:space-between',
                'gap:12px',
                'padding:0 14px',
                'box-sizing:border-box',
                'background:var(--surface-secondary)',
                'border-bottom:1px solid var(--border-subtle)',
                'z-index:5',
                'backdrop-filter:blur(14px)',
            ].join(';'))

            header.innerHTML = `
                <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
                    <div style="font-size:10px;line-height:1;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;">ADHDev</div>
                    <div style="min-width:0;font-size:13px;font-weight:700;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(title)}</div>
                    <div style="min-width:0;font-size:10px;line-height:1.1;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(meta)}</div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex:0 0 auto;">
                    <button type="button" data-adhdev-popout-focus style="height:30px;padding:0 10px;border-radius:9px;background:var(--bg-glass);color:var(--text-secondary);font-size:11px;font-weight:600;">Dashboard</button>
                    <button type="button" data-adhdev-popout-dock style="height:30px;padding:0 10px;border-radius:9px;background:var(--surface-primary);color:var(--text-primary);font-size:11px;font-weight:700;">Dock</button>
                </div>
            `

            mount.style.top = '52px'
            mount.style.height = 'calc(100% - 52px)'

            const focusBtn = header.querySelector<HTMLButtonElement>('[data-adhdev-popout-focus]')
            if (focusBtn) {
                focusBtn.onclick = () => {
                    window.focus()
                }
            }

            const dockBtn = header.querySelector<HTMLButtonElement>('[data-adhdev-popout-dock]')
            if (dockBtn) {
                dockBtn.disabled = !activePanelId
                dockBtn.style.opacity = activePanelId ? '1' : '0.5'
                dockBtn.style.cursor = activePanelId ? 'pointer' : 'default'
                dockBtn.onclick = () => {
                    if (activePanelId) moveTabBackToMain(activePanelId)
                    ownerDoc.defaultView?.focus()
                }
            }
        }
    }, [conversationsByTabKey, moveTabBackToMain])
    const selectTabByShortcut = useCallback((tabKey: string) => {
        const api = apiRef.current
        const panel = api?.getPanel(tabKey)
        if (!api || !panel) return
        panel.group.model.openPanel(panel)
        panel.api.setActive()
        try {
            const location = panel.group.model.location
            if (location.type === 'popout') {
                location.getWindow().focus()
            } else {
                focusOwnerWindow(panel.group.element?.ownerDocument)
            }
        } catch { /* ignore */ }
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
        focusOwnerWindow(nextGroup.element?.ownerDocument)
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
            const remoteIdeId = (activePanel.params as DashboardDockviewRemotePanelParams | undefined)?.routeId || activePanel.id.slice('remote:'.length)
            const relatedConversation = getPreferredConversationForIde(visibleConversations, remoteIdeId)
            if (relatedConversation?.tabKey) {
                setShortcutListening(relatedConversation.tabKey)
            }
            return
        }
        if (!conversationsByTabKey.has(activePanel.id)) return
        setShortcutListening(activePanel.id)
    }, [conversationsByTabKey, selectTabByShortcut, setShortcutListening, visibleConversations])

    const encodeShortcut = useCallback((event: KeyboardEvent): string | null => {
        const parts: string[] = []
        if (event.metaKey) parts.push(isMac ? '⌘' : 'Meta')
        if (event.ctrlKey) parts.push('Ctrl')
        if (event.altKey) parts.push(isMac ? '⌥' : 'Alt')
        if (event.shiftKey && event.key.length !== 1) parts.push(isMac ? '⇧' : 'Shift')
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return null
        parts.push(normalizeKey(event.key))
        return parts.join('+')
    }, [isMac])

    const triggerPopoutActionShortcut = useCallback((actionId: DashboardActionShortcutId) => {
        switch (actionId) {
            case 'splitActiveTabRight':
                moveActivePanelToDirection('right', { createGroupIfMissing: true })
                return
            case 'splitActiveTabDown':
                moveActivePanelToDirection('below', { createGroupIfMissing: true })
                return
            case 'floatActiveTab': {
                const tabKey = getActiveConversationTabKey()
                if (tabKey) floatTab(tabKey)
                return
            }
            case 'popoutActiveTab': {
                const tabKey = getActiveConversationTabKey()
                if (tabKey) popoutTab(tabKey)
                return
            }
            case 'dockActiveTab': {
                const tabKey = getActiveConversationTabKey()
                if (!tabKey) return
                if (isTabInPopout(tabKey)) {
                    moveTabBackToMain(tabKey)
                } else if (isTabFloating(tabKey)) {
                    dockTabToWorkspaceGrid(tabKey)
                }
                return
            }
            case 'focusLeftPane':
                focusAdjacentGroup('left')
                return
            case 'focusRightPane':
                focusAdjacentGroup('right')
                return
            case 'focusUpPane':
                focusAdjacentGroup('above')
                return
            case 'focusDownPane':
                focusAdjacentGroup('below')
                return
            case 'moveActiveTabToLeftPane':
                moveActivePanelToDirection('left')
                return
            case 'moveActiveTabToRightPane':
                moveActivePanelToDirection('right')
                return
            case 'moveActiveTabToUpPane':
                moveActivePanelToDirection('above')
                return
            case 'moveActiveTabToDownPane':
                moveActivePanelToDirection('below')
                return
            case 'selectPreviousGroupTab':
                activateRelativeTabInGroup(-1)
                return
            case 'selectNextGroupTab':
                activateRelativeTabInGroup(1)
                return
            case 'setActiveTabShortcut':
                startShortcutListeningForActiveTab()
                return
            case 'hideCurrentTab': {
                const panelId = apiRef.current?.activePanel?.id
                if (panelId && !isRemotePanelId(panelId)) {
                    hideConversationTab(panelId)
                }
                return
            }
            default:
                return
        }
    }, [
        activateRelativeTabInGroup,
        dockTabToWorkspaceGrid,
        focusAdjacentGroup,
        floatTab,
        getActiveConversationTabKey,
        hideConversationTab,
        isTabFloating,
        isTabInPopout,
        moveTabBackToMain,
        moveActivePanelToDirection,
        popoutTab,
        startShortcutListeningForActiveTab,
    ])

    useEffect(() => {
        if (!ctxMenu) return
        const targetDoc = ctxMenu.sourceDocument
        const targetWin = targetDoc.defaultView ?? window
        const close = (event: MouseEvent) => {
            const menu = targetDoc.querySelector('[data-dockview-tab-context-menu]')
            if (menu && menu.contains(event.target as Node)) return
            setCtxMenu(null)
        }
        targetWin.addEventListener('mousedown', close, true)
        // Also close if main window is clicked when menu is in popout
        if (targetWin !== window) {
            window.addEventListener('mousedown', () => setCtxMenu(null), true)
        }
        return () => {
            targetWin.removeEventListener('mousedown', close, true)
            if (targetWin !== window) {
                window.removeEventListener('mousedown', () => setCtxMenu(null), true)
            }
        }
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
        toggleHiddenTab: hideConversationTab,
        userName,
        scrollToBottomRequest,
        tabShortcuts,
        openTabContextMenu: ({ x, y, tabKey, sourceDocument: srcDoc }) => setCtxMenu({ x, y, tabKey, sourceDocument: srcDoc ?? document }),
        popoutTab,
        moveTabBackToMain,
        isTabInPopout,
        floatTab,
        isTabFloating,
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
        hideConversationTab,
        userName,
        scrollToBottomRequest,
        tabShortcuts,
        popoutTab,
        moveTabBackToMain,
        isTabInPopout,
        floatTab,
        isTabFloating,
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

    const persistHiddenRestoreState = useCallback(() => {
        writeDashboardDockviewHiddenRestoreState(layoutProfile, hiddenRestoreStateRef.current)
    }, [layoutProfile])

    const readHiddenRestoreStateFromLayout = useCallback((tabKey: string): DashboardStoredHiddenTabLocation => {
        const api = apiRef.current
        if (!api) return { kind: 'grid' }

        const serialized = api.toJSON() as {
            floatingGroups?: Array<{
                data?: { views?: string[] }
                position?: {
                    left?: number
                    right?: number
                    top?: number
                    bottom?: number
                    width: number
                    height: number
                }
            }>
            popoutGroups?: Array<{
                data?: { views?: string[] }
                position?: { left: number, top: number, width: number, height: number }
                url?: string
            }>
        }

        for (const group of serialized.floatingGroups || []) {
            if (group.data?.views?.includes(tabKey) && group.position) {
                return { kind: 'floating', position: group.position }
            }
        }

        for (const group of serialized.popoutGroups || []) {
            if (group.data?.views?.includes(tabKey)) {
                return {
                    kind: 'popout',
                    position: group.position,
                    popoutUrl: group.url,
                }
            }
        }

        return { kind: 'grid' }
    }, [])

    const restoreHiddenTabToSavedLocation = useCallback((tabKey: string) => {
        const api = apiRef.current
        if (!api) return
        const panel = api.getPanel(tabKey)
        const savedLocation = hiddenRestoreStateRef.current[tabKey]
        if (!panel || !savedLocation || savedLocation.kind === 'grid') return

        const currentLocation = panel.group.model.location.type
        if (currentLocation === savedLocation.kind) {
            delete hiddenRestoreStateRef.current[tabKey]
            persistHiddenRestoreState()
            return
        }

        if (savedLocation.kind === 'floating') {
            api.addFloatingGroup(panel, {
                x: savedLocation.position.left ?? 24,
                y: savedLocation.position.top ?? 24,
                width: savedLocation.position.width,
                height: savedLocation.position.height,
            })
            delete hiddenRestoreStateRef.current[tabKey]
            persistHiddenRestoreState()
            return
        }
        // Popout restoration is intentionally not automatic.
        // Browser popup restrictions make hidden-tab restore unreliable, so
        // popout tabs come back docked in the main grid.
        delete hiddenRestoreStateRef.current[tabKey]
        persistHiddenRestoreState()
    }, [persistHiddenRestoreState])

    useEffect(() => {
        registerActionHandlers?.({
            setShortcutForActiveTab: startShortcutListeningForActiveTab,
            restoreHiddenTabToSavedLocation,
            activatePreviousTabInGroup: () => activateRelativeTabInGroup(-1),
            activateNextTabInGroup: () => activateRelativeTabInGroup(1),
            floatActiveTab: () => {
                const tabKey = getActiveConversationTabKey()
                if (tabKey) floatTab(tabKey)
            },
            popoutActiveTab: () => {
                const tabKey = getActiveConversationTabKey()
                if (tabKey) popoutTab(tabKey)
            },
            dockActiveTab: () => {
                const tabKey = getActiveConversationTabKey()
                if (!tabKey) return
                if (isTabInPopout(tabKey)) {
                    moveTabBackToMain(tabKey)
                } else if (isTabFloating(tabKey)) {
                    dockTabToWorkspaceGrid(tabKey)
                }
            },
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
    }, [
        activateRelativeTabInGroup,
        dockTabToWorkspaceGrid,
        floatTab,
        focusAdjacentGroup,
        getActiveConversationTabKey,
        isTabFloating,
        isTabInPopout,
        moveActivePanelToDirection,
        moveTabBackToMain,
        popoutTab,
        registerActionHandlers,
        restoreHiddenTabToSavedLocation,
        startShortcutListeningForActiveTab,
    ])

    const markDockviewOverlaysHidden = useCallback(() => {
        const root = dockviewContainerRef.current
        if (!root) return
        const nodes = root.querySelectorAll<HTMLElement>(
            '.dv-drop-target-container, .dv-drop-target-anchor, .dv-drop-target-dropzone, .dv-drop-target-selection',
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
            syncPopoutChrome()
            if (panel && isRemotePanelId(panel.id)) {
                const remoteIdeId = (panel.params as DashboardDockviewRemotePanelParams | undefined)?.routeId || panel.id.slice('remote:'.length)
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
                sendCommand(conversation.routeId, 'focus_session', {
                    agentType: conversation.agentType,
                    ...(conversation.sessionId && { targetSessionId: conversation.sessionId }),
                }).catch(() => {})
            }
        })

        event.api.onDidLayoutChange(() => {
            persistDockviewLayout()
            syncPopoutChrome()
            setPopoutWindowRevision(value => value + 1)
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

        // Inject theme attributes into popout windows created by drag-to-popout.
        // Note: dockview already copies stylesheets (addStyles), but data-theme
        // attribute and inline :root style overrides need manual propagation.
        event.api.onDidAddGroup((group) => {
            // Defer check so the group has time to be placed in a popout window
            requestAnimationFrame(() => {
                try {
                    const ownerDoc = group.element?.ownerDocument
                    if (!ownerDoc || ownerDoc === document) return
                    ownerDoc.getElementById('dv-popout-window')?.classList.add('adhdev-dockview')
                    // This group is in a popout window — inject theme attributes
                    const htmlTheme = document.documentElement.getAttribute('data-theme')
                    if (htmlTheme) ownerDoc.documentElement.setAttribute('data-theme', htmlTheme)
                    ownerDoc.body.className = document.body.className
                    const inlineRootStyle = document.documentElement.getAttribute('style')
                    if (inlineRootStyle) ownerDoc.documentElement.setAttribute('style', inlineRootStyle)
                } catch { /* ignore */ }
                syncPopoutChrome()
                setPopoutWindowRevision(value => value + 1)
            })
        })

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
        syncPopoutChrome,
        visibleConversations,
    ])

    useLayoutEffect(() => {
        const api = apiRef.current
        if (!api || !hasInitializedRef.current) return

        if (awaitingInitialLayoutHydrationRef.current && !initialDataLoaded) return
        if (awaitingInitialLayoutHydrationRef.current) {
            awaitingInitialLayoutHydrationRef.current = false
        }

        const previousVisibleTabKeys = previousVisibleTabKeysRef.current
        const previousVisibleTabKeySet = new Set(previousVisibleTabKeys)
        const nextVisibleTabKeys = visibleConversations.map(conversation => conversation.tabKey)
        const nextVisibleTabKeySet = new Set(nextVisibleTabKeys)

        let hiddenStateChanged = false
        for (const tabKey of previousVisibleTabKeys) {
            if (nextVisibleTabKeySet.has(tabKey)) continue
            hiddenRestoreStateRef.current[tabKey] = readHiddenRestoreStateFromLayout(tabKey)
            hiddenStateChanged = true
        }
        if (hiddenStateChanged) {
            persistHiddenRestoreState()
        }

        syncDockviewPanels(api, visibleConversations)
        syncRemotePanels(api, visibleConversations, requestedRemoteIdeId)

        const restoredTabKeys = nextVisibleTabKeys.filter(tabKey => !previousVisibleTabKeySet.has(tabKey))
        let restoredStateConsumed = false
        for (const tabKey of restoredTabKeys) {
            const panel = api.getPanel(tabKey)
            const savedLocation = hiddenRestoreStateRef.current[tabKey]
            if (!panel || !savedLocation || savedLocation.kind === 'grid') continue

            const currentLocation = panel.group.model.location.type
            if (currentLocation === savedLocation.kind) {
                delete hiddenRestoreStateRef.current[tabKey]
                restoredStateConsumed = true
                continue
            }

            if (savedLocation.kind === 'floating') {
                api.addFloatingGroup(panel, {
                    x: savedLocation.position.left ?? 24,
                    y: savedLocation.position.top ?? 24,
                    width: savedLocation.position.width,
                    height: savedLocation.position.height,
                })
                delete hiddenRestoreStateRef.current[tabKey]
                restoredStateConsumed = true
                continue
            }
        }

        if (restoredStateConsumed) {
            persistHiddenRestoreState()
        }

        previousVisibleTabKeysRef.current = nextVisibleTabKeys

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
    }, [activateRequestedTab, activateStoredActiveTab, initialDataLoaded, persistHiddenRestoreState, readHiddenRestoreStateFromLayout, requestedActiveTabKey, requestedRemoteIdeId, visibleConversations])

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
                    const dragPreview =
                        target.closest('.dv-tab') ||
                        tabNode.closest('.dv-tab') ||
                        (tabNode as HTMLElement)
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/tab-key', tabKey)
                    if (dragPreview instanceof HTMLElement) {
                        e.dataTransfer.setDragImage(
                            dragPreview,
                            Math.max(12, Math.round(dragPreview.clientWidth / 2)),
                            Math.max(10, Math.round(dragPreview.clientHeight / 2)),
                        )
                    }
                }
            }
        }
        window.addEventListener('dragstart', handleDragStart)
        const api = apiRef.current
        const popoutWindows = api
            ? Array.from(
                new Set(
                    api.groups
                        .map(group => group.element?.ownerDocument?.defaultView)
                        .filter(popup => popup && popup !== window),
                ),
            )
            : []

        for (const popup of popoutWindows) {
            popup.addEventListener('dragstart', handleDragStart)
        }

        return () => {
            window.removeEventListener('dragstart', handleDragStart)
            for (const popup of popoutWindows) {
                popup.removeEventListener('dragstart', handleDragStart)
            }
        }
    }, [popoutWindowRevision])

    useEffect(() => {
        const root = dockviewContainerRef.current?.querySelector('.adhdev-dockview')
        if (root instanceof HTMLElement) {
            applyDockviewThemeClass(root, theme)
        }
        syncThemeToOpenPopouts()
        syncPopoutChrome()
        syncPopoutContainerClasses()
    }, [syncPopoutChrome, syncPopoutContainerClasses, syncThemeToOpenPopouts, theme])

    useEffect(() => {
        syncPopoutChrome()
        syncPopoutContainerClasses()
    }, [syncPopoutChrome, syncPopoutContainerClasses])

    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if (event.defaultPrevented || shortcutListening) return
            const combo = encodeShortcut(event)
            if (!combo) return
            const hasModifier = event.metaKey || event.ctrlKey || event.altKey
            if (isEditableTarget(event.target) && !hasModifier) return

            const actionShortcuts = readActionShortcuts(isMac)
            if (actionShortcuts.setActiveTabShortcut !== combo) return

            event.preventDefault()
            event.stopPropagation()
            startShortcutListeningForActiveTab()
        }

        window.addEventListener('keydown', handler, true)
        return () => window.removeEventListener('keydown', handler, true)
    }, [encodeShortcut, isMac, shortcutListening, startShortcutListeningForActiveTab])

    useEffect(() => {
        const api = apiRef.current
        if (!api) return

        const popoutWindows = Array.from(
            new Set(
                api.groups
                    .map(group => group.element?.ownerDocument?.defaultView)
                    .filter(popup => popup && popup !== window),
            ),
        )
        if (popoutWindows.length === 0) return

        const cleanups = popoutWindows.map(popup => {
            let sequenceParts: string[] = []
            let sequenceTimer: number | null = null

            const resetSequence = () => {
                if (sequenceTimer != null) popup.clearTimeout(sequenceTimer)
                sequenceTimer = null
                sequenceParts = []
            }

            const armSequenceTimeout = () => {
                if (sequenceTimer != null) popup.clearTimeout(sequenceTimer)
                sequenceTimer = popup.setTimeout(() => {
                    sequenceTimer = null
                    sequenceParts = []
                }, 1200)
            }

            const handleTabShortcut = (event: KeyboardEvent) => {
                if (!event.ctrlKey && !event.metaKey && !event.altKey) return
                const combo = encodeShortcut(event)
                if (!combo) return

                const tabShortcuts = readTabShortcuts()
                for (const [tabKey, shortcut] of Object.entries(tabShortcuts)) {
                    if (!visibleConversations.some(conversation => conversation.tabKey === tabKey)) continue
                    if (shortcut !== combo) continue
                    event.preventDefault()
                    selectTabByShortcut(tabKey)
                    return
                }
            }

            const handleActionShortcut = (event: KeyboardEvent) => {
                if (event.defaultPrevented || shortcutListening) return

                const combo = encodeShortcut(event)
                if (!combo) return

                const hasModifier = event.metaKey || event.ctrlKey || event.altKey
                if (isEditableTarget(event.target) && !hasModifier) return

                const actionShortcuts = readActionShortcuts(isMac)
                const supportedEntries = (Object.entries(actionShortcuts) as [DashboardActionShortcutId, string][])
                    .filter(([actionId, shortcut]) => !!shortcut && (
                        actionId === 'splitActiveTabRight'
                        || actionId === 'splitActiveTabDown'
                        || actionId === 'floatActiveTab'
                        || actionId === 'popoutActiveTab'
                        || actionId === 'dockActiveTab'
                        || actionId === 'focusLeftPane'
                        || actionId === 'focusRightPane'
                        || actionId === 'focusUpPane'
                        || actionId === 'focusDownPane'
                        || actionId === 'moveActiveTabToLeftPane'
                        || actionId === 'moveActiveTabToRightPane'
                        || actionId === 'moveActiveTabToUpPane'
                        || actionId === 'moveActiveTabToDownPane'
                        || actionId === 'selectPreviousGroupTab'
                        || actionId === 'selectNextGroupTab'
                        || actionId === 'setActiveTabShortcut'
                        || actionId === 'hideCurrentTab'
                    ))

                const nextParts = hasModifier
                    ? [combo]
                    : [...sequenceParts.slice(-1), combo].slice(-2)
                const fullCandidate = nextParts.join(' ')
                const singleCandidate = nextParts[nextParts.length - 1]

                const exactFullMatch = supportedEntries.find(([, shortcut]) => shortcut === fullCandidate)
                if (exactFullMatch) {
                    event.preventDefault()
                    resetSequence()
                    triggerPopoutActionShortcut(exactFullMatch[0])
                    return
                }

                const fullPrefixMatch = supportedEntries.some(([, shortcut]) => shortcut.startsWith(`${fullCandidate} `))
                if (fullPrefixMatch) {
                    event.preventDefault()
                    sequenceParts = nextParts
                    armSequenceTimeout()
                    return
                }

                const exactSingleMatch = supportedEntries.find(([, shortcut]) => shortcut === singleCandidate)
                if (exactSingleMatch) {
                    event.preventDefault()
                    resetSequence()
                    triggerPopoutActionShortcut(exactSingleMatch[0])
                    return
                }

                const singlePrefixMatch = supportedEntries.some(([, shortcut]) => shortcut.startsWith(`${singleCandidate} `))
                if (singlePrefixMatch) {
                    event.preventDefault()
                    sequenceParts = [singleCandidate]
                    armSequenceTimeout()
                    return
                }

                resetSequence()
            }

            popup.addEventListener('keydown', handleTabShortcut)
            popup.addEventListener('keydown', handleActionShortcut)

            return () => {
                resetSequence()
                popup.removeEventListener('keydown', handleTabShortcut)
                popup.removeEventListener('keydown', handleActionShortcut)
            }
        })

        return () => {
            for (const cleanup of cleanups) cleanup()
        }
    }, [
        encodeShortcut,
        isMac,
        popoutWindowRevision,
        selectTabByShortcut,
        shortcutListening,
        triggerPopoutActionShortcut,
        visibleConversations,
    ])

    const dockviewTheme = theme === 'light' ? themeLight : themeDark
    const shortcutOverlayDocument = apiRef.current?.activePanel?.group.element?.ownerDocument ?? document

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
                    popoutUrl="/popout.html"
                />
            </div>
            {ctxMenu && createPortal(
                <div
                    data-dockview-tab-context-menu
                    className="fixed z-50 bg-bg-primary border border-border-subtle rounded-lg shadow-lg py-1 min-w-[180px]"
                    style={{ left: ctxMenu.x, top: ctxMenu.y }}
                >
                    {isTabInPopout(ctxMenu.tabKey) ? (
                        <>
                            {isTabFloating(ctxMenu.tabKey) && (
                                <button
                                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors flex items-center gap-2"
                                    onClick={() => {
                                        dockTabToWorkspaceGrid(ctxMenu.tabKey)
                                        setCtxMenu(null)
                                    }}
                                >
                                    <IconDock size={13} className="shrink-0 opacity-70" /> Dock in window
                                </button>
                            )}
                            <button
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors flex items-center gap-2"
                                onClick={() => {
                                    moveTabBackToMain(ctxMenu.tabKey)
                                    setCtxMenu(null)
                                }}
                            >
                                <IconArrowBack size={13} className="shrink-0 opacity-70" /> Move back to main window
                            </button>
                        </>
                    ) : isTabFloating(ctxMenu.tabKey) ? (
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors flex items-center gap-2"
                            onClick={() => {
                                dockTabToWorkspaceGrid(ctxMenu.tabKey)
                                setCtxMenu(null)
                            }}
                        >
                            <IconDock size={13} className="shrink-0 opacity-70" /> Dock back to grid
                        </button>
                    ) : (
                        <>
                            <button
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors flex items-center gap-2"
                                onClick={() => {
                                    floatTab(ctxMenu.tabKey)
                                    setCtxMenu(null)
                                }}
                            >
                                <IconFloat size={13} className="shrink-0 opacity-70" /> Float as panel
                            </button>
                            <button
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors flex items-center gap-2"
                                onClick={() => {
                                    popoutTab(ctxMenu.tabKey)
                                    setCtxMenu(null)
                                }}
                            >
                                <IconExternalWindow size={13} className="shrink-0 opacity-70" /> Open in new window
                            </button>
                        </>
                    )}
                    <div className="border-t border-border-subtle my-1" />
                    <button
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors flex items-center gap-2"
                        onClick={(event) => {
                            event.stopPropagation()
                            setShortcutListening(ctxMenu.tabKey)
                            setCtxMenu(null)
                        }}
                    >
                        <IconKeyboard size={13} className="shrink-0 opacity-70" /> {tabShortcuts[ctxMenu.tabKey] ? `Change shortcut (${tabShortcuts[ctxMenu.tabKey]})` : 'Set shortcut'}
                    </button>
                    {tabShortcuts[ctxMenu.tabKey] && (
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors text-text-muted flex items-center gap-2"
                            onClick={() => {
                                const next = { ...tabShortcuts }
                                delete next[ctxMenu.tabKey]
                                saveShortcuts(next)
                                setCtxMenu(null)
                            }}
                        >
                            <IconX size={13} className="shrink-0 opacity-70" /> Remove shortcut
                        </button>
                    )}
                    <div className="border-t border-border-subtle my-1" />
                    <button
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors text-text-muted flex items-center gap-2"
                        onClick={() => {
                            hideConversationTab(ctxMenu.tabKey)
                            setCtxMenu(null)
                        }}
                    >
                        <IconEyeOff size={13} className="shrink-0 opacity-70" /> Hide tab
                    </button>
                </div>,
                ctxMenu.sourceDocument.body,
            )}
            {shortcutListening && (
                createPortal(
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
                    </div>,
                    shortcutOverlayDocument.body,
                )
            )}
        </DashboardDockviewContext.Provider>
    )
}
