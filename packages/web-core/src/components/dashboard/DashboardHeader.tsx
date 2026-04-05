/**
 * DashboardHeader — Top header bar for Dashboard
 *
 * Shows title, agent count, connection status indicator, and action buttons.
 * Connection state is abstract — injected by platform (cloud=P2P, standalone=local).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActiveConversation, CliConversationViewMode } from './types';
import { isCliConv, isCliTerminalConv, isAcpConv } from './types';
import { IconBell, IconChat, IconScroll, IconMonitor, IconEyeOff, IconX } from '../Icons';
import { useDaemons } from '../../compat';
import { buildLiveSessionInboxStateMap, getConversationInboxSurfaceState, isHiddenNativeIdeParentConversation } from './DashboardMobileChatShared';
import CliViewModeToggle from './CliViewModeToggle';

export interface DashboardHeaderProps {
    activeConv: ActiveConversation | undefined;
    agentCount: number;
    wsStatus: string;
    /** Overall connection readiness (green=ready, yellow=partial, red=disconnected) */
    isConnected: boolean;
    conversations: ActiveConversation[];
    onOpenHistory: (conversation?: ActiveConversation) => void;
    onOpenRemote?: () => void;
    onStopCli?: () => void;
    activeCliViewMode?: CliConversationViewMode | null;
    onSetCliViewMode?: (mode: CliConversationViewMode) => void;
    onOpenConversation?: (conversation: ActiveConversation) => void;
    onHideConversation?: (conversation: ActiveConversation) => void;
    hiddenConversations?: ActiveConversation[];
    onShowConversation?: (conversation: ActiveConversation) => void;
    onShowAllHidden?: () => void;
    onClearDevHistory?: () => void;
}

function DashboardHeaderInboxItem({
    conversation,
    isAttention,
    onClick,
}: {
    conversation: ActiveConversation;
    isAttention?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            className={`dashboard-header-inbox-item ${isAttention ? 'is-attention' : ''}`.trim()}
            onClick={onClick}
        >
            <span className="dashboard-header-inbox-item-title">{conversation.displayPrimary}</span>
            <span className="dashboard-header-inbox-item-meta">{conversation.displaySecondary}</span>
        </button>
    );
}

export default function DashboardHeader({
    activeConv,
    agentCount,
    wsStatus,
    isConnected,
    conversations,
    onOpenHistory,
    onOpenRemote,
    onStopCli,
    activeCliViewMode,
    onSetCliViewMode,
    onOpenConversation,
    onHideConversation,
    hiddenConversations = [],
    onShowConversation,
    onShowAllHidden,
}: DashboardHeaderProps) {
    const daemonCtx = useDaemons() as any;
    const p2pStates: Record<string, string> = daemonCtx.p2pStates || {};
    const ides = daemonCtx.ides || [];
    const isCliActive = !!activeConv && isCliConv(activeConv) && !isAcpConv(activeConv);
    const effectiveCliViewMode = activeCliViewMode || (activeConv ? (isCliTerminalConv(activeConv) ? 'terminal' : 'chat') : null);
    const [inboxOpen, setInboxOpen] = useState(false);
    const [hiddenOpen, setHiddenOpen] = useState(false);
    const [isHiddenDropTarget, setIsHiddenDropTarget] = useState(false);
    const inboxRef = useRef<HTMLDivElement | null>(null);
    const hiddenRef = useRef<HTMLDivElement | null>(null);

    const dotColor = isConnected ? '#22c55e' : wsStatus === 'connected' ? '#eab308' : '#ef4444';
    const dotGlow = isConnected ? '0 0 4px #22c55e80' : wsStatus === 'connected' ? '0 0 4px #eab30880' : '0 0 4px #ef444480';

    // Derive connection stage summary
    const daemons = ides.filter((i: any) => i.type === 'adhdev-daemon');
    const liveSessionInboxState = useMemo(
        () => buildLiveSessionInboxStateMap(ides),
        [ides],
    );
    const p2pValues = Object.values(p2pStates) as string[];
    const p2pConnected = p2pValues.filter(s => s === 'connected').length;
    const p2pConnecting = p2pValues.filter(s => s === 'connecting' || s === 'new' || s === 'checking').length;

    // Build compact status string
    const getStatusText = () => {
        if (wsStatus !== 'connected') return null;
        if (daemons.length === 0) return null;
        if (p2pConnecting > 0 && p2pConnected === 0) return 'P2P connecting...';
        if (p2pConnected > 0 && agentCount === 0) return 'Waiting for IDE...';
        return null;
    };
    const statusText = getStatusText();
    const desktopInboxConversations = useMemo(
        () => conversations.filter(conversation => !isHiddenNativeIdeParentConversation(conversation, conversations, liveSessionInboxState)),
        [conversations, liveSessionInboxState],
    );
    const inboxAttention = useMemo(
        () => desktopInboxConversations.filter(conversation => getConversationInboxSurfaceState(conversation, liveSessionInboxState).requiresAction),
        [desktopInboxConversations, liveSessionInboxState],
    );
    const inboxUnread = useMemo(
        () => desktopInboxConversations.filter(conversation => {
            const isOpenConversation = activeConv?.tabKey === conversation.tabKey;
            return getConversationInboxSurfaceState(conversation, liveSessionInboxState, {
                hideOpenTaskCompleteUnread: true,
                isOpenConversation,
            }).unread;
        }),
        [activeConv, desktopInboxConversations, liveSessionInboxState],
    );
    const inboxCount = inboxAttention.length + inboxUnread.length;

    useEffect(() => {
        if (!inboxOpen) return;
        const onPointerDown = (event: MouseEvent) => {
            if (!inboxRef.current?.contains(event.target as Node)) setInboxOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [inboxOpen]);

    useEffect(() => {
        if (!hiddenOpen) return;
        const onPointerDown = (event: MouseEvent) => {
            if (!hiddenRef.current?.contains(event.target as Node)) setHiddenOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [hiddenOpen]);

    const handleHideDrop = (tabKey: string | null | undefined) => {
        if (!tabKey) return
        const conversation = conversations.find(item => item.tabKey === tabKey)
        if (!conversation) return
        onHideConversation?.(conversation)
    }

    return (
        <div className="dashboard-header">
            <div className="flex items-center gap-3">
                <div className="header-title-block">
                    <div className="header-title-row">
                        <h1 className="header-title m-0 flex items-center gap-1.5">
                        <IconChat size={18} />
                        {/* Mobile: show active tab title; Desktop: "Dashboard" */}
                        <span className="header-title-desktop">Dashboard</span>
                        <span className="header-title-mobile">
                            {activeConv?.displayPrimary || 'Dashboard'}
                        </span>
                        <span className="header-count-mobile text-[10px] font-semibold opacity-60 ml-2 tracking-wide">
                            <span
                                className="inline-block w-[6px] h-[6px] rounded-full align-middle"
                                style={{ background: dotColor, boxShadow: dotGlow }}
                            />
                        </span>
                        </h1>
                        <div className="header-subtitle">
                            <span className="header-subtitle-copy">
                                {agentCount} agent{agentCount !== 1 ? 's' : ''} active
                            </span>
                            <span
                                title={isConnected ? 'Connected' : wsStatus === 'connected' ? 'Partial' : 'Disconnected'}
                                className="header-subtitle-dot inline-block w-1.5 h-1.5 rounded-full shrink-0"
                                style={{ background: dotColor, boxShadow: dotGlow }}
                            />
                            {statusText && (
                                <span className="header-subtitle-status">
                                    · {statusText}
                                </span>
                            )}
                        </div>
                    </div>
                </div>
            </div>
            <div className="flex gap-2 items-center">
                {activeConv && (isCliActive || !isAcpConv(activeConv)) && (
                    <div className="dashboard-header-actions-group">
                        <span
                            className="dashboard-header-action-target"
                            title={activeConv.displaySecondary || activeConv.displayPrimary}
                        >
                            {activeConv.displayPrimary}
                        </span>

                        {isCliActive && onStopCli && (
                            <>
                                {onSetCliViewMode && effectiveCliViewMode && (
                                    <CliViewModeToggle mode={effectiveCliViewMode} onChange={onSetCliViewMode} compact />
                                )}
                                <button
                                    onClick={onStopCli}
                                    className="btn btn-secondary btn-sm"
                                    title="Stop CLI process"
                                    style={{
                                        color: 'var(--status-error, #ef4444)',
                                        borderColor: 'color-mix(in srgb, var(--status-error, #ef4444) 25%, transparent)',
                                    }}
                                >
                                    <IconX size={14} />
                                </button>
                            </>
                        )}

                        {!isAcpConv(activeConv) && (
                            <button
                                onClick={() => onOpenHistory(activeConv)}
                                className="btn btn-secondary btn-sm"
                                title="Chat History"
                            >
                                <IconScroll size={14} />
                            </button>
                        )}
                        {!isCliActive && !isAcpConv(activeConv) && (
                            <button
                                onClick={onOpenRemote}
                                className="btn btn-secondary btn-sm"
                                title="Remote Control"
                            >
                                <IconMonitor size={14} />
                            </button>
                        )}
                    </div>
                )}
                <div className="dashboard-header-inbox" ref={inboxRef}>
                    <div
                        className={`dashboard-header-hidden${isHiddenDropTarget ? ' is-drop-target' : ''}`}
                        ref={hiddenRef}
                        onDragEnter={event => {
                            if (!event.dataTransfer.types.includes('text/tab-key')) return
                            event.preventDefault()
                            setIsHiddenDropTarget(true)
                        }}
                        onDragOver={event => {
                            if (!event.dataTransfer.types.includes('text/tab-key')) return
                            event.preventDefault()
                            event.dataTransfer.dropEffect = 'move'
                            setIsHiddenDropTarget(true)
                        }}
                        onDragLeave={event => {
                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                setIsHiddenDropTarget(false)
                            }
                        }}
                        onDrop={event => {
                            const tabKey = event.dataTransfer.getData('text/tab-key')
                            event.preventDefault()
                            setIsHiddenDropTarget(false)
                            handleHideDrop(tabKey)
                        }}
                    >
                        <button
                            type="button"
                            onClick={() => setHiddenOpen(open => !open)}
                            className="btn btn-secondary btn-sm dashboard-header-hidden-button"
                            title="Hidden tabs. Drag a tab here to hide it."
                        >
                            <IconEyeOff size={16} />
                            {hiddenConversations.length > 0 && <span className="dashboard-header-hidden-badge">{hiddenConversations.length}</span>}
                        </button>
                        {hiddenOpen && (
                            <div className="dashboard-header-hidden-popover">
                                <div className="dashboard-header-hidden-topbar">
                                    <div className="dashboard-header-inbox-section-title mb-0">Hidden tabs</div>
                                    {hiddenConversations.length > 0 && onShowAllHidden && (
                                        <button
                                            type="button"
                                            className="dashboard-header-hidden-restore-all"
                                            onClick={() => {
                                                onShowAllHidden();
                                                setHiddenOpen(false);
                                            }}
                                        >
                                            Restore all
                                        </button>
                                    )}
                                </div>
                                {activeConv && onHideConversation && (
                                    <button
                                        type="button"
                                        className="dashboard-header-hidden-current"
                                        onClick={() => onHideConversation(activeConv)}
                                    >
                                        <span className="dashboard-header-hidden-current-label">Hide current tab</span>
                                        <span className="dashboard-header-hidden-current-title">{activeConv.displayPrimary}</span>
                                    </button>
                                )}
                                {hiddenConversations.length > 0 ? (
                                    <div className="dashboard-header-hidden-list">
                                        {hiddenConversations.map(conversation => (
                                            <button
                                                key={conversation.tabKey}
                                                type="button"
                                                className="dashboard-header-inbox-item"
                                                onClick={() => {
                                                    onShowConversation?.(conversation);
                                                    setHiddenOpen(false);
                                                }}
                                            >
                                                <span className="dashboard-header-inbox-item-title">{conversation.displayPrimary}</span>
                                                <span className="dashboard-header-inbox-item-meta">{conversation.displaySecondary}</span>
                                            </button>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="dashboard-header-inbox-empty">No hidden tabs.</div>
                                )}
                            </div>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={() => setInboxOpen(open => !open)}
                        className="btn btn-secondary btn-sm dashboard-header-inbox-button"
                        title="Activity inbox"
                    >
                        <IconBell size={16} />
                        {inboxCount > 0 && <span className="dashboard-header-inbox-badge">{inboxCount}</span>}
                    </button>
                    {inboxOpen && (
                        <div className="dashboard-header-inbox-popover">
                            {inboxAttention.length > 0 && (
                                <div className="dashboard-header-inbox-section">
                                    <div className="dashboard-header-inbox-section-title">Needs attention</div>
                                    {inboxAttention.map(conversation => (
                                        <DashboardHeaderInboxItem
                                            key={conversation.tabKey}
                                            conversation={conversation}
                                            isAttention={true}
                                            onClick={() => {
                                                onOpenConversation?.(conversation);
                                                setInboxOpen(false);
                                            }}
                                        />
                                    ))}
                                </div>
                            )}
                            {inboxUnread.length > 0 && (
                                <div className="dashboard-header-inbox-section">
                                    <div className="dashboard-header-inbox-section-title">Task complete</div>
                                    {inboxUnread.map(conversation => (
                                        <DashboardHeaderInboxItem
                                            key={conversation.tabKey}
                                            conversation={conversation}
                                            onClick={() => {
                                                onOpenConversation?.(conversation);
                                                setInboxOpen(false);
                                            }}
                                        />
                                    ))}
                                </div>
                            )}
                            {inboxCount === 0 && (
                                <div className="dashboard-header-inbox-empty">No pending activity.</div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
