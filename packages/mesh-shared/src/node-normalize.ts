/**
 * Canonical mesh-node identity normalizer shared by daemon-core (standalone /
 * local IPC) and web-core (cloud / P2P transit) — the node-id counterpart of
 * session-normalize.ts.
 *
 * A mesh node record can carry its stable identifier under THREE different field
 * names depending on the serialization path it travelled, all with the same
 * value:
 *  - `id`      — config canonical form (mesh registry / persisted config)
 *  - `nodeId`  — runtime/wire camelCase form (inline-cache de-serialization,
 *                mesh_status output via readStringValue(node.nodeId, node.id))
 *  - `node_id` — SQLite DB column form leaked onto the object
 *
 * Comparing only `node.id` (or a 2-way `id ?? nodeId` that omits `node_id`)
 * against a target id silently drops nodes that arrived in another form — e.g. an
 * inline-cached worktree node, leaving a target-routed task permanently pending
 * with a misleading `no_node_satisfies_required_tags` skip. This module is the
 * single 3-way source of truth so every comparison site absorbs all three forms.
 */

import { readString } from './json'
import type { MeshNodeIdentified } from './types'

/**
 * Read a mesh node's stable identifier, absorbing any of the three
 * serialization forms (`id` / `nodeId` / `node_id`). Returns undefined when the
 * record carries no usable id in any form.
 */
export function normalizeMeshNodeId(node: MeshNodeIdentified | null | undefined): string | undefined {
    const record = (node && typeof node === 'object' ? node : {}) as MeshNodeIdentified
    return readString(record.id, record.nodeId, record.node_id)
}

/**
 * Whether a mesh node record matches the given candidate id, comparing the
 * node's normalized id (any form) against the candidate. False when either side
 * is empty — never matches an absent id against an absent candidate.
 */
export function meshNodeIdMatches(
    node: MeshNodeIdentified | null | undefined,
    candidateId: string | null | undefined,
): boolean {
    if (!candidateId) return false
    const trimmed = candidateId.trim()
    if (!trimmed) return false
    return normalizeMeshNodeId(node) === trimmed
}
