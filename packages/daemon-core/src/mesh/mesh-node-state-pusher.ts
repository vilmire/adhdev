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
 * Lifetime: the coordinator's ack renews the subscription; an explicit refusal
 * (node no longer on its roster, sender gate) drops it; an unreachable
 * coordinator lets it lapse after the TTL — the coordinator's own stale-state
 * probe re-subscribes when it comes back. Nothing here is persisted: after a
 * member restart the coordinator's next background probe re-registers.
 *
 * P2P only — no server path, no seqscribe topic.
 */
import { LOG } from '../logging/logger.js';
import { readMeshTimeoutEnvMs } from '../runtime-defaults.js';
import { carryUpstreamFreshness, computeMeshNodeGitSignature, sanitizeObservedGit } from './mesh-node-git-state.js';

export const MESH_NODE_STATE_REPORT_COMMAND = 'mesh_node_git_report';
/** How often a subscribed workspace's git is re-read. */
export const MESH_NODE_STATE_PUSH_CHECK_MS = readMeshTimeoutEnvMs('MESH_NODE_STATE_PUSH_CHECK_MS', 60_000);
/** Unchanged state is still re-reported (and the upstream re-fetched) this often. */
export const MESH_NODE_STATE_PUSH_HEARTBEAT_MS = 300_000;
/** A subscription the coordinator has not acked for this long is dropped. */
export const MESH_NODE_STATE_PUSH_TTL_MS = 30 * 60_000;

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
}

export interface MeshNodeStatePusherOptions {
    dispatch?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    readGit: (workspace: string, opts: { refreshUpstream: boolean }) => Promise<Record<string, unknown> | null>;
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

    constructor(private readonly options: MeshNodeStatePusherOptions) {
        this.now = options.now ?? Date.now;
        this.checkIntervalMs = options.checkIntervalMs ?? MESH_NODE_STATE_PUSH_CHECK_MS;
        this.heartbeatMs = options.heartbeatMs ?? MESH_NODE_STATE_PUSH_HEARTBEAT_MS;
        this.ttlMs = options.ttlMs ?? MESH_NODE_STATE_PUSH_TTL_MS;
    }

    private key(coordinatorDaemonId: string, meshId: string, nodeId: string): string {
        return `${coordinatorDaemonId}\u0000${meshId}\u0000${nodeId}`;
    }

    list(): MeshNodeStatePushSubscription[] {
        return [...this.subscriptions.values()].map((sub) => ({ ...sub }));
    }

    /**
     * Register (or renew) from an answered coordinator probe. `git` is the state
     * just returned to the coordinator, so it is not pushed again until it changes.
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
            lastPushedAt: git ? now : (existing?.lastPushedAt ?? null),
            // The probe that registered us refreshed the upstream already.
            lastUpstreamRefreshAt: now,
            lastUpstreamGit: git ?? existing?.lastUpstreamGit ?? null,
        });
        if (!existing) {
            LOG.info('MeshNodeState', `pushing git state of node ${args.nodeId} (mesh ${args.meshId}) to coordinator ${coordinatorDaemonId.slice(0, 12)}`);
        }
        this.ensureTimer();
        return true;
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
    }

    /** One check pass over every subscription. Exposed for tests. */
    async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            for (const [key, sub] of [...this.subscriptions.entries()]) {
                const now = this.now();
                if (now >= sub.expiresAt) {
                    this.subscriptions.delete(key);
                    LOG.info('MeshNodeState', `push subscription for node ${sub.nodeId} (mesh ${sub.meshId}) lapsed — coordinator did not ack within the TTL`);
                    continue;
                }
                await this.checkOne(key, sub);
            }
        } finally {
            this.ticking = false;
            if (this.subscriptions.size === 0) this.stop();
        }
    }

    private async checkOne(key: string, sub: MeshNodeStatePushSubscription): Promise<void> {
        const now = this.now();
        const heartbeatDue = sub.lastPushedAt === null || now - sub.lastPushedAt >= this.heartbeatMs;
        const refreshUpstream = sub.lastUpstreamRefreshAt === null || now - sub.lastUpstreamRefreshAt >= this.heartbeatMs;
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
        if (signature === sub.lastSignature && !heartbeatDue) return;
        const observedAt = typeof git.lastCheckedAt === 'number' ? git.lastCheckedAt : now;
        let response: unknown;
        try {
            response = await this.options.dispatch!(sub.coordinatorDaemonId, MESH_NODE_STATE_REPORT_COMMAND, {
                meshId: sub.meshId,
                nodeId: sub.nodeId,
                workspace: sub.workspace,
                git,
                observedAt,
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
        }
    }
}
