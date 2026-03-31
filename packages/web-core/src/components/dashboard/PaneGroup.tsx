/**
 * PaneGroup — One editor-group: its own tab bar + content area.
 *
 * Like VS Code editor groups: each group has independent tabs,
 * active tab selection, and content rendering.
 */
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useTransport } from '../../context/TransportContext';
import { useDashboardCommands } from '../../hooks/useDashboardCommands';
import { isCliConv, isAcpConv } from './types';
import type { ActiveConversation } from './types';
import type { DaemonData } from '../../types';
import type { CliTerminalHandle } from '../CliTerminal';
import ApprovalBanner from './ApprovalBanner';
import CliTerminalPane from './CliTerminalPane';
import ChatPane from './ChatPane';
import ScreenshotViewer from '../ScreenshotViewer';
import InstallCommand from '../InstallCommand';
import { IconWarning, IconRocket } from '../Icons';

export interface PaneGroupProps {
    /** Conversations assigned to this group */
    conversations: ActiveConversation[];
    ides: DaemonData[];
    /** Shared state refs */
    messageReceivedAt: Record<string, number>;
    actionLogs: { ideId: string; text: string; timestamp: number }[];
    ptyBuffers: React.MutableRefObject<Map<string, string[]>>;
    screenshotMap: Record<string, string>;
    setScreenshotMap: (m: Record<string, string>) => void;
    /** Dashboard-level state setters */
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>;
    updateIdeChats: (ideId: string, chats: DaemonData['chats']) => void;
    setToasts: React.Dispatch<React.SetStateAction<any[]>>;
    setLocalUserMessages: React.Dispatch<React.SetStateAction<Record<string, any[]>>>;
    setClearedTabs: React.Dispatch<React.SetStateAction<Record<string, number>>>;
    setActionLogs: React.Dispatch<React.SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>;
    pinTab: (tabKey: string, delays: number[]) => void;
    isStandalone: boolean;
    userName?: string;
    /** Group identity */
    groupIndex: number;
    isFocused: boolean;
    onFocus: () => void;
    /** Split controls */
    isSplitMode: boolean;
    numGroups: number;
    onMoveTab?: (tabKey: string, direction: 'left' | 'right' | 'split-left' | 'split-right') => void;
    onClose?: () => void;
    /** Drag-to-split: called when a tab is dropped into this group */
    onReceiveTab?: (tabKey: string) => void;
    /** CSS style override (for flex-basis resizing) */
    style?: React.CSSProperties;
    /** Standalone empty state */
    detectedIdes?: { type: string; name: string; running: boolean; id?: string }[];
    handleLaunchIde?: (ideType: string) => void;
    /** Notify parent when active tab changes */
    onActiveTabChange?: (tabKey: string | null) => void;
    /** Restore previously selected tab on mount */
    initialActiveTabId?: string | null;
    /** Restore tab order on mount */
    initialTabOrder?: string[];
    /** Notify parent when tab order changes */
    onTabOrderChange?: (order: string[]) => void;
    /** Hide tab from dashboard */
    onHideTab?: (tabKey: string) => void;
}

export default function PaneGroup({
    conversations, ides,
    messageReceivedAt, actionLogs, ptyBuffers,
    screenshotMap, setScreenshotMap,
    sendDaemonCommand, updateIdeChats,
    setToasts, setLocalUserMessages, setClearedTabs, setActionLogs,
    pinTab, isStandalone, userName,
    groupIndex, isFocused: _isFocused, onFocus,
    isSplitMode, numGroups, onMoveTab, onClose: _onClose, onReceiveTab,
    style: styleProp,
    detectedIdes, handleLaunchIde,
    onActiveTabChange,
    initialActiveTabId,
    initialTabOrder,
    onTabOrderChange,
    onHideTab,
}: PaneGroupProps) {
    const { sendCommand } = useTransport();
    const terminalRef = useRef<CliTerminalHandle>(null);
    const [dragOver, setDragOver] = useState(false);
    const [dropAction, setDropAction] = useState<'split-left' | 'merge' | 'split-right' | null>(null);
    const dragCounter = useRef(0);
    const longPressTimer = useRef<any>(null);

    // Group-local active tab (restore from parent if provided)
    const [activeTabId, setActiveTabId] = useState<string | null>(initialActiveTabId ?? null);

    // Sync with parent when initialActiveTabId changes (e.g. URL deep-link from Machines page)
    useEffect(() => {
        if (initialActiveTabId && initialActiveTabId !== activeTabId) {
            setActiveTabId(initialActiveTabId);
        }
    }, [initialActiveTabId]);

    // ── Tab ordering (drag reorder within group) ──
    const [tabOrder, setTabOrder] = useState<string[]>(initialTabOrder ?? []);
    const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
    const previewOrderRef = useRef<string[] | null>(null);
    const draggingTabRef = useRef<string | null>(null);

    // Sync tabOrder with conversations: add new tabs, remove stale
    useEffect(() => {
        const currentKeys = new Set(conversations.map(c => c.tabKey));
        setTabOrder(prev => {
            const existing = prev.filter(k => currentKeys.has(k));
            const newKeys = conversations.filter(c => !prev.includes(c.tabKey)).map(c => c.tabKey);
            const merged = [...existing, ...newKeys];
            if (merged.length === prev.length && merged.every((k, i) => k === prev[i])) return prev;
            return merged;
        });
    }, [conversations]);

    // Sort conversations by tabOrder (or previewOrder during drag) for rendering
    const displayOrder = previewOrder ?? tabOrder;
    const sortedConversations = useMemo(() => {
        if (displayOrder.length === 0) return conversations;
        const orderMap = new Map(displayOrder.map((k, i) => [k, i]));
        return [...conversations].sort((a, b) => {
            const ia = orderMap.get(a.tabKey) ?? 999;
            const ib = orderMap.get(b.tabKey) ?? 999;
            return ia - ib;
        });
    }, [conversations, displayOrder]);

    // Auto-select first tab if current is invalid
    useEffect(() => {
        if (sortedConversations.length === 0) { setActiveTabId(null); onActiveTabChange?.(null); return; }
        if (activeTabId && sortedConversations.some(c => c.tabKey === activeTabId)) return;
        setActiveTabId(sortedConversations[0].tabKey);
        onActiveTabChange?.(sortedConversations[0].tabKey);
    }, [sortedConversations, activeTabId]);

    const activeConv = sortedConversations.find(c => c.tabKey === activeTabId);

    const handleTabReorder = useCallback((draggedKey: string, targetKey: string, side: 'left' | 'right') => {
        setTabOrder(prev => {
            const next = prev.filter(k => k !== draggedKey);
            const targetIdx = next.indexOf(targetKey);
            if (targetIdx < 0) return prev;
            const insertIdx = side === 'left' ? targetIdx : targetIdx + 1;
            next.splice(insertIdx, 0, draggedKey);
            onTabOrderChange?.(next);
            return next;
        });
        setPreviewOrder(null);
    }, [onTabOrderChange]);

    // Compute preview order without committing
    const updatePreviewOrder = useCallback((draggedKey: string, targetKey: string, side: 'left' | 'right') => {
        const base = tabOrder.length > 0 ? tabOrder : conversations.map(c => c.tabKey);
        const next = base.filter(k => k !== draggedKey);
        const targetIdx = next.indexOf(targetKey);
        if (targetIdx < 0) return;
        const insertIdx = side === 'left' ? targetIdx : targetIdx + 1;
        next.splice(insertIdx, 0, draggedKey);
        previewOrderRef.current = next;
        setPreviewOrder(next);
    }, [tabOrder, conversations]);

    // Command handlers for this group
    const cmds = useDashboardCommands({
        sendDaemonCommand,
        activeConv,
        ides,
        updateIdeChats,
        setToasts,
        setLocalUserMessages,
        setClearedTabs,
        setActionLogs,
        pinTab,
        isStandalone,
    });

    // Context menu
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabKey: string } | null>(null);
    useEffect(() => {
        if (!ctxMenu) return;
        const close = (e: MouseEvent) => {
            const menu = document.querySelector('[data-pane-context-menu]');
            if (menu && menu.contains(e.target as Node)) return;
            setCtxMenu(null);
        };
        window.addEventListener('mousedown', close, true);
        return () => window.removeEventListener('mousedown', close, true);
    }, [ctxMenu]);

    // ── Tab Shortcuts ──
    const SHORTCUTS_KEY = 'adhdev-tab-shortcuts';
    const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
    const [tabShortcuts, setTabShortcuts] = useState<Record<string, string>>(() => {
        try { return JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || '{}') } catch { return {} }
    });
    const [shortcutListening, setShortcutListening] = useState<string | null>(null); // tabKey being assigned

    // Encode a keyboard event into a shortcut string like "Ctrl+Shift+1" or "⌘+A"
    const encodeShortcut = useCallback((e: KeyboardEvent): string | null => {
        const parts: string[] = [];
        // On Mac: metaKey = ⌘, ctrlKey = Ctrl. On Win: ctrlKey = Ctrl.
        if (e.metaKey) parts.push(isMac ? '⌘' : 'Meta');
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push(isMac ? '⌥' : 'Alt');
        if (e.shiftKey) parts.push(isMac ? '⇧' : 'Shift');
        // Extract the actual key (not modifier)
        const key = e.key;
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null; // modifier only
        const displayKey = key.length === 1 ? key.toUpperCase() : key;
        parts.push(displayKey);
        return parts.join('+');
    }, [isMac]);

    // Check if a keyboard event matches a stored shortcut string
    const matchesShortcut = useCallback((e: KeyboardEvent, shortcut: string): boolean => {
        const encoded = encodeShortcut(e);
        return encoded === shortcut;
    }, [encodeShortcut]);

    // Save shortcuts to localStorage
    const saveShortcuts = useCallback((next: Record<string, string>) => {
        setTabShortcuts(next);
        localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(next));
    }, []);



    // Listen for key combo when assigning shortcut
    useEffect(() => {
        if (!shortcutListening) return;
        const handler = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { setShortcutListening(null); return; }
            const combo = encodeShortcut(e);
            if (!combo) return; // modifier-only press
            // Remove this combo from any other tab first
            const next = { ...tabShortcuts };
            for (const [k, v] of Object.entries(next)) {
                if (v === combo) delete next[k];
            }
            next[shortcutListening] = combo;
            saveShortcuts(next);
            setShortcutListening(null);
        };
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
    }, [shortcutListening, tabShortcuts, saveShortcuts, encodeShortcut]);

    // Listen for shortcut combos to switch tabs
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            // Only check when at least one modifier is held
            if (!e.ctrlKey && !e.metaKey && !e.altKey) return;
            for (const [tabKey, shortcut] of Object.entries(tabShortcuts)) {
                if (matchesShortcut(e, shortcut) && sortedConversations.some(c => c.tabKey === tabKey)) {
                    e.preventDefault();
                    onFocus();
                    setActiveTabId(tabKey);
                    onActiveTabChange?.(tabKey);
                    return;
                }
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [tabShortcuts, sortedConversations, onFocus, onActiveTabChange, matchesShortcut]);

    const isCli = activeConv && isCliConv(activeConv) && !isAcpConv(activeConv);
    const activeViewMode = isCli ? 'terminal' : 'chat';

    // Force-clear dragOver on ANY drag end (global listener)
    // This prevents stuck outlines when drag ends outside this group
    // NOTE: Do NOT clear previewOrder here — the tab's onDragEnd handler
    // needs to read it to commit the reorder. It clears it after committing.
    useEffect(() => {
        const handleDragEnd = () => {
            dragCounter.current = 0;
            setDragOver(false);
            setDropAction(null);
        };
        window.addEventListener('dragend', handleDragEnd);
        window.addEventListener('drop', handleDragEnd);
        return () => {
            window.removeEventListener('dragend', handleDragEnd);
            window.removeEventListener('drop', handleDragEnd);
        };
    }, []);

    // Tab bar horizontal wheel scroll (must be non-passive to allow preventDefault)
    const tabBarRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = tabBarRef.current;
        if (!el) return;
        const handler = (e: WheelEvent) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                e.preventDefault();
                el.scrollLeft += e.deltaY;
            }
        };
        el.addEventListener('wheel', handler, { passive: false });
        return () => el.removeEventListener('wheel', handler);
    }, []);

    return (
        <div
            className="flex flex-col min-h-0 min-w-0 flex-1 overflow-hidden"
            onClick={onFocus}
            style={{
                ...styleProp,
                outline: dragOver ? '2px dashed var(--accent-primary)' : 'none',
                outlineOffset: '-2px',
                transition: 'outline 0.15s ease',
            }}
        >
            {/* ── Tab Bar ────────────────────────── */}
            <div className="flex items-center bg-bg-secondary border-b border-border-subtle shrink-0 gap-0">
                <div
                    ref={tabBarRef}
                    className="flex-1 flex overflow-x-auto overflow-y-visible pt-1.5 pb-0 gap-1 select-none"
                    style={{ paddingLeft: 8, paddingRight: 4, scrollbarWidth: 'none' }}
                >
                    {sortedConversations.map((conv, _idx) => {
                        const isActive = activeTabId === conv.tabKey;
                        const tabClass = conv.status === 'generating' ? 'agent-tab-generating'
                            : conv.status === 'waiting_approval' ? 'agent-tab-waiting' : '';
                        const isReconnecting = conv.connectionState === 'failed' || conv.connectionState === 'closed';
                        const isDraggedTab = draggingTabRef.current === conv.tabKey;
                        return (
                            <div
                                key={conv.tabKey}
                                data-tabkey={conv.tabKey}
                                className={`${tabClass} shrink-0 px-2.5 py-1.5 rounded-t-lg cursor-pointer flex items-center gap-2 relative`}
                                draggable={true}
                                onDragStart={(e) => {
                                    draggingTabRef.current = conv.tabKey;
                                    e.dataTransfer.setData('text/tab-key', conv.tabKey);
                                    e.dataTransfer.effectAllowed = 'move';
                                }}
                                onDragEnd={() => {
                                    draggingTabRef.current = null;
                                    // Commit preview order as actual tab order on drop
                                    const orderToCommit = previewOrderRef.current;
                                    if (orderToCommit) {
                                        setTabOrder(orderToCommit);
                                        onTabOrderChange?.(orderToCommit);
                                    }
                                    previewOrderRef.current = null;
                                    setPreviewOrder(null);
                                    dragCounter.current = 0;
                                    setDragOver(false);
                                }}
                                onDragOver={(e) => {
                                    const draggedKey = draggingTabRef.current;
                                    if (!draggedKey || draggedKey === conv.tabKey) return;
                                    if (e.dataTransfer.types.includes('text/tab-key')) {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        const midX = rect.left + rect.width / 2;
                                        const side = e.clientX < midX ? 'left' : 'right';
                                        updatePreviewOrder(draggedKey, conv.tabKey, side);
                                    }
                                }}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const draggedKey = e.dataTransfer.getData('text/tab-key');
                                    if (draggedKey && draggedKey !== conv.tabKey) {
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        const midX = rect.left + rect.width / 2;
                                        const side = e.clientX < midX ? 'left' : 'right';
                                        if (sortedConversations.some(c => c.tabKey === draggedKey)) {
                                            handleTabReorder(draggedKey, conv.tabKey, side);
                                        } else if (onReceiveTab) {
                                            onReceiveTab(draggedKey);
                                        }
                                    }
                                    setPreviewOrder(null);
                                }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onFocus();
                                    setActiveTabId(conv.tabKey);
                                    onActiveTabChange?.(conv.tabKey);
                                    if (conv.streamSource === 'agent-stream' && conv.agentType) {
                                        sendCommand(conv.ideId, 'agent_stream_focus', { agentType: conv.agentType }).catch(() => {});
                                    }
                                    if (isCliConv(conv)) {
                                        setTimeout(() => terminalRef.current?.bumpResize?.(), 100);
                                    }
                                }}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    setCtxMenu({ x: e.clientX, y: e.clientY, tabKey: conv.tabKey });
                                }}
                                onTouchStart={(e) => {
                                    const touch = e.touches[0];
                                    const clientX = touch.clientX;
                                    const clientY = touch.clientY;
                                    longPressTimer.current = setTimeout(() => {
                                        setCtxMenu({ x: clientX, y: clientY, tabKey: conv.tabKey });
                                    }, 600);
                                }}
                                onTouchEnd={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current) }}
                                onTouchMove={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current) }}
                                style={{
                                    background: isActive ? 'var(--bg-primary)' : 'var(--bg-glass)',
                                    borderTop: isActive ? '1px solid var(--border-subtle)' : '1px solid transparent',
                                    borderLeft: isActive ? '1px solid var(--border-subtle)' : '1px solid transparent',
                                    borderRight: isActive ? '1px solid var(--border-subtle)' : '1px solid transparent',
                                    opacity: isDraggedTab ? 0.4 : isReconnecting ? (isActive ? 0.6 : 0.3) : (isActive ? 1 : 0.65),
                                    transition: 'transform 0.2s ease, opacity 0.15s ease',
                                }}
                            >
                                {/* Status dot */}
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
                        );
                    })}
                    {conversations.length === 0 && (
                        <div className="p-2 text-xs opacity-40">No tabs in this group</div>
                    )}
                </div>
            </div>

            {/* ── Content Area ────────────────────── */}
            <div
                className="flex-1 min-h-0 flex flex-col overflow-hidden relative"
                onDragEnter={(e) => {
                    if (e.dataTransfer.types.includes('text/tab-key')) {
                        dragCounter.current++;
                        setDragOver(true);
                    }
                }}
                onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes('text/tab-key')) return;
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const localX = e.clientX - rect.left;
                    if (numGroups < 4 && onMoveTab) {
                        const third = rect.width / 3;
                        if (localX < third) setDropAction('split-left');
                        else if (localX > third * 2) setDropAction('split-right');
                        else setDropAction('merge');
                        return;
                    }
                    setDropAction('merge');
                }}
                onDragLeave={() => {
                    dragCounter.current--;
                    if (dragCounter.current <= 0) {
                        dragCounter.current = 0;
                        setDragOver(false);
                        setDropAction(null);
                    }
                }}
                onDrop={(e) => {
                    dragCounter.current = 0;
                    setDragOver(false);
                    const tabKey = e.dataTransfer.getData('text/tab-key');
                    const isOwnTab = tabKey ? conversations.some(c => c.tabKey === tabKey) : false;
                    const nextDropAction = dropAction;
                    setDropAction(null);
                    setPreviewOrder(null);
                    if (!tabKey) return;
                    e.preventDefault();
                    if (nextDropAction === 'split-left' && onMoveTab && numGroups < 4) {
                        onMoveTab(tabKey, 'split-left');
                        return;
                    }
                    if (nextDropAction === 'split-right' && onMoveTab && numGroups < 4) {
                        onMoveTab(tabKey, 'split-right');
                        return;
                    }
                    if (isOwnTab) {
                        setTabOrder(prev => {
                            const next = prev.filter(k => k !== tabKey);
                            next.push(tabKey);
                            onTabOrderChange?.(next);
                            return next;
                        });
                    } else if (onReceiveTab) {
                        onReceiveTab(tabKey);
                    }
                }}
            >
                {dragOver && (
                    <div className="absolute inset-0 z-10 pointer-events-none flex">
                        <div
                            className="flex-1 border-r border-white/10 transition-all duration-150 flex items-center justify-center"
                            style={{
                                background: dropAction === 'split-left' ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)',
                                boxShadow: dropAction === 'split-left' ? 'inset 0 0 0 2px var(--accent-primary)' : 'inset 0 0 0 1px rgba(255,255,255,0.05)',
                                opacity: numGroups < 4 && onMoveTab ? 1 : 0.45,
                            }}
                        >
                            <div className="px-3 py-1.5 rounded-full text-[11px] font-semibold text-white bg-black/45 backdrop-blur-sm">
                                Split Left
                            </div>
                        </div>
                        <div
                            className="flex-1 border-r border-white/10 transition-all duration-150 flex items-center justify-center"
                            style={{
                                background: dropAction === 'merge' ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)',
                                boxShadow: dropAction === 'merge' ? 'inset 0 0 0 2px var(--accent-primary)' : 'inset 0 0 0 1px rgba(255,255,255,0.05)',
                            }}
                        >
                            <div className="px-3 py-1.5 rounded-full text-[11px] font-semibold text-white bg-black/45 backdrop-blur-sm">
                                Move Here
                            </div>
                        </div>
                        <div
                            className="flex-1 transition-all duration-150 flex items-center justify-center"
                            style={{
                                background: dropAction === 'split-right' ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)',
                                boxShadow: dropAction === 'split-right' ? 'inset 0 0 0 2px var(--accent-primary)' : 'inset 0 0 0 1px rgba(255,255,255,0.05)',
                                opacity: numGroups < 4 && onMoveTab ? 1 : 0.45,
                            }}
                        >
                            <div className="px-3 py-1.5 rounded-full text-[11px] font-semibold text-white bg-black/45 backdrop-blur-sm">
                                Split Right
                            </div>
                        </div>
                    </div>
                )}
                {!activeConv ? (
                    <div className="flex-1 flex flex-col items-center justify-center">
                        {conversations.length === 0 && !isSplitMode && detectedIdes && handleLaunchIde ? (
                            <div className="empty-dashboard flex-1 flex flex-col items-center justify-center -mt-8">
                                <div className="glow-orb mb-6 opacity-90 animate-bounce" style={{ animationDuration: '3s' }}>
                                    <img src="/otter-logo.png" alt="ADHDev" className="w-16 h-16 object-contain" />
                                </div>
                                <div className="text-center max-w-lg">
                                    <h2 className="font-bold text-2xl mb-2.5 tracking-tight text-text-primary">
                                        Waiting for your IDE
                                    </h2>
                                    <p className="text-[14px] text-text-secondary mb-8 leading-relaxed max-w-md mx-auto">
                                        {isStandalone
                                            ? 'Launch any supported IDE or CLI agent to start monitoring automatically.'
                                            : 'Install the ADHDev daemon and link your dashboard to start.'}
                                    </p>
                                    {!isStandalone && (
                                        <InstallCommand />
                                    )}
                                    {isStandalone && detectedIdes && detectedIdes.length > 0 && (
                                        <div className="flex flex-col gap-3 items-center">
                                            <div className="text-xs font-semibold uppercase tracking-wider text-text-muted">Fast Launch</div>
                                            <div className="flex flex-wrap gap-2.5 justify-center mt-1">
                                                {detectedIdes.map(d => (
                                                    <button
                                                        key={d.type}
                                                        className="btn btn-sm bg-accent/10 border border-accent/25 text-accent text-xs font-medium px-4 py-2.5 rounded-lg cursor-pointer flex items-center gap-2 transition-all hover:bg-accent/20 hover:scale-105 active:scale-95"
                                                        onClick={() => handleLaunchIde && handleLaunchIde(d.type)}
                                                    >
                                                        <IconRocket size={14} className="opacity-70" /> Launch {d.name}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {!isStandalone && (
                                        <div className="mt-8">
                                            <a href="https://docs.adhf.dev" target="_blank" rel="noopener noreferrer"
                                               className="text-sm font-medium text-accent hover:opacity-80 transition-colors flex items-center justify-center gap-1.5">
                                                📚 Read the documentation →
                                            </a>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className="text-sm text-text-muted opacity-50">
                                {isSplitMode ? 'Move a tab here to view' : 'No active agent'}
                            </div>
                        )}
                    </div>
                ) : (
                    <>
                        <ApprovalBanner activeConv={activeConv} onModalButton={cmds.handleModalButton} />

                        <div className="desktop-only px-3 pt-1 pb-2">
                            {!isCli && !isAcpConv(activeConv) && screenshotMap[activeConv.ideId] ? (
                                <ScreenshotViewer
                                    screenshotUrl={screenshotMap[activeConv.ideId]}
                                    mode="preview"
                                    onDismiss={() => {
                                        const newMap = { ...screenshotMap };
                                        delete newMap[activeConv.ideId];
                                        setScreenshotMap(newMap);
                                    }}
                                />
                            ) : (!isCli && !isAcpConv(activeConv) && activeConv.cdpConnected === false) ? (
                                <div className="flex items-center gap-2.5 px-3.5 py-2 bg-yellow-500/[0.08] border border-yellow-500/20 rounded-lg text-xs text-text-secondary">
                                    <span className="text-sm"><IconWarning size={14} /></span>
                                    <span className="flex-1">CDP not connected — chat history & screenshots unavailable.</span>
                                    <button
                                        className="btn btn-sm bg-yellow-500/15 text-yellow-500 border border-yellow-500/30 text-[10px] whitespace-nowrap shrink-0"
                                        onClick={cmds.handleRelaunch}
                                    >Relaunch with CDP</button>
                                </div>
                            ) : null}
                        </div>

                        {activeViewMode === 'terminal' ? (
                            <CliTerminalPane
                                activeConv={activeConv}
                                ptyBuffers={ptyBuffers}
                                terminalRef={terminalRef}
                                agentInput={cmds.agentInput}
                                setAgentInput={cmds.setAgentInput}
                                handleSendChat={cmds.handleSendChat}
                            />
                        ) : (
                            <ChatPane
                                activeConv={activeConv}
                                ides={ides}
                                agentInput={cmds.agentInput}
                                setAgentInput={cmds.setAgentInput}
                                handleSendChat={cmds.handleSendChat}
                                handleFocusAgent={cmds.handleFocusAgent}
                                isFocusingAgent={cmds.isFocusingAgent}
                                messageReceivedAt={messageReceivedAt}
                                actionLogs={actionLogs}
                                userName={userName}
                            />
                        )}
                    </>
                )}
            </div>

            {/* Context Menu */}
            {ctxMenu && (
                <div
                    data-pane-context-menu
                    className="fixed z-50 bg-bg-primary border border-border-subtle rounded-lg shadow-lg py-1 min-w-[160px]"
                    style={{ left: ctxMenu.x, top: ctxMenu.y }}
                >
                    {onMoveTab && groupIndex > 0 && (
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors "
                            onClick={() => { onMoveTab(ctxMenu.tabKey, 'left'); setCtxMenu(null); }}
                        >
                            ← Move to Left Group
                        </button>
                    )}
                    {onMoveTab && groupIndex < numGroups - 1 && (
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors "
                            onClick={() => { onMoveTab(ctxMenu.tabKey, 'right'); setCtxMenu(null); }}
                        >
                            Move to Right Group →
                        </button>
                    )}
                    {onMoveTab && numGroups < 4 && (
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors "
                            onClick={() => { onMoveTab(ctxMenu.tabKey, 'split-left'); setCtxMenu(null); }}
                        >
                            ⇤ Split Left
                        </button>
                    )}
                    {onMoveTab && numGroups < 4 && (
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors "
                            onClick={() => { onMoveTab(ctxMenu.tabKey, 'split-right'); setCtxMenu(null); }}
                        >
                            Split Right ⇥
                        </button>
                    )}
                    <div className="border-t border-border-subtle my-1 " />
                    <button
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors "
                        onClick={(e) => {
                            e.stopPropagation();
                            setShortcutListening(ctxMenu.tabKey);
                            setCtxMenu(null);
                        }}
                    >
                        ⌨ {tabShortcuts[ctxMenu.tabKey] ? `Change shortcut (${tabShortcuts[ctxMenu.tabKey]})` : 'Set shortcut'}
                    </button>
                    {tabShortcuts[ctxMenu.tabKey] && (
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors text-text-muted "
                            onClick={() => {
                                const next = { ...tabShortcuts };
                                delete next[ctxMenu.tabKey];
                                saveShortcuts(next);
                                setCtxMenu(null);
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
                                onClick={() => { onHideTab(ctxMenu.tabKey); setCtxMenu(null); }}
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

            {/* Shortcut key assignment overlay */}
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
        </div>
    );
}
