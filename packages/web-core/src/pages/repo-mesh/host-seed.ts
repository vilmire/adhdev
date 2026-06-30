import { daemonIdsEquivalent } from '@adhdev/mesh-shared'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import type { MeshNode } from './types'

/**
 * HOST-MISSEED-FIRSTSETUP — first-setup host seed priority.
 *
 * When a mesh has no persisted host pin yet (meshHost.hostDaemonId absent), the UI
 * still needs a daemon to command/view from while a "Launch Host Coordinator" action
 * establishes the host daemon-side. The legacy fallback was a bare `daemons[0]`, which
 * on cloud is just P2P insertion order — so an unrelated MEMBER daemon (e.g. moltbot)
 * could land at index 0 and get seeded as the host candidate, rendering "Will host on
 * <wrong daemon>".
 *
 * Priority (highest first):
 *   1. A node already flagged role:'host' (the daemon-side host declaration, persisted
 *      at add_mesh_node time) — its daemon, when connected.
 *   2. The daemon the operator is viewing from (self / active), never an arbitrary peer.
 *   3. The legacy first-connected fallback (daemons[0]).
 *
 * All id comparisons go through daemonIdsEquivalent so daemon_mach_/mach_/standalone_
 * forms of one machine match. On standalone daemons[0] is self, so steps 2 and 3
 * coincide and the prior behavior is preserved (no regression).
 */
export function resolveFirstSetupSeedDaemonId(
    daemons: RepoMeshDaemonEntry[],
    nodes: MeshNode[],
    selfDaemonId: string | undefined,
    primaryDaemonId: string | undefined,
): string {
    if (!daemons.length) return ''

    // 1) A node already marked role:'host' wins over insertion order.
    const hostNode = nodes.find(n => (n as any).role === 'host')
    const hostNodeDaemonId = String((hostNode as any)?.daemon_id || (hostNode as any)?.daemonId || '')
    if (hostNodeDaemonId) {
        const match = daemons.find(d => daemonIdsEquivalent(d.id, hostNodeDaemonId))
        if (match) return match.id
    }

    // 2) The daemon the operator is currently viewing from (self) — never a peer.
    const self =
        daemons.find(d => selfDaemonId && daemonIdsEquivalent(d.id, selfDaemonId)) ||
        daemons.find(d => primaryDaemonId && daemonIdsEquivalent(d.id, primaryDaemonId))
    if (self) return self.id

    // 3) Last resort — preserve the legacy first-connected fallback.
    return daemons[0]?.id || ''
}
