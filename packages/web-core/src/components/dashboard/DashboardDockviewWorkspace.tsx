import { useTranslation } from 'react-i18next'
import {
    useCallback,
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
    type IDockviewPanelProps,
} from 'dockview'
import type { ActiveConversation } from './types'
import type { DaemonData } from '../../types'
import type { CliTerminalHandle } from '../CliTerminal'
import PaneGroupContent from './PaneGroupContent'
import PaneGroupEmptyState from './PaneGroupEmptyState'
import { areConversationsLoaded } from './dashboard-mobile-chat-mode-helpers'
import { useDashboardConversationCommands } from '../../hooks/useDashboardConversationCommands'
import {
    readDashboardDockviewHiddenRestoreState,
    readDashboardDockviewStoredLayout,
    writeDashboardDockviewHiddenRestoreState,
    writeDashboardDockviewStoredLayout,
    type DashboardLayoutProfile,
    type DashboardStoredHiddenTabLocation,
} from '../../utils/dashboardLayoutStorage'
import type { LiveSessionInboxState } from './DashboardMobileChatShared'
import { getPreferredConversationForIde } from './conversation-sort'
import { getCliConversationViewMode, isAcpConv } from './types'
import { useTransport } from '../../context/TransportContext'
import { useTheme } from '../../hooks/useTheme'
import { useTabShortcuts } from '../../hooks/useTabShortcuts';
import { isEditableTarget, normalizeKey, readActionShortcuts, type DashboardActionShortcutId } from '../../hooks/useActionShortcuts'
import { getConversationTitle } from './conversation-presenters';
import { buildDashboardDockviewContextMenuItems } from './dockviewContextMenuItems'
import { shouldAwaitStoredDockviewHydration, shouldDeferDockviewPanelPrune } from './dashboardDockviewHydration'
import { getPassiveSessionSelectionCommand } from './dashboardSessionCommands'
import type { DashboardScrollToBottomIntent } from './dashboard-scroll-to-bottom'
import { attachDockviewIdleDragFloat, isDockviewIdleDragFloatEnabled } from './dockviewIdleDragFloat'
import {
    applyDockviewThemeClass,
    focusOwnerWindow,
    getDistinctPopoutWindows,
    isRemotePanelId,
    findAdjacentDockviewGroup,
    type DockviewPaneDirection,
} from './dockviewWorkspaceHelpers';
import {
    buildInitialDockviewLayout,
    syncDockviewPanels,
    readHiddenTabLocationFromLayout,
    syncRemotePanels,
    type DashboardDockviewPanelParams,
    type DashboardDockviewRemotePanelParams,
} from './dockviewWorkspaceLayout'
import {
    DashboardDockviewContext,
    DashboardDockviewRemotePanel,
    DashboardDockviewTab,
    DashboardDockviewWatermark,
    useDashboardDockviewContext,
    type DashboardDockviewContextValue,
} from './dockviewWorkspaceContext'
import { attachPopoutShortcutKeys } from './dockviewPopoutShortcuts'
import DockviewTabContextMenu from './DockviewTabContextMenu'
import { injectDockviewThemeIntoPopout, renderDockviewPopoutChrome, syncDockviewThemeToPopouts } from './dockviewPopoutWindows'

/**
 * Stable empty array for the no-active-conversation case. A fresh `[]` literal
 * is a new reference on every render, which would defeat the very memo the
 * `activeActionLogs` useMemo below exists to preserve.
 */
const EMPTY_ACTION_LOGS: { routeId: string; text: string; timestamp: number }[] = []

interface DashboardDockviewWorkspaceProps {
    visibleConversations: ActiveConversation[]
    clearedTabs: Record<string, number>
    ides: DaemonData[]
    actionLogs: { routeId: string; text: string; timestamp: number }[]
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setActionLogs: Dispatch<SetStateAction<{ routeId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
    hasRegisteredMachines: boolean
    initialDataLoaded: boolean
    userName?: string
    toggleHiddenTab: (tabKey: string) => void
    actionShortcuts: Partial<Record<DashboardActionShortcutId, string>>
    registerActionHandlers?: (handlers: {
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
    } | null) => void
    onActiveTabChange: (tabKey: string | null) => void
    onOpenNewSession?: () => void
    onRequestScrollToBottom?: (tabKey: string | null | undefined, intent: DashboardScrollToBottomIntent) => void
    requestedActiveTabKey?: string | null
    requestedRemoteIdeId?: string | null
    onRequestedActiveTabConsumed?: () => void
    scrollToBottomRequest?: { tabKey: string; nonce: number } | null
    liveSessionInboxState: Map<string, LiveSessionInboxState>
    layoutProfile: DashboardLayoutProfile
}

type DashboardDockviewPanelActivityApi = Pick<IDockviewPanelProps<DashboardDockviewPanelParams>['api'], 'isActive' | 'isVisible'>


export function getDockviewPanelInputActive(api: Pick<DashboardDockviewPanelActivityApi, 'isActive'>): boolean {
    return api.isActive
}

export function getDockviewPanelContentVisible(api: Pick<DashboardDockviewPanelActivityApi, 'isVisible'>): boolean {
    return api.isVisible
}

export function DashboardDockviewPanel({ params, api }: IDockviewPanelProps<DashboardDockviewPanelParams>) {
    const ctx = useDashboardDockviewContext()
    const terminalRef = useRef<CliTerminalHandle>(null)
    const [isPanelInputActive, setIsPanelInputActive] = useState(() => getDockviewPanelInputActive(api))
    const [isPanelVisible, setIsPanelVisible] = useState(() => getDockviewPanelContentVisible(api))
    const activeConv = ctx.conversationsByTabKey.get(params.tabKey)
    const cmds = useDashboardConversationCommands({
        sendDaemonCommand: ctx.sendDaemonCommand,
        activeConv,
        setActionLogs: ctx.setActionLogs,
        isStandalone: ctx.isStandalone,
    })

    useEffect(() => {
        setIsPanelInputActive(getDockviewPanelInputActive(api))
        setIsPanelVisible(getDockviewPanelContentVisible(api))
        const disposables = [
            api.onDidActiveChange(event => setIsPanelInputActive(event.isActive)),
            api.onDidActiveGroupChange(event => {
                if (!getDockviewPanelInputActive(api) && !event.isActive) {
                    setIsPanelInputActive(false)
                    return
                }
                setIsPanelInputActive(getDockviewPanelInputActive(api))
            }),
            api.onDidVisibilityChange(event => setIsPanelVisible(event.isVisible)),
        ]
        return () => {
            for (const disposable of disposables) disposable.dispose()
        }
    }, [api])

    const activeIdeEntry = useMemo(
        () => activeConv ? ctx.ides.find(ide => ide.id === activeConv.routeId) : undefined,
        [ctx.ides, activeConv],
    )
    // Depend on `activeConv?.tabKey` — the ONLY field this filter reads — not on
    // the `activeConv` object. The conversation object is rebuilt on every status
    // tick, so keying on it recomputed the filter and produced a fresh array each
    // tick, invalidating `PaneGroupContent`'s memo (via the `actionLogs` prop) on
    // ticks where neither the logs nor the active tab actually changed.
    const activeConvTabKey = activeConv?.tabKey
    const activeActionLogs = useMemo(() => {
        if (!activeConvTabKey) return EMPTY_ACTION_LOGS
        return ctx.actionLogs.filter(log => log.routeId === activeConvTabKey)
    }, [ctx.actionLogs, activeConvTabKey])

    if (!activeConv) {
        return (
            <div className="h-full min-h-0 min-w-0 flex flex-col">
                <PaneGroupEmptyState
                    conversationsCount={0}
                    isSplitMode={false}
                    isStandalone={ctx.isStandalone}
                    hasRegisteredMachines={ctx.hasRegisteredMachines}
                    onOpenNewSession={ctx.onOpenNewSession}
                    suppressGuide={ctx.hasDetachedConversationPanels}
                    isLoading={!areConversationsLoaded(ctx.ides, ctx.initialDataLoaded)}
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
                commands={cmds}
                actionLogs={activeActionLogs}
                userName={ctx.userName}
                scrollToBottomRequestNonce={ctx.scrollToBottomRequest?.tabKey === activeConv.tabKey ? ctx.scrollToBottomRequest.nonce : undefined}
                isInputActive={isPanelInputActive}
                isVisible={isPanelVisible}
            />
        </div>
    )
}

export default function DashboardDockviewWorkspace({
    visibleConversations,
    clearedTabs,
    ides,
    actionLogs,
    sendDaemonCommand,
    setActionLogs,
    isStandalone,
    hasRegisteredMachines,
    initialDataLoaded,
    userName,
    toggleHiddenTab,
    actionShortcuts,
    registerActionHandlers,
    onActiveTabChange,
    onOpenNewSession,
    onRequestScrollToBottom,
    requestedActiveTabKey,
    requestedRemoteIdeId,
    onRequestedActiveTabConsumed,
    scrollToBottomRequest,
    liveSessionInboxState,
    layoutProfile,
}: DashboardDockviewWorkspaceProps) {
    const { t } = useTranslation('common')
    const { theme } = useTheme()
    const { sendCommand } = useTransport()
    const apiRef = useRef<DockviewApi | null>(null)
    const dockviewContainerRef = useRef<HTMLDivElement | null>(null)
    const idleDragFloatCleanupRef = useRef<(() => void) | null>(null)
    const hasInitializedRef = useRef(false)
    const awaitingInitialLayoutHydrationRef = useRef(false)
    const hasRestoredStoredActiveTabRef = useRef(false)
    const storedActiveTabIdRef = useRef<string | null>(null)
    const previousVisibleTabKeysRef = useRef<string[]>([])
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabKey: string; sourceDocument: Document } | null>(null)
    const [popoutWindowRevision, setPopoutWindowRevision] = useState(0)
    const hiddenRestoreStateRef = useRef<Record<string, DashboardStoredHiddenTabLocation>>(
        typeof window === 'undefined' ? {} : readDashboardDockviewHiddenRestoreState(layoutProfile),
    )
    const conversationsByTabKey = useMemo(
        () => new Map(visibleConversations.map(conversation => [conversation.tabKey, conversation])),
        [visibleConversations],
    )
    const hasDetachedConversationPanels = useMemo(() => {
        const api = apiRef.current
        if (!api) return false
        return api.groups.some(group => {
            try {
                const locationType = group.model.location.type
                if (locationType !== 'floating' && locationType !== 'popout') return false
                return group.panels.some(panel => conversationsByTabKey.has(panel.id))
            } catch {
                return false
            }
        })
    }, [conversationsByTabKey, popoutWindowRevision, visibleConversations])
    const focusDockview = useCallback(() => {
        apiRef.current?.focus()
    }, [])
    const requestConversationScrollToBottom = useCallback((tabKey: string | null | undefined, intent: DashboardScrollToBottomIntent) => {
        onRequestScrollToBottom?.(tabKey, intent)
    }, [onRequestScrollToBottom])

    // ─── Popout Window (tear-off to separate browser window) ─────

    const injectThemeIntoPopoutWindow = useCallback((popoutWindow: Window) => {
        injectDockviewThemeIntoPopout(popoutWindow, theme)
    }, [theme])

    const syncThemeToOpenPopouts = useCallback(() => {
        const api = apiRef.current
        if (api) syncDockviewThemeToPopouts(api, theme)
    }, [theme])

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

    const resetAllPanelsToMain = useCallback(() => {
        const api = apiRef.current
        if (!api) return

        const mainGridGroups = api.groups.filter(group => {
            try {
                return group.element?.ownerDocument === document && group.model.location.type === 'grid'
            } catch {
                return false
            }
        })

        const fallbackGroup = mainGridGroups[0] || null
        const panels = [...api.panels]

        for (const panel of panels) {
            const ownerDoc = panel.group.element?.ownerDocument
            const locationType = panel.group.model.location.type
            if (ownerDoc === document && locationType === 'grid') continue

            if (fallbackGroup && fallbackGroup.id !== panel.group.id) {
                panel.api.moveTo({ group: fallbackGroup, position: 'center' })
            } else {
                panel.api.moveTo({ position: 'center' })
            }
        }

        const activePanel = api.activePanel
        if (activePanel) {
            activePanel.group.model.openPanel(activePanel)
            activePanel.api.setActive()
        }
        focusOwnerWindow(document)
    }, [])

    const syncPopoutChrome = useCallback(() => {
        const api = apiRef.current
        if (api) renderDockviewPopoutChrome(api, conversationsByTabKey, moveTabBackToMain)
    }, [conversationsByTabKey, moveTabBackToMain])
    const selectTabByShortcut = useCallback((tabKey: string) => {
        const api = apiRef.current
        const panel = api?.getPanel(tabKey)
        if (!api || !panel) return
        panel.group.model.openPanel(panel)
        panel.api.setActive()
        requestConversationScrollToBottom(tabKey, 'dockview-shortcut')
        try {
            const location = panel.group.model.location
            if (location.type === 'popout') {
                location.getWindow().focus()
            } else {
                focusOwnerWindow(panel.group.element?.ownerDocument)
            }
        } catch { /* ignore */ }
    }, [requestConversationScrollToBottom])
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
        if (!isRemotePanelId(nextPanel.id)) {
            requestConversationScrollToBottom(nextPanel.id, 'dockview-shortcut')
        }
    }, [requestConversationScrollToBottom])
    const getAdjacentGroup = useCallback((direction: DockviewPaneDirection) => {
        const api = apiRef.current
        return api ? findAdjacentDockviewGroup(api, direction) : undefined
    }, [])
    const focusAdjacentGroup = useCallback((direction: DockviewPaneDirection) => {
        const nextGroup = getAdjacentGroup(direction)
        if (!nextGroup) return
        const nextPanel = nextGroup.activePanel || nextGroup.panels[0]
        if (!nextPanel) return
        nextGroup.model.openPanel(nextPanel)
        nextPanel.api.setActive()
        if (!isRemotePanelId(nextPanel.id)) {
            requestConversationScrollToBottom(nextPanel.id, 'dockview-focus')
        }
        focusOwnerWindow(nextGroup.element?.ownerDocument)
    }, [getAdjacentGroup, requestConversationScrollToBottom])
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
        if (!isRemotePanelId(activePanel.id)) {
            requestConversationScrollToBottom(
                activePanel.id,
                options?.createGroupIfMissing ? 'dockview-split' : 'dockview-move',
            )
        }
    }, [getAdjacentGroup, requestConversationScrollToBottom])
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
        hasDetachedConversationPanels,
        ides,
        isStandalone,
        hasRegisteredMachines,
        initialDataLoaded,
        onOpenNewSession,
        liveSessionInboxState,
            sendDaemonCommand,
        setActionLogs,
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
        hasDetachedConversationPanels,
        ides,
        isStandalone,
        hasRegisteredMachines,
        initialDataLoaded,
        onOpenNewSession,
        liveSessionInboxState,
            sendDaemonCommand,
        setActionLogs,
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

    const ctxMenuItems = ctxMenu ? buildDashboardDockviewContextMenuItems({
        isTabInPopout: isTabInPopout(ctxMenu.tabKey),
        isTabFloating: isTabFloating(ctxMenu.tabKey),
        tabShortcut: tabShortcuts[ctxMenu.tabKey],
        actionShortcuts,
    }) : []

    const activatePanel = useCallback((panel: { id: string; group: { model: { openPanel: (panel: any) => void } }; api: { setActive: () => void } }) => {
        const api = apiRef.current
        const activePanelId = api?.activePanel?.id ?? null
        if (activePanelId === panel.id) {
            panel.group.model.openPanel(panel)
            return
        }
        panel.group.model.openPanel(panel)
        panel.api.setActive()
    }, [])

    const activateRequestedTab = useCallback((
        tabKey: string | null | undefined,
        intent: DashboardScrollToBottomIntent = 'requested-tab',
    ) => {
        if (!tabKey) return false
        const api = apiRef.current
        if (!api) return false
        const panel = api.getPanel(tabKey)
        if (!panel) return false
        activatePanel(panel)
        requestConversationScrollToBottom(tabKey, intent)
        onRequestedActiveTabConsumed?.()
        return true
    }, [activatePanel, onRequestedActiveTabConsumed, requestConversationScrollToBottom])

    const activateStoredActiveTab = useCallback(() => {
        if (hasRestoredStoredActiveTabRef.current) return false
        const activated = activateRequestedTab(storedActiveTabIdRef.current, 'stored-layout-restore')
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
        return api ? readHiddenTabLocationFromLayout(api, tabKey) : { kind: 'grid' }
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
            activateConversationTab: selectTabByShortcut,
            resetAllPanelsToMain,
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
        resetAllPanelsToMain,
        restoreHiddenTabToSavedLocation,
        selectTabByShortcut,
        startShortcutListeningForActiveTab,
    ])

    useEffect(() => {
        return () => {
            idleDragFloatCleanupRef.current?.()
            idleDragFloatCleanupRef.current = null
        }
    }, [])

    const handleReady = useCallback((event: DockviewReadyEvent) => {
        apiRef.current = event.api
        idleDragFloatCleanupRef.current?.()
        idleDragFloatCleanupRef.current = null

        const stored = readDashboardDockviewStoredLayout(layoutProfile)
        storedActiveTabIdRef.current = stored?.activeTabId ?? null
        if (stored?.layout) {
            event.api.fromJSON(stored.layout, { reuseExistingPanels: false })
        }

        awaitingInitialLayoutHydrationRef.current = shouldAwaitStoredDockviewHydration({
            hasStoredLayout: !!stored?.layout,
            initialDataLoaded,
            visibleConversationCount: visibleConversations.length,
            ides,
        })

        if (!awaitingInitialLayoutHydrationRef.current) {
            syncDockviewPanels(event.api, visibleConversations)
            syncRemotePanels(event.api, visibleConversations, requestedRemoteIdeId)
        }

        if (event.api.totalPanels === 0 && visibleConversations.length > 0) {
            const preferredActiveTabKey = buildInitialDockviewLayout(event.api, visibleConversations, requestedActiveTabKey)
            if (preferredActiveTabKey) {
                const preferredPanel = event.api.getPanel(preferredActiveTabKey)
                if (preferredPanel) {
                    activatePanel(preferredPanel)
                }
            }
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
                sendCommand(conversation.routeId, getPassiveSessionSelectionCommand(), {
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

        if (isDockviewIdleDragFloatEnabled()) {
            idleDragFloatCleanupRef.current = attachDockviewIdleDragFloat(
                event.api,
                () => dockviewContainerRef.current,
                () => {
                    persistDockviewLayout()
                    syncPopoutChrome()
                    setPopoutWindowRevision(value => value + 1)
                },
            )
        }

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
        activatePanel,
        activateRequestedTab,
        conversationsByTabKey,
        ides,
        initialDataLoaded,
        layoutProfile,
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

        if (awaitingInitialLayoutHydrationRef.current && shouldAwaitStoredDockviewHydration({
            hasStoredLayout: true,
            initialDataLoaded,
            visibleConversationCount: visibleConversations.length,
            ides,
        })) return
        if (awaitingInitialLayoutHydrationRef.current) {
            awaitingInitialLayoutHydrationRef.current = false
        }

        const previousVisibleTabKeys = previousVisibleTabKeysRef.current
        const previousVisibleTabKeySet = new Set(previousVisibleTabKeys)
        const nextVisibleTabKeys = visibleConversations.map(conversation => conversation.tabKey)
        const nextVisibleTabKeySet = new Set(nextVisibleTabKeys)
        const shouldSkipPanelPrune = shouldDeferDockviewPanelPrune({
            previousVisibleConversationCount: previousVisibleTabKeys.length,
            visibleConversationCount: visibleConversations.length,
            ides,
        })

        let hiddenStateChanged = false
        for (const tabKey of previousVisibleTabKeys) {
            if (nextVisibleTabKeySet.has(tabKey)) continue
            if (shouldSkipPanelPrune) continue
            hiddenRestoreStateRef.current[tabKey] = readHiddenRestoreStateFromLayout(tabKey)
            hiddenStateChanged = true
        }
        if (hiddenStateChanged) {
            persistHiddenRestoreState()
        }

        if (!shouldSkipPanelPrune) {
            syncDockviewPanels(api, visibleConversations)
            syncRemotePanels(api, visibleConversations, requestedRemoteIdeId)
        }

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
            activatePanel(api.panels[0])
        }

        const activePanelStillExists = !!(api.activePanel && api.getPanel(api.activePanel.id))
        if (!activePanelStillExists) {
            activateStoredActiveTab()
        }
    }, [activatePanel, activateRequestedTab, activateStoredActiveTab, ides, initialDataLoaded, persistHiddenRestoreState, readHiddenRestoreStateFromLayout, requestedActiveTabKey, requestedRemoteIdeId, visibleConversations])

    useEffect(() => {
        if (!hasInitializedRef.current) return
        activateRequestedTab(requestedActiveTabKey)
    }, [activateRequestedTab, requestedActiveTabKey])

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
        const popoutWindows = getDistinctPopoutWindows(apiRef.current)

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
    }, [syncPopoutChrome, syncThemeToOpenPopouts, theme])

    useEffect(() => {
        syncPopoutChrome()
    }, [syncPopoutChrome])

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

    // Dockview tab bar wheel fix:
    // dockview's Scrollbar only handles deltaY and ignores deltaX.
    // Horizontal trackpad swipes (deltaX) bubble to browser → back/forward navigation.
    // Also, .dv-scrollable > .dv-tabs-container has overflow:hidden, so scrollLeft is a no-op from outside.
    // Fix: capture wheel events near .dv-scrollable, prevent default, then re-dispatch a synthetic
    // wheel event with deltaY = effective delta so dockview's own Scrollbar handler does the scroll.
    useEffect(() => {
        const container = dockviewContainerRef.current
        if (!container) return
        const handler = (e: WheelEvent) => {
            // synthetic events (isTrusted=false) are ones we dispatched ourselves —
            // let them pass through so dockview's own Scrollbar handler can process them
            if (!e.isTrusted) return
            const scrollable = (e.target as Element | null)?.closest?.('.dv-scrollable')
            if (!scrollable) return
            e.preventDefault()
            // stop original event from reaching dockview (which would mishandle deltaX or double-count)
            e.stopPropagation()
            const dx = Math.abs(e.deltaX)
            const dy = Math.abs(e.deltaY)
            const delta = dx > dy ? e.deltaX : e.deltaY
            // dispatch on the .dv-scrollable element so dockview's Scrollbar wheel handler receives it
            scrollable.dispatchEvent(new WheelEvent('wheel', {
                deltaY: delta,
                deltaMode: e.deltaMode,
                bubbles: false,
                cancelable: true,
            }))
        }
        container.addEventListener('wheel', handler, { passive: false, capture: true })
        return () => container.removeEventListener('wheel', handler, { capture: true })
    }, [])

    useEffect(() => {
        const popoutWindows = getDistinctPopoutWindows(apiRef.current)
        if (popoutWindows.length === 0) return

        const cleanups = popoutWindows.map(popup => attachPopoutShortcutKeys(popup, {
            encodeShortcut,
            isMac,
            isShortcutListening: () => !!shortcutListening,
            isVisibleTab: (tabKey) => visibleConversations.some(conversation => conversation.tabKey === tabKey),
            selectTabByShortcut,
            triggerAction: triggerPopoutActionShortcut,
        }))

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
                    className="h-full min-h-0 min-w-0 adhdev-dockview"
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
            {ctxMenu && (
                <DockviewTabContextMenu
                    x={ctxMenu.x}
                    y={ctxMenu.y}
                    sourceDocument={ctxMenu.sourceDocument}
                    items={ctxMenuItems}
                    onSelect={(itemId, event) => {
                        switch (itemId) {
                            case 'dockInWindow':
                            case 'dockBackToGrid':
                                dockTabToWorkspaceGrid(ctxMenu.tabKey)
                                break
                            case 'moveBackToMain':
                                moveTabBackToMain(ctxMenu.tabKey)
                                break
                            case 'floatAsPanel':
                                floatTab(ctxMenu.tabKey)
                                break
                            case 'openInNewWindow':
                                popoutTab(ctxMenu.tabKey)
                                break
                            case 'setShortcut':
                                event.stopPropagation()
                                setShortcutListening(ctxMenu.tabKey)
                                break
                            case 'removeShortcut': {
                                const next = { ...tabShortcuts }
                                delete next[ctxMenu.tabKey]
                                saveShortcuts(next)
                                break
                            }
                            case 'hideTab':
                                hideConversationTab(ctxMenu.tabKey)
                                break
                        }
                        setCtxMenu(null)
                    }}
                />
            )}
            {shortcutListening && (
                createPortal(
                    <div
                        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/50"
                        style={{ backdropFilter: 'blur(2px)' }}
                        onClick={() => setShortcutListening(null)}
                    >
                        <div
                            className="bg-bg-primary border border-border-subtle rounded-xl px-8 py-6 text-center shadow-xl"
                            onClick={event => event.stopPropagation()}
                        >
                            <div className="text-sm font-bold text-text-primary mb-2">⌨ {t('paneGroup.shortcutSetTitle')}</div>
                            <div className="text-xs text-text-secondary mb-4">
                                {t('paneGroup.shortcutPressCombo', { example1: isMac ? '⌘+1' : 'Ctrl+1', example2: isMac ? '⌥+A' : 'Alt+A' })}
                            </div>
                            <div className="text-lg font-mono text-accent animate-pulse">{t('paneGroup.shortcutListening')}</div>
                            <div className="text-3xs text-text-muted mt-3">{t('paneGroup.pressEscToCancel')}</div>
                        </div>
                    </div>,
                    shortcutOverlayDocument.body,
                )
            )}
        </DashboardDockviewContext.Provider>
    )
}
