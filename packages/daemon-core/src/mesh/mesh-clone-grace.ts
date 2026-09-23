import { normalizeMeshNodeId, type MeshNodeIdentified } from '@adhdev/mesh-shared';
import { readLocalRecordsByKind } from './mesh-local-records.js';
import { meshTopicIndexFor } from './mesh-topic-index.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';

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

// M-MESH-INFRA-0829 defect 5-b [B]: the in-memory registry above is a bare per-process Map —
// no persistence, populated only once at clone-forward time (noteRecentlyClonedNode). A
// coordinator daemon restart within the grace window (a redeploy, a crash-restart — routine
// in this repo's fast-iterating preview/deploy cycle, see the deploy-restart-verify workflow)
// loses that evidence entirely, and a bootstrap that simply outlives CLONE_BOOTSTRAP_GRACE_MS
// has the same effect. Either way a still-transient clone silently downgrades to the
// PERMANENT, coordinator-paging `target_node_id_unmatched` reason even though the node is (or
// will shortly be) resolvable — observed as the notification recurring even after the node is
// visible again and a mesh_status refresh changes nothing (refreshing mesh_status does not
// repopulate this registry; only a fresh clone does).
//
// The durable 'node_cloned' record (meshRecord by clone_mesh_node — mesh-crud.ts) survives
// a restart, so it is the fallback source of truth: this daemon's local records plus the
// fleet index (a clone recorded by another coordinator daemon; ids + time only). Consulted ONLY when the fast
// in-memory check misses, so the hot path (every autolaunch tick, every candidate node) stays
// allocation/IO-free in the overwhelmingly common case; the ledger read is paid only on the
// rare miss this fix exists to cover.
const CLONE_LEDGER_LOOKBACK_CAP = 200;

/**
 * How far a foreign ledger stamp may sit AHEAD of our clock before it is read as
 * clock-untrustworthy rather than merely fresh. Local copy of the ±2s tolerance
 * used by mesh-autolaunch-integrity / mesh-completion-live-gate — kept as a
 * constant here so this leaf module gains no import edge.
 */
const CLONE_LEDGER_FUTURE_SKEW_TOLERANCE_MS = 2_000;

/** Durable-fallback counterpart of {@link isWithinCloneBootstrapGrace} — see the block comment
 *  above. Falls back to a mesh's ledger `node_cloned` entries when the in-memory registry has
 *  no (or an expired) entry for this node id, so a restart or a slow-but-live clone is not
 *  misclassified as a permanent routing miss. Fails closed (no grace) on any ledger error, same
 *  conservative default as the in-memory check. */
export function isWithinCloneBootstrapGraceDurable(
    meshId: string | undefined | null,
    nodeId: string | undefined | null,
    nowMs: number = Date.now(),
): boolean {
    if (isWithinCloneBootstrapGrace(nodeId, nowMs)) return true;
    const key = normalizeNodeIdKey(nodeId);
    if (!key || !meshId) return false;
    try {
        const local = readLocalRecordsByKind(meshId, ['node_cloned'], CLONE_LEDGER_LOOKBACK_CAP);
        let fleet: Array<{ nodeId?: string; timestamp: string }> = [];
        try {
            fleet = meshTopicIndexFor(MeshRuntimeStore.getInstance().db)
                .query(meshId, { writer: { scope: 'fleet' }, kinds: ['node_cloned'], tail: CLONE_LEDGER_LOOKBACK_CAP });
        } catch { /* no index on this handle — local records only */ }
        for (const entry of [...local, ...fleet]) {
            if (normalizeNodeIdKey(entry.nodeId) !== key) continue;
            // CLOCK-LOWER-BOUND (2026-09-21): the ledger `timestamp` is FOREIGN (stamped by
            // whichever node appended the `node_cloned` entry), so skew / an NTP step can put
            // it in our future. This grants a GRACE exemption (`age <= window` → the node is
            // "still bootstrapping"), so a negative age would be unconditionally true and the
            // permanent `target_node_id_unmatched` routing miss would be suppressed FOREVER —
            // the node would look eternally transient and never be reported. Reject the
            // untrustworthy stamp instead of clamping it: `Math.max(0, age)` would read a
            // future stamp as "cloned this instant", the strongest possible pass of this gate.
            // Fails closed (no grace), the same conservative default as the rest of this fn.
            const clonedAtMs = Date.parse(entry.timestamp);
            if (!Number.isFinite(clonedAtMs)) continue;
            const ageMs = nowMs - clonedAtMs;
            if (ageMs < -CLONE_LEDGER_FUTURE_SKEW_TOLERANCE_MS) continue;
            if (ageMs <= CLONE_BOOTSTRAP_GRACE_MS) return true;
        }
    } catch {
        // Ledger unavailable — fail closed (no durable evidence).
    }
    return false;
}

export function __resetCloneBootstrapGraceForTests(): void {
    recentlyClonedNodeExpiry.clear();
}
