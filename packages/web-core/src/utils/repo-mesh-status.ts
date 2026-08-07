import type {
    GitRepoStatus,
    RepoMeshNodeStatus,
    RepoMeshSessionStatus,
    RepoMeshStatus,
} from '@adhdev/daemon-core'
import {
    daemonIdsEquivalent,
    normalizeGitStatus,
    normalizeMeshSessionRecord,
    pickBestTransitGitStatus,
    readBoolean,
    readRecord,
    readString,
    readStringArray,
    scoreGitUpstreamFreshness,
    type JsonRecord,
} from '@adhdev/mesh-shared'

/**
 * `daemon_mach_1b46842a…` → `mach_1b46842a` — same truncation shape as
 * meshSurfaceHelpers.ts's shortMachineKey, duplicated here rather than
 * imported: this file is individually whitelisted into web-cloud's narrow
 * tsconfig.app.json `include` list (a consumer-boundary leaf that otherwise
 * only depends on @adhdev/daemon-core / @adhdev/mesh-shared), and importing
 * a src-internal web-core file would pull its whole transitive graph into
 * that allowlist.
 */
function shortMachineKey(machineKey: string): string {
    const core = machineKey.replace(/^(daemon_|standalone_)/, '')
    return core.length <= 20 ? core : `${core.slice(0, 17)}…`
}

// JSON primitives, git-status normalizers (normalizeGitStatus / readGitSubmodules /
// hasGitStatusEvidence / scoreGitStatusCandidate / pickBestTransitGitStatus), the
// upstream-freshness score, and the session normalizer all moved to
// @adhdev/mesh-shared so the cloud (this file) and standalone (daemon-core router)
// paths share ONE implementation that can no longer drift.

function readTransitGitStatus(node: JsonRecord): GitRepoStatus | undefined {
    // Shared with the standalone path: picks the best of the four transit envelope
    // slots (lastGit/lastProbe × status/result.status).
    return pickBestTransitGitStatus(node, { lastCheckedAt: Date.now() })
}

function getGitSubmoduleDriftState(git: GitRepoStatus | null | undefined): { dirty: boolean; outOfSync: boolean } {
    const submodules = Array.isArray(git?.submodules) ? git.submodules : []
    let dirty = false
    let outOfSync = false
    for (const submodule of submodules) {
        if (submodule?.outOfSync) outOfSync = true
        if (submodule?.dirty) dirty = true
    }
    return { dirty, outOfSync }
}

function hasGitWorktreeChanges(git: GitRepoStatus | null | undefined): boolean {
    if (!git) return false
    return (git.staged ?? 0) > 0
        || (git.modified ?? 0) > 0
        || (git.untracked ?? 0) > 0
        || (git.deleted ?? 0) > 0
        || (git.renamed ?? 0) > 0
        || git.hasConflicts === true
}

function deriveMeshNodeHealthFromGit(git: GitRepoStatus | null | undefined): RepoMeshNodeStatus['health'] {
    if (!git || git.isGitRepo === false) return 'degraded'
    if (!git.branch) return 'degraded'
    const submoduleDrift = getGitSubmoduleDriftState(git)
    if (submoduleDrift.outOfSync) return 'degraded'
    if (submoduleDrift.dirty || hasGitWorktreeChanges(git)) return 'dirty'
    return 'online'
}

function preferGitDerivedHealth(rawHealth: string | undefined, git: GitRepoStatus | undefined): RepoMeshNodeStatus['health'] | undefined {
    const gitHealth = git ? deriveMeshNodeHealthFromGit(git) : undefined
    if (!rawHealth || rawHealth === 'unknown') return gitHealth
    return rawHealth as RepoMeshNodeStatus['health']
}

// normalizeMeshSessionRecord moved to @adhdev/mesh-shared (with the sessionId
// fallback → deterministic-synthetic-id bug fix). Both the details list and the
// single activeSession fallback below route through it for uniform behavior.

function readActiveSessionDetails(node: JsonRecord): RepoMeshSessionStatus[] | undefined {
    const details = Array.isArray(node.activeSessionDetails)
        ? node.activeSessionDetails
        : Array.isArray(node.active_session_details)
            ? node.active_session_details
            : Array.isArray(node.sessions)
                ? node.sessions
                : null
    if (details) {
        const normalized = details
            .map(normalizeMeshSessionRecord)
            .filter((entry): entry is RepoMeshSessionStatus => entry !== null)
        if (normalized.length > 0) return normalized
    }

    // Single-session fallback: fold the node-level id hints onto the activeSession
    // record and run it through the SAME shared normalizer so the sessionId
    // fallback (incl. deterministic synthetic id) is uniform with the list path.
    const fallback = readRecord(node.activeSession ?? node.active_session)
    const fallbackWithNodeHints = {
        ...fallback,
        sessionId: readString(
            fallback.sessionId,
            fallback.id,
            fallback.session_id,
            node.activeSessionId,
            node.active_session_id,
            node.sessionId,
            node.session_id,
        ),
    }
    const normalized = normalizeMeshSessionRecord(fallbackWithNodeHints)
    return normalized ? [normalized] : undefined
}

function readConnectionStatus(node: JsonRecord): RepoMeshNodeStatus['connection'] {
    const connection = readRecord(node.connection)
    return Object.keys(connection).length > 0 ? connection as unknown as RepoMeshNodeStatus['connection'] : undefined
}

function buildLivePeerGitConnection(connection: RepoMeshNodeStatus['connection']): RepoMeshNodeStatus['connection'] {
    const source = connection?.source
    const transport = connection?.transport
    return {
        ...connection,
        perspective: connection?.perspective ?? 'selected_coordinator',
        source: source && source !== 'not_reported' ? source : 'mesh_peer_status',
        state: 'connected',
        transport: transport && transport !== 'unknown' ? transport : 'direct',
        reported: true,
        reason: 'Live peer git snapshot reported by the selected coordinator.',
    }
}

export function repoMeshNodeHasLiveGitEvidence(node: Pick<RepoMeshNodeStatus, 'git'>): boolean {
    const git = node.git
    return Boolean(
        git
        && (
            git.isGitRepo === true
            || git.isGitRepo === false
            || git.branch
            || git.upstream
            || git.headCommit
            || typeof git.lastCheckedAt === 'number'
            || (git.submodules?.length ?? 0) > 0
        ),
    )
}

function scoreRepoMeshNodeTruth(node: RepoMeshNodeStatus): number {
    let score = 0
    const git = node.git
    if (repoMeshNodeHasLiveGitEvidence(node)) {
        score += 80
        if (git?.isGitRepo === true) score += 20
        if (git?.isGitRepo === false) score += 5
        if (git?.branch) score += 20
        if (git?.upstream) score += 12
        if (git?.headCommit) score += 12
        score += scoreGitUpstreamFreshness(git?.upstreamStatus)
        if (typeof git?.lastCheckedAt === 'number') score += 6
        score += (git?.submodules?.length ?? 0) * 6
    }
    if ((node as any).branchConvergence?.status) score += 12
    if (node.connection?.state === 'connected' || node.connection?.state === 'self') score += 8
    if (node.connection?.transport === 'direct') score += 4
    if (node.connection?.source === 'mesh_peer_status') score += 4
    if (node.health === 'online') score += 4
    if (node.health === 'dirty') score += 3
    if (node.health === 'degraded') score += 2
    if (node.launchReady) score += 2
    if (node.gitProbePending) score -= 40
    if (node.error) score -= 10
    return score
}

function mergeRepoMeshNodeStatus(existing: RepoMeshNodeStatus, incoming: RepoMeshNodeStatus): RepoMeshNodeStatus {
    const existingScore = scoreRepoMeshNodeTruth(existing)
    const incomingScore = scoreRepoMeshNodeTruth(incoming)
    const primary = incomingScore > existingScore ? incoming : existing
    const secondary = primary === incoming ? existing : incoming
    const git = primary.git ?? secondary.git
    const providers = (primary.providers?.length ?? 0) > 0 ? primary.providers : secondary.providers
    const activeSessions = (primary.activeSessions?.length ?? 0) > 0 ? primary.activeSessions : secondary.activeSessions
    const activeSessionDetails = (primary.activeSessionDetails?.length ?? 0) > 0 ? primary.activeSessionDetails : secondary.activeSessionDetails
    const providerPriority = (primary.providerPriority?.length ?? 0) > 0 ? primary.providerPriority : secondary.providerPriority
    const connection = primary.connection ?? secondary.connection
    const merged: RepoMeshNodeStatus = {
        ...secondary,
        ...primary,
        machineLabel: primary.machineLabel || secondary.machineLabel,
        workspace: primary.workspace || secondary.workspace,
        ...(primary.repoRoot || secondary.repoRoot ? { repoRoot: primary.repoRoot || secondary.repoRoot } : {}),
        ...(primary.daemonId || secondary.daemonId ? { daemonId: primary.daemonId || secondary.daemonId } : {}),
        ...(primary.machineId || secondary.machineId ? { machineId: primary.machineId || secondary.machineId } : {}),
        ...(primary.machineStatus || secondary.machineStatus ? { machineStatus: primary.machineStatus || secondary.machineStatus } : {}),
        health: git && (!primary.health || primary.health === 'unknown') ? deriveMeshNodeHealthFromGit(git) : primary.health,
        providers: providers ?? [],
        activeSessions: activeSessions ?? [],
        ...(activeSessionDetails && activeSessionDetails.length > 0 ? { activeSessionDetails } : {}),
        ...(providerPriority && providerPriority.length > 0 ? { providerPriority } : {}),
        ...(connection ? { connection } : {}),
        ...(git ? { git } : {}),
    }
    const primaryBranchConvergence = readRecord((primary as any).branchConvergence)
    if (Object.keys(primaryBranchConvergence).length > 0) {
        Object.assign(merged, { branchConvergence: primaryBranchConvergence })
    } else {
        delete (merged as { branchConvergence?: unknown }).branchConvergence
    }
    if (git) {
        delete (merged as { gitProbePending?: boolean }).gitProbePending
        delete (merged as { error?: string }).error
    }
    return merged
}

function normalizeRepoMeshNodeStatus(node: unknown): RepoMeshNodeStatus | null {
    const record = readRecord(node)
    const nodeId = readString(record.nodeId, record.id)
    if (!nodeId) return null

    const cachedStatus = readRecord(record.cachedStatus)
    const liveGit = readTransitGitStatus(record)
    const directGit = liveGit ? undefined : normalizeGitStatus(readRecord(record.git), record) ?? normalizeGitStatus(record, record)
    const authoritativeGit = liveGit ?? directGit
    const cachedGit = authoritativeGit ? undefined : normalizeGitStatus(readRecord(cachedStatus.git), record)
    const git = authoritativeGit ?? cachedGit

    const machineStatus = readString(record.machineStatus, record.machine_status, cachedStatus.machineStatus, cachedStatus.machine_status)
    const rawHealth = readString(record.health)
    const health = liveGit
        ? deriveMeshNodeHealthFromGit(git)
        : preferGitDerivedHealth(rawHealth, authoritativeGit)
            || (git ? deriveMeshNodeHealthFromGit(git) : undefined)
            || readString(cachedStatus.health)
            || machineStatus
            || readString(record.status)
            || 'unknown'

    const directError = liveGit ? undefined : readString(record.error)
    const error = directError ?? (authoritativeGit ? undefined : readString(cachedStatus.error))
    const activeSessionDetails = readActiveSessionDetails(record)
    const activeSessions = readStringArray(record.activeSessions)
    const derivedActiveSessions = activeSessionDetails?.map(entry => entry.sessionId) ?? []
    const providerPriority = readStringArray(record.providerPriority)
    const rawGitProbePending = readBoolean(record.gitProbePending, record.git_probe_pending)
    const gitProbePending = authoritativeGit ? undefined : rawGitProbePending
    const rawConnection = readConnectionStatus(record)
    const rawBranchConvergence = readRecord(record.branchConvergence ?? record.branch_convergence)
    const connectionState = rawConnection?.state
    const connection = liveGit && (!rawConnection?.reported || connectionState === 'unknown')
        ? buildLivePeerGitConnection(rawConnection)
        : rawConnection

    return {
        nodeId,
        // No named field (nickname/hostname) present → fall back to a SHORT id
        // (shortMachineKey), never the raw full-length daemonId/machineId/nodeId
        // hash. A raw hash reads as broken UI ("what is daemon_mach_4462a753...?"),
        // while the short form still lets an operator tell two unnamed machines
        // apart — see resolveMachineLabel's identical raw-id-carries-no-info logic.
        machineLabel: readString(record.machineLabel, record.machine_label, record.hostname)
            || shortMachineKey(readString(record.daemonId, record.daemon_id, record.machineId, record.machine_id, nodeId) || nodeId),
        workspace: readString(record.workspace, git?.workspace) || '',
        ...(readString(record.repoRoot, record.repo_root, git?.repoRoot) ? { repoRoot: readString(record.repoRoot, record.repo_root, git?.repoRoot) } : {}),
        ...(readString(record.daemonId, record.daemon_id) ? { daemonId: readString(record.daemonId, record.daemon_id) } : {}),
        ...(readString(record.machineId, record.machine_id) ? { machineId: readString(record.machineId, record.machine_id) } : {}),
        ...(machineStatus ? { machineStatus } : {}),
        ...(readBoolean(record.isLocalWorktree, record.is_local_worktree) !== undefined ? { isLocalWorktree: readBoolean(record.isLocalWorktree, record.is_local_worktree) } : {}),
        ...(readString(record.worktreeBranch, record.worktree_branch) ? { worktreeBranch: readString(record.worktreeBranch, record.worktree_branch) } : {}),
        ...(readString(record.clonedFromNodeId, record.cloned_from_node_id) ? { clonedFromNodeId: readString(record.clonedFromNodeId, record.cloned_from_node_id) } : {}),
        health: health as RepoMeshNodeStatus['health'],
        ...(git ? { git } : {}),
        ...(gitProbePending !== undefined ? { gitProbePending } : {}),
        providers: readStringArray(record.providers),
        activeSessions: activeSessions.length > 0 ? activeSessions : derivedActiveSessions,
        ...(activeSessionDetails && activeSessionDetails.length > 0 ? { activeSessionDetails } : {}),
        ...(providerPriority.length > 0 ? { providerPriority } : {}),
        ...(readBoolean(record.launchReady) !== undefined ? { launchReady: readBoolean(record.launchReady) } : liveGit ? { launchReady: true } : {}),
        ...(readString(record.lastSeenAt, record.last_seen_at, cachedStatus.lastSeenAt, cachedStatus.last_seen_at) ? { lastSeenAt: readString(record.lastSeenAt, record.last_seen_at, cachedStatus.lastSeenAt, cachedStatus.last_seen_at) } : {}),
        ...(readString(record.updatedAt, record.updated_at, cachedStatus.updatedAt, cachedStatus.updated_at) ? { updatedAt: readString(record.updatedAt, record.updated_at, cachedStatus.updatedAt, cachedStatus.updated_at) } : {}),
        ...(connection ? { connection } : {}),
        ...(Object.keys(rawBranchConvergence).length > 0 ? { branchConvergence: rawBranchConvergence } : {}),
        // Runtime fields surfaced on the Status/Runtime tab. The canonicalizer rebuilds
        // the node field-by-field, so these must be carried through explicitly or the
        // Status tab loses them. Pass-through (best-effort) — shapes are validated by
        // the daemon-core types; the UI tolerates missing/older-daemon values.
        ...(record.scheduling && typeof record.scheduling === 'object'
            ? { scheduling: record.scheduling as RepoMeshNodeStatus['scheduling'] } : {}),
        ...(readBoolean(record.autoFastForwardEligible, record.auto_fast_forward_eligible) === true
            ? { autoFastForwardEligible: true } : {}),
        ...(record.worktreeBootstrap && typeof record.worktreeBootstrap === 'object'
            ? { worktreeBootstrap: record.worktreeBootstrap as RepoMeshNodeStatus['worktreeBootstrap'] } : {}),
        ...(record.staleDaemonBuild && typeof record.staleDaemonBuild === 'object'
            ? { staleDaemonBuild: record.staleDaemonBuild as RepoMeshNodeStatus['staleDaemonBuild'] } : {}),
        // T7: detected provider versions + daemon build version (per-node). Pass-through;
        // omitted by daemons predating the exposure and by quiet compact-folded nodes.
        ...(record.providerVersions && typeof record.providerVersions === 'object' && !Array.isArray(record.providerVersions)
            ? { providerVersions: record.providerVersions as RepoMeshNodeStatus['providerVersions'] } : {}),
        ...(readString(record.daemonBuildVersion, record.daemon_build_version)
            ? { daemonBuildVersion: readString(record.daemonBuildVersion, record.daemon_build_version) } : {}),
        // Versioned facts bundle — OPAQUE pass-through by design (deploy-lag
        // design §a): future bundle fields must ride through without touching
        // this reassembler.
        ...(record.nodeFacts && typeof record.nodeFacts === 'object' && !Array.isArray(record.nodeFacts)
            ? { nodeFacts: record.nodeFacts as RepoMeshNodeStatus['nodeFacts'] } : {}),
        ...(error ? { error } : {}),
    }
}

function dedupeSessionDetails(sessions: RepoMeshSessionStatus[]): RepoMeshSessionStatus[] {
    const byId = new Map<string, RepoMeshSessionStatus>()
    for (const session of sessions) {
        const existing = byId.get(session.sessionId)
        byId.set(session.sessionId, existing ? { ...existing, ...session } : session)
    }
    return [...byId.values()]
}

function attachCoordinatorSessionsToNodes(status: RepoMeshStatus, nodes: RepoMeshNodeStatus[]): RepoMeshNodeStatus[] {
    const coordinatorSessions = Array.isArray((status as any).coordinatorSessions)
        ? (status as any).coordinatorSessions
        : Array.isArray((status as any).coordinator_sessions)
            ? (status as any).coordinator_sessions
            : []
    const normalizedSessions = coordinatorSessions
        .map(normalizeMeshSessionRecord)
        .filter((entry): entry is RepoMeshSessionStatus => entry !== null)
    if (normalizedSessions.length === 0) return nodes

    return nodes.map(node => {
        const matching = normalizedSessions.filter(session => {
            const record = readRecord(coordinatorSessions.find((entry: unknown) => {
                const raw = readRecord(entry)
                return readString(raw.sessionId, raw.session_id, raw.id) === session.sessionId
            }))
            const sessionNodeId = readString(record.nodeId, record.node_id)
            const sessionDaemonId = readString(record.daemonId, record.daemon_id)
            const sessionWorkspace = readString(record.workspace)
            if (sessionNodeId && sessionNodeId === node.nodeId) return true
            // daemonIdsEquivalent (mesh-shared SSOT) collapses the interchangeable
            // mach_ / daemon_mach_ / standalone_mach_ id forms of one machine, so a
            // session stamped in a different-but-equivalent form still matches its
            // node — a raw === here used to false-miss cross-form pairs.
            if (daemonIdsEquivalent(sessionDaemonId, node.daemonId)) {
                return !sessionWorkspace || !node.workspace || sessionWorkspace === node.workspace
            }
            return Boolean(sessionWorkspace && node.workspace && sessionWorkspace === node.workspace)
        })
        if (matching.length === 0) return node
        const activeSessionDetails = dedupeSessionDetails([...(node.activeSessionDetails ?? []), ...matching])
        return {
            ...node,
            activeSessionDetails,
            activeSessions: dedupeSessionDetails([
                ...(node.activeSessionDetails ?? []),
                ...matching,
                ...(node.activeSessions ?? []).map(sessionId => ({ sessionId })),
            ]).map(session => session.sessionId),
        }
    })
}

function nodeNeedsAliasNormalization(node: unknown): boolean {
    const record = readRecord(node)
    return Array.isArray(record.sessions)
        || Array.isArray(record.active_session_details)
        || readString(record.daemon_id, record.machine_id, record.repo_root, record.worktree_branch, record.cloned_from_node_id) !== undefined
        || readBoolean(record.is_local_worktree) !== undefined
}

function canonicalizeRepoMeshNodes(nodes: unknown[]): RepoMeshNodeStatus[] {
    const nodesById = new Map<string, RepoMeshNodeStatus>()
    const canonicalNodes: RepoMeshNodeStatus[] = []
    for (const rawNode of nodes) {
        const node = nodeNeedsAliasNormalization(rawNode)
            ? normalizeRepoMeshNodeStatus(rawNode) ?? rawNode as RepoMeshNodeStatus
            : rawNode as RepoMeshNodeStatus
        if (!node?.nodeId) continue
        const existing = nodesById.get(node.nodeId)
        if (!existing) {
            nodesById.set(node.nodeId, node)
            canonicalNodes.push(node)
            continue
        }
        const merged = mergeRepoMeshNodeStatus(existing, node)
        nodesById.set(node.nodeId, merged)
        const index = canonicalNodes.findIndex(entry => entry.nodeId === node.nodeId)
        if (index >= 0) canonicalNodes[index] = merged
    }
    return canonicalNodes
}

export function canonicalizeRepoMeshStatus(status: RepoMeshStatus | null | undefined): RepoMeshStatus {
    // Null-safe boundary primitive: callers may hand us a status that hasn't
    // arrived yet (mesh unselected / SWR uninitialized / pre-handshake). A null or
    // missing `nodes` collapses to an empty-array canonical status so every
    // downstream `.nodes.map/.length/.find` is safe — this is the single seam that
    // absorbs the MESH-PAGE-NULL-NODES-CRASH regression class. Non-null callers are
    // unaffected (`status ?? {}` === status). The `?? []` node defense stays.
    const safe = (status ?? {}) as RepoMeshStatus
    const nodes = canonicalizeRepoMeshNodes(safe.nodes ?? [])
    return {
        ...safe,
        nodes: attachCoordinatorSessionsToNodes(safe, nodes),
    }
}

export function summarizeRepoMeshCanonicalNodeDebug(node: RepoMeshNodeStatus | null | undefined): Record<string, unknown> {
    const git = node?.git
    return {
        nodeId: node?.nodeId ?? null,
        chosenSource: git ? 'live_git' : node?.gitProbePending ? 'pending_git' : 'no_git',
        hasLiveGit: repoMeshNodeHasLiveGitEvidence(node ?? { git: undefined } as RepoMeshNodeStatus),
        branch: git?.branch ?? null,
        upstream: git?.upstream ?? null,
        headCommit: git?.headCommit ?? null,
        submoduleCount: git?.submodules?.length ?? 0,
        pendingGit: node?.gitProbePending === true,
        connection: node?.connection ? {
            state: node.connection.state,
            transport: node.connection.transport,
            source: node.connection.source,
        } : null,
    }
}

function normalizeRepoMeshStatus(candidate: JsonRecord): RepoMeshStatus | null {
    const meshId = readString(candidate.meshId, candidate.mesh_id, candidate.id)
    const nodesValue = candidate.nodes
    const normalizedNodes = Array.isArray(nodesValue)
        ? nodesValue
            .map(node => normalizeRepoMeshNodeStatus(node))
            .filter((node): node is RepoMeshNodeStatus => node !== null)
        : null
    if (!meshId || !normalizedNodes) return null

    const nodes = attachCoordinatorSessionsToNodes(candidate as unknown as RepoMeshStatus, canonicalizeRepoMeshNodes(normalizedNodes))
    const meshName = readString(candidate.meshName, candidate.mesh_name, candidate.name)
    const repoIdentity = readString(candidate.repoIdentity, candidate.repo_identity)
    const refreshedAt = readString(candidate.refreshedAt, candidate.refreshed_at, candidate.updatedAt, candidate.updated_at)
    if (!meshName || !repoIdentity || !refreshedAt) return null

    return {
        ...candidate,
        meshId,
        meshName,
        repoIdentity,
        refreshedAt,
        nodes,
    } as RepoMeshStatus
}

function scoreRepoMeshStatusTruth(status: RepoMeshStatus): number {
    let score = 0
    const sourceOfTruth = readRecord((status as unknown as JsonRecord).sourceOfTruth)
    const directPeerTruth = readRecord(sourceOfTruth.directPeerTruth)
    const currentStatus = readString(sourceOfTruth.currentStatus)
    if (currentStatus === 'live_git_and_session_probes') score += 100
    if (sourceOfTruth.coordinatorOwnsLiveTruth === true) score += 25
    // SINGLE-RESPONSE ASSUMPTION: pickBestRepoMeshStatus only ever compares
    // variants drawn from ONE daemon response (extractRepoMeshStatus is the sole
    // caller; cloud + standalone are both single-daemon with no cross-source
    // merge). So `directPeerTruth.satisfied` is a constant across all candidates
    // in any single call — this +15 shifts every candidate equally and cannot
    // change which one wins. It would only become a latent bug if a future caller
    // compared CROSS-SOURCE candidates (e.g. a satisfied=true STALE snapshot vs a
    // satisfied=false FRESH one). The refreshedAt freshness tiebreaker in
    // pickBestRepoMeshStatus mitigates exactly that case: a clearly-fresher
    // candidate is not beaten by a marginally-richer stale one. Keep the +15.
    if (directPeerTruth.satisfied === true) score += 15
    for (const node of status.nodes) {
        const git = node.git
        if (!git) {
            if (node.gitProbePending) score -= 8
            continue
        }
        score += 10
        if (git.isGitRepo === true) score += 5
        if (git.isGitRepo === false) score += 1
        if (git.branch) score += 4
        if (git.upstream) score += 3
        if (git.headCommit) score += 3
        score += scoreGitUpstreamFreshness(git.upstreamStatus)
        if (typeof git.ahead === 'number') score += 1
        if (typeof git.behind === 'number') score += 1
        if (typeof git.lastCheckedAt === 'number') score += 2
        score += (git.submodules?.length ?? 0) * 2
    }
    return score
}

// Parse a RepoMeshStatus.refreshedAt ISO timestamp into epoch millis for
// freshness comparison. Absent / malformed / non-finite timestamps collapse to 0
// (treated as the oldest possible) so a candidate without a usable refreshedAt
// never wins a tiebreak and we never throw on a bad string.
function parseRefreshedAtMillis(status: RepoMeshStatus): number {
    const raw = (status as unknown as JsonRecord).refreshedAt
    if (typeof raw !== 'string' || raw.length === 0) return 0
    const millis = Date.parse(raw)
    return Number.isFinite(millis) ? millis : 0
}

// Score gap within which we treat two candidates as a near-tie and let freshness
// decide. Small enough that the truth score stays the primary signal (a richer
// live-git snapshot still wins decisively), large enough that the directPeerTruth
// +15 (the single-response-assumption constant documented in
// scoreRepoMeshStatusTruth) cannot let a stale candidate beat a fresher one in a
// hypothetical cross-source comparison.
const REPO_MESH_FRESHNESS_TIE_SCORE_GAP = 20

// Exported for focused freshness-tiebreaker regression tests. extractRepoMeshStatus
// remains the only production caller (single-daemon, single-response).
export function pickBestRepoMeshStatus(candidates: unknown[]): RepoMeshStatus | null {
    let best: { status: RepoMeshStatus; score: number; refreshedAt: number } | null = null
    for (const candidate of candidates) {
        const normalized = normalizeRepoMeshStatus(readRecord(candidate))
        if (!normalized) continue
        const score = scoreRepoMeshStatusTruth(normalized)
        const refreshedAt = parseRefreshedAtMillis(normalized)
        if (!best) {
            best = { status: normalized, score, refreshedAt }
            continue
        }
        // Primary signal: truth score (content richness). When the scores are
        // within REPO_MESH_FRESHNESS_TIE_SCORE_GAP of each other, break the
        // (near-)tie by the newer refreshedAt so a fresher candidate is not lost
        // to a marginally-richer stale one. Strictly-higher scores outside the
        // gap still win outright; equal/absent timestamps keep the incumbent,
        // preserving existing single-candidate / equal-timestamp behavior.
        const nearTie = Math.abs(score - best.score) <= REPO_MESH_FRESHNESS_TIE_SCORE_GAP
        const wins = nearTie
            ? refreshedAt > best.refreshedAt || (refreshedAt === best.refreshedAt && score > best.score)
            : score > best.score
        if (wins) best = { status: normalized, score, refreshedAt }
    }
    return best?.status ?? null
}

export function extractRepoMeshStatus(response: any): RepoMeshStatus | null {
    const hasWrappedResult = Boolean(response && typeof response === 'object' && 'result' in response)
    const body = hasWrappedResult ? response?.result : response

    // Cloud/P2P command responses wrap the daemon-owned payload under `result`.
    // A top-level `status` can be transport/UI-side metadata from an older refresh;
    // never let that outer snapshot outscore the latest command result and keep
    // removed nodes or stale upstream_unverified follow-ups alive after refresh.
    const primary = pickBestRepoMeshStatus([body?.status, body])
    if (primary) return primary

    return pickBestRepoMeshStatus([response?.status, response])
}
