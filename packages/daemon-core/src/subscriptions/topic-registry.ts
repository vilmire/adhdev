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
 *    session.chat_tail / session.modal, which migrate in S3.
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

import type { SubscribeRequest, TransportTopic, UnsubscribeRequest } from '../shared-types.js';
import type { TopicUpdateEnvelope } from '../shared-types.js';
import type { GitWorkspaceSubscription, GitWorkspaceMonitor, NormalizedWorkspaceGitSubscriptionParams } from '../git/git-monitor.js';
import { createGitWorkspaceMonitor } from '../git/git-monitor.js';
import type { WorkspaceGitSubscriptionParams } from '../git/git-types.js';
import { runAsyncBatch } from '../chat/async-batch.js';

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

export interface TopicEngineOptions {
    /**
     * Debug-trace correlation id provider (cloud's interactionId subsystem).
     * Declared per the design; consumed by the session.chat_tail /
     * session.modal cohorts (S3) — workspace.git does not stamp it.
     */
    interactionId?: (sessionId?: string) => string | undefined;
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
}

/**
 * Topics whose engine has migrated into the registry. Cohort-gated per the
 * design (S2 = workspace.git only); grows in S3. `subscribe`/`unsubscribe`
 * return false for unmigrated topics so daemons can keep their local engines
 * until each cohort lands.
 */
const MIGRATED_TOPICS: ReadonlySet<TransportTopic> = new Set<TransportTopic>(['workspace.git']);

export class TopicSubscriptionRegistry {
    private readonly sink: TopicSink;
    private readonly opts: TopicEngineOptions;
    private readonly now: () => number;
    private readonly gitMonitor: GitWorkspaceMonitor;
    private readonly gitRefreshConcurrency: number;
    /** connectionId → key → subscription engine state. */
    private readonly gitSubscriptions = new Map<string, Map<string, WorkspaceGitSubscriptionEntry>>();

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

    /** Whether the registry owns the engine for `topic` (migrated cohort gate). */
    handlesTopic(topic: string): topic is TransportTopic {
        return MIGRATED_TOPICS.has(topic as TransportTopic);
    }

    /**
     * Register (or replace — same key resets seq/throttle, matching both
     * daemons' overwrite-on-resubscribe behavior) a subscription.
     * Returns false when the topic is not yet migrated or params are invalid,
     * so callers can fall through to their local engine / ignore.
     */
    subscribe(connectionId: string, request: SubscribeRequest): boolean {
        if (request.topic !== 'workspace.git') return false;
        const rawParams = request.params as WorkspaceGitSubscriptionParams | undefined;
        const workspace = typeof rawParams?.workspace === 'string' ? rawParams.workspace.trim() : '';
        if (!workspace || !request.key) return false;
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

    /** Returns true when the topic is registry-owned (even if no entry matched). */
    unsubscribe(connectionId: string, request: Pick<UnsubscribeRequest, 'topic' | 'key'>): boolean {
        if (request.topic !== 'workspace.git') return false;
        const subs = this.gitSubscriptions.get(connectionId);
        const entry = subs?.get(request.key);
        if (entry) {
            entry.subscription.dispose();
            subs!.delete(request.key);
            if (subs!.size === 0) this.gitSubscriptions.delete(connectionId);
        }
        return true;
    }

    /** Dispose and drop every subscription owned by a closed connection. */
    dropConnection(connectionId: string): void {
        const subs = this.gitSubscriptions.get(connectionId);
        if (!subs) return;
        for (const entry of subs.values()) entry.subscription.dispose();
        subs.clear();
        this.gitSubscriptions.delete(connectionId);
    }

    hasSubscriptions(topic: TransportTopic, connectionId?: string): boolean {
        if (topic !== 'workspace.git') return false;
        if (connectionId) return (this.gitSubscriptions.get(connectionId)?.size ?? 0) > 0;
        for (const subs of this.gitSubscriptions.values()) {
            if (subs.size > 0) return true;
        }
        return false;
    }

    /**
     * Consume a {@link commandInvalidations} result: run a flush pass for each
     * invalidated topic the registry owns. NOTE: matches both daemons' historic
     * behavior — invalidation triggers a flush PASS, it does not bypass the
     * per-subscription interval throttle.
     */
    async invalidate(topics: ReadonlySet<string>): Promise<void> {
        if (topics.has('workspace.git') && this.hasSubscriptions('workspace.git')) {
            await this.flushNow('workspace.git');
        }
    }

    /**
     * "Upstream state changed" nudge — run a throttled flush pass for a
     * migrated topic. Push-style topics gain a snapshotFn parameter when their
     * cohorts migrate (S3); the pull-based workspace.git engine refreshes from
     * its own monitor.
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
        if (topic !== 'workspace.git') return;
        await this.flushWorkspaceGit(connectionId);
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
