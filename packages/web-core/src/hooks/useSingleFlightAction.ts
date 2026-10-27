import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * One-at-a-time runner for tap actions (assistant chips, hidden-tab rows).
 *
 * - `run(key, fn)` starts `fn` unless another action is in flight; a dropped
 *   tap returns `false` and never calls `fn`, so a double tap cannot send twice.
 * - A synchronous `fn` never latches. An async one latches until it settles;
 *   `pendingKey` names the running action so its control can show a spinner.
 * - `cancel()` aborts the signal handed to `fn` and releases the latch at
 *   once. It is local: an `fn` that ignores the signal still runs to its end,
 *   only its settle no longer touches the latch (a newer flight is never
 *   cleared by an older one's late settle).
 *
 * Nothing here touches caller state such as a composer draft — callers keep
 * their own state, which is how a chip tap leaves the typed draft alone.
 */
export interface SingleFlightAction {
    pendingKey: string | null
    run: (key: string, fn: (signal: AbortSignal) => unknown) => boolean
    cancel: () => void
}

export function useSingleFlightAction(): SingleFlightAction {
    const [pendingKey, setPendingKey] = useState<string | null>(null)
    const currentRef = useRef<{ token: number; controller: AbortController } | null>(null)
    const tokenRef = useRef(0)
    const mountedRef = useRef(true)

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            currentRef.current?.controller.abort()
            currentRef.current = null
        }
    }, [])

    const release = useCallback((token: number) => {
        if (currentRef.current?.token !== token) return
        currentRef.current = null
        if (mountedRef.current) setPendingKey(null)
    }, [])

    const run = useCallback((key: string, fn: (signal: AbortSignal) => unknown) => {
        if (currentRef.current) return false
        const token = ++tokenRef.current
        const controller = new AbortController()
        currentRef.current = { token, controller }
        let result: unknown
        try {
            result = fn(controller.signal)
        } catch (error) {
            console.warn('[single-flight] action failed', error)
            release(token)
            return true
        }
        if (!result || typeof (result as PromiseLike<unknown>).then !== 'function') {
            release(token)
            return true
        }
        setPendingKey(key)
        Promise.resolve(result).then(
            () => release(token),
            (error) => {
                if (!controller.signal.aborted) console.warn('[single-flight] action failed', error)
                release(token)
            },
        )
        return true
    }, [release])

    const cancel = useCallback(() => {
        const current = currentRef.current
        if (!current) return
        current.controller.abort()
        release(current.token)
    }, [release])

    return { pendingKey, run, cancel }
}
