/**
 * `TranscriptProjectionService` — the single-observation coalescing publisher
 * (design §5.2, §8 unit 2: "single observation publisher + parity/readiness").
 *
 * ── What this unit owns, and what it does NOT ──────────────────────────────
 * This service turns a `TranscriptObservation` into a begin/chunk/commit
 * envelope set (via unit 1's `encodeTranscriptRevision`) and hands the result
 * to an INJECTED `publishRevision` sink. It never touches a live seqscribe
 * node, never defines a topic, and never runs the two-sided define/serve
 * grant/updateGrants activation handshake — wiring an encoder call to a live
 * `node.log(topic).append` is `§8 unit 3` ("dynamic transcript activation +
 * daemon replica store"), exactly as transcript-revision-codec.ts's header
 * says for the assembler half. `configureTranscriptProjection` is therefore
 * NOT called from `boot/daemon-lifecycle.ts` in this unit: there is nothing
 * true to wire it to yet. (That is no longer the state of the tree — a later
 * unit did wire it; `configureTranscriptProjection` is now called from
 * `boot/daemon-lifecycle.ts`. The call sites below are live, not inert.)
 * The call sites this unit DOES add (the choke point in
 * `commands/read-chat-presentation.ts`, the dirty trigger in
 * `subscriptions/topic-registry.ts#markChatOutputActivity`) are safe no-ops
 * while unconfigured — the same incremental pattern unit 1 used for
 * `TranscriptTopicClaimRegistry`.
 *
 * ── Coalescing (design §5.2) ────────────────────────────────────────────────
 * "publisher는 read hot path를 block하지 않는 bounded per-session queue를 쓰되,
 * enqueue 실패를 숨기지 않는다. 같은 session의 중간 observation은 coalesce하고
 * 최신 complete 상태를 발행한다." Two entry points exist:
 *
 *   - `observe(sessionId, observation)` — PUSH. Called from the read_chat
 *     last-mile choke point, which already has a full, freshly-normalized
 *     observation in hand. No re-collection needed.
 *   - `markDirty(sessionId)` — PULL trigger. Called from output-activity/
 *     status-change hooks that know a session changed but do not have a fresh
 *     observation. Requires `deps.collectObservation` to do anything; a
 *     service configured without it treats `markDirty` as a no-op (useful for
 *     unit tests that only exercise `observe`, and for exercising the choke
 *     point in isolation before a collector exists).
 *
 * Both are serialized PER SESSION through the same `inFlight`/`pendingLatest`
 * bookkeeping so the monotonic revision counter never races, and a second
 * call arriving while one is in flight replaces (never queues) the pending
 * work — "매 commit 전체 교체다. delta merge가 아니다" (§3.4) applies just as
 * much to what the publisher itself coalesces as to what a subscriber does.
 * That `inFlight` coalescing merges CONCURRENT work only. It does nothing for
 * a serial stream: a chunk arriving after the previous pull has settled starts
 * a full new pull, and each pull re-encodes the WHOLE snapshot (§3.4 — "매
 * commit 전체 교체다"), not a delta. Measured, 20 serial PTY callbacks produce
 * 20 full reparses. Do not treat `inFlight` as a burst guard; it is not one.
 *
 * PTY output therefore uses a separate leading+trailing throttle
 * (`markPtyOutputActivity`): the first byte pulls immediately, while the rest
 * of a paint burst is collapsed into at most one pull per
 * `TRANSCRIPT_PTY_DIRTY_THROTTLE_MS` window. The trailing pull is not optional
 * — a provider may append its JSONL record just after the terminal write, so
 * dropping it loses the tail of every burst. Status/finalization/post-chat
 * callers continue to use the immediate `markDirty` path, so completion and
 * approval transitions are not delayed by the throughput guard.
 *
 * ── Dedup / empty-guard / oversize (design §3.4, §7.2 item 3) ──────────────
 * See `transcript-observation.ts#hashTranscriptObservation` for why the dedup
 * hash excludes producer identity/revision/observedAt. The empty-guard and
 * oversize-fallback rules are implemented in `publishObservation` below with
 * inline comments at each branch.
 */

import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LOG } from '../logging/logger.js';
import {
    encodeTranscriptRevision,
    type TranscriptRevisionBeginV1,
    type TranscriptRevisionChunkV1,
    type TranscriptRevisionCommitV1,
    type TranscriptRevisionIdentity,
} from './transcript-revision-codec.js';
import { encodeTranscriptSnapshot } from './transcript-projection.js';
import {
    hashTranscriptObservation,
    isEmptyTranscriptObservation,
    stampTranscriptObservation,
    type TranscriptObservation,
} from './transcript-observation.js';
import { resolveTranscriptMode, type TranscriptMode } from './transcript-mode.js';
import {
    TranscriptLatencyRecorder,
    type TranscriptLatencyDetail,
    type TranscriptTriggerSource,
} from './transcript-latency.js';

/** Hard bound on distinct sessions tracked at once — mirrors MAX_INFLIGHT's
 * role in mesh-dual-write.ts: a shadow that OOMs a daemon is worse than a
 * shadow that skips sessions, and the skip is counted, never silent. */
export const MAX_TRACKED_SESSIONS = 512;

/**
 * PTY paint bursts commonly deliver one callback per small terminal chunk.
 * Keep this below the legacy 700ms chat-tail UI debounce — so the replica lane
 * is still faster than what it replaced — while leaving enough room to collapse
 * the dozens/hundreds of chunks emitted by one repaint into a single reparse.
 */
export const TRANSCRIPT_PTY_DIRTY_THROTTLE_MS = 350;

/**
 * Safety net only, NOT the latency path. Picks up transcript writes that
 * produced no PTY callback (external edits, a provider that flushes its JSONL
 * out of band). The first observed tick is discarded to establish a baseline
 * signature, so a change is seen at worst two intervals after it lands —
 * which is exactly why the PTY trigger above must stay wired.
 */
export const TRANSCRIPT_STAT_POLL_INTERVAL_MS = 3000;

export interface TranscriptRevisionEnvelope {
    readonly begin: TranscriptRevisionBeginV1;
    readonly chunks: readonly TranscriptRevisionChunkV1[];
    readonly commit: TranscriptRevisionCommitV1;
}

export interface TranscriptObservationCollectResult {
    readonly observation: TranscriptObservation;
    /**
     * True only when the caller has POSITIVELY confirmed the session is
     * cleared/terminated/new — never merely "this read returned nothing".
     * Gates the empty-guard in `publishObservation` (design §3.4: "검증된 새
     * 세션/explicit clear/termination coverage만 empty commit을 허용한다").
     */
    readonly verifiedClear?: boolean;
}

export interface TranscriptProjectionDeps {
    /** This process's seqscribe writer/daemon identity — stable for the process lifetime. */
    daemonId(): string;
    writerId(): string;
    /** Injected for tests; defaults to `new Date().toISOString()`. */
    now?(): string;
    /**
     * The producer epoch — random per service-instantiation (design §3.4:
     * "publisher service boot마다 random UUID"). Injectable for tests that need
     * a fixed value; defaults to `randomUUID()`.
     */
    epoch?: string;
    /**
     * Hand a complete begin/chunk/commit envelope set to whatever actually owns
     * the live seqscribe append (§8 unit 3). Rejecting/throwing is caught and
     * counted (`publishFailed`) — this must never propagate into the read_chat
     * hot path that triggered it.
     */
    publishRevision(sessionId: string, envelope: TranscriptRevisionEnvelope): Promise<void>;
    resolveSourcePath?: (sessionId: string) => string | null;
    /**
     * Pull a fresh observation for `markDirty`-triggered publishes. Omit to
     * make `markDirty` an inert no-op (e.g. in tests that only exercise
     * `observe`, or before a later unit wires a real collector).
     */
    collectObservation?(sessionId: string): Promise<TranscriptObservationCollectResult | null>;
    /** Called once per oversize rejection — the caller's cue to fall back the
     * whole read to legacy `read_chat`/`chat_history` (design §3.3, §7.2 item 3). */
    onOversize?(sessionId: string, chunkCount: number, snapshotBytes: number): void;
}

export interface TranscriptProjectionCounters {
    /** Complete revisions successfully handed to `publishRevision`. */
    published: number;
    /** `publishRevision` threw/rejected. */
    publishFailed: number;
    /** Stable-hash observations that produced no new revision (design §3.4). */
    deduped: number;
    /** Transient-empty observations that did NOT clobber a prior non-empty revision. */
    emptyGuarded: number;
    /** Rejected by `encodeTranscriptRevision` as `projection_oversize`. */
    oversized: number;
    /** Sessions dropped because `MAX_TRACKED_SESSIONS` was reached. */
    dropped: number;
    /** `markDirty` calls that did nothing because no `collectObservation` was configured. */
    collectorUnavailable: number;
    /** `collectObservation` returned `null` (source not ready — safety-net poll found nothing new). */
    sourcePending: number;
    /** PTY dirty triggers collapsed behind the per-session throttle window. */
    ptyDirtyCoalesced: number;
}

function freshCounters(): TranscriptProjectionCounters {
    return {
        published: 0,
        publishFailed: 0,
        deduped: 0,
        emptyGuarded: 0,
        oversized: 0,
        dropped: 0,
        collectorUnavailable: 0,
        sourcePending: 0,
        ptyDirtyCoalesced: 0,
    };
}

interface SessionState {
    revision: number;
    /** Content hash of the last successfully published complete revision. */
    hash: string;
}

function redactSessionId(id: string): string {
    return id.length <= 8 ? id : `${id.slice(0, 8)}…(${id.length})`;
}

export class TranscriptProjectionService {
    private readonly deps: TranscriptProjectionDeps;
    private readonly epoch: string;
    private readonly counters: TranscriptProjectionCounters = freshCounters();
    private readonly sessionState = new Map<string, SessionState>();

    // Per-session coalescing bookkeeping. `inFlight` gates concurrent work for
    // a session; `pendingObservation`/`pendingPull` hold "arrived while busy,
    // replace/reschedule" — never queued, always the latest wins.
    private readonly inFlight = new Set<string>();
    private readonly pendingObservation = new Map<string, TranscriptObservation>();
    private readonly pendingPull = new Set<string>();
    /**
     * Trigger attribution + stage timings for the CURRENT in-flight unit of
     * work, keyed by session. Held here rather than threaded through the
     * `runObserve`/`runPull`/`settle` signatures because `settle()` re-enters
     * that cycle for coalesced work, and the attribution must survive the
     * re-entry: a pull that was queued by `pty_output` and finally published by
     * `settle()` is still a `pty_output` refresh, and its latency is still
     * measured from when that PTY byte arrived.
     */
    private readonly triggerContext = new Map<string, { source: TranscriptTriggerSource; startedAt: number }>();
    /** Attribution for work coalesced while a session was busy — replaces, never
     * queues, matching `pendingObservation`/`pendingPull`'s latest-wins rule. */
    private readonly pendingContext = new Map<string, { source: TranscriptTriggerSource; startedAt: number }>();
    private readonly latency = new TranscriptLatencyRecorder();
    /** PTY-only leading+trailing throttle state; direct dirty triggers bypass it. */
    private readonly ptyDirtyTimers = new Map<string, NodeJS.Timeout>();
    private readonly ptyDirtyTrailing = new Set<string>();
    private readonly pollingSessions = new Set<string>();
    private readonly knownPaths = new Map<string, string>();
    private readonly lastSignatures = new Map<string, string>();
    private statPollTimer: NodeJS.Timeout | null = null;

    constructor(deps: TranscriptProjectionDeps) {
        this.deps = deps;
        this.epoch = deps.epoch ?? randomUUID();
    }

    mode(env?: NodeJS.ProcessEnv): TranscriptMode {
        return resolveTranscriptMode(env);
    }

    /** PUSH entry point — the read_chat last-mile choke point already has a full observation. */
    observe(sessionId: string, observation: TranscriptObservation): void {
        if (!sessionId) return;
        if (this.mode() === 'off') return;
        if (this.inFlight.has(sessionId)) {
            this.pendingObservation.set(sessionId, observation);
            // A nested observe() arriving during a pull is that pull's own
            // collector re-entering the choke point (see the collectObservation
            // note in boot/daemon-lifecycle.ts), so the ORIGINAL trigger context
            // must be preserved — overwriting it here would restart the clock
            // mid-measurement and report every pull-driven publish as instant.
            if (!this.pendingContext.has(sessionId) && !this.triggerContext.has(sessionId)) {
                this.pendingContext.set(sessionId, { source: 'unspecified', startedAt: this.latency.now() });
            }
            return;
        }
        if (!this.admitSession(sessionId)) return;
        this.beginTrigger(sessionId, 'unspecified');
        const sourcePath = (observation.provenance?.transcriptProvenance as any)?.sourcePath;
        if (typeof sourcePath === 'string' && sourcePath) {
            this.knownPaths.set(sessionId, sourcePath);
        }
        void this.runObserve(sessionId, observation);
    }

    /**
     * PULL trigger — output-activity/status-change hooks that lack a fresh
     * observation. `source` attributes the refresh on the latency diagnostic
     * surface; it defaults to `unspecified` so a caller that has no meaningful
     * label is counted honestly rather than being silently folded into whatever
     * source happens to be listed first.
     */
    markDirty(sessionId: string, source: TranscriptTriggerSource = 'unspecified'): void {
        if (!sessionId) return;
        if (this.mode() === 'off') return;
        this.latency.recordTriggered(source);
        if (!this.deps.collectObservation) {
            this.counters.collectorUnavailable++;
            return;
        }
        if (this.inFlight.has(sessionId)) {
            this.pendingPull.add(sessionId);
            this.latency.recordCoalesced(source);
            // Latest-wins, matching `pendingPull`'s own replace-never-queue rule:
            // the freshest trigger is the one whose latency the user is waiting
            // on. Its `startedAt` is stamped now, not carried from the older
            // pending trigger, so the sample measures this trigger's wait.
            this.pendingContext.set(sessionId, { source, startedAt: this.latency.now() });
            return;
        }
        if (!this.admitSession(sessionId)) return;
        this.beginTrigger(sessionId, source);
        this.latency.recordAdmitted(source);
        void this.runPull(sessionId);
    }

    /** Stamp the attribution + start time for a unit of work about to run. */
    private beginTrigger(sessionId: string, source: TranscriptTriggerSource): void {
        this.triggerContext.set(sessionId, { source, startedAt: this.latency.now() });
    }

    /**
     * PTY-output trigger. Pull the leading edge immediately, then collapse all
     * repaint chunks in the window into one trailing pull. The trailing pull is
     * mandatory even for a single byte because providers may append their JSONL
     * record just after writing the corresponding terminal output — without it
     * the last chunk of a burst is silently never observed.
     */
    markPtyOutputActivity(sessionId: string): void {
        if (!sessionId) return;
        if (this.mode() === 'off') return;
        if (!this.deps.collectObservation) {
            this.latency.recordTriggered('pty_output');
            this.counters.collectorUnavailable++;
            return;
        }

        if (this.ptyDirtyTimers.has(sessionId)) {
            this.ptyDirtyTrailing.add(sessionId);
            this.counters.ptyDirtyCoalesced++;
            // Counted here rather than deferring to markDirty: this call never
            // reaches markDirty, so leaving it out would under-report exactly
            // the source whose burst behaviour is the point of measuring.
            this.latency.recordTriggered('pty_output');
            this.latency.recordCoalesced('pty_output');
            return;
        }

        // Leading edge remains immediate for live transcript consumers.
        this.markDirty(sessionId, 'pty_output');
        // Always retain one trailing refresh: the native transcript write can
        // lag the first PTY byte even when the burst contains only one callback.
        this.ptyDirtyTrailing.add(sessionId);
        this.armPtyDirtyTimer(sessionId);
    }

    private armPtyDirtyTimer(sessionId: string): void {
        const timer = setTimeout(() => {
            if (!this.ptyDirtyTrailing.delete(sessionId)) {
                this.ptyDirtyTimers.delete(sessionId);
                return;
            }

            // Keep the cooldown armed before pulling so output arriving during
            // the read cannot start another leading-edge parse concurrently.
            this.ptyDirtyTimers.delete(sessionId);
            this.armPtyDirtyTimer(sessionId);
            this.markDirty(sessionId, 'pty_output');
        }, TRANSCRIPT_PTY_DIRTY_THROTTLE_MS);
        timer.unref?.();
        this.ptyDirtyTimers.set(sessionId, timer);
    }

    startPolling(sessionId: string): void {
        if (!sessionId) return;
        if (this.mode() === 'off') return;
        this.pollingSessions.add(sessionId);
        if (!this.statPollTimer) {
            this.statPollTimer = setInterval(() => this.runStatPoll(), TRANSCRIPT_STAT_POLL_INTERVAL_MS);
            this.statPollTimer.unref?.();
        }
    }

    stopPolling(sessionId: string): void {
        if (!sessionId) return;
        this.pollingSessions.delete(sessionId);
        this.knownPaths.delete(sessionId);
        this.lastSignatures.delete(sessionId);
        if (this.pollingSessions.size === 0 && this.statPollTimer) {
            clearInterval(this.statPollTimer);
            this.statPollTimer = null;
        }
    }

    private runStatPoll(): void {
        for (const sessionId of this.pollingSessions) {
            let path = this.knownPaths.get(sessionId);
            if (!path && this.deps.resolveSourcePath) {
                path = this.deps.resolveSourcePath(sessionId) ?? undefined;
                if (path) this.knownPaths.set(sessionId, path);
            }
            if (!path) continue;
            try {
                const st = fs.statSync(path);
                const sig = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
                const lastSig = this.lastSignatures.get(sessionId);
                if (sig !== lastSig) {
                    this.lastSignatures.set(sessionId, sig);
                    if (lastSig !== undefined) {
                        this.markDirty(sessionId, 'stat_poll');
                    }
                }
            } catch {
                const lastSig = this.lastSignatures.get(sessionId);
                if (lastSig !== 'missing') {
                    this.lastSignatures.set(sessionId, 'missing');
                    if (lastSig !== undefined) {
                        this.markDirty(sessionId, 'stat_poll');
                    }
                }
            }
        }
    }

    /**
     * Explicit alias for the restart/activation seed-read entry point (design
     * §5.2: "activation 직후와 daemon restart 직후에는 해당 세션을 즉시
     * seed-read한다"). Behaviourally identical to `markDirty` — the separate
     * name documents INTENT at call sites, not a different mechanism.
     */
    seedSession(sessionId: string): void {
        this.markDirty(sessionId, 'seed');
    }

    private admitSession(sessionId: string): boolean {
        if (this.inFlight.size >= MAX_TRACKED_SESSIONS && !this.sessionState.has(sessionId)) {
            this.counters.dropped++;
            LOG.warn('Seqscribe', `transcript publisher dropped session=${redactSessionId(sessionId)} — MAX_TRACKED_SESSIONS reached`);
            return false;
        }
        this.inFlight.add(sessionId);
        return true;
    }

    private async runObserve(sessionId: string, observation: TranscriptObservation): Promise<void> {
        try {
            await this.publishObservation(sessionId, observation, false);
        } finally {
            await this.settle(sessionId);
        }
    }

    private async runPull(sessionId: string): Promise<void> {
        try {
            const collector = this.deps.collectObservation;
            const collected = collector ? await collector(sessionId) : null;
            // Stamped whether or not the collector produced anything: the
            // collect leg is the file read + normalization, and its cost is the
            // same work regardless of whether it found a new revision. Recording
            // only the productive pulls would bias the distribution toward the
            // cheap cases.
            const ctx = this.triggerContext.get(sessionId);
            if (ctx) this.latency.recordStage('trigger_to_collect', this.latency.now() - ctx.startedAt);
            if (collected) {
                await this.publishObservation(sessionId, collected.observation, collected.verifiedClear ?? false);
            } else {
                this.counters.sourcePending++;
            }
        } finally {
            await this.settle(sessionId);
        }
    }

    /** Coalesced follow-up: latest pending observation wins over a pending pull. */
    private async settle(sessionId: string): Promise<void> {
        const next = this.pendingObservation.get(sessionId);
        if (next !== undefined) {
            this.pendingObservation.delete(sessionId);
            this.promotePendingContext(sessionId);
            await this.runObserve(sessionId, next);
            return;
        }
        if (this.pendingPull.delete(sessionId)) {
            this.promotePendingContext(sessionId);
            await this.runPull(sessionId);
            return;
        }
        this.inFlight.delete(sessionId);
        this.triggerContext.delete(sessionId);
        this.pendingContext.delete(sessionId);
    }

    /**
     * Hand the coalesced trigger's attribution to the follow-up run. When there
     * is no pending context — the common case, where a pull's own nested
     * `observe()` is what got queued — the ORIGINAL context is kept, so the
     * latency of a `pty_output`-triggered publish is still measured from that
     * PTY byte rather than restarting at the internal re-entry.
     */
    private promotePendingContext(sessionId: string): void {
        const pending = this.pendingContext.get(sessionId);
        if (!pending) return;
        this.pendingContext.delete(sessionId);
        this.triggerContext.set(sessionId, pending);
        this.latency.recordAdmitted(pending.source);
    }

    private async publishObservation(
        sessionId: string,
        observation: TranscriptObservation,
        verifiedClear: boolean,
    ): Promise<void> {
        const mode = this.mode();
        if (mode === 'off') return;

        const last = this.sessionState.get(sessionId);

        // Design §3.4: "pending:true, unsafe mapping, transient empty read는
        // 이미 non-empty complete snapshot을 빈 값으로 덮지 않는다." A prior
        // complete revision exists (`last`), the new observation is empty, and
        // the caller has NOT positively confirmed a clear — hold, do not publish.
        if (last && isEmptyTranscriptObservation(observation) && !verifiedClear) {
            this.counters.emptyGuarded++;
            return;
        }

        const contentHash = hashTranscriptObservation(observation);
        if (last && last.hash === contentHash) {
            this.counters.deduped++;
            return;
        }

        const revision = (last?.revision ?? 0) + 1;
        const identity: TranscriptRevisionIdentity = {
            sessionId: observation.sessionId,
            producerDaemonId: this.deps.daemonId(),
            producerWriterId: this.deps.writerId(),
            producerEpoch: this.epoch,
            revision,
        };
        const now = this.deps.now ?? (() => new Date().toISOString());
        const candidate = stampTranscriptObservation(observation, identity, now());
        const snapshot = encodeTranscriptSnapshot(candidate);
        const encoded = encodeTranscriptRevision(snapshot, identity, now);

        if (!encoded.ok) {
            // Design §3.3/§7.2 item 3: no silent truncation. Count it and let the
            // caller (§8 unit 3+) fall the whole read back to legacy — this
            // service does not itself know how to fall back a read.
            this.counters.oversized++;
            LOG.warn(
                'Seqscribe',
                `transcript projection_oversize session=${redactSessionId(sessionId)} chunks=${encoded.chunkCount} bytes=${encoded.snapshotBytes}`,
            );
            this.deps.onOversize?.(sessionId, encoded.chunkCount, encoded.snapshotBytes);
            return;
        }

        // Commit the new state BEFORE the async publish call so a concurrent
        // `observe`/`markDirty` arriving mid-publish dedupes/coalesces against
        // this revision rather than racing to mint a duplicate one.
        this.sessionState.set(sessionId, { revision, hash: contentHash });

        if (mode === 'shadow' || mode === 'primary') {
            const encodedAt = this.latency.now();
            try {
                await this.deps.publishRevision(sessionId, { begin: encoded.begin, chunks: encoded.chunks, commit: encoded.commit });
                this.counters.published++;
                // Only a SUCCESSFUL publish is sampled. A failed sink returns
                // fast and would drag the distribution down while representing
                // nothing a user ever saw rendered — `publishFailed` is the
                // counter for that case.
                const ctx = this.triggerContext.get(sessionId);
                this.latency.recordStage('collect_to_publish', this.latency.now() - encodedAt);
                if (ctx) {
                    this.latency.recordPublished(ctx.source);
                    this.latency.recordTriggerToPublish(ctx.source, this.latency.now() - ctx.startedAt);
                }
            } catch (error) {
                this.counters.publishFailed++;
                LOG.warn(
                    'Seqscribe',
                    `transcript publish failed session=${redactSessionId(sessionId)}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    getCounters(): TranscriptProjectionCounters {
        return { ...this.counters };
    }

    /**
     * Trigger attribution + daemon-side stage latencies.
     *
     * ★ LOCAL-ONLY. Raw counters and raw millisecond distributions — on the
     * deduped status frame these would change every tick and turn an idle
     * daemon into a permanent transmitter, the exact failure stats.ts's bucket
     * discipline exists to prevent. `buildCloudSeqscribeSummary`
     * (status/reporter.ts) is a fixed-key allow-list that does not name this,
     * and `test/status/cloud-status-content-boundary.test.ts` keeps it out.
     */
    getLatencyDetail(): TranscriptLatencyDetail {
        return this.latency.detail();
    }

    /** Test/diagnostic helper — sessions currently tracked (published at least once). */
    get trackedSessionCount(): number {
        return this.sessionState.size;
    }

    /** Stop deferred PTY work when the singleton is replaced or disarmed. */
    dispose(): void {
        if (this.statPollTimer) clearInterval(this.statPollTimer);
        this.statPollTimer = null;
        this.pollingSessions.clear();
        this.knownPaths.clear();
        this.lastSignatures.clear();
        // Stop deferred PTY work when the singleton is replaced or disarmed.
        for (const timer of this.ptyDirtyTimers.values()) clearTimeout(timer);
        this.ptyDirtyTimers.clear();
        this.ptyDirtyTrailing.clear();
        this.triggerContext.clear();
        this.pendingContext.clear();
    }
}

// ─── Module-level singleton — the safe-no-op-until-configured pattern ──────

let activeService: TranscriptProjectionService | null = null;

/**
 * Wire a service instance. NOT called from production boot in this unit (see
 * header) — exists so `§8 unit 3` has exactly one place to arm the publisher
 * against a real node, and so tests can arm/disarm around a fake `deps`.
 */
export function configureTranscriptProjection(deps: TranscriptProjectionDeps | null): TranscriptProjectionService | null {
    activeService?.dispose();
    activeService = deps ? new TranscriptProjectionService(deps) : null;
    return activeService;
}

export function activeTranscriptProjectionService(): TranscriptProjectionService | null {
    return activeService;
}

/** Safe no-op when unconfigured — see the choke-point wiring note in read-chat-presentation.ts. */
export function notifyTranscriptObservation(sessionId: string, observation: TranscriptObservation): void {
    activeService?.observe(sessionId, observation);
}

/**
 * Safe no-op when unconfigured — the immediate path, for status/finalization/
 * post-chat. `source` is what makes the latency surface able to say WHICH lane
 * a refresh came down; callers that omit it are counted as `unspecified`
 * rather than being folded into a neighbouring source.
 */
export function markTranscriptSessionDirty(
    sessionId: string,
    source: TranscriptTriggerSource = 'unspecified',
): void {
    activeService?.markDirty(sessionId, source);
}

/** Trigger attribution + daemon-side stage latencies, or null when unconfigured.
 * LOCAL-ONLY — see `TranscriptProjectionService.getLatencyDetail`. */
export function transcriptLatencyDetail(): TranscriptLatencyDetail | null {
    return activeService?.getLatencyDetail() ?? null;
}

/**
 * PTY-only throughput guard; status/finalization/post-chat callers stay
 * immediate. Safe no-op when unconfigured — see markChatOutputActivity in
 * subscriptions/topic-registry.ts.
 */
export function markTranscriptPtyOutputActivity(sessionId: string): void {
    activeService?.markPtyOutputActivity(sessionId);
}

export function startTranscriptStatPolling(sessionId: string): void {
    activeService?.startPolling(sessionId);
}

export function stopTranscriptStatPolling(sessionId: string): void {
    activeService?.stopPolling(sessionId);
}

/** TESTS ONLY. */
export function __resetTranscriptProjectionForTests(): void {
    activeService?.dispose();
    activeService = null;
}
