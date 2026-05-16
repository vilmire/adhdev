/**
 * Mesh Visualization — transform RepoMeshStatus into a graph model that can be
 * rendered by richer graph surfaces (React Flow, SVG, etc.).
 */

import type { GitRepoStatus, RepoMeshNodeHealth, RepoMeshNodeStatus, RepoMeshStatus } from '@adhdev/daemon-core'

export type MeshGraphNodeType = 'defaultBranchNode' | 'worktreeNode' | 'orphanNode'
export type MeshGraphEdgeType = 'parentBranch' | 'worktreeLink' | 'sessionLink' | 'orphanLink'

export interface MeshGraphNode {
    id: string
    type: MeshGraphNodeType
    label: string
    workspace: string
    branch: string | null
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
    source: RepoMeshNodeStatus
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
        totalActiveSessions: number
    }
    warnings: string[]
}

function isDirty(git?: GitRepoStatus): boolean {
    if (!git) return false
    return (git.staged + git.modified + git.untracked + git.deleted + git.renamed) > 0
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

    if (node.error) {
        reasons.push(node.error)
    }

    return reasons
}

export function buildMeshGraph(status: RepoMeshStatus): MeshGraph {
    const inferredDefaultBranch = inferDefaultBranch(status.nodes)
    const nodes: MeshGraphNode[] = []
    const edges: MeshGraphEdge[] = []
    const warnings: string[] = []
    const branchToNodeIds = new Map<string, string[]>()

    for (const nodeStatus of status.nodes) {
        const git = nodeStatus.git
        const branch = git?.branch ?? null
        const dirty = isDirty(git)
        const orphanReasons = detectOrphanReasons(nodeStatus, inferredDefaultBranch)
        const graphNode: MeshGraphNode = {
            id: nodeStatus.nodeId,
            type: orphanReasons.length > 0 ? 'orphanNode' : 'worktreeNode',
            label: nodeStatus.machineLabel || nodeStatus.nodeId.slice(0, 8),
            workspace: nodeStatus.workspace,
            branch,
            machineLabel: nodeStatus.machineLabel || null,
            health: nodeStatus.health,
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
            nextStepHint: orphanReasons[0],
            source: nodeStatus,
        }
        nodes.push(graphNode)
        if (branch) {
            const ids = branchToNodeIds.get(branch) ?? []
            ids.push(graphNode.id)
            branchToNodeIds.set(branch, ids)
        }
    }

    const defaultBranchNodeId = inferredDefaultBranch ? `__branch_${inferredDefaultBranch}` : null

    if (defaultBranchNodeId && inferredDefaultBranch) {
        const branchNodeIds = branchToNodeIds.get(inferredDefaultBranch) ?? []
        const branchNodes = branchNodeIds
            .map(id => nodes.find(node => node.id === id))
            .filter(Boolean) as MeshGraphNode[]

        const syntheticDefaultNode: MeshGraphNode = {
            id: defaultBranchNodeId,
            type: 'defaultBranchNode',
            label: inferredDefaultBranch,
            workspace: status.repoIdentity,
            branch: inferredDefaultBranch,
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
            nextStepHint: branchNodes.length > 0 ? `${branchNodes.length} workspace(s) currently on ${inferredDefaultBranch}` : 'No workspaces currently checked out to the default branch',
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
            if (node.id === defaultBranchNodeId) continue
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

    const orphanCount = nodes.filter(node => node.isOrphan).length
    const conflictCount = nodes.filter(node => node.hasConflicts).length
    const offlineCount = nodes.filter(node => node.health === 'offline').length

    if (orphanCount > 0) warnings.push(`${orphanCount} workspace(s) need attention before safe coordination`)
    if (conflictCount > 0) warnings.push(`${conflictCount} workspace(s) report merge conflicts`)
    if (offlineCount > 0) warnings.push(`${offlineCount} node(s) are currently offline`)
    if (!inferredDefaultBranch) warnings.push('Could not infer a default branch from live mesh status')

    return {
        meshId: status.meshId,
        meshName: status.meshName,
        repoIdentity: status.repoIdentity,
        refreshedAt: status.refreshedAt,
        nodes,
        edges,
        stats: {
            totalNodes: status.nodes.length,
            onlineNodes: status.nodes.filter(node => node.health === 'online').length,
            dirtyNodes: nodes.filter(node => node.dirty).length,
            orphanNodes: orphanCount,
            errorNodes: status.nodes.filter(node => Boolean(node.error)).length,
            offlineNodes: offlineCount,
            totalActiveSessions: status.nodes.reduce((total, node) => total + (node.activeSessions?.length ?? 0), 0),
        },
        warnings,
    }
}
