/**
 * Mesh Visualization — transform RepoMeshStatus into a graph model that can be
 * rendered by richer graph surfaces (React Flow, SVG, etc.).
 */

import type {
    GitRepoStatus,
    RepoMeshNodeHealth,
    RepoMeshNodeStatus,
    RepoMeshStatus,
} from '@adhdev/daemon-core'

export type MeshGraphNodeType = 'defaultBranchNode' | 'worktreeNode' | 'orphanNode' | 'submoduleNode'
export type MeshGraphEdgeType = 'parentBranch' | 'worktreeLink' | 'sessionLink' | 'orphanLink' | 'submoduleLink'

type MeshGraphSubmoduleStatus = NonNullable<GitRepoStatus['submodules']>[number]

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
    machineLabel: string | null
    health: RepoMeshNodeHealth
    ahead: number
    behind: number
    dirty: boolean
    dirtyFiles: number
    hasConflicts: boolean
    activeSessionCount: number
    activeSessions: string[]
    providers: string[]
    isOrphan: boolean
    orphanReasons: string[]
    nextStepHint?: string
    error?: string
    parentNodeId?: string | null
    submodulePath?: string | null
    submoduleCommit?: string | null
    outOfSync?: boolean
    branchConvergence: MeshGraphBranchConvergence | null
    source: MeshGraphNodeSource
}

export interface MeshGraphEdge {
    id: string
    source: string
    target: string
    type: MeshGraphEdgeType
    label?: string
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
        totalActiveSessions: number
    }
    warnings: string[]
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

function evaluateBranchConvergence(node: RepoMeshNodeStatus, defaultBranch: string | null): MeshGraphBranchConvergence | null {
    if (!defaultBranch) return null

    const git = node.git
    const branch = git?.branch ?? null
    const upstream = git?.upstream ?? null
    const upstreamStatus = git?.upstreamStatus ?? null
    const ahead = git?.ahead ?? 0
    const behind = git?.behind ?? 0
    const dirty = isDirty(git) || hasDirtySubmodules(git)
    const hasConflicts = Boolean(git?.hasConflicts) || hasOutOfSyncSubmodules(git)
    const base = {
        branch,
        defaultBranch,
        upstream,
        upstreamStatus,
        ahead,
        behind,
        dirty,
        hasConflicts,
    }

    if (git?.isGitRepo !== true) {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: 'git_status_unavailable',
            nextStep: `Resolve git status for '${node.machineLabel || node.nodeId}' before declaring the mesh converged.`,
        }
    }

    if (!branch) {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: 'branch_unknown',
            nextStep: `Inspect '${node.machineLabel || node.nodeId}' and confirm which branch should converge into ${defaultBranch}.`,
        }
    }

    if (hasConflicts || dirty) {
        return {
            ...base,
            status: 'not_mergeable',
            needsConvergence: true,
            reason: git?.hasConflicts ? 'conflicts_present' : hasOutOfSyncSubmodules(git) ? 'submodule_out_of_sync' : 'dirty_workspace',
            nextStep: `Commit, checkpoint, or resolve '${branch}' before any convergence step into ${defaultBranch}.`,
        }
    }

    if (upstream && upstreamStatus && upstreamStatus !== 'fresh') {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: 'upstream_unverified',
            nextStep: `Refresh '${branch}' against ${upstream} before claiming the mesh is converged.`,
        }
    }

    if (branch === defaultBranch) {
        if (ahead > 0 || behind > 0) {
            return {
                ...base,
                status: 'blocked_review',
                needsConvergence: true,
                reason: 'default_branch_not_even_with_upstream',
                nextStep: `Bring ${defaultBranch} even with ${upstream ?? 'its upstream'} before declaring convergence complete.`,
            }
        }
        return {
            ...base,
            status: 'merged_to_main',
            needsConvergence: false,
            reason: 'clean_default_branch',
            nextStep: null,
        }
    }

    if (node.isLocalWorktree) {
        return {
            ...base,
            status: 'cleanup_candidate',
            needsConvergence: true,
            reason: 'clean_non_default_worktree_branch',
            nextStep: `Run refine / cleanup for '${branch}' or explicitly classify the worktree before ending the task.`,
        }
    }

    if (!upstream || ahead > 0 || behind > 0) {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: !upstream ? 'feature_branch_missing_upstream' : 'feature_branch_not_even_with_upstream',
            nextStep: `Push or reconcile '${branch}', then merge it into ${defaultBranch} or mark it blocked with a reason.`,
        }
    }

    return {
        ...base,
        status: 'pushed_feature_branch_needs_merge',
        needsConvergence: true,
        reason: 'clean_non_default_branch',
        nextStep: `Review and merge '${branch}' into ${defaultBranch}; do not treat it as fully complete while it remains off ${defaultBranch}.`,
    }
}

function getSubmoduleHealth(submodule: MeshGraphSubmoduleStatus): RepoMeshNodeHealth {
    if (submodule.error || submodule.outOfSync) return 'degraded'
    if (submodule.dirty) return 'dirty'
    return 'online'
}

export function buildMeshGraph(status: RepoMeshStatus): MeshGraph {
    const meshDefaultBranch = typeof (status as any).defaultBranch === 'string' && (status as any).defaultBranch.trim().length > 0
        ? (status as any).defaultBranch.trim()
        : null
    const inferredDefaultBranch = meshDefaultBranch ?? inferDefaultBranch(status.nodes)
    const nodes: MeshGraphNode[] = []
    const edges: MeshGraphEdge[] = []
    const warnings: string[] = []
    const branchToNodeIds = new Map<string, string[]>()

    for (const nodeStatus of status.nodes) {
        const git = nodeStatus.git
        const branch = git?.branch ?? null
        const submoduleHealth = getParentSubmoduleHealth(git)
        const dirty = isDirty(git) || submoduleHealth === 'dirty'
        const orphanReasons = detectOrphanReasons(nodeStatus, inferredDefaultBranch)
        const branchConvergence = evaluateBranchConvergence(nodeStatus, inferredDefaultBranch)
        const graphNode: MeshGraphNode = {
            id: nodeStatus.nodeId,
            type: orphanReasons.length > 0 ? 'orphanNode' : 'worktreeNode',
            label: nodeStatus.machineLabel || nodeStatus.nodeId.slice(0, 8),
            workspace: nodeStatus.workspace,
            branch,
            upstream: git?.upstream ?? null,
            upstreamStatus: git?.upstreamStatus ?? null,
            machineLabel: nodeStatus.machineLabel || null,
            health: pickDominantHealth([nodeStatus.health, submoduleHealth]),
            ahead: git?.ahead ?? 0,
            behind: git?.behind ?? 0,
            dirty,
            dirtyFiles: dirtyFileCount(git),
            hasConflicts: git?.hasConflicts ?? false,
            activeSessionCount: nodeStatus.activeSessions?.length ?? 0,
            activeSessions: nodeStatus.activeSessions ?? [],
            providers: nodeStatus.providers ?? [],
            isOrphan: orphanReasons.length > 0,
            orphanReasons,
            error: nodeStatus.error,
            nextStepHint: orphanReasons[0] ?? branchConvergence?.nextStep ?? undefined,
            parentNodeId: null,
            submodulePath: null,
            submoduleCommit: git?.headCommit ?? null,
            outOfSync: hasOutOfSyncSubmodules(git),
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
                machineLabel: graphNode.machineLabel,
                health: getSubmoduleHealth(submodule),
                ahead: 0,
                behind: 0,
                dirty: submodule.dirty,
                dirtyFiles: submodule.dirty ? 1 : 0,
                hasConflicts: false,
                activeSessionCount: 0,
                activeSessions: [],
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
        const dominantBranchConvergence = branchConvergences.length > 0
            ? pickDominantBranchConvergence(branchConvergences)
            : null
        const unresolvedBranchConvergenceCount = branchConvergences.filter(convergence => convergence.needsConvergence).length

        const syntheticDefaultNode: MeshGraphNode = {
            id: defaultBranchNodeId,
            type: 'defaultBranchNode',
            label: inferredDefaultBranch,
            workspace: status.repoIdentity,
            branch: inferredDefaultBranch,
            upstream: null,
            upstreamStatus: null,
            machineLabel: 'default branch',
            health: pickDominantHealth(branchNodes.map(node => node.health)),
            ahead: 0,
            behind: 0,
            dirty: branchNodes.some(node => node.dirty),
            dirtyFiles: branchNodes.reduce((total, node) => total + node.dirtyFiles, 0),
            hasConflicts: branchNodes.some(node => node.hasConflicts),
            activeSessionCount: branchNodes.reduce((total, node) => total + node.activeSessionCount, 0),
            activeSessions: branchNodes.flatMap(node => node.activeSessions),
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
            branchConvergence: dominantBranchConvergence,
            source: {
                nodeId: defaultBranchNodeId,
                machineLabel: inferredDefaultBranch,
                workspace: status.repoIdentity,
                health: pickDominantHealth(branchNodes.map(node => node.health)),
                providers: [],
                activeSessions: [],
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
            })
        }
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

    if (followUpNodes > 0) warnings.push(`${followUpNodes} workspace(s) still need follow-up before the mesh is converged`)
    if (orphanCount > 0) warnings.push(`${orphanCount} workspace(s) need attention before safe coordination`)
    if (blockedReviewNodes > 0) warnings.push(`${blockedReviewNodes} workspace(s) are blocked on branch convergence or upstream sync`)
    if (mergeReadyNodes > 0) warnings.push(`${mergeReadyNodes} clean feature branch workspace(s) still need merge follow-up`)
    if (cleanupCandidateNodes > 0) warnings.push(`${cleanupCandidateNodes} worktree workspace(s) are ready for refine / cleanup`)
    if (notMergeableNodes > 0) warnings.push(`${notMergeableNodes} workspace(s) have local changes or conflicts blocking convergence`)
    if (conflictCount > 0) warnings.push(`${conflictCount} workspace(s) report merge conflicts`)
    if (offlineCount > 0) warnings.push(`${offlineCount} node(s) are currently offline`)
    if (outOfSyncSubmoduleCount > 0) warnings.push(`${outOfSyncSubmoduleCount} submodule(s) are out of sync with their parent checkout`)
    if (!inferredDefaultBranch) warnings.push('Could not infer a default branch from live mesh status')

    return {
        meshId: status.meshId,
        meshName: status.meshName,
        repoIdentity: status.repoIdentity,
        refreshedAt: status.refreshedAt,
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
            totalActiveSessions: visibleGraphNodes.reduce((total, node) => total + node.activeSessionCount, 0),
        },
        warnings,
    }
}
