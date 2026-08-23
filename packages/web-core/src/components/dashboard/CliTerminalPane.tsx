/**
 * CliTerminalPane — CLI agent terminal view with buffer replay and input bar.
 */
import { useRef, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CliTerminal } from '../CliTerminal';
import type { CliTerminalHandle } from '../CliTerminal';
import { useTransport } from '../../context/TransportContext';
import { connectionManager } from '../../compat';
import { useBaseDaemons } from '../../context/BaseDaemonContext';
import { getConversationSendBlockMessage, SEND_BLOCKED_PLACEHOLDER } from '../../hooks/dashboardCommandUtils';
import ChatInputBar from './ChatInputBar';
import {
    DEFAULT_MAX_CLI_TERMINAL_SCALE,
    DEFAULT_MIN_CLI_TERMINAL_SCALE,
} from '../../utils/cli-terminal-scale';
import { encodeTerminalKey } from '../../utils/terminal-key-encoding';
import type { ActiveConversation } from './types';
import { getConversationTitle } from './conversation-presenters';
import SpecDebugPanel from './SpecDebugPanel';

export interface CliTerminalPaneProps {
    activeConv: ActiveConversation;
    clearToken?: number;
    /** Outer terminal ref for bumpResize etc. */
    terminalRef: React.RefObject<CliTerminalHandle | null>;
    handleSendChat: (message: string, attachments?: import('./ChatInputBar').ImageAttachment[]) => Promise<boolean>;
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
    const { t } = useTranslation('common');
    useBaseDaemons();
    const { sendPtyInput } = useTransport();
    const [runtimeReady, setRuntimeReady] = useState(false);
    const runtimeReadyRef = useRef(false);
    runtimeReadyRef.current = runtimeReady;
    const [runtimeStatusMessage, setRuntimeStatusMessage] = useState('Runtime terminal unavailable');
    const [isLoadingScrollback, setIsLoadingScrollback] = useState(false);
    const [scrollbackStatusMessage, setScrollbackStatusMessage] = useState<string | null>(null);
    const [mayHaveOlderRuntimeScrollback, setMayHaveOlderRuntimeScrollback] = useState(false);
    const [hasLoadedOlderRuntimeScrollback, setHasLoadedOlderRuntimeScrollback] = useState(false);
    const [terminalScale, setTerminalScale] = useState(1);
    const [terminalControlsOpen, setTerminalControlsOpen] = useState(false);
    const [stickyCtrl, setStickyCtrl] = useState(false);
    const [stickyAlt, setStickyAlt] = useState(false);
    const [stickyShift, setStickyShift] = useState(false);
    const [showSpecDebug, setShowSpecDebug] = useState(false);
    const [terminalViewport, setTerminalViewport] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const [terminalIntrinsicViewport, setTerminalIntrinsicViewport] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const [terminalScrollMetrics, setTerminalScrollMetrics] = useState<{ scrollTop: number; scrollHeight: number; clientHeight: number; atTop: boolean; canScroll: boolean }>({
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        atTop: false,
        canScroll: false,
    });
    const [copyStatusMessage, setCopyStatusMessage] = useState<string | null>(null);
    const terminalViewportRef = useRef<HTMLDivElement | null>(null);
    const terminalPanSurfaceRef = useRef<HTMLDivElement | null>(null);
    const terminalScaleTouchedRef = useRef(false);
    const terminalAutoScaleInitializedRef = useRef(false);
    const previousIsVisibleRef = useRef(isVisible);
    const seededSnapshotSeqRef = useRef(0);
    const liveOutputStartedRef = useRef(false);
    const pendingLiveOutputRef = useRef('');
    const pendingHiddenSnapshotRef = useRef<{ text: string; seq: number; cols?: number; rows?: number; force?: boolean } | null>(null);
    const pendingHiddenClearRef = useRef(false);
    const pendingScrollToTopAfterReplayRef = useRef(false);
    const flushFrameRef = useRef<{ ownerWindow: Window; frameId: number } | null>(null);
    const copyStatusTimeoutRef = useRef<{ ownerWindow: Window; timeoutId: number } | null>(null);
    const scrollbackStatusTimeoutRef = useRef<{ ownerWindow: Window; timeoutId: number } | null>(null);
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
    const clearCopyStatusTimeout = () => {
        const pendingTimeout = copyStatusTimeoutRef.current;
        if (!pendingTimeout) return;
        try {
            pendingTimeout.ownerWindow.clearTimeout(pendingTimeout.timeoutId);
        } catch {}
        copyStatusTimeoutRef.current = null;
    };
    const clearScrollbackStatusTimeout = () => {
        const pendingTimeout = scrollbackStatusTimeoutRef.current;
        if (!pendingTimeout) return;
        try {
            pendingTimeout.ownerWindow.clearTimeout(pendingTimeout.timeoutId);
        } catch {}
        scrollbackStatusTimeoutRef.current = null;
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
    // Placeholder carries the state as a short one-liner; the line below the
    // input only repeats send errors the user must keep seeing while typing.
    const inputStatusMessage = !runtimeReady
        ? runtimeStatusMessage
        : (sendBlockMessage ? SEND_BLOCKED_PLACEHOLDER : sendFeedbackMessage);
    const inputInlineMessage = runtimeReady ? (sendFeedbackMessage || null) : null;
    const MIN_TERMINAL_SCALE = DEFAULT_MIN_CLI_TERMINAL_SCALE;
    const MAX_TERMINAL_SCALE = DEFAULT_MAX_CLI_TERMINAL_SCALE;
    const TERMINAL_AUTO_SCALE_CHANGE_THRESHOLD = 0.05;
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
        pendingScrollToTopAfterReplayRef.current = false;
        if (!terminalScaleTouchedRef.current) {
            terminalAutoScaleInitializedRef.current = false;
            setTerminalScale(1);
        }
        if (flushFrameRef.current !== null) {
            cancelScheduledFrame();
        }
        setRuntimeReady(false);
        setRuntimeStatusMessage('Runtime terminal unavailable');
        clearScrollbackStatusTimeout();
        clearCopyStatusTimeout();
        setScrollbackStatusMessage(null);
        setCopyStatusMessage(null);
        setTerminalControlsOpen(false);
        setIsLoadingScrollback(false);
        setMayHaveOlderRuntimeScrollback(false);
        setHasLoadedOlderRuntimeScrollback(false);
        terminalRef.current?.reset?.();
    };

    const clearRuntimeView = () => {
        seededSnapshotSeqRef.current = 0;
        liveOutputStartedRef.current = false;
        pendingLiveOutputRef.current = '';
        pendingHiddenSnapshotRef.current = null;
        pendingHiddenClearRef.current = false;
        pendingScrollToTopAfterReplayRef.current = false;
        if (flushFrameRef.current !== null) {
            cancelScheduledFrame();
        }
        setRuntimeReady(true);
        setRuntimeStatusMessage('');
        clearScrollbackStatusTimeout();
        clearCopyStatusTimeout();
        setScrollbackStatusMessage(null);
        setCopyStatusMessage(null);
        setTerminalControlsOpen(false);
        setIsLoadingScrollback(false);
        setMayHaveOlderRuntimeScrollback(false);
        setHasLoadedOlderRuntimeScrollback(false);
        terminalRef.current?.reset?.();
    };

    const finishScrollbackReplayIfNeeded = () => {
        if (!pendingScrollToTopAfterReplayRef.current) return;
        pendingScrollToTopAfterReplayRef.current = false;
        scheduleInOwnerWindow(() => {
            terminalRef.current?.scrollToTop?.();
        });
    };

    const flushPendingLiveOutput = () => {
        flushFrameRef.current = null;
        if (!isVisible) return;
        const queuedOutput = pendingLiveOutputRef.current;
        if (!queuedOutput) return;
        const nextChunk = queuedOutput.slice(0, MAX_TERMINAL_WRITE_CHARS_PER_FRAME);
        pendingLiveOutputRef.current = queuedOutput.slice(nextChunk.length);
        const terminal = terminalRef.current;
        if (!terminal) {
            pendingLiveOutputRef.current = nextChunk + pendingLiveOutputRef.current;
            scheduleFlushPendingLiveOutput();
            return;
        }
        terminal.write(nextChunk, () => {
            if (pendingLiveOutputRef.current.length > 0) {
                scheduleFlushPendingLiveOutput();
                return;
            }
            finishScrollbackReplayIfNeeded();
        });
    };

    const enqueueTerminalWrite = (data: string) => {
        if (!data) return;
        pendingLiveOutputRef.current += data;
        scheduleFlushPendingLiveOutput();
    };

    const seedTerminal = (text: string, seq = 0, cols?: number, rows?: number, options: { force?: boolean } = {}) => {
        const force = !!options.force;
        if (!force && seq > 0 && seededSnapshotSeqRef.current >= seq) return;
        if (!force && seq === 0 && liveOutputStartedRef.current) return;
        seededSnapshotSeqRef.current = seq;
        if (seq > 0) setMayHaveOlderRuntimeScrollback(true);
        setRuntimeReady(true);
        setRuntimeStatusMessage('');
        if (typeof cols === 'number' && typeof rows === 'number' && cols > 0 && rows > 0) {
            terminalRef.current?.resize?.(cols, rows);
        }
        pendingLiveOutputRef.current = '';
        terminalRef.current?.reset?.();
        if (text) enqueueTerminalWrite(text);
        else finishScrollbackReplayIfNeeded();
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
                        force: !!event.force,
                    };
                    return;
                }
                seedTerminal(event.text || '', event.seq || 0, event.cols, event.rows, { force: !!event.force });
                return;
            }
            if (event.type === 'session_output') {
                liveOutputStartedRef.current = true;
                if (typeof event.seq === 'number') {
                    seededSnapshotSeqRef.current = Math.max(seededSnapshotSeqRef.current, event.seq);
                    if (event.seq > 0) setMayHaveOlderRuntimeScrollback(true);
                }
                if (!runtimeReadyRef.current) setRuntimeReady(true);
                if (!runtimeReadyRef.current) setRuntimeStatusMessage('');
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
                return;
            }
            if (event.type === 'session_io_error') {
                const detail = typeof event.error === 'string' && event.error
                    ? event.error
                    : (typeof event.reason === 'string' && event.reason ? event.reason : 'unknown error');
                setRuntimeReady(false);
                setRuntimeStatusMessage(`Runtime input failed: ${detail}`);
                return;
            }
        }, daemonRouteId) || (() => {});

        return () => {
            unsubRuntime();
        };
    }, [daemonRouteId, sessionId, terminalRef, isVisible]);

    const requestRuntimeSnapshot = async (options: { sinceSeq?: number; force?: boolean; loadingMessage?: string; preserveStatus?: boolean } = {}) => {
        if (!daemonRouteId || !sessionId) return { success: false as const, error: 'daemonId and sessionId are required' };
        if (!options.preserveStatus) setRuntimeStatusMessage(options.loadingMessage || 'Loading runtime terminal...');
        try {
            const snapshotResult = await connectionManager.requestRuntimeSnapshot?.(daemonRouteId, sessionId, {
                sinceSeq: options.sinceSeq,
                force: options.force,
            });
            if (snapshotResult && snapshotResult.success === false) {
                if (!options.preserveStatus) {
                    setRuntimeReady(false);
                    setRuntimeStatusMessage(`Runtime terminal unavailable: ${snapshotResult.error}`);
                }
                return snapshotResult;
            }
            return snapshotResult || { success: true as const };
        } catch (error: any) {
            const message = error?.message || String(error);
            if (!options.preserveStatus) {
                setRuntimeReady(false);
                setRuntimeStatusMessage(`Runtime terminal unavailable: ${message}`);
            }
            return { success: false as const, error: message };
        }
    };

    const copyTextToClipboard = async (text: string): Promise<boolean> => {
        const ownerDocument = terminalViewportRef.current?.ownerDocument || document;
        const ownerWindow = ownerDocument.defaultView || window;
        const clipboard = ownerWindow.navigator?.clipboard;
        if (clipboard?.writeText && ownerWindow.isSecureContext) {
            try {
                await clipboard.writeText(text);
                return true;
            } catch {}
        }
        let textarea: HTMLTextAreaElement | null = null;
        try {
            textarea = ownerDocument.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', 'true');
            textarea.style.position = 'fixed';
            textarea.style.left = '-9999px';
            textarea.style.top = '0';
            ownerDocument.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            return ownerDocument.execCommand('copy');
        } catch {
            return false;
        } finally {
            textarea?.remove();
        }
    };

    const setTransientCopyStatus = (message: string) => {
        clearCopyStatusTimeout();
        setCopyStatusMessage(message);
        const ownerWindow = getOwnerWindow();
        copyStatusTimeoutRef.current = {
            ownerWindow,
            timeoutId: ownerWindow.setTimeout(() => {
                copyStatusTimeoutRef.current = null;
                setCopyStatusMessage((current) => (current === message ? null : current));
            }, 2200),
        };
    };

    const setTransientScrollbackStatus = (message: string) => {
        clearScrollbackStatusTimeout();
        setScrollbackStatusMessage(message);
        const ownerWindow = getOwnerWindow();
        scrollbackStatusTimeoutRef.current = {
            ownerWindow,
            timeoutId: ownerWindow.setTimeout(() => {
                scrollbackStatusTimeoutRef.current = null;
                setScrollbackStatusMessage((current) => (current === message ? null : current));
            }, 2200),
        };
    };

    const copyCurrentTerminalText = async () => {
        const selection = terminalRef.current?.getSelection?.() || '';
        const visibleText = terminalRef.current?.getVisibleText?.() || '';
        const text = (selection.trimEnd() || visibleText.trimEnd());
        if (!text) {
            setTransientCopyStatus('Nothing to copy');
            return;
        }
        const copied = await copyTextToClipboard(text);
        if (!copied) {
            setTransientCopyStatus('Copy failed');
            return;
        }
        setTransientCopyStatus(selection.trimEnd() ? 'Copied selection' : 'Copied visible terminal');
    };

    const sendTerminalControlInput = (data: string) => {
        if (!runtimeReady || !isVisible) return;
        const sent = sendPtyInput?.(daemonRouteId, sessionId, data) ?? false;
        if (!sent) {
            setTransientCopyStatus('Terminal input failed');
        }
    };

    // Encode a logical key with the currently-active sticky modifiers, send it,
    // then clear the modifiers (one-shot: the toggle resets after each keypress).
    const sendEncodedKey = (key: string) => {
        sendTerminalControlInput(encodeTerminalKey({ ctrl: stickyCtrl, alt: stickyAlt, shift: stickyShift }, key));
        setStickyCtrl(false);
        setStickyAlt(false);
        setStickyShift(false);
    };

    const loadOlderRuntimeScrollback = async () => {
        if (isLoadingScrollback) return;
        setIsLoadingScrollback(true);
        setScrollbackStatusMessage('Loading older terminal output...');
        pendingScrollToTopAfterReplayRef.current = true;
        const result = await requestRuntimeSnapshot({
            sinceSeq: 0,
            force: true,
            loadingMessage: 'Loading older terminal output...',
            preserveStatus: runtimeReady,
        });
        setIsLoadingScrollback(false);
        if (result?.success === false) {
            pendingScrollToTopAfterReplayRef.current = false;
            setScrollbackStatusMessage(`Older terminal output unavailable: ${result.error}`);
            return;
        }
        setHasLoadedOlderRuntimeScrollback(true);
        setTransientScrollbackStatus('Older terminal output loaded');
        scheduleInOwnerWindow(() => {
            terminalRef.current?.bumpResize();
        });
    };

    useEffect(() => {
        if (!sessionId) return;

        if (daemonRouteId && connectionManager.getState?.(daemonRouteId) === 'connected') {
            void requestRuntimeSnapshot();
        }

        const unsubState = connectionManager.onStateChange?.((connectedDaemonId: string, state: string) => {
            if (connectedDaemonId !== daemonRouteId || state !== 'connected') return;
            void requestRuntimeSnapshot();
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
        if (!isManualZoomedIn) return;
        anchorZoomViewportBottomLeft();
    }, [isManualZoomedIn, scaledTerminalHeight, scaledTerminalWidth]);

    useEffect(() => {
        const wasVisible = previousIsVisibleRef.current;
        previousIsVisibleRef.current = isVisible;

        if (!isVisible) {
            return;
        }

        if (!wasVisible) {
            setHasLoadedOlderRuntimeScrollback(false);
        }

        if (pendingHiddenClearRef.current) {
            pendingHiddenClearRef.current = false;
            clearRuntimeView();
        }

        const pendingSnapshot = pendingHiddenSnapshotRef.current;
        if (pendingSnapshot) {
            pendingHiddenSnapshotRef.current = null;
            seedTerminal(pendingSnapshot.text, pendingSnapshot.seq, pendingSnapshot.cols, pendingSnapshot.rows, { force: !!pendingSnapshot.force });
        }

        if (daemonRouteId && sessionId && connectionManager.getState?.(daemonRouteId) === 'connected') {
            void requestRuntimeSnapshot();
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
            clearCopyStatusTimeout();
            clearScrollbackStatusTimeout();
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

    const shouldOfferOlderScrollbackLoad = runtimeReady
        && mayHaveOlderRuntimeScrollback
        && !hasLoadedOlderRuntimeScrollback
        && (terminalScrollMetrics.atTop || !terminalScrollMetrics.canScroll);
    const shouldShowOlderScrollbackLoader = shouldOfferOlderScrollbackLoad || isLoadingScrollback || !!scrollbackStatusMessage;

    return (
        <>
            {/* Terminal */}
            <div ref={terminalViewportRef} className="flex-1 min-h-0 p-2 bg-[#0f1117] relative">
                {shouldShowOlderScrollbackLoader && (
                    <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
                        <button
                            type="button"
                            className="h-8 rounded-full border border-white/10 bg-black/35 px-3 text-2xs font-medium text-white/85 backdrop-blur-sm transition-colors hover:bg-black/55 disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={() => { void loadOlderRuntimeScrollback(); }}
                            disabled={!sessionId || isLoadingScrollback}
                            title="Replay raw session scrollback so the terminal viewport can scroll farther up"
                        >
                            {isLoadingScrollback ? t('terminal.loadingOlder') : t('terminal.loadOlderOutput')}
                        </button>
                        {scrollbackStatusMessage && (
                            <span className="rounded-full border border-white/10 bg-black/35 px-2 py-1 text-3xs text-white/70 backdrop-blur-sm">
                                {scrollbackStatusMessage}
                            </span>
                        )}
                    </div>
                )}
                <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5">
                    {copyStatusMessage && (
                        <span className="rounded-full border border-white/10 bg-black/35 px-2 py-1 text-3xs text-white/70 backdrop-blur-sm">
                            {copyStatusMessage}
                        </span>
                    )}
                    <button
                        type="button"
                        className="h-8 rounded-full border border-white/10 bg-black/35 px-3 text-2xs font-semibold text-white/85 backdrop-blur-sm transition-colors hover:bg-black/55"
                        onClick={() => setShowSpecDebug(v => !v)}
                        title="Spec debug — inspect current state, sections, and transition history"
                    >
                        {t('terminal.debug')}
                    </button>
                    <button
                        type="button"
                        className="h-8 rounded-full border border-white/10 bg-black/35 px-3 text-2xs font-semibold text-white/85 backdrop-blur-sm transition-colors hover:bg-black/55 disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={() => { void copyCurrentTerminalText(); }}
                        disabled={!runtimeReady}
                        title="Copy selected terminal text, or the visible terminal viewport if nothing is selected"
                    >
                        {t('terminal.copy')}
                    </button>
                    <div className="relative">
                        <button
                            type="button"
                            className="h-8 rounded-full border border-white/10 bg-black/35 px-3 text-2xs font-semibold text-white/85 backdrop-blur-sm transition-colors hover:bg-black/55 disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={() => setTerminalControlsOpen((open) => !open)}
                            disabled={!runtimeReady}
                            aria-label={terminalControlsOpen ? t('terminal.closeControlKeys') : t('terminal.openControlKeys')}
                            aria-expanded={terminalControlsOpen}
                            aria-controls="terminal-control-keys-popover"
                            title="Open mobile-friendly terminal control keys"
                        >
                            Keys
                        </button>
                        {terminalControlsOpen && (
                            <div
                                id="terminal-control-keys-popover"
                                role="dialog"
                                aria-label={t('terminal.openControlKeys')}
                                className="absolute right-0 top-10 w-72 rounded-2xl border border-white/10 bg-[#0b0d12]/95 p-3 text-white/85 shadow-2xl shadow-black/40 backdrop-blur-md"
                            >
                                <div className="mb-2 flex items-center justify-between gap-2">
                                    <span className="text-3xs font-semibold uppercase tracking-[0.14em] text-white/45">Terminal keys</span>
                                    <button
                                        type="button"
                                        className="rounded-full px-2 py-0.5 text-2xs text-white/55 transition-colors hover:bg-white/10 hover:text-white/85"
                                        onClick={() => setTerminalControlsOpen(false)}
                                        aria-label={t('terminal.closeControlKeys')}
                                    >
                                        ×
                                    </button>
                                </div>
                                {/* Sticky modifiers — toggle on, apply to the next key press, then auto-clear (one-shot). */}
                                <div className="mb-2 grid grid-cols-3 gap-1.5">
                                    {([
                                        ['Ctrl', stickyCtrl, setStickyCtrl],
                                        ['Alt', stickyAlt, setStickyAlt],
                                        ['Shift', stickyShift, setStickyShift],
                                    ] as const).map(([label, active, setActive]) => (
                                        <button
                                            key={label}
                                            type="button"
                                            aria-pressed={active}
                                            className={`h-9 rounded-lg border text-xs font-semibold transition-colors ${
                                                active
                                                    ? 'border-sky-400/50 bg-sky-400/25 text-white'
                                                    : 'border-white/10 bg-white/[0.06] hover:bg-white/[0.12]'
                                            }`}
                                            onClick={() => setActive((on) => !on)}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                                <div className="my-2 h-px bg-white/10" />
                                {/* Function keys — also modifier-aware (e.g. Ctrl+Arrow, Shift+Tab). */}
                                <div className="grid grid-cols-3 gap-1.5">
                                    <button type="button" className="h-9 rounded-lg border border-white/10 bg-white/[0.06] text-xs font-semibold hover:bg-white/[0.12]" onClick={() => sendEncodedKey('Escape')}>Esc</button>
                                    <button type="button" className="h-9 rounded-lg border border-white/10 bg-white/[0.06] text-xs font-semibold hover:bg-white/[0.12]" onClick={() => sendEncodedKey('Tab')}>Tab</button>
                                    <button type="button" className="h-9 rounded-lg border border-white/10 bg-white/[0.06] text-xs font-semibold hover:bg-white/[0.12]" onClick={() => sendEncodedKey('Enter')}>Enter</button>
                                    <span aria-hidden="true" />
                                    <button type="button" className="h-9 rounded-lg border border-white/10 bg-white/[0.06] text-[15px] font-semibold hover:bg-white/[0.12]" onClick={() => sendEncodedKey('ArrowUp')} aria-label="Arrow up">↑</button>
                                    <span aria-hidden="true" />
                                    <button type="button" className="h-9 rounded-lg border border-white/10 bg-white/[0.06] text-[15px] font-semibold hover:bg-white/[0.12]" onClick={() => sendEncodedKey('ArrowLeft')} aria-label="Arrow left">←</button>
                                    <button type="button" className="h-9 rounded-lg border border-white/10 bg-white/[0.06] text-[15px] font-semibold hover:bg-white/[0.12]" onClick={() => sendEncodedKey('ArrowDown')} aria-label="Arrow down">↓</button>
                                    <button type="button" className="h-9 rounded-lg border border-white/10 bg-white/[0.06] text-[15px] font-semibold hover:bg-white/[0.12]" onClick={() => sendEncodedKey('ArrowRight')} aria-label="Arrow right">→</button>
                                    <button type="button" className="h-9 rounded-lg border border-white/10 bg-white/[0.06] text-xs font-semibold hover:bg-white/[0.12]" onClick={() => sendTerminalControlInput('\u0003')} title="Send SIGINT (Ctrl-C)">Ctrl-C</button>
                                    <button type="button" className="h-9 rounded-lg border border-white/10 bg-white/[0.06] text-xs font-semibold hover:bg-white/[0.12]" onClick={() => sendEncodedKey('Space')}>Space</button>
                                    <button type="button" className="h-9 rounded-lg border border-white/10 bg-white/[0.06] text-xs font-semibold hover:bg-white/[0.12]" onClick={() => sendEncodedKey('Backspace')}>Bksp</button>
                                </div>
                            </div>
                        )}
                    </div>
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
                                onScrollMetrics={setTerminalScrollMetrics}
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
                    <div className="absolute inset-x-2 top-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-2xs text-red-300 pointer-events-none">
                        {runtimeStatusMessage}
                    </div>
                )}
            </div>

            <ChatInputBar
                contextKey={activeConv.tabKey}
                panelLabel={getConversationTitle(activeConv)}
                isSending={isSendingChat}
                isBusy={!!sendBlockMessage}
                statusMessage={inputStatusMessage}
                inlineStatusMessage={inputInlineMessage}
                onSend={async (message) => {
                    if (sendBlockMessage) return false;
                    return handleSendChat(message);
                }}
                isActive={isInputActive && isVisible}
                showControlsToggle={false}
                animateVisibility={false}
            />
            {showSpecDebug && (
                <SpecDebugPanel
                    activeConv={activeConv}
                    onClose={() => setShowSpecDebug(false)}
                />
            )}
        </>
    );
}
