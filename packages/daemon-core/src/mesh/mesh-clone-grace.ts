import { normalizeMeshNodeId, type MeshNodeIdentified } from '@adhdev/mesh-shared';

// ---------------------------------------------------------------------------
// Recently-cloned worktree node grace window
// ---------------------------------------------------------------------------
// FALSE-BLOCKER-CLONE-QUEUE: right after mesh_clone_node registers a worktree node, a
// queue task pinned to that node id (target_node pin) can transiently find NO matching
// node in the coordinator-owning daemon's mesh view, because:
//   - the clone wrote the node ONLY into the inline mesh cache (med-family clone branch),
//     and that inline entry has not yet PROPAGATED to the coordinator daemon (the clone
//     may have run on the source node's machine and forwarded), and/or
//   - the node's worktree bootstrap (npm install / native-addon repair) is still running,
//     so the claim gate defers anyway.
// In BOTH cases the unmatch SELF-RESOLVES within ~seconds (observed bootstrap ~2m8s) — it
// is NOT the permanent `target_node_id_unmatched` routing miss (a removed/dead node) that
// the actionable-blocker coordinator notification exists for. This registry lets the skip
// classifier tell the transient case apart from the permanent one: a node id recorded here
// (within the grace TTL) is a freshly cloned worktree whose unmatch should be reported as a
// transient, NON-actionable skip rather than paging the coordinator with a false
// "will NOT clear on its own" blocker.
//
// The window is floored well above the observed clone + bootstrap + inline-cache
// propagation latency so a slow-but-live clone is never misclassified as a permanent
// unmatch. A genuinely dead/removed node is never recorded here (or its entry has long
// expired), so its `target_node_id_unmatched` stays correctly actionable.
export const CLONE_BOOTSTRAP_GRACE_MS = 10 * 60 * 1000;

const recentlyClonedNodeExpiry = new Map<string, number>(); // normalized nodeId -> expiry epoch ms
const MAX_TRACKED_CLONED_NODES = 512;

function normalizeNodeIdKey(nodeId: string | undefined | null): string {
    return normalizeMeshNodeId({ id: nodeId ?? undefined } as MeshNodeIdentified) ?? '';
}

/** Record that a worktree node id was just cloned, opening its transient grace window. */
export function noteRecentlyClonedNode(nodeId: string | undefined | null, nowMs: number = Date.now()): void {
    const key = normalizeNodeIdKey(nodeId);
    if (!key) return;
    recentlyClonedNodeExpiry.set(key, nowMs + CLONE_BOOTSTRAP_GRACE_MS);
    if (recentlyClonedNodeExpiry.size > MAX_TRACKED_CLONED_NODES) {
        // Map iteration is insertion-ordered; the first key is the oldest-inserted entry.
        const oldest = recentlyClonedNodeExpiry.keys().next().value;
        if (oldest !== undefined) recentlyClonedNodeExpiry.delete(oldest);
    }
}

/** True when nodeId was cloned within the grace window (and the entry has not expired). */
export function isWithinCloneBootstrapGrace(nodeId: string | undefined | null, nowMs: number = Date.now()): boolean {
    const key = normalizeNodeIdKey(nodeId);
    if (!key) return false;
    const expiry = recentlyClonedNodeExpiry.get(key);
    if (expiry === undefined) return false;
    if (nowMs >= expiry) {
        recentlyClonedNodeExpiry.delete(key);
        return false;
    }
    return true;
}

/** Drop a node's grace entry (e.g. once it has fully resolved into the mesh view). */
export function clearCloneBootstrapGrace(nodeId: string | undefined | null): void {
    const key = normalizeNodeIdKey(nodeId);
    if (key) recentlyClonedNodeExpiry.delete(key);
}

export function __resetCloneBootstrapGraceForTests(): void {
    recentlyClonedNodeExpiry.clear();
}
