/**
 * Machine health for a /mesh list card: how many of the mesh's machines are online.
 *
 * Reachability comes from the COORDINATOR's mesh_status (the same nodes the
 * detail view reads), never from the dashboard's own daemon list alone: on
 * standalone that list holds only the local daemon, so a remote member would
 * always read offline. The connected daemon entry is only the fallback for a
 * machine the coordinator has said nothing about yet (status not loaded).
 *
 * The host's own node carries no daemon binding on standalone (single local
 * daemon), so an unbound node counts as the host machine instead of being
 * dropped. On cloud every node carries its daemon id, so nothing changes there.
 */
import { daemonIdsEquivalent } from '@adhdev/mesh-shared'
import type { RepoMeshNodeStatus } from '@adhdev/daemon-core'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import { findStatusNodeForNode } from './node-providers'
import { readCoordinatorNodeMachineStatus } from './node-runtime'
import type { MeshNode } from './types'

export interface MeshListMachineHealth {
    /** Distinct machines (worktree clones excluded). */
    total: number
    online: number
}

/** Key for an unbound node when the host daemon is not known either. */
const LOCAL_MACHINE_KEY = '__local__'

function nodeDaemonId(node: MeshNode): string {
    return String((node as any).daemon_id || (node as any).daemonId || '').trim()
}

export function summarizeMeshListMachineHealth(args: {
    nodes: MeshNode[]
    daemons: RepoMeshDaemonEntry[]
    statusNodes?: RepoMeshNodeStatus[] | null
    /** The mesh's host daemon (resolveMeshHostDaemonId) — owner of unbound nodes. */
    hostDaemonId?: string
}): MeshListMachineHealth {
    const hostKey = String(args.hostDaemonId || '').trim() || LOCAL_MACHINE_KEY
    const groups: Array<{ key: string; statuses: string[] }> = []
    const groupFor = (key: string) => {
        const existing = groups.find(group => group.key === key
            || (key !== LOCAL_MACHINE_KEY && group.key !== LOCAL_MACHINE_KEY && daemonIdsEquivalent(group.key, key)))
        if (existing) return existing
        const created = { key, statuses: [] as string[] }
        groups.push(created)
        return created
    }
    for (const node of args.nodes) {
        if (node.isLocalWorktree === true) continue
        const statusNode = findStatusNodeForNode(node, args.statusNodes)
        // The coordinator's own node ("self") is the host machine whatever its record says.
        const isSelf = statusNode?.connection?.state === 'self'
        const key = isSelf ? hostKey : (nodeDaemonId(node) || hostKey)
        const group = groupFor(key)
        const status = readCoordinatorNodeMachineStatus(statusNode)
        if (status) group.statuses.push(status)
    }
    const online = groups.filter(group => {
        if (group.statuses.length > 0) return group.statuses.includes('online')
        if (group.key === LOCAL_MACHINE_KEY) return false
        const daemon = args.daemons.find(d => daemonIdsEquivalent(d.id, group.key))
        return !!daemon && (daemon.status === undefined || daemon.status === 'online')
    }).length
    return { total: groups.length, online }
}
