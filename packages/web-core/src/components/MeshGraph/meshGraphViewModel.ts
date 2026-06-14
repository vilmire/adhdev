import type { MeshGraphData, MeshGraphNode } from './types'

function rankOverviewNode(node: MeshGraphNode): number {
    if (node.type === 'defaultBranchNode') return 0
    if (node.isOrphan) return 3
    if (node.type === 'submoduleNode') return 4
    if (node.branch) return 1
    return 2
}

export function getMeshGraphViewportFocusNodeIds(data: MeshGraphData): string[] {
    const defaultAnchor = data.nodes.find(node => node.type === 'defaultBranchNode') ?? null
    const primaryBranch = defaultAnchor?.branch ?? null

    const primaryNodes = data.nodes
        .filter(node => {
            if (node.type === 'submoduleNode') return false
            if (primaryBranch && node.branch === primaryBranch) return true
            return node.type === 'defaultBranchNode'
        })
        .sort((a, b) => rankOverviewNode(a) - rankOverviewNode(b) || a.label.localeCompare(b.label))

    if (primaryNodes.length > 0) {
        return primaryNodes.map(node => node.id)
    }

    return [...data.nodes]
        .filter(node => node.type !== 'submoduleNode')
        .sort((a, b) => rankOverviewNode(a) - rankOverviewNode(b) || a.label.localeCompare(b.label))
        .slice(0, 4)
        .map(node => node.id)
}

export type MeshGraphAttentionBadgeTone = 'good' | 'warn' | 'danger' | 'info'

export function formatMeshGraphAheadBehind(node: MeshGraphNode): string | null {
    if (node.ahead <= 0 && node.behind <= 0) return null
    if (node.ahead > 0 && node.behind > 0) return `ahead ${node.ahead} / behind ${node.behind}`
    if (node.behind > 0) return `behind ${node.behind}`
    return `ahead ${node.ahead}`
}

export function getMeshGraphAttentionBadge(node: MeshGraphNode): { label: string; tone: MeshGraphAttentionBadgeTone } | null {
    if (node.type === 'submoduleNode') {
        if (node.outOfSync || node.error) return { label: 'submodule drift', tone: 'danger' }
        if (node.dirty) return { label: 'submodule dirty', tone: 'warn' }
        return null
    }

    const convergence = node.branchConvergence
    if (convergence?.status === 'not_mergeable') {
        return { label: node.hasConflicts ? 'conflicts present' : 'dirty workspace', tone: 'danger' }
    }
    if (convergence?.status === 'blocked_review') {
        if (convergence.reason === 'upstream_unverified') return { label: 'upstream unverified', tone: 'warn' }
        const drift = formatMeshGraphAheadBehind(node)
        if (drift) return { label: drift, tone: 'danger' }
        if (!node.upstream && node.branch && node.branch !== convergence.defaultBranch) return { label: 'push branch', tone: 'warn' }
        return { label: 'blocked review', tone: 'danger' }
    }
    // Refine job state ranks below the hard convergence blockers above (not_mergeable /
    // blocked_review drift already returned) but above orphan/offline — a live or failed
    // refine is the more actionable signal for an otherwise-idle worktree.
    if (node.refineJobStatus === 'failed') return { label: 'refine failed', tone: 'danger' }
    if (node.refineJobStatus === 'running' || node.refineJobStatus === 'accepted') return { label: 'refining…', tone: 'info' }
    if (convergence?.status === 'pushed_feature_branch_needs_merge') return { label: 'needs merge', tone: 'warn' }
    if (convergence?.status === 'cleanup_candidate') return { label: 'refine worktree', tone: 'info' }
    if (node.isOrphan) return { label: 'needs follow-up', tone: 'warn' }
    if (node.health === 'offline') return { label: 'offline', tone: 'danger' }
    return null
}

export function getMeshGraphCalloutText(node: MeshGraphNode): string | null {
    return node.nextStepHint ?? node.branchConvergence?.nextStep ?? null
}

export function shouldShowMeshGraphCallout(node: MeshGraphNode): boolean {
    if (!getMeshGraphCalloutText(node)) return false
    if (node.type === 'defaultBranchNode') return false
    if (node.branchConvergence?.needsConvergence) return true
    if (node.isOrphan || node.hasConflicts || node.outOfSync || node.error) return true
    if (node.health === 'offline' || node.health === 'degraded' || node.health === 'wrong_branch') return true
    if (node.dirty) return true
    return false
}
