/**
 * Provider plan quota — presentation helpers.
 *
 * Moved out of components/MeshGraph/MeshObservabilitySurface/meshSurfaceHelpers.ts
 * (pure relocation, no behavior change) so non-mesh surfaces — the machine
 * detail page, the chat session-info dialog — can format the same
 * MeshNodeFactsProviderQuota values without importing from the MeshGraph
 * subtree, which is scoped to mesh observability UI, not machine/session
 * screens. Everything here depends only on `@adhdev/mesh-shared` types
 * (type-only), so it carries zero MeshGraph or daemon-core coupling.
 *
 * What stayed behind in meshSurfaceHelpers.ts: collectNodeQuotaEntries and
 * collectMachineQuotaGroups, because both take mesh-status-shaped input
 * (RepoMeshNodeStatus / RepoMeshStatus) that only the mesh Status tab has —
 * a bare machine-scoped command response (get_machine_runtime_stats,
 * get_session_info) is a plain Record<string, MeshNodeFactsProviderQuota>,
 * not a mesh node/status object.
 */
import type { MeshNodeFactsProviderQuota, MeshNodeFactsQuotaWindow } from '@adhdev/mesh-shared'

/** Provider ids are wire keys ('claude-cli'); show the product name. */
const QUOTA_PROVIDER_LABELS: Record<string, string> = {
    'claude-cli': 'Claude Code',
    'codex-cli': 'Codex CLI',
    kimi: 'Kimi Code',
}

export function quotaProviderLabel(provider: string): string {
    return QUOTA_PROVIDER_LABELS[provider] ?? provider
}

/**
 * Tone for a usage percentage. Same 70/90 thresholds the `adhdev quota` CLI
 * uses for its bar colour, so the two surfaces agree on what "getting close"
 * means.
 */
export function quotaUsageTone(usedPercent: number): 'default' | 'good' | 'warn' | 'danger' | 'info' {
    if (!Number.isFinite(usedPercent)) return 'default'
    if (usedPercent >= 90) return 'danger'
    if (usedPercent >= 70) return 'warn'
    return 'good'
}

/** "resets in 2h 14m" — omitted entirely when the node reported no reset time. */
export function formatQuotaReset(resetsAt: number | null | undefined, now: number = Date.now()): string | null {
    if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return null
    const deltaMs = resetsAt - now
    if (deltaMs <= 0) return 'resets now'
    const minutes = Math.round(deltaMs / 60_000)
    if (minutes < 60) return `resets in ${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`
    return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** "23.5% used" / "23.5% used · resets in 2h 14m" for one rolling window. */
export function formatQuotaWindow(window: MeshNodeFactsQuotaWindow | null | undefined, now: number = Date.now()): string | null {
    if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null
    const used = `${window.usedPercent.toFixed(1)}% used`
    const resets = formatQuotaReset(window.resetsAt, now)
    return resets ? `${used} · ${resets}` : used
}

/**
 * The failure line for a non-ok provider. Prefers the daemon's own message and
 * appends failureKind when it adds information the message does not already
 * carry — the kind is the field that separates "not installed" from "expired
 * credentials" from "channel broken".
 */
export function describeQuotaFailure(quota: MeshNodeFactsProviderQuota): string {
    const message = typeof quota.error === 'string' ? quota.error.trim() : ''
    const kindRaw = quota.metadata?.failureKind
    const kind = typeof kindRaw === 'string' ? kindRaw.trim() : ''
    const kindLabel = kind ? kind.replace(/[_-]+/g, ' ') : ''
    if (message && kindLabel && !message.toLowerCase().includes(kindLabel.toLowerCase())) {
        return `${message} (${kindLabel})`
    }
    if (message) return message
    if (kindLabel) return kindLabel
    return quota.status === 'unavailable' ? 'not available on this node' : 'could not read quota'
}

export type QuotaEntry = {
    provider: string
    quota: MeshNodeFactsProviderQuota
}

/**
 * Turn a machine-scoped quota map into a stable display list.
 *
 * The machine detail page (`get_machine_runtime_stats` → `machine.quota`) and
 * the session-info dialog (`get_session_info` → `quota`) both receive a plain
 * `Record<string, MeshNodeFactsProviderQuota>` keyed by provider id, unlike the
 * mesh Status tab whose input is a RepoMeshNodeStatus. This is the shared
 * map→list step for those two.
 *
 * Returns [] for an absent/empty/malformed map, so a caller can render NOTHING
 * rather than an empty heading — "the machine never reported quota" must not be
 * dressed up as a quota display with no rows in it. Sorted by display label so
 * providers do not reshuffle between refreshes.
 */
export function collectQuotaEntries(quota: unknown): QuotaEntry[] {
    if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return []
    const entries: QuotaEntry[] = []
    for (const [provider, value] of Object.entries(quota as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        entries.push({ provider, quota: value as MeshNodeFactsProviderQuota })
    }
    return entries.sort((a, b) => quotaProviderLabel(a.provider).localeCompare(quotaProviderLabel(b.provider)))
}

/**
 * Age of the facts bundle this quota rode in on. Deliberately derived from the
 * bundle's existing `reportedAt` rather than any TTL field: refresh cadence is
 * owned by the reporting node and delivery cadence by whoever calls git_status,
 * so neither end is in a position to assert an expiry (mesh-shared node-facts.ts).
 * The reader judges age instead.
 */
export function formatQuotaFreshness(reportedAt: number | null | undefined, now: number = Date.now()): string | null {
    if (typeof reportedAt !== 'number' || !Number.isFinite(reportedAt) || reportedAt <= 0) return null
    const ageMs = now - reportedAt
    if (ageMs < 0) return 'just now'
    const minutes = Math.floor(ageMs / 60_000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ${minutes % 60}m ago`
    return `${Math.floor(hours / 24)}d ${hours % 24}h ago`
}
