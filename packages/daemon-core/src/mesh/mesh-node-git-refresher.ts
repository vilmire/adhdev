/**
 * Coordinator side of the coordinator-held node state: ASK members to push.
 *
 * The request path (mesh_status) never awaits a remote read: it answers from
 * the coordinator-held store (mesh-node-git-state.ts). Members keep that store
 * fresh themselves — mesh-node-state-pusher.ts pushes on change plus a
 * heartbeat — so the coordinator never reads a member's git or runtime. The
 * only thing it ever sends a member is `mesh_node_state_nudge` ("push now"),
 * and only on three occasions:
 *   - an explicit refresh (the dashboard's / a tool's refresh=true) of a node
 *     whose held state is older than the refresh threshold (`nudge`);
 *   - a member daemon's link (re)opens, or this coordinator restarts / upgrades
 *     it (`handshakeDaemon`) — its held entries are suspect until it reports;
 *   - first contact: a node this coordinator holds nothing for (just added, or
 *     a fresh coordinator) (`firstContact`).
 * A nudge for a node the member is not yet pushing REGISTERS the subscription
 * on the member (the nudge carries the node's workspace), so the nudge is also
 * the handshake — there is no separate probe, no legacy cadence and no
 * background runtime read (the audit 2026-09-29 P1-2 pull fallbacks).
 *
 * Bounded: one nudge in flight per node, a per-node minimum interval, and a
 * failure backoff for first contact. An unreachable member is recorded as
 * such (the transition into unreachable settles a revision); the member's next
 * push clears it.
 */
import { readMeshTimeoutEnvMs } from '../runtime-defaults.js';
import { MeshNodeGitStateStore, type MeshNodeGitStateEntry } from './mesh-node-git-state.js';
import { MESH_NODE_STATE_PUSH_HEARTBEAT_MS } from './mesh-node-state-pusher.js';

/**
 * A member-pushed observation older than this means the member stopped
 * pushing (its link is down / its subscription lapsed): held state is still
 * served, but no longer reported as live. Twice the push heartbeat, so a quiet
 * subscribed member never crosses it.
 */
export const MESH_NODE_STATE_STALE_MS = readMeshTimeoutEnvMs('MESH_NODE_STATE_STALE_MS', 2 * MESH_NODE_STATE_PUSH_HEARTBEAT_MS);
/** After a failed first-contact nudge, wait this long before the next automatic one. */
export const MESH_NODE_STATE_FAILURE_BACKOFF_MS = readMeshTimeoutEnvMs('MESH_NODE_STATE_FAILURE_BACKOFF_MS', 60_000);
/** A node is never nudged twice within this interval (explicit refresh / handshake storms). */
export const MESH_NODE_STATE_FORCE_MIN_INTERVAL_MS = 5_000;
/** Command a coordinator sends a member to make it push (and, if needed, subscribe) now. */
export const MESH_NODE_STATE_NUDGE_COMMAND = 'mesh_node_state_nudge';

/**
 * Held runtime a reader may trust as live: it was PUSHED by the member and the
 * member is still pushing (observation younger than the stale threshold).
 */
export function isHeldRuntimeLive(
    entry: Pick<MeshNodeGitStateEntry, 'runtime' | 'runtimeSource' | 'runtimeObservedAt'> & Partial<Pick<MeshNodeGitStateEntry, 'handshakePendingSince'>> | null | undefined,
    now: number = Date.now(),
    staleMs: number = MESH_NODE_STATE_STALE_MS,
): boolean {
    if (!entry?.runtime || entry.runtimeSource !== 'member_push' || entry.runtimeObservedAt === null) return false;
    // A handshake is pending (member reconnected / restarted): the held summary may be the replaced process's.
    if (entry.handshakePendingSince != null) return false;
    return now - entry.runtimeObservedAt < staleMs;
}

/**
 * The live held runtime of the node `nodeId` on `meshId`, IF it belongs to
 * `daemonId` (the daemon a reader is about to call) and isHeldRuntimeLive —
 * else null.
 */
export function readLiveHeldRuntime(
    store: MeshNodeGitStateStore | null | undefined,
    args: { meshId: string | null | undefined; nodeId: string | null | undefined; daemonId: string },
    now: number = Date.now(),
): { runtime: NonNullable<MeshNodeGitStateEntry['runtime']>; observedAt: number } | null {
    if (!store || !args.meshId || !args.nodeId || !args.daemonId) return null;
    const entry = store.get(args.meshId, args.nodeId);
    if (!entry || !isHeldRuntimeLive(entry, now) || !entry.runtime || entry.runtimeObservedAt === null) return null;
    if (!MeshNodeGitStateStore.runtimeBelongsToDaemon(entry, args.daemonId)) return null;
    return { runtime: entry.runtime, observedAt: entry.runtimeObservedAt };
}

export interface MeshNodeGitRefreshTarget {
    meshId: string;
    nodeId: string;
    daemonId: string;
    workspace: string;
}

/** A handshake target (`runtimeOnly` = its git is read on this machine; the member still pushes its runtime). */
export interface MeshNodeHandshakeTarget extends MeshNodeGitRefreshTarget {
    runtimeOnly?: boolean;
}

interface MeshNodeGitRefresherOptions {
    store: MeshNodeGitStateStore;
    /**
     * Ask the member to push now (subscribing when it is not yet). Resolves
     * `true` when the member took it (it will push), `false` when it refused
     * (e.g. the workspace is not on that machine). Rejects when unreachable.
     */
    nudge: (target: MeshNodeGitRefreshTarget) => Promise<boolean>;
    /** Called when a nudge outcome changed what a viewer sees (into / out of unreachable). */
    onSettled: (meshId: string) => void;
    now?: () => number;
    failureBackoffMs?: number;
}

export class MeshNodeGitRefresher {
    private readonly inflight = new Map<string, Promise<void>>();
    /** meshId+daemonId → how many of its nodes have a nudge in flight (overlay `refreshing`). */
    private readonly daemonInflight = new Map<string, number>();
    private readonly lastNudgeAt = new Map<string, number>();
    private readonly now: () => number;
    private readonly failureBackoffMs: number;

    constructor(private readonly options: MeshNodeGitRefresherOptions) {
        this.now = options.now ?? Date.now;
        this.failureBackoffMs = options.failureBackoffMs ?? MESH_NODE_STATE_FAILURE_BACKOFF_MS;
    }

    private key(meshId: string, nodeId: string): string {
        return `${meshId}\u0000${nodeId}`;
    }

    /** A nudge for this node is in flight. */
    isRefreshing(meshId: string, nodeId: string): boolean {
        return this.inflight.has(this.key(meshId, nodeId));
    }

    /** A nudge for any node of this daemon is in flight (runtime is daemon-wide). */
    isRuntimeRefreshing(meshId: string, daemonId: string): boolean {
        return (this.daemonInflight.get(this.key(meshId, daemonId)) ?? 0) > 0;
    }

    private valid(target: MeshNodeGitRefreshTarget): boolean {
        return !!(target.meshId && target.nodeId && target.daemonId && target.workspace);
    }

    /**
     * Send one nudge now (no eligibility checks beyond the in-flight slot).
     * Fire-and-forget; returns whether a nudge was started.
     */
    private send(target: MeshNodeGitRefreshTarget): boolean {
        const key = this.key(target.meshId, target.nodeId);
        if (this.inflight.has(key)) return false;
        const now = this.now();
        this.lastNudgeAt.set(key, now);
        const { store } = this.options;
        store.recordProbeAttempt(target.meshId, target.nodeId, target.workspace, now);
        const daemonKey = this.key(target.meshId, target.daemonId);
        this.daemonInflight.set(daemonKey, (this.daemonInflight.get(daemonKey) ?? 0) + 1);
        const run = (async (): Promise<boolean> => {
            let failure: string | null = null;
            try {
                if (!(await this.options.nudge(target))) failure = 'member_refused_push';
            } catch (error: any) {
                failure = error?.message ? String(error.message) : 'nudge_failed';
            }
            if (failure === null) return false; // the member's push settles what changed
            // Only the transition INTO unreachable is a visible change.
            return store.recordProbeFailure(target.meshId, target.nodeId, target.workspace, failure, this.now()).changed;
        })()
            .catch(() => false)
            .then((changed) => {
                if (this.inflight.get(key) === run) this.inflight.delete(key);
                const left = (this.daemonInflight.get(daemonKey) ?? 1) - 1;
                if (left > 0) this.daemonInflight.set(daemonKey, left);
                else this.daemonInflight.delete(daemonKey);
                if (changed) {
                    try { this.options.onSettled(target.meshId); } catch { /* best-effort */ }
                }
            });
        this.inflight.set(key, run);
        return true;
    }

    private recentlyNudged(target: MeshNodeGitRefreshTarget): boolean {
        const last = this.lastNudgeAt.get(this.key(target.meshId, target.nodeId));
        return last !== undefined && this.now() - last < MESH_NODE_STATE_FORCE_MIN_INTERVAL_MS;
    }

    /** Explicit refresh: ask the member to push now. Returns whether a nudge was sent. */
    nudge(target: MeshNodeGitRefreshTarget): boolean {
        if (!this.valid(target) || this.recentlyNudged(target)) return false;
        return this.send(target);
    }

    /**
     * First contact: this coordinator holds nothing observed for the node (just
     * added / fresh coordinator) — ask the member to subscribe and push. Honors
     * the failure backoff so an unreachable member is not asked on every read.
     */
    firstContact(target: MeshNodeGitRefreshTarget): boolean {
        if (!this.valid(target) || this.recentlyNudged(target)) return false;
        const entry = this.options.store.get(target.meshId, target.nodeId);
        if (entry && (entry.observedAt !== null || entry.runtimeObservedAt !== null)) return false;
        if (entry?.lastFailureAt != null && this.now() - entry.lastFailureAt < this.failureBackoffMs) return false;
        return this.send(target);
    }

    /**
     * The member daemon `daemonId` (re)connected, or was restarted by this
     * coordinator: nudge every node of it on `meshId` NOW (the per-node minimum
     * interval still applies, so a flapping link cannot storm the member).
     * Returns how many nudges were started.
     */
    handshakeDaemon(meshId: string, daemonId: string, targets: MeshNodeHandshakeTarget[]): number {
        if (!meshId || !daemonId) return 0;
        let started = 0;
        for (const target of targets) {
            if (target.meshId !== meshId || !this.valid(target) || this.recentlyNudged(target)) continue;
            if (this.send(target)) started += 1;
        }
        return started;
    }

    /** Resolves once every nudge in flight has settled (tests / shutdown). */
    async whenIdle(): Promise<void> {
        while (this.inflight.size > 0) {
            await Promise.allSettled([...this.inflight.values()]);
        }
    }
}
