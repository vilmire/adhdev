import { useEffect, useRef } from 'react'

declare global {
    interface Window {
        __ADHDEV_DEBUG_RENDERS__?: boolean
    }
}

function isTraceEnabled() {
    if (typeof window === 'undefined') return false
    try {
        return window.__ADHDEV_DEBUG_RENDERS__ === true || window.localStorage.getItem('adhdev_debug_renders') === '1'
    } catch {
        return window.__ADHDEV_DEBUG_RENDERS__ === true
    }
}

function summarize(value: unknown) {
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'string') return value.length > 64 ? `${value.slice(0, 61)}...` : value
    if (Array.isArray(value)) return `Array(${value.length})`
    if (typeof value === 'object') return 'Object'
    return typeof value
}

export function useDevRenderTrace(name: string, props: Record<string, unknown>) {
    const prevRef = useRef<Record<string, unknown> | null>(null)
    const renderCountRef = useRef(0)

    useEffect(() => {
        if (!isTraceEnabled()) return

        renderCountRef.current += 1
        const prev = prevRef.current
        if (!prev) {
            console.debug(`[render-trace] ${name}#${renderCountRef.current}`, {
                changed: ['mount'],
                snapshot: Object.fromEntries(Object.entries(props).map(([key, value]) => [key, summarize(value)])),
            })
            prevRef.current = props
            return
        }

        const changed = Object.keys({ ...prev, ...props }).filter(key => !Object.is(prev[key], props[key]))
        if (changed.length > 0) {
            console.debug(`[render-trace] ${name}#${renderCountRef.current}`, {
                changed,
                snapshot: Object.fromEntries(changed.map(key => [key, summarize(props[key])])),
            })
        }
        prevRef.current = props
    })
}
