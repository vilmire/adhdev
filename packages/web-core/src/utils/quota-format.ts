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
    'grok-cli': 'Grok CLI',
    kimi: 'Kimi Code',
    opencode: 'opencode',
}

/** "184230" → "184.2K"; small counts stay exact. */
function formatTokenCount(count: number): string {
    if (count >= 1e9) return `${(count / 1e9).toFixed(1)}B`
    if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`
    if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K`
    return String(count)
}

/**
 * The chip label for a USAGE-shaped entry — absolute tokens/cost over a
 * trailing window, from a provider with no rate-limit concept to report a
 * percentage against (opencode: a BYO-provider router whose limits belong to
 * the upstream accounts). Null when the entry carries no usage block, so
 * window-shaped providers are untouched.
 */
export function formatQuotaUsage(quota: MeshNodeFactsProviderQuota): string | null {
    const usage = quota.metadata?.usage as { days?: number;[k: string]: unknown } | undefined
    if (!usage || typeof usage.days !== 'number') return null
    const parts: string[] = []
    if (typeof usage.totalCostUsd === 'number') parts.push(`$${usage.totalCostUsd.toFixed(2)}`)
    const inTok = typeof usage.inputTokens === 'number' ? usage.inputTokens : null
    const outTok = typeof usage.outputTokens === 'number' ? usage.outputTokens : null
    if (inTok !== null || outTok !== null) {
        parts.push(`${formatTokenCount((inTok ?? 0) + (outTok ?? 0))} tok`)
    }
    if (typeof usage.sessions === 'number') parts.push(`${usage.sessions} sess`)
    if (parts.length === 0) return null
    return `${usage.days}d ${parts.join(' · ')}`
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

/**
 * "23.5% used" / "23.5% used · resets in 2h 14m" for one rolling window.
 *
 * `isLastGood` marks a window carried forward from a prior successful read
 * after a TRANSIENT fetch failure (daemon-core's `carryForwardLastGoodWindows`,
 * signalled via `metadata.lastGoodWindows` — see mesh-shared node-facts.ts).
 * It appends "· refreshing" so a reader can tell "this number is real but not
 * from this tick" from a freshly measured value, instead of the two looking
 * identical — the whole point of retaining the number instead of blanking it.
 */
export function formatQuotaWindow(window: MeshNodeFactsQuotaWindow | null | undefined, now: number = Date.now(), isLastGood: boolean = false): string | null {
    if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null
    const used = `${window.usedPercent.toFixed(1)}% used`
    const resets = formatQuotaReset(window.resetsAt, now)
    const base = resets ? `${used} · ${resets}` : used
    return isLastGood ? `${base} · refreshing` : base
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

/**
 * Should we explain, next to this provider's failure line, WHY Claude alone
 * needs a setup step?
 *
 * Claude Code exposes no outbound quota interface: the numbers exist only in
 * the JSON it pipes to a user-configured `statusLine` command, so reading them
 * means occupying that slot with a wrapper. codex/kimi answer a live query and
 * need nothing. That asymmetry is invisible on a dashboard that just says
 * "unavailable", and the missing piece is the REASON — the daemon's own message
 * already names the command to run.
 *
 * Deliberately gated on the PROVIDER, not on failureKind: kimi emits
 * `missing-credentials` too (fetchers/kimi.ts), and there it means "log in to
 * kimi", which this hint would answer wrongly. Gated on non-ok rather than on a
 * specific kind so a future claude-side failure code does not silently drop the
 * explanation.
 */
export function shouldShowClaudeSetupHint(provider: string, quota: MeshNodeFactsProviderQuota): boolean {
    if (provider !== 'claude-cli') return false
    return quota.status !== 'ok'
}

// formatQuotaAccount moved to @adhdev/mesh-shared (pure relocation, no behaviour
// change) so the `adhdev quota` CLI in daemon-core renders the account label
// through the SAME function these dashboards use. daemon-core cannot import
// web-core (the dependency arrow runs the other way), and a second copy in the
// CLI is exactly the drift that left the CLI showing no account at all.
export { formatQuotaAccount } from '@adhdev/mesh-shared'

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
