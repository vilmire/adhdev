import { useRef, useEffect, useState, KeyboardEvent, MouseEvent } from 'react';
import RemoteCursorOverlay from './remote/RemoteCursorOverlay';
import RemoteViewToolbar from './remote/RemoteViewToolbar';
import RemoteWaitingState from './remote/RemoteWaitingState';
import { useRemoteTouchControls } from '../hooks/useRemoteTouchControls';

/** Connection state */
type ConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed';

interface RemoteViewProps {
    /** Action dispatcher for remote input (click, key, scroll, etc.) */
    onAction: (action: string, params: any) => Promise<any>;
    /** Log callback for errors */
    addLog: (msg: string) => void;
    /** Connection state (P2P for cloud, WS adapter for standalone) */
    connState: ConnectionState;
    /** Screenshot received via connection (P2P or WS adapter) */
    connScreenshot: string | null;
    /** Screenshot usage stats from daemon status report */
    screenshotUsage?: { dailyUsedMinutes: number; dailyBudgetMinutes: number; budgetExhausted: boolean } | null;
    /** Current connection transport type for the active machine */
    transportType?: string;
}

type InputMode = 'touch' | 'mouse';

export default function RemoteView({ onAction, addLog, connState, connScreenshot, screenshotUsage, transportType }: RemoteViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);

    const [lastActionStatus, setLastActionStatus] = useState<string | null>(null);
    const [imeText, setImeText] = useState('');
    const [, setIsFocused] = useState(false);
    // Click ripple feedback
    const [ripples, setRipples] = useState<{ id: number; x: number; y: number; type: 'left' | 'right' | 'double' }[]>([]);
    const rippleIdRef = useRef(0);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [isImeOpen, setIsImeOpen] = useState(false);
    // Default to mouse mode on mobile
    const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
    const [inputMode, setInputMode] = useState<InputMode>(isMobile ? 'mouse' : 'touch');

    // Mobile cover mode: fill viewport, no black bars
    const [mobileFillZoom, setMobileFillZoom] = useState(1.0);
    const mobileFillApplied = useRef(false);

    // Transform state: zoom + pan (CSS transform based)
    const [zoom, setZoom] = useState(1.0);
    const [panX, setPanX] = useState(0);
    const [panY, setPanY] = useState(0);

    const lastWheelTime = useRef(0);
    const zoomRef = useRef(zoom);
    const panXRef = useRef(panX);
    const panYRef = useRef(panY);

    useEffect(() => { zoomRef.current = zoom; }, [zoom]);
    useEffect(() => { panXRef.current = panX; }, [panX]);
    useEffect(() => { panYRef.current = panY; }, [panY]);

    // Auto-focus on mount
    useEffect(() => { containerRef.current?.focus(); }, []);

    // Screenshot source: connection-based (P2P or WS adapter)
    const isConnActive = connState === 'connected';
    const displayScreenshot = connScreenshot;
    const waitingLabel = isConnActive
        ? 'Connected. Waiting for first frame...'
        : connState === 'connecting'
            ? 'Connecting to Host...'
            : 'Reconnecting to Host...';
    const waitingHint = isConnActive
        ? 'The remote stream is warming up'
        : 'Waiting for the remote stream to catch up';

    // Mobile: auto-calculate fill zoom when first screenshot arrives
    // This makes the image height fill the viewport so there are no black bars
    useEffect(() => {
        if (!isMobile || mobileFillApplied.current || !displayScreenshot) return;
        const img = imgRef.current;
        const vp = viewportRef.current;
        if (!img || !vp) return;
        const onLoad = () => {
            const vpW = vp.clientWidth;
            const vpH = vp.clientHeight;
            const natW = img.naturalWidth;
            const natH = img.naturalHeight;
            if (!natW || !natH || !vpW || !vpH) return;
            // "contain" scale = min(vpW/natW, vpH/natH)
            // "cover" scale = max(vpW/natW, vpH/natH)
            // fillZoom = cover / contain
            const containScale = Math.min(vpW / natW, vpH / natH);
            const coverScale = Math.max(vpW / natW, vpH / natH);
            const fillZ = coverScale / containScale;
            if (fillZ > 1.01) {
                setMobileFillZoom(fillZ);
                setZoom(fillZ);
                zoomRef.current = fillZ;
            }
            mobileFillApplied.current = true;
        };
        if (img.complete && img.naturalWidth) onLoad();
        else img.addEventListener('load', onLoad, { once: true });
    }, [displayScreenshot, isMobile]);

    // minZoom: allow zooming out freely (no forced fill lock)
    const minZoom = 0.5;

    // Reset pan when zoom returns to minimum
    useEffect(() => {
        if (zoom <= minZoom) {
            setPanX(0);
            setPanY(0);
        }
    }, [zoom, minZoom]);

    // Clamp pan to prevent scrolling out of bounds
    // CSS: transform: scale(Z) translate(X%, Y%) — translate is applied AFTER scale
    // So translate % is relative to the SCALED size. maxPan must account for this.
    const clampPan = (newPanX: number, newPanY: number, currentZoom: number) => {
        if (currentZoom <= minZoom) return { x: 0, y: 0 };
        const maxPanX = ((currentZoom - 1) / (2 * currentZoom)) * 100;
        const maxPanY = ((currentZoom - 1) / (2 * currentZoom)) * 100;
        return {
            x: Math.max(-maxPanX, Math.min(maxPanX, newPanX)),
            y: Math.max(-maxPanY, Math.min(maxPanY, newPanY)),
        };
    };


    // Image click → coordinate calculation (zoom/pan adjusted)
    const getImageNormalizedPos = (clientX: number, clientY: number) => {
        if (!imgRef.current) return null;
        const rect = imgRef.current.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return {
            nx: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
            ny: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
        };
    };

    // Spawn a ripple effect at viewport-relative coordinates
    const spawnRipple = (clientX: number, clientY: number, type: 'left' | 'right' | 'double') => {
        const vp = viewportRef.current;
        if (!vp) return;
        const vpRect = vp.getBoundingClientRect();
        const id = ++rippleIdRef.current;
        setRipples(prev => [...prev, { id, x: clientX - vpRect.left, y: clientY - vpRect.top, type }]);
        setTimeout(() => setRipples(prev => prev.filter(r => r.id !== id)), 600);
    };

    // Spawn ripple from normalized image coordinates (for touch/cursor mode)
    const spawnRippleFromNormalized = (nx: number, ny: number, type: 'left' | 'right' | 'double') => {
        const img = imgRef.current;
        const vp = viewportRef.current;
        if (!img || !vp) return;
        const imgRect = img.getBoundingClientRect();
        const vpRect = vp.getBoundingClientRect();
        // Account for object-fit:contain letterboxing
        const natW = img.naturalWidth || imgRect.width;
        const natH = img.naturalHeight || imgRect.height;
        const imgAspect = natW / natH;
        const elemAspect = imgRect.width / imgRect.height;
        let renderedW: number, renderedH: number, offsetX: number, offsetY: number;
        if (imgAspect > elemAspect) {
            renderedW = imgRect.width; renderedH = imgRect.width / imgAspect;
            offsetX = 0; offsetY = (imgRect.height - renderedH) / 2;
        } else {
            renderedH = imgRect.height; renderedW = imgRect.height * imgAspect;
            offsetX = (imgRect.width - renderedW) / 2; offsetY = 0;
        }
        const cx = imgRect.left - vpRect.left + offsetX + renderedW * nx;
        const cy = imgRect.top - vpRect.top + offsetY + renderedH * ny;
        const id = ++rippleIdRef.current;
        setRipples(prev => [...prev, { id, x: cx, y: cy, type }]);
        setTimeout(() => setRipples(prev => prev.filter(r => r.id !== id)), 600);
    };

    const handleImageClick = async (e: MouseEvent<HTMLImageElement>) => {
        const pos = getImageNormalizedPos(e.clientX, e.clientY);
        if (!pos) return;
        setLastActionStatus(`Click: ${Math.round(pos.nx * 100)}%, ${Math.round(pos.ny * 100)}%`);
        spawnRipple(e.clientX, e.clientY, 'left');
        containerRef.current?.focus();
        try {
            const res = await onAction('input_click', { nx: pos.nx, ny: pos.ny });
            if (!res?.success) addLog(`❌ Click failed: ${res?.error}`);
        } catch (err: any) { addLog(`❌ Click error: ${err.message || err}`); }
    };

    const sendRemoteKey = async (key: string, code: string, isChar: boolean, modifiers = 0) => {
        try {
            await onAction('input_key', {
                type: isChar ? 'char' : 'keyDown',
                key, code,
                text: isChar ? key : undefined,
                unmodifiedText: isChar ? key : undefined,
                modifiers
            });
        } catch (err: any) { addLog(`❌ Key error: ${err.message || err}`); }
    };

    const handleKeyDown = async (e: KeyboardEvent) => {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT') return;
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Tab', 'Enter', 'Escape'].includes(e.key)) {
            e.preventDefault();
        }
        let modifiers = 0;
        if (e.altKey) modifiers |= 1;
        if (e.ctrlKey) modifiers |= 2;
        if (e.metaKey) modifiers |= 4;
        if (e.shiftKey) modifiers |= 8;
        setLastActionStatus(`Key: ${e.key}`);
        await sendRemoteKey(e.key, e.code, e.key.length === 1, modifiers);
    };

    const handleImeSubmit = async (e: any) => {
        if (e.key === 'Enter') {
            if (e.nativeEvent.isComposing) return;
            if (imeText) {
                const textToSend = imeText;
                setImeText('');
                setLastActionStatus(`IME Sent: ${textToSend}`);
                try {
                    const res = await onAction('input_type', { text: textToSend });
                    if (!res?.success) addLog(`❌ IME error: ${res?.error}`);
                } catch (err: any) { addLog(`❌ IME error: ${err.message}`); }
            } else {
                setLastActionStatus(`Key: Enter`);
                await sendRemoteKey('Enter', 'Enter', false);
            }
        }
    };

    // Desktop wheel → remote scroll
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const handleNativeWheel = (e: any) => {
            if (imgRef.current?.contains(e.target)) {
                e.preventDefault();
                const now = Date.now();
                if (now - lastWheelTime.current < 40) return;
                lastWheelTime.current = now;
                const pos = getImageNormalizedPos(e.clientX, e.clientY);
                if (!pos) return;
                setLastActionStatus(`Scroll: ${Math.round(e.deltaY)}`);
                onAction('input_wheel', { nx: pos.nx, ny: pos.ny, deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY) }).catch(() => { });
            }
        };
        container.addEventListener('wheel', handleNativeWheel, { passive: false });
        return () => container.removeEventListener('wheel', handleNativeWheel);
    }, [onAction]);

    const {
        cursorPos,
        cursorPosRef,
        handleToggleInputMode,
        handleZoomReset,
    } = useRemoteTouchControls({
        containerRef,
        viewportRef,
        imgRef,
        inputMode,
        setInputMode,
        minZoom,
        zoomRef,
        panXRef,
        panYRef,
        setPanX,
        setPanY,
        setZoom,
        lastWheelTimeRef: lastWheelTime,
        onAction,
        setLastActionStatus,
        spawnRippleFromNormalized,
        clampPan,
        isMobile,
        mobileFillZoom,
    })

    return (
        <div
            ref={containerRef}
            className="flex-1 flex flex-col bg-black relative overflow-hidden outline-none touch-none"
            onKeyDown={handleKeyDown}
            onContextMenu={e => e.preventDefault()}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            tabIndex={0}
        >
            {/* Full Screen View Area */}
            <div ref={viewportRef} className="flex-1 relative overflow-hidden flex items-center justify-center bg-black">
                {displayScreenshot ? (
                    <img
                        ref={imgRef}
                        src={displayScreenshot}
                        alt="Remote View"
                        style={{
                            display: 'block',
                            maxWidth: '100%',
                            maxHeight: '100%',
                            width: 'auto',
                            height: 'auto',
                            transform: `scale(${zoom}) translate(${panX}%, ${panY}%)`,
                            transformOrigin: 'center center',
                            cursor: inputMode === 'mouse' ? 'default' : 'crosshair',
                            userSelect: 'none',
                            WebkitTouchCallout: 'none',
                        }}
                        onClick={handleImageClick}
                        onContextMenu={e => e.preventDefault()}
                        onDragStart={e => e.preventDefault()}
                    />
                ) : (
                    <RemoteWaitingState
                        waitingLabel={waitingLabel}
                        waitingHint={waitingHint}
                        transportType={transportType}
                    />
                )}

                {inputMode === 'mouse' && displayScreenshot && (
                    <RemoteCursorOverlay cursorPos={cursorPos} viewportRef={viewportRef} imgRef={imgRef} />
                )}

                {/* Click ripple feedback */}
                {ripples.map(r => {
                    const colorMap = { left: '59,130,246', right: '239,68,68', double: '34,197,94' };
                    const rgb = colorMap[r.type];
                    return (
                        <div key={r.id} style={{
                            position: 'absolute', left: r.x, top: r.y,
                            pointerEvents: 'none', zIndex: 200,
                            transform: 'translate(-50%, -50%)',
                        }}>
                            {/* Outer expanding ring */}
                            <div style={{
                                width: 40, height: 40,
                                borderRadius: '50%',
                                border: `2px solid rgba(${rgb}, 0.8)`,
                                animation: 'click-ripple-ring 0.5s ease-out forwards',
                                position: 'absolute', left: -20, top: -20,
                            }} />
                            {/* Inner flash dot */}
                            <div style={{
                                width: 8, height: 8,
                                borderRadius: '50%',
                                background: `rgba(${rgb}, 0.9)`,
                                boxShadow: `0 0 12px rgba(${rgb}, 0.6)`,
                                animation: 'click-ripple-dot 0.4s ease-out forwards',
                                position: 'absolute', left: -4, top: -4,
                            }} />
                        </div>
                    );
                })}
            </div>

            <RemoteViewToolbar
                inputMode={inputMode}
                onToggleInputMode={handleToggleInputMode}
                isImeOpen={isImeOpen}
                setIsImeOpen={setIsImeOpen}
                isMenuOpen={isMenuOpen}
                setIsMenuOpen={setIsMenuOpen}
                imeText={imeText}
                setImeText={setImeText}
                handleImeSubmit={handleImeSubmit}
                isConnActive={isConnActive}
                zoom={zoom}
                isMobile={isMobile}
                mobileFillZoom={mobileFillZoom}
                onZoomOut={() => setZoom(prev => Math.max(0.5, prev - 0.25))}
                onZoomReset={handleZoomReset}
                onZoomIn={() => setZoom(prev => Math.min(5, prev + 0.25))}
                transportType={transportType}
                screenshotUsage={screenshotUsage}
                lastActionStatus={lastActionStatus}
            />

            <style>{`
                @keyframes slideUp {
                    from { opacity: 0; transform: translateY(6px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes slideUpSidebar {
                    from { opacity: 0; transform: translateY(6px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes click-ripple-ring {
                    0% { transform: scale(0.3); opacity: 1; }
                    100% { transform: scale(2.2); opacity: 0; }
                }
                @keyframes click-ripple-dot {
                    0% { transform: scale(1); opacity: 0.9; }
                    50% { transform: scale(1.8); opacity: 0.6; }
                    100% { transform: scale(0.5); opacity: 0; }
                }
                @keyframes remote-float {
                    0% { transform: translateY(0px); }
                    50% { transform: translateY(-7px); }
                    100% { transform: translateY(0px); }
                }
            `}</style>
        </div>
    );
}
