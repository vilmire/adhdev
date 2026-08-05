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
    /** Unix ms of the snapshot itself — older than the bundle's reportedAt. */
    updatedAt: number
    error: string | null
    /**
     * `accountEmail` is PII and rides this bundle because the bundle is
     * P2P/local only — it must never be added to a server-bound payload. See
     * daemon-core `QuotaMetadata.accountEmail` and the regression suite that
     * pins its absence from every server allow-list.
     */
    metadata?: { failureKind?: string; source?: string; planType?: string | null; accountEmail?: string | null; [extra: string]: unknown }
    [extra: string]: unknown
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
     * 'codex-cli', 'kimi'). OBSERVATION ONLY — nothing routes on this yet.
     *
     * Freshness is `Date.now() - reportedAt` (the bundle stamp) plus each
     * entry's own `updatedAt`; there is deliberately NO ttl/expiry field here,
     * because refresh cadence is owned by the reporting node and the delivery
     * cadence by whoever calls git_status. Neither end is in a position to
     * assert a TTL, so readers judge age themselves.
     */
    quota?: Record<string, MeshNodeFactsProviderQuota>
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
