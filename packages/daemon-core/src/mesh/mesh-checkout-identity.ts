import { meshNodeIdMatches } from '@adhdev/mesh-shared';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';

/**
 * Which physical checkout a write task runs in. Ownership conflicts (owned_paths overlap, a writer
 * with no attested scope) only exist between tasks that share ONE checkout: two different worktree
 * nodes, light workspaces or member clones cannot overwrite each other's files, and a content overlap
 * between their branches is a merge-time concern (Refinery patch-equivalence / trivial-ff gates).
 * Do NOT widen the owned_paths fence back to the whole mesh — owner direction 2026-11-08 ("unnecessary
 * safety guards are dropping parallelism"; live a9497cce held by f7e7cb04 in another worktree node).
 */
export interface CheckoutRef { light?: string; nodeId?: string }

type CheckoutSource = Pick<MeshWorkQueueEntry, 'id' | 'light' | 'lightWorkspaceId' | 'assignedNodeId' | 'targetNodeId' | 'autoLaunch'>;

/** The checkout an in-flight writer occupies (assigned node, or the node a launch reservation targets). */
export function checkoutOfWriter(entry: Partial<CheckoutSource>): CheckoutRef | undefined {
    // A light task runs in its own private scratch worktree.
    if (entry.light) return { light: entry.lightWorkspaceId ?? entry.id ?? 'light' };
    const nodeId = entry.assignedNodeId || entry.autoLaunch?.nodeId;
    return nodeId ? { nodeId } : undefined;
}

/** The checkout a candidate will run in; `nodeId` is the claiming/launching node when known. Undefined = not chosen yet. */
export function checkoutOfCandidate(entry: Partial<CheckoutSource>, nodeId?: string): CheckoutRef | undefined {
    if (entry.light) return { light: entry.lightWorkspaceId ?? entry.id ?? 'light' };
    const node = nodeId || entry.assignedNodeId || entry.targetNodeId;
    return node ? { nodeId: node } : undefined;
}

/**
 * Whether a candidate and an in-flight writer share a checkout.
 * An in-flight writer whose checkout cannot be identified (corrupt/legacy row) is treated as sharing it (fail closed).
 * A candidate with no node chosen yet (pre-spawn, untargeted) shares nothing: the claim re-checks with the real node.
 */
export function sharesCheckout(candidate: CheckoutRef | undefined, other: CheckoutRef | undefined): boolean {
    if (!other) return true;
    if (!candidate) return false;
    if (candidate.light || other.light) return !!candidate.light && candidate.light === other.light;
    return !!candidate.nodeId && !!other.nodeId && meshNodeIdMatches({ id: other.nodeId }, candidate.nodeId);
}
