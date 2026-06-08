import type { MeshGraphData, MeshGraphEdge, MeshGraphNode } from './types'

function nodeFingerprint(node: MeshGraphNode): string {
    return [
        node.id,
        node.type,
        node.label,
        node.branch ?? '',
        node.upstream ?? '',
        node.upstreamStatus ?? '',
        node.daemonId ?? '',
        node.machineId ?? '',
        node.machineLabel ?? '',
        node.locality,
        node.health,
        node.ahead,
        node.behind,
        node.dirty ? 1 : 0,
        node.dirtyFiles,
        node.hasConflicts ? 1 : 0,
        node.activeSessionCount,
        node.sessionDetails.map(session => [
            session.sessionId,
            session.providerType ?? '',
            session.state ?? '',
            session.chatStatus ?? '',
            session.lifecycle ?? '',
            session.role ?? '',
            session.isSelfCoordinator ? 1 : 0,
            session.startedAt ?? '',
            session.createdAt ?? '',
        ].join('/')).join(','),
        node.isOrphan ? 1 : 0,
        node.outOfSync ? 1 : 0,
        node.snapshotCompleteness,
        node.branchConvergence?.status ?? '',
        node.branchConvergence?.needsConvergence ? 1 : 0,
        node.nextStepHint ?? '',
        node.error ?? '',
        node.parentNodeId ?? '',
        node.submodulePath ?? '',
        node.submoduleCommit ?? '',
    ].join('|')
}

function edgeFingerprint(edge: MeshGraphEdge): string {
    return [edge.id, edge.source, edge.target, edge.type, edge.label ?? '', edge.direction].join('|')
}

export function getMeshGraphDataFingerprint(data: MeshGraphData): string {
    return [
        data.meshId,
        data.refreshedAt,
        data.nodes.length,
        data.edges.length,
        ...data.nodes.map(nodeFingerprint),
        ...data.edges.map(edgeFingerprint),
    ].join('::')
}

export function getMeshGraphLayoutFingerprint(data: MeshGraphData): string {
    return [
        data.meshId,
        data.nodes.length,
        data.edges.length,
        ...data.nodes.map(node => [
            node.id,
            node.type,
            node.label,
            node.branch ?? '',
            node.machineLabel ?? '',
            node.locality,
            node.health,
            node.dirty ? 1 : 0,
            node.dirtyFiles,
            node.hasConflicts ? 1 : 0,
            node.activeSessionCount,
            node.isOrphan ? 1 : 0,
            node.outOfSync ? 1 : 0,
            node.snapshotCompleteness,
            node.branchConvergence?.status ?? '',
            node.branchConvergence?.needsConvergence ? 1 : 0,
            node.nextStepHint ?? '',
            node.parentNodeId ?? '',
            node.submodulePath ?? '',
            node.submoduleCommit ?? '',
        ].join('|')),
        ...data.edges.map(edgeFingerprint),
    ].join('::')
}
