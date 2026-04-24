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
    const { sendPtyInput } = useTransport();
    const [runtimeReady, setRuntimeReady] = useState(false);
    const [terminalScale, setTerminalScale] = useState(1);
    const [terminalViewport, setTerminalViewport] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const [terminalIntrinsicViewport, setTerminalIntrinsicViewport] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const terminalViewportRef = useRef<HTMLDivElement | null>(null);
    const terminalPanSurfaceRef = useRef<HTMLDivElement | null>(null);
    const terminalScaleTouchedRef = useRef(false);
    const terminalAutoScaleInitializedRef = useRef(false);
    const seededSnapshotSeqRef = useRef(0);
    const liveOutputStartedRef = useRef(false);
    const pendingLiveOutputRef = useRef('');
    const pendingHiddenSnapshotRef = useRef<{ text: string; seq: number; cols?: number; rows?: number } | null>(null);
    const pendingHiddenClearRef = useRef(false);
    const flushFrameRef = useRef<{ ownerWindow: Window; frameId: number } | null>(null);
    const MAX_TERMINAL_WRITE_CHARS_PER_FRAME = 32 * 1024;

    const getOwnerWindow = () => terminalViewportRef.current?.ownerDocument?.defaultView
        || terminalPanSurfaceRef.current?.ownerDocument?.defaultView
        || window;
    const scheduleInOwnerWindow = (callback: FrameRequestCallback) => {
        const ownerWindow = getOwnerWindow();
        return {
            ownerWindow,
            frameId: ownerWindow.requestAnimationFrame(callback),
        };
    };
    const cancelScheduledFrame = () => {
        const pendingFrame = flushFrameRef.current;
        if (!pendingFrame) return;
        try {
            pendingFrame.ownerWindow.cancelAnimationFrame(pendingFrame.frameId);
        } catch {}
        flushFrameRef.current = null;
    };
    const scheduleFlushPendingLiveOutput = () => {
        if (!isVisible) return;
        if (flushFrameRef.current !== null) return;
        flushFrameRef.current = scheduleInOwnerWindow(() => {
            flushPendingLiveOutput();
        });
    };

    const tabKey = activeConv.tabKey;
    const sessionId = activeConv.sessionId || '';
    const daemonRouteId = activeConv.daemonId || activeConv.routeId?.split(':')[0] || activeConv.routeId || '';
    const sendBlockMessage = getConversationSendBlockMessage(activeConv);
    const inputStatusMessage = !runtimeReady
        ? 'Runtime terminal unavailable'
        : (sendFeedbackMessage || sendBlockMessage);
    const MIN_TERMINAL_SCALE = DEFAULT_MIN_CLI_TERMINAL_SCALE;
    const MAX_TERMINAL_SCALE = DEFAULT_MAX_CLI_TERMINAL_SCALE;
    const TERMINAL_AUTO_SCALE_CHANGE_THRESHOLD = 0.05;
    const safeTerminalScale = Number.isFinite(terminalScale) && terminalScale > 0 ? terminalScale : 1;
    const terminalFontSize = Number((13 * terminalScale).toFixed(2));
    const getAutoTerminalScale = () => {
        const renderedWidth = terminalIntrinsicViewport.width > 0 ? Math.max(terminalViewport.width, Math.round(terminalIntrinsicViewport.width)) : terminalViewport.width;
        const renderedHeight = terminalIntrinsicViewport.height > 0 ? Math.max(terminalViewport.height, Math.round(terminalIntrinsicViewport.height)) : terminalViewport.height;
        if (!Number.isFinite(terminalViewport.width) || terminalViewport.width <= 0) return 1;
        if (!Number.isFinite(terminalViewport.height) || terminalViewport.height <= 0) return 1;
        if (!Number.isFinite(renderedWidth) || renderedWidth <= 0) return 1;
        if (!Number.isFinite(renderedHeight) || renderedHeight <= 0) return 1;
        const unscaledWidth = renderedWidth / safeTerminalScale;
        const unscaledHeight = renderedHeight / safeTerminalScale;
        if (!Number.isFinite(unscaledWidth) || unscaledWidth <= 0) return 1;
        if (!Number.isFinite(unscaledHeight) || unscaledHeight <= 0) return 1;
        const widthRatio = terminalViewport.width / unscaledWidth;
        const heightRatio = terminalViewport.height / unscaledHeight;
        return Number(Math.min(MAX_TERMINAL_SCALE, Math.max(MIN_TERMINAL_SCALE, Math.min(widthRatio, heightRatio))).toFixed(2));
    };
    const fittedTerminalScale = getAutoTerminalScale();
    const isManualZoomedIn = terminalScaleTouchedRef.current && terminalScale > fittedTerminalScale;
    const hasOverflowedTerminalSurface = terminalIntrinsicViewport.width > terminalViewport.width + 1
        || terminalIntrinsicViewport.height > terminalViewport.height + 1;
    const renderedTerminalWidth = terminalIntrinsicViewport.width > 0
        ? Math.max(terminalViewport.width, Math.round(terminalIntrinsicViewport.width))
        : terminalViewport.width;
    const renderedTerminalHeight = terminalIntrinsicViewport.height > 0
        ? Math.max(terminalViewport.height, Math.round(terminalIntrinsicViewport.height))
        : terminalViewport.height;
    const terminalSurfaceWidth = terminalIntrinsicViewport.width > 0
        ? Math.round(terminalIntrinsicViewport.width)
        : renderedTerminalWidth;
    const terminalSurfaceHeight = terminalIntrinsicViewport.height > 0
        ? Math.round(terminalIntrinsicViewport.height)
        : renderedTerminalHeight;

    const anchorZoomViewportBottomLeft = () => {
        scheduleInOwnerWindow(() => {
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
        if (!terminalScaleTouchedRef.current) {
            terminalAutoScaleInitializedRef.current = false;
            setTerminalScale(1);
        }
        if (flushFrameRef.current !== null) {
            cancelScheduledFrame();
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
            cancelScheduledFrame();
        }
        setRuntimeReady(true);
        terminalRef.current?.reset?.();
    };

    const flushPendingLiveOutput = () => {
        flushFrameRef.current = null;
        if (!isVisible) return;
        const queuedOutput = pendingLiveOutputRef.current;
        if (!queuedOutput) return;
        const nextChunk = queuedOutput.slice(0, MAX_TERMINAL_WRITE_CHARS_PER_FRAME);
        pendingLiveOutputRef.current = queuedOutput.slice(nextChunk.length);
        terminalRef.current?.write(nextChunk);
        if (pendingLiveOutputRef.current.length > 0) {
            scheduleFlushPendingLiveOutput();
        }
    };

    const enqueueTerminalWrite = (data: string) => {
        if (!data) return;
        pendingLiveOutputRef.current += data;
        scheduleFlushPendingLiveOutput();
    };

    const seedTerminal = (text: string, seq = 0, cols?: number, rows?: number) => {
        if (seq > 0 && seededSnapshotSeqRef.current >= seq) return;
        if (seq === 0 && liveOutputStartedRef.current) return;
        seededSnapshotSeqRef.current = seq;
        setRuntimeReady(true);
        if (typeof cols === 'number' && typeof rows === 'number' && cols > 0 && rows > 0) {
            terminalRef.current?.resize?.(cols, rows);
        }
        pendingLiveOutputRef.current = '';
        terminalRef.current?.reset?.();
        if (text) enqueueTerminalWrite(text);
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
        const ResizeObserverCtor = container?.ownerDocument?.defaultView?.ResizeObserver;
        if (!container || !ResizeObserverCtor) return;

        const observer = new ResizeObserverCtor((entries) => {
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
        if (terminalScaleTouchedRef.current) return;
        const nextScale = getAutoTerminalScale();
        if (!Number.isFinite(nextScale) || nextScale <= 0) return;
        setTerminalScale((currentScale) => {
            if (!terminalAutoScaleInitializedRef.current) {
                terminalAutoScaleInitializedRef.current = true;
                return nextScale;
            }
            const shouldAutoShrink = nextScale < currentScale - TERMINAL_AUTO_SCALE_CHANGE_THRESHOLD;
            return shouldAutoShrink ? nextScale : currentScale;
        });
    }, [terminalIntrinsicViewport.height, terminalIntrinsicViewport.width, terminalViewport.height, terminalViewport.width]);

    useEffect(() => {
        if (!hasOverflowedTerminalSurface && !isManualZoomedIn) return;
        anchorZoomViewportBottomLeft();
    }, [hasOverflowedTerminalSurface, isManualZoomedIn, renderedTerminalHeight, renderedTerminalWidth]);

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
            scheduleFlushPendingLiveOutput();
        }

        scheduleInOwnerWindow(() => {
            terminalRef.current?.bumpResize();
        });
    }, [daemonRouteId, isVisible, sessionId]);

    useEffect(() => {
        return () => {
            if (flushFrameRef.current !== null) {
                cancelScheduledFrame();
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
        const ownerWindow = getOwnerWindow();
        const targets = ownerWindow === window ? [window] : [window, ownerWindow];
        for (const target of targets) {
            target.addEventListener('adhdev:fit-cli-terminal', handleFit as EventListener);
        }
        return () => {
            for (const target of targets) {
                target.removeEventListener('adhdev:fit-cli-terminal', handleFit as EventListener);
            }
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
                                    const nextScale = Math.max(fittedTerminalScale, Number((scale - 0.1).toFixed(2)));
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
                    className={hasOverflowedTerminalSurface ? 'w-full h-full overflow-x-auto overflow-y-hidden rounded-lg overscroll-contain' : 'w-full h-full overflow-hidden rounded-lg overscroll-contain'}
                    style={{
                        display: 'flex',
                        justifyContent: 'flex-start',
                        alignItems: 'flex-end',
                    }}
                >
                    <div
                        style={{
                            width: terminalSurfaceWidth > 0 ? `${terminalSurfaceWidth}px` : renderedTerminalWidth > 0 ? `${renderedTerminalWidth}px` : '100%',
                            height: terminalSurfaceHeight > 0 ? `${terminalSurfaceHeight}px` : renderedTerminalHeight > 0 ? `${renderedTerminalHeight}px` : '100%',
                            minWidth: terminalSurfaceWidth > 0 ? `${terminalSurfaceWidth}px` : '100%',
                            minHeight: terminalSurfaceHeight > 0 ? `${terminalSurfaceHeight}px` : '100%',
                            position: 'relative',
                        }}
                    >
                        <div
                            style={{
                                width: '100%',
                                height: '100%',
                                position: 'absolute',
                                left: 0,
                                bottom: 0,
                            }}
                        >
                            <CliTerminal
                                ref={terminalRef}
                                readOnly={!runtimeReady || !isVisible}
                                sizingMode="measured"
                                fontSize={terminalFontSize}
                                onViewportMetrics={setTerminalIntrinsicViewport}
                                onInput={(data) => {
                                    if (!runtimeReady) return;
                                    const sent = sendPtyInput?.(daemonRouteId, sessionId, data) ?? false;
                                    if (!sent) return;
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
