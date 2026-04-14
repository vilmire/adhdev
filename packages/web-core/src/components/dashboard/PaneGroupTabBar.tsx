import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useDevRenderTrace } from '../../hooks/useDevRenderTrace'
import { useTabShortcuts } from '../../hooks/useTabShortcuts'
import type { ActiveConversation } from './types'
import { getConversationViewStates } from './DashboardMobileChatShared'
import { getConversationTabMetaText, getConversationTitle } from './conversation-presenters'

interface PaneGroupTabBarProps {
    conversations: ActiveConversation[]
    activeTabId: string | null
    groupIndex: number
    numGroups: number
    unreadTabKeys: Set<string>
    draggingTabRef: MutableRefObject<string | null>
    onFocus: () => void
    onSelectTab: (tabKey: string) => void
    onConversationActivated: (conversation: ActiveConversation) => void
    onPreviewReorder: (draggedKey: string, targetKey: string, side: 'left' | 'right') => void
    onReorderTab: (draggedKey: string, targetKey: string, side: 'left' | 'right') => void
    onCommitPreviewOrder: () => void
    onClearPreviewOrder: () => void
    onDragStateReset: () => void
    onDragTabKeyChange: (tabKey: string | null) => void
    onMoveTab?: (tabKey: string, direction: 'left' | 'right' | 'split-left' | 'split-right') => void
    onReceiveTab?: (tabKey: string) => void
    onHideTab?: (tabKey: string) => void
    isGroupActive?: boolean
    allowTabShortcuts?: boolean
}

interface PaneGroupTabBarItemProps {
    conv: ActiveConversation
    isActive: boolean
    isDraggedTab: boolean
    isTaskCompleteUnread: boolean
    shortcut?: string
    conversationKeys: string[]
    draggingTabRef: MutableRefObject<string | null>
    onFocus: () => void
    onSelectTab: (tabKey: string) => void
    onConversationActivated: (conversation: ActiveConversation) => void
    onPreviewReorder: (draggedKey: string, targetKey: string, side: 'left' | 'right') => void
    onReorderTab: (draggedKey: string, targetKey: string, side: 'left' | 'right') => void
    onCommitPreviewOrder: () => void
    onClearPreviewOrder: () => void
    onDragStateReset: () => void
    onDragTabKeyChange: (tabKey: string | null) => void
    onReceiveTab?: (tabKey: string) => void
    onOpenContextMenu: (x: number, y: number, tabKey: string) => void
    longPressTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>
    isGroupActive?: boolean
}

const PaneGroupTabBarItem = memo(function PaneGroupTabBarItem({
    conv,
    isActive,
    isDraggedTab,
    isTaskCompleteUnread,
    shortcut,
    conversationKeys,
    draggingTabRef,
    onFocus,
    onSelectTab,
    onConversationActivated,
    onPreviewReorder,
    onReorderTab,
    onCommitPreviewOrder,
    onClearPreviewOrder,
    onDragStateReset,
    onDragTabKeyChange,
    onReceiveTab,
    onOpenContextMenu,
    longPressTimer,
    isGroupActive,
}: PaneGroupTabBarItemProps) {
    const viewStates = getConversationViewStates(conv)
    const tabClass = viewStates.isGenerating ? 'agent-tab-generating'
        : viewStates.isWaiting ? 'agent-tab-waiting' : ''
    const isReconnecting = viewStates.isReconnecting

    const handleDragStart = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        draggingTabRef.current = conv.tabKey
        onDragTabKeyChange(conv.tabKey)
        e.dataTransfer.setData('text/tab-key', conv.tabKey)
        e.dataTransfer.effectAllowed = 'move'
    }, [conv.tabKey, draggingTabRef, onDragTabKeyChange])

    const handleDragEnd = useCallback(() => {
        draggingTabRef.current = null
        onDragTabKeyChange(null)
        onCommitPreviewOrder()
        onClearPreviewOrder()
        onDragStateReset()
    }, [draggingTabRef, onDragTabKeyChange, onCommitPreviewOrder, onClearPreviewOrder, onDragStateReset])

    const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        const draggingTabKey = draggingTabRef.current
        if (!draggingTabKey || draggingTabKey === conv.tabKey) return
        if (e.dataTransfer.types.includes('text/tab-key')) {
            e.preventDefault()
            e.stopPropagation()
            const rect = e.currentTarget.getBoundingClientRect()
            const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
            onPreviewReorder(draggingTabKey, conv.tabKey, side)
        }
    }, [conv.tabKey, draggingTabRef, onPreviewReorder])

    const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault()
        e.stopPropagation()
        const draggedKey = e.dataTransfer.getData('text/tab-key')
        if (draggedKey && draggedKey !== conv.tabKey) {
            const rect = e.currentTarget.getBoundingClientRect()
            const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
            if (conversationKeys.includes(draggedKey)) {
                onReorderTab(draggedKey, conv.tabKey, side)
            } else if (onReceiveTab) {
                onReceiveTab(draggedKey)
            }
        }
        onClearPreviewOrder()
    }, [conv.tabKey, conversationKeys, onReorderTab, onReceiveTab, onClearPreviewOrder])

    const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.stopPropagation()
        onFocus()
        onSelectTab(conv.tabKey)
        onConversationActivated(conv)
    }, [conv, onConversationActivated, onFocus, onSelectTab])

    const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault()
        onOpenContextMenu(e.clientX, e.clientY, conv.tabKey)
    }, [conv.tabKey, onOpenContextMenu])

    const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
        const touch = e.touches[0]
        longPressTimer.current = setTimeout(() => {
            onOpenContextMenu(touch.clientX, touch.clientY, conv.tabKey)
        }, 600)
    }, [conv.tabKey, longPressTimer, onOpenContextMenu])

    const clearLongPress = useCallback(() => {
        if (longPressTimer.current) clearTimeout(longPressTimer.current)
    }, [longPressTimer])

    const tabClasses = [
        'adhdev-dockview-tab',
        tabClass,
        isActive && 'is-active',
        isGroupActive && 'is-group-active',
        isReconnecting && 'is-reconnecting',
    ].filter(Boolean).join(' ')

    return (
        <div
            data-tabkey={conv.tabKey}
            className={tabClasses}
            draggable={true}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onClick={handleClick}
            onContextMenu={handleContextMenu}
            onTouchStart={handleTouchStart}
            onTouchEnd={clearLongPress}
            onTouchMove={clearLongPress}
            style={{
                cursor: 'pointer',
                opacity: isDraggedTab ? 0.4 : undefined,
            }}
        >
            {isTaskCompleteUnread && <span className="adhdev-dockview-tab-unread-dot" aria-hidden="true" />}
            <div className="adhdev-dockview-tab-status">
                {viewStates.isGenerating ? (
                    <div className="tab-spinner" />
                ) : viewStates.isWaiting ? (
                    <span className="adhdev-dockview-tab-status-text is-waiting">▲</span>
                ) : isReconnecting ? (
                    <span className="adhdev-dockview-tab-reconnecting">○</span>
                ) : viewStates.isConnecting ? (
                    <div className="tab-connecting-spinner" />
                ) : conv.connectionState === 'connected' ? (
                    <span className="adhdev-dockview-tab-status-text is-connected">●</span>
                ) : (
                    <span className="adhdev-dockview-tab-status-text is-idle">○</span>
                )}
            </div>
            <div className="adhdev-dockview-tab-copy">
                <span className="adhdev-dockview-tab-primary" title={getConversationTitle(conv)}>{getConversationTitle(conv)}</span>
                <span className="adhdev-dockview-tab-meta">
                    {isReconnecting ? (
                        <span className="adhdev-dockview-tab-reconnecting">{getConversationTabMetaText(conv)}</span>
                    ) : viewStates.isConnecting ? (
                        <span className="adhdev-dockview-tab-connecting">{getConversationTabMetaText(conv)}<span className="connecting-dots"></span></span>
                    ) : (
                        getConversationTabMetaText(conv)
                    )}
                </span>
            </div>
            {shortcut && (
                <span className="text-[9px] opacity-50 font-mono ml-0.5 shrink-0 bg-bg-secondary px-1 rounded" title={`Ctrl+${shortcut}`}>{shortcut}</span>
            )}
        </div>
    )
}, (prev, next) => (
    prev.conv === next.conv
    && prev.isActive === next.isActive
    && prev.isDraggedTab === next.isDraggedTab
    && prev.isTaskCompleteUnread === next.isTaskCompleteUnread
    && prev.shortcut === next.shortcut
    && prev.conversationKeys === next.conversationKeys
    && prev.isGroupActive === next.isGroupActive
));

export default function PaneGroupTabBar({
    conversations,
    activeTabId,
    groupIndex,
    unreadTabKeys,
    draggingTabRef,
    onFocus,
    onSelectTab,
    onConversationActivated,
    onPreviewReorder,
    onReorderTab,
    onCommitPreviewOrder,
    onClearPreviewOrder,
    onDragStateReset,
    onDragTabKeyChange,
    onReceiveTab,
    onHideTab,
    isGroupActive,
    allowTabShortcuts = true,
}: PaneGroupTabBarProps) {
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabKey: string } | null>(null)
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const tabBarRef = useRef<HTMLDivElement>(null)
    const conversationKeys = useMemo(() => conversations.map(conv => conv.tabKey), [conversations])
    useDevRenderTrace('PaneGroupTabBar', {
        groupIndex,
        activeTabId,
        tabCount: conversations.length,
        ctxMenuTab: ctxMenu?.tabKey || null,
    })

    const {
        isMac,
        tabShortcuts,
        shortcutListening,
        setShortcutListening,
        saveShortcuts,
    } = useTabShortcuts({
        enabled: allowTabShortcuts,
        sortedTabKeys: conversations.map(conv => conv.tabKey),
        onFocus,
        onSelectTab,
    })

    useEffect(() => {
        if (!ctxMenu) return
        const close = (e: MouseEvent) => {
            const menu = document.querySelector('[data-pane-context-menu]')
            if (menu && menu.contains(e.target as Node)) return
            setCtxMenu(null)
        }
        window.addEventListener('mousedown', close, true)
        return () => window.removeEventListener('mousedown', close, true)
    }, [ctxMenu])

    useEffect(() => {
        const el = tabBarRef.current
        if (!el) return
        const handler = (e: WheelEvent) => {
            // Only intercept when vertical scroll dominates (mouse wheel → horizontal)
            // Horizontal trackpad swipes are handled natively; overscroll-behavior-x prevents back nav
            if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
            e.preventDefault()
            el.scrollLeft += e.deltaY
        }
        el.addEventListener('wheel', handler, { passive: false })
        return () => el.removeEventListener('wheel', handler)
    }, [])

    const openContextMenu = useCallback((x: number, y: number, tabKey: string) => {
        setCtxMenu({ x, y, tabKey })
    }, [])

    return (
        <>
            <div className="flex items-end shrink-0 gap-0" style={{
                background: 'var(--surface-secondary)',
                paddingInline: 8,
                paddingTop: 6,
                paddingBottom: 0,
            }}>
                <div
                    ref={tabBarRef}
                    className="flex-1 flex overflow-x-auto overflow-y-visible gap-1.5 select-none"
                    style={{ scrollbarWidth: 'none', overscrollBehaviorX: 'contain' }}
                >
                    {conversations.map((conv) => (
                        <PaneGroupTabBarItem
                            key={conv.tabKey}
                            conv={conv}
                            isActive={activeTabId === conv.tabKey}
                            isDraggedTab={draggingTabRef.current === conv.tabKey}
                            isTaskCompleteUnread={unreadTabKeys.has(conv.tabKey)}
                            shortcut={allowTabShortcuts ? tabShortcuts[conv.tabKey] : undefined}
                            conversationKeys={conversationKeys}
                            draggingTabRef={draggingTabRef}
                            onFocus={onFocus}
                            onSelectTab={onSelectTab}
                            onConversationActivated={onConversationActivated}
                            onPreviewReorder={onPreviewReorder}
                            onReorderTab={onReorderTab}
                            onCommitPreviewOrder={onCommitPreviewOrder}
                            onClearPreviewOrder={onClearPreviewOrder}
                            onDragStateReset={onDragStateReset}
                            onDragTabKeyChange={onDragTabKeyChange}
                            onReceiveTab={onReceiveTab}
                            onOpenContextMenu={openContextMenu}
                            longPressTimer={longPressTimer}
                            isGroupActive={isGroupActive}
                        />
                    ))}
                    {conversations.length === 0 && (
                        <div className="p-2 text-xs opacity-40">No tabs in this group</div>
                    )}
                </div>
            </div>

            {ctxMenu && (
                <div
                    data-pane-context-menu
                    className="fixed z-50 bg-bg-primary border border-border-subtle rounded-lg shadow-lg py-1 min-w-[160px]"
                    style={{ left: ctxMenu.x, top: ctxMenu.y }}
                >
                    {allowTabShortcuts && (
                        <>
                            <button
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors "
                                onClick={(e) => {
                                    e.stopPropagation()
                                    setShortcutListening(ctxMenu.tabKey)
                                    setCtxMenu(null)
                                }}
                            >
                                ⌨ {tabShortcuts[ctxMenu.tabKey] ? `Change shortcut (${tabShortcuts[ctxMenu.tabKey]})` : 'Set shortcut'}
                            </button>
                            {tabShortcuts[ctxMenu.tabKey] && (
                                <button
                                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors text-text-muted "
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
                        </>
                    )}
                    {onHideTab && (
                        <>
                            {allowTabShortcuts && <div className="border-t border-border-subtle my-1" />}
                            <button
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors text-text-muted"
                                onClick={() => { onHideTab(ctxMenu.tabKey); setCtxMenu(null) }}
                            >
                                🚫 Hide from Dashboard
                            </button>
                        </>
                    )}
                </div>
            )}

            {allowTabShortcuts && shortcutListening && (
                <div
                    className="fixed inset-0 z-[60] flex items-center justify-center"
                    style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
                    onClick={() => setShortcutListening(null)}
                >
                    <div
                        className="bg-bg-primary border border-border-subtle rounded-xl px-8 py-6 text-center shadow-xl"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="text-sm font-bold text-text-primary mb-2">⌨ Set shortcut</div>
                        <div className="text-xs text-text-secondary mb-4">
                            Press a key combo (e.g. {isMac ? '⌘+1' : 'Ctrl+1'}, {isMac ? '⌥+A' : 'Alt+A'})
                        </div>
                        <div className="text-lg font-mono text-accent animate-pulse">
                            Listening...
                        </div>
                        <div className="text-[10px] text-text-muted mt-3">Press Esc to cancel</div>
                    </div>
                </div>
            )}
        </>
    )
}
