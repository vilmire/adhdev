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
 * Resolve the detected CLI providers to show for an existing node.
 *
 * Primary path: key by the node's own daemon (`daemon_id`) so a multi-machine
 * mesh never leaks one machine's detected providers into another's panel.
 *
 * Standalone fallback: standalone mesh nodes carry NO `daemon_id` (there is a
 * single local daemon and nodes aren't daemon-bound the way cloud nodes are).
 * Failing closed to `[]` in that case made every detected provider render as
 * "not on this machine" even though the local daemon reports them detected.
 * So when the node has no daemon binding AND exactly one daemon is connected,
 * use that sole daemon's providers — unambiguous, with no cross-machine leak
 * risk (there is only one machine).
 */
export function resolveNodeAvailableProviders(
    node: MeshNode,
    providersByDaemonId: Map<string, AvailableCliProviderOption[]>,
): AvailableCliProviderOption[] {
    const nodeDaemonId = String((node as any).daemon_id || (node as any).daemonId || '')
    if (nodeDaemonId && providersByDaemonId.has(nodeDaemonId)) {
        return providersByDaemonId.get(nodeDaemonId)!
    }
    // Single-daemon (standalone) fallback: unbound node + exactly one daemon.
    if (!nodeDaemonId && providersByDaemonId.size === 1) {
        return [...providersByDaemonId.values()][0]
    }
    return []
}
