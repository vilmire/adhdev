/**
 * Canonical workspace-path normalizer for mesh node/session scope comparison,
 * shared by daemon-core (standalone / local IPC) and any other core that has to
 * tell a base node apart from a co-located worktree clone whose ONLY structural
 * difference is its distinct workspace root.
 *
 * One physical daemon can host a base node plus several worktree nodes. Session
 * records, queue claims, and read_chat requests are scoped to a node by matching
 * the session's actual workspace against the node's declared workspace. Those two
 * paths can arrive in different but equivalent spellings (back/forward slashes,
 * trailing separators, Windows case-insensitivity), so a raw string compare would
 * either falsely separate equal paths or fail to engage at all.
 *
 * This folds separator style, trailing slashes, and case into a single comparable
 * form. It was previously a module-private copy in daemon-core's
 * mesh-events-coordinator.ts (WTCLAIM fix-B); promoting it here keeps the one
 * comparison rule identical across the enqueue→claim path, the mesh_status
 * per-node session filter, and the read_chat node scope guard. Pure string ops —
 * no Node/DOM APIs — so it stays a valid mesh-shared leaf.
 */
export function normalizeMeshWorkspaceForCompare(dir?: string | null): string {
    if (typeof dir !== 'string') return ''
    return dir.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Whether two workspace paths refer to the same workspace root after
 * normalization. Returns false when either side is empty — an unknown workspace
 * never "matches" another, so callers must decide separately whether an unknown
 * workspace should be treated permissively (the WTCLAIM convention: unknown →
 * do not block).
 */
export function meshWorkspacesEquivalent(a?: string | null, b?: string | null): boolean {
    const left = normalizeMeshWorkspaceForCompare(a)
    const right = normalizeMeshWorkspaceForCompare(b)
    if (!left || !right) return false
    return left === right
}
