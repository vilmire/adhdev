/**
 * Holds the first render until the boot language's catalog is loaded.
 *
 * Only `en` ships in the main bundle (see config.ts); a `ko`/`ja`/… boot fetches
 * its catalog first. Rendering the app before that would paint English and then
 * swap — this gate shows the host's loading screen instead. An `en` boot (or a
 * catalog already loaded) is ready synchronously, so it renders children on the
 * very first pass with no extra frame.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { isI18nReady, whenI18nReady } from './config'

export interface I18nReadyGateProps {
    children: ReactNode
    /** Shown while the chosen locale is loading. */
    fallback?: ReactNode
}

export function I18nReadyGate({ children, fallback = null }: I18nReadyGateProps) {
    const [ready, setReady] = useState(isI18nReady)

    useEffect(() => {
        if (ready) return
        let alive = true
        void whenI18nReady().then(() => {
            if (alive) setReady(true)
        })
        return () => {
            alive = false
        }
    }, [ready])

    return <>{ready ? children : fallback}</>
}
