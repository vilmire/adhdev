import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react'

type InputMode = 'touch' | 'mouse'
type CursorPos = { nx: number; ny: number }

interface UseRemoteTouchControlsOptions {
    containerRef: RefObject<HTMLDivElement>
    viewportRef: RefObject<HTMLDivElement>
    imgRef: RefObject<HTMLImageElement>
    inputMode: InputMode
    setInputMode: Dispatch<SetStateAction<InputMode>>
    minZoom: number
    zoomRef: MutableRefObject<number>
    panXRef: MutableRefObject<number>
    panYRef: MutableRefObject<number>
    setPanX: Dispatch<SetStateAction<number>>
    setPanY: Dispatch<SetStateAction<number>>
    setZoom: Dispatch<SetStateAction<number>>
    lastWheelTimeRef: MutableRefObject<number>
    onAction: (action: string, params: any) => Promise<any>
    setLastActionStatus: Dispatch<SetStateAction<string | null>>
    spawnRippleFromNormalized: (nx: number, ny: number, type: 'left' | 'right' | 'double') => void
    clampPan: (newPanX: number, newPanY: number, currentZoom: number) => { x: number; y: number }
    isMobile: boolean
    mobileFillZoom: number
}

export function useRemoteTouchControls({
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
    lastWheelTimeRef,
    onAction,
    setLastActionStatus,
    spawnRippleFromNormalized,
    clampPan,
    isMobile,
    mobileFillZoom,
}: UseRemoteTouchControlsOptions) {
    const [cursorPos, setCursorPos] = useState<CursorPos | null>(null)
    const cursorPosRef = useRef<CursorPos | null>(null)
    const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null)
    const touchLastRef = useRef<{ x: number; y: number } | null>(null)
    const isPanningRef = useRef(false)
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const lastTapTimeRef = useRef<number>(0)
    const pinchStartDistRef = useRef<number | null>(null)
    const pinchStartZoomRef = useRef<number>(1)
    const pinchMidRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
    const wasPinchingRef = useRef(false)
    const inputModeRef = useRef<InputMode>(inputMode)
    const onActionRef = useRef(onAction)

    const ensureMouseCursor = () => {
        if (cursorPosRef.current) return
        const initial = { nx: 0.5, ny: 0.5 }
        cursorPosRef.current = initial
        setCursorPos(initial)
    }

    useEffect(() => {
        inputModeRef.current = inputMode
        if (inputMode === 'mouse') ensureMouseCursor()
    }, [inputMode])

    useEffect(() => {
        onActionRef.current = onAction
    }, [onAction])

    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const getTouchImgPos = (touch: Touch) => {
            if (!imgRef.current) return null
            const rect = imgRef.current.getBoundingClientRect()
            if (!rect.width || !rect.height) return null
            return {
                nx: Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width)),
                ny: Math.max(0, Math.min(1, (touch.clientY - rect.top) / rect.height)),
            }
        }

        const fingerDeltaToCursorDelta = (dx: number, dy: number) => {
            if (!imgRef.current) return { dnx: 0, dny: 0 }
            const img = imgRef.current
            const rect = img.getBoundingClientRect()
            const natW = img.naturalWidth || rect.width
            const natH = img.naturalHeight || rect.height
            const imgAspect = natW / natH
            const elemAspect = rect.width / rect.height
            let renderedW: number
            let renderedH: number

            if (imgAspect > elemAspect) {
                renderedW = rect.width
                renderedH = rect.width / imgAspect
            } else {
                renderedH = rect.height
                renderedW = rect.height * imgAspect
            }

            return {
                dnx: dx / renderedW,
                dny: dy / renderedH,
            }
        }

        const autoPanTowardsCursor = (nx: number, ny: number, currentZoom: number) => {
            if (currentZoom <= 1.05) return
            const targetPanX = -(nx - 0.5) * 100
            const targetPanY = -(ny - 0.5) * 100
            const clamped = clampPan(targetPanX, targetPanY, currentZoom)
            if (Math.abs(clamped.x - panXRef.current) > 0.1 || Math.abs(clamped.y - panYRef.current) > 0.1) {
                setPanX(clamped.x)
                setPanY(clamped.y)
                panXRef.current = clamped.x
                panYRef.current = clamped.y
            }
        }

        const handleTouchStart = (event: TouchEvent) => {
            const viewport = viewportRef.current
            if (viewport && event.target instanceof Node && viewport.contains(event.target as Node)) {
                event.preventDefault()
            } else {
                return
            }

            if (event.touches.length === 1) {
                const touch = event.touches[0]
                touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() }
                touchLastRef.current = { x: touch.clientX, y: touch.clientY }

                if (!wasPinchingRef.current) {
                    isPanningRef.current = false
                }

                longPressTimerRef.current = setTimeout(() => {
                    if (!isPanningRef.current && !wasPinchingRef.current) {
                        isPanningRef.current = true
                        if (inputModeRef.current === 'mouse') {
                            const pos = cursorPosRef.current || { nx: 0.5, ny: 0.5 }
                            setLastActionStatus('Right Click')
                            spawnRippleFromNormalized(pos.nx, pos.ny, 'right')
                            onActionRef.current('input_click', { ...pos, button: 'right' }).catch(() => {})
                        } else {
                            const pos = getTouchImgPos(touch)
                            if (pos) {
                                setLastActionStatus('Right Click')
                                spawnRippleFromNormalized(pos.nx, pos.ny, 'right')
                                onActionRef.current('input_click', { ...pos, button: 'right' }).catch(() => {})
                            }
                        }
                    }
                }, 500)
                return
            }

            if (event.touches.length === 2) {
                if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
                isPanningRef.current = true
                wasPinchingRef.current = true
                const dx = event.touches[1].clientX - event.touches[0].clientX
                const dy = event.touches[1].clientY - event.touches[0].clientY
                pinchStartDistRef.current = Math.sqrt(dx * dx + dy * dy)
                pinchStartZoomRef.current = zoomRef.current
                pinchMidRef.current = {
                    x: (event.touches[0].clientX + event.touches[1].clientX) / 2,
                    y: (event.touches[0].clientY + event.touches[1].clientY) / 2,
                }
            }
        }

        const handleTouchMove = (event: TouchEvent) => {
            const viewport = viewportRef.current
            if (viewport && event.target instanceof Node && viewport.contains(event.target as Node)) {
                event.preventDefault()
            }

            if (event.touches.length === 1 && touchLastRef.current) {
                const touch = event.touches[0]
                const dx = touch.clientX - touchLastRef.current.x
                const dy = touch.clientY - touchLastRef.current.y

                if (!isPanningRef.current && touchStartRef.current) {
                    const totalDx = touch.clientX - touchStartRef.current.x
                    const totalDy = touch.clientY - touchStartRef.current.y
                    const totalDist = Math.sqrt(totalDx * totalDx + totalDy * totalDy)
                    if (totalDist > 8) {
                        isPanningRef.current = true
                        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
                    }
                }

                if (isPanningRef.current) {
                    if (inputModeRef.current === 'mouse') {
                        const delta = fingerDeltaToCursorDelta(dx, dy)
                        const prev = cursorPosRef.current || { nx: 0.5, ny: 0.5 }
                        const newNx = Math.max(0, Math.min(1, prev.nx + delta.dnx))
                        const newNy = Math.max(0, Math.min(1, prev.ny + delta.dny))
                        cursorPosRef.current = { nx: newNx, ny: newNy }
                        setCursorPos({ nx: newNx, ny: newNy })
                        setLastActionStatus(`Cursor: ${Math.round(newNx * 100)}%, ${Math.round(newNy * 100)}%`)

                        autoPanTowardsCursor(newNx, newNy, zoomRef.current)

                        const now = Date.now()
                        if (now - lastWheelTimeRef.current >= 30) {
                            lastWheelTimeRef.current = now
                            onActionRef.current('input_mouseMoved', { nx: newNx, ny: newNy }).catch(() => {})
                        }
                    } else if (zoomRef.current > 1.0) {
                        const nextViewport = viewportRef.current
                        if (nextViewport) {
                            const vw = nextViewport.clientWidth
                            const vh = nextViewport.clientHeight
                            const newPanX = panXRef.current + (dx / vw) * 100
                            const newPanY = panYRef.current + (dy / vh) * 100
                            const clamped = clampPan(newPanX, newPanY, zoomRef.current)
                            setPanX(clamped.x)
                            setPanY(clamped.y)
                            panXRef.current = clamped.x
                            panYRef.current = clamped.y
                        }
                    } else {
                        const pos = getTouchImgPos(touch)
                        if (pos) {
                            const now = Date.now()
                            if (now - lastWheelTimeRef.current >= 40) {
                                lastWheelTimeRef.current = now
                                setLastActionStatus('Scroll')
                                onActionRef.current('input_wheel', {
                                    nx: pos.nx,
                                    ny: pos.ny,
                                    deltaX: Math.round(-dx * 2.5),
                                    deltaY: Math.round(-dy * 2.5),
                                }).catch(() => {})
                            }
                        }
                    }
                }

                touchLastRef.current = { x: touch.clientX, y: touch.clientY }
                return
            }

            if (event.touches.length === 2 && pinchStartDistRef.current !== null) {
                const dx = event.touches[1].clientX - event.touches[0].clientX
                const dy = event.touches[1].clientY - event.touches[0].clientY
                const dist = Math.sqrt(dx * dx + dy * dy)
                const scale = dist / pinchStartDistRef.current
                const midX = (event.touches[0].clientX + event.touches[1].clientX) / 2
                const midY = (event.touches[0].clientY + event.touches[1].clientY) / 2
                const dMidX = midX - pinchMidRef.current.x
                const dMidY = midY - pinchMidRef.current.y
                const isPinching = Math.abs(scale - 1) > 0.03

                if (inputModeRef.current === 'mouse') {
                    if (isPinching) {
                        const newZoom = Math.max(minZoom, Math.min(5, pinchStartZoomRef.current * scale))
                        setZoom(newZoom)
                        zoomRef.current = newZoom
                    } else if (Math.abs(dMidX) > 2 || Math.abs(dMidY) > 2) {
                        const pos = cursorPosRef.current || { nx: 0.5, ny: 0.5 }
                        const now = Date.now()
                        if (now - lastWheelTimeRef.current >= 30) {
                            lastWheelTimeRef.current = now
                            setLastActionStatus('Scroll')
                            onActionRef.current('input_wheel', {
                                nx: pos.nx,
                                ny: pos.ny,
                                deltaX: Math.round(-dMidX * 3),
                                deltaY: Math.round(-dMidY * 3),
                            }).catch(() => {})
                        }
                    }
                } else {
                    const newZoom = Math.max(minZoom, Math.min(5, pinchStartZoomRef.current * scale))
                    setZoom(newZoom)
                    zoomRef.current = newZoom

                    const nextViewport = viewportRef.current
                    if (nextViewport && newZoom > 1) {
                        const vw = nextViewport.clientWidth
                        const vh = nextViewport.clientHeight
                        const newPanX = panXRef.current + (dMidX / vw) * 100
                        const newPanY = panYRef.current + (dMidY / vh) * 100
                        const clamped = clampPan(newPanX, newPanY, newZoom)
                        setPanX(clamped.x)
                        setPanY(clamped.y)
                        panXRef.current = clamped.x
                        panYRef.current = clamped.y
                    }
                }

                pinchMidRef.current = { x: midX, y: midY }
            }
        }

        const handleTouchEnd = (event: TouchEvent) => {
            if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
            pinchStartDistRef.current = null

            if (event.touches.length === 1 && wasPinchingRef.current) {
                const remaining = event.touches[0]
                touchStartRef.current = { x: remaining.clientX, y: remaining.clientY, time: Date.now() }
                touchLastRef.current = { x: remaining.clientX, y: remaining.clientY }
                isPanningRef.current = true
                return
            }

            if (event.touches.length === 0) {
                if (wasPinchingRef.current) {
                    wasPinchingRef.current = false
                    isPanningRef.current = false
                    return
                }

                if (event.changedTouches.length === 1 && !isPanningRef.current) {
                    const touch = event.changedTouches[0]
                    const now = Date.now()
                    const elapsed = now - (touchStartRef.current?.time || 0)

                    if (elapsed < 60 || elapsed > 400) {
                        isPanningRef.current = false
                        return
                    }

                    if (touchStartRef.current) {
                        const totalDx = touch.clientX - touchStartRef.current.x
                        const totalDy = touch.clientY - touchStartRef.current.y
                        if (Math.sqrt(totalDx * totalDx + totalDy * totalDy) > 12) {
                            isPanningRef.current = false
                            return
                        }
                    }

                    if (inputModeRef.current === 'mouse') {
                        const pos = cursorPosRef.current || getTouchImgPos(touch)
                        if (pos) {
                            setLastActionStatus(`Click: ${Math.round(pos.nx * 100)}%, ${Math.round(pos.ny * 100)}%`)
                            spawnRippleFromNormalized(pos.nx, pos.ny, 'left')
                            onActionRef.current('input_click', { ...pos }).catch(() => {})
                        }
                    } else {
                        const pos = getTouchImgPos(touch)
                        if (!pos) return
                        if (now - lastTapTimeRef.current < 300) {
                            setLastActionStatus('Double tap')
                            spawnRippleFromNormalized(pos.nx, pos.ny, 'double')
                            onActionRef.current('input_click', { ...pos, clickCount: 2 }).catch(() => {})
                            lastTapTimeRef.current = 0
                        } else {
                            setLastActionStatus(`Tap: ${Math.round(pos.nx * 100)}%, ${Math.round(pos.ny * 100)}%`)
                            spawnRippleFromNormalized(pos.nx, pos.ny, 'left')
                            onActionRef.current('input_click', { ...pos }).catch(() => {})
                            lastTapTimeRef.current = now
                        }
                    }
                }
                isPanningRef.current = false
            }
        }

        container.addEventListener('touchstart', handleTouchStart, { passive: false })
        container.addEventListener('touchmove', handleTouchMove, { passive: false })
        container.addEventListener('touchend', handleTouchEnd, { passive: false })

        return () => {
            container.removeEventListener('touchstart', handleTouchStart)
            container.removeEventListener('touchmove', handleTouchMove)
            container.removeEventListener('touchend', handleTouchEnd)
            if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
        }
    }, [
        containerRef,
        viewportRef,
        imgRef,
        minZoom,
        zoomRef,
        panXRef,
        panYRef,
        setPanX,
        setPanY,
        setZoom,
        lastWheelTimeRef,
        setLastActionStatus,
        spawnRippleFromNormalized,
        clampPan,
    ])

    const handleToggleInputMode = () => {
        setInputMode(prev => {
            const next = prev === 'touch' ? 'mouse' : 'touch'
            if (next === 'mouse') ensureMouseCursor()
            return next
        })
    }

    const handleZoomReset = () => {
        const resetZoom = isMobile ? mobileFillZoom : 1.0
        setZoom(resetZoom)
        zoomRef.current = resetZoom
        setPanX(0)
        setPanY(0)
        panXRef.current = 0
        panYRef.current = 0
    }

    return {
        cursorPos,
        cursorPosRef,
        handleToggleInputMode,
        handleZoomReset,
    }
}
