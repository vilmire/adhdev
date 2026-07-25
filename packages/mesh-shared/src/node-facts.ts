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

export interface MeshNodeFacts {
    schemaVersion: number
    reportedAt: number
    daemonBuild?: MeshNodeFactsDaemonBuild
    providerVersions?: Record<string, string>
    platform?: string
    arch?: string
    machineNickname?: string
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
