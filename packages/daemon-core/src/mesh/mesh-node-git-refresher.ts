/**
 * Coordinator background freshness for remote mesh nodes' git state.
 *
 * The request path (mesh_status) never awaits a remote probe: it answers from
 * the coordinator-held store (mesh-node-git-state.ts). Member pushes
 * (mesh-node-state-pusher.ts) keep the store fresh — on change, and on a
 * heartbeat — so this probe is only the HANDSHAKE that (re)subscribes a member:
 *   - no entry / no held git yet (node just added, coordinator never saw it);
 *   - the member stopped pushing (restart, subscription lapsed): its observation
 *     ages past MESH_NODE_STATE_STALE_MS, which is comfortably above the member's
 *     push heartbeat, so a quiet-but-subscribed node is NEVER re-probed;
 *   - a member too old to push (its held state is only ever `coordinator_probe`):
 *     re-probed on the shorter legacy cadence it always had.
 * Answering the probe (`git_status` carrying `meshStateSubscription`) is what
 * registers the member's push subscription.
 *
 * An explicit refresh does not force-probe anything: `nudge` asks a subscribed
 * member to push NOW (`mesh_node_state_nudge`, fire-and-forget). Only a member
 * that answers "not subscribed" or does not know the nudge (older build) gets
 * the handshake probe instead.
 *
 * Bounded: one probe in flight per node, a failed probe backs off before the
 * next attempt. Completion calls `onSettled(meshId)` — the router invalidates the
 * aggregate snapshot and emits the mesh-state revision the dashboard listens to —
 * ONLY when the visible state changed (content, or the transition into / out of
 * unreachable). A probe that re-confirms the same state is silent: the per-call
 * overlay already reports its age, so dashboards need not refetch.
 *
 * Runtime half (`kickRuntime`): a node whose held runtime summary (sessions /
 * build / quota, mesh-node-runtime-summary.ts) is missing or stale — a member
 * too old to push it, or one that has not subscribed yet — gets ONE background
 * `get_status_metadata` per DAEMON (runtime is daemon-wide), recorded into every
 * node of that daemon. Same staleness rule; only a facts change or a session
 * launch/terminate settles with a revision.
 */
import { LOG } from '../logging/logger.js';
import { readMeshTimeoutEnvMs } from '../runtime-defaults.js';
import { MeshNodeGitStateStore, type MeshNodeGitStateEntry } from './mesh-node-git-state.js';
import { MESH_NODE_STATE_PUSH_HEARTBEAT_MS } from './mesh-node-state-pusher.js';

/**
 * A member-pushed observation older than this means the member stopped pushing
 * (restart / lapsed subscription) and gets the handshake probe. Twice the push
 * heartbeat: a quiet subscribed member re-reports every heartbeat (+ one check
 * interval of jitter), so it never crosses this line.
 */
export const MESH_NODE_STATE_STALE_MS = readMeshTimeoutEnvMs('MESH_NODE_STATE_STALE_MS', 2 * MESH_NODE_STATE_PUSH_HEARTBEAT_MS);
/**
 * Held state that only the coordinator's own probe ever wrote (a member too old
 * to push, or a handshake whose first push has not landed yet) is re-probed on
 * this shorter legacy cadence — nothing else keeps it fresh.
 */
export const MESH_NODE_STATE_LEGACY_STALE_MS = readMeshTimeoutEnvMs('MESH_NODE_STATE_LEGACY_STALE_MS', 180_000);
/** After a failed probe, wait this long before the next automatic attempt. */
export const MESH_NODE_STATE_FAILURE_BACKOFF_MS = readMeshTimeoutEnvMs('MESH_NODE_STATE_FAILURE_BACKOFF_MS', 60_000);
/** An explicit refresh never re-probes / re-nudges a node attempted more recently than this. */
export const MESH_NODE_STATE_FORCE_MIN_INTERVAL_MS = 5_000;
/** Command a coordinator sends a subscribed member to make it push now. */
export const MESH_NODE_STATE_NUDGE_COMMAND = 'mesh_node_state_nudge';

/**
 * Held runtime a reader may trust instead of a live remote call: it was PUSHED
 * by the member (so session changes arrive within the push debounce) and the
 * member is still pushing (observation younger than the stale threshold). A
 * `coordinator_probe` snapshot is a one-off read nothing keeps current.
 */
export function isHeldRuntimeLive(
    entry: Pick<MeshNodeGitStateEntry, 'runtime' | 'runtimeSource' | 'runtimeObservedAt'> | null | undefined,
    now: number = Date.now(),
    staleMs: number = MESH_NODE_STATE_STALE_MS,
): boolean {
    if (!entry?.runtime || entry.runtimeSource !== 'member_push' || entry.runtimeObservedAt === null) return false;
    return now - entry.runtimeObservedAt < staleMs;
}

/**
 * The live held runtime of the node `nodeId` on `meshId`, IF it belongs to
 * `daemonId` (the daemon a reader is about to call) and isHeldRuntimeLive —
 * else null, and the reader falls back to its live call (older members).
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

export interface MeshNodeGitRefresherOptions {
    store: MeshNodeGitStateStore;
    /** Run the actual remote probe. Resolves the git status, or null when the node could not answer. */
    probe: (target: MeshNodeGitRefreshTarget) => Promise<Record<string, unknown> | null>;
    /** Called when a probe changed what a viewer sees — invalidate + publish a mesh-state revision. */
    onSettled: (meshId: string) => void;
    /** Called with a successful probe's raw result (platform / facts self-heal). */
    onObserved?: (target: MeshNodeGitRefreshTarget, git: Record<string, unknown>) => void;
    /** Background runtime probe of one daemon (content-free summary, or null when it could not answer). */
    probeRuntime?: (daemonId: string) => Promise<Record<string, unknown> | null>;
    /**
     * Ask a subscribed member to push its state now. Resolves `true` when the
     * member holds a push subscription for this node (it will push), `false`
     * when it does not (not subscribed, or too old to know the nudge) — the
     * caller then falls back to the handshake probe. Rejects when unreachable.
     */
    nudge?: (target: MeshNodeGitRefreshTarget) => Promise<boolean>;
    now?: () => number;
    staleMs?: number;
    legacyStaleMs?: number;
    failureBackoffMs?: number;
}

export class MeshNodeGitRefresher {
    private readonly inflight = new Map<string, Promise<void>>();
    private readonly runtimeInflight = new Map<string, Promise<void>>();
    private readonly nudgeInflight = new Map<string, Promise<void>>();
    private readonly lastNudgeAt = new Map<string, number>();
    private readonly now: () => number;
    private readonly staleMs: number;
    private readonly legacyStaleMs: number;
    private readonly failureBackoffMs: number;

    constructor(private readonly options: MeshNodeGitRefresherOptions) {
        this.now = options.now ?? Date.now;
        this.staleMs = options.staleMs ?? MESH_NODE_STATE_STALE_MS;
        this.legacyStaleMs = Math.min(options.legacyStaleMs ?? MESH_NODE_STATE_LEGACY_STALE_MS, this.staleMs);
        this.failureBackoffMs = options.failureBackoffMs ?? MESH_NODE_STATE_FAILURE_BACKOFF_MS;
    }

    /** Stale threshold for an observation: member-pushed state is kept fresh by the member's heartbeat. */
    private staleFor(source: MeshNodeGitStateEntry['source']): number {
        return source === 'member_push' ? this.staleMs : this.legacyStaleMs;
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
        if (!entry || entry.observedAt === null || !entry.git) return true;
        return now - entry.observedAt >= this.staleFor(entry.source);
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
        const run = (async (): Promise<boolean> => {
            let git: Record<string, unknown> | null = null;
            let failure = 'no_git_status';
            try {
                git = await this.options.probe(target);
            } catch (error: any) {
                failure = error?.message ? String(error.message) : 'probe_failed';
            }
            if (git && typeof git.isGitRepo === 'boolean') {
                const observedAt = typeof git.lastCheckedAt === 'number' ? git.lastCheckedAt : undefined;
                const recorded = store.recordObservation({
                    meshId: target.meshId,
                    nodeId: target.nodeId,
                    workspace: target.workspace,
                    git,
                    source: 'coordinator_probe',
                    observedAt,
                });
                try { this.options.onObserved?.(target, git); } catch { /* self-heal is best-effort */ }
                // `changed` covers new content AND the recovery out of unreachable.
                return recorded.changed;
            }
            // Only the transition INTO unreachable is a visible change.
            return store.recordProbeFailure(target.meshId, target.nodeId, target.workspace, failure, this.now()).changed;
        })()
            .catch((error: any) => {
                LOG.warn('MeshNodeGitState', `background refresh for ${target.nodeId} failed: ${error?.message || error}`);
                return false;
            })
            .then((changed) => {
                if (this.inflight.get(key) === run) this.inflight.delete(key);
                // Settle AFTER the in-flight slot is released so the re-render the
                // revision triggers no longer reports this node as refreshing.
                if (changed) {
                    try { this.options.onSettled(target.meshId); } catch { /* best-effort */ }
                }
            });
        this.inflight.set(key, run);
        return true;
    }

    isRuntimeRefreshing(meshId: string, daemonId: string): boolean {
        return this.runtimeInflight.has(this.key(meshId, daemonId));
    }

    private runtimeNeedsRefresh(meshId: string, nodeId: string, force: boolean): boolean {
        const entry = this.options.store.get(meshId, nodeId);
        const now = this.now();
        if (entry?.runtimeLastAttemptAt != null && now - entry.runtimeLastAttemptAt < MESH_NODE_STATE_FORCE_MIN_INTERVAL_MS) return false;
        // A member that pushes its runtime is never force-probed: a refresh nudges it instead.
        if (force && entry?.runtimeSource !== 'member_push') return true;
        if (entry?.runtimeLastFailureAt != null && now - entry.runtimeLastFailureAt < this.failureBackoffMs) return false;
        if (!entry || entry.runtimeObservedAt === null || !entry.runtime) return true;
        return now - entry.runtimeObservedAt >= this.staleFor(entry.runtimeSource);
    }

    /**
     * Start ONE background runtime probe for a daemon when any of its nodes'
     * held runtime is missing/stale (or `force` — an explicit refresh — for a
     * member that does not push its runtime). Never awaited by the request path.
     */
    kickRuntime(meshId: string, daemonId: string, targets: Array<{ nodeId: string; workspace: string; force?: boolean }>): boolean {
        const probeRuntime = this.options.probeRuntime;
        if (!probeRuntime || !meshId || !daemonId || targets.length === 0) return false;
        const key = this.key(meshId, daemonId);
        if (this.runtimeInflight.has(key)) return false;
        if (!targets.some((t) => this.runtimeNeedsRefresh(meshId, t.nodeId, t.force === true))) return false;
        const { store } = this.options;
        const startedAt = this.now();
        for (const t of targets) store.recordRuntimeProbeAttempt(meshId, t.nodeId, t.workspace, startedAt);
        const run = (async () => {
            let runtime: Record<string, unknown> | null = null;
            try {
                runtime = await probeRuntime(daemonId);
            } catch {
                runtime = null;
            }
            let factsChanged = false;
            for (const t of targets) {
                if (runtime) {
                    const recorded = store.recordRuntimeObservation({
                        meshId, nodeId: t.nodeId, workspace: t.workspace, runtime, source: 'coordinator_probe', observedAt: this.now(), daemonId,
                    });
                    if (!recorded.entry) store.recordRuntimeProbeFailure(meshId, t.nodeId, t.workspace, this.now());
                    factsChanged = factsChanged || recorded.factsChanged || recorded.sessionsChanged;
                } else {
                    store.recordRuntimeProbeFailure(meshId, t.nodeId, t.workspace, this.now());
                }
            }
            return factsChanged;
        })()
            .catch((error: any) => {
                LOG.warn('MeshNodeGitState', `background runtime refresh for ${daemonId} failed: ${error?.message || error}`);
                return false;
            })
            .then((factsChanged) => {
                if (this.runtimeInflight.get(key) === run) this.runtimeInflight.delete(key);
                if (factsChanged) {
                    try { this.options.onSettled(meshId); } catch { /* best-effort */ }
                }
            });
        this.runtimeInflight.set(key, run);
        return true;
    }

    /**
     * Explicit refresh: ask the member to push its state now instead of probing
     * it. Fire-and-forget (never awaited by the request path). A member that is
     * not subscribed, or too old to know the nudge, gets the handshake probe;
     * an unreachable one is left to the normal stale / failure-backoff rules.
     * Returns whether a nudge was sent.
     */
    nudge(target: MeshNodeGitRefreshTarget): boolean {
        if (!target.meshId || !target.nodeId || !target.daemonId || !target.workspace) return false;
        const key = this.key(target.meshId, target.nodeId);
        if (this.nudgeInflight.has(key) || this.isRefreshing(target.meshId, target.nodeId)) return false;
        const now = this.now();
        const last = this.lastNudgeAt.get(key);
        if (last !== undefined && now - last < MESH_NODE_STATE_FORCE_MIN_INTERVAL_MS) return false;
        const nudge = this.options.nudge;
        if (!nudge) {
            // No nudge channel wired (tests / older wiring): the handshake probe is the only way.
            return this.kick(target, { force: true });
        }
        this.lastNudgeAt.set(key, now);
        const run = (async () => {
            let subscribed: boolean | null;
            try {
                subscribed = await nudge(target);
            } catch {
                subscribed = null; // unreachable — the stale / backoff rules decide the next probe
            }
            if (subscribed === false) this.kick(target, { force: true });
        })()
            .catch(() => { /* best-effort */ })
            .finally(() => {
                if (this.nudgeInflight.get(key) === run) this.nudgeInflight.delete(key);
            });
        this.nudgeInflight.set(key, run);
        return true;
    }

    /** Resolves once every probe / nudge in flight has settled (tests / shutdown). */
    async whenIdle(): Promise<void> {
        while (this.inflight.size > 0 || this.runtimeInflight.size > 0 || this.nudgeInflight.size > 0) {
            await Promise.allSettled([...this.inflight.values(), ...this.runtimeInflight.values(), ...this.nudgeInflight.values()]);
        }
    }
}
