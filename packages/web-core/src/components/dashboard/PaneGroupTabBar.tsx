import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { useTabShortcuts } from '../../hooks/useTabShortcuts'
import { isCliConv } from './types'
import type { ActiveConversation } from './types'

interface PaneGroupTabBarProps {
    conversations: ActiveConversation[]
    activeTabId: string | null
    groupIndex: number
    numGroups: number
    draggingTabRef: MutableRefObject<string | null>
    previewOrderRef: MutableRefObject<string[] | null>
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
}

export default function PaneGroupTabBar({
    conversations,
    activeTabId,
    groupIndex,
    numGroups,
    draggingTabRef,
    previewOrderRef,
    onFocus,
    onSelectTab,
    onConversationActivated,
    onPreviewReorder,
    onReorderTab,
    onCommitPreviewOrder,
    onClearPreviewOrder,
    onDragStateReset,
    onDragTabKeyChange,
    onMoveTab,
    onReceiveTab,
    onHideTab,
}: PaneGroupTabBarProps) {
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabKey: string } | null>(null)
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const tabBarRef = useRef<HTMLDivElement>(null)

    const {
        isMac,
        tabShortcuts,
        shortcutListening,
        setShortcutListening,
        saveShortcuts,
    } = useTabShortcuts({
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
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                e.preventDefault()
                el.scrollLeft += e.deltaY
            }
        }
        el.addEventListener('wheel', handler, { passive: false })
        return () => el.removeEventListener('wheel', handler)
    }, [])

    return (
        <>
            <div className="flex items-center bg-bg-secondary border-b border-border-subtle shrink-0 gap-0">
                <div
                    ref={tabBarRef}
                    className="flex-1 flex overflow-x-auto overflow-y-visible pt-1.5 pb-0 gap-1 select-none"
                    style={{ paddingLeft: 8, paddingRight: 4, scrollbarWidth: 'none' }}
                >
                    {conversations.map((conv) => {
                        const isActive = activeTabId === conv.tabKey
                        const tabClass = conv.status === 'generating' ? 'agent-tab-generating'
                            : conv.status === 'waiting_approval' ? 'agent-tab-waiting' : ''
                        const isReconnecting = conv.connectionState === 'failed' || conv.connectionState === 'closed'
                        const isDraggedTab = draggingTabRef.current === conv.tabKey

                        return (
                            <div
                                key={conv.tabKey}
                                data-tabkey={conv.tabKey}
                                className={`${tabClass} shrink-0 px-2.5 py-1.5 rounded-t-lg cursor-pointer flex items-center gap-2 relative`}
                                draggable={true}
                                onDragStart={(e) => {
                                    draggingTabRef.current = conv.tabKey
                                    onDragTabKeyChange(conv.tabKey)
                                    e.dataTransfer.setData('text/tab-key', conv.tabKey)
                                    e.dataTransfer.effectAllowed = 'move'
                                }}
                                onDragEnd={() => {
                                    draggingTabRef.current = null
                                    onDragTabKeyChange(null)
                                    onCommitPreviewOrder()
                                    previewOrderRef.current = null
                                    onClearPreviewOrder()
                                    onDragStateReset()
                                }}
                                onDragOver={(e) => {
                                    const draggingTabKey = draggingTabRef.current
                                    if (!draggingTabKey || draggingTabKey === conv.tabKey) return
                                    if (e.dataTransfer.types.includes('text/tab-key')) {
                                        e.preventDefault()
                                        e.stopPropagation()
                                        const rect = e.currentTarget.getBoundingClientRect()
                                        const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
                                        onPreviewReorder(draggingTabKey, conv.tabKey, side)
                                    }
                                }}
                                onDrop={(e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    const draggedKey = e.dataTransfer.getData('text/tab-key')
                                    if (draggedKey && draggedKey !== conv.tabKey) {
                                        const rect = e.currentTarget.getBoundingClientRect()
                                        const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
                                        if (conversations.some(c => c.tabKey === draggedKey)) {
                                            onReorderTab(draggedKey, conv.tabKey, side)
                                        } else if (onReceiveTab) {
                                            onReceiveTab(draggedKey)
                                        }
                                    }
                                    onClearPreviewOrder()
                                }}
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onFocus()
                                    onSelectTab(conv.tabKey)
                                    onConversationActivated(conv)
                                }}
                                onContextMenu={(e) => {
                                    e.preventDefault()
                                    setCtxMenu({ x: e.clientX, y: e.clientY, tabKey: conv.tabKey })
                                }}
                                onTouchStart={(e) => {
                                    const touch = e.touches[0]
                                    longPressTimer.current = setTimeout(() => {
                                        setCtxMenu({ x: touch.clientX, y: touch.clientY, tabKey: conv.tabKey })
                                    }, 600)
                                }}
                                onTouchEnd={() => {
                                    if (longPressTimer.current) clearTimeout(longPressTimer.current)
                                }}
                                onTouchMove={() => {
                                    if (longPressTimer.current) clearTimeout(longPressTimer.current)
                                }}
                                style={{
                                    background: isActive ? 'var(--bg-primary)' : 'var(--bg-glass)',
                                    borderTop: isActive ? '1px solid var(--border-subtle)' : '1px solid transparent',
                                    borderLeft: isActive ? '1px solid var(--border-subtle)' : '1px solid transparent',
                                    borderRight: isActive ? '1px solid var(--border-subtle)' : '1px solid transparent',
                                    opacity: isDraggedTab ? 0.4 : isReconnecting ? (isActive ? 0.6 : 0.3) : (isActive ? 1 : 0.65),
                                    transition: 'transform 0.2s ease, opacity 0.15s ease',
                                }}
                            >
                                {conv.status === 'generating' ? (
                                    <div className="tab-spinner" />
                                ) : conv.status === 'waiting_approval' ? (
                                    <span className="text-[8px] px-[5px] py-px text-yellow-400">▲</span>
                                ) : isReconnecting ? (
                                    <span className="text-[8px] px-[5px] py-px text-yellow-400 animate-pulse">○</span>
                                ) : conv.connectionState === 'connecting' || conv.connectionState === 'new' ? (
                                    <div className="tab-connecting-spinner" />
                                ) : conv.connectionState === 'connected' ? (
                                    <span className="text-[8px] px-[5px] py-px text-green-400">●</span>
                                ) : (
                                    <span className="text-[8px] px-[5px] py-px text-text-muted animate-pulse">○</span>
                                )}
                                <div className="min-w-0">
                                    <div className="text-xs font-bold whitespace-nowrap overflow-hidden text-ellipsis" style={{ maxWidth: '10ch' }} title={conv.displayPrimary}>{conv.displayPrimary}</div>
                                    <div className="text-[8px] opacity-50 flex gap-1 items-center">
                                        {isReconnecting ? (
                                            <span className="text-yellow-400 opacity-100">Reconnecting…</span>
                                        ) : (conv.connectionState === 'connecting' || conv.connectionState === 'new') ? (
                                            <span className="text-blue-400 opacity-100">Connecting<span className="connecting-dots"></span></span>
                                        ) : (
                                            <>
                                                {conv.displaySecondary}
                                                {conv.machineName && (
                                                    <>
                                                        <span className="opacity-40">·</span>
                                                        <span className="opacity-70">🖥 {conv.machineName}</span>
                                                    </>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                                {tabShortcuts[conv.tabKey] && (
                                    <span className="text-[9px] opacity-50 font-mono ml-0.5 shrink-0 bg-bg-secondary px-1 rounded" title={`Ctrl+${tabShortcuts[conv.tabKey]}`}>{tabShortcuts[conv.tabKey]}</span>
                                )}
                            </div>
                        )
                    })}
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
                    {onMoveTab && groupIndex > 0 && (
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors "
                            onClick={() => { onMoveTab(ctxMenu.tabKey, 'left'); setCtxMenu(null) }}
                        >
                            ← Move to Left Group
                        </button>
                    )}
                    {onMoveTab && groupIndex < numGroups - 1 && (
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors "
                            onClick={() => { onMoveTab(ctxMenu.tabKey, 'right'); setCtxMenu(null) }}
                        >
                            Move to Right Group →
                        </button>
                    )}
                    {onMoveTab && numGroups < 4 && (
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors "
                            onClick={() => { onMoveTab(ctxMenu.tabKey, 'split-left'); setCtxMenu(null) }}
                        >
                            ⇤ Split Left
                        </button>
                    )}
                    {onMoveTab && numGroups < 4 && (
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors "
                            onClick={() => { onMoveTab(ctxMenu.tabKey, 'split-right'); setCtxMenu(null) }}
                        >
                            Split Right ⇥
                        </button>
                    )}
                    <div className="border-t border-border-subtle my-1 " />
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
                    {onHideTab && (
                        <>
                            <div className="border-t border-border-subtle my-1" />
                            <button
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors text-text-muted"
                                onClick={() => { onHideTab(ctxMenu.tabKey); setCtxMenu(null) }}
                            >
                                🚫 Hide from Dashboard
                            </button>
                        </>
                    )}
                    {!onMoveTab && !onHideTab && (
                        <div className="px-3 py-1.5 text-[11px] text-text-muted opacity-50 italic">
                            No actions available
                        </div>
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
