/**
 * Canonical git-status normalizers shared by the cloud (web-core) and standalone
 * (daemon-core router) mesh paths. Previously each transport hand-maintained its
 * own copy and they drifted (e.g. submodule drop rules, evidence checks); this is
 * the one implementation both import.
 */

import { joinRepoPath, readBoolean, readNumber, readRecord, readString, type JsonRecord } from './json'
import type { DaemonBuildBehind, GitRepoStatus, GitSubmoduleStatus, GitUpstreamFreshness } from './types'

export function scoreGitUpstreamFreshness(status: GitUpstreamFreshness | undefined): number {
    switch (status) {
        case 'fresh':
            return 30
        case 'no_upstream':
            return 4
        case 'unchecked':
        case undefined:
            return 0
        case 'stale':
            return -10
        case 'unavailable':
            return -15
        default:
            return 0
    }
}

export function readGitSubmodules(value: unknown, parentRepoRoot?: string): GitSubmoduleStatus[] | undefined {
    if (!Array.isArray(value)) return undefined
    const submodules = value
        .map(entry => {
            const submodule = readRecord(entry)
            const path = readString(submodule.path)
            const commit = readString(submodule.commit)
            const repoPath = readString(submodule.repoPath, submodule.repo_root)
                ?? joinRepoPath(parentRepoRoot, path)
            // repoPath is only used for the submodule node's display workspace, which is
            // allowed to be empty. The cloud P2P transit path can deliver submodule entries
            // without repoPath (and a per-node git object without a derivable repoRoot), so
            // dropping on missing repoPath would silently strip every submodule graph node.
            // Keep any submodule that carries both path and commit.
            if (!path || !commit) return null
            const result: GitSubmoduleStatus = {
                path,
                commit,
                dirty: readBoolean(submodule.dirty) ?? false,
                outOfSync: readBoolean(submodule.outOfSync, submodule.out_of_sync) ?? false,
                lastCheckedAt: readNumber(submodule.lastCheckedAt, submodule.last_checked_at) ?? Date.now(),
            }
            if (repoPath) result.repoPath = repoPath
            const error = readString(submodule.error)
            if (error) result.error = error
            return result
        })
        .filter((entry): entry is GitSubmoduleStatus => entry !== null)
    return submodules.length > 0 ? submodules : undefined
}

export function hasGitStatusEvidence(status: JsonRecord): boolean {
    // BUG FIX: a transit-reshaped git status that carries only a repoRoot/workspace
    // (e.g. cloud P2P stripped the branch/upstream/counters but kept the path) must
    // NOT be dropped — otherwise the node loses its git object and any submodules
    // hanging off it. Treat a present repoRoot/repo_root/workspace as evidence too.
    return readBoolean(status.isGitRepo) !== undefined
        || Boolean(readString(status.branch, status.upstream, status.upstreamStatus, status.upstream_status, status.headCommit))
        || Boolean(readString(status.repoRoot, status.repo_root, status.workspace))
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

export function normalizeGitStatus(
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
    // node.workspace is in the fallback chain so a transit node carrying its path only
    // on the node (not the inner git object) still yields a parentRepoRoot for submodules.
    const repoRoot = readString(status.repoRoot, status.repo_root, node.repoRoot, node.repo_root, status.workspace, node.workspace) || undefined
    const submodules = readGitSubmodules(status.submodules, repoRoot)
    const upstreamStatus = readString(status.upstreamStatus, status.upstream_status)
    const upstreamFetchedAt = readNumber(status.upstreamFetchedAt, status.upstream_fetched_at)
    const upstreamFetchError = readString(status.upstreamFetchError, status.upstream_fetch_error)
    const error = readString(status.error)
    const staged = readNumber(status.staged) ?? 0
    const modified = readNumber(status.modified) ?? 0
    const untracked = readNumber(status.untracked) ?? 0
    const deleted = readNumber(status.deleted) ?? 0
    const renamed = readNumber(status.renamed) ?? 0
    return {
        workspace: readString(status.workspace, node.workspace) || '',
        repoRoot: repoRoot ?? null,
        isGitRepo,
        branch: readString(status.branch) ?? null,
        headCommit: readString(status.headCommit) ?? null,
        headMessage: readString(status.headMessage) ?? null,
        upstream: readString(status.upstream) ?? null,
        upstreamStatus: (upstreamStatus as GitUpstreamFreshness) ?? 'unchecked',
        ...(upstreamFetchedAt !== undefined ? { upstreamFetchedAt } : {}),
        ...(upstreamFetchError ? { upstreamFetchError } : {}),
        ahead: readNumber(status.ahead) ?? 0,
        behind: readNumber(status.behind) ?? 0,
        staged,
        modified,
        untracked,
        deleted,
        renamed,
        dirty: readBoolean(status.dirty, status.isDirty, status.is_dirty) ?? (staged + modified + untracked + deleted + renamed > 0 || hasConflicts),
        hasConflicts,
        conflictFiles,
        stashCount: readNumber(status.stashCount, status.stash_count) ?? 0,
        lastCheckedAt: options?.lastCheckedAt ?? readNumber(status.lastCheckedAt, status.last_checked_at) ?? Date.now(),
        ...(submodules ? { submodules } : {}),
        // Deploy-lag visibility: daemonBuildBehind is computed by the reporting
        // daemon's git probe (build commit vs workspace/submodule HEAD). It must
        // survive relay reassembly or downstream staleDaemonBuild surfaces
        // (dashboard Status tab badge, MCP staleDaemonBuilds warning) never fire
        // for remote nodes.
        ...(status.daemonBuildBehind && typeof status.daemonBuildBehind === 'object'
            ? { daemonBuildBehind: status.daemonBuildBehind as unknown as DaemonBuildBehind }
            : {}),
        ...(error ? { error } : {}),
    }
}

export function scoreGitStatusCandidate(git: GitRepoStatus | undefined): number {
    if (!git) return Number.NEGATIVE_INFINITY
    let score = 0
    if (git.isGitRepo === true) score += 50
    if (git.isGitRepo === false) score -= 10
    if (git.branch) score += 20
    if (git.headCommit) score += 20
    if (git.upstream) score += 10
    score += scoreGitUpstreamFreshness(git.upstreamStatus)
    if (typeof git.ahead === 'number') score += 2
    if (typeof git.behind === 'number') score += 2
    if (Array.isArray(git.submodules) && git.submodules.length > 0) score += 4 + git.submodules.length
    if (git.error) score -= 20
    return score
}

/**
 * Pick the best git status out of the four transit envelope slots a mesh node can
 * carry: lastGit.status, lastGit.result.status, lastProbe.git.status,
 * lastProbe.git.result.status. Returns undefined when none carry git evidence.
 */
export function pickBestTransitGitStatus(node: JsonRecord, options?: { lastCheckedAt?: number }): GitRepoStatus | undefined {
    const rawGit = readRecord(node.lastGit ?? node.last_git)
    const gitResult = readRecord(rawGit.result)
    const directStatus = readRecord(rawGit.status)
    const nestedStatus = readRecord(gitResult.status)
    const rawProbe = readRecord(node.lastProbe ?? node.last_probe)
    const probeGit = readRecord(rawProbe.git)
    const probeGitResult = readRecord(probeGit.result)
    const probeDirectStatus = readRecord(probeGit.status)
    const probeNestedStatus = readRecord(probeGitResult.status)
    const lastCheckedAt = options?.lastCheckedAt
    let best: { git: GitRepoStatus; score: number } | null = null
    for (const status of [directStatus, nestedStatus, probeDirectStatus, probeNestedStatus]) {
        const normalized = normalizeGitStatus(status, node, { lastCheckedAt: lastCheckedAt ?? Date.now() })
        if (!normalized) continue
        const score = scoreGitStatusCandidate(normalized)
        if (!best || score > best.score) best = { git: normalized, score }
    }
    return best?.git
}
