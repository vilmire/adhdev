/**
 * DashboardHeader — Top header bar for Dashboard
 *
 * Shows title, agent count, connection status indicator, and action buttons.
 * Connection state is abstract — injected by platform (cloud=P2P, standalone=local).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActiveConversation, CliConversationViewMode } from './types';
import { isCliConv, isCliTerminalConv, isAcpConv } from './types';
import { IconBell, IconChat, IconScroll, IconMonitor, IconTerminal } from '../Icons';
import { useDaemons } from '../../compat';
import { buildLiveSessionInboxStateMap, getConversationLiveInboxState, isHiddenNativeIdeParentConversation } from './DashboardMobileChatShared';

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
    onFitCli?: () => void;
    activeCliViewMode?: CliConversationViewMode | null;
    onToggleCliViewMode?: () => void;
    onOpenConversation?: (conversation: ActiveConversation) => void;
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
    onFitCli,
    activeCliViewMode,
    onToggleCliViewMode,
    onOpenConversation,
}: DashboardHeaderProps) {
    const daemonCtx = useDaemons() as any;
    const p2pStates: Record<string, string> = daemonCtx.p2pStates || {};
    const ides = daemonCtx.ides || [];
    const isCliActive = !!activeConv && isCliConv(activeConv) && !isAcpConv(activeConv);
    const effectiveCliViewMode = activeCliViewMode || (activeConv ? (isCliTerminalConv(activeConv) ? 'terminal' : 'chat') : null);
    const isCliTerminalActive = !!activeConv && isCliActive && effectiveCliViewMode === 'terminal';
    const [inboxOpen, setInboxOpen] = useState(false);
    const inboxRef = useRef<HTMLDivElement | null>(null);

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
        () => desktopInboxConversations.filter(conversation => getConversationLiveInboxState(conversation, liveSessionInboxState).inboxBucket === 'needs_attention'),
        [desktopInboxConversations, liveSessionInboxState],
    );
    const inboxUnread = useMemo(
        () => desktopInboxConversations.filter(conversation => {
            const liveState = getConversationLiveInboxState(conversation, liveSessionInboxState);
            const isOpenConversation = activeConv?.tabKey === conversation.tabKey;
            return liveState.inboxBucket === 'task_complete' && liveState.unread && !isOpenConversation;
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
                <div className="dashboard-header-inbox" ref={inboxRef}>
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
                                        <button
                                            key={conversation.tabKey}
                                            type="button"
                                            className="dashboard-header-inbox-item is-attention"
                                            onClick={() => {
                                                onOpenConversation?.(conversation);
                                                setInboxOpen(false);
                                            }}
                                        >
                                            <span className="dashboard-header-inbox-item-title">{conversation.displayPrimary}</span>
                                            <span className="dashboard-header-inbox-item-meta">{conversation.displaySecondary}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                            {inboxUnread.length > 0 && (
                                <div className="dashboard-header-inbox-section">
                                    <div className="dashboard-header-inbox-section-title">Task complete</div>
                                    {inboxUnread.map(conversation => (
                                        <button
                                            key={conversation.tabKey}
                                            type="button"
                                            className="dashboard-header-inbox-item"
                                            onClick={() => {
                                                onOpenConversation?.(conversation);
                                                setInboxOpen(false);
                                            }}
                                        >
                                            <span className="dashboard-header-inbox-item-title">{conversation.displayPrimary}</span>
                                            <span className="dashboard-header-inbox-item-meta">{conversation.displaySecondary}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                            {inboxCount === 0 && (
                                <div className="dashboard-header-inbox-empty">No pending activity.</div>
                            )}
                        </div>
                    )}
                </div>
                {isCliActive && onStopCli && (
                    <>
                        {onToggleCliViewMode && (
                            <button
                                onClick={onToggleCliViewMode}
                                className="btn btn-secondary btn-sm"
                                title={isCliTerminalActive ? 'Switch to parsed chat view' : 'Switch to terminal view'}
                            >
                                {isCliTerminalActive ? <IconChat size={16} /> : <IconTerminal size={16} />}
                            </button>
                        )}
                        {isCliTerminalActive && (
                            <button
                                onClick={onFitCli}
                                className="btn btn-secondary btn-sm"
                                title="Fit terminal to current view"
                            >
                                Fit
                            </button>
                        )}
                        <button
                            onClick={onStopCli}
                            className="btn btn-secondary btn-sm text-red-400 border-red-500/25 hover:bg-red-500/10"
                            title="Stop CLI process"
                        >
                            Stop
                        </button>
                    </>
                )}

                {activeConv && !isCliTerminalActive && !isAcpConv(activeConv) && (
                    <button
                        onClick={() => onOpenHistory(activeConv)}
                        className="btn btn-secondary btn-sm"
                        title="Chat History"
                    >
                        <IconScroll size={16} />
                    </button>
                )}
                {activeConv && !isCliActive && !isAcpConv(activeConv) && (
                    <button
                        onClick={onOpenRemote}
                        className="btn btn-secondary btn-sm"
                        title="Remote Control"
                    >
                        <IconMonitor size={16} />
                    </button>
                )}
            </div>
        </div>
    );
}
