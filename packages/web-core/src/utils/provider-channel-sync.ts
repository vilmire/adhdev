/**
 * Interpreting the result of `activate_provider_updates` (daemon handler.ts)
 * — the Providers tab's per-provider "Update" and "Update all" buttons.
 * (The machine-page tab badge that used to trigger a full channel sync was
 * replaced by a non-clickable dot on 2026-09-25; the command-name constant
 * and the badge's extra-types helper went with it.)
 */

export type ProviderChannelSyncOutcome =
    | { ok: true; activatedCount: number }
    | { ok: false; error: string }

/**
 * Accept both transport shapes:
 *   standalone — raw daemon body
 *   cloud P2P  — `{ success: true, result: <daemon body> }`
 *
 * Canonical implementation moved to utils/daemon-command-envelope.ts
 * (fragmentation audit); re-exported here so existing imports keep working.
 */
import { unwrapDaemonCommandBody } from './daemon-command-envelope'
export { unwrapDaemonCommandBody }

type ActivateProviderUpdatesBody = {
    success?: boolean
    error?: unknown
    activated?: unknown
    channelSync?: {
        status?: string
        errors?: Array<{ message?: string }>
    } | null
}

export function interpretProviderChannelSyncResult(raw: unknown): ProviderChannelSyncOutcome {
    const body = unwrapDaemonCommandBody<ActivateProviderUpdatesBody>(raw)
    if (!body) return { ok: false, error: 'empty response' }
    if (body.success === false) {
        return {
            ok: false,
            error: typeof body.error === 'string' && body.error.trim() ? body.error : 'sync failed',
        }
    }
    const channelSync = body.channelSync
    if (channelSync && typeof channelSync === 'object' && channelSync.status === 'error') {
        const first = Array.isArray(channelSync.errors) ? channelSync.errors[0]?.message : undefined
        return {
            ok: false,
            error: typeof first === 'string' && first.trim() ? first : 'channel sync failed',
        }
    }
    const activatedCount = Array.isArray(body.activated) ? body.activated.length : 0
    return { ok: true, activatedCount }
}
