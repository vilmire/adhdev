/**
 * Coordinator background freshness for remote mesh nodes' git state.
 *
 * The request path (mesh_status) never awaits a remote probe: it answers from
 * the coordinator-held store (mesh-node-git-state.ts) and, when a node's
 * observation is missing or older than the stale threshold (or the caller asked
 * for a refresh), KICKS a background probe here. Member pushes normally keep the
 * store fresh, so this only fires for nodes that have not pushed (older daemon,
 * member restarted before re-subscribing, node just added).
 *
 * Bounded: one probe in flight per node, a failed probe backs off before the
 * next attempt, and an explicit refresh cannot re-kick a node probed a few
 * seconds ago. Completion (success or failure) records into the store and calls
 * `onSettled(meshId)` — the router invalidates the aggregate snapshot and emits
 * the mesh-state revision the dashboard already listens to, so the view updates
 * in place without polling.
 */
import { LOG } from '../logging/logger.js';
import { readMeshTimeoutEnvMs } from '../runtime-defaults.js';
import type { MeshNodeGitStateStore } from './mesh-node-git-state.js';

/** A node's observation older than this makes the coordinator probe it in the background. */
export const MESH_NODE_STATE_STALE_MS = readMeshTimeoutEnvMs('MESH_NODE_STATE_STALE_MS', 180_000);
/** After a failed probe, wait this long before the next automatic attempt. */
export const MESH_NODE_STATE_FAILURE_BACKOFF_MS = readMeshTimeoutEnvMs('MESH_NODE_STATE_FAILURE_BACKOFF_MS', 60_000);
/** An explicit refresh never re-probes a node attempted more recently than this. */
export const MESH_NODE_STATE_FORCE_MIN_INTERVAL_MS = 5_000;

export interface MeshNodeGitRefreshTarget {
    meshId: string;
    nodeId: string;
    daemonId: string;
    workspace: string;
}

export interface MeshNodeGitRefresherOptions {
    store: MeshNodeGitStateStore;
    /** Run the actual remote probe. Resolves the git status, or null when the node could not answer. */
    probe: (target: MeshNodeGitRefreshTarget) => Promise<Record<string, unknown> | null>;
    /** Called after a probe settles (success or failure) — invalidate + publish a mesh-state revision. */
    onSettled: (meshId: string) => void;
    /** Called with a successful probe's raw result (platform / facts self-heal). */
    onObserved?: (target: MeshNodeGitRefreshTarget, git: Record<string, unknown>) => void;
    now?: () => number;
    staleMs?: number;
    failureBackoffMs?: number;
}

export class MeshNodeGitRefresher {
    private readonly inflight = new Map<string, Promise<void>>();
    private readonly now: () => number;
    private readonly staleMs: number;
    private readonly failureBackoffMs: number;

    constructor(private readonly options: MeshNodeGitRefresherOptions) {
        this.now = options.now ?? Date.now;
        this.staleMs = options.staleMs ?? MESH_NODE_STATE_STALE_MS;
        this.failureBackoffMs = options.failureBackoffMs ?? MESH_NODE_STATE_FAILURE_BACKOFF_MS;
    }

    private key(meshId: string, nodeId: string): string {
        return `${meshId}\u0000${nodeId}`;
    }

    isRefreshing(meshId: string, nodeId: string): boolean {
        return this.inflight.has(this.key(meshId, nodeId));
    }

    /** Whether a kick for this node would start a probe right now. */
    shouldRefresh(meshId: string, nodeId: string, opts?: { force?: boolean }): boolean {
        if (this.isRefreshing(meshId, nodeId)) return false;
        const entry = this.options.store.get(meshId, nodeId);
        const now = this.now();
        if (entry?.lastAttemptAt !== null && entry?.lastAttemptAt !== undefined
            && now - entry.lastAttemptAt < MESH_NODE_STATE_FORCE_MIN_INTERVAL_MS) {
            return false;
        }
        if (opts?.force) return true;
        if (entry?.lastFailureAt !== null && entry?.lastFailureAt !== undefined
            && now - entry.lastFailureAt < this.failureBackoffMs) {
            return false;
        }
        if (!entry || entry.observedAt === null) return true;
        return now - entry.observedAt >= this.staleMs;
    }

    /**
     * Start a background probe when warranted. Never awaited by the request
     * path; returns whether a probe was started.
     */
    kick(target: MeshNodeGitRefreshTarget, opts?: { force?: boolean }): boolean {
        if (!target.meshId || !target.nodeId || !target.daemonId || !target.workspace) return false;
        if (!this.shouldRefresh(target.meshId, target.nodeId, opts)) return false;
        const key = this.key(target.meshId, target.nodeId);
        const { store } = this.options;
        store.recordProbeAttempt(target.meshId, target.nodeId, target.workspace, this.now());
        const run = (async () => {
            let git: Record<string, unknown> | null = null;
            let failure = 'no_git_status';
            try {
                git = await this.options.probe(target);
            } catch (error: any) {
                failure = error?.message ? String(error.message) : 'probe_failed';
            }
            if (git && typeof git.isGitRepo === 'boolean') {
                const observedAt = typeof git.lastCheckedAt === 'number' ? git.lastCheckedAt : undefined;
                store.recordObservation({
                    meshId: target.meshId,
                    nodeId: target.nodeId,
                    workspace: target.workspace,
                    git,
                    source: 'coordinator_probe',
                    observedAt,
                });
                try { this.options.onObserved?.(target, git); } catch { /* self-heal is best-effort */ }
            } else {
                store.recordProbeFailure(target.meshId, target.nodeId, target.workspace, failure, this.now());
            }
        })()
            .catch((error: any) => {
                LOG.warn('MeshNodeGitState', `background refresh for ${target.nodeId} failed: ${error?.message || error}`);
            })
            .finally(() => {
                if (this.inflight.get(key) === run) this.inflight.delete(key);
                // Settle AFTER the in-flight slot is released so the re-render the
                // revision triggers no longer reports this node as refreshing.
                try { this.options.onSettled(target.meshId); } catch { /* best-effort */ }
            });
        this.inflight.set(key, run);
        return true;
    }

    /** Resolves once every probe in flight has settled (tests / shutdown). */
    async whenIdle(): Promise<void> {
        while (this.inflight.size > 0) {
            await Promise.allSettled([...this.inflight.values()]);
        }
    }
}
