/**
 * MeshNodeFacts — the versioned per-machine RUNTIME facts bundle a reporting
 * daemon ships wholesale (design: root repo
 * docs/design/2026-07-25-deploy-lag-visibility.md §(a)).
 *
 * The mirror-defect class (a field reaching the dashboard for self nodes but
 * not remote ones, or vice versa) came from every fact being plumbed
 * field-by-field through six reassembly layers. The bundle rule that kills the
 * class: producers build it with ONE builder (daemon-core buildLocalNodeFacts —
 * used by BOTH the reporter envelope and the self-node stamp), and every relay
 * layer passes the object through OPAQUELY — never rebuild it field-by-field.
 * schemaVersion lets future fields ride through old relays untouched.
 *
 * Slots are deliberately NOT part of the bundle: they are coordinator-owned
 * config (REMOTE-NODE-SLOTS-COORDINATOR-LOCAL), not a reported runtime fact.
 */

export interface MeshNodeFactsDaemonBuild {
    /** Full build commit baked into the running daemon (40-hex). */
    commit?: string
    commitShort?: string
    version?: string
    builtAt?: string
}

/**
 * One rolling quota window, structurally identical to daemon-core's
 * `QuotaWindow`. Redeclared here rather than imported because this package is a
 * dependency-free leaf (see the header of index.ts) and must never import
 * daemon-core — the dependency arrow points the other way. daemon-core's
 * richer type stays assignable to this one, so the producer passes its snapshot
 * straight through with no mapping layer to drift.
 */
export interface MeshNodeFactsQuotaWindow {
    usedPercent: number
    windowMinutes: number
    resetsAt: number | null
}

/**
 * A provider's quota snapshot as reported by the node that owns the credentials.
 *
 * `status` is the field that matters to a reader: 'ok' means the windows are
 * usable, anything else means they are not. A node that CANNOT read a quota
 * still reports an entry (status 'unavailable'/'error' + metadata.failureKind)
 * rather than omitting the provider — an absent entry means "this node never
 * told us", a present failing entry means "this node looked and could not
 * tell", and a reader that cannot distinguish those two cannot diagnose
 * anything. Extra provider-specific fields (buckets, monthly) ride through via
 * the index signature.
 */
export interface MeshNodeFactsProviderQuota {
    provider: string
    status: string
    session: MeshNodeFactsQuotaWindow | null
    weekly: MeshNodeFactsQuotaWindow | null
    /** 30-day billing-style window, only for providers that report one
     *  (cursor-cli). Promoted from the index signature 2026-08-24 so readers
     *  can render it typed — an 'ok' cursor snapshot often carries ONLY this
     *  axis, and a reader that looks at session/weekly alone misreads a
     *  healthy reading as a failure. */
    monthly?: MeshNodeFactsQuotaWindow | null
    /** Per-pool quota buckets, only for providers whose plan has more than one
     *  pool (antigravity-cli: Gemini vs Claude/GPT groups, each with a 5h and
     *  a weekly bucket). `session`/`weekly` above collapse these to the WORST
     *  bucket per window (the routing-safe headline); the buckets carry the
     *  per-pool detail a reader should surface. Promoted from the index
     *  signature 2026-08-24, same reasoning as `monthly`. */
    buckets?: Array<{
        name?: string
        usedPercent?: number
        windowMinutes?: number
        resetsAt?: number | null
        [extra: string]: unknown
    }> | null
    /** Unix ms of the snapshot itself — older than the bundle's reportedAt. */
    updatedAt: number
    error: string | null
    /**
     * `accountEmail` is PII and rides this bundle because the bundle is
     * P2P/local only — it must never be added to a server-bound payload. See
     * daemon-core `QuotaMetadata.accountEmail` and the regression suite that
     * pins its absence from every server allow-list.
     */
    metadata?: {
        failureKind?: string
        source?: string
        planType?: string | null
        accountEmail?: string | null
        /**
         * True when `session`/`weekly` are NOT this snapshot's own reading but a
         * retained last-good reading carried forward by daemon-core's
         * `carryForwardLastGoodWindows` (quota/refresh.ts) after a TRANSIENT
         * fetch failure (expired token, network blip, rate limit). `status` on
         * this same entry is the fresh failure, not 'ok' — the numbers are real,
         * just not from THIS tick. A reader should label them (e.g. "· refreshing")
         * rather than presenting them as a freshly measured value.
         */
        lastGoodWindows?: boolean
        /**
         * Unix ms when the reporting node last ATTEMPTED a refresh of this
         * provider — deliberately distinct from `updatedAt`, which dates the
         * DATA. They differ for file-source providers (claude-cli reports its
         * statusline snapshot's capture time, codex-cli the rollout entry's),
         * whose `updatedAt` does not move while the source file is unchanged
         * however often it is successfully re-read.
         *
         * A reader judging FRESHNESS wants `updatedAt`. This field answers the
         * different question "is that node still looking?", which is what makes
         * "3h old but re-checked a minute ago" distinguishable from "3h old and
         * nobody has looked since". Absent on entries written by daemons
         * predating the field.
         */
        fetchedAt?: number
        [extra: string]: unknown
    }
    [extra: string]: unknown
}

/**
 * One provider's enablement state on the reporting machine — see
 * `MeshNodeFacts.providerEnablement`.
 *
 * Both fields are REQUIRED booleans on the wire even though the underlying
 * config defaults are asymmetric (`enabled` defaults false, `quotaEnabled`
 * defaults true). The producer resolves those defaults before stamping, so a
 * reader never re-derives them — a second copy of the default rules is exactly
 * the drift this shape avoids. Absence is expressed by omitting the whole
 * provider entry (or the whole bundle field), never by a missing sub-field.
 */
export interface MeshNodeFactsProviderEnablement {
    /** "This machine uses provider X" — gates launching and mesh claims. */
    enabled: boolean
    /** "...and its quota is probed here" — an independent user opt-out. */
    quotaEnabled: boolean
}

export interface MeshNodeFacts {
    schemaVersion: number
    reportedAt: number
    daemonBuild?: MeshNodeFactsDaemonBuild
    providerVersions?: Record<string, string>
    /**
     * Verified-channel PIN per provider type: which provider MANIFEST the node
     * actually loads. NOT the same as `providerVersions`, which is the CLI
     * BINARY version — a node can run kimi-code 1.2.3 while pinned to kimi
     * spec 1.0.0. Keep them separate; folding them would repeat the
     * multi-identifier confusion behind the canon-identity defect class.
     *
     * This is what makes a remote node's pin knowable. Provider fixes do not
     * propagate on their own (the pin advances only on an explicit
     * activation, by design), so without this field a node that never adopted
     * a published fix looks exactly like one that did.
     *
     * A missing entry means "no pin", never a fabricated value.
     */
    providerSpecPins?: Record<string, string>
    platform?: string
    arch?: string
    machineNickname?: string
    /**
     * Per-provider quota snapshots, keyed by QuotaProvider id ('claude-cli',
     * 'codex-cli', 'cursor-cli', 'kimi'). Consumed by ROUTING as well as observation: the
     * coordinator's quota gate / spread bonus (daemon-core mesh-quota-routing.ts,
     * thresholds in RepoMeshPolicy.quotaRouting) reads exactly this shape, so
     * field renames here are a routing-contract change, not a cosmetic one.
     * Both consumers fail open on missing/stale data.
     *
     * Freshness is `Date.now() - reportedAt` (the bundle stamp) plus each
     * entry's own `updatedAt`; there is deliberately NO ttl/expiry field here,
     * because refresh cadence is owned by the reporting node and the delivery
     * cadence by whoever calls git_status. Neither end is in a position to
     * assert a TTL, so readers judge age themselves (the routing consumer's
     * rule: quotaSnapshotAgeMs in daemon-core mesh-quota-routing.ts).
     */
    quota?: Record<string, MeshNodeFactsProviderQuota>
    /**
     * Per-provider ENABLEMENT state on the reporting machine, keyed the same
     * way as `quota`. Exists because `quota` alone cannot answer "why is there
     * no snapshot": a provider that is disabled — on either axis — is pruned
     * from the quota cache entirely (daemon-core quota/refresh.ts drops it and
     * refuses to restore it from disk), so a deliberate opt-out and a
     * never-yet-measured provider both arrive as the SAME absent entry. On the
     * node that owns the config that ambiguity is resolvable by reading the
     * config; for every OTHER node in the mesh it was not resolvable at all,
     * which is what this field fixes.
     *
     * The two axes mirror ProviderLoader exactly and are INDEPENDENT:
     * `enabled` is "this machine uses provider X" (gates launching and mesh
     * claims), `quotaEnabled` gates ONLY the quota probe — a machine can use a
     * provider and still opt out of having its usage read.
     *
     * ★An ABSENT bundle field means "this node did not tell us" — a daemon too
     * old to send it — and must NEVER be read as "disabled". The consumer
     * (daemon-core mesh-quota-routing.ts classifyAbsentQuotaReason) keeps its
     * unclassified fallback for exactly that case; treating absence as
     * disabled would invent a fail-closed verdict out of a missing field.
     *
     * Booleans keyed by provider type only — no free text, no credentials.
     */
    providerEnablement?: Record<string, MeshNodeFactsProviderEnablement>
    /** Future fields ride through opaquely — do not enumerate them in relays. */
    [extra: string]: unknown
}

/**
 * Validate the minimal envelope shape and pass EVERYTHING else through
 * untouched. Returns undefined for anything that is not a v1+ bundle so
 * callers skip the stamp instead of shipping garbage.
 */
export function normalizeMeshNodeFacts(raw: unknown): MeshNodeFacts | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const record = raw as Record<string, unknown>
    const schemaVersion = Number(record.schemaVersion)
    const reportedAt = Number(record.reportedAt)
    if (!Number.isFinite(schemaVersion) || schemaVersion < 1) return undefined
    if (!Number.isFinite(reportedAt) || reportedAt <= 0) return undefined
    return { ...record, schemaVersion, reportedAt } as MeshNodeFacts
}

/**
 * Provider types with a SHIPPED quota fetcher — the providers whose quota can
 * actually be read on a node today.
 *
 * This must mirror `REFRESHERS` in daemon-core's `quota/refresh.ts`, which is
 * the runtime authority: a provider absent from REFRESHERS is never probed, so
 * offering it a quota switch anywhere would promise a control that does
 * nothing. It lives here, in the dependency-free leaf, for the same reason
 * `formatQuotaAccount` does — the machine page and the new-install surfaces are
 * in web-core, the fetchers and the `adhdev setup` wizard reach it from
 * daemon-core, and the dependency arrow only runs one way. This list previously
 * existed as a hand-copied literal in web-core's ProvidersTab; that copy is now
 * derived from this one.
 *
 * Deliberately NOT necessarily the same set as the `QuotaProvider` union in
 * daemon-core's quota/types.ts: that union is the set of valid keys a snapshot
 * can be carried under, while membership HERE means "a fetcher exists".
 *
 * Known non-members and why, so this is not re-litigated per surface:
 *   - cursor-cli    — permanently impossible; no personal usage API exists
 *   - hermes-cli    — no model-axis quota to report
 *
 * ★grok-cli WAS listed here as impossible and is not: that verdict came from
 * probing `api.x.ai` / `management-api.x.ai` (the team-API billing axis, which
 * genuinely rejects a CLI OAuth token) and from reading `grok --help`, where
 * the `/usage` view does not appear because it is a TUI slash command. The
 * subscription quota is served by the CLI's own chat proxy — see the endpoint
 * provenance note in daemon-core `quota/fetchers/grok.ts`.
 *
 * ★antigravity-cli was likewise twice judged impossible, from reading
 * `agy --help` where the usage view does not appear because it is a TUI view.
 * Its quota comes from the SHARED Gemini Code Assist backend
 * (`daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` —
 * the host `agy` itself uses; the unprefixed `cloudcode-pa` host 429s Google
 * AI Pro Antigravity accounts), and its credential lives in the OS keyring,
 * not the stale on-disk token file — see the provenance note in daemon-core
 * `quota/fetchers/antigravity.ts`. Supported on macOS and Windows; other
 * platforms report `unsupported` rather than guess at a keyring backend
 * nobody has verified.
 *
 * ★Adding a provider here without adding its fetcher to REFRESHERS re-creates
 * exactly the "switch that does nothing" this constant prevents.
 */
export const QUOTA_SUPPORTED_PROVIDERS: readonly string[] = [
    'antigravity-cli',
    'claude-cli',
    'codex-cli',
    'cursor-cli',
    'grok-cli',
    'kimi',
    'opencode',
]

/** Whether this provider's quota can be probed at all — see QUOTA_SUPPORTED_PROVIDERS. */
export function supportsQuota(providerType: string | undefined | null): boolean {
    return !!providerType && QUOTA_SUPPORTED_PROVIDERS.includes(providerType)
}

/**
 * The account/plan label for a provider quota row: "you@example.com · Plus".
 *
 * Lives HERE, in the dependency-free leaf, because both renderers need it and
 * they cannot share code any other way: the dashboards are in web-core and the
 * `adhdev quota` CLI is in daemon-core, and the dependency arrow runs
 * web-core → daemon-core, never back. Duplicating the formatter in the CLI is
 * what produced the drift this function exists to prevent — the CLI showed no
 * account at all while the UI showed one.
 *
 * Both halves are optional and independent: codex reports both, kimi reports
 * neither, and Claude Code exposes no account at all. Returns null when there
 * is nothing to say, so a provider without an account renders no empty slot and
 * no "unknown" placeholder — the absence is simply invisible, in every surface.
 *
 * ★The email is PII travelling on a P2P-only path. Rendering it locally is
 * fine; it must never be forwarded to a server payload or a push body. See
 * daemon-core QuotaMetadata.accountEmail and the server-boundary suite.
 */
export function formatQuotaAccount(quota: MeshNodeFactsProviderQuota | undefined): string | null {
    const meta = quota?.metadata
    const email = typeof meta?.accountEmail === 'string' ? meta.accountEmail.trim() : ''
    const plan = typeof meta?.planType === 'string' ? meta.planType.trim() : ''
    const parts = [email, plan].filter(Boolean)
    return parts.length > 0 ? parts.join(' · ') : null
}
