/**
 * DashboardPane — A single conversation pane (chat or CLI terminal).
 *
 * Encapsulates everything needed to render one conversation:
 * ApprovalBanner, ScreenshotViewer, ChatPane/CliTerminalPane.
 * Used by Dashboard for both single and split-view modes.
 */
import { useRef, useCallback, useEffect, useState } from 'react';
import { isCliConv, isAcpConv } from './types';
import type { ActiveConversation } from './types';
import type { DaemonData } from '../../types';
import type { CliTerminalHandle } from '../CliTerminal';
import { useTransport } from '../../context/TransportContext';
import ApprovalBanner from './ApprovalBanner';
import CliTerminalPane from './CliTerminalPane';
import ChatPane from './ChatPane';
import ScreenshotViewer from '../ScreenshotViewer';
import { IconWarning } from '../Icons';

export interface DashboardPaneProps {
    activeConv: ActiveConversation;
    ides: DaemonData[];
    /** All handlers from useDashboardCommands, scoped to this pane */
    agentInput: string;
    setAgentInput: (v: string | ((prev: string) => string)) => void;
    handleSendChat: () => void;
    handleFocusAgent: () => void;
    handleRelaunch: () => void;
    handleModalButton: (btnText: string) => void;
    isFocusingAgent: boolean;
    messageReceivedAt: Record<string, number>;
    actionLogs: { ideId: string; text: string; timestamp: number }[];
    /** PTY buffer map (shared ref from Dashboard) */
    ptyBuffers: React.MutableRefObject<Map<string, string[]>>;
    /** Terminal ref for CLI panes */
    terminalRef: React.RefObject<CliTerminalHandle | null>;
    /** Screenshot data */
    screenshotUrl?: string;
    onDismissScreenshot?: () => void;
    /** Split view props */
    paneIndex: number;
    isFocused: boolean;
    onFocus: () => void;
    /** Show close button for split panes (pane 1) */
    onClose?: () => void;
    /** User display name */
    userName?: string;
    /** Whether this is standalone mode */
    isStandalone?: boolean;
}

export default function DashboardPane({
    activeConv, ides,
    agentInput, setAgentInput, handleSendChat,
    handleFocusAgent, handleRelaunch, handleModalButton,
    isFocusingAgent, messageReceivedAt, actionLogs,
    ptyBuffers, terminalRef,
    screenshotUrl, onDismissScreenshot,
    paneIndex, isFocused, onFocus, onClose,
    userName,
}: DashboardPaneProps) {
    const { sendCommand } = useTransport();
    const [cliViewMode, setCliViewMode] = useState<'chat' | 'terminal' | null>(null);
    const isCli = isCliConv(activeConv) && !isAcpConv(activeConv);
    const activeViewMode = isCli ? (cliViewMode ?? activeConv.mode ?? 'terminal') : 'chat';

    return (
        <div
            className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden relative"
            onClick={onFocus}
            style={{
                borderLeft: paneIndex === 1 ? '1px solid var(--border-subtle)' : undefined,
                outline: isFocused ? '2px solid var(--accent-primary)' : '2px solid transparent',
                outlineOffset: '-2px',
                transition: 'outline-color 0.2s ease',
            }}
        >
            {/* Pane header (split mode only) */}
            {onClose != null && (
                <div className="flex items-center justify-between px-3 py-1 bg-bg-secondary border-b border-border-subtle shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            activeConv.status === 'working' ? 'bg-green-400 animate-pulse' :
                            activeConv.status === 'waiting_approval' ? 'bg-yellow-400' : 'bg-text-muted'
                        }`} />
                        <span className="text-xs font-semibold truncate">{activeConv.displayPrimary}</span>
                        <span className="text-[10px] text-text-muted truncate">{activeConv.displaySecondary}</span>
                    </div>
                    <button
                        onClick={(e) => { e.stopPropagation(); onClose(); }}
                        className="text-text-muted hover:text-text-primary text-sm px-1 transition-colors"
                        title="Close split pane"
                    >
                        ✕
                    </button>
                </div>
            )}

            {isCli && (
                <div className="flex items-center justify-between px-3 py-2 bg-bg-primary shrink-0 gap-3">
                    <button 
                        className="flex items-center gap-2 outline-none cursor-pointer select-none group px-1"
                        onClick={() => setCliViewMode(activeViewMode === 'chat' ? 'terminal' : 'chat')}
                    >
                        <span className={`text-[11.5px] font-medium transition-colors ${activeViewMode === 'chat' ? 'text-text-primary' : 'text-text-muted group-hover:text-text-primary'}`}>
                            Chat
                        </span>
                        <div className={`relative w-[34px] h-4 rounded-full transition-colors duration-300 ${activeViewMode === 'terminal' ? 'bg-[var(--accent-primary)]' : 'bg-border-strong'}`}>
                            <div 
                                className={`absolute top-[2px] left-[2px] w-3 h-3 bg-white rounded-full transition-transform duration-300 shadow-sm ${activeViewMode === 'terminal' ? 'translate-x-[18px]' : 'translate-x-0'}`} 
                            />
                        </div>
                        <span className={`text-[11.5px] font-medium transition-colors ${activeViewMode === 'terminal' ? 'text-text-primary' : 'text-text-muted group-hover:text-text-primary'}`}>
                            Terminal
                        </span>
                    </button>
                    {activeViewMode === 'terminal' && (
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => {
                                    if (!terminalRef.current) return;
                                    const buf = ptyBuffers.current.get(activeConv.tabKey);
                                    if (buf && buf.length > 0) {
                                        for (const chunk of buf) terminalRef.current.write(chunk);
                                    }
                                    requestAnimationFrame(() => {
                                        requestAnimationFrame(() => {
                                            terminalRef.current?.bumpResize();
                                        });
                                    });
                                }}
                                title="Refresh terminal (replay buffer + TUI redraw)"
                                className="px-2 py-0.5 rounded-[5px] text-[11px] bg-bg-secondary text-text-secondary border border-border-subtle cursor-pointer leading-none"
                            >↺</button>
                            <button
                                onClick={async () => {
                                    const cliType = activeConv.ideId?.includes(':cli:') ? activeConv.ideId.split(':cli:')[1] : (activeConv.ideType || activeConv.agentType || '');
                                    if (!window.confirm(`Stop ${cliType}?\nThis will terminate the CLI process.`)) return;
                                    const daemonId = activeConv.ideId || activeConv.daemonId || '';
                                    try {
                                        await sendCommand(daemonId, 'stop_cli', { cliType });
                                    } catch (e: any) { console.error('Stop CLI failed:', e); }
                                }}
                                title="Stop CLI process"
                                className="px-2 py-0.5 rounded-[5px] text-[11px] bg-red-500/[0.08] text-red-400 border border-red-500/30 cursor-pointer leading-none font-semibold"
                            >■ Stop</button>
                        </div>
                    )}
                </div>
            )}

            {/* Approval Banner */}
            <ApprovalBanner activeConv={activeConv} onModalButton={handleModalButton} />

            {/* Screenshot / CDP warning */}
            {(!isCli && !isAcpConv(activeConv)) && (screenshotUrl || activeConv.cdpConnected === false) && (
                <div className="desktop-only px-3 pt-1 pb-2">
                    {screenshotUrl ? (
                        <ScreenshotViewer
                            screenshotUrl={screenshotUrl}
                            mode="preview"
                            onDismiss={onDismissScreenshot}
                        />
                    ) : activeConv.cdpConnected === false ? (
                        <div className="flex items-center gap-2.5 px-3.5 py-2 bg-yellow-500/[0.08] border border-yellow-500/20 rounded-lg text-xs text-text-secondary">
                            <span className="text-sm"><IconWarning size={14} /></span>
                            <span className="flex-1">CDP not connected — chat history & screenshots unavailable.</span>
                            <button
                                className="btn btn-sm bg-yellow-500/15 text-yellow-500 border border-yellow-500/30 text-[10px] whitespace-nowrap shrink-0"
                                onClick={handleRelaunch}
                            >
                                Relaunch with CDP
                            </button>
                        </div>
                    ) : null}
                </div>
            )}

            {/* Main Content */}
            {activeViewMode === 'terminal' ? (
                <CliTerminalPane
                    activeConv={activeConv}
                    ptyBuffers={ptyBuffers}
                    terminalRef={terminalRef}
                    agentInput={agentInput}
                    setAgentInput={setAgentInput}
                    handleSendChat={handleSendChat}
                />
            ) : (
                <ChatPane
                    activeConv={activeConv}
                    ides={ides}
                    agentInput={agentInput}
                    setAgentInput={setAgentInput}
                    handleSendChat={handleSendChat}
                    handleFocusAgent={handleFocusAgent}
                    isFocusingAgent={isFocusingAgent}
                    messageReceivedAt={messageReceivedAt}
                    actionLogs={actionLogs}
                    userName={userName}
                />
            )}
        </div>
    );
}
