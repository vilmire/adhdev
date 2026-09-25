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
import type { TFunction } from 'i18next'
import type { MeshNodeFactsProviderQuota, MeshNodeFactsQuotaWindow } from '@adhdev/mesh-shared'

/**
 * Every user-visible word this module produces, behind one seam so the helpers
 * stay pure (no i18n import at call time) and their tests keep pinning the
 * English defaults. Surfaces pass `createQuotaTextFormatter(t)`; omitting the
 * formatter yields exactly the historical English text.
 *
 * Numbers, window prefixes (5h/7d/30d), provider product names and the
 * daemon's own error messages are NOT localized here — the first three are
 * universal notation/brands, the last is daemon-supplied text.
 */
export interface QuotaTextFormatter {
    /** "23.5% used" — `percent` is already formatted ("23.5"). */
    used(percent: string): string
    resetsNow(): string
    resetsInMinutes(minutes: number): string
    resetsInHours(hours: number, minutes: number): string
    resetsInDays(days: number, hours: number): string
    cue(cue: QuotaWindowCue): string
    /** A window whose reset boundary passed with no new reading yet. */
    windowReset(): string
    /** "184.2K tok" — `count` is already formatted. */
    usageTokens(count: string): string
    usageSessions(count: number): string
    /** Unnamed per-pool bucket fallback label. */
    pool(): string
    /** Display label for a daemon failureKind (`fallback` = the de-slugged kind). */
    failureKind(kind: string, fallback: string): string
    unavailable(): string
    unreadable(): string
    justNow(): string
    agoMinutes(minutes: number): string
    agoHours(hours: number, minutes: number): string
    agoDays(days: number, hours: number): string
}

export const ENGLISH_QUOTA_TEXT: QuotaTextFormatter = {
    used: (percent) => `${percent}% used`,
    resetsNow: () => 'resets now',
    resetsInMinutes: (m) => `resets in ${m}m`,
    resetsInHours: (h, m) => `resets in ${h}h ${m}m`,
    resetsInDays: (d, h) => `resets in ${d}d ${h}h`,
    cue: (cue) => cue,
    windowReset: () => 'reset · awaiting refresh',
    usageTokens: (count) => `${count} tok`,
    usageSessions: (count) => `${count} sess`,
    pool: () => 'pool',
    failureKind: (_kind, fallback) => fallback,
    unavailable: () => 'not available on this node',
    unreadable: () => 'could not read quota',
    justNow: () => 'just now',
    agoMinutes: (m) => `${m}m ago`,
    agoHours: (h, m) => `${h}h ${m}m ago`,
    agoDays: (d, h) => `${d}d ${h}h ago`,
}

/** Failure kinds with a translated label (`machine.quota.text.failureKind.<kind>`). */
const LOCALIZED_FAILURE_KINDS = new Set([
    'missing-credentials', 'expired-token', 'unauthorized', 'quota-exhausted', 'rate-limited', 'network',
    'server', 'parse', 'cli-unavailable', 'unsupported', 'setup-required', 'no-data', 'unknown',
])

/** i18n-backed formatter (keys under `machine.quota.text.*` in the common namespace). */
export function createQuotaTextFormatter(t: TFunction): QuotaTextFormatter {
    const K = 'machine.quota.text.'
    return {
        used: (percent) => t(`${K}used`, { percent }),
        resetsNow: () => t(`${K}resetsNow`),
        resetsInMinutes: (minutes) => t(`${K}resetsInMinutes`, { minutes }),
        resetsInHours: (hours, minutes) => t(`${K}resetsInHours`, { hours, minutes }),
        resetsInDays: (days, hours) => t(`${K}resetsInDays`, { days, hours }),
        cue: (cue) => t(`${K}cue.${cue}`),
        windowReset: () => t(`${K}windowReset`),
        usageTokens: (count) => t(`${K}usageTokens`, { count }),
        usageSessions: (count) => t(`${K}usageSessions`, { count }),
        pool: () => t(`${K}pool`),
        failureKind: (kind, fallback) => (LOCALIZED_FAILURE_KINDS.has(kind) ? t(`${K}failureKind.${kind}`) : fallback),
        unavailable: () => t(`${K}unavailable`),
        unreadable: () => t(`${K}unreadable`),
        justNow: () => t(`${K}justNow`),
        agoMinutes: (minutes) => t(`${K}agoMinutes`, { minutes }),
        agoHours: (hours, minutes) => t(`${K}agoHours`, { hours, minutes }),
        agoDays: (days, hours) => t(`${K}agoDays`, { days, hours }),
    }
}

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
export function formatQuotaUsage(quota: MeshNodeFactsProviderQuota, fmt: QuotaTextFormatter = ENGLISH_QUOTA_TEXT): string | null {
    const usage = quota.metadata?.usage as { days?: number;[k: string]: unknown } | undefined
    if (!usage || typeof usage.days !== 'number') return null
    const parts: string[] = []
    if (typeof usage.totalCostUsd === 'number') parts.push(`$${usage.totalCostUsd.toFixed(2)}`)
    const inTok = typeof usage.inputTokens === 'number' ? usage.inputTokens : null
    const outTok = typeof usage.outputTokens === 'number' ? usage.outputTokens : null
    if (inTok !== null || outTok !== null) {
        parts.push(fmt.usageTokens(formatTokenCount((inTok ?? 0) + (outTok ?? 0))))
    }
    if (typeof usage.sessions === 'number') parts.push(fmt.usageSessions(usage.sessions))
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
export function formatQuotaReset(resetsAt: number | null | undefined, now: number = Date.now(), fmt: QuotaTextFormatter = ENGLISH_QUOTA_TEXT): string | null {
    if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return null
    const deltaMs = resetsAt - now
    if (deltaMs <= 0) return fmt.resetsNow()
    const minutes = Math.round(deltaMs / 60_000)
    if (minutes < 60) return fmt.resetsInMinutes(minutes)
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return fmt.resetsInHours(hours, minutes % 60)
    return fmt.resetsInDays(Math.floor(hours / 24), hours % 24)
}

export type QuotaWindowCue = 'refreshing' | 'stale'

/**
 * Has this window's own reset boundary already passed? Its usedPercent then
 * describes the PREVIOUS window — the gate already ignores it (daemon-core
 * mesh-quota-routing isWindowExpired), so the chip must not keep showing it as
 * the current usage either. Rendered as one state ("reset · awaiting refresh")
 * instead of "100.0% used · resets now · stale" (owner report 2026-09-25).
 */
export function isQuotaWindowReset(window: MeshNodeFactsQuotaWindow | null | undefined, now: number = Date.now()): boolean {
    const resetsAt = window?.resetsAt
    return typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0 && resetsAt <= now
}

/** Chip text (English default) for a window whose reset has passed but no new reading has arrived. */
export const QUOTA_WINDOW_RESET_TEXT = ENGLISH_QUOTA_TEXT.windowReset()

function hasUsableQuotaWindow(window: MeshNodeFactsQuotaWindow | null | undefined): boolean {
    return !!window && typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
}

/**
 * Failure kinds whose retained numbers must read `stale`, never `refreshing`.
 *
 * The distinction is not "is the failure transient?" but "will the daemon fix
 * this on its own?". Both of these answer no, and each needs a user action:
 *  - `no-data` — the capture channel produced nothing new (Claude's statusline
 *    aged out). The daemon may poll again, but this snapshot is a historical
 *    capture, not an in-flight refresh.
 *  - `expired-token` on antigravity — the daemon deliberately does NOT redeem
 *    the stored refresh token (fetchers/antigravity.ts), so no amount of
 *    retrying renews it; only the user running `agy` does. Labelling it
 *    "refreshing" promised a self-heal that cannot happen, which is the
 *    opposite of the one thing the user needed to be told (owner report
 *    2026-09-13). Kimi's expired-token is NOT here on purpose: its CLI
 *    refreshes the token on its own cadence, so "refreshing" is literally true.
 */
function isSelfHealingFailure(quota: MeshNodeFactsProviderQuota): boolean {
    const kind = quota.metadata?.failureKind
    if (kind === 'no-data') return false
    if (kind === 'expired-token' && quota.provider === 'antigravity-cli') return false
    return true
}

/** Does the snapshot carry any renderable number — windows OR per-pool buckets? */
function hasAnyUsableQuotaReading(quota: MeshNodeFactsProviderQuota): boolean {
    if (hasUsableQuotaWindow(quota.session) || hasUsableQuotaWindow(quota.weekly)) return true
    // Antigravity's reading can live entirely on the bucket axis (session/weekly
    // are only a worst-bucket collapse and may both be null), and those chips
    // are exactly what the user sees — so a cue is owed even with no window.
    return Array.isArray(quota.buckets)
        && quota.buckets.some((b) => !!b && typeof b.usedPercent === 'number' && Number.isFinite(b.usedPercent))
}

/**
 * Which freshness cue a snapshot's windows should carry.
 *
 * `refreshing` — last-good carry-forward after a failure the daemon is
 * expected to resolve by itself; another fetch will replace the numbers.
 * `stale` — numbers are present but nothing is going to refresh them without
 * the user (see isSelfHealingFailure). Distinct from `refreshing` on purpose:
 * mixing them tells a reader a reading is about to update itself when it is
 * not, and suppresses the action that would actually fix it.
 */
export function quotaWindowCue(quota: MeshNodeFactsProviderQuota): QuotaWindowCue | undefined {
    // Order matters: the aged-out Claude shape and the retained antigravity
    // shape both ALSO mark lastGoodWindows (mesh routing trusts retained
    // numbers until their reset), so the non-self-healing test must come
    // first or they would all read 'refreshing'.
    if (!isSelfHealingFailure(quota) && hasAnyUsableQuotaReading(quota)) {
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
    fmt: QuotaTextFormatter = ENGLISH_QUOTA_TEXT,
): string | null {
    if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null
    if (isQuotaWindowReset(window, now)) return fmt.windowReset()
    const used = fmt.used(window.usedPercent.toFixed(1))
    const resets = formatQuotaReset(window.resetsAt, now, fmt)
    const base = resets ? `${used} · ${resets}` : used
    const marker: QuotaWindowCue | null = cue === true || cue === 'refreshing' ? 'refreshing' : cue === 'stale' ? 'stale' : null
    return marker ? `${base} · ${fmt.cue(marker)}` : base
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
export function collectQuotaBucketChips(quota: MeshNodeFactsProviderQuota, fmt: QuotaTextFormatter = ENGLISH_QUOTA_TEXT): QuotaBucketChip[] {
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
            label: `${pool || fmt.pool()} ${shortWindowLabel(windowMinutes)}`,
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
export function describeQuotaFailure(quota: MeshNodeFactsProviderQuota, fmt: QuotaTextFormatter = ENGLISH_QUOTA_TEXT): string {
    const message = typeof quota.error === 'string' ? quota.error.trim() : ''
    const kindRaw = quota.metadata?.failureKind
    const kind = typeof kindRaw === 'string' ? kindRaw.trim() : ''
    const kindLabel = kind ? kind.replace(/[_-]+/g, ' ') : ''
    // Dedupe against the daemon's (English) message on the raw kind; display the localized one.
    const kindDisplay = kind ? fmt.failureKind(kind, kindLabel) : ''
    if (message && kindLabel && !message.toLowerCase().includes(kindLabel.toLowerCase())) {
        return `${message} (${kindDisplay})`
    }
    if (message) return message
    if (kindDisplay) return kindDisplay
    return quota.status === 'unavailable' ? fmt.unavailable() : fmt.unreadable()
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
export function buildQuotaDisplayModel(
    quota: MeshNodeFactsProviderQuota,
    now: number = Date.now(),
    fmt: QuotaTextFormatter = ENGLISH_QUOTA_TEXT,
): QuotaDisplayModel {
    const cue = quotaWindowCue(quota)
    const axisChip = (window: MeshNodeFactsQuotaWindow | null | undefined, hint: 'session' | 'weekly' | 'monthly', prefix: string): QuotaDisplayChip | null => {
        const text = formatQuotaWindow(window, now, cue, fmt)
        if (!text) return null
        const usedPercent = window!.usedPercent
        const reset = isQuotaWindowReset(window, now)
        return { key: hint, label: `${prefix} ${text}`, usedPercent: reset ? null : usedPercent, hint, tone: reset ? 'default' : quotaUsageTone(usedPercent) }
    }
    const session = axisChip(quota.session, 'session', '5h')
    const weekly = axisChip(quota.weekly, 'weekly', '7d')
    const monthly = axisChip(quota.monthly, 'monthly', '30d')

    // Multi-pool providers (antigravity): the per-pool buckets REPLACE the
    // collapsed worst-of-pools axes — showing both would render the same
    // numbers twice.
    const bucketChips: QuotaDisplayChip[] = collectQuotaBucketChips(quota, fmt).map(chip => ({
        key: chip.label,
        label: `${chip.label} ${formatQuotaWindow(chip.window, now, cue, fmt)}`,
        usedPercent: isQuotaWindowReset(chip.window, now) ? null : chip.usedPercent,
        hint: 'bucket' as const,
        tone: isQuotaWindowReset(chip.window, now) ? 'default' as const : quotaUsageTone(chip.usedPercent),
    }))
    const chips = bucketChips.length > 0
        ? bucketChips
        : [session, weekly, monthly].filter((c): c is QuotaDisplayChip => c !== null)

    // Usage-shaped provider (opencode): absolute tokens/cost, no percent
    // windows to chip. Only reached when no window rendered.
    const usageLabel = formatQuotaUsage(quota, fmt)
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
    return { kind: 'failure', cue, chips: [], usageLabel: null, message: describeQuotaFailure(quota, fmt), compactChip: null }
}

/**
 * `buildQuotaDisplayModel` pre-bound to a text formatter, so a surface keeps
 * its one-argument `buildQuotaDisplayModel(quota)` call (the drift guard in
 * test/utils/quota-display-model.test.ts pins that shape) while rendering in
 * the user's language:
 *
 *     const buildQuotaDisplayModel = bindQuotaDisplayModel(createQuotaTextFormatter(t))
 */
export function bindQuotaDisplayModel(fmt: QuotaTextFormatter) {
    return (quota: MeshNodeFactsProviderQuota, now: number = Date.now()): QuotaDisplayModel =>
        buildQuotaDisplayModel(quota, now, fmt)
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
export function formatQuotaFreshness(reportedAt: number | null | undefined, now: number = Date.now(), fmt: QuotaTextFormatter = ENGLISH_QUOTA_TEXT): string | null {
    if (typeof reportedAt !== 'number' || !Number.isFinite(reportedAt) || reportedAt <= 0) return null
    const ageMs = now - reportedAt
    if (ageMs < 0) return fmt.justNow()
    const minutes = Math.floor(ageMs / 60_000)
    if (minutes < 1) return fmt.justNow()
    if (minutes < 60) return fmt.agoMinutes(minutes)
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return fmt.agoHours(hours, minutes % 60)
    return fmt.agoDays(Math.floor(hours / 24), hours % 24)
}
