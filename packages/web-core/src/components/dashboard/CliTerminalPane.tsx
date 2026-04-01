/**
 * CliTerminalPane — CLI agent terminal view with buffer replay and input bar.
 */
import { useRef, useEffect, useState } from 'react';
import { CliTerminal } from '../CliTerminal';
import type { CliTerminalHandle } from '../CliTerminal';
import { useTransport } from '../../context/TransportContext';
import { ptyBus } from './ptyBus';
import type { ActiveConversation } from './types';

export interface CliTerminalPaneProps {
    activeConv: ActiveConversation;
    /** PTY buffer map (ref from Dashboard) */
    ptyBuffers: React.MutableRefObject<Map<string, string[]>>;
    /** Outer terminal ref for bumpResize etc. */
    terminalRef: React.RefObject<CliTerminalHandle | null>;
    handleSendChat: (message: string) => void;
    isSendingChat?: boolean;
}

export default function CliTerminalPane({
    activeConv, ptyBuffers, terminalRef,
    handleSendChat,
    isSendingChat = false,
}: CliTerminalPaneProps) {
    const chatInputRef = useRef<HTMLInputElement>(null);
    const { sendCommand, sendData } = useTransport();
    const [draftInput, setDraftInput] = useState('');

    // ─── Real-time PTY output: subscribe to P2P pty_output and write to xterm ───
    // Also replay existing buffer on mount so the terminal starts with past output.
    const tabKey = activeConv.tabKey;
    const sessionId = activeConv.sessionId || '';

    useEffect(() => {
        // Replay existing buffer on mount
        const buf = ptyBuffers.current.get(tabKey);
        if (buf && buf.length > 0) {
            // Small delay to let xterm initialize
            const timer = setTimeout(() => {
                for (const chunk of buf) {
                    terminalRef.current?.write(chunk);
                }
                requestAnimationFrame(() => {
                    terminalRef.current?.bumpResize();
                });
            }, 100);
            return () => clearTimeout(timer);
        }
    }, [tabKey]); // Only on mount / tab switch

    useEffect(() => {
        // Subscribe to real-time PTY output via ptyBus (emitted by Dashboard)
        const unsub = ptyBus.on((cliId: string, data: string) => {
            if (!data) return;
            const match = cliId === sessionId || cliId === activeConv.ideId || cliId === activeConv.tabKey;
            if (match) {
                terminalRef.current?.write(data);
            }
        });
        return () => { unsub(); };
    }, [sessionId, activeConv.ideId, activeConv.tabKey]);

    useEffect(() => {
        setDraftInput('');
    }, [activeConv.tabKey]);

    return (
        <>
            {/* Terminal */}
            <div className="flex-1 min-h-0 p-2 bg-[#0f1117]">
                <CliTerminal
                    key={activeConv.tabKey}
                    ref={terminalRef as any}
                    onInput={(data) => {
                        const daemonId = activeConv.ideId || activeConv.daemonId || ''
                        if (!sendData?.(daemonId, { type: 'pty_input', targetSessionId: sessionId, data })) {
                            sendCommand(daemonId, 'pty_input', { targetSessionId: sessionId, data }).catch(console.error)
                        }
                    }}
                    onResize={(cols, rows) => {
                        const daemonId = activeConv.ideId || activeConv.daemonId || ''
                        if (!sendData?.(daemonId, { type: 'pty_resize', targetSessionId: sessionId, cols, rows })) {
                            sendCommand(daemonId, 'pty_resize', { targetSessionId: sessionId, cols, rows, force: true }).catch(() => { })
                        }
                    }}
                />
            </div>

            {/* Input bar for CLI terminal */}
            <div className="px-3 py-2 bg-[var(--surface-primary)] border-t border-border-subtle shrink-0">
                <div className="flex gap-2.5 items-center">
                    <div className="flex-1 relative">
                        <input
                            ref={chatInputRef}
                            type="text"
                            placeholder={`Send message to ${activeConv.displayPrimary}...`}
                            value={draftInput}
                            onChange={e => setDraftInput(e.target.value)}
                            onPaste={e => {
                                const pasted = e.clipboardData.getData('text');
                                if (pasted) setDraftInput(prev => prev + pasted);
                                e.preventDefault();
                            }}
                            onKeyDown={e => {
                                if (e.key !== 'Enter') return;
                                if (e.nativeEvent.isComposing) {
                                    e.preventDefault();
                                    return;
                                }
                                e.preventDefault();
                                const message = draftInput.trim();
                                if (!message || isSendingChat) return;
                                setDraftInput('');
                                handleSendChat(message);
                            }}
                            className="w-full h-9 rounded-[18px] px-4 bg-bg-secondary text-[13px] text-text-primary"
                            style={{ border: '1px solid var(--chat-input-border, var(--border-subtle))' }}
                        />
                    </div>
                    <button
                        onClick={() => {
                            const message = draftInput.trim();
                            if (!message || isSendingChat) return;
                            setDraftInput('');
                            handleSendChat(message);
                        }}
                        disabled={!draftInput.trim() || isSendingChat}
                        className={`w-9 h-9 rounded-full flex items-center justify-center border-none shrink-0 transition-all duration-300 ${
                            draftInput.trim() && !isSendingChat ? 'cursor-pointer' : 'bg-bg-secondary cursor-default'
                        }`}
                        style={draftInput.trim() && !isSendingChat ? { background: 'var(--chat-send-bg, var(--accent-primary))' } : undefined}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={draftInput.trim() ? 'text-white' : 'text-text-muted'}>
                            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                        </svg>
                    </button>
                </div>
            </div>
        </>
    );
}
