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
    'antigravity-cli': 'Antigravity CLI',
    'claude-cli': 'Claude Code',
    'codex-cli': 'Codex CLI',
    'cursor-cli': 'Cursor CLI',
    'grok-cli': 'Grok CLI',
    'hermes-cli': 'Hermes CLI',
    kimi: 'Kimi Code',
    opencode: 'opencode', // the project's own lowercase brand spelling
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

export type QuotaWindowCue = 'refreshing' | 'stale'

function hasUsableQuotaWindow(window: MeshNodeFactsQuotaWindow | null | undefined): boolean {
    return !!window && typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
}

/**
 * Which freshness cue a snapshot's windows should carry.
 *
 * `refreshing` — last-good carry-forward after a TRANSIENT failure; another
 * fetch is expected to replace the numbers.
 * `stale` — windows are present but the capture channel has no current
 * reading (`failureKind: 'no-data'`). Claude's statusline is the canonical
 * case: the numbers are a historical capture, and there is no refresh
 * in-flight. Distinct from `refreshing` on purpose — mixing them would
 * tell a coordinator a 20-hour-old reading is about to update itself.
 */
export function quotaWindowCue(quota: MeshNodeFactsProviderQuota): QuotaWindowCue | undefined {
    // Order matters: the Claude aged-out shape now ALSO marks lastGoodWindows
    // (mesh routing trusts the retained windows until their reset), but its
    // cue must stay 'stale' — nothing is retrying. 'no-data' is not a
    // transient kind, so carry-forward can never wear it.
    if (quota.metadata?.failureKind === 'no-data' && (hasUsableQuotaWindow(quota.session) || hasUsableQuotaWindow(quota.weekly))) {
        return 'stale'
    }
    if (quota.metadata?.lastGoodWindows === true) return 'refreshing'
    return undefined
}

/**
 * "23.5% used" / "23.5% used · resets in 2h 14m" for one rolling window.
 *
 * `cue` marks a window that is visible but not a fresh measurement:
 *  - `true` / `'refreshing'` — last-good carry-forward after a TRANSIENT
 *    fetch failure (`metadata.lastGoodWindows`). Appends "· refreshing".
 *  - `'stale'` — numbers present with `failureKind: 'no-data'` (Claude
 *    statusline aged out). Appends "· stale". Not the same state as
 *    refreshing: nothing is retrying this reading.
 */
export function formatQuotaWindow(
    window: MeshNodeFactsQuotaWindow | null | undefined,
    now: number = Date.now(),
    cue: boolean | QuotaWindowCue | undefined = false,
): string | null {
    if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null
    const used = `${window.usedPercent.toFixed(1)}% used`
    const resets = formatQuotaReset(window.resetsAt, now)
    const base = resets ? `${used} · ${resets}` : used
    const marker = cue === true || cue === 'refreshing' ? 'refreshing' : cue === 'stale' ? 'stale' : null
    return marker ? `${base} · ${marker}` : base
}

/** One renderable per-pool quota bucket (antigravity's Gemini vs Claude/GPT). */
export interface QuotaBucketChip {
    /** `<pool> <window>` — e.g. "Gemini 7d". */
    label: string
    usedPercent: number
    window: MeshNodeFactsQuotaWindow
}

/** "5h" / "7d" / "30d" for the well-known window sizes, else a rounded hour/day count. */
function shortWindowLabel(windowMinutes: number): string {
    const near = (target: number) => Math.abs(windowMinutes - target) <= target * 0.1
    if (near(300)) return '5h'
    if (near(10080)) return '7d'
    if (near(43200)) return '30d'
    return windowMinutes >= 24 * 60 ? `${Math.round(windowMinutes / (24 * 60))}d` : `${Math.round(windowMinutes / 60)}h`
}

/**
 * Per-pool bucket chips for a provider whose plan has several quota pools —
 * antigravity's live shape is two groups (Gemini Models, Claude/GPT bundled
 * models) × two windows (5h, weekly). The snapshot's `session`/`weekly` axes
 * collapse those to the worst bucket per window (the routing headline), which
 * hid the healthier pool entirely; these chips carry the per-pool truth
 * (owner request 2026-08-24). Bucket names arrive as "<group> · <bucket>" —
 * the group segment becomes the pool label, with the noise words the live
 * responses append ("Models", "Limit Remaining") trimmed for chip width.
 * Returns [] when the provider reports fewer than two buckets — a single
 * bucket says nothing the axes do not.
 */
export function collectQuotaBucketChips(quota: MeshNodeFactsProviderQuota): QuotaBucketChip[] {
    const raw = quota.buckets
    if (!Array.isArray(raw) || raw.length < 2) return []
    const chips: QuotaBucketChip[] = []
    for (const bucket of raw) {
        if (!bucket || typeof bucket !== 'object') continue
        const usedPercent = Number(bucket.usedPercent)
        const windowMinutes = Number(bucket.windowMinutes)
        if (!Number.isFinite(usedPercent) || !Number.isFinite(windowMinutes) || windowMinutes <= 0) continue
        const name = typeof bucket.name === 'string' ? bucket.name : ''
        const pool = name.split('·')[0]?.trim().replace(/\s+(Models?|Bundled Models?)$/i, '').trim()
        chips.push({
            label: `${pool || 'pool'} ${shortWindowLabel(windowMinutes)}`,
            usedPercent,
            window: {
                usedPercent,
                windowMinutes,
                resetsAt: typeof bucket.resetsAt === 'number' ? bucket.resetsAt : null,
            },
        })
    }
    // Stable order: by pool label, then shorter window first — pools stay
    // visually grouped between refreshes.
    return chips.sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Summary line for an 'ok' snapshot that carries NO usage windows at all —
 * cursor-cli's included-usage accounts are the canonical case: the fetch
 * succeeded and the account state is real, there is just no percentage window
 * to chart. Prefers the provider's own display message (cursor's
 * metadata.cursorUsage.displayMessage, e.g. "You've used 0% of your included
 * usage"); returns null when there is nothing usable, so the caller can fall
 * back to a neutral i18n line. Rendering describeQuotaFailure here — "could
 * not read quota" — misreported a healthy reading as a failure (owner-visible
 * 2026-08-24).
 */
export function describeQuotaOkWithoutWindows(quota: MeshNodeFactsProviderQuota): string | null {
    if (quota.status !== 'ok') return null
    const usage = (quota.metadata as Record<string, unknown> | undefined)?.cursorUsage
    if (usage && typeof usage === 'object') {
        const message = (usage as Record<string, unknown>).displayMessage
        if (typeof message === 'string' && message.trim() !== '') return message.trim()
    }
    return null
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

export type QuotaTone = 'default' | 'good' | 'warn' | 'danger' | 'info'

/** Which reading a display chip carries — callers map this to their own hover title. */
export type QuotaChipHint = 'session' | 'weekly' | 'monthly' | 'bucket' | 'usage'

export interface QuotaDisplayChip {
    /** Stable render key ('session' / 'weekly' / 'monthly' or the bucket label). */
    key: string
    /** Full chip text — "5h 26.0% used · resets in 2h 14m", "Gemini 7d 9.0% used". */
    label: string
    /** Finite for window/bucket chips; null for the usage chip (no percent axis). */
    usedPercent: number | null
    hint: QuotaChipHint
    /** Same 70/90 thresholds as the `adhdev quota` CLI ('info' for usage chips). */
    tone: QuotaTone
}

export interface QuotaDisplayModel {
    /**
     * chips       — percentage windows exist (per-pool buckets, or the 5h/7d/30d axes)
     * usage       — no windows; a usage-shaped reading (opencode: tokens/cost over a trailing window)
     * okNoWindows — successful reading with no axis at all (cursor included-usage);
     *               `message` is the provider's own line, or null → caller renders its neutral i18n line
     * failure     — the machine looked and could not read it; `message` is always set
     */
    kind: 'chips' | 'usage' | 'okNoWindows' | 'failure'
    /** Freshness cue the chips already carry in their labels — exposed for callers that need it. */
    cue: QuotaWindowCue | undefined
    /** Non-empty exactly when kind === 'chips'. */
    chips: QuotaDisplayChip[]
    /** Set exactly when kind === 'usage'. */
    usageLabel: string | null
    /** okNoWindows: provider message or null; failure: never null. */
    message: string | null
    /**
     * The single "smallest useful reading" for tight surfaces (the provider-row
     * header chip): the 5h axis, else the 7d axis, else the usage summary, else
     * null. Deliberately built from the collapsed AXES even when per-pool
     * buckets replace them in `chips` — a one-chip surface wants the worst-of-
     * pools headline, not one arbitrary pool. Never a monthly-only reading:
     * a 30d billing axis alone is not a "how am I doing right now" number.
     */
    compactChip: QuotaDisplayChip | null
}

/**
 * THE single content-assembly step for every quota display surface.
 *
 * Four dashboards render the same MeshNodeFactsProviderQuota snapshot (mesh
 * Status tab, machine Overview card, session-info dialog, installed-provider
 * row). Each used to re-derive cue/buckets/axes/usage/ok-without-windows/
 * failure on its own, and the rules drifted apart repeatedly (monthly axis,
 * neutral ok-line, bucket replacement, cue threading — all re-aligned by hand
 * on 2026-08-24). Styles may differ per surface; the CONTENT decisions all
 * live here. Consumers must not reassemble axes from the raw snapshot — the
 * drift-guard test (test/utils/quota-display-model.test.ts) pins that.
 */
export function buildQuotaDisplayModel(quota: MeshNodeFactsProviderQuota, now: number = Date.now()): QuotaDisplayModel {
    const cue = quotaWindowCue(quota)
    const axisChip = (window: MeshNodeFactsQuotaWindow | null | undefined, hint: 'session' | 'weekly' | 'monthly', prefix: string): QuotaDisplayChip | null => {
        const text = formatQuotaWindow(window, now, cue)
        if (!text) return null
        const usedPercent = window!.usedPercent
        return { key: hint, label: `${prefix} ${text}`, usedPercent, hint, tone: quotaUsageTone(usedPercent) }
    }
    const session = axisChip(quota.session, 'session', '5h')
    const weekly = axisChip(quota.weekly, 'weekly', '7d')
    const monthly = axisChip(quota.monthly, 'monthly', '30d')

    // Multi-pool providers (antigravity): the per-pool buckets REPLACE the
    // collapsed worst-of-pools axes — showing both would render the same
    // numbers twice.
    const bucketChips: QuotaDisplayChip[] = collectQuotaBucketChips(quota).map(chip => ({
        key: chip.label,
        label: `${chip.label} ${formatQuotaWindow(chip.window, now, cue)}`,
        usedPercent: chip.usedPercent,
        hint: 'bucket' as const,
        tone: quotaUsageTone(chip.usedPercent),
    }))
    const chips = bucketChips.length > 0
        ? bucketChips
        : [session, weekly, monthly].filter((c): c is QuotaDisplayChip => c !== null)

    // Usage-shaped provider (opencode): absolute tokens/cost, no percent
    // windows to chip. Only reached when no window rendered.
    const usageLabel = formatQuotaUsage(quota)
    const usageChip: QuotaDisplayChip | null = usageLabel
        ? { key: 'usage', label: usageLabel, usedPercent: null, hint: 'usage', tone: 'info' }
        : null

    const compactChip = session ?? weekly ?? usageChip

    if (chips.length > 0) {
        return { kind: 'chips', cue, chips, usageLabel: null, message: null, compactChip }
    }
    if (usageChip) {
        return { kind: 'usage', cue, chips: [], usageLabel, message: null, compactChip }
    }
    if (quota.status === 'ok') {
        // 'ok' with no windows at all = a SUCCESSFUL reading whose provider has
        // no percentage axis (cursor included-usage) — its own message when it
        // has one, NEVER the failure line. null → caller's neutral i18n line.
        return { kind: 'okNoWindows', cue, chips: [], usageLabel: null, message: describeQuotaOkWithoutWindows(quota), compactChip: null }
    }
    return { kind: 'failure', cue, chips: [], usageLabel: null, message: describeQuotaFailure(quota), compactChip: null }
}

export type ClaudeQuotaHint = 'setup' | 'refresh' | null

/** The action, if any, that resolves a failed Claude statusline reading. */
export function claudeQuotaHint(provider: string, quota: MeshNodeFactsProviderQuota): ClaudeQuotaHint {
    // Provider gating is essential: kimi also emits failure kinds used here,
    // but installing Claude's statusline wrapper is never an answer for kimi.
    if (provider !== 'claude-cli' || quota.status === 'ok') return null

    const failureKind = quota.metadata?.failureKind
    const error = typeof quota.error === 'string' ? quota.error.toLowerCase() : ''
    if (failureKind === 'setup-required') return 'setup'

    // Compatibility with older daemons, which labeled both setup failures and
    // aged-out readings `no-data`. Their actionable error text is the only
    // remaining discriminator. Check it before lastGoodWindows because an old
    // daemon can report a dangling wrapper while retaining an old snapshot.
    if (error.includes('claude:install') || error.includes('not set up') || error.includes('wrapper is missing')) {
        return 'setup'
    }

    // A retained Claude snapshot proves the capture bridge worked at least
    // once, so an aged-out reading asks for a session, never installation.
    // This alone cannot detect "dangling wrapper + old snapshot" when an old
    // daemon has already masked it with the stale message. The fallback above
    // handles older unmasked setup messages; fully resolving the masked shape
    // requires the new daemon's wrapper audit and setup-required signal.
    if (quota.metadata?.lastGoodWindows === true || failureKind === 'no-data') return 'refresh'
    return null
}

/** True only when Claude's capture bridge must be installed or repaired. */
export function shouldShowClaudeSetupHint(provider: string, quota: MeshNodeFactsProviderQuota): boolean {
    return claudeQuotaHint(provider, quota) === 'setup'
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
