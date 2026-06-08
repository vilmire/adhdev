/**
 * Mesh Visualization — transform RepoMeshStatus into a graph model that can be
 * rendered by richer graph surfaces (React Flow, SVG, etc.).
 */

import type {
    GitRepoStatus,
    RepoMeshNodeHealth,
    RepoMeshNodeStatus,
    RepoMeshSessionStatus,
    RepoMeshStatus,
} from '@adhdev/daemon-core'
import { canonicalizeRepoMeshStatus, repoMeshNodeHasLiveGitEvidence } from './repo-mesh-status'

export type MeshGraphNodeType = 'defaultBranchNode' | 'worktreeNode' | 'orphanNode' | 'submoduleNode'
export type MeshGraphEdgeType = 'parentBranch' | 'worktreeLink' | 'sessionLink' | 'orphanLink' | 'submoduleLink' | 'cloneLink'

type MeshGraphSubmoduleStatus = NonNullable<GitRepoStatus['submodules']>[number]

export interface MeshGraphSessionDetail extends RepoMeshSessionStatus {
    chatStatus?: string
    role?: string | null
    isSelfCoordinator?: boolean
    statusNote?: string | null
    createdAt?: string | null
    startedAt?: string | null
}

type MeshGraphNodeSource = RepoMeshNodeStatus | {
    kind: 'synthetic-submodule'
    parentNodeId: string
    parentWorkspace: string
    submodule: MeshGraphSubmoduleStatus
}

export type MeshGraphBranchConvergenceStatus =
    | 'merged_to_main'
    | 'pushed_feature_branch_needs_merge'
    | 'blocked_review'
    | 'cleanup_candidate'
    | 'not_mergeable'

export interface MeshGraphBranchConvergence {
    status: MeshGraphBranchConvergenceStatus
    needsConvergence: boolean
    reason: string
    nextStep: string | null
    branch: string | null
    defaultBranch: string | null
    upstream: string | null
    upstreamStatus: GitRepoStatus['upstreamStatus'] | null
    ahead: number
    behind: number
    dirty: boolean
    hasConflicts: boolean
}

export interface MeshGraphNode {
    id: string
    type: MeshGraphNodeType
    label: string
    workspace: string
    branch: string | null
    upstream: string | null
    upstreamStatus: GitRepoStatus['upstreamStatus'] | null
    daemonId: string | null
    machineId: string | null
    machineLabel: string | null
    locality: 'local' | 'remote' | 'unknown'
    health: RepoMeshNodeHealth
    ahead: number
    behind: number
    dirty: boolean
    dirtyFiles: number
    hasConflicts: boolean
    activeSessionCount: number
    activeSessions: string[]
    sessionDetails: MeshGraphSessionDetail[]
    providers: string[]
    isOrphan: boolean
    orphanReasons: string[]
    nextStepHint?: string
    error?: string
    parentNodeId?: string | null
    clonedFromNodeId?: string | null
    worktreeBranch?: string | null
    submodulePath?: string | null
    submoduleCommit?: string | null
    outOfSync?: boolean
    snapshotCompleteness: 'complete' | 'pending_git' | 'missing_git' | 'missing_submodule_report' | 'stale'
    snapshotWarnings: string[]
    branchConvergence: MeshGraphBranchConvergence | null
    source: MeshGraphNodeSource
}

export interface MeshGraphEdge {
    id: string
    source: string
    target: string
    type: MeshGraphEdgeType
    label?: string
    direction: 'directed' | 'undirected'
}

export interface MeshGraph {
    meshId: string
    meshName: string
    repoIdentity: string
    refreshedAt: string
    nodes: MeshGraphNode[]
    edges: MeshGraphEdge[]
    stats: {
        totalNodes: number
        onlineNodes: number
        dirtyNodes: number
        orphanNodes: number
        errorNodes: number
        offlineNodes: number
        followUpNodes: number
        blockedReviewNodes: number
        mergeReadyNodes: number
        cleanupCandidateNodes: number
        notMergeableNodes: number
        incompleteSnapshotNodes: number
        missingGitSnapshotNodes: number
        missingSubmoduleSnapshotNodes: number
        staleGitSnapshotNodes: number
        totalActiveSessions: number
    }
    warnings: string[]
    snapshotWarnings: string[]
}

const STALE_SNAPSHOT_MS = 5 * 60 * 1000

function readNodeDaemonId(node: RepoMeshNodeStatus): string | null {
    return typeof node.daemonId === 'string' && node.daemonId.trim() ? node.daemonId.trim() : null
}

function readNodeMachineId(node: RepoMeshNodeStatus): string | null {
    return typeof node.machineId === 'string' && node.machineId.trim() ? node.machineId.trim() : null
}

function inferNodeLocality(node: RepoMeshNodeStatus): MeshGraphNode['locality'] {
    if (node.connection?.state === 'self' || node.isLocalWorktree === true) return 'local'
    if (node.connection?.transport === 'direct' || node.connection?.transport === 'relay') return 'remote'
    if (readNodeDaemonId(node) || readNodeMachineId(node)) return 'remote'
    return 'unknown'
}

function hasLiveGitEvidence(node: RepoMeshNodeStatus): boolean {
    return repoMeshNodeHasLiveGitEvidence(node)
}

function isPendingPeerGitSnapshot(node: RepoMeshNodeStatus): boolean {
    if (hasLiveGitEvidence(node)) return false
    if (node.gitProbePending) return true
    if (node.connection?.state === 'connecting') return true
    return false
}

function parseTimestampMs(value: string | null | undefined): number | null {
    if (!value) return null
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
}

function readNodeSessionDetails(nodeStatus: RepoMeshNodeStatus): MeshGraphSessionDetail[] {
    if (nodeStatus.activeSessionDetails && nodeStatus.activeSessionDetails.length > 0) {
        return nodeStatus.activeSessionDetails as MeshGraphSessionDetail[]
    }
    return (nodeStatus.activeSessions ?? []).map(sessionId => ({
        sessionId,
        workspace: nodeStatus.workspace,
        isCached: true,
    }))
}

function isDirty(git?: GitRepoStatus): boolean {
    if (!git) return false
    return (git.staged + git.modified + git.untracked + git.deleted + git.renamed) > 0
}

function hasDirtySubmodules(git?: GitRepoStatus): boolean {
    return (git?.submodules ?? []).some(submodule => submodule.dirty)
}

function hasOutOfSyncSubmodules(git?: GitRepoStatus): boolean {
    return (git?.submodules ?? []).some(submodule => submodule.outOfSync || Boolean(submodule.error))
}

function getParentSubmoduleHealth(git?: GitRepoStatus): RepoMeshNodeHealth {
    if (hasOutOfSyncSubmodules(git)) return 'degraded'
    if (hasDirtySubmodules(git)) return 'dirty'
    return 'online'
}

function dirtyFileCount(git?: GitRepoStatus): number {
    if (!git) return 0
    return git.staged + git.modified + git.untracked + git.deleted + git.renamed
}

function nodeHealthPriority(health: RepoMeshNodeHealth): number {
    switch (health) {
        case 'online':
            return 0
        case 'dirty':
            return 1
        case 'degraded':
            return 2
        case 'wrong_branch':
            return 3
        case 'offline':
            return 4
        case 'unknown':
        default:
            return 5
    }
}

function pickDominantHealth(healths: RepoMeshNodeHealth[]): RepoMeshNodeHealth {
    if (healths.length === 0) return 'unknown'
    return healths.reduce((best, health) => (
        nodeHealthPriority(health) > nodeHealthPriority(best) ? health : best
    ))
}

function inferDefaultBranch(nodes: RepoMeshNodeStatus[]): string | null {
    const upstreamCounts = new Map<string, number>()
    const branchCounts = new Map<string, number>()

    for (const node of nodes) {
        const branch = node.git?.branch?.trim()
        if (!branch) continue
        branchCounts.set(branch, (branchCounts.get(branch) ?? 0) + 1)
        if (node.git?.upstream) {
            upstreamCounts.set(branch, (upstreamCounts.get(branch) ?? 0) + 1)
        }
    }

    const ranked = [...upstreamCounts.entries()].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1]
        const preferred = ['main', 'master', 'develop', 'dev']
        const aPref = preferred.indexOf(a[0])
        const bPref = preferred.indexOf(b[0])
        if (aPref !== -1 || bPref !== -1) {
            if (aPref === -1) return 1
            if (bPref === -1) return -1
            return aPref - bPref
        }
        return a[0].localeCompare(b[0])
    })
    if (ranked[0]?.[0]) return ranked[0][0]

    const fallback = [...branchCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    return fallback ?? null
}

function detectOrphanReasons(node: RepoMeshNodeStatus, defaultBranch: string | null): string[] {
    const reasons: string[] = []
    const git = node.git

    if (!git) {
        reasons.push('No git status available')
        return reasons
    }

    if (!git.isGitRepo) {
        reasons.push('Not a git repository')
        return reasons
    }

    if (!git.branch && git.headCommit) {
        reasons.push('Detached HEAD')
    }

    if (git.hasConflicts) {
        reasons.push('Merge conflicts need resolution')
    }

    if (git.branch && defaultBranch && git.branch !== defaultBranch && !git.upstream) {
        reasons.push(`No upstream tracking for ${git.branch}`)
    }

    if (git.upstream && git.upstreamStatus && git.upstreamStatus !== 'fresh') {
        reasons.push(`Upstream freshness unverified for ${git.branch ?? 'workspace'}`)
    }

    if (node.error) {
        reasons.push(node.error)
    }

    return reasons
}

function branchConvergencePriority(status: MeshGraphBranchConvergenceStatus): number {
    switch (status) {
        case 'merged_to_main':
            return 0
        case 'pushed_feature_branch_needs_merge':
            return 1
        case 'cleanup_candidate':
            return 2
        case 'blocked_review':
            return 3
        case 'not_mergeable':
        default:
            return 4
    }
}

function pickDominantBranchConvergence(convergences: MeshGraphBranchConvergence[]): MeshGraphBranchConvergence {
    return convergences.reduce((best, current) => (
        branchConvergencePriority(current.status) > branchConvergencePriority(best.status) ? current : best
    ))
}

function readBranchConvergenceFollowUps(status: RepoMeshStatus): unknown[] | null {
    const summary = (status as unknown as { branchConvergenceSummary?: { followUps?: unknown[]; needsFollowUp?: boolean; unresolvedCount?: number } }).branchConvergenceSummary
    if (Array.isArray(summary?.followUps)) return summary.followUps
    const topLevelFollowUps = (status as unknown as { followUps?: unknown[] }).followUps
    if (Array.isArray(topLevelFollowUps)) return topLevelFollowUps
    if (summary?.needsFollowUp === false || summary?.unresolvedCount === 0) return []
    return null
}

function readSourceOfTruthWarnings(status: RepoMeshStatus): string[] {
    const sourceOfTruth = (status as unknown as { sourceOfTruth?: { fallback?: { warning?: unknown }; directPeerTruth?: { required?: unknown; satisfied?: unknown }; currentStatus?: unknown } }).sourceOfTruth
    const warnings: string[] = []
    const fallbackWarning = sourceOfTruth?.fallback?.warning
    if (typeof fallbackWarning === 'string' && fallbackWarning.trim()) {
        warnings.push(fallbackWarning.trim())
    }
    if (
        sourceOfTruth?.currentStatus === 'bootstrap_inventory_fallback'
        && sourceOfTruth.directPeerTruth?.required === true
        && sourceOfTruth.directPeerTruth?.satisfied !== true
        && !warnings.some(warning => warning.includes('direct mesh truth'))
    ) {
        warnings.push('Direct mesh truth is not confirmed yet; this graph is drawn from setup inventory only.')
    }
    return warnings
}

function isCleanDefaultBranchMember(node: MeshGraphNode, defaultBranch: string): boolean {
    return node.type !== 'submoduleNode'
        && node.branch === defaultBranch
        && node.ahead === 0
        && node.behind === 0
        && !node.dirty
        && !node.hasConflicts
        && (!node.upstreamStatus || node.upstreamStatus === 'fresh')
        && node.snapshotCompleteness === 'complete'
}

function buildCleanDefaultBranchConvergence(defaultBranch: string, branchNodes: MeshGraphNode[]): MeshGraphBranchConvergence {
    return {
        status: 'merged_to_main',
        needsConvergence: false,
        reason: 'clean_default_branch_aggregate',
        nextStep: null,
        branch: defaultBranch,
        defaultBranch,
        upstream: branchNodes.find(node => node.upstream)?.upstream ?? null,
        upstreamStatus: branchNodes.find(node => node.upstreamStatus)?.upstreamStatus ?? null,
        ahead: 0,
        behind: 0,
        dirty: false,
        hasConflicts: false,
    }
}

function readProvidedBranchConvergence(node: RepoMeshNodeStatus, defaultBranchHint: string | null): MeshGraphBranchConvergence | null {
    if (isPendingPeerGitSnapshot(node)) return null
    const provided = (node as unknown as { branchConvergence?: Partial<MeshGraphBranchConvergence> }).branchConvergence
    if (!provided || typeof provided !== 'object') return null
    const status = provided.status
    if (!status || !['merged_to_main', 'pushed_feature_branch_needs_merge', 'blocked_review', 'cleanup_candidate', 'not_mergeable'].includes(status)) return null
    const git = node.git
    const dirty = isDirty(git) || hasDirtySubmodules(git)
    const hasConflicts = Boolean(git?.hasConflicts) || hasOutOfSyncSubmodules(git)
    const ahead = git?.ahead ?? 0
    const behind = git?.behind ?? 0
    const branch = git?.branch ?? null
    const upstream = git?.upstream ?? null
    const upstreamStatus = git?.upstreamStatus ?? null
    const defaultBranch = provided.defaultBranch ?? defaultBranchHint ?? null

    return {
        status: status as MeshGraphBranchConvergenceStatus,
        needsConvergence: provided.needsConvergence ?? status !== 'merged_to_main',
        reason: provided.reason ?? 'provided_by_coordinator',
        nextStep: provided.nextStep ?? null,
        branch: provided.branch ?? branch,
        defaultBranch,
        upstream: provided.upstream ?? upstream,
        upstreamStatus: provided.upstreamStatus ?? upstreamStatus,
        ahead: provided.ahead ?? ahead,
        behind: provided.behind ?? behind,
        dirty: provided.dirty ?? dirty,
        hasConflicts: provided.hasConflicts ?? hasConflicts,
    }
}

function evaluateBranchConvergence(node: RepoMeshNodeStatus, defaultBranch: string | null): MeshGraphBranchConvergence | null {
    const providedConvergence = readProvidedBranchConvergence(node, defaultBranch)
    if (providedConvergence) {
        return {
            ...providedConvergence,
            defaultBranch: providedConvergence.defaultBranch ?? defaultBranch,
        }
    }

    // Browser-facing graph convergence is intentionally read-only: the daemon's
    // live mesh_status branchConvergence/branchConvergenceSummary is the single
    // source of truth. Missing fields are unknown/pending, not UI-invented
    // blocked_review/upstream_unverified states.
    return null
}

function getSubmoduleHealth(submodule: MeshGraphSubmoduleStatus): RepoMeshNodeHealth {
    if (submodule.error || submodule.outOfSync) return 'degraded'
    if (submodule.dirty) return 'dirty'
    return 'online'
}

function assessSnapshotCompleteness(args: {
    nodeStatus: RepoMeshNodeStatus
    expectedSubmodulePaths: Set<string>
    refreshedAtMs: number | null
}): {
    snapshotCompleteness: MeshGraphNode['snapshotCompleteness']
    snapshotWarnings: string[]
} {
    const { nodeStatus, expectedSubmodulePaths, refreshedAtMs } = args
    const snapshotWarnings: string[] = []
    const label = nodeStatus.machineLabel || nodeStatus.nodeId
    const git = nodeStatus.git

    if (!git) {
        if (isPendingPeerGitSnapshot(nodeStatus)) {
            snapshotWarnings.push(`${label} is still waiting for a live peer git snapshot from the selected coordinator.`)
            return {
                snapshotCompleteness: 'pending_git',
                snapshotWarnings,
            }
        }
        const looksOnline = nodeStatus.health === 'online'
            || nodeStatus.machineStatus === 'online'
            || nodeStatus.connection?.state === 'connected'
            || nodeStatus.connection?.state === 'self'
        snapshotWarnings.push(
            looksOnline
                ? `${label} is online but no peer git snapshot is visible yet.`
                : `${label} has no peer git snapshot visible yet.`,
        )
        return {
            snapshotCompleteness: 'missing_git',
            snapshotWarnings,
        }
    }

    const reportedSubmodulePaths = new Set((git.submodules ?? []).map(submodule => submodule.path))
    if (expectedSubmodulePaths.size > 0) {
        const missingPaths = [...expectedSubmodulePaths].filter(path => !reportedSubmodulePaths.has(path))
        if (missingPaths.length > 0) {
            snapshotWarnings.push(
                `${label} is missing submodule visibility for ${missingPaths.join(', ')} even though another peer reported it.`,
            )
        }
    }

    if (nodeStatus.connection?.state !== 'self' && refreshedAtMs !== null && typeof git.lastCheckedAt === 'number') {
        const ageMs = refreshedAtMs - git.lastCheckedAt
        if (ageMs > STALE_SNAPSHOT_MS) {
            snapshotWarnings.push(`${label} is relying on a peer git snapshot older than 5m; re-probe before trusting convergence.`)
        }
    }

    if (snapshotWarnings.some(warning => warning.includes('submodule visibility'))) {
        return {
            snapshotCompleteness: 'missing_submodule_report',
            snapshotWarnings,
        }
    }
    if (snapshotWarnings.some(warning => warning.includes('older than 5m'))) {
        return {
            snapshotCompleteness: 'stale',
            snapshotWarnings,
        }
    }
    return {
        snapshotCompleteness: 'complete',
        snapshotWarnings,
    }
}

export function buildMeshGraph(status: RepoMeshStatus): MeshGraph {
    const canonicalStatus = canonicalizeRepoMeshStatus(status)
    const meshDefaultBranch = typeof (canonicalStatus as any).defaultBranch === 'string' && (canonicalStatus as any).defaultBranch.trim().length > 0
        ? (canonicalStatus as any).defaultBranch.trim()
        : null
    const inferredDefaultBranch = meshDefaultBranch ?? inferDefaultBranch(canonicalStatus.nodes)
    const refreshedAtMs = parseTimestampMs(canonicalStatus.refreshedAt)
    const expectedSubmodulePaths = new Set(
        canonicalStatus.nodes.flatMap(node => (node.git?.submodules ?? []).map(submodule => submodule.path)),
    )
    const nodes: MeshGraphNode[] = []
    const edges: MeshGraphEdge[] = []
    const warnings: string[] = readSourceOfTruthWarnings(canonicalStatus)
    const branchToNodeIds = new Map<string, string[]>()

    for (const nodeStatus of canonicalStatus.nodes) {
        const git = nodeStatus.git
        const branch = git?.branch ?? null
        const submoduleHealth = getParentSubmoduleHealth(git)
        const dirty = isDirty(git) || submoduleHealth === 'dirty'
        const orphanReasons = detectOrphanReasons(nodeStatus, inferredDefaultBranch)
        const branchConvergence = evaluateBranchConvergence(nodeStatus, inferredDefaultBranch)
        const snapshotAssessment = assessSnapshotCompleteness({
            nodeStatus,
            expectedSubmodulePaths,
            refreshedAtMs,
        })
        const rawClonedFromNodeId = typeof (nodeStatus as any).clonedFromNodeId === 'string'
            ? (nodeStatus as any).clonedFromNodeId
            : null
        const sessionDetails = readNodeSessionDetails(nodeStatus)
        const graphNode: MeshGraphNode = {
            id: nodeStatus.nodeId,
            type: orphanReasons.length > 0 ? 'orphanNode' : 'worktreeNode',
            label: nodeStatus.machineLabel || nodeStatus.nodeId.slice(0, 8),
            workspace: nodeStatus.workspace,
            branch,
            upstream: git?.upstream ?? null,
            upstreamStatus: git?.upstreamStatus ?? null,
            daemonId: readNodeDaemonId(nodeStatus),
            machineId: readNodeMachineId(nodeStatus),
            machineLabel: nodeStatus.machineLabel || null,
            locality: inferNodeLocality(nodeStatus),
            health: pickDominantHealth([nodeStatus.health, submoduleHealth]),
            ahead: git?.ahead ?? 0,
            behind: git?.behind ?? 0,
            dirty,
            dirtyFiles: dirtyFileCount(git),
            hasConflicts: git?.hasConflicts ?? false,
            activeSessionCount: sessionDetails.length,
            activeSessions: sessionDetails.map(session => session.sessionId),
            sessionDetails,
            providers: nodeStatus.providers ?? [],
            isOrphan: orphanReasons.length > 0,
            orphanReasons,
            error: nodeStatus.error,
            nextStepHint: snapshotAssessment.snapshotWarnings[0] ?? orphanReasons[0] ?? branchConvergence?.nextStep ?? undefined,
            parentNodeId: null,
            clonedFromNodeId: rawClonedFromNodeId,
            worktreeBranch: nodeStatus.worktreeBranch ?? null,
            submodulePath: null,
            submoduleCommit: git?.headCommit ?? null,
            outOfSync: hasOutOfSyncSubmodules(git),
            snapshotCompleteness: snapshotAssessment.snapshotCompleteness,
            snapshotWarnings: snapshotAssessment.snapshotWarnings,
            branchConvergence,
            source: nodeStatus,
        }
        nodes.push(graphNode)
        if (branch) {
            const ids = branchToNodeIds.get(branch) ?? []
            ids.push(graphNode.id)
            branchToNodeIds.set(branch, ids)
        }

        for (const submodule of git?.submodules ?? []) {
            const submoduleNodeId = `${graphNode.id}::submodule::${submodule.path}`
            const submoduleLabel = submodule.path.split('/').filter(Boolean).pop() || submodule.path
            nodes.push({
                id: submoduleNodeId,
                type: 'submoduleNode',
                label: submoduleLabel,
                workspace: submodule.repoPath,
                branch: null,
                upstream: null,
                upstreamStatus: null,
                daemonId: graphNode.daemonId,
                machineId: graphNode.machineId,
                machineLabel: graphNode.machineLabel,
                locality: graphNode.locality,
                health: getSubmoduleHealth(submodule),
                ahead: 0,
                behind: 0,
                dirty: submodule.dirty,
                dirtyFiles: submodule.dirty ? 1 : 0,
                hasConflicts: false,
                activeSessionCount: 0,
                activeSessions: [],
                sessionDetails: [],
                providers: [],
                isOrphan: false,
                orphanReasons: [],
                error: submodule.error,
                nextStepHint: submodule.error
                    || (submodule.outOfSync
                        ? `${submodule.path} is out of sync with the parent checkout`
                        : submodule.dirty
                            ? `${submodule.path} has local changes`
                            : `${submodule.path} is in sync with the parent checkout`),
                parentNodeId: graphNode.id,
                submodulePath: submodule.path,
                submoduleCommit: submodule.commit,
                outOfSync: submodule.outOfSync,
                snapshotCompleteness: 'complete',
                snapshotWarnings: [],
                branchConvergence: null,
                source: {
                    kind: 'synthetic-submodule',
                    parentNodeId: graphNode.id,
                    parentWorkspace: nodeStatus.workspace,
                    submodule,
                },
            })
            edges.push({
                id: `${graphNode.id}--${submoduleNodeId}`,
                source: graphNode.id,
                target: submoduleNodeId,
                type: 'submoduleLink',
                label: submodule.outOfSync ? 'submodule out of sync' : 'submodule',
                direction: 'directed',
            })
        }
    }

    const defaultBranchNodeId = inferredDefaultBranch ? `__branch_${inferredDefaultBranch}` : null

    if (defaultBranchNodeId && inferredDefaultBranch) {
        const branchNodeIds = branchToNodeIds.get(inferredDefaultBranch) ?? []
        const branchNodes = branchNodeIds
            .map(id => nodes.find(node => node.id === id))
            .filter(Boolean) as MeshGraphNode[]
        const branchConvergences = branchNodes
            .map(node => node.branchConvergence)
            .filter(Boolean) as MeshGraphBranchConvergence[]
        const followUps = readBranchConvergenceFollowUps(canonicalStatus)
        const allCurrentMembersCleanMerged = branchNodes.length > 0
            && branchNodes.every(node => isCleanDefaultBranchMember(node, inferredDefaultBranch))
        const dominantBranchConvergence = followUps?.length === 0 && allCurrentMembersCleanMerged
            ? buildCleanDefaultBranchConvergence(inferredDefaultBranch, branchNodes)
            : branchConvergences.length > 0
                ? pickDominantBranchConvergence(branchConvergences)
                : null
        const unresolvedBranchConvergenceCount = followUps?.length === 0 && allCurrentMembersCleanMerged
            ? 0
            : branchConvergences.filter(convergence => convergence.needsConvergence).length

        const syntheticDefaultNode: MeshGraphNode = {
            id: defaultBranchNodeId,
            type: 'defaultBranchNode',
            label: inferredDefaultBranch,
            workspace: canonicalStatus.repoIdentity,
            branch: inferredDefaultBranch,
            upstream: null,
            upstreamStatus: null,
            daemonId: null,
            machineId: null,
            machineLabel: 'default branch',
            locality: 'unknown',
            health: pickDominantHealth(branchNodes.map(node => node.health)),
            ahead: 0,
            behind: 0,
            dirty: branchNodes.some(node => node.dirty),
            dirtyFiles: branchNodes.reduce((total, node) => total + node.dirtyFiles, 0),
            hasConflicts: branchNodes.some(node => node.hasConflicts),
            activeSessionCount: branchNodes.reduce((total, node) => total + node.activeSessionCount, 0),
            activeSessions: branchNodes.flatMap(node => node.activeSessions),
            sessionDetails: branchNodes.flatMap(node => node.sessionDetails),
            providers: [...new Set(branchNodes.flatMap(node => node.providers))],
            isOrphan: false,
            orphanReasons: [],
            nextStepHint: unresolvedBranchConvergenceCount > 0
                ? `${unresolvedBranchConvergenceCount} workspace(s) on ${inferredDefaultBranch} still need follow-up`
                : branchNodes.length > 0
                    ? `${branchNodes.length} workspace(s) currently on ${inferredDefaultBranch}`
                    : 'No workspaces currently checked out to the default branch',
            error: undefined,
            parentNodeId: null,
            submodulePath: null,
            submoduleCommit: null,
            outOfSync: false,
            snapshotCompleteness: 'complete',
            snapshotWarnings: [],
            branchConvergence: dominantBranchConvergence,
            source: {
                nodeId: defaultBranchNodeId,
                machineLabel: inferredDefaultBranch,
                workspace: canonicalStatus.repoIdentity,
                health: pickDominantHealth(branchNodes.map(node => node.health)),
                providers: [],
                activeSessions: [],
                activeSessionDetails: [],
            },
        }
        nodes.push(syntheticDefaultNode)

        for (const node of nodes) {
            if (node.id === defaultBranchNodeId || node.type === 'submoduleNode') continue
            if (node.branch === inferredDefaultBranch) {
                edges.push({
                    id: `${defaultBranchNodeId}--${node.id}`,
                    source: defaultBranchNodeId,
                    target: node.id,
                    type: 'parentBranch',
                    label: 'checked out',
                    direction: 'undirected',
                })
                continue
            }
            if (node.branch) {
                edges.push({
                    id: `${defaultBranchNodeId}--${node.id}`,
                    source: defaultBranchNodeId,
                    target: node.id,
                    type: node.isOrphan ? 'orphanLink' : 'parentBranch',
                    label: node.branch,
                    direction: 'undirected',
                })
                continue
            }
            if (node.isOrphan) {
                edges.push({
                    id: `${defaultBranchNodeId}--${node.id}`,
                    source: defaultBranchNodeId,
                    target: node.id,
                    type: 'orphanLink',
                    label: 'detached',
                    direction: 'undirected',
                })
            }
        }
    }

    for (const [branch, ids] of branchToNodeIds) {
        if (ids.length < 2) continue
        const ordered = ids
            .map(id => nodes.find(node => node.id === id))
            .filter(Boolean) as MeshGraphNode[]
        ordered.sort((a, b) => a.label.localeCompare(b.label))
        for (let index = 1; index < ordered.length; index += 1) {
            edges.push({
                id: `wt_${ordered[index - 1].id}--${ordered[index].id}`,
                source: ordered[index - 1].id,
                target: ordered[index].id,
                type: 'worktreeLink',
                label: index === 1 ? `${branch} peers` : undefined,
                direction: 'undirected',
            })
        }
    }

    const nodeIds = new Set(nodes.map(node => node.id))
    const cloneLinkEdgeIds = new Set<string>()
    for (const node of nodes) {
        if (!node.clonedFromNodeId || node.type === 'submoduleNode') continue
        if (!nodeIds.has(node.clonedFromNodeId)) continue
        const edgeId = `clone_${node.clonedFromNodeId}--${node.id}`
        if (cloneLinkEdgeIds.has(edgeId)) continue
        cloneLinkEdgeIds.add(edgeId)
        const branchLabel = node.worktreeBranch ?? node.branch ?? undefined
        edges.push({
            id: edgeId,
            source: node.clonedFromNodeId,
            target: node.id,
            type: 'cloneLink',
            label: branchLabel ? `cloned · ${branchLabel}` : 'cloned',
            direction: 'directed',
        })
    }

    const visibleGraphNodes = nodes.filter(node => node.type !== 'defaultBranchNode')
    const orphanCount = visibleGraphNodes.filter(node => node.isOrphan).length
    const conflictCount = visibleGraphNodes.filter(node => node.hasConflicts).length
    const offlineCount = visibleGraphNodes.filter(node => node.health === 'offline').length
    const outOfSyncSubmoduleCount = visibleGraphNodes.filter(node => node.type === 'submoduleNode' && node.outOfSync).length
    const followUpNodes = visibleGraphNodes.filter(node => node.type !== 'submoduleNode' && node.branchConvergence?.needsConvergence).length
    const blockedReviewNodes = visibleGraphNodes.filter(node => node.branchConvergence?.status === 'blocked_review').length
    const mergeReadyNodes = visibleGraphNodes.filter(node => node.branchConvergence?.status === 'pushed_feature_branch_needs_merge').length
    const cleanupCandidateNodes = visibleGraphNodes.filter(node => node.branchConvergence?.status === 'cleanup_candidate').length
    const notMergeableNodes = visibleGraphNodes.filter(node => node.branchConvergence?.status === 'not_mergeable').length
    const incompleteSnapshotNodes = visibleGraphNodes.filter(node => node.snapshotWarnings.length > 0).length
    const pendingGitSnapshotNodes = visibleGraphNodes.filter(node => node.snapshotCompleteness === 'pending_git').length
    const missingGitSnapshotNodes = visibleGraphNodes.filter(node => node.snapshotCompleteness === 'missing_git').length
    const missingSubmoduleSnapshotNodes = visibleGraphNodes.filter(node => node.snapshotCompleteness === 'missing_submodule_report').length
    const staleGitSnapshotNodes = visibleGraphNodes.filter(node => node.snapshotCompleteness === 'stale').length
    const snapshotWarnings = [
        pendingGitSnapshotNodes > 0 ? `${pendingGitSnapshotNodes} node(s) are still waiting for a live peer git snapshot` : null,
        missingGitSnapshotNodes > 0 ? `${missingGitSnapshotNodes} node(s) have no visible peer git snapshot` : null,
        missingSubmoduleSnapshotNodes > 0 ? `${missingSubmoduleSnapshotNodes} node(s) are missing peer submodule visibility reported elsewhere in the mesh` : null,
        staleGitSnapshotNodes > 0 ? `${staleGitSnapshotNodes} node(s) rely on peer git snapshots older than 5m` : null,
    ].filter(Boolean) as string[]

    if (followUpNodes > 0) warnings.push(`${followUpNodes} workspace(s) still need follow-up before the mesh is converged`)
    if (orphanCount > 0) warnings.push(`${orphanCount} workspace(s) need attention before safe coordination`)
    if (blockedReviewNodes > 0) warnings.push(`${blockedReviewNodes} workspace(s) are blocked on branch convergence or upstream sync`)
    if (mergeReadyNodes > 0) warnings.push(`${mergeReadyNodes} clean feature branch workspace(s) still need merge follow-up`)
    if (cleanupCandidateNodes > 0) warnings.push(`${cleanupCandidateNodes} worktree workspace(s) are ready for refine / cleanup`)
    if (notMergeableNodes > 0) warnings.push(`${notMergeableNodes} workspace(s) have local changes or conflicts blocking convergence`)
    if (conflictCount > 0) warnings.push(`${conflictCount} workspace(s) report merge conflicts`)
    if (offlineCount > 0) warnings.push(`${offlineCount} node(s) are currently offline`)
    if (outOfSyncSubmoduleCount > 0) warnings.push(`${outOfSyncSubmoduleCount} submodule(s) are out of sync with their parent checkout`)
    warnings.push(...snapshotWarnings)
    if (!inferredDefaultBranch) warnings.push('Could not infer a default branch from live mesh status')

    return {
        meshId: canonicalStatus.meshId,
        meshName: canonicalStatus.meshName,
        repoIdentity: canonicalStatus.repoIdentity,
        refreshedAt: canonicalStatus.refreshedAt,
        nodes,
        edges,
        stats: {
            totalNodes: visibleGraphNodes.length,
            onlineNodes: visibleGraphNodes.filter(node => node.health === 'online').length,
            dirtyNodes: visibleGraphNodes.filter(node => node.dirty).length,
            orphanNodes: orphanCount,
            errorNodes: visibleGraphNodes.filter(node => Boolean(node.error) || node.outOfSync).length,
            offlineNodes: offlineCount,
            followUpNodes,
            blockedReviewNodes,
            mergeReadyNodes,
            cleanupCandidateNodes,
            notMergeableNodes,
            incompleteSnapshotNodes,
            missingGitSnapshotNodes,
            missingSubmoduleSnapshotNodes,
            staleGitSnapshotNodes,
            totalActiveSessions: visibleGraphNodes.reduce((total, node) => total + node.activeSessionCount, 0),
        },
        warnings,
        snapshotWarnings,
    }
}
