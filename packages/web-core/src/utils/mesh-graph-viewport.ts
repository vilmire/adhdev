import type { MeshGraph, MeshGraphNode } from './mesh-visualization'

function uniqueIds(ids: Array<string | null | undefined>): string[] {
    return [...new Set(ids.filter((value): value is string => Boolean(value)))]
}

function nonSubmoduleNodes(data: MeshGraph): MeshGraphNode[] {
    return data.nodes.filter(node => node.type !== 'submoduleNode')
}

export function getMeshGraphInitialFocusNodeIds(data: MeshGraph): string[] {
    const defaultAnchor = data.nodes.find(node => node.type === 'defaultBranchNode') ?? null
    const preferredBranch = defaultAnchor?.branch ?? null

    const primaryBranchNodes = data.nodes.filter(node => (
        node.type !== 'defaultBranchNode'
        && node.type !== 'submoduleNode'
        && !node.isOrphan
        && Boolean(preferredBranch)
        && node.branch === preferredBranch
    ))

    const nonOrphanNodes = data.nodes.filter(node => node.type !== 'submoduleNode' && !node.isOrphan)
    const visibleNodes = nonSubmoduleNodes(data)

    if (defaultAnchor || primaryBranchNodes.length > 0) {
        return uniqueIds([defaultAnchor?.id, ...primaryBranchNodes.map(node => node.id)])
    }

    if (nonOrphanNodes.length > 0) {
        return uniqueIds(nonOrphanNodes.map(node => node.id))
    }

    if (visibleNodes.length > 0) {
        return uniqueIds(visibleNodes.map(node => node.id))
    }

    return uniqueIds(data.nodes.map(node => node.id))
}

export function shouldShowMeshGraphMiniMap(data: MeshGraph): boolean {
    const visibleNodes = nonSubmoduleNodes(data)
    const branchCount = new Set(visibleNodes.map(node => node.branch).filter((branch): branch is string => Boolean(branch))).size
    const submoduleCount = data.nodes.filter(node => node.type === 'submoduleNode').length
    const orphanCount = visibleNodes.filter(node => node.isOrphan).length

    return visibleNodes.length >= 6 || branchCount >= 3 || submoduleCount >= 3 || orphanCount > 0
}

export function getMeshGraphLayoutKey(data: MeshGraph): string {
    const nodeSignature = [...data.nodes]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(node => [node.id, node.type, node.branch ?? '', node.parentNodeId ?? '', node.submodulePath ?? ''].join(':'))
        .join('|')
    const edgeSignature = [...data.edges]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(edge => [edge.id, edge.source, edge.target, edge.type].join(':'))
        .join('|')

    return `${data.meshId}::${nodeSignature}::${edgeSignature}`
}

export function getMeshGraphViewportKey(data: MeshGraph, width: number, height: number): string {
    const safeWidth = Math.max(0, Math.round(width))
    const safeHeight = Math.max(0, Math.round(height))
    return `${getMeshGraphLayoutKey(data)}::${safeWidth}x${safeHeight}`
}
