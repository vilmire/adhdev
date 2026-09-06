/**
 * Transcript trigger-source attribution + stage-latency sampling.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `TranscriptProjectionCounters` (transcript-publisher.ts) counts THROUGHPUT —
 * `published`/`deduped`/`sourcePending` — and `transcriptParityDetail`
 * (stats.ts) counts parity runs. Neither answers the two questions a live
 * daemon actually gets asked when the replica lane feels slow:
 *
 *   1. WHICH trigger is driving refreshes right now? Six sources can mark a
 *      session dirty and their cadences differ by two orders of magnitude
 *      (a leading-edge PTY byte vs. the 3s safety-net stat poll). If a
 *      streaming session is being refreshed mostly by `stat_poll`, the fast
 *      observer is not firing and ~3s of the observed latency is the poll
 *      interval, not the pipeline. That is a diagnosis, not a guess.
 *   2. HOW LONG does the daemon-side leg take? Not "on average" — a mean hides
 *      the tail that users actually feel, so every sample set reports
 *      count/p50/p95/max.
 *
 * Without these two numbers, tuning is speculation. It has already cost one
 * wrong call: a throttle constant was changed to "fix" a perceived regression
 * that a source breakdown would have attributed elsewhere immediately.
 *
 * ── What is measurable, and what is deliberately NOT ───────────────────────
 * Everything recorded here is a RELATIVE elapsed time inside THIS process,
 * taken from one monotonic clock. Absolute timestamps are never compared
 * across a process boundary:
 *
 *   - trigger → publish: MEASURED. Both ends are in the daemon.
 *   - publish → browser worker `onSnapshot`: NOT MEASURED. The daemon and the
 *     browser have independent, unsynchronized wall clocks; subtracting one's
 *     stamp from the other's yields clock skew, not latency. A number produced
 *     that way would look precise and be wrong, which is worse than absent.
 *   - `onSnapshot` → controller apply: NOT MEASURED HERE. Both ends share the
 *     browser's clock so it is measurable in principle, but it lives in the web
 *     packages, not on this daemon diagnostic surface.
 *
 * Do not "complete" the chain by differencing daemon and browser stamps.
 *
 * ── Content boundary (CLAUDE.md "Server content boundary") ─────────────────
 * Everything here is LOCAL-ONLY and rides `includeLocalDiagnostics`, for the
 * same two independent reasons as `readRouting` / `transcriptParityDetail` in
 * stats.ts: these are raw monotonic counters that would defeat the status-frame
 * dedup and turn an idle daemon into a permanent transmitter, and the server
 * has no routing use for them. The keys are a FIXED trigger-source enum — never
 * a session id, topic name, or peer id — and the values are integers.
 */

/**
 * What caused a transcript refresh. A closed enum: these become object keys on
 * a diagnostic surface, so they must never be derived from a session id, topic
 * name, or any other identifier.
 */
export type TranscriptTriggerSource =
    /** Leading edge or trailing flush of a PTY output burst. */
    | 'pty_output'
    /** The `TRANSCRIPT_STAT_POLL_INTERVAL_MS` safety-net source-file poll. */
    | 'stat_poll'
    /** A per-session status transition (finalizing, approval, completion). */
    | 'status_event'
    /** The post-chat command hook, right after send_chat and friends. */
    | 'post_chat'
    /**
     * Chat-tail liveness watchdog tick.
     *
     * ★ Reserved, and currently never recorded — see `unspecified` below. The
     * watchdog lives in the BROWSER controller
     * (web-core `session-chat-tail-controller.ts`), and its daemon-visible
     * effect is an ordinary `read_chat` command carrying no source marker. The
     * member exists so that wiring an explicit marker later is an additive
     * change rather than a rename of a live key.
     */
    | 'watchdog'
    /** Busy-quiet lease expiry falling the session back to legacy. Reserved and
     * currently never recorded, for the same reason as `watchdog`. */
    | 'lease_expiry'
    /** Activation / restart seed-read. */
    | 'seed'
    /**
     * A trigger whose origin this process cannot attribute.
     *
     * ★ Read this as "browser-originated `read_chat`, source unknown" rather
     * than as a residual bucket. The PUSH choke point
     * (`commands/read-chat-presentation.ts`) fires on every `read_chat`, and the
     * daemon has no way to tell a watchdog tick from a lease-expiry re-pull from
     * a user opening a pane — the command carries no marker. Attributing them to
     * `watchdog` by guesswork would manufacture precision that does not exist;
     * counting them honestly here does not.
     */
    | 'unspecified';

export const TRANSCRIPT_TRIGGER_SOURCES: readonly TranscriptTriggerSource[] = [
    'pty_output',
    'stat_poll',
    'status_event',
    'post_chat',
    'watchdog',
    'lease_expiry',
    'seed',
    'unspecified',
] as const;

/** Per-source trigger tallies. Every source is always present, so a zero is
 * distinguishable from "this source was never wired". */
export interface TranscriptTriggerCounts {
    /** `markDirty`/`markPtyOutputActivity` calls attributed to this source. */
    triggered: number;
    /** Calls that reached the collector rather than being coalesced/dropped. */
    admitted: number;
    /** Calls collapsed into an in-flight or throttled window. */
    coalesced: number;
    /** Calls that produced a new published revision. */
    published: number;
}

export interface TranscriptLatencyDistribution {
    count: number;
    p50: number;
    p95: number;
    max: number;
}

/**
 * Bounded reservoir of the most recent samples. Ring rather than unbounded so a
 * long-lived daemon cannot grow this without limit; recent-window rather than
 * all-time because "how fast is it RIGHT NOW" is the question being asked, and
 * an all-time p95 on a daemon that has been up for a week is dominated by
 * conditions that no longer hold.
 */
const SAMPLE_CAPACITY = 256;

class LatencySamples {
    private readonly values = new Float64Array(SAMPLE_CAPACITY);
    private next = 0;
    private filled = 0;
    private maxSeen = 0;

    record(ms: number): void {
        if (!Number.isFinite(ms) || ms < 0) return;
        this.values[this.next] = ms;
        this.next = (this.next + 1) % SAMPLE_CAPACITY;
        if (this.filled < SAMPLE_CAPACITY) this.filled++;
        // `max` is tracked separately from the ring: it is the one statistic
        // where forgetting the worst case defeats the purpose of measuring.
        if (ms > this.maxSeen) this.maxSeen = ms;
    }

    get count(): number {
        return this.filled;
    }

    distribution(): TranscriptLatencyDistribution | null {
        if (this.filled === 0) return null;
        const sorted = Array.from(this.values.subarray(0, this.filled)).sort((a, b) => a - b);
        return {
            count: this.filled,
            p50: percentile(sorted, 0.5),
            p95: percentile(sorted, 0.95),
            max: round1(this.maxSeen),
        };
    }
}

/**
 * Nearest-rank percentile over an ascending array. Nearest-rank rather than
 * interpolated so every reported value is a real observed sample — an
 * interpolated p95 of a bimodal distribution (350ms throttle vs. 3s poll) lands
 * between the two modes, at a latency that never actually occurred.
 */
function percentile(sortedAscending: readonly number[], q: number): number {
    if (sortedAscending.length === 0) return 0;
    const rank = Math.ceil(q * sortedAscending.length);
    const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
    return round1(sortedAscending[index]!);
}

function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

/** Stages of the daemon-side leg. See the header for what is NOT here. */
export type TranscriptLatencyStage =
    /** Dirty trigger accepted → collector call returned. */
    | 'trigger_to_collect'
    /** Collector returned → revision handed to the publish sink. */
    | 'collect_to_publish'
    /** Dirty trigger accepted → revision handed to the publish sink. */
    | 'trigger_to_publish';

export const TRANSCRIPT_LATENCY_STAGES: readonly TranscriptLatencyStage[] = [
    'trigger_to_collect',
    'collect_to_publish',
    'trigger_to_publish',
] as const;

export interface TranscriptLatencyDetail {
    /** Per-source trigger attribution — the "which lane" answer. */
    bySource: Record<TranscriptTriggerSource, TranscriptTriggerCounts>;
    /**
     * Per-stage distributions over the recent window. A stage with no samples
     * yet is ABSENT rather than zero-filled: `{count: 0, p50: 0}` reads as
     * "measured, and it was instant", which is the opposite of the truth.
     */
    stages: Partial<Record<TranscriptLatencyStage, TranscriptLatencyDistribution>>;
    /**
     * End-to-end daemon-side latency split by the source that triggered it.
     * This is the join of the two answers above and the one an observer reads
     * first: `stat_poll` dominating with a ~3s p50 is the poll interval showing
     * through, not the pipeline being slow.
     */
    triggerToPublishBySource: Partial<Record<TranscriptTriggerSource, TranscriptLatencyDistribution>>;
    /**
     * Stages this instrumentation deliberately does NOT measure, each with the
     * reason, so an observer never reads their absence as "zero latency". Kept
     * in the payload rather than only in this file's comments because the
     * payload is what gets pasted into an issue.
     */
    notMeasurable: readonly { stage: string; reason: string }[];
    /** `Date.now()` when this process began counting — dates the zeros. */
    since: number;
    /** Milliseconds counted so far. */
    uptimeMs: number;
}

/** Fixed, and duplicated into no other module — see the header. */
const NOT_MEASURABLE: readonly { stage: string; reason: string }[] = [
    {
        stage: 'publish_to_worker_onsnapshot',
        reason: 'crosses the daemon→browser process boundary; the two wall clocks are unsynchronized, so a difference of their stamps measures skew, not latency',
    },
    {
        stage: 'worker_onsnapshot_to_controller_apply',
        reason: 'both ends share the browser clock and are measurable in principle, but they live in the web packages, not on this daemon diagnostic surface',
    },
];

function freshTriggerCounts(): TranscriptTriggerCounts {
    return { triggered: 0, admitted: 0, coalesced: 0, published: 0 };
}

/**
 * Process-local latency/attribution recorder. One instance is owned by the
 * `TranscriptProjectionService`, so it is reset whenever the publisher is
 * reconfigured — the same lifetime as the counters it sits beside.
 */
export class TranscriptLatencyRecorder {
    private readonly bySource: Record<TranscriptTriggerSource, TranscriptTriggerCounts>;
    private readonly stages = new Map<TranscriptLatencyStage, LatencySamples>();
    private readonly perSource = new Map<TranscriptTriggerSource, LatencySamples>();
    private readonly since = Date.now();
    private readonly clock: () => number;

    /** `clock` is injected for tests; defaults to the monotonic timer. Never a
     * wall clock — a wall-clock elapsed can go negative across an NTP step. */
    constructor(clock: () => number = () => Number(process.hrtime.bigint() / 1_000_000n)) {
        this.clock = clock;
        this.bySource = {
            pty_output: freshTriggerCounts(),
            stat_poll: freshTriggerCounts(),
            status_event: freshTriggerCounts(),
            post_chat: freshTriggerCounts(),
            watchdog: freshTriggerCounts(),
            lease_expiry: freshTriggerCounts(),
            seed: freshTriggerCounts(),
            unspecified: freshTriggerCounts(),
        };
    }

    now(): number {
        return this.clock();
    }

    recordTriggered(source: TranscriptTriggerSource): void {
        this.bySource[source].triggered++;
    }

    recordAdmitted(source: TranscriptTriggerSource): void {
        this.bySource[source].admitted++;
    }

    recordCoalesced(source: TranscriptTriggerSource): void {
        this.bySource[source].coalesced++;
    }

    recordPublished(source: TranscriptTriggerSource): void {
        this.bySource[source].published++;
    }

    recordStage(stage: TranscriptLatencyStage, elapsedMs: number): void {
        let samples = this.stages.get(stage);
        if (!samples) {
            samples = new LatencySamples();
            this.stages.set(stage, samples);
        }
        samples.record(elapsedMs);
    }

    recordTriggerToPublish(source: TranscriptTriggerSource, elapsedMs: number): void {
        this.recordStage('trigger_to_publish', elapsedMs);
        let samples = this.perSource.get(source);
        if (!samples) {
            samples = new LatencySamples();
            this.perSource.set(source, samples);
        }
        samples.record(elapsedMs);
    }

    detail(): TranscriptLatencyDetail {
        const stages: Partial<Record<TranscriptLatencyStage, TranscriptLatencyDistribution>> = {};
        for (const stage of TRANSCRIPT_LATENCY_STAGES) {
            const dist = this.stages.get(stage)?.distribution();
            if (dist) stages[stage] = dist;
        }
        const triggerToPublishBySource: Partial<Record<TranscriptTriggerSource, TranscriptLatencyDistribution>> = {};
        for (const source of TRANSCRIPT_TRIGGER_SOURCES) {
            const dist = this.perSource.get(source)?.distribution();
            if (dist) triggerToPublishBySource[source] = dist;
        }
        // Deep-copy the tallies so a caller holding a returned detail cannot see
        // it mutate underneath them on the next trigger.
        const bySource = {} as Record<TranscriptTriggerSource, TranscriptTriggerCounts>;
        for (const source of TRANSCRIPT_TRIGGER_SOURCES) {
            bySource[source] = { ...this.bySource[source] };
        }
        return {
            bySource,
            stages,
            triggerToPublishBySource,
            notMeasurable: NOT_MEASURABLE,
            since: this.since,
            uptimeMs: Math.max(0, Date.now() - this.since),
        };
    }
}
