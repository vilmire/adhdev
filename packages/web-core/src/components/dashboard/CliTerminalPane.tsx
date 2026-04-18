/**
 * CliTerminalPane — CLI agent terminal view with buffer replay and input bar.
 */
import { useRef, useEffect, useState } from 'react';
import { CliTerminal } from '../CliTerminal';
import type { CliTerminalHandle } from '../CliTerminal';
import { useTransport } from '../../context/TransportContext';
import { connectionManager } from '../../compat';
import { useBaseDaemons } from '../../context/BaseDaemonContext';
import { getConversationSendBlockMessage } from '../../hooks/dashboardCommandUtils';
import { shouldDisableChatSendButton } from './ChatInputBar';
import { getAutoCliTerminalScaleForWidth, DEFAULT_MAX_CLI_TERMINAL_SCALE, DEFAULT_MIN_CLI_TERMINAL_SCALE } from '../../utils/cli-terminal-scale';
import type { ActiveConversation } from './types';
import { getConversationTitle } from './conversation-presenters';

export interface CliTerminalPaneProps {
    activeConv: ActiveConversation;
    clearToken?: number;
    /** Outer terminal ref for bumpResize etc. */
    terminalRef: React.RefObject<CliTerminalHandle | null>;
    handleSendChat: (message: string) => Promise<boolean>;
    isSendingChat?: boolean;
    sendFeedbackMessage?: string | null;
    isVisible?: boolean;
}

export default function CliTerminalPane({
    activeConv, clearToken = 0, terminalRef,
    handleSendChat,
    isSendingChat: _isSendingChat = false,
    sendFeedbackMessage = null,
    isVisible = true,
}: CliTerminalPaneProps) {
    const { ides } = useBaseDaemons();
    const chatInputRef = useRef<HTMLInputElement>(null);
    const { sendCommand, sendData } = useTransport();
    const [draftInput, setDraftInput] = useState('');
    const [runtimeReady, setRuntimeReady] = useState(false);
    const [terminalScale, setTerminalScale] = useState(1);
    const terminalScaleTouchedRef = useRef(false);
    const seededSnapshotSeqRef = useRef(0);
    const liveOutputStartedRef = useRef(false);
    const pendingLiveOutputRef = useRef('');
    const pendingHiddenSnapshotRef = useRef<{ text: string; seq: number; cols?: number; rows?: number } | null>(null);
    const pendingHiddenClearRef = useRef(false);
    const flushFrameRef = useRef<number | null>(null);

    const tabKey = activeConv.tabKey;
    const sessionId = activeConv.sessionId || '';
    const daemonRouteId = activeConv.daemonId || activeConv.routeId?.split(':')[0] || activeConv.routeId || '';
    const daemonEntry = ides.find(entry => entry.id === daemonRouteId && entry.type === 'adhdev-daemon');
    const terminalSizingMode = daemonEntry?.terminalSizingMode === 'fit' ? 'fit' : 'measured';
    const sendBlockMessage = getConversationSendBlockMessage(activeConv);
    const inputStatusMessage = sendFeedbackMessage || sendBlockMessage;
    const MIN_TERMINAL_SCALE = DEFAULT_MIN_CLI_TERMINAL_SCALE;
    const MAX_TERMINAL_SCALE = DEFAULT_MAX_CLI_TERMINAL_SCALE;
    const getAutoTerminalScale = () => {
        if (typeof window === 'undefined') return 1;
        return getAutoCliTerminalScaleForWidth(window.innerWidth || 0, { minScale: MIN_TERMINAL_SCALE });
    };
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
        terminalRef.current?.reset?.();
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
        terminalRef.current?.reset?.();
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
            terminalRef.current?.resize?.(cols, rows);
        }
        terminalRef.current?.reset?.();
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
                        cols: event.cols,
                        rows: event.rows,
                    };
                    return;
                }
                seedTerminal(event.text || '', event.seq || 0, event.cols, event.rows);
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
        const applyAutoScale = () => {
            if (terminalScaleTouchedRef.current) return;
            setTerminalScale(getAutoTerminalScale());
        };
        applyAutoScale();
        window.addEventListener('resize', applyAutoScale);
        return () => window.removeEventListener('resize', applyAutoScale);
    }, []);

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

        requestAnimationFrame(() => {
            terminalRef.current?.bumpResize();
        });
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
            terminalRef.current?.bumpResize();
        };
        window.addEventListener('adhdev:fit-cli-terminal', handleFit as EventListener);
        return () => {
            window.removeEventListener('adhdev:fit-cli-terminal', handleFit as EventListener);
        };
    }, [runtimeReady, sessionId, terminalRef]);

    return (
        <>
            {/* Terminal */}
            <div className="flex-1 min-h-0 p-2 bg-[#0f1117] relative">
                <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5">
                    <button
                        type="button"
                        className="h-8 w-8 rounded-full border border-white/10 bg-black/35 text-sm font-semibold text-white/85 backdrop-blur-sm transition-colors hover:bg-black/55"
                        onClick={() => {
                            terminalScaleTouchedRef.current = true;
                            setTerminalScale(scale => Math.max(MIN_TERMINAL_SCALE, Number((scale - 0.1).toFixed(2))));
                        }}
                        title="Shrink terminal viewport"
                    >
                        -
                    </button>
                    <button
                        type="button"
                        className="h-8 w-8 rounded-full border border-white/10 bg-black/35 text-sm font-semibold text-white/85 backdrop-blur-sm transition-colors hover:bg-black/55"
                        onClick={() => {
                            terminalScaleTouchedRef.current = true;
                            setTerminalScale(scale => Math.min(MAX_TERMINAL_SCALE, Number((scale + 0.1).toFixed(2))));
                        }}
                        title="Increase terminal viewport"
                    >
                        +
                    </button>
                </div>
                <div className="w-full h-full overflow-x-auto overflow-y-hidden rounded-lg overscroll-contain">
                    <div
                        style={{
                            width: `${100 / terminalScale}%`,
                            height: `${100 / terminalScale}%`,
                            transform: `scale(${terminalScale})`,
                            transformOrigin: 'top left',
                        }}
                    >
                        <CliTerminal
                            ref={terminalRef}
                            readOnly={!runtimeReady || !isVisible}
                            sizingMode={terminalSizingMode}
                            onInput={(data) => {
                                if (!runtimeReady) return;
                                if (!sendData?.(daemonRouteId, { type: 'pty_input', sessionId, targetSessionId: sessionId, data })) {
                                    sendCommand(daemonRouteId, 'pty_input', { targetSessionId: sessionId, data }).catch(console.error)
                                }
                            }}
                        />
                    </div>
                </div>
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
                            placeholder={inputStatusMessage || `Send message to ${getConversationTitle(activeConv)}...`}
                            value={draftInput}
                            disabled={!runtimeReady || !isVisible}
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
                                if (!runtimeReady || !message || sendBlockMessage) return;
                                void handleSendChat(message).then((accepted) => {
                                    if (accepted !== false) setDraftInput('');
                                });
                            }}
                            className="w-full h-9 rounded-[18px] px-4 bg-bg-secondary text-[13px] text-text-primary"
                            style={{ border: '1px solid var(--chat-input-border, var(--border-subtle))' }}
                        />
                    </div>
                    <button
                        onClick={() => {
                            const message = draftInput.trim();
                            if (!runtimeReady || !message || sendBlockMessage) return;
                            void handleSendChat(message).then((accepted) => {
                                if (accepted !== false) setDraftInput('');
                            });
                        }}
                        disabled={!runtimeReady || !isVisible || shouldDisableChatSendButton({ hasDraft: !!draftInput.trim(), isBusy: !!sendBlockMessage })}
                        className={`w-9 h-9 rounded-full flex items-center justify-center border-none shrink-0 transition-all duration-300 ${
                            draftInput.trim() && !sendBlockMessage ? 'cursor-pointer' : 'bg-bg-secondary cursor-default'
                        }`}
                        style={draftInput.trim() && !sendBlockMessage ? { background: 'var(--chat-send-bg, var(--accent-primary))' } : undefined}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={draftInput.trim() ? 'text-white' : 'text-text-muted'}>
                            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                        </svg>
                    </button>
                </div>
                {inputStatusMessage && (
                    <div className="pt-2 px-1 text-[11px] text-text-muted opacity-80">
                        {inputStatusMessage}
                    </div>
                )}
            </div>
        </>
    );
}
