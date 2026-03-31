/**
 * DashboardPane — A single conversation pane (chat or CLI terminal).
 *
 * Encapsulates everything needed to render one conversation:
 * ApprovalBanner, ScreenshotViewer, ChatPane/CliTerminalPane.
 * Used by Dashboard for both single and split-view modes.
 */
import { useRef, useCallback, useEffect } from 'react';
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
    isSendingChat?: boolean;
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
    isSendingChat = false,
    handleFocusAgent, handleRelaunch, handleModalButton,
    isFocusingAgent, messageReceivedAt, actionLogs,
    ptyBuffers, terminalRef,
    screenshotUrl, onDismissScreenshot,
    paneIndex, isFocused, onFocus, onClose,
    userName,
}: DashboardPaneProps) {
    const { sendCommand } = useTransport();
    const isCli = isCliConv(activeConv) && !isAcpConv(activeConv);

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
                            activeConv.status === 'generating' ? 'bg-green-400 animate-pulse' :
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
            {isCli ? (
                <CliTerminalPane
                    activeConv={activeConv}
                    ptyBuffers={ptyBuffers}
                    terminalRef={terminalRef}
                    agentInput={agentInput}
                    setAgentInput={setAgentInput}
                    handleSendChat={handleSendChat}
                    isSendingChat={isSendingChat}
                />
            ) : (
                <ChatPane
                    activeConv={activeConv}
                    ides={ides}
                    agentInput={agentInput}
                    setAgentInput={setAgentInput}
                    handleSendChat={handleSendChat}
                    isSendingChat={isSendingChat}
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
