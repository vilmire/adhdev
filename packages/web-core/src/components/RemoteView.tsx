import { useRef, useEffect, useState, KeyboardEvent, MouseEvent } from 'react';

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
    const onActionRef = useRef(onAction);

    // Touch control refs
    const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
    const touchLastRef = useRef<{ x: number; y: number } | null>(null);
    const isPanningRef = useRef(false);
    const longPressTimerRef = useRef<any>(null);
    const lastTapTimeRef = useRef<number>(0);
    const pinchStartDistRef = useRef<number | null>(null);
    const pinchStartZoomRef = useRef<number>(1);
    const pinchMidRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const wasPinchingRef = useRef(false);  // Tracks if we were in a pinch gesture (suppresses accidental clicks)
    const zoomRef = useRef(zoom);
    const panXRef = useRef(panX);
    const panYRef = useRef(panY);
    const inputModeRef = useRef(inputMode);

    useEffect(() => { zoomRef.current = zoom; }, [zoom]);
    useEffect(() => { panXRef.current = panX; }, [panX]);
    useEffect(() => { panYRef.current = panY; }, [panY]);
    useEffect(() => { onActionRef.current = onAction; }, [onAction]);
    useEffect(() => { inputModeRef.current = inputMode; }, [inputMode]);

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

    // ─── Touch Controls (mobile) ───────────────────────────────────────────────
    // Mouse cursor state (Google Remote Desktop style)
    const [cursorPos, setCursorPos] = useState<{ nx: number; ny: number } | null>(null);
    const cursorPosRef = useRef<{ nx: number; ny: number } | null>(null);

    // Initialize cursor to center when entering mouse mode
    useEffect(() => {
        if (inputMode === 'mouse' && !cursorPosRef.current) {
            const initial = { nx: 0.5, ny: 0.5 };
            cursorPosRef.current = initial;
            setCursorPos(initial);
        }
    }, [inputMode]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const getTouchImgPos = (touch: Touch) => {
            if (!imgRef.current) return null;
            const rect = imgRef.current.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;
            return {
                nx: Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width)),
                ny: Math.max(0, Math.min(1, (touch.clientY - rect.top) / rect.height)),
            };
        };

        // Google Remote Desktop: convert finger delta (px) to cursor delta (normalized)
        const fingerDeltaToCursorDelta = (dx: number, dy: number) => {
            if (!imgRef.current) return { dnx: 0, dny: 0 };
            const img = imgRef.current;
            const rect = img.getBoundingClientRect();
            // Account for object-fit:contain — actual image may be smaller than element
            const natW = img.naturalWidth || rect.width;
            const natH = img.naturalHeight || rect.height;
            const imgAspect = natW / natH;
            const elemAspect = rect.width / rect.height;
            let renderedW: number, renderedH: number;
            if (imgAspect > elemAspect) {
                // Image is wider → width fills, height has bars
                renderedW = rect.width;
                renderedH = rect.width / imgAspect;
            } else {
                // Image is taller → height fills, width has bars
                renderedH = rect.height;
                renderedW = rect.height * imgAspect;
            }
            return {
                dnx: dx / renderedW,
                dny: dy / renderedH,
            };
        };

        // Auto-pan: center viewport on cursor when zoomed
        const autoPanTowardsCursor = (nx: number, ny: number, currentZoom: number) => {
            if (currentZoom <= 1.05) return;
            // Center viewport on cursor. translate% is relative to scaled size,
            // so we just need -(nx - 0.5) * 100 (no zoom multiply needed)
            const targetPanX = -(nx - 0.5) * 100;
            const targetPanY = -(ny - 0.5) * 100;
            const clamped = clampPan(targetPanX, targetPanY, currentZoom);
            if (Math.abs(clamped.x - panXRef.current) > 0.1 || Math.abs(clamped.y - panYRef.current) > 0.1) {
                setPanX(clamped.x);
                setPanY(clamped.y);
                panXRef.current = clamped.x;
                panYRef.current = clamped.y;
            }
        };

        const handleTouchStart = (e: TouchEvent) => {
            // Only block browser defaults for touches inside the viewport (image area).
            // Toolbar/popover buttons must receive native touch→click conversion.
            const vp = viewportRef.current;
            if (vp && e.target instanceof Node && vp.contains(e.target as Node)) {
                e.preventDefault();
            } else {
                return; // Let toolbar handle its own events
            }

            if (e.touches.length === 1) {
                const touch = e.touches[0];
                touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
                touchLastRef.current = { x: touch.clientX, y: touch.clientY };
                // Only reset panning if this is a fresh touch (not leftover from pinch)
                if (!wasPinchingRef.current) {
                    isPanningRef.current = false;
                }

                // Long press (500ms) → right click
                longPressTimerRef.current = setTimeout(() => {
                    if (!isPanningRef.current && !wasPinchingRef.current) {
                        isPanningRef.current = true; // Prevent click on release
                        if (inputModeRef.current === 'mouse') {
                            const pos = cursorPosRef.current || { nx: 0.5, ny: 0.5 };
                            setLastActionStatus(`Right Click`);
                            spawnRippleFromNormalized(pos.nx, pos.ny, 'right');
                            onActionRef.current('input_click', { ...pos, button: 'right' }).catch(() => {});
                        } else {
                            const pos = getTouchImgPos(touch);
                            if (pos) {
                                setLastActionStatus(`Right Click`);
                                spawnRippleFromNormalized(pos.nx, pos.ny, 'right');
                                onActionRef.current('input_click', { ...pos, button: 'right' }).catch(() => {});
                            }
                        }
                    }
                }, 500);
            } else if (e.touches.length === 2) {
                clearTimeout(longPressTimerRef.current);
                isPanningRef.current = true;
                wasPinchingRef.current = true; // Mark that we entered pinch mode
                const dx = e.touches[1].clientX - e.touches[0].clientX;
                const dy = e.touches[1].clientY - e.touches[0].clientY;
                pinchStartDistRef.current = Math.sqrt(dx * dx + dy * dy);
                pinchStartZoomRef.current = zoomRef.current;
                pinchMidRef.current = {
                    x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                    y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
                };
            }
        };

        const handleTouchMove = (e: TouchEvent) => {
            // Only prevent default scrolling inside viewport
            const vp = viewportRef.current;
            if (vp && e.target instanceof Node && vp.contains(e.target as Node)) {
                e.preventDefault();
            }

            if (e.touches.length === 1 && touchLastRef.current) {
                const touch = e.touches[0];
                const dx = touch.clientX - touchLastRef.current.x;
                const dy = touch.clientY - touchLastRef.current.y;

                // Drag threshold: use cumulative distance from START (not per-frame)
                // This prevents slow gradual drags from being misread as taps
                if (!isPanningRef.current && touchStartRef.current) {
                    const totalDx = touch.clientX - touchStartRef.current.x;
                    const totalDy = touch.clientY - touchStartRef.current.y;
                    const totalDist = Math.sqrt(totalDx * totalDx + totalDy * totalDy);
                    if (totalDist > 8) {
                        isPanningRef.current = true;
                        clearTimeout(longPressTimerRef.current);
                    }
                }

                if (isPanningRef.current) {
                    if (inputModeRef.current === 'mouse') {
                        // Mouse mode: drag → move cursor
                        const delta = fingerDeltaToCursorDelta(dx, dy);
                        const prev = cursorPosRef.current || { nx: 0.5, ny: 0.5 };
                        const newNx = Math.max(0, Math.min(1, prev.nx + delta.dnx));
                        const newNy = Math.max(0, Math.min(1, prev.ny + delta.dny));
                        cursorPosRef.current = { nx: newNx, ny: newNy };
                        setCursorPos({ nx: newNx, ny: newNy });
                        setLastActionStatus(`Cursor: ${Math.round(newNx * 100)}%, ${Math.round(newNy * 100)}%`);

                        autoPanTowardsCursor(newNx, newNy, zoomRef.current);

                        const now = Date.now();
                        if (now - lastWheelTime.current >= 30) {
                            lastWheelTime.current = now;
                            onActionRef.current('input_mouseMoved', { nx: newNx, ny: newNy }).catch(() => {});
                        }
                    } else if (zoomRef.current > 1.0) {
                        // Touch mode + zoomed: pan viewport
                        const viewport = viewportRef.current;
                        if (viewport) {
                            const vw = viewport.clientWidth;
                            const vh = viewport.clientHeight;
                            const newPanX = panXRef.current + (dx / vw) * 100;
                            const newPanY = panYRef.current + (dy / vh) * 100;
                            const clamped = clampPan(newPanX, newPanY, zoomRef.current);
                            setPanX(clamped.x);
                            setPanY(clamped.y);
                            panXRef.current = clamped.x;
                            panYRef.current = clamped.y;
                        }
                    } else {
                        // Touch mode + 1x: remote scroll
                        const pos = getTouchImgPos(touch);
                        if (pos) {
                            const now = Date.now();
                            if (now - lastWheelTime.current >= 40) {
                                lastWheelTime.current = now;
                                setLastActionStatus('Scroll');
                                onActionRef.current('input_wheel', {
                                    nx: pos.nx, ny: pos.ny,
                                    deltaX: Math.round(-dx * 2.5),
                                    deltaY: Math.round(-dy * 2.5),
                                }).catch(() => {});
                            }
                        }
                    }
                }
                touchLastRef.current = { x: touch.clientX, y: touch.clientY };
            } else if (e.touches.length === 2 && pinchStartDistRef.current !== null) {
                const dx = e.touches[1].clientX - e.touches[0].clientX;
                const dy = e.touches[1].clientY - e.touches[0].clientY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const scale = dist / pinchStartDistRef.current;

                const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                const dMidX = midX - pinchMidRef.current.x;
                const dMidY = midY - pinchMidRef.current.y;

                const isPinching = Math.abs(scale - 1) > 0.03;

                if (inputModeRef.current === 'mouse') {
                    if (isPinching) {
                        // Pinch → zoom only
                        const newZoom = Math.max(minZoom, Math.min(5, pinchStartZoomRef.current * scale));
                        setZoom(newZoom);
                        zoomRef.current = newZoom;
                    } else if (Math.abs(dMidX) > 2 || Math.abs(dMidY) > 2) {
                        // Parallel drag → scroll only
                        const pos = cursorPosRef.current || { nx: 0.5, ny: 0.5 };
                        const now = Date.now();
                        if (now - lastWheelTime.current >= 30) {
                            lastWheelTime.current = now;
                            setLastActionStatus('Scroll');
                            onActionRef.current('input_wheel', {
                                nx: pos.nx, ny: pos.ny,
                                deltaX: Math.round(-dMidX * 3),
                                deltaY: Math.round(-dMidY * 3),
                            }).catch(() => {});
                        }
                    }
                } else {
                    // Touch mode: always pinch zoom + pan
                    const newZoom = Math.max(minZoom, Math.min(5, pinchStartZoomRef.current * scale));
                    setZoom(newZoom);
                    zoomRef.current = newZoom;

                    const viewport = viewportRef.current;
                    if (viewport && newZoom > 1) {
                        const vw = viewport.clientWidth;
                        const vh = viewport.clientHeight;
                        const newPanX = panXRef.current + (dMidX / vw) * 100;
                        const newPanY = panYRef.current + (dMidY / vh) * 100;
                        const clamped = clampPan(newPanX, newPanY, newZoom);
                        setPanX(clamped.x);
                        setPanY(clamped.y);
                        panXRef.current = clamped.x;
                        panYRef.current = clamped.y;
                    }
                }
                pinchMidRef.current = { x: midX, y: midY };
            }
        };

        const handleTouchEnd = (e: TouchEvent) => {
            clearTimeout(longPressTimerRef.current);
            pinchStartDistRef.current = null;

            // If going from 2 fingers to 1 (pinch ending), suppress the remaining finger
            if (e.touches.length === 1 && wasPinchingRef.current) {
                // One finger still down after pinch — update refs but do NOT reset isPanning
                const remaining = e.touches[0];
                touchStartRef.current = { x: remaining.clientX, y: remaining.clientY, time: Date.now() };
                touchLastRef.current = { x: remaining.clientX, y: remaining.clientY };
                isPanningRef.current = true; // Force-suppress any click on this finger's release
                return;
            }

            // All fingers lifted
            if (e.touches.length === 0) {
                // If we were pinching, suppress click and reset flag
                if (wasPinchingRef.current) {
                    wasPinchingRef.current = false;
                    isPanningRef.current = false;
                    return;
                }

                if (e.changedTouches.length === 1 && !isPanningRef.current) {
                    const touch = e.changedTouches[0];
                    const now = Date.now();
                    const elapsed = now - (touchStartRef.current?.time || 0);

                    // Tap guard: too fast (<60ms) or too slow (>400ms) → ignore
                    if (elapsed < 60 || elapsed > 400) {
                        isPanningRef.current = false;
                        return;
                    }

                    // Final distance check: finger must not have moved far from start
                    if (touchStartRef.current) {
                        const totalDx = touch.clientX - touchStartRef.current.x;
                        const totalDy = touch.clientY - touchStartRef.current.y;
                        if (Math.sqrt(totalDx * totalDx + totalDy * totalDy) > 12) {
                            isPanningRef.current = false;
                            return;
                        }
                    }

                    if (inputModeRef.current === 'mouse') {
                        // Mouse mode: tap → click at CURSOR position (not finger position)
                        const pos = cursorPosRef.current || getTouchImgPos(touch);
                        if (pos) {
                            setLastActionStatus(`Click: ${Math.round(pos.nx * 100)}%, ${Math.round(pos.ny * 100)}%`);
                            spawnRippleFromNormalized(pos.nx, pos.ny, 'left');
                            onActionRef.current('input_click', { ...pos }).catch(() => {});
                        }
                    } else {
                        // Touch mode: tap directly
                        const pos = getTouchImgPos(touch);
                        if (!pos) return;
                        if (now - lastTapTimeRef.current < 300) {
                            setLastActionStatus('Double tap');
                            spawnRippleFromNormalized(pos.nx, pos.ny, 'double');
                            onActionRef.current('input_click', { ...pos, clickCount: 2 }).catch(() => {});
                            lastTapTimeRef.current = 0;
                        } else {
                            setLastActionStatus(`Tap: ${Math.round(pos.nx * 100)}%, ${Math.round(pos.ny * 100)}%`);
                            spawnRippleFromNormalized(pos.nx, pos.ny, 'left');
                            onActionRef.current('input_click', { ...pos }).catch(() => {});
                            lastTapTimeRef.current = now;
                        }
                    }
                }
                // Always reset panning state at end of touch
                isPanningRef.current = false;
            }
        };

        container.addEventListener('touchstart', handleTouchStart, { passive: false });
        container.addEventListener('touchmove', handleTouchMove, { passive: false });
        container.addEventListener('touchend', handleTouchEnd, { passive: false });
        return () => {
            container.removeEventListener('touchstart', handleTouchStart);
            container.removeEventListener('touchmove', handleTouchMove);
            container.removeEventListener('touchend', handleTouchEnd);
            clearTimeout(longPressTimerRef.current);
        };
    }, []);

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
                    <div className="text-center flex flex-col items-center gap-3 px-6">
                        <div
                            className="w-14 h-14 rounded-2xl flex items-center justify-center border border-white/10 bg-white/[0.04] shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
                            style={{ animation: 'remote-float 2.8s ease-in-out infinite' }}
                        >
                            <img src="/otter-logo.png" alt="" className="w-8 h-8 opacity-90" />
                        </div>
                        <div className="text-white/85 text-[13px] font-semibold tracking-wide">{waitingLabel}</div>
                        <div className="text-[11px] text-white/40">{waitingHint}</div>
                        {transportType === 'relay' && (
                            <div className="text-[10px] text-amber-300/80">TURN relay active</div>
                        )}
                    </div>
                )}

                {/* Virtual cursor indicator (mouse mode) */}
                {inputMode === 'mouse' && cursorPos && displayScreenshot && imgRef.current && (() => {
                    const img = imgRef.current!;
                    const rect = img.getBoundingClientRect();
                    const viewRect = viewportRef.current?.getBoundingClientRect();
                    if (!viewRect) return null;
                    // Account for object-fit:contain letterboxing
                    const natW = img.naturalWidth || rect.width;
                    const natH = img.naturalHeight || rect.height;
                    const imgAspect = natW / natH;
                    const elemAspect = rect.width / rect.height;
                    let renderedW: number, renderedH: number, offsetX: number, offsetY: number;
                    if (imgAspect > elemAspect) {
                        renderedW = rect.width;
                        renderedH = rect.width / imgAspect;
                        offsetX = 0;
                        offsetY = (rect.height - renderedH) / 2;
                    } else {
                        renderedH = rect.height;
                        renderedW = rect.height * imgAspect;
                        offsetX = (rect.width - renderedW) / 2;
                        offsetY = 0;
                    }
                    const cx = rect.left - viewRect.left + offsetX + renderedW * cursorPos.nx;
                    const cy = rect.top - viewRect.top + offsetY + renderedH * cursorPos.ny;
                    // Clamp to viewport so cursor never leaves mobile screen
                    const clampedCx = Math.max(8, Math.min(viewRect.width - 8, cx));
                    const clampedCy = Math.max(8, Math.min(viewRect.height - 8, cy));
                    return (
                        <div style={{
                            position: 'absolute', left: clampedCx - 8, top: clampedCy - 8,
                            width: 16, height: 16, pointerEvents: 'none', zIndex: 100,
                        }}>
                            {/* Crosshair */}
                            <div style={{ position: 'absolute', left: 7, top: 0, width: 2, height: 16, background: 'rgba(59,130,246,0.8)' }} />
                            <div style={{ position: 'absolute', left: 0, top: 7, width: 16, height: 2, background: 'rgba(59,130,246,0.8)' }} />
                            {/* Center dot */}
                            <div style={{
                                position: 'absolute', left: 5, top: 5, width: 6, height: 6,
                                borderRadius: '50%', background: '#3b82f6',
                                boxShadow: '0 0 8px rgba(59,130,246,0.6)',
                            }} />
                        </div>
                    );
                })()}

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

            {/* Bottom Toolbar (horizontal, always visible) */}
            <div
                onTouchStart={e => e.stopPropagation()}
                className="absolute bottom-0 left-0 right-0 z-20 flex items-center justify-center gap-1.5 px-3 py-2 bg-black/75 backdrop-blur-xl border-t border-white/[0.08] touch-none"
            >
                {/* Input Mode Toggle */}
                <div
                    onClick={() => {
                        setInputMode(m => {
                            const next = m === 'touch' ? 'mouse' : 'touch';
                            if (next === 'mouse' && !cursorPosRef.current) {
                                const init = { nx: 0.5, ny: 0.5 };
                                cursorPosRef.current = init;
                                setCursorPos(init);
                            }
                            return next;
                        });
                    }}
                    className={`h-8 px-2.5 rounded-lg flex items-center gap-[5px] cursor-pointer ${
                        inputMode === 'mouse' ? 'bg-blue-500/25 border border-blue-500/40' : 'bg-white/[0.08] border border-white/10'
                    }`}
                >
                    <span className="text-sm">{inputMode === 'mouse' ? '🖱️' : '👆'}</span>
                    <span className={`text-[10px] font-bold ${inputMode === 'mouse' ? 'text-blue-400' : 'text-slate-400'}`}>
                        {inputMode === 'mouse' ? 'Mouse' : 'Touch'}
                    </span>
                </div>

                {/* IME */}
                <div className="relative">
                    <div
                        onClick={() => { setIsImeOpen(!isImeOpen); setIsMenuOpen(false); }}
                        className={`w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer ${
                            isImeOpen ? 'bg-emerald-500/25 border border-emerald-500/40' : 'bg-white/[0.08] border border-white/10'
                        }`}
                    >
                        <span className="text-sm">⌨️</span>
                    </div>
                    {isImeOpen && (
                        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 w-[220px] bg-neutral-950/[0.98] backdrop-blur-[30px] rounded-xl border border-white/20 p-[10px_12px] shadow-[0_10px_30px_rgba(0,0,0,0.8)] flex flex-col gap-2 z-20" style={{ animation: 'slideUp 0.15s ease-out' }}>
                            <input
                                type="text" placeholder="Type & Enter..." value={imeText} autoFocus
                                onTouchStart={e => e.stopPropagation()}
                                onChange={e => setImeText(e.target.value)} onKeyDown={handleImeSubmit}
                                className="w-full bg-black/60 border border-white/15 rounded-lg px-2.5 py-2 text-white text-[13px] outline-none"
                            />
                        </div>
                    )}
                </div>

                {/* Settings */}
                <div className="relative">
                    <div
                        onClick={() => { setIsMenuOpen(!isMenuOpen); setIsImeOpen(false); }}
                        className={`w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer ${
                            isMenuOpen ? 'bg-blue-500/25 border border-blue-500/40' : 'bg-white/[0.08] border border-white/10'
                        }`}
                    >
                        <span className="text-sm">⚙️</span>
                    </div>
                </div>

                {/* Separator */}
                <div className="w-px h-[18px] bg-white/10" />

                {/* Status indicators */}
                <div className="flex items-center gap-1.5">
                    <div
                        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md"
                        style={{ background: isConnActive ? 'rgba(34,197,94,0.12)' : 'rgba(234,179,8,0.12)' }}
                    >
                        <div className="w-1 h-1 rounded-full" style={{ background: isConnActive ? '#22c55e' : '#eab308', boxShadow: isConnActive ? '0 0 4px #22c55e80' : '0 0 4px #eab30880' }} />
                        <span className="text-[8px] font-extrabold" style={{ color: isConnActive ? '#22c55e' : '#eab308' }}>
                            {isConnActive ? 'Connected' : 'WS'}
                        </span>
                    </div>
                    {zoom > 1.0 && (
                        <span className="text-[8px] font-bold text-indigo-400">{Math.round(zoom * 100)}%</span>
                    )}
                    {transportType === 'direct' && (
                        <span
                            className="text-[8px] font-bold px-1 py-0.5 rounded"
                            style={{ color: '#22c55e', background: 'rgba(34,197,94,0.12)' }}
                            title="Direct P2P connection"
                        >
                            Direct
                        </span>
                    )}
                    {transportType === 'relay' && (
                        <span
                            className="text-[8px] font-bold px-1 py-0.5 rounded"
                            style={{ color: '#f59e0b', background: 'rgba(245,158,11,0.12)' }}
                            title="TURN relay in use"
                        >
                            Relay
                        </span>
                    )}
                    {screenshotUsage && screenshotUsage.dailyBudgetMinutes > 0 && (
                        <span
                            className="text-[8px] font-bold px-1 py-0.5 rounded"
                            style={{
                                color: screenshotUsage.budgetExhausted ? '#ef4444' : '#c4b5fd',
                                background: screenshotUsage.budgetExhausted ? 'rgba(239,68,68,0.1)' : 'rgba(139,92,246,0.14)',
                            }}
                            title="Daily TURN relay usage"
                        >
                            {screenshotUsage.budgetExhausted
                                ? 'TURN blocked'
                                : `TURN ${screenshotUsage.dailyUsedMinutes}/${screenshotUsage.dailyBudgetMinutes}m`}
                        </span>
                    )}
                    {lastActionStatus && (
                        <span className="text-[8px] text-neutral-500 font-semibold max-w-[100px] overflow-hidden text-ellipsis whitespace-nowrap">{lastActionStatus}</span>
                    )}
                </div>
            </div>

            {/* Settings Popover (displayed from toolbar gear icon) */}
            {isMenuOpen && (
                <div
                    onTouchStart={e => e.stopPropagation()}
                    style={{
                        position: 'absolute', bottom: 56, left: '50%', transform: 'translateX(-50%)', width: 220,
                        background: 'rgba(23, 23, 23, 0.95)', backdropFilter: 'blur(25px)',
                        borderRadius: 14, border: '1px solid rgba(255,255,255,0.1)',
                        padding: 14, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
                        display: 'flex', flexDirection: 'column', gap: 12,
                        zIndex: 20, touchAction: 'none',
                        animation: 'slideUpSidebar 0.15s ease-out'
                    }}
                >
                    <div style={{ fontSize: 9, fontWeight: 900, color: '#3b82f6', letterSpacing: 1.5 }}>SETTINGS</div>

                    {/* Zoom Controls */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ fontSize: 10, color: '#888', fontWeight: 700 }}>ZOOM: {zoom <= (isMobile ? mobileFillZoom : 1.0) + 0.01 ? (isMobile ? 'FILL' : 'FIT') : `${Math.round(zoom * 100)}%`}</div>
                        <div style={{ display: 'flex', gap: 4 }}>
                            <button onClick={(e) => { e.stopPropagation(); setZoom(prev => Math.max(0.5, prev - 0.25)); }} style={{ flex: 1, background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', padding: '6px', borderRadius: 6, fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>−</button>
                            <button onClick={(e) => { e.stopPropagation(); const resetZ = isMobile ? mobileFillZoom : 1.0; setZoom(resetZ); zoomRef.current = resetZ; setPanX(0); setPanY(0); }} style={{ flex: 1, background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', padding: '6px', borderRadius: 6, fontSize: 9, fontWeight: 800, cursor: 'pointer' }}>{isMobile ? 'FILL' : 'FIT'}</button>
                            <button onClick={(e) => { e.stopPropagation(); setZoom(prev => Math.min(5, prev + 0.25)); }} style={{ flex: 1, background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', padding: '6px', borderRadius: 6, fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>+</button>
                        </div>
                    </div>


                </div>
            )}

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
