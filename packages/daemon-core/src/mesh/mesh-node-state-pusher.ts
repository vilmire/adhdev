/**
 * Member side of the coordinator-held node state: PUSH this daemon's git state
 * for a mesh node to the coordinator that holds it, instead of waiting to be
 * probed (mesh-node-git-state.ts is the coordinator's store).
 *
 * Subscription: a coordinator's `mesh_node_state_nudge` (first contact, a
 * (re)connect handshake, an explicit refresh) carrying the node's workspace
 * registers (coordinator daemon, mesh, node, workspace) here when it is not
 * registered yet — the coordinator never probes. From then on this daemon
 * re-reads the workspace's git every check interval (the upstream is refreshed
 * on the slower heartbeat cadence) and sends `mesh_node_git_report` over the
 * existing daemon↔daemon mesh command channel when the visible state changed,
 * plus a heartbeat so the coordinator's observation age stays honest. A report
 * whose git did not change since the coordinator last acked it (the heartbeat,
 * a nudge over an unchanged checkout) carries only `gitSignature` + the
 * upstream fetch stamp; the coordinator confirms it against what it holds and
 * `gitHeld: false` makes this daemon send the body at once (same read).
 *
 * Runtime half: the same report carries this daemon's content-free RUNTIME
 * summary (sessions / build / upgrade marker / facts incl. quota —
 * mesh-node-runtime-summary.ts) so the coordinator answers those from held
 * state too — but only when its signature changed since the coordinator last
 * acked it; otherwise the report carries just `runtimeSignature`, which the
 * coordinator confirms against what it holds (`runtimeHeld: false` makes the
 * next push carry the summary again). It is re-read on every check tick and,
 * between ticks, a session lifecycle change (`noteRuntimeChanged`, wired to
 * the lifecycle bus) schedules a debounced runtime-only push.
 *
 * Lifetime: the coordinator's ack renews the subscription; an explicit refusal
 * (node no longer on its roster, sender gate, a coordinator that does not know
 * the report command) drops it; an unreachable coordinator lets it lapse after
 * the TTL — the coordinator's handshake re-subscribes when its link comes back.
 *
 * Restart: the subscription SET (coordinator, mesh, node, workspace — ids and
 * a local path, no state) is persisted (`persistence`). A restarted member
 * restores it at boot (`restore`, plus memberships derived from its mesh host
 * records / config) and pushes at once (`pushNow`) — and again whenever the
 * link to a coordinator comes up (`pushNow(coordinatorDaemonId)`) — so the
 * coordinator sees the new process's build within seconds instead of after
 * its stale threshold. Without this the coordinator kept reporting the
 * replaced build until its held state aged out (rc.61 live regression).
 *
 * Worktree reconciliation: every coordinator ack carries its per-process
 * `coordinatorBootId`. The first push of a (re-)registered subscription, and
 * the first push after the boot id changes (the coordinator restarted), also
 * lists the worktree nodes this daemon owns on the mesh (`memberWorktreeNodes`)
 * so the coordinator adopts any its roster lost. When a plain push reveals a new
 * boot id, one follow-up push carries the list right away.
 *
 * A nudge pushes immediately instead of waiting for the tick.
 *
 * Change detector: every subscribed workspace's git dir is watched
 * (workspace-git-watcher.ts — HEAD / index / refs / packed-refs, debounced, no
 * git spawned by the watch itself). A commit / checkout / `git add` made from a
 * terminal is re-read and pushed within about a second; while a workspace is
 * watched the check tick does NOT re-read its git (the heartbeat still does,
 * with the upstream fetch). A workspace that cannot be watched keeps the
 * per-tick re-read.
 *
 * P2P only — no server path, no seqscribe topic.
 */
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import { readMeshTimeoutEnvMs } from '../runtime-defaults.js';
import * as fs from 'fs';
import { carryUpstreamFreshness, computeMeshNodeGitSignature, digestMeshNodeStateSignature, sanitizeObservedGit } from './mesh-node-git-state.js';
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

/** A forced push (nudge / reconnect / boot) of one subscription is skipped when the last one is younger than this. */
export const MESH_NODE_STATE_FORCED_PUSH_MIN_INTERVAL_MS = 5_000;
/**
 * A git-dir change within this long after this daemon's own read of that
 * workspace is its own write (`git status` refreshing the index, the heartbeat's
 * upstream fetch moving remote-tracking refs) — ignored, so a read never
 * re-triggers itself.
 */
export const MESH_NODE_STATE_SELF_READ_QUIET_MS = 1_500;

/** The restart-surviving part of a subscription: who to push which node's state to. */
export interface MeshNodeStatePushTarget {
    coordinatorDaemonId: string;
    meshId: string;
    nodeId: string;
    workspace: string;
}

export interface MeshNodeStatePushPersistence {
    load(): MeshNodeStatePushTarget[];
    save(targets: MeshNodeStatePushTarget[]): void;
}

export interface MeshNodeStatePushSubscription {
    coordinatorDaemonId: string;
    meshId: string;
    nodeId: string;
    workspace: string;
    expiresAt: number;
    lastSignature: string | null;
    lastPushedAt: number | null;
    lastUpstreamRefreshAt: number | null;
    /** Last read that verified the upstream (a refresh tick / forced push). */
    lastUpstreamGit: Record<string, unknown> | null;
    /** Signature of the runtime summary the coordinator last acked (null = never sent). */
    lastRuntimeSignature: string | null;
    /** Boot id the coordinator returned on its last ack (null = none seen / older coordinator). */
    coordinatorBootId: string | null;
    /** Boot id the worktree list was last delivered to ('' = a coordinator without boot ids; null = not yet). */
    worktreeNodesDeliveredFor: string | null;
    /** Boot id a follow-up push was already triggered for (one follow-up per boot id). */
    worktreeFollowUpFor?: string | null;
    /** Epoch ms of the last forced push (nudge / reconnect / boot). */
    lastForcedPushAt?: number | null;
    /** The last git read (post freshness carry) — reused by a check tick of a watched, unchanged workspace. */
    lastGit?: Record<string, unknown> | null;
    /** The change detector fired (or a read is owed) since the last git read. */
    gitDirty?: boolean;
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
    /** Restart-surviving subscription set (absent = in-memory only). */
    persistence?: MeshNodeStatePushPersistence;
    /**
     * Change detector for a subscribed workspace's git dir (workspace-git-watcher.ts).
     * Returns a handle while the workspace is watched, null when it cannot be.
     * A watched workspace's git is re-read only when the detector fires, on the
     * heartbeat (upstream refresh) or on a forced push — never on the check tick.
     * Absent / null → the check tick re-reads it (the unwatched fallback).
     */
    watchGit?: (workspace: string, onChange: () => void, onError: () => void) => { stop(): void } | null;
    /** A detector callback within this long after this daemon's OWN git read is ignored (its status / fetch writes). */
    selfReadQuietMs?: number;
}

function readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** The coordinator's verdict on a signature-only runtime report (null = not answered). */
function readRuntimeHeld(response: unknown): boolean | null {
    const root = readRecord(response);
    const held = root.runtimeHeld ?? readRecord(root.result).runtimeHeld;
    return typeof held === 'boolean' ? held : null;
}

/** The coordinator's verdict on a signature-only git report (null = not answered — e.g. an older coordinator). */
function readGitHeld(response: unknown): boolean | null {
    const root = readRecord(response);
    const held = root.gitHeld ?? readRecord(root.result).gitHeld;
    return typeof held === 'boolean' ? held : null;
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
        // A coordinator too old to hold pushed state (a restored subscription can reach one).
        if (code.startsWith('Unknown command')) return false;
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
    /** workspace → its git change detector (null handle = could not watch → the tick re-reads it). */
    private readonly gitWatches = new Map<string, { stop(): void } | null>();
    /** workspace → own git reads in flight / epoch ms until which detector callbacks are ignored. */
    private readonly gitReadsInFlight = new Map<string, number>();
    private readonly gitQuietUntil = new Map<string, number>();
    /** Subscription keys whose change-triggered check is running (a callback meanwhile re-runs it after). */
    private readonly changeChecks = new Map<string, boolean>();
    private readonly selfReadQuietMs: number;

    constructor(private readonly options: MeshNodeStatePusherOptions) {
        this.now = options.now ?? Date.now;
        this.checkIntervalMs = options.checkIntervalMs ?? MESH_NODE_STATE_PUSH_CHECK_MS;
        this.heartbeatMs = options.heartbeatMs ?? MESH_NODE_STATE_PUSH_HEARTBEAT_MS;
        this.ttlMs = options.ttlMs ?? MESH_NODE_STATE_PUSH_TTL_MS;
        this.runtimeDebounceMs = options.runtimeDebounceMs ?? MESH_NODE_RUNTIME_PUSH_DEBOUNCE_MS;
        this.selfReadQuietMs = options.selfReadQuietMs ?? MESH_NODE_STATE_SELF_READ_QUIET_MS;
    }

    // ─── git change detector (member side) ───────────────────────────────────

    private ensureGitWatch(workspace: string): void {
        if (!this.options.watchGit || this.gitWatches.has(workspace)) return;
        let handle: { stop(): void } | null = null;
        try {
            handle = this.options.watchGit(
                workspace,
                () => this.onGitChanged(workspace),
                // The watch died (the dir went away, an FS error): the tick re-reads it from now on.
                () => { if (this.gitWatches.has(workspace)) this.gitWatches.set(workspace, null); },
            );
        } catch (error: any) {
            LOG.debug('MeshNodeState', `git watch failed for ${workspace}: ${error?.message || error}`);
            handle = null;
        }
        this.gitWatches.set(workspace, handle);
    }

    private releaseGitWatch(workspace: string): void {
        for (const sub of this.subscriptions.values()) if (sub.workspace === workspace) return;
        const handle = this.gitWatches.get(workspace);
        this.gitWatches.delete(workspace);
        try { handle?.stop(); } catch { /* noop */ }
    }

    /** Whether `workspace`'s git is covered by a live change detector. */
    isGitWatched(workspace: string): boolean {
        return !!this.gitWatches.get(workspace);
    }

    /**
     * The detector saw the workspace's git dir move: re-read it now for every
     * subscription on it and push when the visible state changed. A callback
     * inside this daemon's own read window is its own write and is ignored.
     */
    private onGitChanged(workspace: string): void {
        if ((this.gitReadsInFlight.get(workspace) ?? 0) > 0) return;
        if (this.now() < (this.gitQuietUntil.get(workspace) ?? 0)) return;
        let runtime: MeshNodeRuntimeSummary | null | undefined;
        const readRuntimeOnce = async () => {
            if (runtime === undefined) runtime = await this.readRuntimeSummary();
            return runtime;
        };
        for (const [key, sub] of this.subscriptions) {
            if (sub.workspace !== workspace) continue;
            sub.gitDirty = true;
            if (this.changeChecks.has(key)) {
                this.changeChecks.set(key, true); // re-run once the running check settles
                continue;
            }
            void this.runChangeCheck(key, sub, readRuntimeOnce);
        }
    }

    private async runChangeCheck(key: string, sub: MeshNodeStatePushSubscription, readRuntime: () => Promise<MeshNodeRuntimeSummary | null>): Promise<void> {
        this.changeChecks.set(key, false);
        try {
            await this.checkOne(key, sub, readRuntime);
        } catch { /* best-effort */ } finally {
            const again = this.changeChecks.get(key) === true;
            this.changeChecks.delete(key);
            if (again && this.subscriptions.get(key) === sub) void this.runChangeCheck(key, sub, readRuntime);
        }
    }

    private async readGitTracked(workspace: string, refreshUpstream: boolean): Promise<Record<string, unknown> | null> {
        this.gitReadsInFlight.set(workspace, (this.gitReadsInFlight.get(workspace) ?? 0) + 1);
        try {
            return sanitizeObservedGit(await this.options.readGit(workspace, { refreshUpstream }));
        } finally {
            const left = (this.gitReadsInFlight.get(workspace) ?? 1) - 1;
            if (left > 0) this.gitReadsInFlight.set(workspace, left);
            else this.gitReadsInFlight.delete(workspace);
            this.gitQuietUntil.set(workspace, this.now() + this.selfReadQuietMs);
        }
    }

    private key(coordinatorDaemonId: string, meshId: string, nodeId: string): string {
        return `${coordinatorDaemonId}\u0000${meshId}\u0000${nodeId}`;
    }

    list(): MeshNodeStatePushSubscription[] {
        return [...this.subscriptions.values()].map((sub) => ({ ...sub }));
    }

    /**
     * Register a subscription — from a coordinator's nudge, a restored one after
     * a restart, or a membership derived from this daemon's mesh host records.
     * Nothing is held for it yet, so the first push carries the full git +
     * runtime + worktree list. An existing subscription is left untouched.
     * Returns whether one was added.
     */
    selfRegister(target: MeshNodeStatePushTarget): boolean {
        if (!this.options.dispatch) return false;
        const coordinatorDaemonId = readString(target.coordinatorDaemonId);
        const meshId = readString(target.meshId);
        const nodeId = readString(target.nodeId);
        const workspace = readString(target.workspace);
        if (!coordinatorDaemonId || !meshId || !nodeId || !workspace) return false;
        const key = this.key(coordinatorDaemonId, meshId, nodeId);
        if (this.subscriptions.has(key)) return false;
        this.subscriptions.set(key, {
            coordinatorDaemonId,
            meshId,
            nodeId,
            workspace,
            expiresAt: this.now() + this.ttlMs,
            lastSignature: null,
            lastPushedAt: null,
            lastUpstreamRefreshAt: null,
            lastUpstreamGit: null,
            lastRuntimeSignature: null,
            coordinatorBootId: null,
            worktreeNodesDeliveredFor: null,
            gitDirty: true,
        });
        this.ensureGitWatch(workspace);
        this.ensureTimer();
        this.persistTargets();
        return true;
    }

    /**
     * Boot: restore the persisted subscription set plus `derived` memberships
     * (self-registered, not pushed — call pushNow once the transport is up).
     * Returns how many subscriptions were added.
     */
    restore(derived: MeshNodeStatePushTarget[] = [], opts?: { selfDaemonId?: string }): number {
        const self = readString(opts?.selfDaemonId);
        let persisted: MeshNodeStatePushTarget[] = [];
        try {
            persisted = this.options.persistence?.load() ?? [];
        } catch (error: any) {
            LOG.debug('MeshNodeState', `push subscription restore failed: ${error?.message || error}`);
        }
        let added = 0;
        for (const target of [...persisted, ...derived]) {
            // Never push to ourselves (a config dir shared with another daemon's record).
            if (self && daemonIdsEquivalent(readString(target?.coordinatorDaemonId), self)) continue;
            if (this.selfRegister(target)) added += 1;
        }
        if (added > 0) {
            LOG.info('MeshNodeState', `restored ${added} node state push subscription(s) — pushing to their coordinators now`);
            this.persistTargets();
        }
        return added;
    }

    /**
     * Push every subscription (or only those of `coordinatorDaemonId`) NOW, in
     * the background — at boot once the mesh transport is up, and whenever the
     * link to a coordinator (re)opens, so a coordinator learns this process's
     * state (build, sessions, git) within seconds. A subscription force-pushed
     * less than MESH_NODE_STATE_FORCED_PUSH_MIN_INTERVAL_MS ago is skipped.
     * Returns how many pushes were started.
     */
    pushNow(coordinatorDaemonId?: string): number {
        if (!this.options.dispatch) return 0;
        const wanted = readString(coordinatorDaemonId);
        const now = this.now();
        let runtime: MeshNodeRuntimeSummary | null | undefined;
        const readRuntimeOnce = async () => {
            if (runtime === undefined) runtime = await this.readRuntimeSummary();
            return runtime;
        };
        let started = 0;
        for (const [key, sub] of [...this.subscriptions.entries()]) {
            if (wanted && !daemonIdsEquivalent(sub.coordinatorDaemonId, wanted)) continue;
            if (sub.lastForcedPushAt != null && now - sub.lastForcedPushAt < MESH_NODE_STATE_FORCED_PUSH_MIN_INTERVAL_MS) continue;
            sub.lastForcedPushAt = now;
            void this.checkOne(key, sub, readRuntimeOnce, { force: true }).catch(() => { /* best-effort */ });
            started += 1;
        }
        return started;
    }

    private persistTargets(): void {
        if (!this.options.persistence) return;
        try {
            this.options.persistence.save([...this.subscriptions.values()].map((sub) => ({
                coordinatorDaemonId: sub.coordinatorDaemonId,
                meshId: sub.meshId,
                nodeId: sub.nodeId,
                workspace: sub.workspace,
            })));
        } catch (error: any) {
            LOG.debug('MeshNodeState', `push subscription persist failed: ${error?.message || error}`);
        }
    }

    private dropSubscription(key: string): void {
        const sub = this.subscriptions.get(key);
        if (!this.subscriptions.delete(key)) return;
        this.persistTargets();
        if (sub) this.releaseGitWatch(sub.workspace);
    }

    /**
     * A coordinator asks for this node's state now (first contact, handshake,
     * explicit refresh). A node not yet pushed to that coordinator is
     * subscribed on the spot when `workspace` is given and exists on this
     * machine. Returns whether a subscription exists (false = refused). The
     * push itself runs in the background; the upstream is re-fetched only when
     * the last refresh is older than MESH_NODE_STATE_NUDGE_UPSTREAM_MIN_MS.
     */
    nudge(coordinatorDaemonId: string, meshId: string, nodeId: string, workspace?: string): boolean {
        if (!this.options.dispatch) return false;
        const coordinator = readString(coordinatorDaemonId);
        const key = this.key(coordinator, readString(meshId), readString(nodeId));
        if (!this.subscriptions.has(key)) {
            const path = readString(workspace);
            if (!path || !fs.existsSync(path)) return false;
            if (!this.selfRegister({ coordinatorDaemonId: coordinator, meshId, nodeId, workspace: path })) return false;
            LOG.info('MeshNodeState', `pushing state of node ${nodeId} (mesh ${meshId}) to coordinator ${coordinator.slice(0, 12)}`);
        }
        const sub = this.subscriptions.get(key);
        if (!sub) return false;
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
        // A session did something (a turn ended, a session launched / exited) — the
        // working tree it works in may have changed in ways the git-dir detector
        // cannot see (edited files): the next check re-reads git.
        for (const sub of this.subscriptions.values()) sub.gitDirty = true;
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
                    this.dropSubscription(key);
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
        for (const handle of this.gitWatches.values()) {
            try { handle?.stop(); } catch { /* noop */ }
        }
        this.gitWatches.clear();
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
                    this.dropSubscription(key);
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
        // A watched workspace whose git dir has not moved is not re-read on the
        // check tick (no git spawn when nothing changed): the last read stands until
        // the detector fires, the heartbeat refreshes the upstream, or a push is forced.
        const reuse = !force && !heartbeatDue && !refreshUpstream && sub.gitDirty !== true
            && !!sub.lastGit && this.isGitWatched(sub.workspace);
        let git: Record<string, unknown> | null = null;
        if (reuse) {
            git = sub.lastGit!;
        } else {
            try {
                git = await this.readGitTracked(sub.workspace, refreshUpstream);
            } catch (error: any) {
                LOG.debug('MeshNodeState', `git read failed for ${sub.workspace}: ${error?.message || error}`);
                return;
            }
            if (!git) return;
            sub.gitDirty = false;
            if (refreshUpstream) {
                sub.lastUpstreamRefreshAt = now;
                sub.lastUpstreamGit = git;
            } else {
                // Between upstream refreshes the read says 'unchecked'; report the
                // freshness verified at the last refresh instead (see carryUpstreamFreshness).
                git = carryUpstreamFreshness(sub.lastUpstreamGit, git, now);
            }
            sub.lastGit = git;
        }
        const signature = computeMeshNodeGitSignature(git);
        const runtime = await readRuntime();
        const runtimeSignature = runtime ? computeMeshNodeRuntimeSignature(runtime) : null;
        const runtimeChanged = runtimeSignature !== null && runtimeSignature !== sub.lastRuntimeSignature;
        if (signature === sub.lastSignature && !heartbeatDue && !runtimeChanged) return;
        const observedAt = typeof git.lastCheckedAt === 'number' ? git.lastCheckedAt : now;
        const worktreeNodes = await this.worktreeNodesDue(sub);
        const gitBody = git;
        const report = (fullGit: boolean): Record<string, unknown> => ({
            meshId: sub.meshId,
            nodeId: sub.nodeId,
            workspace: sub.workspace,
            // The git body only when it changed since the coordinator last acked it;
            // otherwise its signature (+ the upstream fetch stamp the coordinator's
            // auto-ff precheck reads), which the coordinator confirms (gitHeld).
            ...(fullGit
                ? { git: gitBody }
                : { gitSignature: digestMeshNodeStateSignature(signature), ...(typeof gitBody.upstreamFetchedAt === 'number' ? { upstreamFetchedAt: gitBody.upstreamFetchedAt } : {}) }),
            observedAt,
            // The summary only when it changed since the coordinator last acked it;
            // otherwise its signature, which the coordinator confirms (runtimeHeld).
            ...(runtime && runtimeChanged ? { runtime, runtimeObservedAt: now } : {}),
            ...(runtime && !runtimeChanged && runtimeSignature ? { runtimeSignature: digestMeshNodeStateSignature(runtimeSignature), runtimeObservedAt: now } : {}),
            ...(worktreeNodes ? { memberWorktreeNodes: worktreeNodes } : {}),
        });
        const signatureOnly = signature === sub.lastSignature;
        let response: unknown;
        try {
            response = await this.options.dispatch!(sub.coordinatorDaemonId, MESH_NODE_STATE_REPORT_COMMAND, report(!signatureOnly));
            // The coordinator does not hold this git state (it restarted without the
            // row, a restart handshake is pending, or it predates signature-only
            // reports): send the body now — the same read, no second git spawn.
            if (signatureOnly && readAck(response) !== false && readGitHeld(response) !== true) {
                response = await this.options.dispatch!(sub.coordinatorDaemonId, MESH_NODE_STATE_REPORT_COMMAND, report(true));
            }
        } catch {
            // Coordinator unreachable right now — keep the subscription until its TTL.
            return;
        }
        const ack = readAck(response);
        if (ack === false) {
            this.dropSubscription(key);
            LOG.info('MeshNodeState', `coordinator refused git state push for node ${sub.nodeId} (mesh ${sub.meshId}); subscription dropped`);
            return;
        }
        if (ack === true) {
            sub.lastSignature = signature;
            sub.lastPushedAt = now;
            sub.expiresAt = now + this.ttlMs;
            if (runtimeSignature !== null) sub.lastRuntimeSignature = runtimeSignature;
            this.noteWorktreeAck(key, sub, response, worktreeNodes !== null);
            // The coordinator does not hold this summary (it restarted without the row,
            // or a restart handshake wants the new process's): send it on the next push.
            if (runtime && !runtimeChanged && readRuntimeHeld(response) === false) {
                sub.lastRuntimeSignature = null;
                this.noteRuntimeChanged();
            }
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
