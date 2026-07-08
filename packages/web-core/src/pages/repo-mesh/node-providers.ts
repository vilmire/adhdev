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

/** A capability tag for display: its raw form plus whether the operator set it. */
export interface NodeCapabilityTag {
    tag: string
    /** true = operator-authored custom tag; false = auto-derived (os/arch/provider/worktree). */
    custom: boolean
}

/**
 * Derive the capability tags shown for a node, mirroring the daemon's
 * buildMeshNodeCapabilityTags (mesh-work-queue.ts) for the operator-facing subset:
 * custom `capabilities`, `os=`, `arch=`, `provider=`, and `worktree=<branch>`.
 *
 * The daemon's internal `converge=refine|fast_forward` routing tag is intentionally
 * omitted — it is scheduler plumbing, not something an operator targets by hand.
 * Precedence for os/arch matches the daemon: userOverrides → reported → (unknown).
 */
export function deriveNodeCapabilityTags(node: MeshNode): NodeCapabilityTag[] {
    const n = node as any
    const out: NodeCapabilityTag[] = []

    // Operator-authored custom tags first (order preserved).
    const custom = Array.isArray(n.capabilities) ? n.capabilities : []
    for (const t of custom) {
        const s = typeof t === 'string' ? t.trim() : ''
        if (s) out.push({ tag: s, custom: true })
    }

    const os = (n.userOverrides?.platform || n.reportedPlatform || '').toString().trim()
    const arch = (n.userOverrides?.arch || n.reportedArch || '').toString().trim()
    if (os) out.push({ tag: `os=${os}`, custom: false })
    if (arch) out.push({ tag: `arch=${arch}`, custom: false })

    const provider = Array.isArray(n.policy?.providerPriority) ? String(n.policy.providerPriority[0] || '').trim() : ''
    if (provider) out.push({ tag: `provider=${provider}`, custom: false })

    const worktreeBranch = typeof n.worktreeBranch === 'string' ? n.worktreeBranch.trim() : ''
    if (n.isLocalWorktree === true && worktreeBranch) out.push({ tag: `worktree=${worktreeBranch}`, custom: false })

    return out
}
