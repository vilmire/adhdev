/**
 * CliTerminalPane — CLI agent terminal view with buffer replay and input bar.
 */
import { useRef, useEffect } from 'react';
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
    agentInput: string;
    setAgentInput: (v: string | ((prev: string) => string)) => void;
    handleSendChat: () => void;
    isSendingChat?: boolean;
}

export default function CliTerminalPane({
    activeConv, ptyBuffers, terminalRef,
    agentInput, setAgentInput, handleSendChat,
    isSendingChat = false,
}: CliTerminalPaneProps) {
    const chatInputRef = useRef<HTMLInputElement>(null);
    const { sendCommand, sendData } = useTransport();

    // ─── Real-time PTY output: subscribe to P2P pty_output and write to xterm ───
    // Also replay existing buffer on mount so the terminal starts with past output.
    const convAdapterKey = activeConv.ideId?.includes(':cli:') ? activeConv.ideId.split(':cli:')[1] : '';
    const tabKey = activeConv.tabKey;
    const cliType = activeConv.ideType || activeConv.agentType || '';

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
            const match = cliId === convAdapterKey || cliId === cliType || cliId === activeConv.ideId || cliId === activeConv.tabKey;
            if (match) {
                terminalRef.current?.write(data);
            }
        });
        return () => { unsub(); };
    }, [convAdapterKey, cliType]);

    return (
        <>
            {/* Terminal */}
            <div className="flex-1 min-h-0 p-2 bg-[#0f1117]">
                <CliTerminal
                    key={activeConv.tabKey}
                    ref={terminalRef as any}
                    onInput={(data) => {
                        const daemonId = activeConv.ideId || activeConv.daemonId || ''
                        const cliId = activeConv.ideId?.includes(':cli:') ? activeConv.ideId.split(':cli:')[1] : (activeConv.ideType || activeConv.agentType || '')
                        if (!sendData?.(daemonId, { type: 'pty_input', cliType: cliId, data })) {
                            sendCommand(daemonId, 'pty_input', { cliType: cliId, data }).catch(console.error)
                        }
                    }}
                    onResize={(cols, rows) => {
                        const daemonId = activeConv.ideId || activeConv.daemonId || ''
                        const cliId = activeConv.ideId?.includes(':cli:') ? activeConv.ideId.split(':cli:')[1] : (activeConv.ideType || activeConv.agentType || '')
                        if (!sendData?.(daemonId, { type: 'pty_resize', cliType: cliId, cols, rows })) {
                            sendCommand(daemonId, 'pty_resize', { cliType: cliId, cols, rows, force: true }).catch(() => { })
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
                            value={agentInput}
                            onChange={e => setAgentInput(e.target.value)}
                            onPaste={e => {
                                const pasted = e.clipboardData.getData('text');
                                if (pasted) setAgentInput((prev: string) => prev + pasted);
                                e.preventDefault();
                            }}
                            onKeyDown={e => {
                                if (e.key !== 'Enter') return;
                                if (e.nativeEvent.isComposing) {
                                    e.preventDefault();
                                    return;
                                }
                                e.preventDefault();
                                handleSendChat();
                            }}
                            className="w-full h-9 rounded-[18px] px-4 bg-bg-secondary text-[13px] text-text-primary"
                            style={{ border: '1px solid var(--chat-input-border, var(--border-subtle))' }}
                        />
                    </div>
                    <button
                        onClick={handleSendChat}
                        disabled={!agentInput.trim() || isSendingChat}
                        className={`w-9 h-9 rounded-full flex items-center justify-center border-none shrink-0 transition-all duration-300 ${
                            agentInput.trim() && !isSendingChat ? 'cursor-pointer' : 'bg-bg-secondary cursor-default'
                        }`}
                        style={agentInput.trim() && !isSendingChat ? { background: 'var(--chat-send-bg, var(--accent-primary))' } : undefined}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={agentInput.trim() ? 'text-white' : 'text-text-muted'}>
                            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                        </svg>
                    </button>
                </div>
            </div>
        </>
    );
}
