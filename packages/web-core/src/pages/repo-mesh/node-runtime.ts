/**
 * Node runtime as the COORDINATOR reports it (mesh_status nodes).
 *
 * The mesh settings list renders config records (list_meshes nodes); their live
 * state — sessions, whether the machine is reachable — comes from the
 * coordinator's mesh_status for the same node id, never from searching the
 * connected daemons' own session lists or statuses.
 */
import type { RepoMeshNodeStatus } from '@adhdev/daemon-core'

export interface NodeRuntimeSession {
    id: string
    provider: string
    status: string
}

/** The node's sessions per the coordinator (remote nodes via heldRuntime, folded in by repo-mesh-status). */
export function getCoordinatorNodeSessions(statusNode: RepoMeshNodeStatus | null | undefined): NodeRuntimeSession[] {
    const details = Array.isArray(statusNode?.activeSessionDetails) ? statusNode!.activeSessionDetails : []
    return details
        .filter(session => !!session?.sessionId)
        .map(session => ({
            id: session.sessionId,
            provider: session.providerType || 'unknown',
            status: session.chatStatus || session.state || 'unknown',
        }))
}

/**
 * 'online' / 'offline' for the node's machine as the coordinator sees it, or
 * null when the coordinator's answer carries no signal. Order: the
 * coordinator's explicit machineStatus, then its connection state, then its
 * held git observation (unreachable since …).
 */
export function readCoordinatorNodeMachineStatus(statusNode: RepoMeshNodeStatus | null | undefined): string | null {
    if (!statusNode) return null
    const machineStatus = typeof statusNode.machineStatus === 'string' ? statusNode.machineStatus.trim() : ''
    if (machineStatus) return machineStatus
    const state = statusNode.connection?.state
    if (state === 'self' || state === 'connected') return 'online'
    if (typeof statusNode.gitObservation?.unreachableSince === 'number') return 'offline'
    if (state === 'failed' || state === 'closed' || state === 'disconnected') return 'offline'
    return null
}

/** Machine nickname / platform the coordinator holds for the node (nodeFacts). */
export function readCoordinatorNodeMachineFacts(statusNode: RepoMeshNodeStatus | null | undefined): { machineNickname?: string; platform?: string } {
    const facts = statusNode?.nodeFacts
    const machineNickname = typeof facts?.machineNickname === 'string' && facts.machineNickname.trim() ? facts.machineNickname.trim() : undefined
    const platform = typeof facts?.platform === 'string' && facts.platform.trim() ? facts.platform.trim() : undefined
    return { ...(machineNickname ? { machineNickname } : {}), ...(platform ? { platform } : {}) }
}
