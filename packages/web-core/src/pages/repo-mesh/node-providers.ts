import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import {
    normalizeAvailableCliProviders,
    type AvailableCliProviderOption,
} from '../../utils/provider-priority'
import type { MeshNode } from './types'

/**
 * Build a daemon-id → normalized detected CLI providers map.
 *
 * The "DEFAULT CLI PROVIDERS" list for an existing node must reflect *that node's*
 * daemon — not the mesh's first daemon (daemons[0], from which `availableCliProviders`
 * is derived). In a multi-machine mesh, daemons[0] may be a remote machine, so falling
 * back to it would leak the remote machine's detected providers into a local node's panel.
 */
export function buildProvidersByDaemonId(
    daemons: RepoMeshDaemonEntry[],
): Map<string, AvailableCliProviderOption[]> {
    const map = new Map<string, AvailableCliProviderOption[]>()
    for (const d of daemons) {
        if (!d?.id) continue
        map.set(d.id, normalizeAvailableCliProviders((d as any).availableProviders || []))
    }
    return map
}

/**
 * Resolve the detected CLI providers to show for an existing node, keyed by its own
 * daemon. Falls back to an empty list when the node has no daemon_id or no matching
 * daemon is connected — never show another machine's providers.
 */
export function resolveNodeAvailableProviders(
    node: MeshNode,
    providersByDaemonId: Map<string, AvailableCliProviderOption[]>,
): AvailableCliProviderOption[] {
    const nodeDaemonId = String((node as any).daemon_id || (node as any).daemonId || '')
    if (nodeDaemonId && providersByDaemonId.has(nodeDaemonId)) {
        return providersByDaemonId.get(nodeDaemonId)!
    }
    return []
}
