/**
 * Canonical pure-shape mesh/git status types.
 *
 * These are the single source of truth for the data shapes that cross the
 * cloud (P2P/transit) and standalone (local IPC) boundaries. daemon-core and
 * web-core re-export these so neither side can drift its own copy. Pure type
 * declarations only — no runtime, no dependency on either core.
 */

export type GitUpstreamFreshness = 'fresh' | 'unchecked' | 'stale' | 'no_upstream' | 'unavailable'

export type GitFailureReason =
    | 'not_git_repo'
    | 'git_not_installed'
    | 'timeout'
    | 'path_outside_repo'
    | 'dirty_index_required'
    | 'conflict'
    | 'invalid_args'
    | 'nothing_to_commit'
    | 'git_command_failed'

export interface GitRepoIdentity {
    workspace: string
    repoRoot: string | null
    isGitRepo: boolean
}

export interface GitSubmoduleStatus {
    /** Submodule path relative to repo root */
    path: string
    /** Current commit SHA the submodule is at */
    commit: string
    /**
     * Path to the submodule repo (absolute). Optional: cloud P2P transit can
     * deliver submodule entries without a derivable repo path, and graph
     * rendering only uses this for a display field that is allowed to be empty.
     */
    repoPath?: string
    /** Whether the submodule has uncommitted changes */
    dirty: boolean
    /** Whether the submodule commit differs from what the parent repo expects */
    outOfSync: boolean
    /** Last checked timestamp */
    lastCheckedAt: number
    /** Error message if submodule status could not be read */
    error?: string
}

export interface DaemonBuildBehind {
    /** Full build commit baked into the running daemon. */
    buildCommit: string
    /** Short build commit. */
    buildCommitShort: string
    /** HEAD commit the build commit is behind (repo or submodule). */
    head: string
    /** Where the comparison matched: 'root' or the submodule path. */
    scope: string
    /**
     * Whether any package changed between buildCommit..HEAD affects the daemon
     * runtime (daemon-core, standalone, session-host, terminal-mux, ghostty,
     * mcp-server). When false, only web/render packages changed — the daemon does
     * NOT need a rebuild/restart; only the web deploy is pending. Conservative:
     * when the changed-package set can't be determined it defaults to true.
     */
    isDaemonAffecting: boolean
    /** Distinct package names changed between buildCommit..HEAD (best-effort). */
    affectedPackages?: string[]
    warning: string
}

export interface GitRepoStatus extends GitRepoIdentity {
    branch: string | null
    headCommit: string | null
    headMessage: string | null
    upstream: string | null
    /** Whether ahead/behind was verified against a freshly fetched upstream ref. */
    upstreamStatus: GitUpstreamFreshness
    /** Timestamp for the fetch that refreshed upstream refs when upstreamStatus === 'fresh'. */
    upstreamFetchedAt?: number
    /** Error from the last refresh attempt when upstreamStatus === 'stale'. */
    upstreamFetchError?: string
    ahead: number
    behind: number
    staged: number
    modified: number
    untracked: number
    deleted: number
    renamed: number
    /** Aggregate dirty flag including root worktree changes, conflicts, stash, and submodule drift. */
    dirty: boolean
    hasConflicts: boolean
    conflictFiles: string[]
    stashCount: number
    lastCheckedAt: number
    /** Submodule statuses when auto-discover is enabled */
    submodules?: GitSubmoduleStatus[]
    /**
     * Set when the running daemon's build commit is a STRICT ancestor of this
     * repo's HEAD (or a submodule HEAD) — i.e. the live daemon predates committed
     * code in this workspace and is awaiting a deploy/restart to catch up.
     * Omitted entirely when no staleness is provable.
     */
    daemonBuildBehind?: DaemonBuildBehind
    error?: string
    reason?: GitFailureReason
}

/**
 * Minimal identity shape for a mesh node record. A node's stable identifier can
 * arrive under any of THREE field names depending on the serialization path it
 * travelled, all carrying the same value:
 *  - `id`      — config canonical form (mesh registry / persisted config)
 *  - `nodeId`  — runtime/wire camelCase form (inline-cache de-serialization,
 *                mesh_status output)
 *  - `node_id` — SQLite DB column form leaked onto the object
 *
 * Use {@link normalizeMeshNodeId} to read the id regardless of which form is
 * present. This interface only declares the identity fields — node records carry
 * many more runtime fields, intentionally left as an open index so existing
 * `any`-shaped call sites keep compiling while gaining a typed id reader.
 */
export interface MeshNodeIdentified {
    id?: string
    nodeId?: string
    node_id?: string
    [key: string]: unknown
}

export interface RepoMeshSessionStatus {
    sessionId: string
    providerType?: string
    state?: string
    chatStatus?: string
    lifecycle?: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'interrupted'
    surfaceKind?: 'live_runtime' | 'recovery_snapshot' | 'inactive_record'
    recoveryState?: string | null
    workspace?: string | null
    title?: string | null
    role?: string | null
    isSelfCoordinator?: boolean
    statusNote?: string | null
    createdAt?: string | null
    startedAt?: string | null
    lastActivityAt?: string | null
    isCached?: boolean
}
