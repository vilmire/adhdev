import { normalizeNodeCapabilitySlots } from '@adhdev/mesh-shared'
import type { RepoMeshNodeStatus } from '@adhdev/daemon-core'

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
function memberNodeProviders(
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

function readRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

/**
 * The raw provider inventory the COORDINATOR holds for a node, when it carries
 * one (`nodeFacts.availableProviders` or `heldRuntime.availableProviders`).
 * Read defensively — older coordinators do not send it.
 */
export function readCoordinatorHeldProviders(statusNode: RepoMeshNodeStatus | null | undefined): any[] | null {
    if (!statusNode) return null
    const fromFacts = readRecord(statusNode.nodeFacts).availableProviders
    if (Array.isArray(fromFacts) && fromFacts.length > 0) return fromFacts
    const fromHeld = readRecord((statusNode as { heldRuntime?: unknown }).heldRuntime).availableProviders
    if (Array.isArray(fromHeld) && fromHeld.length > 0) return fromHeld
    return null
}

/**
 * Provider types the coordinator reports as detected on a node: the keys of its
 * held provider versions (node-level `providerVersions`, else the facts
 * bundle's), minus providers the node reports as disabled. Empty = the
 * coordinator did not say.
 */
export function readCoordinatorDetectedProviderTypes(statusNode: RepoMeshNodeStatus | null | undefined): string[] {
    if (!statusNode) return []
    const facts = readRecord(statusNode.nodeFacts)
    const versions = Object.keys(readRecord(statusNode.providerVersions)).length > 0
        ? readRecord(statusNode.providerVersions)
        : readRecord(facts.providerVersions)
    const enablement = readRecord(facts.providerEnablement)
    return Object.keys(versions)
        .map(type => type.trim())
        .filter(type => type && readRecord(enablement[type]).enabled !== false)
}

/**
 * Detected CLI providers to show for an existing node. The COORDINATOR's view
 * of the node wins (it holds every node's latest facts):
 *   1. a held provider inventory, when the coordinator carries one;
 *   2. the coordinator's detected provider set (provider versions) — labels and
 *      model lists are taken from the member's own inventory when it has the
 *      same provider, so the coordinator decides WHAT is there and the member
 *      only decorates it;
 *   3. only when the coordinator says nothing: the member daemon's own
 *      inventory (the pre-coordinator behavior, below).
 *
 * Member fallback: key by the node's own daemon (`daemon_id`) so a multi-machine
 * mesh never leaks one machine's detected providers into another's panel.
 * Standalone mesh nodes carry NO `daemon_id` (single local daemon), so an unbound
 * node with exactly one connected daemon uses that daemon's providers.
 */
export function resolveNodeAvailableProviders(
    node: MeshNode,
    providersByDaemonId: Map<string, AvailableCliProviderOption[]>,
    statusNode?: RepoMeshNodeStatus | null,
): AvailableCliProviderOption[] {
    const held = readCoordinatorHeldProviders(statusNode)
    if (held) return normalizeAvailableCliProviders(held)
    const member = memberNodeProviders(node, providersByDaemonId)
    const detected = readCoordinatorDetectedProviderTypes(statusNode)
    if (detected.length === 0) return member
    if (member.length > 0) {
        const detectedSet = new Set(detected)
        return member.filter(option => detectedSet.has(option.type))
    }
    return normalizeAvailableCliProviders(detected.map(type => ({ type, category: 'cli', installed: true })))
}

/** The union of provider inventories across a mesh's nodes, plus reporting coverage. */
export interface MeshProviderInventory {
    /** Raw provider entries, de-duplicated by `type` (first node to report one wins). */
    providers: any[]
    /** Nodes whose owning daemon has reported an inventory. */
    reportedNodeCount: number
    /** Nodes bound to a daemon that has not reported an inventory yet. */
    unreportedNodeCount: number
}

/**
 * Collect every CLI provider available anywhere in THIS mesh, as a union across the
 * mesh's own nodes.
 *
 * Scoped through `nodes` on purpose. The obvious shortcut — unioning `daemons`
 * directly — would pull in daemons that belong to no node of this mesh (the user's
 * other machines / other meshes), advertising providers that no node here can
 * actually launch. Mapping node → daemon → inventory keeps the result exactly "what
 * this mesh can run".
 *
 * The counters exist because an empty inventory is AMBIGUOUS: `availableProviders`
 * is populated only after P2P connects and `get_status_metadata` completes, so a
 * node that is merely still connecting looks identical to one with nothing
 * installed. Callers must render "not reported yet" distinctly instead of asserting
 * "none" — reporting a pending reading as a settled fact is the failure mode this
 * whole surface keeps hitting.
 */
export function collectMeshProviderInventory(
    nodes: MeshNode[] | undefined | null,
    daemons: RepoMeshDaemonEntry[],
    /** The coordinator's mesh_status nodes; a held inventory there wins over the member's. */
    statusNodes?: RepoMeshNodeStatus[] | null,
): MeshProviderInventory {
    // Raw (un-normalized) inventories keyed by daemon id. Deliberately NOT
    // buildProvidersByDaemonId: normalizeAvailableCliProviders drops the very fields
    // this surface needs (autoApproveModes, category), so the raw entries are kept
    // while the daemon-id keying stays identical.
    const rawByDaemonId = new Map<string, any[]>()
    for (const d of daemons) {
        if (!d?.id) continue
        rawByDaemonId.set(d.id, Array.isArray((d as any).availableProviders) ? (d as any).availableProviders : [])
    }

    const seenTypes = new Set<string>()
    const providers: any[] = []
    let reportedNodeCount = 0
    let unreportedNodeCount = 0

    for (const node of Array.isArray(nodes) ? nodes : []) {
        const nodeDaemonId = String((node as any)?.daemon_id || (node as any)?.daemonId || '')
        const statusNode = findStatusNodeForNode(node, statusNodes)
        // Coordinator-held inventory first; the member's own only as a fallback.
        // Mirror resolveNodeAvailableProviders' standalone fallback: an unbound node
        // with exactly one connected daemon belongs to that daemon.
        const raw = readCoordinatorHeldProviders(statusNode) ?? (nodeDaemonId
            ? rawByDaemonId.get(nodeDaemonId)
            : (rawByDaemonId.size === 1 ? [...rawByDaemonId.values()][0] : undefined))

        // No inventory yet (daemon offline, or P2P/status metadata still in flight).
        if (!raw || raw.length === 0) {
            unreportedNodeCount++
            continue
        }
        reportedNodeCount++
        for (const p of raw) {
            const type = String(p?.type || p?.id || '').trim()
            if (!type || seenTypes.has(type)) continue
            seenTypes.add(type)
            providers.push(p)
        }
    }

    // Keep the surface stable across re-renders regardless of node iteration order.
    providers.sort((a, b) =>
        String(a?.type || a?.id || '').localeCompare(String(b?.type || b?.id || '')))

    return { providers, reportedNodeCount, unreportedNodeCount }
}

/** The coordinator's mesh_status record for a mesh config node (by node id). */
export function findStatusNodeForNode(
    node: MeshNode | null | undefined,
    statusNodes: RepoMeshNodeStatus[] | null | undefined,
): RepoMeshNodeStatus | undefined {
    const nodeId = String((node as any)?.id || (node as any)?.nodeId || '').trim()
    if (!nodeId || !Array.isArray(statusNodes)) return undefined
    return statusNodes.find(statusNode => statusNode?.nodeId === nodeId)
}

/**
 * Every provider type a node can launch, in the daemon's precedence order:
 * `policy.slots` FIRST, then `policy.providerPriority`, de-duplicated.
 *
 * A direct mirror of the daemon's readNodeProviderTypes (mesh-work-queue.ts), and
 * it must stay one: this list is what `provider=` capability tags are derived from,
 * and the operator's only way to learn which `provider=` values are valid for
 * `required_tags` (NodeTagEditor's RESERVED_PREFIXES forbids typing `provider=` by
 * hand, so the rendered tag list is the sole source).
 *
 * It previously read `providerPriority[0]` alone, which was wrong twice over: it
 * showed only the FIRST provider, and it never consulted `policy.slots` at all — so
 * a provider configured only as a capability slot (the modern surface; `slots` is
 * coordinator-owned and is what routing actually matches) was invisible in the UI
 * forever, even though the daemon tagged and routed to it.
 *
 * Slot normalization goes through mesh-shared's normalizeNodeCapabilitySlots — the
 * same function the daemon uses — rather than a local re-read, so the two cannot
 * drift on what counts as a valid slot.
 */
export function readNodeProviderTypes(policy: unknown): string[] {
    const record = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? policy as Record<string, unknown>
        : {}
    const seen = new Set<string>()
    const out: string[] = []
    const push = (type: unknown) => {
        const trimmed = typeof type === 'string' ? type.trim() : ''
        if (!trimmed || seen.has(trimmed)) return
        seen.add(trimmed)
        out.push(trimmed)
    }
    for (const slot of normalizeNodeCapabilitySlots(record.slots)) push(slot.provider)
    if (Array.isArray(record.providerPriority)) {
        for (const type of record.providerPriority) push(type)
    }
    return out
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
 *
 * `provider=` mirrors the daemon exactly (readNodeProviderTypes: slots first, then
 * providerPriority, de-duplicated), and the final list is de-duplicated the way
 * normalizeMeshCapabilityTags does. The mirroring claim above is therefore accurate
 * for every tag rendered, with ONE deliberate remaining difference: when a node has
 * no override and has never reported, the daemon falls back to the COORDINATOR's own
 * process.platform/arch, whereas this omits `os=`/`arch=` entirely. Rendering the
 * viewer's own OS as if it were the node's would be a false claim about a machine we
 * have no reading for — the same "unknown shown as fact" trap as treating a
 * not-yet-reported provider list as "none".
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

    for (const provider of readNodeProviderTypes(n.policy)) {
        out.push({ tag: `provider=${provider}`, custom: false })
    }

    const worktreeBranch = typeof n.worktreeBranch === 'string' ? n.worktreeBranch.trim() : ''
    if (n.isLocalWorktree === true && worktreeBranch) out.push({ tag: `worktree=${worktreeBranch}`, custom: false })

    // The daemon runs the assembled list through normalizeMeshCapabilityTags, which
    // de-dupes across the WHOLE list — so an operator custom tag spelled exactly like
    // a derived one (e.g. a hand-typed `os=win32`) collapses to a single tag there.
    // De-dupe here too, keeping the first occurrence, or the UI would advertise a tag
    // twice that the matcher only ever sees once.
    const seen = new Set<string>()
    return out.filter(entry => {
        if (seen.has(entry.tag)) return false
        seen.add(entry.tag)
        return true
    })
}
