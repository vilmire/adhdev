/**
 * `TranscriptProjectionService` — the single-observation coalescing publisher
 * of the keyed chat transcript (design 2026-09-28 message-keyed storage; the
 * coalescing rules are unchanged from the 2026-08-29 transcript design §5.2).
 *
 * ── What this service owns ─────────────────────────────────────────────────
 * It turns each `TranscriptObservation` into at most one FRAME of
 * `session.<id>.chat` rows (transcript-keyed-frame.ts: changed bubbles only,
 * meta when it changed, then a commit) and hands the frame to an INJECTED
 * `appendChatFrame` sink. The live append, compaction and parity read-back
 * are `transcript-keyed-publish-runtime.ts`'s — the only module that appends
 * to a `.chat` topic (`check:transcript-write-shape`).
 *
 * Per session it keeps a `KeyedChatSessionState`: what is already durable, so
 * an observation that changed nothing writes nothing, and a streaming tick
 * writes one bubble (or one 24 KiB part) plus a commit regardless of how long
 * the transcript is. The state is rebuilt from the topic on first use after a
 * restart (`readPersistedChat`) and dropped whenever an append fails, so the
 * next frame re-diffs against what actually landed.
 *
 * ── Coalescing ─────────────────────────────────────────────────────────────
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
 *     service configured without it treats `markDirty` as a no-op.
 *
 * Both are serialized PER SESSION through the same `inFlight`/`pendingLatest`
 * bookkeeping so frames never race, and a second call arriving while one is in
 * flight replaces (never queues) the pending work. That coalescing merges
 * CONCURRENT work only; a serial stream of PTY callbacks is collapsed by the
 * separate leading+trailing throttle (`markPtyOutputActivity`): the first byte
 * pulls immediately, the rest of a paint burst is collapsed into at most one
 * pull per `TRANSCRIPT_PTY_DIRTY_THROTTLE_MS`. The trailing pull is not
 * optional — a provider may append its JSONL record just after the terminal
 * write. The window is FIXED: a frame's cost no longer grows with the
 * transcript, so the v1 size-adaptive window (up to 3 s for large sessions)
 * is gone (§7.1). Status/finalization/post-chat callers use the immediate
 * `markDirty` path.
 *
 * ── Empty-guard ────────────────────────────────────────────────────────────
 * An empty observation never clears published bubbles unless the collector
 * positively confirmed a clear (`verifiedClear`) — see `publishObservation`.
 */

import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LOG } from '../logging/logger.js';
import { dropMessageIdentityLedger, peekMessageIdentityLedger } from '../chat/message-identity-ledger.js';
import { redactSessionId, type ChatBaseReason } from './transcript-keyed-codec.js';
import {
    KeyedChatSessionState,
    type KeyedChatFrame,
    type PersistedChatState,
} from './transcript-keyed-frame.js';
import { isEmptyTranscriptObservation, type TranscriptObservation } from './transcript-observation.js';
import {
    TranscriptLatencyRecorder,
    type TranscriptLatencyDetail,
    type TranscriptTriggerSource,
} from './transcript-latency.js';

/** Hard bound on distinct sessions tracked at once — mirrors MAX_INFLIGHT's
 * role in mesh-dual-write.ts: a publisher that OOMs a daemon is worse than one
 * that skips sessions, and the skip is counted, never silent. */
export const MAX_TRACKED_SESSIONS = 512;

/**
 * PTY paint bursts commonly deliver one callback per small terminal chunk.
 * Keep this below the retired chat push lane's 700ms debounce — so the keyed
 * lane is still faster than what it replaced — while leaving enough room to collapse
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
     * The producer epoch — random per service instantiation (§4.10: "프로세스
     * (퍼블리셔 인스턴스)마다 새로 발급"). Injectable for tests.
     */
    epoch?: string;
    /**
     * Read back what the topic already holds for a session, to rebuild its
     * published state after a restart (§4.10). Synchronous (seqscribe's scans
     * are). Omit or return null for "nothing persisted" (tests, no node).
     */
    readPersistedChat?(sessionId: string): PersistedChatState | null;
    /**
     * Durably append one frame's rows (the live `.chat` append — §8 unit 3).
     * Rejecting/throwing is caught and counted (`publishFailed`) and drops the
     * session's state so the next frame re-diffs against the topic. Must never
     * propagate into the read_chat hot path that triggered it.
     */
    appendChatFrame(sessionId: string, frame: KeyedChatFrame, observation: TranscriptObservation): Promise<void>;
    /**
     * Claim + define + announce the session's `.chat` topic NOW, without
     * appending (`transcript-activation.ts#ensureSessionChatTopic`). Called by
     * `warmSession` so a dashboard SUB is grantable the moment the session
     * exists — not only after its first publish. Returns whether the topic is
     * defined. Omit for "no node" (tests); `warmSession` then only seeds.
     */
    activateSession?(sessionId: string): boolean;
    /**
     * Pull a fresh observation for `markDirty`-triggered publishes. Omit to
     * make `markDirty` an inert no-op.
     */
    collectObservation?(sessionId: string): Promise<TranscriptObservationCollectResult | null>;
}

/** Base frames by reason (§4.10), plus `unexpected` for tripwire frames (§8.2c). */
export type TranscriptChatBaseCounts = Record<ChatBaseReason | 'unexpected', number>;

export interface TranscriptProjectionCounters {
    /** Frames successfully appended (`chatFramesPublished`). */
    published: number;
    /** `appendChatFrame` threw/rejected. */
    publishFailed: number;
    /** Observations that changed nothing and wrote zero rows. */
    deduped: number;
    /** Transient-empty observations that did NOT clobber published bubbles. */
    emptyGuarded: number;
    /** Frames in which the 16 MiB live cap tombstoned the oldest bubbles (§11 Q1). */
    oversized: number;
    /** Sessions dropped because `MAX_TRACKED_SESSIONS` was reached. */
    dropped: number;
    /** `markDirty` calls that did nothing because no `collectObservation` was configured. */
    collectorUnavailable: number;
    /** `collectObservation` returned `null` (source not ready — safety-net poll found nothing new). */
    sourcePending: number;
    /**
     * `collectObservation` threw. Split out of `sourcePending` deliberately: only
     * this counter rising means the collect leg is actually broken.
     */
    collectFailed: number;
    /** PTY dirty triggers collapsed behind the per-session throttle window. */
    ptyDirtyCoalesced: number;
    /** Observations whose bubbles carried no `messageId`/`ord` (identity ledger failed) — not published. */
    unidentified: number;
    /** Rows appended across all frames (`chatRowsWritten`). */
    chatRowsWritten: number;
    /** JCS payload bytes appended across all frames (`chatBytesWritten`). */
    chatBytesWritten: number;
    /** Base frames by reason (`chatBaseFrames`). */
    chatBaseFrames: TranscriptChatBaseCounts;
    /** Base frames that came within 10 minutes of the previous one for their session. */
    chatBaseRateExceeded: number;
    /** Tripwire frames that were refused because the tripwire is armed to throw. */
    chatTripwireRefused: number;
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
        collectFailed: 0,
        ptyDirtyCoalesced: 0,
        unidentified: 0,
        chatRowsWritten: 0,
        chatBytesWritten: 0,
        chatBaseFrames: { epoch_start: 0, writer_change: 0, lineage_switch: 0, resync_request: 0, unexpected: 0 },
        chatBaseRateExceeded: 0,
        chatTripwireRefused: 0,
    };
}

/**
 * Whether a tripwire frame (§8.2c — a delta frame rewriting more than half of
 * the live bubbles) is REFUSED instead of published. Armed in development
 * builds and by `ADHDEV_TRANSCRIPT_TRIPWIRE=throw` (the gate tests); in
 * production the frame is published and counted as `chatBaseFrames.unexpected`.
 */
export function transcriptTripwireArmed(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.ADHDEV_TRANSCRIPT_TRIPWIRE === 'throw' || env.NODE_ENV === 'development';
}

function newProducerEpoch(): string {
    return randomUUID().replace(/-/g, '').slice(0, 12);
}

export class TranscriptProjectionService {
    private readonly deps: TranscriptProjectionDeps;
    private readonly epoch: string;
    private readonly counters: TranscriptProjectionCounters = freshCounters();
    /** Per-session published state (LRU order: most recently published last). */
    private readonly sessionState = new Map<string, KeyedChatSessionState>();

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
    /**
     * Sessions already warmed in this process (topic activated + one seed pull
     * scheduled). A re-register of a live id (meta refresh, reconcile) is an
     * upsert on the bus, so without this every upsert would cost a read_chat.
     * Bounded like the other per-session maps; dropped on `forgetSession`.
     */
    private readonly warmed = new Set<string>();
    private readonly seedTimers = new Map<string, NodeJS.Timeout>();

    constructor(deps: TranscriptProjectionDeps) {
        this.deps = deps;
        this.epoch = deps.epoch ?? newProducerEpoch();
    }

    /** PUSH entry point — the read_chat last-mile choke point already has a full observation. */
    observe(sessionId: string, observation: TranscriptObservation): void {
        if (!sessionId) return;
        // Learn the stat-poll path from the file this read actually used, BEFORE
        // the in-flight branch: every pull-driven observation arrives nested
        // while the pull is in flight, so learning it only on the idle branch
        // left the path unknown and the stat poll dead for every native-reader
        // provider (claude/codex/antigravity/grok) — a turn's final message
        // written after the last PTY-driven read was then never published.
        const sourcePath = ((observation.provenance as any)?.transcriptProvenance as any)?.sourcePath;
        if (typeof sourcePath === 'string' && sourcePath) {
            this.knownPaths.set(sessionId, sourcePath);
        }
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

    /**
     * Drop every per-session row for a session that terminated (wiring-
     * unification B4 — these maps previously grew for every session that ever
     * existed, C9). A pull already in flight settles normally; `inFlight` and
     * the in-flight `triggerContext` are left for `settle()` to clear.
     */
    forgetSession(sessionId: string): void {
        if (!sessionId) return;
        this.stopPolling(sessionId);
        this.sessionState.delete(sessionId);
        this.pendingObservation.delete(sessionId);
        this.pendingPull.delete(sessionId);
        this.pendingContext.delete(sessionId);
        const timer = this.ptyDirtyTimers.get(sessionId);
        if (timer) clearTimeout(timer);
        this.ptyDirtyTimers.delete(sessionId);
        this.ptyDirtyTrailing.delete(sessionId);
        this.warmed.delete(sessionId);
        const seedTimer = this.seedTimers.get(sessionId);
        if (seedTimer) clearTimeout(seedTimer);
        this.seedTimers.delete(sessionId);
        // The session's identity ledger holds its bubble texts for alignment;
        // a terminated session no longer needs them (a later read re-seeds
        // from the topic).
        dropMessageIdentityLedger(sessionId.trim());
    }

    private runStatPoll(): void {
        for (const sessionId of this.pollingSessions) {
            // The path is the one the session's own read resolved (learned in
            // observe()); there is no second resolver to drift from it.
            const path = this.knownPaths.get(sessionId);
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
     * First-paint warm-up for a session that just came into existence on this
     * daemon (launch / restore after restart / attach — the `registered` bus
     * event): define its `.chat` topic synchronously, so a dashboard SUB is
     * granted immediately and the attached lanes are told the topic exists
     * (`announceTopicActivated` → lane re-advertisement → availability push),
     * then schedule ONE seed pull that publishes the session's first frame.
     *
     * Why both halves: the definition alone makes an idle session restored
     * after a daemon restart servable at once — its committed rows are already
     * on disk, and a SUB's SNAP carries them. The seed pull covers a session
     * that has never published (a fresh launch): its first frame is a commit
     * with the current live set (possibly empty), which is what gives the
     * browser a verified view instead of an indefinitely pending pane. Before
     * this, the topic was defined only on the first PTY-driven publish, so an
     * idle session was never SUB-able and a fresh one only after ~seconds.
     *
     * The pull is deferred off the caller's stack: `registered` fires inside
     * `SessionRegistry.register`, before the launching code has finished
     * wiring the session, and the collector re-enters `read_chat`.
     * Idempotent per session until `forgetSession`.
     */
    warmSession(sessionId: string): void {
        if (!sessionId) return;
        if (this.deps.activateSession) {
            try {
                this.deps.activateSession(sessionId);
            } catch (error) {
                LOG.warn(
                    'Seqscribe',
                    `transcript topic warm-up failed session=${redactSessionId(sessionId)}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        if (this.warmed.has(sessionId)) return;
        this.warmed.add(sessionId);
        while (this.warmed.size > MAX_TRACKED_SESSIONS) {
            const oldest = this.warmed.values().next().value as string;
            this.warmed.delete(oldest);
        }
        const timer = setTimeout(() => {
            this.seedTimers.delete(sessionId);
            this.seedSession(sessionId);
        }, 0);
        timer.unref?.();
        this.seedTimers.set(sessionId, timer);
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

    /**
     * A reader reported repeated digest mismatches (`request_transcript_base`,
     * §5.2): make the session's next frame a full `resync_request` base frame,
     * and pull one now.
     */
    requestBase(sessionId: string): void {
        if (!sessionId) return;
        this.stateFor(sessionId).requestBase('resync_request');
        this.markDirty(sessionId, 'unspecified');
    }

    /** The session's published state, restored from the topic on first use. */
    private stateFor(sessionId: string): KeyedChatSessionState {
        let state = this.sessionState.get(sessionId);
        if (state) {
            this.sessionState.delete(sessionId);
            this.sessionState.set(sessionId, state);
            return state;
        }
        state = new KeyedChatSessionState(sessionId, this.epoch);
        try {
            const persisted = this.deps.readPersistedChat?.(sessionId) ?? null;
            if (persisted) state.restore(persisted, this.deps.writerId());
        } catch (error) {
            LOG.warn(
                'Seqscribe',
                `transcript chat restore failed session=${redactSessionId(sessionId)}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        this.sessionState.set(sessionId, state);
        // Bounded like every per-session map here; an evicted state is simply
        // restored from the topic again on its next frame.
        while (this.sessionState.size > MAX_TRACKED_SESSIONS) {
            const oldest = this.sessionState.keys().next().value as string;
            if (oldest === sessionId) break;
            this.sessionState.delete(oldest);
        }
        return state;
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
            let collected: TranscriptObservationCollectResult | null = null;
            let collectThrew = false;
            if (collector) {
                try {
                    collected = await collector(sessionId);
                } catch (error: any) {
                    // A throwing collector is a distinct condition from an empty
                    // one — see `collectFailed`. Swallowing it into `sourcePending`
                    // made a permanently broken collect leg look like an idle
                    // session. Still non-fatal: the `finally` below must settle.
                    collectThrew = true;
                    this.counters.collectFailed++;
                    LOG.warn(
                        'Seqscribe',
                        `transcript projection collect failed session=${redactSessionId(sessionId)}: ${error?.message || String(error)}`,
                    );
                }
            }
            // Stamped whether or not the collector produced anything: the
            // collect leg is the file read + normalization, and its cost is the
            // same work regardless of whether it found a new frame. Recording
            // only the productive pulls would bias the distribution toward the
            // cheap cases.
            const ctx = this.triggerContext.get(sessionId);
            if (ctx) this.latency.recordStage('trigger_to_collect', this.latency.now() - ctx.startedAt);
            if (collected) {
                await this.publishObservation(sessionId, collected.observation, collected.verifiedClear ?? false);
            } else if (!collectThrew) {
                // Only a clean "nothing new" bumps sourcePending; the failure case
                // was already counted as collectFailed above.
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
        const state = this.stateFor(sessionId);

        // "pending:true, unsafe mapping, transient empty read는 이미 non-empty
        // complete snapshot을 빈 값으로 덮지 않는다." Published bubbles exist, the
        // new observation is empty, and the caller has NOT positively confirmed
        // a clear — hold, do not tombstone everything.
        if (state.liveCount > 0 && isEmptyTranscriptObservation(observation) && !verifiedClear) {
            this.counters.emptyGuarded++;
            return;
        }
        if (verifiedClear) {
            // §3.5: a verified clear starts a new identity epoch, so daemon-issued
            // ids of the cleared conversation are never reissued.
            try { peekMessageIdentityLedger(sessionId.trim())?.reset(); } catch { /* identity is best-effort */ }
        }

        const nowIso = (this.deps.now ?? (() => new Date().toISOString()))();
        const nowMs = Date.now();
        const built = state.build(observation, {
            writerId: this.deps.writerId(),
            producerDaemonId: this.deps.daemonId(),
            observedAt: nowIso,
            nowMs,
            verifiedClear,
        });
        if (built.status === 'unchanged') {
            this.counters.deduped++;
            return;
        }
        if (built.status === 'unidentified') {
            this.counters.unidentified++;
            return;
        }
        const frame = built.frame;

        if (frame.tripwire) {
            // §8.2c — a delta frame rewrote most of the live transcript: exactly
            // the whole-transcript-per-change shape this storage exists to end.
            LOG.warn(
                'Seqscribe',
                `transcript chat tripwire session=${redactSessionId(sessionId)} rewritten=${frame.rewrittenBubbles}/${frame.priorLive} frame=${frame.frame}`,
            );
            if (transcriptTripwireArmed()) {
                this.counters.chatTripwireRefused++;
                this.sessionState.delete(sessionId);
                return;
            }
            this.counters.chatBaseFrames.unexpected++;
        }

        const encodedAt = this.latency.now();
        try {
            await this.deps.appendChatFrame(sessionId, frame, observation);
        } catch (error) {
            this.counters.publishFailed++;
            // What landed is unknown (a group commit rolls back whole, but
            // an earlier frame may have been torn): re-diff against the
            // topic on the next frame instead of trusting this state.
            this.sessionState.delete(sessionId);
            LOG.warn(
                'Seqscribe',
                `transcript publish failed session=${redactSessionId(sessionId)}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
        }
        state.commit(frame, nowMs);
        this.counters.published++;
        this.counters.chatRowsWritten += frame.rows.length;
        this.counters.chatBytesWritten += frame.bytes;
        if (frame.capped) this.counters.oversized++;
        if (frame.commit.baseReason) this.counters.chatBaseFrames[frame.commit.baseReason]++;
        if (frame.baseRateExceeded) {
            this.counters.chatBaseRateExceeded++;
            LOG.warn(
                'Seqscribe',
                `transcript chat base frames too frequent session=${redactSessionId(sessionId)} reason=${frame.commit.baseReason}`,
            );
        }
        // Only a SUCCESSFUL publish is sampled — `publishFailed` counts the rest.
        const ctx = this.triggerContext.get(sessionId);
        this.latency.recordStage('collect_to_publish', this.latency.now() - encodedAt);
        if (ctx) {
            this.latency.recordPublished(ctx.source);
            this.latency.recordTriggerToPublish(ctx.source, this.latency.now() - ctx.startedAt);
        }
    }

    getCounters(): TranscriptProjectionCounters {
        return { ...this.counters, chatBaseFrames: { ...this.counters.chatBaseFrames } };
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
        for (const timer of this.seedTimers.values()) clearTimeout(timer);
        this.seedTimers.clear();
        this.warmed.clear();
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

/**
 * `request_transcript_base` (§5.2) — a reader's repeated digest mismatches ask
 * for one base frame. Safe no-op when unconfigured.
 */
export function requestTranscriptBaseFrame(sessionId: string): boolean {
    if (!activeService) return false;
    activeService.requestBase(sessionId);
    return true;
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
 * immediate. Safe no-op when unconfigured — called from the host runtime's
 * output fanout (boot/host-runtime.ts) for every CLI chunk.
 */
export function markTranscriptPtyOutputActivity(sessionId: string): void {
    activeService?.markPtyOutputActivity(sessionId);
}



/** TESTS ONLY. */
export function __resetTranscriptProjectionForTests(): void {
    activeService?.dispose();
    activeService = null;
}
