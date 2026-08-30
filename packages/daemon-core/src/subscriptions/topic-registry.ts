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
 * | session.chat_tail        | adhdev-daemon.ts:457 (build) + :601 (flush coalescing);    | index.ts:1851 (build), :2061 (flush coalescing),                | event debounce (cloud 700ms, standalone| per-subscription via                             | lastDeliveredSignature via            |
 * |                          | daemon-p2p/index.ts:422 (fan-out, concurrency 4)           | concurrency 4 (:2129), hot-session classification               | markWsChatOutputActivity debounce) +   | prepareSessionChatTailUpdate (core)              | prepareSessionChatTailUpdate (core)   |
 * |                          |                                                            |                                                                 | 2.5s cloud interval / status-driven    |                                                  | + missing-session backoff (core)      |
 * | machine.runtime          | adhdev-daemon.ts:633                                       | index.ts:2143                                                   | intervalMs (min 5s, default 15s)      | per-subscription `seq += 1`                      | none (throttle only)                  |
 * | session_host.diagnostics | adhdev-daemon.ts:663                                       | index.ts:2180                                                   | intervalMs (min 5s, default 10s)      | per-subscription `seq += 1`                      | none (throttle only)                  |
 * | session.modal            | adhdev-daemon.ts:713 (interactionId + debug trace)         | index.ts:2230 (no interactionId)                                | none (event/status driven)            | per-subscription via prepareSessionModalUpdate    | lastDeliveredSignature (core helper)  |
 * | daemon.metadata          | adhdev-daemon.ts:783                                       | index.ts:2273                                                   | none (always builds)                  | per-subscription `seq += 1`                      | none                                  |
 * | workspace.git            | adhdev-daemon.ts:838 (build, per-sub seq, NO concurrency   | index.ts:2330 (flush, concurrency 2 via runAsyncBatch,          | intervalMs (min 1s, default 5s via    | cloud: per-subscription `seq += 1`;              | none (throttle only)                  |
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
 *    but is NOT used by workspace.git — cloud stamps interactionId only on
 *    session.chat_tail / session.modal, which migrated in S3.
 *
 * ── Union decisions applied for the S3 cohorts (daemon.metadata → session.modal
 *    → session.chat_tail → machine.runtime → session_host.diagnostics) ──
 * 5. chat_tail flush debounce: NOT unified — exposed as a per-daemon injected
 *    option ({@link ChatTailEngineOptions.flushDebounceMs}). Both daemons
 *    measured at 700ms on 2026-08-24 (cloud CHAT_OUTPUT_FLUSH_DEBOUNCE_MS,
 *    standalone CHAT_OUTPUT_FLUSH_DEBOUNCE_MS), but each daemon keeps supplying
 *    its own constant so the values can diverge again without touching core.
 * 6. daemon.metadata stays throttle-free (both daemons always built + sent on
 *    every flush pass; seq/lastSentAt bookkeeping only).
 * 7. interactionId stamping + debug-trace recording on session.chat_tail /
 *    session.modal are hooks ({@link TopicEngineOptions.interactionId} /
 *    {@link TopicEngineOptions.recordTrace}): cloud passes its subsystems and
 *    stays byte-identical; standalone passes none in S3 and gains both in S4.
 * 8. session.modal subscribe validation = cloud semantics (trimmed non-empty
 *    targetSessionId); standalone only rejected falsy ids — whitespace-only ids
 *    are now rejected for both (no dashboard sends those).
 * 9. session.chat_tail is a HYBRID cohort: per-subscription BUILD engine
 *    (read → missing-session backoff bookkeeping → prepare → seq/cursor/
 *    signature mutation → hooks) and the output-activity debounce live here,
 *    but subscription STORAGE and flush fan-out (runAsyncBatch concurrency 4,
 *    hot-session classification, coalescing of overlapping flushes, the D8
 *    guaranteed-delivery ACK gate) stay daemon-side as transport/flush-policy
 *    mechanics — cloud keeps peer.chatSubscriptions, standalone keeps
 *    wsSubscriptions. `subscribe()` therefore still returns false for
 *    session.chat_tail.
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
    DaemonMetadataSubscriptionParams,
    DaemonMetadataUpdate,
    MachineInfo,
    MachineRuntimeSubscriptionParams,
    SessionChatTailSubscriptionParams,
    SessionChatTailUpdate,
    SessionHostDiagnosticsSnapshot,
    SessionHostDiagnosticsSubscriptionParams,
    SessionModalSubscriptionParams,
    SubscribeRequest,
    TransportTopic,
    UnsubscribeRequest,
} from '../shared-types.js';
import type { TopicUpdateEnvelope } from '../shared-types.js';
import type { GitWorkspaceSubscription, GitWorkspaceMonitor, NormalizedWorkspaceGitSubscriptionParams } from '../git/git-monitor.js';
import { createGitWorkspaceMonitor } from '../git/git-monitor.js';
import type { WorkspaceGitSubscriptionParams } from '../git/git-types.js';
import { runAsyncBatch } from '../chat/async-batch.js';
import {
    prepareSessionChatTailUpdate,
    prepareSessionModalUpdate,
    type ChatTailSubscriptionCursor,
    type SessionChatTailCommandResult,
} from '../chat/subscription-updates.js';
import {
    isMissingLiveSessionResult,
    recordMissingSessionAttempt,
    shouldWarnForMissingSession,
    type ChatTailMissingSessionState,
} from '../chat/chat-tail-missing-session-backoff.js';
import { buildMachineInfo } from '../status/snapshot.js';
import { DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS } from '../status/chat-tail-hot-sessions.js';
import {
    DEFAULT_MACHINE_RUNTIME_SUBSCRIPTION_INTERVAL_MS,
    DEFAULT_SESSION_HOST_DIAGNOSTICS_SUBSCRIPTION_INTERVAL_MS,
    MIN_MACHINE_RUNTIME_SUBSCRIPTION_INTERVAL_MS,
    MIN_SESSION_HOST_DIAGNOSTICS_SUBSCRIPTION_INTERVAL_MS,
} from '../runtime-defaults.js';
import type { SessionModalState } from '../providers/provider-instance.js';
import type { DebugTraceEvent } from '../logging/debug-trace.js';
import { markTranscriptPtyOutputActivity } from '../seqscribe/transcript-publisher.js';

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
 * Default chat-tail output-activity flush debounce. Both daemons measured at
 * 700ms pre-extraction, but the value is deliberately per-daemon injectable
 * (S3 union decision #5) — this default only backs tests / omitted config.
 */
export const DEFAULT_CHAT_TAIL_FLUSH_DEBOUNCE_MS = 700;

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
     * session.chat_tail read. `tailLimit` is present only when > 0, so the
     * daemon can compose byte-identical read_chat args. Cloud routes through
     * router.execute('read_chat', …, 'p2p'); standalone through its
     * executeCommand (which also runs the invalidation gate — preserved).
     */
    readChatTail?: (args: { targetSessionId: string; historySessionId?: string; tailLimit?: number }) =>
        Promise<SessionChatTailCommandResult | null | undefined>;
}

export type DaemonMetadataUpdateBody = Omit<DaemonMetadataUpdate, 'topic' | 'key' | 'seq' | 'timestamp'>;

/**
 * chat_tail engine wiring (hybrid cohort — see union decision #9 in the
 * header). The debounce/activity engine and the per-subscription build engine
 * live in the registry; the daemon injects transport gates + policy hooks.
 */
export interface ChatTailEngineOptions {
    /** Output-activity flush debounce — per-daemon constant (union decision #5). */
    flushDebounceMs?: number;
    /** Activity hot window. Default {@link DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS} (both daemons). */
    activityHotMs?: number;
    /** Only CLI sessions mark output activity (both daemons). */
    isCliSession?: (sessionId: string) => boolean;
    /**
     * Transport gate checked before arming the debounce timer (cloud:
     * p2p connected && has chat subscriptions; standalone: clients present).
     */
    scheduleGate?: () => boolean;
    /** Debounced flush trigger — the daemon's own onlyActive flush wrapper. */
    onDebouncedFlush?: () => void;
    /**
     * Missing-live-session bookkeeping hook — the engine records the backoff
     * state; the daemon owns the log line wording. `warnNow` is true exactly
     * once per miss streak.
     */
    onMissingSession?: (ctx: { sessionId: string; consecutiveMisses: number; warnNow: boolean }) => void;
    /**
     * Post-prepare hook, fired BEFORE the null-update check (standalone's D8
     * guaranteed-delivery gate records the flushed tail signature here even
     * when the update deduped to null). Cloud passes none.
     */
    onPrepared?: (ctx: {
        sessionId: string;
        lastDeliveredSignature: string;
        update: SessionChatTailUpdate | null;
        result: unknown;
    }) => void;
}

export interface TopicEngineOptions {
    /**
     * Debug-trace correlation id provider (cloud's interactionId subsystem).
     * Consumed by the session.chat_tail / session.modal engines; workspace.git
     * does not stamp it. Standalone gains a provider in S4.
     */
    interactionId?: (sessionId?: string) => string | undefined;
    /**
     * Debug-trace sink for the chat_tail/modal publish stages (cloud passes
     * recordDebugTrace; standalone gains it in S4).
     */
    recordTrace?: (event: DebugTraceEvent) => void;
    /** Daemon-injected payload sources for the push-style topic engines. */
    sources?: TopicEngineSources;
    /** chat_tail hybrid-engine wiring. */
    chatTail?: ChatTailEngineOptions;
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

/** Mutable per-subscription chat_tail engine state (storage stays daemon-side — union decision #9). */
export interface ChatTailEngineState {
    seq: number;
    cursor: ChatTailSubscriptionCursor;
    lastDeliveredSignature: string;
    missingSession?: ChatTailMissingSessionState;
}

interface WorkspaceGitSubscriptionEntry {
    readonly connectionId: string;
    readonly key: string;
    params: NormalizedWorkspaceGitSubscriptionParams;
    subscription: GitWorkspaceSubscription;
    seq: number;
    lastSentAt: number;
}

/** Registry-stored push-style topics (subscription storage owned here). */
type PushTopic = 'machine.runtime' | 'session_host.diagnostics' | 'session.modal' | 'daemon.metadata';

const PUSH_TOPICS: ReadonlyArray<PushTopic> = ['machine.runtime', 'session_host.diagnostics', 'session.modal', 'daemon.metadata'];

interface PushTopicEntry {
    readonly connectionId: string;
    readonly key: string;
    params: Record<string, unknown>;
    seq: number;
    lastSentAt: number;
    lastDeliveredSignature: string;
}

/**
 * Topics whose engine has migrated into the registry (S3 complete: all five
 * remaining cohorts). session.chat_tail is deliberately absent — its
 * subscription STORAGE stays daemon-side (hybrid cohort, union decision #9),
 * so `subscribe`/`unsubscribe` return false and daemons keep their transport
 * storage while consuming the registry's build/debounce engine.
 */
const MIGRATED_TOPICS: ReadonlySet<TransportTopic> = new Set<TransportTopic>([
    'workspace.git',
    ...PUSH_TOPICS,
]);

/**
 * Topics the registry flushes when {@link TopicSubscriptionRegistry.invalidate}
 * consumes a commandInvalidations set (machine.runtime is never in the
 * invalidation table; chat_tail is not invalidation-driven in either daemon).
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
    /** chat_tail output-activity engine state (sessionId → last output at). */
    private readonly chatOutputActiveAt = new Map<string, number>();
    private chatOutputFlushTimer: NodeJS.Timeout | null = null;

    constructor(sink: TopicSink, opts: TopicEngineOptions = {}) {
        this.sink = sink;
        this.opts = opts;
        this.now = opts.now ?? Date.now;
        this.gitMonitor = opts.gitMonitor ?? createGitWorkspaceMonitor();
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
     * Returns false when the topic is not registry-stored (chat_tail /
     * runtime_output stay daemon-side) or params are invalid, so callers can
     * fall through to their local engine / ignore.
     */
    subscribe(connectionId: string, request: SubscribeRequest): boolean {
        if (!request.key) return false;
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
            lastDeliveredSignature: '',
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
     * Consume a {@link commandInvalidations} result: run a flush pass for each
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
            await this.flushNow(topic);
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
     * Run one flush pass now (optionally scoped to a single connection, e.g.
     * the targeted first flush right after subscribe). The per-subscription
     * interval throttle still applies — identical to both daemons' historic
     * flush functions.
     */
    async flushNow(topic: TransportTopic, connectionId?: string): Promise<void> {
        switch (topic) {
            case 'workspace.git': return this.flushWorkspaceGit(connectionId);
            case 'machine.runtime': return this.flushMachineRuntime(connectionId);
            case 'session_host.diagnostics': return this.flushSessionHostDiagnostics(connectionId);
            case 'session.modal': return this.flushSessionModal(connectionId);
            case 'daemon.metadata': return this.flushDaemonMetadata(connectionId);
            default: return;
        }
    }

    /**
     * Deliverable push-topic entries for one flush pass. Dead connections are
     * lazily pruned (cloud peers have no per-peer close hook that reaches the
     * registry); alive-but-undeliverable connections are skipped, not dropped.
     */
    private collectPushEntries(topic: PushTopic, connectionId?: string): PushTopicEntry[] {
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
            for (const entry of subs.values()) entries.push(entry);
        }
        return entries;
    }

    /**
     * machine.runtime engine — interval throttle (min 5s / default 15s) +
     * per-subscription monotonic seq. Identical pre-extraction in cloud
     * (buildMachineRuntimeUpdateForSubscription) and standalone
     * (buildMachineRuntimeUpdate).
     */
    private async flushMachineRuntime(connectionId?: string): Promise<void> {
        const source = this.opts.sources?.machineInfo ?? (() => buildMachineInfo('full'));
        for (const entry of this.collectPushEntries('machine.runtime', connectionId)) {
            const params = entry.params as MachineRuntimeSubscriptionParams;
            const intervalMs = Math.max(
                MIN_MACHINE_RUNTIME_SUBSCRIPTION_INTERVAL_MS,
                Number(params.intervalMs || DEFAULT_MACHINE_RUNTIME_SUBSCRIPTION_INTERVAL_MS),
            );
            const now = this.now();
            if (entry.lastSentAt > 0 && (now - entry.lastSentAt) < intervalMs) continue;
            entry.seq += 1;
            entry.lastSentAt = now;
            this.sink.send(entry.connectionId, 'machine.runtime', {
                topic: 'machine.runtime',
                key: entry.key,
                machine: source(),
                seq: entry.seq,
                timestamp: now,
            });
        }
    }

    /**
     * session_host.diagnostics engine — interval throttle (min 5s / default
     * 10s); a null source result (controller unavailable) skips WITHOUT
     * mutating state. seq/lastSentAt advance only after the diagnostics
     * snapshot resolves (both daemons awaited before bumping).
     */
    private async flushSessionHostDiagnostics(connectionId?: string): Promise<void> {
        const source = this.opts.sources?.sessionHostDiagnostics;
        if (!source) return;
        for (const entry of this.collectPushEntries('session_host.diagnostics', connectionId)) {
            const params = entry.params as SessionHostDiagnosticsSubscriptionParams;
            const intervalMs = Math.max(
                MIN_SESSION_HOST_DIAGNOSTICS_SUBSCRIPTION_INTERVAL_MS,
                Number(params.intervalMs || DEFAULT_SESSION_HOST_DIAGNOSTICS_SUBSCRIPTION_INTERVAL_MS),
            );
            const now = this.now();
            if (entry.lastSentAt > 0 && (now - entry.lastSentAt) < intervalMs) continue;
            const pending = source({
                includeSessions: params.includeSessions !== false,
                limit: Number(params.limit) || undefined,
            });
            if (!pending) continue;
            const diagnostics = await pending;
            entry.seq += 1;
            entry.lastSentAt = now;
            // Standalone re-checked ws OPEN after the await; cloud's send is a
            // no-op on a disconnected peer — the recheck is safe for both.
            if (!this.sink.isDeliverable(entry.connectionId)) continue;
            this.sink.send(entry.connectionId, 'session_host.diagnostics', {
                topic: 'session_host.diagnostics',
                key: entry.key,
                diagnostics,
                seq: entry.seq,
                timestamp: now,
            });
        }
    }

    /**
     * session.modal engine — event-driven (no interval throttle), deduped via
     * prepareSessionModalUpdate's delivery signature. interactionId stamping +
     * debug-trace recording ride the optional hooks (cloud-only until S4).
     */
    private async flushSessionModal(connectionId?: string): Promise<void> {
        const source = this.opts.sources?.sessionModalState;
        if (!source) return;
        for (const entry of this.collectPushEntries('session.modal', connectionId)) {
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
     * daemon.metadata engine — no throttle (always builds + sends; union
     * decision #6), per-subscription monotonic seq. The daemon-specific body
     * (daemonId prefix, mesh-owned session append, meshStateRevisions/userName)
     * comes from the injected source.
     */
    private async flushDaemonMetadata(connectionId?: string): Promise<void> {
        const source = this.opts.sources?.daemonMetadataBody;
        if (!source) return;
        for (const entry of this.collectPushEntries('daemon.metadata', connectionId)) {
            const now = this.now();
            entry.seq += 1;
            entry.lastSentAt = now;
            const body = source(entry.params as DaemonMetadataSubscriptionParams);
            this.sink.send(entry.connectionId, 'daemon.metadata', {
                topic: 'daemon.metadata',
                key: entry.key,
                ...body,
                seq: entry.seq,
                timestamp: now,
            });
        }
    }

    // ─── session.chat_tail hybrid engine (storage + fan-out stay daemon-side) ───

    /**
     * Record CLI chat output activity and arm the debounced onlyActive flush.
     * Engine-owned copy of cloud markP2PChatOutputActivity / standalone
     * markWsChatOutputActivity — the debounce constant and transport gate are
     * per-daemon injected (union decision #5).
     */
    markChatOutputActivity(sessionId: string): void {
        const cfg = this.opts.chatTail;
        if (!sessionId || !(cfg?.isCliSession?.(sessionId) ?? false)) return;
        // §8 unit 2 dirty trigger (design §5.2): "no-subscriber 상태에서도 live
        // production이 멈추지 않게 기존 markChatOutputActivity ... 가
        // TranscriptProjectionService.markDirty(sessionId)를 호출한다." Safe
        // no-op until a later unit configures a service — see
        // seqscribe/transcript-publisher.ts's header.
        markTranscriptPtyOutputActivity(sessionId);
        this.chatOutputActiveAt.set(sessionId, this.now());
        if (this.chatOutputFlushTimer) return;
        if (cfg?.scheduleGate && !cfg.scheduleGate()) return;
        this.chatOutputFlushTimer = setTimeout(() => {
            this.chatOutputFlushTimer = null;
            cfg?.onDebouncedFlush?.();
        }, cfg?.flushDebounceMs ?? DEFAULT_CHAT_TAIL_FLUSH_DEBOUNCE_MS);
    }

    /**
     * Sessions with CLI output inside the activity hot window (default 8s —
     * DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS in both daemons). Prunes
     * expired entries, identical to both daemons' local copies. Consumed by
     * the daemon-side hot-session classification.
     */
    getRecentlyOutputActiveChatSessionIds(now: number): Set<string> {
        const hotMs = this.opts.chatTail?.activityHotMs ?? DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS;
        const active = new Set<string>();
        for (const [sessionId, lastOutputAt] of this.chatOutputActiveAt) {
            if (now - lastOutputAt <= hotMs) {
                active.add(sessionId);
            } else {
                this.chatOutputActiveAt.delete(sessionId);
            }
        }
        return active;
    }

    /**
     * Per-subscription chat_tail build engine: read (daemon source) →
     * missing-session backoff bookkeeping → prepare (seq/dedup) →
     * cursor/seq/signature mutation → hooks. The caller (daemon fan-out) sends
     * the returned update over its own transport.
     */
    async buildChatTailUpdate(input: {
        key: string;
        params: SessionChatTailSubscriptionParams;
        state: ChatTailEngineState;
    }): Promise<SessionChatTailUpdate | null> {
        const read = this.opts.sources?.readChatTail;
        if (!read) return null;
        const { key, params, state } = input;
        const result = await read({
            targetSessionId: params.targetSessionId,
            ...(params.historySessionId ? { historySessionId: params.historySessionId } : {}),
            ...(state.cursor.tailLimit > 0 ? { tailLimit: state.cursor.tailLimit } : {}),
        });

        // The session vanished from the live registry (stopped agent, reclaimed
        // mesh worker). The subscription itself survives — only an explicit
        // client unsubscribe removes one — so record the miss and let the
        // daemon flush loop's backoff pace (and eventually drop) it. Publishing
        // nothing here is deliberate: the pane keeps its last rendered
        // transcript rather than being blanked by a transient miss.
        if (isMissingLiveSessionResult(result)) {
            const now = this.now();
            const missing = recordMissingSessionAttempt(state.missingSession, now);
            state.missingSession = missing;
            // One warn per streak — the daemon owns the log line wording.
            const warnNow = shouldWarnForMissingSession(missing);
            if (warnNow) missing.warned = true;
            this.opts.chatTail?.onMissingSession?.({
                sessionId: params.targetSessionId,
                consecutiveMisses: missing.consecutiveMisses,
                warnNow,
            });
            return null;
        }
        // A successful read clears the streak so a session that recovers (or
        // was merely slow to attach) returns to the normal flush cadence.
        if (state.missingSession) state.missingSession = undefined;
        const interactionId = this.opts.interactionId?.(params.targetSessionId);
        const prepared = prepareSessionChatTailUpdate({
            key,
            sessionId: params.targetSessionId,
            ...(params.historySessionId ? { historySessionId: params.historySessionId } : {}),
            seq: state.seq,
            timestamp: this.now(),
            ...(interactionId ? { interactionId } : {}),
            cursor: state.cursor,
            lastDeliveredSignature: state.lastDeliveredSignature,
            result: result as SessionChatTailCommandResult,
        });
        state.cursor = prepared.cursor;
        state.seq = prepared.seq;
        state.lastDeliveredSignature = prepared.lastDeliveredSignature;
        // D8 hook fires BEFORE the null-update check: standalone records the
        // flushed tail signature even when the update deduped to null.
        this.opts.chatTail?.onPrepared?.({
            sessionId: params.targetSessionId,
            lastDeliveredSignature: prepared.lastDeliveredSignature,
            update: prepared.update,
            result,
        });
        if (!prepared.update) {
            return null;
        }
        this.opts.recordTrace?.({
            interactionId,
            category: 'topic',
            stage: 'session.chat_tail_published',
            level: 'info',
            sessionId: params.targetSessionId,
            payload: {
                returnedMessages: prepared.update.messages.length,
                hasModal: !!prepared.update.activeModal,
                hasTitle: typeof prepared.update.title === 'string',
            },
        });
        return prepared.update;
    }

    private async flushWorkspaceGit(connectionId?: string): Promise<void> {
        const now = this.now();
        const tasks: WorkspaceGitSubscriptionEntry[] = [];
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
                const intervalMs = Math.max(1, Number(entry.params.intervalMs || 0));
                if (entry.lastSentAt > 0 && (now - entry.lastSentAt) < intervalMs) continue;
                tasks.push(entry);
            }
        }
        if (tasks.length === 0) return;
        await runAsyncBatch(tasks, async (entry) => {
            try {
                const monitorUpdate = await entry.subscription.refresh();
                const current = this.gitSubscriptions.get(entry.connectionId)?.get(entry.key);
                if (current !== entry || !this.sink.isDeliverable(entry.connectionId)) return;
                entry.seq += 1;
                entry.lastSentAt = monitorUpdate.timestamp;
                this.sink.send(entry.connectionId, 'workspace.git', {
                    ...monitorUpdate,
                    key: entry.key,
                    seq: entry.seq,
                });
            } catch (error) {
                this.opts.onFlushError?.('workspace.git', error, {
                    connectionId: entry.connectionId,
                    key: entry.key,
                    detail: entry.params.workspace,
                });
            }
        }, { concurrency: this.gitRefreshConcurrency });
    }
}
