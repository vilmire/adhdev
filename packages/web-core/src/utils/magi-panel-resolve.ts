/**
 * MAGI panel resolvability — client-side, pure.
 *
 * MAGI panel definitions (`~/.adhdev/meshes.json` `magiPanels`) are machine-local
 * config returned RAW by the daemon `magi_panel_list` command — the daemon does
 * NOT compute resolvability, because the fan-out planner (`buildMagiFanoutPlan`)
 * lives in mcp-server and is unreachable from daemon-core. So the dashboard
 * derives each member's resolvability HERE, against the same live `mesh_status`
 * node list the graph already loads, and reuses the SAME independence/coupling
 * rule the live MAGI activity surface uses (magi-activity.ts: a quorum is
 * `coupled` when it collapses to <2 distinct providers OR <2 distinct nodes).
 *
 * Pure — no transport, no React. Unit-tested in test/utils/magi-panel-resolve.test.ts.
 */
import type { MagiPanel, MagiPanelMember } from '@adhdev/mesh-shared'

/** Minimal live-node shape this resolver needs (subset of RepoMeshNodeStatus). */
export interface MagiResolveNode {
    nodeId: string
    /** Installed/reported providers; falls back to providerPriority when empty. */
    providers?: string[]
    providerPriority?: string[]
}

export type MagiMemberAvailability =
    /** A pinned node exists and offers the member's provider, or a tag-routed
     *  member has ≥1 node offering its provider. */
    | 'available'
    /** Pinned nodeId is not in the live mesh. */
    | 'node_missing'
    /** Node/mesh resolves but no node offers the required provider. */
    | 'provider_unavailable'
    /** No live mesh nodes reported yet — resolvability is unknown, not a failure. */
    | 'unknown'

export interface MagiMemberResolution {
    member: MagiPanelMember
    availability: MagiMemberAvailability
    /** Replicas this member contributes (member.n ?? panel.defaultN ?? 1). */
    replicas: number
    /** Live nodes (by id) that satisfy this member — for the badge tooltip. */
    matchingNodeIds: string[]
}

export interface MagiPanelResolution {
    members: MagiMemberResolution[]
    /** Sum of replicas across members. */
    totalReplicas: number
    /** Distinct providers across members (the panel's provider diversity). */
    distinctProviders: number
    /** Distinct *resolvable* nodes the panel would dispatch to. */
    distinctNodes: number
    /**
     * True when the panel collapses to a single provider OR a single machine —
     * agreements would be flagged source-coupled by MAGI synthesis. Same rule as
     * magi-activity.ts MagiGroupActivity.coupled. False once ≥2 providers AND ≥2
     * nodes are spanned. When the live mesh is empty this is reported against the
     * raw definition (declared providers / pinned nodeIds) so the editor still
     * gives the operator an independence signal before a coordinator is live.
     */
    coupled: boolean
    /** True when at least one member is not currently resolvable. */
    hasUnresolvable: boolean
    /** True when there are zero live nodes to resolve against. */
    meshEmpty: boolean
}

function nodeProviders(node: MagiResolveNode): string[] {
    const installed = Array.isArray(node.providers) ? node.providers.filter(Boolean) : []
    if (installed.length > 0) return installed
    // Providers not yet reported (e.g. pre-handshake) — fall back to the declared
    // priority list so a freshly-added node isn't spuriously flagged unavailable.
    return Array.isArray(node.providerPriority) ? node.providerPriority.filter(Boolean) : []
}

function memberReplicas(member: MagiPanelMember, panel: MagiPanel): number {
    const n = typeof member.n === 'number' && Number.isFinite(member.n) && member.n >= 1 ? Math.floor(member.n) : undefined
    if (n !== undefined) return n
    const dn = typeof panel.defaultN === 'number' && Number.isFinite(panel.defaultN) && panel.defaultN >= 1 ? Math.floor(panel.defaultN) : undefined
    return dn ?? 1
}

/**
 * Resolve every member of a panel against the live mesh node list and assess the
 * panel's overall independence (coupling). Pass an empty `nodes` array when no
 * live mesh_status is available — members then resolve to `unknown` and coupling
 * is computed from the raw definition.
 */
export function resolveMagiPanel(panel: MagiPanel, nodes: MagiResolveNode[]): MagiPanelResolution {
    const meshEmpty = nodes.length === 0
    const nodeById = new Map(nodes.map(n => [n.nodeId, n]))

    const members: MagiMemberResolution[] = (panel.members ?? []).map(member => {
        const provider = member.provider
        const replicas = memberReplicas(member, panel)

        if (meshEmpty) {
            return { member, availability: 'unknown', replicas, matchingNodeIds: [] }
        }

        if (member.nodeId) {
            const node = nodeById.get(member.nodeId)
            if (!node) return { member, availability: 'node_missing', replicas, matchingNodeIds: [] }
            const offers = nodeProviders(node).includes(provider)
            return {
                member,
                availability: offers ? 'available' : 'provider_unavailable',
                replicas,
                matchingNodeIds: offers ? [node.nodeId] : [],
            }
        }

        // Tag-routed member: any live node offering the provider resolves it.
        // (capabilityTags narrow further, but tags are machine-local facts the
        // dashboard cannot see in mesh_status, so provider availability is the
        // resolvable signal here — the coordinator applies tags at dispatch.)
        const matching = nodes.filter(n => nodeProviders(n).includes(provider)).map(n => n.nodeId)
        return {
            member,
            availability: matching.length > 0 ? 'available' : 'provider_unavailable',
            replicas,
            matchingNodeIds: matching,
        }
    })

    const totalReplicas = members.reduce((sum, m) => sum + m.replicas, 0)

    // Provider diversity is always read from the declaration (every member has a
    // required provider). Node diversity prefers resolved nodes; when the mesh is
    // empty it falls back to the pinned nodeIds in the definition so the editor
    // still surfaces an independence hint before a coordinator is live.
    const distinctProviders = new Set(members.map(m => m.member.provider)).size
    const resolvedNodeIds = new Set<string>()
    for (const m of members) for (const id of m.matchingNodeIds) resolvedNodeIds.add(id)
    const declaredNodeIds = new Set(
        members.map(m => m.member.nodeId).filter((id): id is string => !!id),
    )
    const distinctNodes = meshEmpty ? declaredNodeIds.size : resolvedNodeIds.size

    return {
        members,
        totalReplicas,
        distinctProviders,
        distinctNodes,
        coupled: distinctProviders < 2 || distinctNodes < 2,
        hasUnresolvable: members.some(m => m.availability === 'node_missing' || m.availability === 'provider_unavailable'),
        meshEmpty,
    }
}
