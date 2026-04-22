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
import ChatInputBar from './ChatInputBar';
import {
    DEFAULT_MAX_CLI_TERMINAL_SCALE,
    DEFAULT_MIN_CLI_TERMINAL_SCALE,
} from '../../utils/cli-terminal-scale';
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
    isInputActive?: boolean;
}

export default function CliTerminalPane({
    activeConv, clearToken = 0, terminalRef,
    handleSendChat,
    isSendingChat = false,
    sendFeedbackMessage = null,
    isVisible = true,
    isInputActive = true,
}: CliTerminalPaneProps) {
    useBaseDaemons();
    const { sendData } = useTransport();
    const [runtimeReady, setRuntimeReady] = useState(false);
    const [terminalScale, setTerminalScale] = useState(1);
    const [terminalViewport, setTerminalViewport] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const [terminalIntrinsicViewport, setTerminalIntrinsicViewport] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const terminalViewportRef = useRef<HTMLDivElement | null>(null);
    const terminalPanSurfaceRef = useRef<HTMLDivElement | null>(null);
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
    const sendBlockMessage = getConversationSendBlockMessage(activeConv);
    const inputStatusMessage = !runtimeReady
        ? 'Runtime terminal unavailable'
        : (sendFeedbackMessage || sendBlockMessage);
    const MIN_TERMINAL_SCALE = DEFAULT_MIN_CLI_TERMINAL_SCALE;
    const MAX_TERMINAL_SCALE = DEFAULT_MAX_CLI_TERMINAL_SCALE;
    const getAutoTerminalScale = () => {
        const intrinsicWidth = terminalIntrinsicViewport.width;
        const intrinsicHeight = terminalIntrinsicViewport.height;
        if (!Number.isFinite(terminalViewport.width) || terminalViewport.width <= 0) return 1;
        if (!Number.isFinite(terminalViewport.height) || terminalViewport.height <= 0) return 1;
        if (!Number.isFinite(intrinsicWidth) || intrinsicWidth <= 0) return 1;
        if (!Number.isFinite(intrinsicHeight) || intrinsicHeight <= 0) return 1;
        const widthRatio = terminalViewport.width / intrinsicWidth;
        const heightRatio = terminalViewport.height / intrinsicHeight;
        return Number(Math.min(MAX_TERMINAL_SCALE, Math.max(MIN_TERMINAL_SCALE, Math.min(widthRatio, heightRatio))).toFixed(2));
    };
    const fittedTerminalScale = getAutoTerminalScale();
    const isManualZoomedIn = terminalScaleTouchedRef.current && terminalScale > fittedTerminalScale;
    const scaledTerminalWidth = Number.isFinite(terminalIntrinsicViewport.width) && terminalIntrinsicViewport.width > 0
        ? Math.max(terminalViewport.width, Math.round(terminalIntrinsicViewport.width * terminalScale))
        : terminalViewport.width;
    const scaledTerminalHeight = Number.isFinite(terminalIntrinsicViewport.height) && terminalIntrinsicViewport.height > 0
        ? Math.max(terminalViewport.height, Math.round(terminalIntrinsicViewport.height * terminalScale))
        : terminalViewport.height;

    const anchorZoomViewportBottomLeft = () => {
        requestAnimationFrame(() => {
            const scroller = terminalPanSurfaceRef.current;
            if (!scroller) return;
            scroller.scrollLeft = 0;
            scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
        });
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
        const container = terminalViewportRef.current;
        if (!container || typeof ResizeObserver === 'undefined') return;

        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;
            const { width, height } = entry.contentRect;
            setTerminalViewport((current) => {
                const nextWidth = Math.round(width);
                const nextHeight = Math.round(height);
                if (current.width === nextWidth && current.height === nextHeight) return current;
                return { width: nextWidth, height: nextHeight };
            });
        });

        observer.observe(container);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const applyAutoScale = () => {
            if (terminalScaleTouchedRef.current) return;
            setTerminalScale(getAutoTerminalScale());
        };
        applyAutoScale();
    }, [terminalIntrinsicViewport.height, terminalIntrinsicViewport.width, terminalViewport.height, terminalViewport.width]);

    useEffect(() => {
        if (!isVisible) {
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

        if (daemonRouteId && sessionId && connectionManager.getState?.(daemonRouteId) === 'connected') {
            connectionManager.requestRuntimeSnapshot?.(daemonRouteId, sessionId).catch(() => {});
        }

        if (pendingLiveOutputRef.current && flushFrameRef.current === null) {
            flushFrameRef.current = requestAnimationFrame(flushPendingLiveOutput);
        }

        requestAnimationFrame(() => {
            terminalRef.current?.bumpResize();
        });
    }, [daemonRouteId, isVisible, sessionId]);

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
            <div ref={terminalViewportRef} className="flex-1 min-h-0 p-2 bg-[#0f1117] relative">
                <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5">
                        <button
                            type="button"
                            className="h-8 w-8 rounded-full border border-white/10 bg-black/35 text-sm font-semibold text-white/85 backdrop-blur-sm transition-colors hover:bg-black/55"
                            onClick={() => {
                                terminalScaleTouchedRef.current = true;
                                setTerminalScale(scale => {
                                    const nextScale = Math.max(MIN_TERMINAL_SCALE, Number((scale - 0.1).toFixed(2)));
                                    if (nextScale > fittedTerminalScale) anchorZoomViewportBottomLeft();
                                    return nextScale;
                                });
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
                                setTerminalScale(scale => {
                                    const nextScale = Math.min(MAX_TERMINAL_SCALE, Number((scale + 0.1).toFixed(2)));
                                    if (nextScale > fittedTerminalScale) anchorZoomViewportBottomLeft();
                                    return nextScale;
                                });
                            }}
                            title="Increase terminal viewport"
                        >
                            +
                        </button>
                    </div>
                <div
                    ref={terminalPanSurfaceRef}
                    className={isManualZoomedIn ? 'w-full h-full overflow-auto rounded-lg overscroll-contain' : 'w-full h-full overflow-hidden rounded-lg overscroll-contain'}
                >
                    <div
                        style={{
                            width: scaledTerminalWidth > 0 ? `${scaledTerminalWidth}px` : '100%',
                            height: scaledTerminalHeight > 0 ? `${scaledTerminalHeight}px` : '100%',
                            minWidth: '100%',
                            minHeight: '100%',
                            position: 'relative',
                        }}
                    >
                        <div
                            style={{
                                width: terminalIntrinsicViewport.width > 0 ? `${terminalIntrinsicViewport.width}px` : '100%',
                                height: terminalIntrinsicViewport.height > 0 ? `${terminalIntrinsicViewport.height}px` : '100%',
                                position: 'absolute',
                                left: 0,
                                bottom: 0,
                                zoom: terminalScale,
                            }}
                        >
                            <CliTerminal
                                ref={terminalRef}
                                readOnly={!runtimeReady || !isVisible}
                                sizingMode="measured"
                                onViewportMetrics={setTerminalIntrinsicViewport}
                                onInput={(data) => {
                                    if (!runtimeReady) return;
                                    sendData?.(daemonRouteId, { type: 'pty_input', sessionId, targetSessionId: sessionId, data })
                                }}
                            />
                        </div>
                    </div>
                </div>
                {!runtimeReady && (
                    <div className="absolute inset-x-2 top-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300 pointer-events-none">
                        Runtime terminal unavailable
                    </div>
                )}
            </div>

            <ChatInputBar
                contextKey={activeConv.tabKey}
                panelLabel={getConversationTitle(activeConv)}
                isSending={isSendingChat}
                isBusy={!runtimeReady || !!sendBlockMessage}
                statusMessage={inputStatusMessage}
                onSend={async (message) => {
                    if (!runtimeReady || sendBlockMessage) return false;
                    return handleSendChat(message);
                }}
                isActive={isInputActive && isVisible}
                showControlsToggle={false}
            />
        </>
    );
}
