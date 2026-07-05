/**
 * Remote mesh-session owner resolution — extracted from router.ts (behavior-preserving code move).
 *
 * These functions were `DaemonCommandRouter` methods; they now take the router
 * instance as `self`. resolveRemoteMeshSessionOwnerDaemonId stays reachable as a
 * public method (the [Z] session-scoped forward in executeDaemonCommand and the
 * mesh-session-scoped-remote-forward test call it), so the class keeps a thin
 * delegating wrapper. No log string, error message, refusal condition, or result
 * shape changed — only physical location + `this.` → `self.`.
 *
 * The group is read-only: it reads self.deps.statusInstanceId, the cached inline-mesh
 * nodes, and the aggregate-status snapshot nodes. It never mutates router state.
 */
import type { DaemonCommandRouter } from './router.js';
import { meshNodeIdMatches, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import {
    collectMeshNodeHostedSessionIds,
    readMeshNodeDaemonId,
    readObjectRecord,
} from '../mesh/mesh-node-identity.js';

/**
 * Resolve the REMOTE worker daemonId that owns a given session, when the session
 * belongs to a mesh node hosted on a DIFFERENT daemon than this coordinator.
 *
 * The coordinator does not host remote-worker session instances in its own
 * instanceManager/sessionRegistry — only their cached mesh-node metadata. A
 * dashboard-issued session-scoped command (invoke_provider_script / resolve_action /
 * set_mode / …) lands on the coordinator with a targetSessionId the coordinator can't
 * find locally, and without forwarding it dies as "Live session not found". send_chat
 * happens to survive (its target resolves to the worker by another route), but the
 * controlbar commands do not — so the controlbar buttons appear to do nothing.
 *
 * Mirror the existing node-level remote-forward pattern (fast_forward_mesh_node etc.):
 * scan the candidate mesh nodes for the one hosting the targetSessionId, and return its
 * daemonId when that daemonId is a remote daemon (i.e. not this coordinator's own
 * statusInstanceId). Returns undefined for a locally-hosted session (no forward — execute
 * locally as before) or when ownership can't be resolved.
 *
 * The candidate set spans BOTH the cached inline-mesh nodes and the live aggregate
 * mesh-status snapshots. The inline cache reliably carries only each node's single primary
 * session (cachedStatus.activeSession), so a worker hosting more than one session exposes its
 * non-primary sessions only on the aggregate snapshot nodes (status.activeSessions /
 * activeSessionDetails, built from live session records). collectMeshNodeHostedSessionIds does
 * the wider plural-shape scan so a controlbar/modal command targeting a non-primary remote
 * session still resolves its owner — the singular readCachedInlineMeshActiveSessions semantics
 * other consumers depend on stay untouched.
 *
 * CANCEL-STOP-RELAY: the session-id cache scan above only matches when the coordinator's
 * cached status snapshot already lists the worker's session id in a recognized active-sessions
 * shape. A worktree-clone worker session whose id form/timing differs from the cached snapshot
 * (or is simply not yet reflected) misses the scan, so a stop that carries the authoritative
 * owning nodeId (mesh_queue_cancel knows assignedNodeId) used to silently fail to forward.
 * `ownerNodeIdHint` adds a deterministic fallback: when the session-id scan misses, resolve the
 * owner daemonId by matching the node by id (meshNodeIdMatches — same form-tolerant compare the
 * rest of the router uses, no new raw compare). The same self-loopback guard applies to both
 * paths, so a coordinator-hosted node is still never force-forwarded to a remote form of itself.
 */
export function resolveRemoteMeshSessionOwnerDaemonId(
    self: DaemonCommandRouter,
    sessionId: string,
    ownerNodeIdHint?: string,
): string | undefined {
        const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
        const nodeHint = typeof ownerNodeIdHint === 'string' ? ownerNodeIdHint.trim() : '';
        if (!trimmed && !nodeHint) return undefined;
        const selfDaemonId = self.deps.statusInstanceId;
        const candidates = collectMeshSessionOwnerCandidateNodes(self);
        if (trimmed) {
            for (const node of candidates) {
                if (!collectMeshNodeHostedSessionIds(node).has(trimmed)) continue;
                const nodeDaemonId = readMeshNodeDaemonId(readObjectRecord(node));
                // A matching node with no readable daemonId can't be attributed — keep scanning
                // the remaining candidates (e.g. the same session on an aggregate node that does
                // carry the daemonId) rather than bailing on the whole resolution.
                if (!nodeDaemonId) continue;
                // Only forward to a genuinely remote daemon. When the owning node is this
                // coordinator itself (locally hosted worker), fall through to local handling.
                // id-form robust: the node daemonId and selfDaemonId may be stored in different
                // forms of the same machine — a strict `===` would miss the self-match and forward
                // a local session to a remote form of THIS daemon (loopback).
                if (selfDaemonId && daemonIdsEquivalent(nodeDaemonId, selfDaemonId)) return undefined;
                return nodeDaemonId;
            }
        }
        // Deterministic fallback: the session-id scan missed (cache lag / id-form mismatch on a
        // worktree-clone worker), but the caller knows the authoritative owning nodeId. Resolve the
        // owner daemonId straight off that node — never the fuzzy session cache.
        if (nodeHint) {
            for (const node of candidates) {
                if (!meshNodeIdMatches(node, nodeHint)) continue;
                const nodeDaemonId = readMeshNodeDaemonId(readObjectRecord(node));
                if (!nodeDaemonId) continue;
                if (selfDaemonId && daemonIdsEquivalent(nodeDaemonId, selfDaemonId)) return undefined;
                return nodeDaemonId;
            }
        }
        return undefined;
}

/**
 * Candidate nodes for remote-session owner resolution: the cached inline-mesh nodes (which
 * carry each node's primary session) plus the nodes from every cached aggregate mesh-status
 * snapshot (which carry each node's full live session list). getCachedInlineMeshNodes()
 * returns a fresh array, so appending the aggregate nodes never mutates cached state.
 */
export function collectMeshSessionOwnerCandidateNodes(self: DaemonCommandRouter): any[] {
        const nodes: any[] = self.getCachedInlineMeshNodes();
        for (const cached of self.aggregateMeshStatusCache.values()) {
            const snapshotNodes = cached?.snapshot?.nodes;
            if (Array.isArray(snapshotNodes)) nodes.push(...snapshotNodes);
        }
        return nodes;
}
