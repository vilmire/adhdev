/**
 * Member side of the coordinator-held node state: PUSH this daemon's git state
 * for a mesh node to the coordinator that holds it, instead of waiting to be
 * probed (mesh-node-git-state.ts is the coordinator's store).
 *
 * Subscription: a coordinator's background `git_status` probe carries
 * `meshStateSubscription: { meshId, nodeId }`. Answering it registers
 * (coordinator daemon, mesh, node, workspace) here. From then on this daemon
 * re-reads the workspace's git every check interval (the upstream is refreshed
 * on the slower heartbeat cadence) and sends `mesh_node_git_report` over the
 * existing daemon↔daemon mesh command channel when the visible state changed,
 * plus a heartbeat so the coordinator's observation age stays honest.
 *
 * Runtime half: the same report carries this daemon's content-free RUNTIME
 * summary (sessions / build / upgrade marker / facts incl. quota —
 * mesh-node-runtime-summary.ts) so the coordinator answers those from held
 * state too. It is re-read on every check tick and, between ticks, a session
 * lifecycle change (`noteRuntimeChanged`, wired to the lifecycle bus) schedules
 * a debounced runtime-only push. Unchanged runtime stays quiet until the heartbeat.
 *
 * Lifetime: the coordinator's ack renews the subscription; an explicit refusal
 * (node no longer on its roster, sender gate) drops it; an unreachable
 * coordinator lets it lapse after the TTL — the coordinator's own stale-state
 * probe re-subscribes when it comes back. Nothing here is persisted: after a
 * member restart the coordinator's next background probe re-registers.
 *
 * Worktree reconciliation: every coordinator ack carries its per-process
 * `coordinatorBootId`. The first push of a (re-)registered subscription, and
 * the first push after the boot id changes (the coordinator restarted), also
 * lists the worktree nodes this daemon owns on the mesh (`memberWorktreeNodes`)
 * so the coordinator adopts any its roster lost. When a plain push reveals a new
 * boot id, one follow-up push carries the list right away.
 *
 * Every (re-)registration makes the next check tick push, so the coordinator's
 * held state flips from its own probe's snapshot to `member_push` within one
 * check interval — and a probe never postpones the heartbeat. A coordinator
 * that wants fresh state now (an explicit refresh) sends `mesh_node_state_nudge`
 * (`nudge`), which pushes immediately instead of waiting for the tick.
 *
 * P2P only — no server path, no seqscribe topic.
 */
import { LOG } from '../logging/logger.js';
import { readMeshTimeoutEnvMs } from '../runtime-defaults.js';
import { carryUpstreamFreshness, computeMeshNodeGitSignature, sanitizeObservedGit } from './mesh-node-git-state.js';
import { computeMeshNodeRuntimeSignature, sanitizeMeshNodeRuntimeSummary, type MeshNodeRuntimeSummary } from './mesh-node-runtime-summary.js';
import { sanitizeMemberWorktreeNodes, type MemberWorktreeNodeRecord } from './mesh-remote-worktree-membership.js';

export const MESH_NODE_STATE_REPORT_COMMAND = 'mesh_node_git_report';
/** How often a subscribed workspace's git is re-read. */
export const MESH_NODE_STATE_PUSH_CHECK_MS = readMeshTimeoutEnvMs('MESH_NODE_STATE_PUSH_CHECK_MS', 60_000);
/** Unchanged state is still re-reported (and the upstream re-fetched) this often. */
export const MESH_NODE_STATE_PUSH_HEARTBEAT_MS = 300_000;
/** A subscription the coordinator has not acked for this long is dropped. */
export const MESH_NODE_STATE_PUSH_TTL_MS = 30 * 60_000;
/** A nudge re-fetches the upstream only when the last upstream refresh is at least this old. */
export const MESH_NODE_STATE_NUDGE_UPSTREAM_MIN_MS = 60_000;
/** A burst of session lifecycle changes is coalesced into one runtime push after this quiet period. */
export const MESH_NODE_RUNTIME_PUSH_DEBOUNCE_MS = readMeshTimeoutEnvMs('MESH_NODE_RUNTIME_PUSH_DEBOUNCE_MS', 1_500);

export interface MeshNodeStatePushSubscription {
    coordinatorDaemonId: string;
    meshId: string;
    nodeId: string;
    workspace: string;
    expiresAt: number;
    lastSignature: string | null;
    lastPushedAt: number | null;
    lastUpstreamRefreshAt: number | null;
    /** Last read that verified the upstream (the registering probe, or a refresh tick). */
    lastUpstreamGit: Record<string, unknown> | null;
    /** Signature of the runtime summary the coordinator last acked (null = never sent). */
    lastRuntimeSignature: string | null;
    /** Boot id the coordinator returned on its last ack (null = none seen / older coordinator). */
    coordinatorBootId: string | null;
    /** Boot id the worktree list was last delivered to ('' = a coordinator without boot ids; null = not yet). */
    worktreeNodesDeliveredFor: string | null;
    /** Boot id a follow-up push was already triggered for (one follow-up per boot id). */
    worktreeFollowUpFor?: string | null;
}

export interface MeshNodeStatePusherOptions {
    dispatch?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    readGit: (workspace: string, opts: { refreshUpstream: boolean }) => Promise<Record<string, unknown> | null>;
    /** This daemon's content-free runtime summary (absent = git-only pusher, e.g. older wiring/tests). */
    readRuntime?: () => Promise<MeshNodeRuntimeSummary | Record<string, unknown> | null>;
    /** The worktree nodes this daemon owns on a mesh (absent = no worktree reconciliation). */
    readWorktreeNodes?: (meshId: string) => Promise<MemberWorktreeNodeRecord[] | unknown[]>;
    runtimeDebounceMs?: number;
    /** Injected for tests; defaults to an unref'd setTimeout. */
    startDebounce?: (fn: () => void, ms: number) => { stop(): void };
    now?: () => number;
    checkIntervalMs?: number;
    heartbeatMs?: number;
    ttlMs?: number;
    /** Injected for tests; defaults to an unref'd setInterval. */
    startTimer?: (fn: () => void, ms: number) => { stop(): void };
}

function readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** Parse the coordinator's `meshStateSubscription` marker off a git_status request. */
export function readMeshStateSubscription(args: unknown): { meshId: string; nodeId: string } | null {
    const marker = readRecord(readRecord(args).meshStateSubscription);
    const meshId = readString(marker.meshId);
    const nodeId = readString(marker.nodeId);
    return meshId && nodeId ? { meshId, nodeId } : null;
}

function readBootId(response: unknown): string | null {
    const root = readRecord(response);
    return readString(root.coordinatorBootId) || readString(readRecord(root.result).coordinatorBootId) || null;
}

/** true = accepted, false = explicitly refused (drop), null = no usable answer. */
function readAck(response: unknown): boolean | null {
    const root = readRecord(response);
    const inner = readRecord(root.result);
    const accepted = root.accepted ?? inner.accepted;
    if (accepted === true) return true;
    if (accepted === false) return false;
    if (root.success === false || inner.success === false) {
        const code = readString(root.code) || readString(inner.code) || readString(root.error) || readString(inner.error);
        // A sender-gate refusal or an unknown node is final for this subscription.
        if (code.startsWith('mesh_sender_') || code === 'mesh_node_unknown' || code === 'mesh_not_found') return false;
    }
    return null;
}

export class MeshNodeStatePusher {
    private readonly subscriptions = new Map<string, MeshNodeStatePushSubscription>();
    private readonly now: () => number;
    private readonly checkIntervalMs: number;
    private readonly heartbeatMs: number;
    private readonly ttlMs: number;
    private timer: { stop(): void } | null = null;
    private ticking = false;
    private readonly runtimeDebounceMs: number;
    private runtimeDebounce: { stop(): void } | null = null;
    private runtimePushing: Promise<void> | null = null;
    private runtimeDirtyWhilePushing = false;

    constructor(private readonly options: MeshNodeStatePusherOptions) {
        this.now = options.now ?? Date.now;
        this.checkIntervalMs = options.checkIntervalMs ?? MESH_NODE_STATE_PUSH_CHECK_MS;
        this.heartbeatMs = options.heartbeatMs ?? MESH_NODE_STATE_PUSH_HEARTBEAT_MS;
        this.ttlMs = options.ttlMs ?? MESH_NODE_STATE_PUSH_TTL_MS;
        this.runtimeDebounceMs = options.runtimeDebounceMs ?? MESH_NODE_RUNTIME_PUSH_DEBOUNCE_MS;
    }

    private key(coordinatorDaemonId: string, meshId: string, nodeId: string): string {
        return `${coordinatorDaemonId}\u0000${meshId}\u0000${nodeId}`;
    }

    list(): MeshNodeStatePushSubscription[] {
        return [...this.subscriptions.values()].map((sub) => ({ ...sub }));
    }

    /**
     * Register (or renew) from an answered coordinator probe. `git` is the state
     * just returned to the coordinator. The next check tick pushes regardless
     * (lastPushedAt cleared): the coordinator learns the subscription is live and
     * its held state becomes member-pushed, so it stops probing this node.
     */
    register(args: { coordinatorDaemonId: string; meshId: string; nodeId: string; workspace: string; git?: unknown }): boolean {
        if (!this.options.dispatch) return false;
        const coordinatorDaemonId = readString(args.coordinatorDaemonId);
        const workspace = readString(args.workspace);
        if (!coordinatorDaemonId || !args.meshId || !args.nodeId || !workspace) return false;
        const key = this.key(coordinatorDaemonId, args.meshId, args.nodeId);
        const now = this.now();
        const git = sanitizeObservedGit(args.git);
        const existing = this.subscriptions.get(key);
        this.subscriptions.set(key, {
            coordinatorDaemonId,
            meshId: args.meshId,
            nodeId: args.nodeId,
            workspace,
            expiresAt: now + this.ttlMs,
            lastSignature: git ? computeMeshNodeGitSignature(git) : (existing?.lastSignature ?? null),
            // Push on the next tick (see above) — never "just pushed", which used to
            // postpone the heartbeat every time the coordinator probed.
            lastPushedAt: null,
            // The probe that registered us refreshed the upstream already.
            lastUpstreamRefreshAt: now,
            lastUpstreamGit: git ?? existing?.lastUpstreamGit ?? null,
            lastRuntimeSignature: existing?.lastRuntimeSignature ?? null,
            coordinatorBootId: existing?.coordinatorBootId ?? null,
            // A probe means the coordinator wants fresh state: re-report the worktree list.
            worktreeNodesDeliveredFor: null,
        });
        if (!existing) {
            LOG.info('MeshNodeState', `pushing git state of node ${args.nodeId} (mesh ${args.meshId}) to coordinator ${coordinatorDaemonId.slice(0, 12)}`);
            // Land the runtime half now instead of on the next check tick.
            this.noteRuntimeChanged();
        }
        this.ensureTimer();
        return true;
    }

    /**
     * A coordinator asks for this node's state now (explicit refresh). Returns
     * whether a subscription exists — false tells the coordinator to fall back
     * to its handshake probe, which (re-)registers one. The push itself runs in
     * the background; the upstream is re-fetched only when the last refresh is
     * older than MESH_NODE_STATE_NUDGE_UPSTREAM_MIN_MS.
     */
    nudge(coordinatorDaemonId: string, meshId: string, nodeId: string): boolean {
        const key = this.key(readString(coordinatorDaemonId), readString(meshId), readString(nodeId));
        const sub = this.subscriptions.get(key);
        if (!sub || !this.options.dispatch) return false;
        let runtime: MeshNodeRuntimeSummary | null | undefined;
        const readRuntimeOnce = async () => {
            if (runtime === undefined) runtime = await this.readRuntimeSummary();
            return runtime;
        };
        void this.checkOne(key, sub, readRuntimeOnce, { force: true }).catch(() => { /* best-effort */ });
        return true;
    }

    /**
     * A session lifecycle fact changed on this daemon (registered / status /
     * terminated / …). Debounced: a burst becomes ONE runtime-only push to every
     * subscribed coordinator whose held runtime differs.
     */
    noteRuntimeChanged(): void {
        if (!this.options.readRuntime || !this.options.dispatch || this.subscriptions.size === 0) return;
        if (this.runtimePushing) {
            this.runtimeDirtyWhilePushing = true;
            return;
        }
        if (this.runtimeDebounce) return;
        const start = this.options.startDebounce ?? ((fn: () => void, ms: number) => {
            const handle = setTimeout(fn, ms);
            handle.unref?.();
            return { stop: () => clearTimeout(handle) };
        });
        this.runtimeDebounce = start(() => {
            this.runtimeDebounce = null;
            void this.pushRuntimeChanges();
        }, this.runtimeDebounceMs);
    }

    private async readRuntimeSummary(): Promise<MeshNodeRuntimeSummary | null> {
        if (!this.options.readRuntime) return null;
        try {
            return sanitizeMeshNodeRuntimeSummary(await this.options.readRuntime());
        } catch (error: any) {
            LOG.debug('MeshNodeState', `runtime read failed: ${error?.message || error}`);
            return null;
        }
    }

    /** Runtime-only push to every subscription whose acked runtime differs. Exposed for tests. */
    async pushRuntimeChanges(): Promise<void> {
        if (this.runtimePushing) {
            this.runtimeDirtyWhilePushing = true;
            return this.runtimePushing;
        }
        const run = (async () => {
            const runtime = await this.readRuntimeSummary();
            if (!runtime) return;
            const signature = computeMeshNodeRuntimeSignature(runtime);
            const observedAt = this.now();
            for (const [key, sub] of [...this.subscriptions.entries()]) {
                if (sub.lastRuntimeSignature === signature) continue;
                let response: unknown;
                const worktreeNodes = await this.worktreeNodesDue(sub);
                try {
                    response = await this.options.dispatch!(sub.coordinatorDaemonId, MESH_NODE_STATE_REPORT_COMMAND, {
                        meshId: sub.meshId,
                        nodeId: sub.nodeId,
                        workspace: sub.workspace,
                        runtime,
                        runtimeObservedAt: observedAt,
                        ...(worktreeNodes ? { memberWorktreeNodes: worktreeNodes } : {}),
                    });
                } catch {
                    continue; // unreachable — the next tick retries (subscription kept until its TTL)
                }
                const ack = readAck(response);
                if (ack === false) {
                    this.subscriptions.delete(key);
                    continue;
                }
                if (ack === true) {
                    sub.lastRuntimeSignature = signature;
                    sub.expiresAt = this.now() + this.ttlMs;
                    this.noteWorktreeAck(key, sub, response, worktreeNodes !== null);
                }
            }
        })().finally(() => {
            this.runtimePushing = null;
            if (this.runtimeDirtyWhilePushing) {
                this.runtimeDirtyWhilePushing = false;
                this.noteRuntimeChanged();
            }
        });
        this.runtimePushing = run;
        return run;
    }

    private ensureTimer(): void {
        if (this.timer || this.subscriptions.size === 0) return;
        const start = this.options.startTimer ?? ((fn: () => void, ms: number) => {
            const handle = setInterval(fn, ms);
            handle.unref?.();
            return { stop: () => clearInterval(handle) };
        });
        this.timer = start(() => { void this.tick(); }, this.checkIntervalMs);
    }

    stop(): void {
        this.timer?.stop();
        this.timer = null;
        this.runtimeDebounce?.stop();
        this.runtimeDebounce = null;
    }

    /** One check pass over every subscription. Exposed for tests. */
    async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            // Runtime is per DAEMON: read once per pass, shared by every subscription.
            let runtime: MeshNodeRuntimeSummary | null | undefined;
            const readRuntimeOnce = async () => {
                if (runtime === undefined) runtime = await this.readRuntimeSummary();
                return runtime;
            };
            for (const [key, sub] of [...this.subscriptions.entries()]) {
                const now = this.now();
                if (now >= sub.expiresAt) {
                    this.subscriptions.delete(key);
                    LOG.info('MeshNodeState', `push subscription for node ${sub.nodeId} (mesh ${sub.meshId}) lapsed — coordinator did not ack within the TTL`);
                    continue;
                }
                await this.checkOne(key, sub, readRuntimeOnce);
            }
        } finally {
            this.ticking = false;
            if (this.subscriptions.size === 0) this.stop();
        }
    }

    private async checkOne(
        key: string,
        sub: MeshNodeStatePushSubscription,
        readRuntime: () => Promise<MeshNodeRuntimeSummary | null>,
        opts?: { force?: boolean },
    ): Promise<void> {
        const now = this.now();
        const force = opts?.force === true;
        const heartbeatDue = force || sub.lastPushedAt === null || now - sub.lastPushedAt >= this.heartbeatMs;
        const upstreamRefreshEvery = force ? Math.min(MESH_NODE_STATE_NUDGE_UPSTREAM_MIN_MS, this.heartbeatMs) : this.heartbeatMs;
        const refreshUpstream = sub.lastUpstreamRefreshAt === null || now - sub.lastUpstreamRefreshAt >= upstreamRefreshEvery;
        let git: Record<string, unknown> | null = null;
        try {
            git = sanitizeObservedGit(await this.options.readGit(sub.workspace, { refreshUpstream }));
        } catch (error: any) {
            LOG.debug('MeshNodeState', `git read failed for ${sub.workspace}: ${error?.message || error}`);
            return;
        }
        if (!git) return;
        if (refreshUpstream) {
            sub.lastUpstreamRefreshAt = now;
            sub.lastUpstreamGit = git;
        } else {
            // Between upstream refreshes the read says 'unchecked'; report the
            // freshness verified at the last refresh instead (see carryUpstreamFreshness).
            git = carryUpstreamFreshness(sub.lastUpstreamGit, git, now);
        }
        const signature = computeMeshNodeGitSignature(git);
        const runtime = await readRuntime();
        const runtimeSignature = runtime ? computeMeshNodeRuntimeSignature(runtime) : null;
        const runtimeChanged = runtimeSignature !== null && runtimeSignature !== sub.lastRuntimeSignature;
        if (signature === sub.lastSignature && !heartbeatDue && !runtimeChanged) return;
        const observedAt = typeof git.lastCheckedAt === 'number' ? git.lastCheckedAt : now;
        const worktreeNodes = await this.worktreeNodesDue(sub);
        let response: unknown;
        try {
            response = await this.options.dispatch!(sub.coordinatorDaemonId, MESH_NODE_STATE_REPORT_COMMAND, {
                meshId: sub.meshId,
                nodeId: sub.nodeId,
                workspace: sub.workspace,
                git,
                observedAt,
                ...(runtime ? { runtime, runtimeObservedAt: now } : {}),
                ...(worktreeNodes ? { memberWorktreeNodes: worktreeNodes } : {}),
            });
        } catch {
            // Coordinator unreachable right now — keep the subscription until its TTL.
            return;
        }
        const ack = readAck(response);
        if (ack === false) {
            this.subscriptions.delete(key);
            LOG.info('MeshNodeState', `coordinator refused git state push for node ${sub.nodeId} (mesh ${sub.meshId}); subscription dropped`);
            return;
        }
        if (ack === true) {
            sub.lastSignature = signature;
            sub.lastPushedAt = now;
            sub.expiresAt = now + this.ttlMs;
            if (runtimeSignature !== null) sub.lastRuntimeSignature = runtimeSignature;
            this.noteWorktreeAck(key, sub, response, worktreeNodes !== null);
        }
    }

    /**
     * The worktree list to attach to this push, or null when it is not due: it is
     * due until delivered once to the coordinator's current boot id.
     */
    private async worktreeNodesDue(sub: MeshNodeStatePushSubscription): Promise<MemberWorktreeNodeRecord[] | null> {
        if (!this.options.readWorktreeNodes) return null;
        const due = sub.worktreeNodesDeliveredFor === null
            || (sub.coordinatorBootId !== null && sub.worktreeNodesDeliveredFor !== sub.coordinatorBootId);
        if (!due) return null;
        try {
            return sanitizeMemberWorktreeNodes(await this.options.readWorktreeNodes(sub.meshId));
        } catch (error: any) {
            LOG.debug('MeshNodeState', `worktree node read failed for mesh ${sub.meshId}: ${error?.message || error}`);
            return null;
        }
    }

    /** Record an accepted push's boot id; a newly seen boot id triggers ONE follow-up push carrying the list. */
    private noteWorktreeAck(key: string, sub: MeshNodeStatePushSubscription, response: unknown, carriedWorktreeNodes: boolean): void {
        const bootId = readBootId(response);
        sub.coordinatorBootId = bootId;
        if (carriedWorktreeNodes) {
            sub.worktreeNodesDeliveredFor = bootId ?? '';
            return;
        }
        if (!this.options.readWorktreeNodes || bootId === null || sub.worktreeNodesDeliveredFor === bootId) return;
        if (sub.worktreeFollowUpFor === bootId) return;
        sub.worktreeFollowUpFor = bootId;
        // The coordinator restarted since the list was delivered: re-report now rather
        // than on the next heartbeat.
        let runtime: MeshNodeRuntimeSummary | null | undefined;
        const readRuntimeOnce = async () => {
            if (runtime === undefined) runtime = await this.readRuntimeSummary();
            return runtime;
        };
        void this.checkOne(key, sub, readRuntimeOnce, { force: true }).catch(() => { /* best-effort */ });
    }
}
