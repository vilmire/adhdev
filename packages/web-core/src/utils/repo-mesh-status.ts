import type {
    GitRepoStatus,
    RepoMeshNodeStatus,
    RepoMeshSessionStatus,
    RepoMeshStatus,
} from '@adhdev/daemon-core'

type JsonRecord = Record<string, unknown>

function readRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function readString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value !== 'string') continue
        const trimmed = value.trim()
        if (trimmed) return trimmed
    }
    return undefined
}

function readNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value
    }
    return undefined
}

function readBoolean(...values: unknown[]): boolean | undefined {
    for (const value of values) {
        if (typeof value === 'boolean') return value
    }
    return undefined
}

function readStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : []
}

function joinRepoPath(root: string | undefined, relativePath: string | undefined): string | undefined {
    const normalizedRoot = typeof root === 'string' ? root.trim().replace(/[\\/]+$/, '') : ''
    const normalizedPath = typeof relativePath === 'string' ? relativePath.trim() : ''
    if (!normalizedPath) return undefined
    if (/^(?:[A-Za-z]:[\\/]|\/)/.test(normalizedPath)) return normalizedPath
    if (!normalizedRoot) return undefined
    return `${normalizedRoot}/${normalizedPath.replace(/^[\\/]+/, '')}`
}

function readGitSubmodules(value: unknown, parentRepoRoot?: string): GitRepoStatus['submodules'] {
    if (!Array.isArray(value)) return undefined
    const submodules = value
        .map(entry => {
            const submodule = readRecord(entry)
            const path = readString(submodule.path)
            const commit = readString(submodule.commit)
            const repoPath = readString(submodule.repoPath, submodule.repo_root)
                ?? joinRepoPath(parentRepoRoot, path)
            if (!path || !commit || !repoPath) return null
            return {
                path,
                commit,
                repoPath,
                dirty: readBoolean(submodule.dirty) ?? false,
                outOfSync: readBoolean(submodule.outOfSync, submodule.out_of_sync) ?? false,
                lastCheckedAt: readNumber(submodule.lastCheckedAt, submodule.last_checked_at) ?? Date.now(),
                ...(readString(submodule.error) ? { error: readString(submodule.error) } : {}),
            }
        })
        .filter((entry): entry is NonNullable<GitRepoStatus['submodules']>[number] => entry !== null)
    return submodules.length > 0 ? submodules : undefined
}

function hasGitStatusEvidence(status: JsonRecord): boolean {
    return readBoolean(status.isGitRepo) !== undefined
        || Boolean(readString(status.branch, status.upstream, status.upstreamStatus, status.upstream_status, status.headCommit))
        || readNumber(
            status.ahead,
            status.behind,
            status.staged,
            status.modified,
            status.untracked,
            status.deleted,
            status.renamed,
            status.lastCheckedAt,
            status.last_checked_at,
        ) !== undefined
        || (Array.isArray(status.submodules) && status.submodules.length > 0)
}

function normalizeGitStatus(
    status: JsonRecord,
    node: JsonRecord,
    options?: { lastCheckedAt?: number },
): GitRepoStatus | undefined {
    const explicitIsGitRepo = readBoolean(status.isGitRepo)
    if (!Object.keys(status).length || !hasGitStatusEvidence(status)) return undefined
    const isGitRepo = explicitIsGitRepo ?? true
    const conflictFiles = Array.isArray(status.conflictFiles)
        ? status.conflictFiles.filter((entry): entry is string => typeof entry === 'string')
        : []
    const conflictCount = readNumber(status.conflicts) ?? conflictFiles.length
    const hasConflicts = readBoolean(status.hasConflicts) ?? conflictCount > 0
    const repoRoot = readString(status.repoRoot, status.repo_root, node.repoRoot, node.repo_root, status.workspace, node.workspace) || undefined
    const submodules = readGitSubmodules(status.submodules, repoRoot)
    const upstreamStatus = readString(status.upstreamStatus, status.upstream_status)
    const error = readString(status.error)
    return {
        workspace: readString(status.workspace, node.workspace) || '',
        repoRoot: repoRoot ?? null,
        isGitRepo,
        branch: readString(status.branch) ?? null,
        headCommit: readString(status.headCommit) ?? null,
        headMessage: readString(status.headMessage) ?? null,
        upstream: readString(status.upstream) ?? null,
        upstreamStatus: (upstreamStatus as GitRepoStatus['upstreamStatus']) ?? 'unchecked',
        ahead: readNumber(status.ahead) ?? 0,
        behind: readNumber(status.behind) ?? 0,
        staged: readNumber(status.staged) ?? 0,
        modified: readNumber(status.modified) ?? 0,
        untracked: readNumber(status.untracked) ?? 0,
        deleted: readNumber(status.deleted) ?? 0,
        renamed: readNumber(status.renamed) ?? 0,
        hasConflicts,
        conflictFiles,
        stashCount: readNumber(status.stashCount, status.stash_count) ?? 0,
        lastCheckedAt: options?.lastCheckedAt ?? readNumber(status.lastCheckedAt, status.last_checked_at) ?? Date.now(),
        ...(submodules ? { submodules } : {}),
        ...(error ? { error } : {}),
    }
}

function readTransitGitStatus(node: JsonRecord): GitRepoStatus | undefined {
    const rawGit = readRecord(node.lastGit ?? node.last_git)
    const gitResult = readRecord(rawGit.result)
    const directStatus = readRecord(rawGit.status)
    const nestedStatus = readRecord(gitResult.status)
    const rawProbe = readRecord(node.lastProbe ?? node.last_probe)
    const probeGit = readRecord(rawProbe.git)
    const probeGitResult = readRecord(probeGit.result)
    const probeDirectStatus = readRecord(probeGit.status)
    const probeNestedStatus = readRecord(probeGitResult.status)
    for (const status of [directStatus, nestedStatus, probeDirectStatus, probeNestedStatus]) {
        const normalized = normalizeGitStatus(status, node, { lastCheckedAt: Date.now() })
        if (normalized) return normalized
    }
    return undefined
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

function readActiveSessionDetails(node: JsonRecord): RepoMeshSessionStatus[] | undefined {
    const details = Array.isArray(node.activeSessionDetails)
        ? node.activeSessionDetails
        : Array.isArray(node.active_session_details)
            ? node.active_session_details
            : null
    if (details) {
        const normalized = details
            .map((entry): RepoMeshSessionStatus | null => {
                const record = readRecord(entry)
                const sessionId = readString(record.sessionId, record.session_id, record.id)
                if (!sessionId) return null
                const normalizedEntry: RepoMeshSessionStatus = {
                    sessionId,
                    ...(readString(record.providerType, record.provider) ? { providerType: readString(record.providerType, record.provider) } : {}),
                    ...(readString(record.state, record.status) ? { state: readString(record.state, record.status) } : {}),
                    ...(readString(record.lifecycle) ? { lifecycle: readString(record.lifecycle) as RepoMeshSessionStatus['lifecycle'] } : {}),
                    ...(readString(record.surfaceKind, record.surface_kind) ? { surfaceKind: readString(record.surfaceKind, record.surface_kind) as RepoMeshSessionStatus['surfaceKind'] } : {}),
                    ...(readString(record.recoveryState, record.recovery_state) ? { recoveryState: readString(record.recoveryState, record.recovery_state) } : {}),
                    ...(readString(record.workspace) ? { workspace: readString(record.workspace) } : {}),
                    ...(readString(record.title) ? { title: readString(record.title) } : {}),
                    ...(readString(record.lastActivityAt, record.last_activity_at) ? { lastActivityAt: readString(record.lastActivityAt, record.last_activity_at) } : {}),
                    ...(readBoolean(record.isCached, record.is_cached) !== undefined ? { isCached: readBoolean(record.isCached, record.is_cached) } : {}),
                }
                return normalizedEntry
            })
            .filter((entry): entry is RepoMeshSessionStatus => entry !== null)
        if (normalized.length > 0) return normalized
    }

    const fallback = readRecord(node.activeSession ?? node.active_session)
    const sessionId = readString(
        fallback.id,
        fallback.sessionId,
        fallback.session_id,
        node.activeSessionId,
        node.active_session_id,
        node.sessionId,
        node.session_id,
    )
    if (!sessionId) return undefined
    return [{
        sessionId,
        ...(readString(fallback.providerType, fallback.provider) ? { providerType: readString(fallback.providerType, fallback.provider) } : {}),
        ...(readString(fallback.state, fallback.status) ? { state: readString(fallback.state, fallback.status) } : {}),
    }]
}

function readConnectionStatus(node: JsonRecord): RepoMeshNodeStatus['connection'] {
    const connection = readRecord(node.connection)
    return Object.keys(connection).length > 0 ? connection as unknown as RepoMeshNodeStatus['connection'] : undefined
}

function normalizeRepoMeshNodeStatus(node: unknown): RepoMeshNodeStatus | null {
    const record = readRecord(node)
    const nodeId = readString(record.nodeId, record.id)
    if (!nodeId) return null

    const cachedStatus = readRecord(record.cachedStatus)
    const liveGit = readTransitGitStatus(record)
    const directGit = liveGit ? undefined : normalizeGitStatus(readRecord(record.git), record)
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

    return {
        nodeId,
        machineLabel: readString(record.machineLabel, record.machine_label, record.hostname, record.daemonId, record.daemon_id, record.machineId, record.machine_id, nodeId) || nodeId,
        workspace: readString(record.workspace, git?.workspace) || '',
        ...(readString(record.repoRoot, record.repo_root, git?.repoRoot) ? { repoRoot: readString(record.repoRoot, record.repo_root, git?.repoRoot) } : {}),
        ...(readString(record.daemonId, record.daemon_id) ? { daemonId: readString(record.daemonId, record.daemon_id) } : {}),
        ...(readString(record.machineId, record.machine_id) ? { machineId: readString(record.machineId, record.machine_id) } : {}),
        ...(machineStatus ? { machineStatus } : {}),
        ...(readBoolean(record.isLocalWorktree, record.is_local_worktree) !== undefined ? { isLocalWorktree: readBoolean(record.isLocalWorktree, record.is_local_worktree) } : {}),
        ...(readString(record.worktreeBranch, record.worktree_branch) ? { worktreeBranch: readString(record.worktreeBranch, record.worktree_branch) } : {}),
        health: health as RepoMeshNodeStatus['health'],
        ...(git ? { git } : {}),
        ...(gitProbePending !== undefined ? { gitProbePending } : {}),
        providers: readStringArray(record.providers),
        activeSessions: activeSessions.length > 0 ? activeSessions : derivedActiveSessions,
        ...(activeSessionDetails && activeSessionDetails.length > 0 ? { activeSessionDetails } : {}),
        ...(providerPriority.length > 0 ? { providerPriority } : {}),
        ...(readBoolean(record.launchReady) !== undefined ? { launchReady: readBoolean(record.launchReady) } : {}),
        ...(readString(record.lastSeenAt, record.last_seen_at, cachedStatus.lastSeenAt, cachedStatus.last_seen_at) ? { lastSeenAt: readString(record.lastSeenAt, record.last_seen_at, cachedStatus.lastSeenAt, cachedStatus.last_seen_at) } : {}),
        ...(readString(record.updatedAt, record.updated_at, cachedStatus.updatedAt, cachedStatus.updated_at) ? { updatedAt: readString(record.updatedAt, record.updated_at, cachedStatus.updatedAt, cachedStatus.updated_at) } : {}),
        ...(readConnectionStatus(record) ? { connection: readConnectionStatus(record) } : {}),
        ...(error ? { error } : {}),
    }
}

function normalizeRepoMeshStatus(candidate: JsonRecord): RepoMeshStatus | null {
    const meshId = readString(candidate.meshId, candidate.mesh_id, candidate.id)
    const nodesValue = candidate.nodes
    const nodes = Array.isArray(nodesValue)
        ? nodesValue
            .map(node => normalizeRepoMeshNodeStatus(node))
            .filter((node): node is RepoMeshNodeStatus => node !== null)
        : null
    if (!meshId || !nodes) return null

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
        if (git.upstreamStatus && git.upstreamStatus !== 'unchecked') score += 2
        if (typeof git.ahead === 'number') score += 1
        if (typeof git.behind === 'number') score += 1
        if (typeof git.lastCheckedAt === 'number') score += 2
        score += (git.submodules?.length ?? 0) * 2
    }
    return score
}

export function extractRepoMeshStatus(response: any): RepoMeshStatus | null {
    const body = response?.result ?? response
    const candidates = [response?.status, body?.status, body, response]
    let best: { status: RepoMeshStatus; score: number } | null = null
    for (const candidate of candidates) {
        const normalized = normalizeRepoMeshStatus(readRecord(candidate))
        if (!normalized) continue
        const score = scoreRepoMeshStatusTruth(normalized)
        if (!best || score > best.score) best = { status: normalized, score }
    }
    return best?.status ?? null
}
