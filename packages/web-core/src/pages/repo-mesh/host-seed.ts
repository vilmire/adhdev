import { daemonIdsEquivalent } from '@adhdev/mesh-shared'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import type { MeshNode } from './types'

/**
 * HOST-MISSEED-FIRSTSETUP — first-setup host seed priority (authoritative-only).
 *
 * When a mesh has no persisted host pin yet (meshHost.hostDaemonId absent), the UI
 * still needs a daemon to command/view from while a "Launch Host Coordinator" action
 * establishes the host daemon-side. The legacy fallback was a bare `daemons[0]`, which
 * on cloud is just P2P insertion order — so an unrelated MEMBER daemon (e.g. moltbot)
 * could land at index 0 and get seeded as the host candidate, rendering "Will host on
 * <wrong daemon>" for a flash before the authoritative pin propagated.
 *
 * HOST-MISSEED-FIRSTSETUP-FALLBACK-REMOVAL: the arbitrary-peer fallbacks are now GONE.
 * This function seeds a host candidate ONLY from an authoritative signal:
 *   0. The daemon-side *resolved* host pin from the loaded mesh_status payload
 *      (resolveMeshHostStatus's synthesized hostDaemonId). This is the daemon's own
 *      answer to "who hosts this mesh" and always wins.
 *   1. A node already flagged role:'host' (the daemon-side host declaration, persisted
 *      at add_mesh_node time) — its daemon, when connected.
 * If NEITHER is present it returns '' (no seed). It deliberately does NOT fall back to
 * `selfDaemonId`/`primaryDaemonId`/`daemons[0]`: on cloud there is no genuine browser
 * self-daemon, so those all collapse to the first-connected peer (P2P insertion order),
 * which is exactly the wrong-node flash we are eliminating. An empty seed makes the
 * header render a neutral "resolving/unpinned" state instead of an arbitrary node name.
 *
 * This function is only invoked on cloud (features.meshHostDaemonSection); standalone
 * seeds coordinatorDaemonId from primaryDaemonId directly and is unaffected.
 *
 * `selfDaemonId`/`primaryDaemonId` are retained in the signature for call-site
 * compatibility but are intentionally unused — they are not authoritative host signals.
 *
 * All id comparisons go through daemonIdsEquivalent so daemon_mach_/mach_/standalone_
 * forms of one machine match.
 */
/** Minimal shape of the daemon-resolved meshHost payload the dashboard reads. */
export interface ResolvedMeshHostPayload {
    hostDaemonId?: string
    hostNodeId?: string
    /** Daemon-side flag: the pin was inferred from the evaluating daemon, not persisted. */
    hostSynthesized?: boolean
}

/**
 * HOST-SELF-SYNTHESIS-GUARD — demote a synthesized host pin to "no pin".
 *
 * `meshHost.role` defaults to 'host' on every peer, so a mesh whose host was never
 * persisted makes EVERY daemon answer "I am the host" when asked. Which daemon the
 * dashboard asks is P2P arrival order, so a synthesized pin is not a fact about the
 * mesh — it is a fact about who answered. Rendering it as an established host produced
 * a confident badge naming an arbitrary machine, and the same id is the coordinator
 * Launch target, whose launch permanently pins the host.
 *
 * So a synthesized pin is stripped here: the caller falls through to the neutral
 * first-setup state, which requires the operator to choose the host explicitly.
 * An authoritative pin (persisted hostDaemonId/hostNodeId, or a node the daemon
 * declared role:'host') passes through untouched.
 *
 * The daemon-side resolver applies the same guard before it ever synthesizes on a
 * multi-peer mesh; this is the dashboard-side layer, which additionally covers a
 * single-peer synthesis (still only a guess) and older daemons that omit the flag.
 */
export function readAuthoritativeMeshHostPin(meshHost: ResolvedMeshHostPayload | undefined): {
    hostDaemonId: string
    hostNodeId: string
} {
    if (!meshHost || meshHost.hostSynthesized) return { hostDaemonId: '', hostNodeId: '' }
    return {
        hostDaemonId: String(meshHost.hostDaemonId || ''),
        hostNodeId: String(meshHost.hostNodeId || ''),
    }
}

export function resolveFirstSetupSeedDaemonId(
    daemons: RepoMeshDaemonEntry[],
    nodes: MeshNode[],
    _selfDaemonId: string | undefined,
    _primaryDaemonId: string | undefined,
    resolvedHostDaemonId?: string,
): string {
    if (!daemons.length) return ''

    // 0) The daemon-side resolved host pin (mesh_status meshHost.hostDaemonId) wins —
    //    it is the daemon's own answer to "who hosts this mesh". Prefer a connected
    //    daemon matching it; if the resolved host is offline, still seed its id so the
    //    UI never falls through to an arbitrary member while the pin propagates.
    const resolvedHostId = String(resolvedHostDaemonId || '')
    if (resolvedHostId) {
        const match = daemons.find(d => daemonIdsEquivalent(d.id, resolvedHostId))
        if (match) return match.id
        return resolvedHostId
    }

    // 1) A node already marked role:'host' — an explicit daemon-side host declaration.
    const hostNode = nodes.find(n => (n as any).role === 'host')
    const hostNodeDaemonId = String((hostNode as any)?.daemon_id || (hostNode as any)?.daemonId || '')
    if (hostNodeDaemonId) {
        const match = daemons.find(d => daemonIdsEquivalent(d.id, hostNodeDaemonId))
        if (match) return match.id
    }

    // No authoritative host signal yet — DO NOT seed an arbitrary peer. Returning ''
    // lets the header show a neutral "resolving host…" state instead of flashing an
    // unrelated member daemon (HOST-MISSEED-FIRSTSETUP). Genuine first-setup (a brand
    // new mesh with no host chosen) also lands here, which is correct — the UI then
    // prompts the operator to launch the coordinator to fix the host.
    return ''
}
