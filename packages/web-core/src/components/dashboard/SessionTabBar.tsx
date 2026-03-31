
/**
 * SessionTabBar — Horizontal draggable tab strip for agent sessions.
 * Supports desktop drag-and-drop and mobile touch reorder.
 */
import { useRef, useState, useCallback, useEffect } from 'react';
import { useTransport } from '../../context/TransportContext';
import { isCliConv } from './types';
import type { ActiveConversation } from './types';
import type { CliTerminalHandle } from '../CliTerminal';

export interface SessionTabBarProps {
    sortedConversations: ActiveConversation[];
    activeTabId: string | null;
    tabsOverflow: boolean;
    tabsContainerRef: React.RefObject<HTMLDivElement | null>;
    terminalRef: React.RefObject<CliTerminalHandle | null>;
    onSelectTab: (tabKey: string) => void;
    onReorder: (newOrder: string[]) => void;
    pinTab: (tabKey: string, delays: number[]) => void;
    clearTabPinTimers: () => void;
    retryConnection?: (daemonId: string) => void;
    /** Split view: which tabs are in each pane */
    splitPanes?: [string | null, string | null];
    /** Split view: open tab in split pane */
    onSplitTab?: (tabKey: string) => void;
    /** Hide tab from dashboard */
    onHideTab?: (tabKey: string) => void;
}



export default function SessionTabBar({
    sortedConversations, activeTabId, tabsOverflow, tabsContainerRef, terminalRef,
    onSelectTab, onReorder, pinTab, clearTabPinTimers,
    splitPanes, onSplitTab, onHideTab,
}: SessionTabBarProps) {
    const { sendCommand } = useTransport();
    const dragTab = useRef<string | null>(null);
    const touchDragTab = useRef<string | null>(null);
    const touchStartPos = useRef<{ x: number; y: number } | null>(null);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [touchDragging, setTouchDragging] = useState(false);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabKey: string } | null>(null);

    const isSplitMode = splitPanes?.[1] != null;

    // ─── Touch reorder handlers ─────────────────────────
    const handleTouchStart = useCallback((tabKey: string, e: React.TouchEvent) => {
        const touch = e.touches[0];
        touchStartPos.current = { x: touch.clientX, y: touch.clientY };
        touchDragTab.current = tabKey;
        longPressTimer.current = setTimeout(() => {
            setTouchDragging(true);
        }, 400);
    }, []);

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
        if (!touchDragging || !touchDragTab.current) {
            if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
            return;
        }
        e.preventDefault();
        const touch = e.touches[0];
        const container = tabsContainerRef.current;
        if (!container) return;
        const tabs = Array.from(container.querySelectorAll('[data-tabkey]'));
        for (const tab of tabs) {
            const rect = tab.getBoundingClientRect();
            if (touch.clientX >= rect.left && touch.clientX <= rect.right) {
                const targetKey = tab.getAttribute('data-tabkey');
                if (targetKey && targetKey !== touchDragTab.current) {
                    const currentOrder = sortedConversations.map(c => c.tabKey);
                    const fromIdx = currentOrder.indexOf(touchDragTab.current!);
                    const toIdx = currentOrder.indexOf(targetKey);
                    if (fromIdx !== -1 && toIdx !== -1) {
                        const newOrder = [...currentOrder];
                        newOrder.splice(fromIdx, 1);
                        newOrder.splice(toIdx, 0, touchDragTab.current!);
                        onReorder(newOrder);
                    }
                }
                break;
            }
        }
    }, [touchDragging, sortedConversations, tabsContainerRef, onReorder]);

    const handleTouchEnd = useCallback(() => {
        if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
        setTouchDragging(false);
        touchDragTab.current = null;
        touchStartPos.current = null;
    }, []);


    // Track scroll position for fade edge hints
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);

    const updateScrollIndicators = useCallback(() => {
        const el = tabsContainerRef.current;
        if (!el) return;
        setCanScrollLeft(el.scrollLeft > 4);
        setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    }, [tabsContainerRef]);

    // Bind scroll event
    useEffect(() => {
        const el = tabsContainerRef.current;
        if (!el) return;
        updateScrollIndicators();
        el.addEventListener('scroll', updateScrollIndicators, { passive: true });
        const ro = new ResizeObserver(updateScrollIndicators);
        ro.observe(el);
        return () => {
            el.removeEventListener('scroll', updateScrollIndicators);
            ro.disconnect();
        };
    }, [tabsContainerRef, updateScrollIndicators, sortedConversations.length]);

    // Close context menu on any mousedown outside
    useEffect(() => {
        if (!contextMenu) return;
        const handler = (e: MouseEvent) => {
            // Don't dismiss if clicking inside the context menu itself
            const menu = document.querySelector('[data-context-menu]');
            if (menu && menu.contains(e.target as Node)) return;
            setContextMenu(null);
        };
        window.addEventListener('mousedown', handler, true);
        return () => window.removeEventListener('mousedown', handler, true);
    }, [contextMenu]);

    // Horizontal wheel scroll on tab bar (must be non-passive to allow preventDefault)
    useEffect(() => {
        const el = tabsContainerRef.current;
        if (!el) return;
        const handler = (e: WheelEvent) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                e.preventDefault();
                el.scrollLeft += e.deltaY;
            }
        };
        el.addEventListener('wheel', handler, { passive: false });
        return () => el.removeEventListener('wheel', handler);
    }, [tabsContainerRef]);


    return (
        <div className="relative shrink-0">
            {/* Fade gradient hints — non-interactive, just visual cues */}
            {tabsOverflow && canScrollLeft && (
                <div
                    className="absolute left-0 top-0 bottom-0 z-[3] w-5 pointer-events-none"
                    style={{ background: 'linear-gradient(to right, var(--bg-secondary), transparent)' }}
                />
            )}
            {tabsOverflow && canScrollRight && (
                <div
                    className="absolute right-0 top-0 bottom-0 z-[3] w-5 pointer-events-none"
                    style={{ background: 'linear-gradient(to left, var(--bg-secondary), transparent)' }}
                />
            )}
            <div
                ref={tabsContainerRef as any}
                className="dashboard-agent-tabs flex overflow-x-auto overflow-y-visible shrink-0 bg-bg-secondary border-b border-border-subtle pt-1.5 pb-0 gap-1 select-none"
                style={{
                    paddingLeft: 8,
                    paddingRight: 8,
                    scrollbarWidth: 'none',
                    WebkitOverflowScrolling: 'touch',
                } as React.CSSProperties}
            >
                {sortedConversations.map((conv, convIdx) => {
                    const isActive = activeTabId === conv.tabKey;
                    const isInSplit = isSplitMode && (splitPanes?.[0] === conv.tabKey || splitPanes?.[1] === conv.tabKey);
                    const splitPaneIdx = splitPanes?.[0] === conv.tabKey ? 0 : splitPanes?.[1] === conv.tabKey ? 1 : -1;
                    const tabClass = conv.status === 'generating' ? 'agent-tab-generating' : conv.status === 'waiting_approval' ? 'agent-tab-waiting' : '';
                    const tabShortcut = convIdx < 9 ? String(convIdx + 1) : null;
                    const isReconnecting = conv.connectionState === 'failed' || conv.connectionState === 'closed';
                    return (
                        <div
                            key={conv.tabKey}
                            data-tabkey={conv.tabKey}
                            className={`${tabClass} shrink-0 px-2.5 py-1.5 rounded-t-lg border-b-0 cursor-grab flex items-center gap-2 transition-all duration-200`}
                            draggable
                            onDragStart={() => { dragTab.current = conv.tabKey; }}
                            onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderLeft = '2px solid var(--accent-primary)'; }}
                            onDragLeave={e => { e.currentTarget.style.borderLeft = isActive ? '1px solid var(--border-subtle)' : '1px solid transparent'; }}
                            onDrop={e => {
                                e.preventDefault();
                                e.currentTarget.style.borderLeft = isActive ? '1px solid var(--border-subtle)' : '1px solid transparent';
                                if (!dragTab.current || dragTab.current === conv.tabKey) return;
                                const currentOrder = sortedConversations.map(c => c.tabKey);
                                const fromIdx = currentOrder.indexOf(dragTab.current);
                                const toIdx = currentOrder.indexOf(conv.tabKey);
                                if (fromIdx === -1 || toIdx === -1) return;
                                const newOrder = [...currentOrder];
                                newOrder.splice(fromIdx, 1);
                                newOrder.splice(toIdx, 0, dragTab.current);
                                onReorder(newOrder);
                                dragTab.current = null;
                            }}
                            onDragEnd={() => { dragTab.current = null; }}
                            onTouchStart={e => handleTouchStart(conv.tabKey, e)}
                            onTouchMove={handleTouchMove}
                            onTouchEnd={handleTouchEnd}
                            onClick={() => {
                                setContextMenu(null);
                                clearTabPinTimers();
                                onSelectTab(conv.tabKey);
                                if (conv.streamSource === 'agent-stream' && conv.agentType) {
                                    sendCommand(conv.ideId, 'agent_stream_focus', { agentType: conv.agentType }).catch(() => { });
                                    pinTab(conv.tabKey, [200, 1500]);
                                }
                                if (isCliConv(conv)) {
                                    setTimeout(() => {
                                        terminalRef.current?.bumpResize?.();
                                    }, 100);
                                }
                            }}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                if (contextMenu && contextMenu.tabKey === conv.tabKey) {
                                    setContextMenu(null);
                                    return;
                                }
                                setContextMenu({ x: e.clientX, y: e.clientY, tabKey: conv.tabKey });
                            }}
                            style={{
                                background: isActive ? 'var(--bg-primary)' : 'var(--bg-glass)',
                                borderTop: (isActive || isInSplit) ? '1px solid var(--border-subtle)' : '1px solid transparent',
                                borderLeft: (isActive || isInSplit) ? '1px solid var(--border-subtle)' : '1px solid transparent',
                                borderRight: (isActive || isInSplit) ? '1px solid var(--border-subtle)' : '1px solid transparent',
                                opacity: (touchDragging && touchDragTab.current === conv.tabKey)
                                    ? (isReconnecting ? 0.15 : 0.3)
                                    : isReconnecting
                                    ? (isActive ? 0.6 : 0.3)
                                    : (isActive || isInSplit ? 1 : 0.65),
                            }}
                        >
                            {/* Left dot: connection indicator */}
                            {conv.status === 'generating' ? (
                                <div className="tab-spinner" />
                            ) : conv.status === 'waiting_approval' ? (
                                <span className="text-[8px] px-[5px] py-px text-yellow-400">▲</span>
                            ) : isReconnecting ? (
                                <span className="text-[8px] px-[5px] py-px text-yellow-400 animate-pulse">○</span>
                            ) : conv.connectionState === 'connecting' ? (
                                <span className="text-[8px] px-[5px] py-px text-blue-400">○</span>
                            ) : conv.connectionState === 'connected' ? (
                                <span className="text-[8px] px-[5px] py-px text-green-400">●</span>
                            ) : (
                                <span className="text-[8px] px-[5px] py-px text-text-muted">●</span>
                            )}
                            <div className="min-w-0">
                                <div className="text-xs font-bold whitespace-nowrap overflow-hidden text-ellipsis">{conv.displayPrimary}</div>
                                <div className="text-[8px] opacity-50 flex gap-1 items-center">
                                    {isReconnecting ? (
                                        <span className="text-yellow-400 opacity-100">Reconnecting…</span>
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
                            {tabShortcut ? (
                                <span className="text-[9px] opacity-35 font-mono ml-0.5 shrink-0">{tabShortcut}</span>
                            ) : null}
                            {isInSplit && (
                                <span className="text-[8px] opacity-40 ml-0.5 shrink-0" title={`Split pane ${splitPaneIdx + 1}`}>
                                    {splitPaneIdx === 0 ? '◧' : '◨'}
                                </span>
                            )}
                        </div>
                    );
                })}
                {sortedConversations.length === 0 && <div className="p-2 text-xs opacity-40">No active agents online.</div>}
            </div>

            {/* Context Menu (right-click split) */}
            {contextMenu && (
                <div
                    data-context-menu
                    className="fixed z-50 bg-bg-primary border border-border-subtle rounded-lg shadow-lg py-1 min-w-[140px]"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                >
                    {onSplitTab && (
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors flex items-center gap-2"
                            onClick={() => {
                                onSplitTab(contextMenu.tabKey);
                                setContextMenu(null);
                            }}
                        >
                            {isSplitMode ? '✕ Close Split' : '◧ Split Right'}
                        </button>
                    )}
                    {onHideTab && (
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors flex items-center gap-2 text-text-muted"
                            onClick={() => {
                                onHideTab(contextMenu.tabKey);
                                setContextMenu(null);
                            }}
                        >
                            👁‍🗨 Hide from Dashboard
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
