import { useEffect, useRef, useState, type RefObject } from 'react'

/** How long the deep-linked mission row stays highlighted. */
export const MISSION_FOCUS_HIGHLIGHT_MS = 2500

/**
 * Mission deep link (`/mesh?...&mission=<id>`): once the row for `missionId` is in the DOM
 * (callers expand folded sections first), scroll it into view and highlight it briefly.
 * `renderKey` must change whenever the set of rendered rows can change (expansion state,
 * mission list), so the effect retries until the row exists. Handles each id once.
 */
export function useMissionFocus(
    missionId: string | undefined,
    containerRef: RefObject<HTMLElement | null>,
    renderKey: string,
): string | null {
    const [highlightId, setHighlightId] = useState<string | null>(null)
    const handledRef = useRef<string | null>(null)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
    useEffect(() => {
        if (!missionId || handledRef.current === missionId) return
        const root = containerRef.current
        if (!root) return
        const el = Array.from(root.querySelectorAll<HTMLElement>('[data-mission-row]')).find(n => n.dataset.missionRow === missionId)
        if (!el) return
        handledRef.current = missionId
        el.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
        setHighlightId(missionId)
        // Not cleaned up per effect run (renderKey changes would cancel the un-highlight); unmount clears it.
        timerRef.current = setTimeout(() => setHighlightId(null), MISSION_FOCUS_HIGHLIGHT_MS)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [missionId, renderKey])
    return highlightId
}
