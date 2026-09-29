/**
 * TopicSubscriptionRegistry — shared dashboard-subscription topic ENGINE.
 *
 * Extraction target for the 6 dashboard subscription topic engines that were
 * duplicated between daemon-cloud (P2P DataChannel sink) and daemon-standalone
 * (local WebSocket sink). The registry owns the per-subscription state machine
 * (normalize / throttle / seq / dedup / refresh-concurrency); the daemons keep
 * ONLY transport mechanics (WS framing, P2P chunking) behind the injected
 * {@link TopicSink}. Design: docs/design/2026-08-24-topic-subscription-core-extraction.md
 * (root repo).
 *
 * ── Engine map (captured 2026-08-24, pre-extraction — line numbers of that day) ──
 *
 * | topic                    | cloud engine (packages/daemon-cloud/src)                  | standalone engine (oss/packages/daemon-standalone/src/index.ts) | throttle                              | seq mechanism                                   | dedup mechanism                       |
 * |--------------------------|-----------------------------------------------------------|-----------------------------------------------------------------|---------------------------------------|--------------------------------------------------|---------------------------------------|
 * | machine.runtime          | adhdev-daemon.ts:633                                       | index.ts:2143                                                   | intervalMs (min 5s, default 15s)      | per-subscription `seq += 1`                      | (2026-09-29) signature — send on change |
 * | session_host.diagnostics | adhdev-daemon.ts:663                                       | index.ts:2180                                                   | intervalMs (min 5s, default 10s)      | per-subscription `seq += 1`                      | (2026-09-29) signature — send on change |
 * | session.modal            | adhdev-daemon.ts:713 (interactionId + debug trace)         | index.ts:2230 (no interactionId)                                | none (event/status driven)            | per-subscription via prepareSessionModalUpdate    | lastDeliveredSignature (core helper)  |
 * | daemon.metadata          | adhdev-daemon.ts:783                                       | index.ts:2273                                                   | none (always builds)                  | per-subscription `seq += 1`                      | (2026-09-29) keyed snapshot/delta     |
 * | workspace.git            | adhdev-daemon.ts:838 (build, per-sub seq, NO concurrency   | index.ts:2330 (flush, concurrency 2 via runAsyncBatch,          | intervalMs (min 1s, default 5s via    | cloud: per-subscription `seq += 1`;              | (2026-09-29) signature — send on change |
 * |                          | cap — sequential per peer)                                 | monitor-global seq)                                             | GitWorkspaceMonitor normalize)        | standalone: GitWorkspaceMonitor global seq       |                                       |
 *
 * ── Union decisions applied for the workspace.git cohort (S2) ──
 * 1. git refresh concurrency cap: engine-internal, default 2 (standalone had 2;
 *    cloud was a sequential per-peer loop — cloud GAINS the cap / parallelism bound).
 * 2. seq semantics: per-subscription monotonic counter (cloud semantics).
 *    Standalone previously stamped the GitWorkspaceMonitor's process-global seq,
 *    which interleaved across subscriptions; per-subscription seq stays strictly
 *    monotonic per key, which is the only property consumers rely on.
 * 3. workspace trimming: engine trims `params.workspace` (cloud did, standalone
 *    did not — standalone gains the trim).
 * 4. interactionId stamping (`opts.interactionId`) is declared here per the design
 *    but is NOT used by workspace.git — only session.modal stamps it.
 *
 * ── Union decisions applied for the S3 cohorts (daemon.metadata → session.modal
 *    → machine.runtime → session_host.diagnostics) ──
 * 5. (retired) The legacy chat push topic that used to sit in this cohort was
 *    removed on 2026-09-29: dashboard chat is served only by the keyed
 *    `session.<id>.chat` seqscribe lane (design 2026-09-28 §6.4).
 * 6. daemon.metadata stays throttle-free, and since 2026-09-29 (data-path
 *    audit P0-3) it is the ONE dashboard state lane: the first frame per
 *    subscription is a snapshot, later frames carry only the keyed difference
 *    (see {@link DaemonMetadataDelta}); an unchanged daemon sends nothing.
 *
 * ── Change-only delivery (2026-09-29, audit P1-9 / P2) ──
 * machine.runtime / session_host.diagnostics / workspace.git keep their
 * interval throttle but also dedupe by a content signature, so a quiet
 * machine / session host / repo sends nothing. workspace.git runs git only
 * while watched (subscribe, invalidation, the host's sample tick) — the
 * monitor's own refreshes (turn end, send_chat) reach subscribers through its
 * listener without another git run.
 * 7. interactionId stamping + debug-trace recording on session.modal are hooks ({@link TopicEngineOptions.interactionId} /
 *    {@link TopicEngineOptions.recordTrace}): cloud passes its subsystems and
 *    stays byte-identical; standalone passes none in S3 and gains both in S4.
 * 8. session.modal subscribe validation = cloud semantics (trimmed non-empty
 *    targetSessionId); standalone only rejected falsy ids — whitespace-only ids
 *    are now rejected for both (no dashboard sends those).
 *
 * ── Deviation from the design sketch ──
 * The sketch's `sink.isActive(topic)` ("does a subscriber exist") became
 * registry-internal state once the registry took ownership of subscription
 * storage (it must, to own seq/throttle state). The sink instead answers two
 * transport questions per connection: {@link TopicSink.isAlive} (connection
 * object still exists — false lets the registry dispose its subscriptions) and
 * {@link TopicSink.isDeliverable} (transport can deliver right now — false
 * skips the flush WITHOUT disposing, preserving cloud's behavior of keeping
 * subscriptions across transient `disconnected` blips).
 */

import type {
    DaemonMetadataDelta,
    DaemonMetadataSubscriptionParams,
    DaemonMetadataUpdate,
    MachineInfo,
    MeshStatusDeltaUpdate,
    MeshStatusSnapshotUpdate,
    MachineRuntimeSubscriptionParams,
    SessionHostDiagnosticsSnapshot,
    SessionHostDiagnosticsSubscriptionParams,
    SessionModalSubscriptionParams,
    SubscribeRequest,
    TransportTopic,
    UnsubscribeRequest,
} from '../shared-types.js';
import type { TopicUpdateEnvelope } from '../shared-types.js';
import type { GitWorkspaceSubscription, GitWorkspaceMonitor, NormalizedWorkspaceGitSubscriptionParams } from '../git/git-monitor.js';
import type { GitWorkspaceUpdate } from '../git/git-types.js';
import {
    DASHBOARD_WIRE_VERSION,
    DAEMON_METADATA_DOC_SPEC,
    diffKeyedDoc,
    digestKeyedDoc,
    MESH_STATUS_DOC_SPEC,
    type KeyedDocDelta,
    type KeyedDocDigest,
    type KeyedDocSpec,
} from '@adhdev/mesh-shared';
import { createGitWorkspaceMonitor } from '../git/git-monitor.js';
import type { WorkspaceGitSubscriptionParams } from '../git/git-types.js';
import { runAsyncBatch } from '../chat/async-batch.js';
import { prepareSessionModalUpdate } from '../chat/subscription-updates.js';
import { buildMachineInfo } from '../status/snapshot.js';
import {
    DEFAULT_MACHINE_RUNTIME_SUBSCRIPTION_INTERVAL_MS,
    DEFAULT_SESSION_HOST_DIAGNOSTICS_SUBSCRIPTION_INTERVAL_MS,
    MIN_MACHINE_RUNTIME_SUBSCRIPTION_INTERVAL_MS,
    MIN_SESSION_HOST_DIAGNOSTICS_SUBSCRIPTION_INTERVAL_MS,
} from '../runtime-defaults.js';
import type { SessionModalState } from '../providers/provider-instance.js';
import type { DebugTraceEvent } from '../logging/debug-trace.js';

/**
 * Transport sink injected by each daemon. The registry never sees WS framing
 * or P2P chunking — it only asks these three questions.
 */
export interface TopicSink {
    /** Deliver one topic_update envelope over the transport. */
    send(connectionId: string, topic: TransportTopic, update: TopicUpdateEnvelope): boolean;
    /**
     * Transport can deliver right now (peer state === 'connected' / ws OPEN).
     * False skips the connection for this flush pass without disposing anything.
     */
    isDeliverable(connectionId: string): boolean;
    /**
     * Connection object still exists. False means the connection is gone for
     * good — the registry disposes and drops its subscriptions (lazy pruning;
     * daemons that get an explicit close event should also call
     * {@link TopicSubscriptionRegistry.dropConnection}).
     */
    isAlive(connectionId: string): boolean;
}

/** Default git refresh parallelism (union decision — was standalone-only). */
export const DEFAULT_GIT_REFRESH_CONCURRENCY = 2;


/**
 * Daemon-injected data sources for the push-style topic engines. The engine
 * owns WHEN to build/throttle/dedup/stamp; the daemon owns WHAT the payload
 * body is (its own components/controllers produce the data).
 */
export interface TopicEngineSources {
    /**
     * machine.runtime payload. Defaults to the shared
     * {@link buildMachineInfo}('full') — which is what BOTH daemons passed.
     */
    machineInfo?: () => MachineInfo;
    /**
     * session_host.diagnostics payload. Return `null` (not a promise) when the
     * session-host controller is unavailable — the engine then skips the
     * subscription WITHOUT mutating seq/throttle state, matching both daemons'
     * pre-extraction `if (!controller) return null` guard.
     */
    sessionHostDiagnostics?: (opts: { includeSessions: boolean; limit?: number }) =>
        Promise<SessionHostDiagnosticsSnapshot> | null;
    /** session.modal state lookup (lightweight modal projection — see daemon-session-modal-hotpath). */
    sessionModalState?: (sessionId: string) => SessionModalState | null;
    /**
     * daemon.metadata payload body — everything except the engine-owned
     * envelope fields (topic/key/seq/timestamp). Cloud returns
     * {daemonId, status, meshStateRevisions?}; standalone {daemonId, status, userName?}.
     */
    daemonMetadataBody?: (params: DaemonMetadataSubscriptionParams | undefined) => DaemonMetadataUpdateBody;
    /**
     * mesh.status payload: the coordinator's held `mesh_status` result for one
     * mesh (the body the `mesh_status` command returns), or null when this
     * daemon cannot answer for it right now.
     */
    meshStatus?: (meshId: string) => Promise<Record<string, unknown> | null>;
}

/**
 * A per-connection projection of daemon.metadata (a share-link peer sees only
 * what its permission allows — daemon-cloud decides). `key` names the
 * projection so connections with the same scope share one built body.
 */
export interface DaemonMetadataScope {
    key: string;
    project(body: DaemonMetadataUpdateBody): DaemonMetadataUpdateBody;
}

export type DaemonMetadataUpdateBody = Omit<DaemonMetadataUpdate, 'topic' | 'key' | 'seq' | 'timestamp' | 'mode'>;

/**
 * daemon.metadata digest options: `daemonId` is envelope identity, the build
 * `timestamp` changes every pass, and a session's `lastUpdated` is stamped at
 * build time (providers return `Date.now()`), so none of them is a change.
 */
function signatureOf(value: unknown): string {
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        return '';
    }
}

/**
 * machine.runtime change signature. `uptime` counts seconds and memory / load
 * move by a few bytes every sample, so the signature coarsens them (uptime to
 * the minute, memory to 1% of total, load to 0.1) — the frame that IS sent
 * carries the exact values.
 */
export function machineRuntimeSignature(machine: MachineInfo): string {
    const total = typeof machine.totalMem === 'number' && machine.totalMem > 0 ? machine.totalMem : 0;
    const pct = (value: unknown) => (typeof value === 'number' && total > 0 ? Math.round((value / total) * 100) : value);
    return signatureOf({
        ...machine,
        uptime: typeof machine.uptime === 'number' ? Math.floor(machine.uptime / 60) : machine.uptime,
        freeMem: pct(machine.freeMem),
        availableMem: pct(machine.availableMem),
        loadavg: Array.isArray(machine.loadavg) ? machine.loadavg.map((v) => Math.round(v * 10) / 10) : machine.loadavg,
    });
}

/**
 * session_host.diagnostics change signature — the snapshot minus the trace of
 * the `get_host_diagnostics` requests this topic itself issues (each poll
 * would otherwise show up as a change in the next one).
 */
export function sessionHostDiagnosticsSignature(diagnostics: SessionHostDiagnosticsSnapshot): string {
    const requests = Array.isArray(diagnostics?.recentRequests)
        ? diagnostics.recentRequests.filter((trace) => trace?.type !== 'get_host_diagnostics')
        : diagnostics?.recentRequests;
    return signatureOf({ ...diagnostics, recentRequests: requests });
}

/** workspace.git change signature — status + diff, minus the per-check `lastCheckedAt` stamp. */
export function workspaceGitSignature(update: Pick<GitWorkspaceUpdate, 'status' | 'diffSummary'>): string {
    const { lastCheckedAt: _checked, ...status } = (update.status ?? {}) as unknown as Record<string, unknown>;
    return signatureOf({ status, diffSummary: update.diffSummary ?? null });
}

export interface TopicEngineOptions {
    /**
     * Debug-trace correlation id provider (cloud's interactionId subsystem).
     * Consumed by the session.modal engine; workspace.git
     * does not stamp it. Standalone gains a provider in S4.
     */
    interactionId?: (sessionId?: string) => string | undefined;
    /**
     * Debug-trace sink for the modal publish stage (cloud passes
     * recordDebugTrace; standalone gains it in S4).
     */
    recordTrace?: (event: DebugTraceEvent) => void;
    /** Daemon-injected payload sources for the push-style topic engines. */
    sources?: TopicEngineSources;
    /** daemon.metadata projection per connection (null / absent = the full body). */
    metadataScope?: (connectionId: string) => DaemonMetadataScope | null;
    /** Max concurrent git refreshes per flush pass. Default {@link DEFAULT_GIT_REFRESH_CONCURRENCY}. */
    gitRefreshConcurrency?: number;
    /**
     * Shared GitWorkspaceMonitor. Daemons already own one (status snapshots read
     * its compact-summary cache) — inject it so the engine and the snapshot path
     * observe the same cache. A private monitor is created when omitted.
     */
    gitMonitor?: GitWorkspaceMonitor;
    /** Clock override for tests. */
    now?: () => number;
    /**
     * Per-subscription flush failure hook — both daemons log-and-continue, each
     * with its own logger, so the transport keeps the log line.
     */
    onFlushError?: (
        topic: TransportTopic,
        error: unknown,
        context: { connectionId: string; key: string; detail?: string },
    ) => void;
}

interface WorkspaceGitSubscriptionEntry {
    readonly connectionId: string;
    readonly key: string;
    params: NormalizedWorkspaceGitSubscriptionParams;
    subscription: GitWorkspaceSubscription;
    seq: number;
    lastSentAt: number;
    /** Last flush PASS that reached this entry (throttle cleared), whether or not it sent — a dedup no-op still counts. Reconciliation reads this, not `lastSentAt`. */
    lastFlushedAt: number;
    /** Signature of the last DELIVERED frame ('' = none yet). */
    lastSignature: string;
    /** Status-only part of {@link lastSignature} (decides whether a diff-less refresh warrants a diff run). */
    lastStatusSignature: string;
}

/** Registry-stored push-style topics (subscription storage owned here). */
type PushTopic = 'machine.runtime' | 'session_host.diagnostics' | 'session.modal' | 'daemon.metadata' | 'mesh.status';

const PUSH_TOPICS: ReadonlyArray<PushTopic> = ['machine.runtime', 'session_host.diagnostics', 'session.modal', 'daemon.metadata', 'mesh.status'];

interface PushTopicEntry {
    readonly connectionId: string;
    readonly key: string;
    params: Record<string, unknown>;
    seq: number;
    lastSentAt: number;
    /** Last flush PASS that reached this entry (throttle cleared), whether or not it sent — a dedup no-op still counts. Reconciliation reads this, not `lastSentAt`. */
    lastFlushedAt: number;
    lastDeliveredSignature: string;
    /** Keyed lanes (daemon.metadata / mesh.status): digest of the last DELIVERED document; null = next frame is a snapshot. */
    keyedBaseline: KeyedDocDigest | null;
}

/**
 * Topics whose engine has migrated into the registry (S3 complete: all five
 * remaining cohorts).
 */
const MIGRATED_TOPICS: ReadonlySet<TransportTopic> = new Set<TransportTopic>([
    'workspace.git',
    ...PUSH_TOPICS,
]);

/**
 * Topics the registry flushes when {@link TopicSubscriptionRegistry.invalidate}
 * consumes a CommandSpec.invalidates set (machine.runtime is never in the
 * invalidation table).
 */
const INVALIDATABLE_TOPICS: ReadonlyArray<TransportTopic> = [
    'daemon.metadata',
    'session_host.diagnostics',
    'session.modal',
    'workspace.git',
];

export class TopicSubscriptionRegistry {
    private readonly sink: TopicSink;
    private readonly opts: TopicEngineOptions;
    private readonly now: () => number;
    private readonly gitMonitor: GitWorkspaceMonitor;
    private readonly gitRefreshConcurrency: number;
    /** connectionId → key → subscription engine state. */
    private readonly gitSubscriptions = new Map<string, Map<string, WorkspaceGitSubscriptionEntry>>();
    /** topic → connectionId → key → subscription engine state (push-style topics). */
    private readonly pushSubscriptions = new Map<PushTopic, Map<string, Map<string, PushTopicEntry>>>();
    /** mesh.status: meshes with a build in flight, and those asked again meanwhile. */
    private readonly meshFlushInflight = new Map<string, Promise<void>>();
    private readonly meshFlushAgain = new Set<string>();

    constructor(sink: TopicSink, opts: TopicEngineOptions = {}) {
        this.sink = sink;
        this.opts = opts;
        this.now = opts.now ?? Date.now;
        this.gitMonitor = opts.gitMonitor ?? createGitWorkspaceMonitor();
        // A monitor refresh from ANY cause (turn end, send_chat, another
        // subscription's pass) reaches every subscriber of that workspace
        // without running git again; unchanged content sends nothing.
        this.gitMonitor.onUpdate((update) => {
            try {
                this.deliverWorkspaceGitUpdate(update);
            } catch (error) {
                this.opts.onFlushError?.('workspace.git', error, { connectionId: '', key: '', detail: update.workspace });
            }
        });
        const requested = Math.floor(opts.gitRefreshConcurrency ?? DEFAULT_GIT_REFRESH_CONCURRENCY);
        this.gitRefreshConcurrency = Number.isFinite(requested) && requested > 0
            ? requested
            : DEFAULT_GIT_REFRESH_CONCURRENCY;
    }

    /** Whether the registry owns the engine + storage for `topic` (migrated cohort gate). */
    handlesTopic(topic: string): topic is TransportTopic {
        return MIGRATED_TOPICS.has(topic as TransportTopic);
    }

    private isPushTopic(topic: string): topic is PushTopic {
        return (PUSH_TOPICS as ReadonlyArray<string>).includes(topic);
    }

    /**
     * Register (or replace — same key resets seq/throttle/dedup state, matching
     * both daemons' overwrite-on-resubscribe behavior) a subscription.
     * Returns false when the topic is not registry-stored (runtime_output
     * stays daemon-side) or params are invalid, so callers can
     * fall through to their local engine / ignore.
     */
    subscribe(connectionId: string, request: SubscribeRequest): boolean {
        if (!request.key) return false;
        // One wire format per release: a page that speaks another version gets
        // an explicit mismatch instead of state it would misread (no dual-format
        // serving) — it reloads, or asks for a daemon update.
        if (request.wireVersion !== DASHBOARD_WIRE_VERSION) {
            this.sink.send(connectionId, request.topic, {
                topic: request.topic,
                key: request.key,
                mode: 'protocol_mismatch',
                daemonWireVersion: DASHBOARD_WIRE_VERSION,
                pageWireVersion: typeof request.wireVersion === 'number' ? request.wireVersion : null,
                seq: 0,
                timestamp: this.now(),
            });
            return false;
        }
        if (request.topic === 'workspace.git') {
            const rawParams = request.params as WorkspaceGitSubscriptionParams | undefined;
            const workspace = typeof rawParams?.workspace === 'string' ? rawParams.workspace.trim() : '';
            if (!workspace) return false;
            const normalized = this.gitMonitor.normalize({
                workspace,
                includeDiffSummary: Boolean(rawParams?.includeDiffSummary),
                intervalMs: typeof rawParams?.intervalMs === 'number' ? rawParams.intervalMs : Number(rawParams?.intervalMs),
            });
            const subs = this.gitSubscriptions.get(connectionId) ?? new Map<string, WorkspaceGitSubscriptionEntry>();
            this.gitSubscriptions.set(connectionId, subs);
            subs.get(request.key)?.subscription.dispose();
            subs.set(request.key, {
                connectionId,
                key: request.key,
                params: normalized,
                subscription: this.gitMonitor.createSubscription(normalized),
                seq: 0,
                lastSentAt: 0,
                lastFlushedAt: 0,
                lastSignature: '',
                lastStatusSignature: '',
            });
            return true;
        }
        if (!this.isPushTopic(request.topic)) return false;
        const params = (request.params && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;
        if (request.topic === 'session.modal') {
            // Cloud validation semantics (union decision #8): trimmed non-empty id.
            const targetSessionId = typeof params.targetSessionId === 'string' ? params.targetSessionId.trim() : '';
            if (!targetSessionId) return false;
        }
        if (request.topic === 'mesh.status') {
            const meshId = typeof params.meshId === 'string' ? params.meshId.trim() : '';
            if (!meshId) return false;
            params.meshId = meshId;
        }
        const byConn = this.pushSubscriptions.get(request.topic) ?? new Map<string, Map<string, PushTopicEntry>>();
        this.pushSubscriptions.set(request.topic, byConn);
        const subs = byConn.get(connectionId) ?? new Map<string, PushTopicEntry>();
        byConn.set(connectionId, subs);
        subs.set(request.key, {
            connectionId,
            key: request.key,
            params,
            seq: 0,
            lastSentAt: 0,
            lastFlushedAt: 0,
            lastDeliveredSignature: '',
            keyedBaseline: null,
        });
        return true;
    }

    /** Returns true when the topic is registry-owned (even if no entry matched). */
    unsubscribe(connectionId: string, request: Pick<UnsubscribeRequest, 'topic' | 'key'>): boolean {
        if (request.topic === 'workspace.git') {
            const subs = this.gitSubscriptions.get(connectionId);
            const entry = subs?.get(request.key);
            if (entry) {
                entry.subscription.dispose();
                subs!.delete(request.key);
                if (subs!.size === 0) this.gitSubscriptions.delete(connectionId);
            }
            return true;
        }
        if (!this.isPushTopic(request.topic)) return false;
        const byConn = this.pushSubscriptions.get(request.topic);
        const subs = byConn?.get(connectionId);
        if (subs) {
            subs.delete(request.key);
            if (subs.size === 0) byConn!.delete(connectionId);
        }
        return true;
    }

    /** Dispose and drop every subscription owned by a closed connection (all topics). */
    dropConnection(connectionId: string): void {
        const subs = this.gitSubscriptions.get(connectionId);
        if (subs) {
            for (const entry of subs.values()) entry.subscription.dispose();
            subs.clear();
            this.gitSubscriptions.delete(connectionId);
        }
        for (const byConn of this.pushSubscriptions.values()) {
            byConn.delete(connectionId);
        }
    }

    hasSubscriptions(topic: TransportTopic, connectionId?: string): boolean {
        if (topic === 'workspace.git') {
            if (connectionId) return (this.gitSubscriptions.get(connectionId)?.size ?? 0) > 0;
            for (const subs of this.gitSubscriptions.values()) {
                if (subs.size > 0) return true;
            }
            return false;
        }
        if (!this.isPushTopic(topic)) return false;
        const byConn = this.pushSubscriptions.get(topic);
        if (!byConn) return false;
        if (connectionId) return (byConn.get(connectionId)?.size ?? 0) > 0;
        for (const subs of byConn.values()) {
            if (subs.size > 0) return true;
        }
        return false;
    }

    /**
     * Oldest `lastSentAt` across every subscriber of `topic` (0 if any
     * subscriber has never been sent — that counts as maximally stale), or
     * `null` when the topic has no subscribers at all. Read-only: used by the
     * host runtime's slow WARN-only reconciliation pass (P-II item 1) to
     * decide whether a topic's bus-edge-driven flush was actually delivered,
     * never to drive a flush itself.
     */
    oldestLastSentAt(topic: TransportTopic): number | null {
        if (topic === 'workspace.git') {
            let oldest: number | null = null;
            for (const subs of this.gitSubscriptions.values()) {
                for (const entry of subs.values()) {
                    if (oldest === null || entry.lastSentAt < oldest) oldest = entry.lastSentAt;
                }
            }
            return oldest;
        }
        if (!this.isPushTopic(topic)) return null;
        const byConn = this.pushSubscriptions.get(topic);
        if (!byConn) return null;
        let oldest: number | null = null;
        for (const subs of byConn.values()) {
            for (const entry of subs.values()) {
                if (oldest === null || entry.lastSentAt < oldest) oldest = entry.lastSentAt;
            }
        }
        return oldest;
    }

    /** Oldest `lastFlushedAt` across every subscriber of `topic` (see the field doc) — what the WARN-only reconciliation compares against. */
    oldestLastFlushedAt(topic: TransportTopic): number | null {
        if (topic === 'workspace.git') {
            let oldest: number | null = null;
            for (const subs of this.gitSubscriptions.values()) {
                for (const entry of subs.values()) {
                    if (oldest === null || entry.lastFlushedAt < oldest) oldest = entry.lastFlushedAt;
                }
            }
            return oldest;
        }
        if (!this.isPushTopic(topic)) return null;
        const byConn = this.pushSubscriptions.get(topic);
        if (!byConn) return null;
        let oldest: number | null = null;
        for (const subs of byConn.values()) {
            for (const entry of subs.values()) {
                if (oldest === null || entry.lastFlushedAt < oldest) oldest = entry.lastFlushedAt;
            }
        }
        return oldest;
    }

    /**
     * Consume a `command_executed.invalidates` set (from the command registry): run a flush pass for each
     * invalidated topic the registry owns. NOTE: matches both daemons' historic
     * behavior — invalidation triggers a flush PASS, it does not bypass the
     * per-subscription interval throttle. `skip` lets cloud's launch fastpath
     * suppress the daemon.metadata double-flush it already performed.
     */
    async invalidate(topics: ReadonlySet<string>, options: { skip?: ReadonlyArray<string> } = {}): Promise<void> {
        for (const topic of INVALIDATABLE_TOPICS) {
            if (!topics.has(topic)) continue;
            if (options.skip?.includes(topic)) continue;
            if (!this.hasSubscriptions(topic)) continue;
            // An invalidation is the explicit "the repo changed" signal: it
            // runs git regardless of the per-subscription sampling interval.
            if (topic === 'workspace.git') await this.flushWorkspaceGit(undefined, undefined, true);
            else await this.flushNow(topic);
        }
    }

    /**
     * "Upstream state changed" nudge — run a throttled flush pass for a
     * migrated topic. Payload bodies come from the daemon-injected
     * {@link TopicEngineSources}; the pull-based workspace.git engine refreshes
     * from its own monitor.
     */
    async publish(topic: TransportTopic): Promise<void> {
        if (!MIGRATED_TOPICS.has(topic)) return;
        await this.flushNow(topic);
    }

    /**
     * Run one flush pass now (optionally scoped to a single connection — and
     * key — e.g. the targeted first flush right after subscribe). The per-subscription
     * interval throttle still applies — identical to both daemons' historic
     * flush functions.
     */
    async flushNow(topic: TransportTopic, connectionId?: string, key?: string): Promise<void> {
        switch (topic) {
            case 'workspace.git': return this.flushWorkspaceGit(connectionId, key);
            case 'machine.runtime': return this.flushMachineRuntime(connectionId, key);
            case 'session_host.diagnostics': return this.flushSessionHostDiagnostics(connectionId, key);
            case 'session.modal': return this.flushSessionModal(connectionId, key);
            case 'daemon.metadata': return this.flushDaemonMetadata(connectionId, key);
            case 'mesh.status': return this.flushMeshStatusEntries(this.collectPushEntries('mesh.status', connectionId, key));
            default: return;
        }
    }

    /**
     * Deliverable push-topic entries for one flush pass. Dead connections are
     * lazily pruned (cloud peers have no per-peer close hook that reaches the
     * registry); alive-but-undeliverable connections are skipped, not dropped.
     */
    private collectPushEntries(topic: PushTopic, connectionId?: string, key?: string): PushTopicEntry[] {
        const byConn = this.pushSubscriptions.get(topic);
        if (!byConn) return [];
        const entries: PushTopicEntry[] = [];
        for (const [connId, subs] of Array.from(byConn.entries())) {
            if (connectionId && connId !== connectionId) continue;
            if (!this.sink.isAlive(connId)) {
                this.dropConnection(connId);
                continue;
            }
            if (!this.sink.isDeliverable(connId)) continue;
            for (const entry of subs.values()) {
                if (key === undefined || entry.key === key) entries.push(entry);
            }
        }
        return entries;
    }

    /**
     * machine.runtime engine — interval throttle (min 5s / default 15s) +
     * per-subscription monotonic seq + change-only delivery
     * ({@link machineRuntimeSignature}).
     */
    private async flushMachineRuntime(connectionId?: string, key?: string): Promise<void> {
        const source = this.opts.sources?.machineInfo ?? (() => buildMachineInfo('full'));
        let sample: { machine: MachineInfo; signature: string } | null = null;
        for (const entry of this.collectPushEntries('machine.runtime', connectionId, key)) {
            const params = entry.params as MachineRuntimeSubscriptionParams;
            const intervalMs = Math.max(
                MIN_MACHINE_RUNTIME_SUBSCRIPTION_INTERVAL_MS,
                Number(params.intervalMs || DEFAULT_MACHINE_RUNTIME_SUBSCRIPTION_INTERVAL_MS),
            );
            const now = this.now();
            if (entry.lastFlushedAt > 0 && (now - entry.lastFlushedAt) < intervalMs) continue;
            entry.lastFlushedAt = now;
            if (!sample) {
                const machine = source();
                sample = { machine, signature: machineRuntimeSignature(machine) };
            }
            if (sample.signature === entry.lastDeliveredSignature) continue;
            entry.seq += 1;
            entry.lastSentAt = now;
            const delivered = this.sink.send(entry.connectionId, 'machine.runtime', {
                topic: 'machine.runtime',
                key: entry.key,
                machine: sample.machine,
                seq: entry.seq,
                timestamp: now,
            });
            entry.lastDeliveredSignature = delivered === false ? '' : sample.signature;
        }
    }

    /**
     * session_host.diagnostics engine — interval throttle (min 5s / default
     * 10s); a null source result (controller unavailable) skips WITHOUT
     * mutating state. Change-only delivery
     * ({@link sessionHostDiagnosticsSignature}).
     */
    private async flushSessionHostDiagnostics(connectionId?: string, key?: string): Promise<void> {
        const source = this.opts.sources?.sessionHostDiagnostics;
        if (!source) return;
        for (const entry of this.collectPushEntries('session_host.diagnostics', connectionId, key)) {
            const params = entry.params as SessionHostDiagnosticsSubscriptionParams;
            const intervalMs = Math.max(
                MIN_SESSION_HOST_DIAGNOSTICS_SUBSCRIPTION_INTERVAL_MS,
                Number(params.intervalMs || DEFAULT_SESSION_HOST_DIAGNOSTICS_SUBSCRIPTION_INTERVAL_MS),
            );
            const now = this.now();
            if (entry.lastFlushedAt > 0 && (now - entry.lastFlushedAt) < intervalMs) continue;
            const pending = source({
                includeSessions: params.includeSessions !== false,
                limit: Number(params.limit) || undefined,
            });
            if (!pending) continue;
            const diagnostics = await pending;
            entry.lastFlushedAt = now;
            const signature = sessionHostDiagnosticsSignature(diagnostics);
            if (signature === entry.lastDeliveredSignature) continue;
            // Standalone re-checked ws OPEN after the await; cloud's send is a
            // no-op on a disconnected peer — the recheck is safe for both.
            if (!this.sink.isDeliverable(entry.connectionId)) continue;
            entry.seq += 1;
            entry.lastSentAt = now;
            const delivered = this.sink.send(entry.connectionId, 'session_host.diagnostics', {
                topic: 'session_host.diagnostics',
                key: entry.key,
                diagnostics,
                seq: entry.seq,
                timestamp: now,
            });
            entry.lastDeliveredSignature = delivered === false ? '' : signature;
        }
    }

    /**
     * session.modal engine — event-driven (no interval throttle), deduped via
     * prepareSessionModalUpdate's delivery signature. interactionId stamping +
     * debug-trace recording ride the optional hooks (cloud-only until S4).
     */
    private async flushSessionModal(connectionId?: string, key?: string): Promise<void> {
        const source = this.opts.sources?.sessionModalState;
        if (!source) return;
        for (const entry of this.collectPushEntries('session.modal', connectionId, key)) {
            const params = entry.params as unknown as SessionModalSubscriptionParams;
            const sessionId = params.targetSessionId;
            const state = source(sessionId);
            if (!state) continue;
            const now = this.now();
            const activeModal = state.activeModal;
            const status = String(state.status || 'idle');
            const title = typeof state.title === 'string' ? state.title : undefined;
            const interactionId = this.opts.interactionId?.(sessionId);
            const prepared = prepareSessionModalUpdate({
                key: entry.key,
                sessionId,
                status,
                title,
                activeModal,
                seq: entry.seq,
                timestamp: now,
                ...(interactionId ? { interactionId } : {}),
                lastDeliveredSignature: entry.lastDeliveredSignature,
            });
            entry.seq = prepared.seq;
            entry.lastDeliveredSignature = prepared.lastDeliveredSignature;
            entry.lastFlushedAt = now;
            if (!prepared.update) continue;
            entry.lastSentAt = now;
            this.opts.recordTrace?.({
                interactionId,
                category: 'topic',
                stage: 'session.modal_published',
                level: 'info',
                sessionId,
                payload: {
                    status,
                    hasTitle: !!prepared.update.title,
                    modalMessage: prepared.update.modalMessage ? prepared.update.modalMessage.slice(0, 140) : undefined,
                    modalButtonCount: prepared.update.modalButtons?.length || 0,
                },
            });
            this.sink.send(entry.connectionId, 'session.modal', prepared.update);
        }
    }

    /**
     * daemon.metadata engine — the ONE dashboard state lane (audit P0-3).
     *
     * No throttle (union decision #6): every pass builds the body, but what a
     * subscription RECEIVES is keyed: its first frame is a `snapshot`, later
     * frames are the {@link DaemonMetadataDelta} against the digest of the
     * last frame delivered to it, and an unchanged body sends nothing and
     * bumps no seq. A failed send clears the baseline so the next frame is a
     * snapshot again — a gap can never be papered over by a later delta.
     *
     * The body depends on exactly ONE input, `includeSessions`, so a pass
     * builds (and digests) at most one body per cohort, lazily; S dashboards
     * watching the same daemon share it. Envelope fields stay per entry.
     */
    private async flushDaemonMetadata(connectionId?: string, key?: string): Promise<void> {
        const source = this.opts.sources?.daemonMetadataBody;
        if (!source) return;
        const entries = this.collectPushEntries('daemon.metadata', connectionId, key);
        if (entries.length === 0) return;
        const bodies = new Map<boolean, DaemonMetadataUpdateBody>();
        const cohorts = new Map<string, { body: DaemonMetadataUpdateBody; digest: KeyedDocDigest }>();
        const cohortFor = (includeSessions: boolean, scope: DaemonMetadataScope | null) => {
            const cohortKey = `${includeSessions ? 1 : 0}|${scope?.key ?? ''}`;
            const cached = cohorts.get(cohortKey);
            if (cached) return cached;
            // A NORMALIZED params object keeps the shared body a pure function
            // of the cohort key (a new params field must widen the key here).
            let full = bodies.get(includeSessions);
            if (!full) {
                full = source({ includeSessions });
                bodies.set(includeSessions, full);
            }
            const body = scope ? scope.project(full) : full;
            const built = { body, digest: digestKeyedDoc(body as unknown as Record<string, unknown>, DAEMON_METADATA_DOC_SPEC) };
            cohorts.set(cohortKey, built);
            return built;
        };
        for (const entry of entries) {
            const scope = this.opts.metadataScope?.(entry.connectionId) ?? null;
            const { body, digest } = cohortFor((entry.params as DaemonMetadataSubscriptionParams | undefined)?.includeSessions === true, scope);
            this.deliverKeyed(entry, 'daemon.metadata', digest, DAEMON_METADATA_DOC_SPEC, {
                snapshot: (seq, timestamp): DaemonMetadataUpdate => ({ topic: 'daemon.metadata', key: entry.key, mode: 'snapshot', wireVersion: DASHBOARD_WIRE_VERSION, ...body, seq, timestamp }),
                delta: (delta, seq, timestamp): DaemonMetadataDelta => ({ topic: 'daemon.metadata', key: entry.key, mode: 'delta', daemonId: body.daemonId, delta, seq, timestamp }),
            });
        }
    }

    /**
     * THE keyed delivery step for both keyed lanes (daemon.metadata /
     * mesh.status — one engine, mesh-shared keyed-doc-delta.ts): a subscription
     * with no delivered baseline gets a snapshot, a baselined one the delta
     * against it — or nothing when nothing it can observe changed (no seq bump).
     * A failed send clears the baseline, so a gap is never papered over by a
     * later delta.
     */
    private deliverKeyed<T extends 'daemon.metadata' | 'mesh.status'>(
        entry: PushTopicEntry,
        topic: T,
        digest: KeyedDocDigest,
        spec: KeyedDocSpec,
        frame: {
            snapshot: (seq: number, timestamp: number) => TopicUpdateEnvelope;
            delta: (delta: KeyedDocDelta, seq: number, timestamp: number) => TopicUpdateEnvelope;
        },
    ): void {
        const now = this.now();
        entry.lastFlushedAt = now;
        let update: TopicUpdateEnvelope;
        if (!entry.keyedBaseline) {
            update = frame.snapshot(entry.seq + 1, now);
        } else {
            const delta = diffKeyedDoc(entry.keyedBaseline, digest, spec);
            if (!delta) return;
            update = frame.delta(delta, entry.seq + 1, now);
        }
        entry.seq += 1;
        entry.lastSentAt = now;
        const delivered = this.sink.send(entry.connectionId, topic, update);
        entry.keyedBaseline = delivered === false ? null : digest;
    }

    /**
     * mesh.status: flush every subscriber of `meshId` (or of every mesh). The
     * source runs at most once per mesh per pass; a request that arrives while
     * that mesh is being built runs ONE more pass after it (never overlapping).
     */
    async flushMeshStatus(meshId?: string): Promise<void> {
        const entries = this.collectPushEntries('mesh.status')
            .filter((entry) => !meshId || entry.params.meshId === meshId);
        await this.flushMeshStatusEntries(entries);
    }

    /** Subscribed mesh ids (the host's triggers are scoped to them). */
    meshStatusMeshIds(): string[] {
        const ids = new Set<string>();
        for (const subs of this.pushSubscriptions.get('mesh.status')?.values() ?? []) {
            for (const entry of subs.values()) ids.add(String(entry.params.meshId));
        }
        return [...ids];
    }

    private async flushMeshStatusEntries(entries: PushTopicEntry[]): Promise<void> {
        const source = this.opts.sources?.meshStatus;
        if (!source || entries.length === 0) return;
        const byMesh = new Set<string>();
        for (const entry of entries) {
            const meshId = String(entry.params.meshId || '');
            if (meshId) byMesh.add(meshId);
        }
        await Promise.all([...byMesh.keys()].map((meshId) => this.flushOneMesh(meshId, source)));
    }

    private async flushOneMesh(meshId: string, source: (meshId: string) => Promise<Record<string, unknown> | null>): Promise<void> {
        const inflight = this.meshFlushInflight.get(meshId);
        if (inflight) {
            this.meshFlushAgain.add(meshId);
            return inflight;
        }
        const run = (async () => {
            do {
                this.meshFlushAgain.delete(meshId);
                let status: Record<string, unknown> | null = null;
                try {
                    status = await source(meshId);
                } catch (error) {
                    this.opts.onFlushError?.('mesh.status', error, { connectionId: '', key: '', detail: meshId });
                }
                if (!status) return;
                const digest = digestKeyedDoc(status, MESH_STATUS_DOC_SPEC);
                // Every live subscriber of this mesh is served from this one build (a
                // subscriber that joined meanwhile gets its snapshot; a baselined one
                // its delta, or nothing when its view is unchanged).
                for (const entry of this.collectPushEntries('mesh.status')) {
                    if (entry.params.meshId === meshId) this.deliverMeshStatus(entry, meshId, status, digest);
                }
            } while (this.meshFlushAgain.has(meshId));
        })().finally(() => {
            this.meshFlushInflight.delete(meshId);
        });
        this.meshFlushInflight.set(meshId, run);
        return run;
    }

    private deliverMeshStatus(entry: PushTopicEntry, meshId: string, status: Record<string, unknown>, digest: KeyedDocDigest): void {
        this.deliverKeyed(entry, 'mesh.status', digest, MESH_STATUS_DOC_SPEC, {
            snapshot: (seq, timestamp): MeshStatusSnapshotUpdate => ({ topic: 'mesh.status', key: entry.key, mode: 'snapshot', wireVersion: DASHBOARD_WIRE_VERSION, meshId, status, seq, timestamp }),
            delta: (delta, seq, timestamp): MeshStatusDeltaUpdate => ({ topic: 'mesh.status', key: entry.key, mode: 'delta', meshId, delta, seq, timestamp }),
        });
    }

    /**
     * workspace.git engine — runs git only while a subscription watches the
     * workspace: on subscribe, on an invalidation (unthrottled), and on the
     * host's sample tick (throttled by the subscription's intervalMs). Delivery is
     * the monitor listener's job ({@link deliverWorkspaceGitUpdate}), so a
     * refresh from any cause reaches every subscriber of that workspace once
     * and only when its content changed.
     */
    private async flushWorkspaceGit(connectionId?: string, key?: string, force = false): Promise<void> {
        const now = this.now();
        const tasks: WorkspaceGitSubscriptionEntry[] = [];
        // One git run per (workspace, includeDiffSummary) per pass.
        const seen = new Set<string>();
        for (const [connId, subs] of Array.from(this.gitSubscriptions.entries())) {
            if (connectionId && connId !== connectionId) continue;
            if (!this.sink.isAlive(connId)) {
                // Connection is gone for good — lazy prune (cloud peers have no
                // per-peer close hook that reaches the registry).
                this.dropConnection(connId);
                continue;
            }
            if (!this.sink.isDeliverable(connId)) continue;
            for (const entry of subs.values()) {
                if (key !== undefined && entry.key !== key) continue;
                const intervalMs = Math.max(1, Number(entry.params.intervalMs || 0));
                if (!force && entry.lastFlushedAt > 0 && (now - entry.lastFlushedAt) < intervalMs) continue;
                entry.lastFlushedAt = now;
                const runKey = `${entry.params.includeDiffSummary ? 1 : 0}:${entry.params.workspace}`;
                if (seen.has(runKey)) continue;
                seen.add(runKey);
                tasks.push(entry);
            }
        }
        if (tasks.length === 0) return;
        await runAsyncBatch(tasks, async (entry) => {
            try {
                await entry.subscription.refresh();
            } catch (error) {
                this.opts.onFlushError?.('workspace.git', error, {
                    connectionId: entry.connectionId,
                    key: entry.key,
                    detail: entry.params.workspace,
                });
            }
        }, { concurrency: this.gitRefreshConcurrency });
    }

    /** Push one monitor update to every subscriber of its workspace whose content differs. */
    private deliverWorkspaceGitUpdate(update: GitWorkspaceUpdate): void {
        const signature = workspaceGitSignature(update);
        const statusSignature = workspaceGitSignature({ status: update.status });
        for (const [connId, subs] of Array.from(this.gitSubscriptions.entries())) {
            if (!this.sink.isDeliverable(connId)) continue;
            for (const entry of subs.values()) {
                if (entry.params.workspace !== update.workspace) continue;
                if (entry.params.includeDiffSummary && update.diffSummary === undefined) {
                    // A status-only refresh (turn end, send_chat) must not wipe
                    // this subscriber's diff: if the status moved, re-run with
                    // the diff; the result comes back through this listener.
                    if (statusSignature !== entry.lastStatusSignature) {
                        void entry.subscription.refresh().catch((error) => {
                            this.opts.onFlushError?.('workspace.git', error, {
                                connectionId: entry.connectionId,
                                key: entry.key,
                                detail: entry.params.workspace,
                            });
                        });
                    }
                    continue;
                }
                const wanted = entry.params.includeDiffSummary ? signature : statusSignature;
                if (wanted === entry.lastSignature) continue;
                entry.seq += 1;
                entry.lastSentAt = update.timestamp;
                const delivered = this.sink.send(entry.connectionId, 'workspace.git', {
                    ...update,
                    ...(entry.params.includeDiffSummary ? {} : { diffSummary: undefined }),
                    key: entry.key,
                    seq: entry.seq,
                });
                entry.lastSignature = delivered === false ? '' : wanted;
                entry.lastStatusSignature = delivered === false ? '' : statusSignature;
            }
        }
    }
}
