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
 * true to wire it to yet. The call sites this unit DOES add (the choke point
 * in `commands/read-chat-presentation.ts`, the dirty trigger in
 * `subscriptions/topic-registry.ts#markChatOutputActivity`) are safe no-ops
 * until a later unit configures a real service instance — the same
 * incremental pattern unit 1 used for `TranscriptTopicClaimRegistry`.
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
 *
 * ── Dedup / empty-guard / oversize (design §3.4, §7.2 item 3) ──────────────
 * See `transcript-observation.ts#hashTranscriptObservation` for why the dedup
 * hash excludes producer identity/revision/observedAt. The empty-guard and
 * oversize-fallback rules are implemented in `publishObservation` below with
 * inline comments at each branch.
 */

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

/** Hard bound on distinct sessions tracked at once — mirrors MAX_INFLIGHT's
 * role in mesh-dual-write.ts: a shadow that OOMs a daemon is worse than a
 * shadow that skips sessions, and the skip is counted, never silent. */
export const MAX_TRACKED_SESSIONS = 512;

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
            return;
        }
        if (!this.admitSession(sessionId)) return;
        void this.runObserve(sessionId, observation);
    }

    /** PULL trigger — output-activity/status-change hooks that lack a fresh observation. */
    markDirty(sessionId: string): void {
        if (!sessionId) return;
        if (this.mode() === 'off') return;
        if (!this.deps.collectObservation) {
            this.counters.collectorUnavailable++;
            return;
        }
        if (this.inFlight.has(sessionId)) {
            this.pendingPull.add(sessionId);
            return;
        }
        if (!this.admitSession(sessionId)) return;
        void this.runPull(sessionId);
    }

    /**
     * Explicit alias for the restart/activation seed-read entry point (design
     * §5.2: "activation 직후와 daemon restart 직후에는 해당 세션을 즉시
     * seed-read한다"). Behaviourally identical to `markDirty` — the separate
     * name documents INTENT at call sites, not a different mechanism.
     */
    seedSession(sessionId: string): void {
        this.markDirty(sessionId);
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
            await this.runObserve(sessionId, next);
            return;
        }
        if (this.pendingPull.delete(sessionId)) {
            await this.runPull(sessionId);
            return;
        }
        this.inFlight.delete(sessionId);
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
            try {
                await this.deps.publishRevision(sessionId, { begin: encoded.begin, chunks: encoded.chunks, commit: encoded.commit });
                this.counters.published++;
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

    /** Test/diagnostic helper — sessions currently tracked (published at least once). */
    get trackedSessionCount(): number {
        return this.sessionState.size;
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

/** Safe no-op when unconfigured — see markChatOutputActivity in subscriptions/topic-registry.ts. */
export function markTranscriptSessionDirty(sessionId: string): void {
    activeService?.markDirty(sessionId);
}

/** TESTS ONLY. */
export function __resetTranscriptProjectionForTests(): void {
    activeService = null;
}
