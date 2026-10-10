/**
 * First-run onboarding gate — the decision, kept out of React so it is testable.
 *
 * The dialog means "no provider is ENABLED on this machine yet" (the daemon's
 * `machineProviders[type].enabled`, the same per-machine opt-in the Providers
 * tab toggles), read through `get_provider_settings` — the command that tab
 * already loads its rows from.
 *
 * It used to key on `GET /api/v1/providers/installed` returning zero rows. That
 * listing only saw `<providers>/.upstream`, which is empty on every
 * channel-store daemon (the default for a fresh config), so the dialog showed on
 * a fresh daemon for the wrong reason — and kept showing in every browser /
 * origin that had no localStorage marker, forever, even on a machine with
 * providers enabled and sessions running. Enablement is the fact a first-run
 * dialog is actually about: until something is enabled nothing can be launched.
 *
 * Fail closed: a non-OK reply (401 on a token-gated daemon, 403, 5xx), a refused
 * command, an unreadable body or a network error says nothing about enablement,
 * so it is never read as "zero enabled".
 */
import { standaloneFetch } from './standalone-auth-client'

const STORAGE_KEY = 'adhdev_onboarding_done'

/** The explicit "don't show again" marker: Skip, Done, or closing the dialog. */
export function hasCompletedOnboarding(): boolean {
    try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
}

export function markOnboardingCompleted(): void {
    try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* private mode — the gate still closes once a provider is enabled */ }
}

/**
 * Number of providers enabled on this machine in a `get_provider_settings`
 * reply, or null when the reply does not answer the question.
 */
export function countEnabledProviders(body: unknown): number | null {
    if (!body || typeof body !== 'object') return null
    const reply = body as { success?: unknown; values?: unknown }
    if (reply.success !== true) return null
    if (!reply.values || typeof reply.values !== 'object' || Array.isArray(reply.values)) return null
    let enabled = 0
    for (const values of Object.values(reply.values as Record<string, unknown>)) {
        if (values && typeof values === 'object' && (values as { enabled?: unknown }).enabled === true) enabled += 1
    }
    return enabled
}

type GateFetch = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>

/** Send one daemon command over the standalone HTTP API (same path the curl surface uses). */
export function postDaemonCommand(type: string, payload: Record<string, unknown>, fetchImpl: GateFetch = standaloneFetch) {
    return fetchImpl('/api/v1/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, payload }),
    })
}

export async function shouldShowOnboarding(options: {
    completed?: boolean
    fetchImpl?: GateFetch
} = {}): Promise<boolean> {
    if (options.completed ?? hasCompletedOnboarding()) return false
    try {
        const res = await postDaemonCommand('get_provider_settings', {}, options.fetchImpl)
        if (!res.ok) return false
        return countEnabledProviders(await res.json()) === 0
    } catch {
        return false
    }
}

export interface OnboardingSetupResult {
    type: string
    ok: boolean
    error?: string
}

/**
 * What "Install" in the onboarding dialog does for one picked provider:
 * activate its spec from the verified channel, then — for CLI providers, the
 * only category with a per-machine `enabled` opt-in — enable it, exactly as the
 * Providers tab toggle does (`set_provider_setting` key `enabled`).
 *
 * The install alone used to be the whole step, which left a channel-store daemon
 * with every picked provider still disabled: nothing could be launched, and the
 * gate (now "0 enabled") would never have closed on its own.
 */
export async function setUpOnboardingProvider(
    provider: { type: string; category?: string },
    fetchImpl: GateFetch = standaloneFetch,
): Promise<OnboardingSetupResult> {
    const { type } = provider
    try {
        const installRes = await fetchImpl('/api/v1/providers/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type }),
        })
        const installed = await installRes.json().catch(() => ({})) as { success?: boolean; error?: string; installed?: { category?: string } }
        if (!installed.success) return { type, ok: false, error: installed.error }
        // The daemon's answer is the authority on the category; the catalog row
        // is only the fallback (the catalog may have failed to load while the
        // default picks are still selected).
        if ((installed.installed?.category ?? provider.category) !== 'cli') return { type, ok: true }
        const enableRes = await postDaemonCommand('set_provider_setting', { providerType: type, key: 'enabled', value: true }, fetchImpl)
        const enabled = await enableRes.json().catch(() => ({})) as { success?: boolean; error?: string }
        return enabled.success ? { type, ok: true } : { type, ok: false, error: enabled.error ?? 'enable failed' }
    } catch (e) {
        return { type, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
}
