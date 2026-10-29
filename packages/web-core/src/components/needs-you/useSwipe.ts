/**
 * Horizontal card swipe for the mobile "Needs you" list (design §6.2): right = answer with the
 * recommended option, left = later. Touch/pen only (a mouse drag must keep selecting text), and
 * buttons stay the primary, accessible path — swipe is a shortcut on top of them.
 */
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

export const SWIPE_THRESHOLD_PX = 80

/** Commit direction of a finished drag: horizontal must dominate and pass the threshold. */
export function resolveSwipe(dx: number, dy: number, threshold: number = SWIPE_THRESHOLD_PX): 'right' | 'left' | null {
    if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.5) return null
    return dx > 0 ? 'right' : 'left'
}

export interface SwipeHandlers {
    onPointerDown: (e: ReactPointerEvent) => void
    onPointerMove: (e: ReactPointerEvent) => void
    onPointerUp: (e: ReactPointerEvent) => void
    onPointerCancel: (e: ReactPointerEvent) => void
}

export function useSwipe(opts: {
    enabled: boolean
    onRight?: () => void
    onLeft?: () => void
}): { handlers: SwipeHandlers; offset: number } {
    const start = useRef<{ x: number; y: number } | null>(null)
    const [offset, setOffset] = useState(0)
    const optsRef = useRef(opts)
    optsRef.current = opts

    const onPointerDown = useCallback((e: ReactPointerEvent) => {
        if (!optsRef.current.enabled || e.pointerType === 'mouse') return
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        start.current = { x: e.clientX, y: e.clientY }
    }, [])
    const onPointerMove = useCallback((e: ReactPointerEvent) => {
        const s = start.current
        if (!s) return
        const dx = e.clientX - s.x
        const dy = e.clientY - s.y
        setOffset(Math.abs(dx) > Math.abs(dy) * 1.5 ? Math.max(-140, Math.min(140, dx)) : 0)
    }, [])
    const finish = useCallback((e: ReactPointerEvent, commit: boolean) => {
        const s = start.current
        start.current = null
        setOffset(0)
        if (!s || !commit) return
        const dir = resolveSwipe(e.clientX - s.x, e.clientY - s.y)
        if (dir === 'right') optsRef.current.onRight?.()
        else if (dir === 'left') optsRef.current.onLeft?.()
    }, [])
    const onPointerUp = useCallback((e: ReactPointerEvent) => finish(e, true), [finish])
    const onPointerCancel = useCallback((e: ReactPointerEvent) => finish(e, false), [finish])
    return { handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }, offset }
}
