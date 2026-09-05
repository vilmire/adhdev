/**
 * (SHELL-FRESHNESS) Detect that the SPA shell running in this tab is older than
 * the deployed build, and let the user choose to reload.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * `index.html` is served `no-cache, no-store` and the service worker has no
 * fetch handler, so this is NOT a cache bug — and treating it as one is the
 * trap. `no-store` governs how a document is FETCHED; it says nothing about a
 * document already parsed and executing. A dashboard left open for hours keeps
 * running whatever bundle it loaded at open time, and nothing ever tells it a
 * new one exists. `build-info.json` was already being emitted by the build
 * (`packages/web-cloud/vite.config.ts`) and no client had ever read it.
 *
 * ── Why the banner never reloads on its own ────────────────────────────────
 * A forced reload would discard whatever the user is in the middle of — an
 * unsent chat message, a scrolled transcript, an open modal. The staleness is
 * hours old by the time we notice; it is never so urgent that it outranks the
 * user's in-flight work. So this hook only ever REPORTS, and the reload is a
 * click.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

declare const __APP_VERSION__: string

/**
 * How often to re-check while the tab is open and visible. Deliberately long:
 * a deploy the user learns about 30 minutes late costs nothing, whereas a
 * chatty poll multiplied by every open dashboard tab is real load for a signal
 * that changes a few times a day at most.
 */
export const SHELL_FRESHNESS_POLL_MS = 30 * 60 * 1000

/**
 * Floor between checks, whatever the trigger. `visibilitychange` and `pageshow`
 * both fire on a single phone unlock (and can fire repeatedly while a user
 * flicks between apps), so without this a background→foreground bounce would
 * issue a burst of requests.
 */
export const SHELL_FRESHNESS_MIN_CHECK_INTERVAL_MS = 60 * 1000

export interface ShellBuildInfo {
    commit?: string
    shortCommit?: string
    packageVersion?: string
    buildTime?: string
    channel?: string
}

export interface ShellFreshnessState {
    /** True when the deployed build differs from the one running in this tab. */
    isStale: boolean
    /** Deployed build identity, once a check has succeeded. */
    deployed: ShellBuildInfo | null
    /** Build identity of the shell currently executing. */
    running: ShellBuildInfo
    /** Reload into the deployed build. Caller wires this to a button. */
    reload: () => void
    /** Force a check now (used by tests and by an explicit user action). */
    checkNow: () => Promise<void>
}

/**
 * Read the identity of the SHELL THAT IS RUNNING.
 *
 * The commit comes from the `<meta name="adhdev-build-commit">` tag that
 * `insertBuildIdentityMeta` stamps into the HTML at build time — it travels
 * with the document, so it describes the loaded shell rather than whatever is
 * currently deployed. `__APP_VERSION__` is compiled into the bundle and serves
 * the same purpose for the package version.
 */
export function readRunningBuildInfo(): ShellBuildInfo {
    const meta = (name: string): string | undefined => {
        if (typeof document === 'undefined') return undefined
        const el = document.querySelector(`meta[name="${name}"]`)
        const value = el?.getAttribute('content')?.trim()
        return value ? value : undefined
    }
    return {
        commit: meta('adhdev-build-commit'),
        packageVersion: typeof __APP_VERSION__ !== 'undefined'
            ? __APP_VERSION__
            : meta('adhdev-build-package-version'),
        buildTime: meta('adhdev-build-time'),
        channel: meta('adhdev-build-channel'),
    }
}

/**
 * Compare the running shell against the deployed one.
 *
 * ★ Fails CLOSED (returns false / "fresh") whenever the comparison is not
 * meaningful — an unknown commit, a missing field, a local dev build. A false
 * "update available" banner that will not go away after reloading is worse than
 * a missed one: it trains the user to ignore the banner entirely.
 */
export function isShellStale(running: ShellBuildInfo, deployed: ShellBuildInfo | null): boolean {
    if (!deployed) return false
    const runningCommit = running.commit
    const deployedCommit = deployed.commit
    if (
        runningCommit
        && deployedCommit
        && runningCommit !== 'unknown'
        && deployedCommit !== 'unknown'
    ) {
        return runningCommit !== deployedCommit
    }
    // No usable commit on one side (dev server, `unknown` stamp): fall back to
    // the package version, which is present in every real build.
    const runningVersion = running.packageVersion
    const deployedVersion = deployed.packageVersion
    if (runningVersion && deployedVersion) return runningVersion !== deployedVersion
    return false
}

export interface UseShellFreshnessOptions {
    /** Overridable for tests. Defaults to the app-root-relative build-info. */
    url?: string
    enabled?: boolean
    pollMs?: number
    minCheckIntervalMs?: number
    now?: () => number
    fetchImpl?: typeof fetch
    reloadImpl?: () => void
}

export function useShellFreshness(options: UseShellFreshnessOptions = {}): ShellFreshnessState {
    const {
        url = '/build-info.json',
        enabled = true,
        pollMs = SHELL_FRESHNESS_POLL_MS,
        minCheckIntervalMs = SHELL_FRESHNESS_MIN_CHECK_INTERVAL_MS,
        now = () => Date.now(),
        fetchImpl,
        reloadImpl,
    } = options

    const [deployed, setDeployed] = useState<ShellBuildInfo | null>(null)
    const runningRef = useRef<ShellBuildInfo | null>(null)
    if (runningRef.current === null) runningRef.current = readRunningBuildInfo()
    const running = runningRef.current

    const lastCheckAtRef = useRef(0)
    const inFlightRef = useRef<Promise<void> | null>(null)

    const checkNow = useCallback(async (): Promise<void> => {
        // Single-flight: a visibility flip that also crosses the poll deadline
        // must not issue two requests.
        if (inFlightRef.current) return inFlightRef.current
        const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : undefined)
        if (!doFetch) return
        const run = (async () => {
            try {
                // ★ `no-store` on the REQUEST as well. Without it a previously
                // cached build-info can satisfy the check and the detector
                // reports "fresh" forever — the same class of bug it exists to
                // catch, one level down.
                const res = await doFetch(url, { cache: 'no-store' })
                if (!res || !('ok' in res) || !res.ok) return
                const body = await res.json() as ShellBuildInfo | null
                if (body && typeof body === 'object') setDeployed(body)
            } catch {
                // Offline or a transient 5xx — leave the last known state alone
                // and let the next trigger retry. Never surface a fetch failure
                // as staleness.
            }
        })().finally(() => {
            inFlightRef.current = null
        })
        inFlightRef.current = run
        return run
    }, [fetchImpl, url])

    const maybeCheck = useCallback((force = false) => {
        const at = now()
        if (!force && at - lastCheckAtRef.current < minCheckIntervalMs) return
        lastCheckAtRef.current = at
        void checkNow()
    }, [checkNow, minCheckIntervalMs, now])

    useEffect(() => {
        if (!enabled) return
        maybeCheck(true)

        const onVisible = () => {
            if (typeof document === 'undefined') return
            if (document.visibilityState !== 'visible') return
            maybeCheck()
        }
        // `pageshow` covers the bfcache restore that `visibilitychange` misses —
        // the exact path an iOS Safari tab takes when the user returns to it
        // after hours in another app, which is where this was reported.
        const onPageShow = () => maybeCheck()

        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVisible)
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('pageshow', onPageShow)
        }
        const timer = setInterval(() => maybeCheck(), pollMs)
        return () => {
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', onVisible)
            }
            if (typeof window !== 'undefined') {
                window.removeEventListener('pageshow', onPageShow)
            }
            clearInterval(timer)
        }
    }, [enabled, maybeCheck, pollMs])

    const reload = useCallback(() => {
        if (reloadImpl) {
            reloadImpl()
            return
        }
        if (typeof window !== 'undefined') window.location.reload()
    }, [reloadImpl])

    return {
        isStale: isShellStale(running, deployed),
        deployed,
        running,
        reload,
        checkNow,
    }
}
