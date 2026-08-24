/**
 * Dashboard recovery for a stale / spec-less provider channel.
 *
 * CLI `adhdev provider sync-channel` (packages/daemon-cloud/src/cli/provider-commands.ts)
 * calls `loader.syncVerifiedChannel()` with no extra args. The daemon already
 * exposes that same path as `activate_provider_updates` (handler.ts) — reuse it;
 * do not invent a second command.
 */

export const PROVIDER_CHANNEL_SYNC_COMMAND = 'activate_provider_updates' as const

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

/** Never-installed channel types must be passed as extra targets (kimi class). */
export function extraTypesForProviderChannelSync(snap: {
    staleTypes?: string[]
    newTypes?: string[]
} | null | undefined): string[] {
    const extra: string[] = []
    for (const type of snap?.newTypes ?? []) {
        if (typeof type === 'string' && type.trim()) extra.push(type.trim())
    }
    return extra
}
