import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore,
    type Dispatch,
    type SetStateAction,
} from 'react'
import type { IDockviewPanelHeaderProps, IDockviewPanelProps } from 'dockview'
import type { ActiveConversation } from './types'
import type { DaemonData } from '../../types'
import RemoteView from '../RemoteView'
import { useIdeRemoteStream } from '../../hooks/useIdeRemoteStream'
import type { LiveSessionInboxState } from './DashboardMobileChatShared'
import { getConversationInboxSurfaceState } from './DashboardMobileChatShared'
import { getChatTyping, subscribeChatTyping } from './chat-typing-indicator-store'
import { getPreferredConversationForIde } from './conversation-sort'
import { getConversationTabMetaText, getConversationTitle } from './conversation-presenters'
import { getConversationNativeTargetSessionId } from './conversation-selectors'
import PaneGroupEmptyState from './PaneGroupEmptyState'
import type { DashboardDockviewPanelParams, DashboardDockviewRemotePanelParams } from './dockviewWorkspaceLayout'

export interface DashboardDockviewContextValue {
    actionLogs: { routeId: string; text: string; timestamp: number }[]
    clearedTabs: Record<string, number>
    conversationsByTabKey: Map<string, ActiveConversation>
    hasDetachedConversationPanels: boolean
    ides: DaemonData[]
    isStandalone: boolean
    hasRegisteredMachines: boolean
    /** False while the first daemon snapshot is still in flight (see PaneGroupEmptyState). */
    initialDataLoaded: boolean
    onOpenNewSession?: () => void
    liveSessionInboxState: Map<string, LiveSessionInboxState>
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setActionLogs: Dispatch<SetStateAction<{ routeId: string; text: string; timestamp: number }[]>>
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

export const DashboardDockviewContext = createContext<DashboardDockviewContextValue | null>(null)

export function useDashboardDockviewContext() {
    const value = useContext(DashboardDockviewContext)
    if (!value) throw new Error('DashboardDockviewContext missing')
    return value
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

export function DashboardDockviewRemotePanel({ params }: IDockviewPanelProps<DashboardDockviewRemotePanelParams>) {
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

export function DashboardDockviewWatermark() {
    const ctx = useDashboardDockviewContext()
    return (
        <div className="h-full min-h-0 min-w-0 flex flex-col items-center justify-center">
            <PaneGroupEmptyState
                conversationsCount={0}
                isSplitMode={false}
                isStandalone={ctx.isStandalone}
                hasRegisteredMachines={ctx.hasRegisteredMachines}
                onOpenNewSession={ctx.onOpenNewSession}
                suppressGuide={ctx.hasDetachedConversationPanels}
                isLoading={!ctx.initialDataLoaded}
            />
        </div>
    )
}

export function DashboardDockviewTab(props: IDockviewPanelHeaderProps<DashboardDockviewPanelParams | DashboardDockviewRemotePanelParams>) {
    useDockviewHeaderRenderTick(props)
    const ctx = useDashboardDockviewContext()
    const activatePanel = useCallback((event: React.MouseEvent | React.PointerEvent | React.TouchEvent) => {
        if ('button' in event && event.button !== 0) return
        props.api.setActive()
    }, [props.api])

    // ── Hooks must run unconditionally (Rules of Hooks) ─────────────────
    // The two early-return branches below (remote / missing conversation)
    // both render without consulting these subscriptions, so we resolve
    // the session id and subscribe up here even if the result is unused
    // on those code paths. Computing them here keeps the hook order
    // identical across all renders of this component.
    const conversationForTypingLookup = props.params.kind === 'remote'
        ? undefined
        : ctx.conversationsByTabKey.get(props.params.tabKey)
    const chatTypingSessionId = conversationForTypingLookup?.sessionId
    const subscribeTypingStore = useCallback(
        (listener: () => void) => subscribeChatTyping(listener),
        [],
    )
    const getTypingSnapshot = useCallback(
        () => getChatTyping(chatTypingSessionId),
        [chatTypingSessionId],
    )
    const isTypingFromStore = useSyncExternalStore(
        subscribeTypingStore,
        getTypingSnapshot,
        getTypingSnapshot,
    )

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

    // The chat-typing-store subscription is set up at the top of this
    // function (above the early-return branches) so the hook order is
    // identical across all renders; isTypingFromStore is captured there
    // and we just consume it here. The OR direction matters: the tab
    // shows the spinner when *either* the daemon-derived
    // surfaceState.isGenerating OR ChatPane's published indicator is
    // true. This guarantees the tab spinner never lags behind the
    // chat-bubble "Agent generating..." indicator that the user
    // specifically asked to treat as authoritative.
    const isReconnecting = surfaceState.isReconnecting
    const isConnecting = surfaceState.isConnecting
    const isGenerating = surfaceState.isGenerating || isTypingFromStore
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
