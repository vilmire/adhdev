/**
 * CliTerminalPane — CLI agent terminal view with buffer replay and input bar.
 */
import { useRef, useEffect, useState } from 'react';
import { CliTerminal } from '../CliTerminal';
import type { CliTerminalHandle } from '../CliTerminal';
import { useTransport } from '../../context/TransportContext';
import { useApi } from '../../context/ApiContext';
import type { ActiveConversation } from './types';
import type { RuntimeSnapshot } from '../../base-api';

export interface CliTerminalPaneProps {
    activeConv: ActiveConversation;
    clearToken?: number;
    /** PTY buffer map (ref from Dashboard) */
    ptyBuffers: React.MutableRefObject<Map<string, string[]>>;
    /** Outer terminal ref for bumpResize etc. */
    terminalRef: React.RefObject<CliTerminalHandle | null>;
    handleSendChat: (message: string) => void;
    isSendingChat?: boolean;
}

export default function CliTerminalPane({
    activeConv, clearToken = 0, ptyBuffers, terminalRef,
    handleSendChat,
    isSendingChat = false,
}: CliTerminalPaneProps) {
    const chatInputRef = useRef<HTMLInputElement>(null);
    const { sendCommand, sendData } = useTransport();
    const api = useApi();
    const [draftInput, setDraftInput] = useState('');
    const [runtimeReady, setRuntimeReady] = useState(false);
    const seededSnapshotSeqRef = useRef(0);
    const liveOutputStartedRef = useRef(false);

    const tabKey = activeConv.tabKey;
    const sessionId = activeConv.sessionId || '';

    const resetRuntimeView = () => {
        seededSnapshotSeqRef.current = 0;
        liveOutputStartedRef.current = false;
        setRuntimeReady(false);
        terminalRef.current?.clear();
    };

    const clearRuntimeView = () => {
        seededSnapshotSeqRef.current = 0;
        liveOutputStartedRef.current = false;
        setRuntimeReady(true);
        terminalRef.current?.clear();
    };

    const seedTerminal = (text: string, seq = 0) => {
        if (liveOutputStartedRef.current) return;
        if (seededSnapshotSeqRef.current >= seq && seededSnapshotSeqRef.current !== 0) return;
        seededSnapshotSeqRef.current = seq;
        setRuntimeReady(true);
        terminalRef.current?.clear();
        if (text) terminalRef.current?.write(text);
    };

    useEffect(() => {
        resetRuntimeView();
    }, [sessionId]);

    useEffect(() => {
        if (!sessionId) return;
        const es = new EventSource(api.getRuntimeEventsUrl(sessionId));

        const handleSnapshot = (raw: MessageEvent<string>) => {
            try {
                const snapshot = JSON.parse(raw.data) as RuntimeSnapshot;
                if (snapshot.sessionId !== sessionId) return;
                seedTerminal(snapshot.text || '', snapshot.seq || 0);
            } catch {
                // noop
            }
        };

        const handleOutput = (raw: MessageEvent<string>) => {
            try {
                const event = JSON.parse(raw.data) as { sessionId: string; data?: string; seq?: number };
                if (event.sessionId !== sessionId) return;
                liveOutputStartedRef.current = true;
                if (typeof event.seq === 'number') {
                    seededSnapshotSeqRef.current = Math.max(seededSnapshotSeqRef.current, event.seq);
                }
                setRuntimeReady(true);
                if (typeof event.data === 'string') terminalRef.current?.write(event.data);
            } catch {
                // noop
            }
        };

        const handleCleared = (raw: MessageEvent<string>) => {
            try {
                const event = JSON.parse(raw.data) as { sessionId: string };
                if (event.sessionId !== sessionId) return;
                clearRuntimeView();
            } catch {
                // noop
            }
        };

        es.addEventListener('runtime_snapshot', handleSnapshot as EventListener);
        es.addEventListener('session_output', handleOutput as EventListener);
        es.addEventListener('session_cleared', handleCleared as EventListener);

        es.onerror = () => {
            // EventSource reconnects automatically. Do not clear the terminal on transient stream errors.
        };

        return () => {
            es.removeEventListener('runtime_snapshot', handleSnapshot as EventListener);
            es.removeEventListener('session_output', handleOutput as EventListener);
            es.removeEventListener('session_cleared', handleCleared as EventListener);
            es.close();
        };
    }, [api, sessionId]);

    useEffect(() => {
        if (!clearToken) return;

        ptyBuffers.current.delete(tabKey);
        resetRuntimeView();
    }, [clearToken, tabKey, ptyBuffers, terminalRef]);

    useEffect(() => {
        setDraftInput('');
    }, [activeConv.tabKey]);

    useEffect(() => {
        const handleFit = (event: Event) => {
            const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
            if (detail?.sessionId && detail.sessionId !== sessionId) return;
            if (!runtimeReady) return;
            terminalRef.current?.fit();
        };
        window.addEventListener('adhdev:fit-cli-terminal', handleFit as EventListener);
        return () => {
            window.removeEventListener('adhdev:fit-cli-terminal', handleFit as EventListener);
        };
    }, [runtimeReady, sessionId, terminalRef]);

    return (
        <>
            {/* Terminal */}
            <div className="flex-1 min-h-0 p-2 bg-[#0f1117]">
                <CliTerminal
                    key={activeConv.tabKey}
                    ref={terminalRef as any}
                    readOnly={!runtimeReady}
                    onInput={(data) => {
                        if (!runtimeReady) return;
                        const daemonId = activeConv.ideId || activeConv.daemonId || ''
                        if (!sendData?.(daemonId, { type: 'pty_input', targetSessionId: sessionId, data })) {
                            sendCommand(daemonId, 'pty_input', { targetSessionId: sessionId, data }).catch(console.error)
                        }
                    }}
                    onResize={(cols, rows) => {
                        if (!runtimeReady) return;
                        const daemonId = activeConv.ideId || activeConv.daemonId || ''
                        if (!sendData?.(daemonId, { type: 'pty_resize', targetSessionId: sessionId, cols, rows })) {
                            sendCommand(daemonId, 'pty_resize', { targetSessionId: sessionId, cols, rows, force: true }).catch(() => { })
                        }
                    }}
                />
                {!runtimeReady && (
                    <div className="absolute inset-x-2 top-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300 pointer-events-none">
                        Runtime terminal unavailable
                    </div>
                )}
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
                                if (!runtimeReady || !message || isSendingChat) return;
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
                            if (!runtimeReady || !message || isSendingChat) return;
                            setDraftInput('');
                            handleSendChat(message);
                        }}
                        disabled={!runtimeReady || !draftInput.trim() || isSendingChat}
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
