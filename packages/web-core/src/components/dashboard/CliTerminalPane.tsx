/**
 * CliTerminalPane — CLI agent terminal view with buffer replay and input bar.
 */
import { useRef, useEffect, useState } from 'react';
import { CliTerminal } from '../CliTerminal';
import type { CliTerminalHandle } from '../CliTerminal';
import { useTransport } from '../../context/TransportContext';
import { connectionManager } from '../../compat';
import type { ActiveConversation } from './types';

export interface CliTerminalPaneProps {
    activeConv: ActiveConversation;
    clearToken?: number;
    /** Outer terminal ref for bumpResize etc. */
    terminalRef: React.RefObject<CliTerminalHandle | null>;
    handleSendChat: (message: string) => void;
    isSendingChat?: boolean;
    isVisible?: boolean;
}

export default function CliTerminalPane({
    activeConv, clearToken = 0, terminalRef,
    handleSendChat,
    isSendingChat = false,
    isVisible = true,
}: CliTerminalPaneProps) {
    const chatInputRef = useRef<HTMLInputElement>(null);
    const { sendCommand, sendData } = useTransport();
    const [draftInput, setDraftInput] = useState('');
    const [runtimeReady, setRuntimeReady] = useState(false);
    const seededSnapshotSeqRef = useRef(0);
    const liveOutputStartedRef = useRef(false);
    const pendingLiveOutputRef = useRef('');
    const pendingHiddenSnapshotRef = useRef<{ text: string; seq: number; cols?: number; rows?: number } | null>(null);
    const pendingHiddenClearRef = useRef(false);
    const flushFrameRef = useRef<number | null>(null);

    const tabKey = activeConv.tabKey;
    const sessionId = activeConv.sessionId || '';
    const daemonRouteId = activeConv.daemonId || activeConv.ideId?.split(':')[0] || activeConv.ideId || '';
    const resetRuntimeView = () => {
        seededSnapshotSeqRef.current = 0;
        liveOutputStartedRef.current = false;
        pendingLiveOutputRef.current = '';
        pendingHiddenSnapshotRef.current = null;
        pendingHiddenClearRef.current = false;
        if (flushFrameRef.current !== null) {
            cancelAnimationFrame(flushFrameRef.current);
            flushFrameRef.current = null;
        }
        setRuntimeReady(false);
        (terminalRef.current as any)?.reset?.();
    };

    const clearRuntimeView = () => {
        seededSnapshotSeqRef.current = 0;
        liveOutputStartedRef.current = false;
        pendingLiveOutputRef.current = '';
        pendingHiddenSnapshotRef.current = null;
        pendingHiddenClearRef.current = false;
        if (flushFrameRef.current !== null) {
            cancelAnimationFrame(flushFrameRef.current);
            flushFrameRef.current = null;
        }
        setRuntimeReady(true);
        (terminalRef.current as any)?.reset?.();
    };

    const flushPendingLiveOutput = () => {
        flushFrameRef.current = null;
        if (!isVisible) return;
        const chunk = pendingLiveOutputRef.current;
        if (!chunk) return;
        pendingLiveOutputRef.current = '';
        terminalRef.current?.write(chunk);
    };

    const enqueueTerminalWrite = (data: string) => {
        if (!data) return;
        pendingLiveOutputRef.current += data;
        if (!isVisible) return;
        if (flushFrameRef.current !== null) return;
        flushFrameRef.current = requestAnimationFrame(flushPendingLiveOutput);
    };

    const seedTerminal = (text: string, seq = 0, cols?: number, rows?: number) => {
        if (seq > 0 && seededSnapshotSeqRef.current >= seq) return;
        if (seq === 0 && liveOutputStartedRef.current) return;
        seededSnapshotSeqRef.current = seq;
        setRuntimeReady(true);
        if (typeof cols === 'number' && typeof rows === 'number' && cols > 0 && rows > 0) {
            (terminalRef.current as any)?.resize?.(cols, rows);
        }
        (terminalRef.current as any)?.reset?.();
        if (text) terminalRef.current?.write(text);
    };

    useEffect(() => {
        resetRuntimeView();
    }, [sessionId]);

    useEffect(() => {
        if (!sessionId) return;
        const unsubRuntime = connectionManager.onRuntimeEvent?.(sessionId, (event: any) => {
            if (!event || event.sessionId !== sessionId) return;
            if (event.type === 'runtime_snapshot') {
                if (!isVisible) {
                    pendingHiddenSnapshotRef.current = {
                        text: event.text || '',
                        seq: event.seq || 0,
                        cols: (event as any).cols,
                        rows: (event as any).rows,
                    };
                    return;
                }
                seedTerminal(event.text || '', event.seq || 0, (event as any).cols, (event as any).rows);
                return;
            }
            if (event.type === 'session_output') {
                liveOutputStartedRef.current = true;
                if (typeof event.seq === 'number') {
                    seededSnapshotSeqRef.current = Math.max(seededSnapshotSeqRef.current, event.seq);
                }
                if (!runtimeReady) setRuntimeReady(true);
                if (typeof event.data === 'string') enqueueTerminalWrite(event.data);
                return;
            }
            if (event.type === 'session_cleared') {
                if (!isVisible) {
                    pendingHiddenClearRef.current = true;
                    pendingLiveOutputRef.current = '';
                    pendingHiddenSnapshotRef.current = null;
                    return;
                }
                clearRuntimeView();
            }
        }) || (() => {});

        return () => {
            unsubRuntime();
        };
    }, [daemonRouteId, sessionId, terminalRef, isVisible, runtimeReady]);

    useEffect(() => {
        if (!sessionId) return;

        if (daemonRouteId && connectionManager.getState?.(daemonRouteId) === 'connected') {
            setRuntimeReady(true);
            connectionManager.requestRuntimeSnapshot?.(daemonRouteId, sessionId).catch(() => {});
        }

        const unsubState = connectionManager.onStateChange?.((connectedDaemonId: string, state: string) => {
            if (connectedDaemonId !== daemonRouteId || state !== 'connected') return;
            setRuntimeReady(true);
            connectionManager.requestRuntimeSnapshot?.(daemonRouteId, sessionId).catch(() => {});
        });

        return () => {
            unsubState?.();
        };
    }, [daemonRouteId, sessionId, terminalRef]);

    useEffect(() => {
        if (!clearToken) return;
        resetRuntimeView();
    }, [clearToken, tabKey, terminalRef]);

    useEffect(() => {
        setDraftInput('');
    }, [activeConv.tabKey]);

    useEffect(() => {
        if (!isVisible) {
            chatInputRef.current?.blur();
            return;
        }

        if (pendingHiddenClearRef.current) {
            pendingHiddenClearRef.current = false;
            clearRuntimeView();
        }

        const pendingSnapshot = pendingHiddenSnapshotRef.current;
        if (pendingSnapshot) {
            pendingHiddenSnapshotRef.current = null;
            seedTerminal(pendingSnapshot.text, pendingSnapshot.seq, pendingSnapshot.cols, pendingSnapshot.rows);
        }

        if (pendingLiveOutputRef.current && flushFrameRef.current === null) {
            flushFrameRef.current = requestAnimationFrame(flushPendingLiveOutput);
        }
    }, [isVisible]);

    useEffect(() => {
        return () => {
            if (flushFrameRef.current !== null) {
                cancelAnimationFrame(flushFrameRef.current);
                flushFrameRef.current = null;
            }
        };
    }, []);

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
                    ref={terminalRef as any}
                    readOnly={!runtimeReady || !isVisible}
                    onInput={(data) => {
                        if (!runtimeReady) return;
                        if (!sendData?.(daemonRouteId, { type: 'pty_input', targetSessionId: sessionId, data })) {
                            sendCommand(daemonRouteId, 'pty_input', { targetSessionId: sessionId, data }).catch(console.error)
                        }
                    }}
                    onResize={(cols, rows) => {
                        if (!runtimeReady) return;
                        if (!sendData?.(daemonRouteId, { type: 'pty_resize', targetSessionId: sessionId, cols, rows })) {
                            sendCommand(daemonRouteId, 'pty_resize', { targetSessionId: sessionId, cols, rows, force: true }).catch(() => { })
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
                            disabled={!runtimeReady || !isVisible || isSendingChat}
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
                        disabled={!runtimeReady || !isVisible || !draftInput.trim() || isSendingChat}
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
