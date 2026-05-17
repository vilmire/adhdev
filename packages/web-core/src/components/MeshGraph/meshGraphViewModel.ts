import type { MeshGraphData, MeshGraphNode } from './types'

const LARGE_GRAPH_MINIMAP_THRESHOLD = 7

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

export function shouldShowMeshGraphCallout(node: MeshGraphNode): boolean {
    if (!node.nextStepHint) return false
    if (node.type === 'defaultBranchNode') return false
    if (node.isOrphan || node.hasConflicts || node.outOfSync || node.error) return true
    if (node.health === 'offline' || node.health === 'degraded' || node.health === 'wrong_branch') return true
    if (node.dirty) return true
    return false
}

export function shouldShowMeshGraphMiniMap(data: MeshGraphData): boolean {
    return data.nodes.length >= LARGE_GRAPH_MINIMAP_THRESHOLD
}
