/**
 * Opt-in debug-surface gates. Same shape as useDevRenderTrace's isTraceEnabled:
 * a `window.__ADHDEV_DEBUG_*__` global (settable from devtools without a
 * reload) or a persisted `localStorage` flag (survives reloads). Both default
 * OFF — these gate surfaces that either expose internal state to end users
 * (G8-11: the CLI terminal's Spec Debug panel) or run a side-effecting action
 * from an easy-to-trigger gesture (G8-12: Android long-press collecting a
 * debug bundle and overwriting the clipboard).
 */

declare global {
    interface Window {
        __ADHDEV_DEBUG_SPEC__?: boolean
        __ADHDEV_DEBUG_MOBILE_BUNDLE__?: boolean
        __ADHDEV_DEBUG_CONN__?: boolean
    }
}

function isFlagEnabled(globalKey: '__ADHDEV_DEBUG_SPEC__' | '__ADHDEV_DEBUG_MOBILE_BUNDLE__' | '__ADHDEV_DEBUG_CONN__', storageKey: string): boolean {
    if (typeof window === 'undefined') return false
    try {
        return window[globalKey] === true || window.localStorage.getItem(storageKey) === '1'
    } catch {
        return window[globalKey] === true
    }
}

/** Gates the CLI terminal pane's "Debug" button (spec state/section/transition inspector). */
export function isSpecDebugEnabled(): boolean {
    return isFlagEnabled('__ADHDEV_DEBUG_SPEC__', 'adhdev_debug_spec')
}

/** Gates the mobile inbox long-press → collect debug bundle + overwrite clipboard action. */
export function isMobileDebugBundleEnabled(): boolean {
    return isFlagEnabled('__ADHDEV_DEBUG_MOBILE_BUNDLE__', 'adhdev_debug_mobile_bundle')
}

/**
 * Gates verbose connection/push diagnostic console.log output (O8): P2P/WS
 * state machines, TURN acquisition, push subscription, and the public share
 * viewer — which previously dumped WS message types/keys/senders to anonymous
 * visitors (G10-3). Error paths keep unconditional console.warn/console.error.
 */
export function isConnDebugEnabled(): boolean {
    return isFlagEnabled('__ADHDEV_DEBUG_CONN__', 'adhdev_debug_conn')
}

/** console.log that only emits when the connection-debug flag is on. */
export function connDebugLog(...args: unknown[]): void {
    if (isConnDebugEnabled()) console.log(...args)
}
