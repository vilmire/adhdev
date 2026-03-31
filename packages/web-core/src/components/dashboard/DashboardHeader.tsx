/**
 * DashboardHeader — Top header bar for Dashboard
 *
 * Shows title, agent count, connection status indicator, and action buttons.
 * Connection state is abstract — injected by platform (cloud=P2P, standalone=local).
 */

import { useNavigate } from 'react-router-dom';
import type { ActiveConversation } from './types';
import { isCliConv, isAcpConv } from './types';
import { IconChat, IconScroll, IconMonitor, IconTerminal } from '../Icons';
import { useDaemons } from '../../compat';

export interface DashboardHeaderProps {
    activeConv: ActiveConversation | undefined;
    agentCount: number;
    wsStatus: string;
    /** Overall connection readiness (green=ready, yellow=partial, red=disconnected) */
    isConnected: boolean;
    onOpenHistory: () => void;
    onStopCli?: () => void;
}

export default function DashboardHeader({
    activeConv,
    agentCount,
    wsStatus,
    isConnected,
    onOpenHistory,
    onStopCli,
}: DashboardHeaderProps) {
    const navigate = useNavigate();
    const daemonCtx = useDaemons() as any;
    const p2pStates: Record<string, string> = daemonCtx.p2pStates || {};
    const ides = daemonCtx.ides || [];
    const isCliActive = !!activeConv && isCliConv(activeConv) && !isAcpConv(activeConv);

    const dotColor = isConnected ? '#22c55e' : wsStatus === 'connected' ? '#eab308' : '#ef4444';
    const dotGlow = isConnected ? '0 0 4px #22c55e80' : wsStatus === 'connected' ? '0 0 4px #eab30880' : '0 0 4px #ef444480';

    // Derive connection stage summary
    const daemons = ides.filter((i: any) => i.type === 'adhdev-daemon');
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

    return (
        <div className="dashboard-header">
            <div className="flex items-center gap-3">
                <div className="leading-tight">
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
                    <div className="header-subtitle text-xs items-center gap-1">
                        {agentCount} agent{agentCount !== 1 ? 's' : ''} active
                        <span
                            title={isConnected ? 'Connected' : wsStatus === 'connected' ? 'Partial' : 'Disconnected'}
                            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ background: dotColor, boxShadow: dotGlow }}
                        />
                        {statusText && (
                            <span className="text-[10px] text-text-muted animate-pulse ml-1">
                                · {statusText}
                            </span>
                        )}
                    </div>
                </div>
            </div>
            <div className="flex gap-2 items-center">
                {isCliActive && onStopCli && (
                    <button
                        onClick={onStopCli}
                        className="btn btn-secondary btn-sm text-red-400 border-red-500/25 hover:bg-red-500/10"
                        title="Stop CLI process"
                    >
                        Stop
                    </button>
                )}

                {activeConv && !isCliActive && !isAcpConv(activeConv) && (
                    <button
                        onClick={() => navigate(`/ide/${activeConv.ideId}`)}
                        className="btn btn-primary btn-sm"
                        title="IDE View"
                    >
                        <IconTerminal size={14} /> IDE
                    </button>
                )}

                {activeConv && !isCliActive && !isAcpConv(activeConv) && (
                    <button
                        onClick={onOpenHistory}
                        className="btn btn-secondary btn-sm"
                        title="Chat History"
                    >
                        <IconScroll size={16} />
                    </button>
                )}
                {activeConv && !isCliActive && !isAcpConv(activeConv) && (
                    <button onClick={() => navigate(`/ide/${activeConv.ideId}?view=remote`)} className="btn btn-secondary btn-sm" title="Remote Control">
                        <IconMonitor size={16} />
                    </button>
                )}
            </div>
        </div>
    );
}
