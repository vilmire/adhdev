/**
 * seqscribe health summary for the status report (design §1.5).
 *
 * Projects `node.stats()` — which is per-topic and per-peer, and grows with the
 * fleet — down to a handful of fleet-wide numbers.
 *
 * ── Content boundary (CLAUDE.md "Server content boundary") ─────────────────
 * The status path is a four-layer ALLOW-LIST and this is the daemon-side layer
 * for seqscribe. Every field below is a counter, a boolean, or a bucketed
 * integer. Deliberately absent:
 *
 *   - topic NAMES — `session.<id>.transcript` and `mesh.<meshId>.events` embed
 *     session and mesh identifiers, so a per-topic map would leak the fleet's
 *     shape to the server. Only aggregates cross.
 *   - peer ids and writer ids — peer identity is not routing metadata here.
 *   - anything derived from an entry payload.
 *
 * Adding a field means asserting it is non-content. Never widen this to a
 * pass-through of `NodeStats`, and never rewrite it as a deny-list.
 *
 * ── Why the values are coarse ──────────────────────────────────────────────
 * `sendUnifiedStatusReport` dedups server frames by hashing the whole payload
 * minus `timestamp`, suppressing up to SERVER_DEDUP_KEEPALIVE_REPORTS identical
 * reports. A raw monotonic counter here would change on every tick and defeat
 * that dedup, turning a mostly-idle daemon into a constant 30s transmitter.
 *
 * So the fields that would otherwise tick constantly are BUCKETED: an idle-ish
 * daemon reports the same bucket for long stretches and the dedup keeps
 * working, while a real problem still crosses a boundary and shows up.
 */

import type { NodeStats } from 'seqscribe';
import type { SeqscribeThroughputSnapshot } from './throughput-collector.js';
import type { TranscriptLatencyDetail } from './transcript-latency.js';

/**
 * Finality staleness buckets, in hours. With a 1h issuance cadence, "fresh" is
 * under 2h (the design's alert threshold is 2× the cadence); beyond that the
 * exact age matters less than the order of magnitude.
 */
const FGEN_AGE_BUCKETS_H = [2, 6, 24, 72] as const;

/** Backlog buckets. Zero is distinct from "a few" — a stuck queue is the signal. */
const BACKLOG_BUCKETS = [1, 10, 100, 1000] as const;

/**
 * Map a value to the index of the first bucket it does NOT exceed, so the
 * reported number is a small ordinal rather than a live counter. `0` always
 * means "none"; the top index means "at or above the last threshold".
 */
function bucket(value: number, thresholds: readonly number[]): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    for (let i = 0; i < thresholds.length; i++) {
        if (value < thresholds[i]!) return i + 1;
    }
    return thresholds.length + 1;
}

/**
 * Fleet-wide seqscribe health. Counters and buckets only — see the content
 * boundary note above.
 */
export interface SeqscribeStatusSummary {
    /** Topics defined on this node. */
    topics: number;
    /** Peers currently attached (any state). */
    peers: number;
    /** Peers in the `ready` state — i.e. actually syncing. */
    peersReady: number;
    /** Bucketed max pending rows across topics (unapplied, awaiting causal deps). */
    pendingBucket: number;
    /** Bucketed max consumer lag across topics, in rows. */
    consumerLagBucket: number;
    /** Bucketed max peer send-queue depth. */
    queueBucket: number;
    /** Bucketed oldest finality certificate age. 0 = fresh or nothing certified. */
    fgenAgeBucket: number;
    /** True when any topic has quarantined entries — always worth surfacing. */
    quarantined: boolean;
    /** True when a fleet secret is configured and certificates can be verified. */
    authority: boolean;

    // ── Phase 2 Stage 2+3: mesh dual-write shadow + parity ──────────────────
    // Same discipline as the fields above: booleans and bucket ordinals, never
    // live counters, so an idle daemon's status frame stays byte-identical and
    // the server-side dedup keeps working.
    /** True when the mesh dual-write shadow leg is armed. */
    dualWrite: boolean;
    /** Bucketed count of shadow appends that failed. 0 = none. */
    dualWriteFailedBucket: number;
    /** Bucketed count of shadow records dropped by load-shedding. 0 = none. */
    dualWriteDroppedBucket: number;
    /**
     * Bucketed count of records mirrored LATE by the parity backfill.
     *
     * ★ Nonzero is EXPECTED and healthy on a machine that runs mesh MCP tools:
     * the mcp-server process appends to the shared ledger with no armed shadow
     * leg of its own, so the daemon repairs those entries on its parity sweep
     * (see the process-boundary note in mesh-dual-write.ts). Read it together
     * with `parityMismatchBucket` — backfill nonzero + mismatch settling is the
     * repair working; mismatch persisting while this stays 0 is the repair
     * itself being broken.
     */
    dualWriteBackfilledBucket: number;
    /**
     * Bucketed count of parity mismatches observed since boot.
     *
     * ★ DETECTION, not the gate. A nonzero value here is EXPECTED in normal
     * operation: the mcp-server process appends ledger entries with no armed
     * shadow leg, every sweep reports them, and the backfill repairs them (see
     * the process-boundary note in mesh-dual-write.ts). Read it together with
     * `parityPersistentMismatchBucket` — this one nonzero while that one is 0 is
     * the self-healing cycle working as designed.
     * Bucketed rather than raw for the dedup reason above — a nonzero bucket is
     * the signal; the exact count lives in the daemon log and `get_status_metadata`.
     */
    parityMismatchBucket: number;
    /**
     * Bucketed count of mismatches that SURVIVED a repair attempt.
     *
     * ★ THIS is the number the read-path cutover needs at 0 — it is the
     * readiness gate's actual condition 4 (mesh-read-readiness.ts). A
     * `missing_in_shadow` counts here only once a later sweep reports the same
     * id again; `field_mismatch` and `extra_in_shadow` count on sight, being
     * unrepairable. Nonzero means a genuine replication failure and the whole
     * process has fallen back to the ledger.
     */
    parityPersistentMismatchBucket: number;
    /** True once at least one parity comparison has run. */
    parityRan: boolean;
    /**
     * Bucketed breakdown of `parityMismatchBucket` by mismatch class.
     *
     * The combined bucket answers "is Stage 4 blocked"; these three answer
     * "blocked by what" without adding a live counter — same bucket discipline
     * as everything else in this summary.
     */
    parityMissingInShadowBucket: number;
    parityExtraInShadowBucket: number;
    parityFieldMismatchBucket: number;

    // ── §8 unit 2: transcript single-observation publisher + parity ────────
    // Same bucket discipline as the mesh dual-write/parity fields above,
    // `transcript*`-prefixed rather than `dualWrite*`/`parity*` so the two
    // legs (mesh events shadow vs. session transcript publisher) never share a
    // key. `transcriptParityPersistentMismatchBucket` mirrors
    // `parityPersistentMismatchBucket`'s omission from
    // `buildCloudSeqscribeSummary` (status/reporter.ts) below — kept local-only
    // for consistency with that existing asymmetry, not a new decision.
    /** True when the transcript publisher is configured (mode != off). */
    transcriptPublish: boolean;
    /** Bucketed count of complete revisions handed to the publish sink. */
    transcriptPublishedBucket: number;
    /** Bucketed count of publish-sink failures. */
    transcriptPublishFailedBucket: number;
    /** Bucketed count of stable-hash observations that produced no new revision. */
    transcriptDedupedBucket: number;
    /** Bucketed count of `projection_oversize` rejections (design §3.3/§7.2 item 3). */
    transcriptOversizedBucket: number;
    /** Bucketed count of sessions dropped at `MAX_TRACKED_SESSIONS`. */
    transcriptDroppedBucket: number;
    /** True once at least one transcript parity comparison has run. */
    transcriptParityRan: boolean;
    /** Bucketed count of transcript parity mismatches observed since boot. */
    transcriptParityMismatchBucket: number;
    /** LOCAL-ONLY — see the header note above. Mismatches that survived a repair attempt. */
    transcriptParityPersistentMismatchBucket: number;

    // ── LOCAL-ONLY replication diagnostics (library P22/P24) ────────────────
    // ★ Everything below is deliberately ABSENT from the cloud projection.
    // `buildCloudSeqscribeSummary` (status/reporter.ts) is a fixed-key
    // allow-list that re-lists every field it forwards, so these do not reach
    // the server — `test/status/cloud-status-content-boundary.test.ts` asserts
    // exactly that. They exist for `get_status_metadata` and the daemon log,
    // which are local surfaces.
    //
    // They are also RAW counters rather than buckets, which is only safe
    // because they never ride the deduped status frame. Do not promote any of
    // them to the cloud summary without bucketing them first.
    /**
     * Cumulative non-applied wire-apply outcomes across topics (P22).
     * Nonzero means entries arrived and were refused — the counterpart to a
     * `sync_stalled` anomaly, and the number that distinguishes "quiet because
     * idle" from "quiet because every apply is bouncing".
     */
    applyRejects?: number;
    /** Peer streams currently suspended for non-progress (P22). */
    stalledStreams?: number;
    /**
     * Interval sync throughput from the last collector tick (P24), summed
     * across topics. Absent until the collector's first tick.
     *
     * ★ Sourced from the throughput collector's snapshot, never from a direct
     * `node.stats()` call — see seqscribe/throughput-collector.ts for why
     * stats() must have exactly one reader.
     */
    throughput?: {
        intervalMs: number;
        servedEntries: number;
        servedBytes: number;
        appliedEntries: number;
        appliedBytes: number;
        wantRoundsRequested: number;
        wantRoundsServed: number;
    };
    /**
     * Top (topic, peer) byte hotspots this interval (P24).
     *
     * ★★ CONTENT: topic names embed session and mesh ids, and `peerId` is a
     * fleet identifier. This field is LOCAL-ONLY and must never be forwarded
     * to the server on any path.
     */
    syncHotspots?: { topic: string; peerId: string; bytes: number }[];
    /**
     * Stage 4A read-path routing: how many allow-listed reads this process
     * answered from the replica versus the ledger, and why the ledger ones fell
     * back (`mesh-read-readiness.ts` `MeshReadFallbackReason`).
     *
     * ★ Why this exists. The readiness gate is four fail-closed conditions, and
     * until this field there was NO way to ask a live daemon which of them was
     * holding. `parityPersistentMismatchBucket` covers condition 4 alone; the
     * other three — topic/grant, quarantine, consumer catch-up — were visible
     * only in a transition log line that prints once and scrolls away. That gap
     * cost a real misdiagnosis: a healthy fleet (dualWrite on, parity clean) was
     * read as "the gate is never called at all", because the observable surface
     * could not distinguish a gate that was never reached from one that was
     * reached and answered `consumer_lag`. `fallbacks` names the condition
     * directly, so that question is now answerable from `get_status_metadata`.
     *
     * ★★ LOCAL-ONLY, for TWO independent reasons — either alone is sufficient:
     *   1. These are RAW monotonic counters, not buckets. On the deduped status
     *      frame they would change every tick and turn an idle daemon into a
     *      constant transmitter — the failure this file's bucket discipline
     *      exists to prevent.
     *   2. They are per-process aggregates the server has no routing use for.
     * The keys are fixed `MeshReadFallbackReason` enums and the values are
     * integers; no mesh id, topic name or peer id appears, which is what makes
     * the shape safe on this local surface at all.
     */
    readRouting?: {
        fromReplica: number;
        fromLedger: number;
        /** Keyed by `MeshReadFallbackReason` — a fixed enum, never a mesh id. */
        fallbacks: Record<string, number>;
    };
    /**
     * §8 unit 2 transcript parity, RAW and undecimated — the numbers §5.6's
     * remaining gate condition (`persistent mismatch 0`) actually needs.
     *
     * ★ Why the bucketed `transcriptParity*Bucket` fields above are not enough.
     * They answer "did anything run" and "roughly how bad", which cannot
     * distinguish a clean run from an UNDECIDED one. `missing_complete_revision`
     * is promoted to persistent only when the SAME session key is compared
     * twice, and the only non-test caller is a per-append self-check — so
     * `transcriptParityRan === true` with two appends on two different sessions
     * means the promotion path never fired and `persistent === 0` is evidence of
     * nothing. `sessionsRepeated` / `pendingMissingRevisits` are what make the
     * condition decidable, and the six-class split says which axis is dirty.
     *
     * ★ `since` is the process-start stamp. Every value here is process-local
     * and returns to 0 on daemon restart; without a date on the zero an observer
     * reads a fresh restart as "no mismatches". Never drop it.
     *
     * ★★ LOCAL-ONLY, for the same two independent reasons as `readRouting`:
     * these are raw monotonic counters that would defeat the status-frame dedup,
     * and the server has no use for them. `buildCloudSeqscribeSummary`
     * (status/reporter.ts) is a fixed-key allow-list that does not list this key;
     * `test/status/cloud-status-content-boundary.test.ts` asserts it stays out.
     * The shape carries integers only — no session key, redacted or otherwise.
     *
     * ★ WHICH CALL SITES EMIT IT. Two production callers pass the parity
     * counters, and only one can produce this field:
     *   - daemon-core's `getSeqscribeStats` closure (boot/daemon-lifecycle.ts),
     *     serving `get_status_metadata` — opts into the local diagnostics, so
     *     the detail appears. This is the surface the §5.6 gate is read from.
     *   - daemon-cloud's status-report supplier (adhdev-daemon.ts), building the
     *     SERVER frame — does not opt in, so the detail is absent BY
     *     CONSTRUCTION rather than by omission at the call site.
     * Do not "fix" the cloud caller to pass it. These are raw monotonic
     * counters: on the deduped status frame every heartbeat would hash
     * differently and an idle daemon would transmit forever. That call site is
     * additionally pinned by `tests/seqscribe-convergence.test.mjs` (G2), which
     * greps its source text to keep the local-diagnostics opt-in out of the
     * server-frame assembly one layer earlier than the allow-list would.
     */
    transcriptParityDetail?: {
        runs: number;
        compared: number;
        mismatches: number;
        persistentMismatches: number;
        missingCompleteRevision: number;
        fieldMismatch: number;
        extraMessage: number;
        wrongSession: number;
        wrongOwner: number;
        digestMismatch: number;
        /** Distinct session keys compared at least once. */
        sessionsObserved: number;
        /** Distinct session keys compared at least twice — recurrence reachable. */
        sessionsRepeated: number;
        /** Comparisons that revisited a session already in the grace set. */
        pendingMissingRevisits: number;
        /** Session keys still sitting in the grace set. */
        pendingMissingOpen: number;
        /** `Date.now()` when this process began counting. */
        since: number;
        /** Milliseconds counted so far — `since` expressed as an age. */
        uptimeMs: number;
    };
    /**
     * Which trigger drove each transcript refresh, and how long the daemon-side
     * leg took (count/p50/p95/max per source).
     *
     * ★ Why this is separate from `transcriptParityDetail` above. That field
     * counts THROUGHPUT — runs, comparisons, mismatch classes. It cannot answer
     * "is the replica lane fast", because it has no timing axis at all and no
     * notion of which of the six dirty-trigger sources fired. Six triggers with
     * cadences two orders of magnitude apart (a leading-edge PTY byte vs. the 3s
     * safety-net stat poll) feed the same publisher, so without attribution a
     * slow lane and a lane being driven only by its slowest trigger look
     * identical from here. That ambiguity has already produced one wrong tuning
     * call.
     *
     * ★ `notMeasurable` is part of the payload on purpose. The daemon→browser
     * legs are absent because the two clocks are unsynchronized, NOT because
     * they are instant, and an observer reading a truncated chain needs that
     * distinction stated where they are looking. See seqscribe/transcript-
     * latency.ts.
     *
     * ★★ LOCAL-ONLY, for the same two independent reasons as `readRouting` and
     * `transcriptParityDetail`: raw monotonic counters and raw millisecond
     * distributions would make every status frame hash differently and turn an
     * idle daemon into a permanent transmitter, and the server has no routing
     * use for them. The keys are a FIXED trigger-source enum and a fixed stage
     * enum — never a session id, topic name, or peer id — and every value is a
     * number. `buildCloudSeqscribeSummary` (status/reporter.ts) is a fixed-key
     * allow-list that does not name this key, and
     * `test/status/cloud-status-content-boundary.test.ts` asserts it stays out.
     */
    transcriptLatencyDetail?: TranscriptLatencyDetail;
    /**
     * The transcript publisher counters that the bucketed `transcript*Bucket`
     * fields do NOT carry.
     *
     * ★ Why this exists. `TranscriptProjectionCounters` has nine fields, and the
     * status projection hand-picked five of them (published / publishFailed /
     * deduped / oversized / dropped). The other four — `ptyDirtyCoalesced`,
     * `emptyGuarded`, `collectorUnavailable`, `sourcePending` — were counted on
     * every daemon and then read by nobody, on any surface. `getCounters()` was
     * always public and always wired; the loss was in the projection, one layer
     * later, which is why it looked like an accessor gap.
     *
     * `ptyDirtyCoalesced` is the load-bearing one: it is the ONLY signal that
     * says whether the per-session PTY throttle is actually collapsing bursts.
     * Without it the throttle window cannot be tuned with evidence — the
     * published count alone cannot distinguish "the throttle merged 200 triggers
     * into 3 publishes" from "only 3 triggers ever fired".
     *
     * ★★ LOCAL-ONLY, for the same reason as `transcriptLatencyDetail` directly
     * above: these are raw monotonic counters that would change on every tick
     * and defeat the status-frame dedup. Fixed keys, numeric values, no session
     * id / topic name / peer id — but the cloud allow-list
     * (`buildCloudSeqscribeSummary`) deliberately does not name this key, and
     * `test/status/cloud-status-content-boundary.test.ts` keeps it out.
     */
    transcriptCounterDetail?: {
        /** PTY dirty triggers collapsed behind the per-session throttle window. */
        ptyDirtyCoalesced: number;
        /** Transient-empty observations that did not clobber a prior non-empty revision. */
        emptyGuarded: number;
        /** `markDirty` calls with no collector configured. */
        collectorUnavailable: number;
        /** Collector returned null — source not ready. */
        sourcePending: number;
    };
}

export interface SummarizeOptions {
    authorityEnabled: boolean;
    /** Stage 2 shadow counters. Omitted → reported as inactive/zero. */
    dualWrite?: {
        active: boolean;
        failed: number;
        dropped: number;
        /** Records mirrored late by the parity backfill. Omitted → 0. */
        backfilled?: number;
    };
    /** Stage 3 parity counters. Omitted → reported as never-run. */
    parity?: {
        runs: number;
        mismatches: number;
        /** Mismatches that survived a repair attempt — the cutover's gate. */
        persistentMismatches?: number;
        /** Per-class breakdown. Omitted → each axis reported as 0. */
        missingInShadow?: number;
        extraInShadow?: number;
        fieldMismatch?: number;
    };
    /**
     * §8 unit 2 transcript publisher counters. Omitted → reported as inactive/zero.
     *
     * The four optional fields feed `transcriptCounterDetail` and are read only
     * under `includeLocalDiagnostics`; pass `getCounters()` whole from a local
     * surface, or just the required fields from the status reporter.
     */
    transcript?: {
        active: boolean;
        published: number;
        publishFailed: number;
        deduped: number;
        oversized: number;
        dropped: number;
        ptyDirtyCoalesced?: number;
        emptyGuarded?: number;
        collectorUnavailable?: number;
        sourcePending?: number;
    };
    /**
     * §8 unit 2 transcript parity counters. Omitted → reported as never-run.
     *
     * The three fields above the line feed the BUCKETS (which the cloud summary
     * may forward). Everything below feeds `transcriptParityDetail` and is read
     * ONLY when `includeLocalDiagnostics` is set — pass
     * `transcriptParityCounters()` whole from a local surface, or just the three
     * required fields from the status reporter.
     */
    transcriptParity?: {
        runs: number;
        mismatches: number;
        persistentMismatches?: number;
        // ── raw detail, local-only ─────────────────────────────────────────
        compared?: number;
        missingCompleteRevision?: number;
        fieldMismatch?: number;
        extraMessage?: number;
        wrongSession?: number;
        wrongOwner?: number;
        digestMismatch?: number;
        sessionsObserved?: number;
        sessionsRepeated?: number;
        pendingMissingRevisits?: number;
        pendingMissingOpen?: number;
        since?: number;
    };
    /**
     * Include the LOCAL-ONLY P22/P24 diagnostics (applyRejects, stalledStreams,
     * throughput, syncHotspots).
     *
     * Defaults to FALSE, so the fields are absent unless a caller explicitly
     * opts in. The status reporter leaves it off; `get_status_metadata` turns
     * it on. The cloud allow-list would drop them regardless — this just keeps
     * the deduped status frame from carrying fields it will never forward.
     */
    includeLocalDiagnostics?: boolean;
    /**
     * The throughput collector's published snapshot. Only read when
     * `includeLocalDiagnostics` is set.
     *
     * ★ Pass the collector's `snapshot()`, never a fresh `node.stats()`:
     * stats() drains the interval counters, so a second reader silently halves
     * everyone's numbers (seqscribe/throughput-collector.ts).
     */
    throughput?: SeqscribeThroughputSnapshot | null;
    /**
     * Stage 4A read-routing counters (`meshReadRoutingCounters()`). Only read
     * when `includeLocalDiagnostics` is set — see the `readRouting` field for
     * why this must not ride the deduped status frame.
     */
    readRouting?: {
        fromReplica: number;
        fromLedger: number;
        fallbacks: Record<string, number>;
    } | null;
    /**
     * Transcript trigger attribution + stage latencies
     * (`transcriptLatencyDetail()` from seqscribe/transcript-publisher.ts). Only
     * read when `includeLocalDiagnostics` is set — see the
     * `transcriptLatencyDetail` field for why this must not ride the deduped
     * status frame.
     */
    transcriptLatency?: TranscriptLatencyDetail | null;
}

export function summarizeSeqscribeStats(
    stats: NodeStats,
    opts: SummarizeOptions,
): SeqscribeStatusSummary {
    let maxPending = 0;
    let maxLag = 0;
    let maxCertAgeMs = 0;
    let quarantined = false;
    let topics = 0;

    for (const topic of Object.values(stats.topics)) {
        topics++;
        if (topic.pending > maxPending) maxPending = topic.pending;
        if (topic.quarantined > 0) quarantined = true;
        if (topic.certOrderAgeMs !== null && topic.certOrderAgeMs > maxCertAgeMs) {
            maxCertAgeMs = topic.certOrderAgeMs;
        }
        for (const consumer of Object.values(topic.consumers)) {
            if (consumer.lagRows > maxLag) maxLag = consumer.lagRows;
        }
    }

    let maxQueued = 0;
    let peersReady = 0;
    for (const peer of stats.peers) {
        if (peer.queuedData > maxQueued) maxQueued = peer.queuedData;
        if (peer.state === 'ready') peersReady++;
    }

    // LOCAL-ONLY diagnostics, computed from the SAME `stats` object the
    // aggregates above came from, so the numbers in one response are mutually
    // consistent. Opt-in — see `includeLocalDiagnostics`.
    let localDiagnostics: Partial<SeqscribeStatusSummary> = {};
    if (opts.includeLocalDiagnostics) {
        let applyRejects = 0;
        for (const topic of Object.values(stats.topics)) {
            for (const count of Object.values(topic.applyRejects ?? {})) {
                if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
                    applyRejects += count;
                }
            }
        }
        let stalledStreams = 0;
        for (const peer of stats.peers) {
            const stalled = peer.stalledStreams;
            if (typeof stalled === 'number' && Number.isFinite(stalled) && stalled > 0) {
                stalledStreams += stalled;
            }
        }
        const snap = opts.throughput;
        // Copy the counters rather than aliasing the module's live maps, so a
        // later read cannot mutate a snapshot a caller is still holding.
        const routing = opts.readRouting;
        const tp = opts.transcriptParity;
        // `since` defaults to now rather than 0 when a caller passes only the
        // three bucket fields: a 0 stamp would render as a 1970 date and read as
        // "counting for 56 years", the opposite of the honesty this field is for.
        const tpSince = tp?.since ?? Date.now();
        localDiagnostics = {
            applyRejects,
            stalledStreams,
            ...(tp
                ? {
                      transcriptParityDetail: {
                          runs: tp.runs,
                          compared: tp.compared ?? 0,
                          mismatches: tp.mismatches,
                          persistentMismatches: tp.persistentMismatches ?? 0,
                          missingCompleteRevision: tp.missingCompleteRevision ?? 0,
                          fieldMismatch: tp.fieldMismatch ?? 0,
                          extraMessage: tp.extraMessage ?? 0,
                          wrongSession: tp.wrongSession ?? 0,
                          wrongOwner: tp.wrongOwner ?? 0,
                          digestMismatch: tp.digestMismatch ?? 0,
                          sessionsObserved: tp.sessionsObserved ?? 0,
                          sessionsRepeated: tp.sessionsRepeated ?? 0,
                          pendingMissingRevisits: tp.pendingMissingRevisits ?? 0,
                          pendingMissingOpen: tp.pendingMissingOpen ?? 0,
                          since: tpSince,
                          uptimeMs: Math.max(0, Date.now() - tpSince),
                      },
                  }
                : {}),
            // Deep-copied by the recorder's own `detail()`, so a caller holding
            // this cannot see it mutate on the next trigger.
            ...(opts.transcriptLatency ? { transcriptLatencyDetail: opts.transcriptLatency } : {}),
            // Emitted only when the caller passed the full counter object. A
            // status-reporter caller supplying just the five bucket fields
            // leaves these undefined, and the key is then omitted entirely
            // rather than reported as a fabricated zero — "not measured" and
            // "measured zero" are different answers to "is the throttle
            // coalescing?", and only one of them is honest here.
            ...(opts.transcript && typeof opts.transcript.ptyDirtyCoalesced === 'number'
                ? {
                      transcriptCounterDetail: {
                          ptyDirtyCoalesced: opts.transcript.ptyDirtyCoalesced,
                          emptyGuarded: opts.transcript.emptyGuarded ?? 0,
                          collectorUnavailable: opts.transcript.collectorUnavailable ?? 0,
                          sourcePending: opts.transcript.sourcePending ?? 0,
                      },
                  }
                : {}),
            ...(routing
                ? {
                      readRouting: {
                          fromReplica: routing.fromReplica,
                          fromLedger: routing.fromLedger,
                          fallbacks: { ...routing.fallbacks },
                      },
                  }
                : {}),
            ...(snap
                ? {
                      throughput: {
                          intervalMs: snap.intervalMs,
                          servedEntries: snap.totals.servedEntries,
                          servedBytes: snap.totals.servedBytes,
                          appliedEntries: snap.totals.appliedEntries,
                          appliedBytes: snap.totals.appliedBytes,
                          wantRoundsRequested: snap.totals.wantRoundsRequested,
                          wantRoundsServed: snap.totals.wantRoundsServed,
                      },
                      syncHotspots: snap.hotspots.map((h) => ({ ...h })),
                  }
                : {}),
        };
    }

    return {
        topics,
        peers: stats.peers.length,
        peersReady,
        pendingBucket: bucket(maxPending, BACKLOG_BUCKETS),
        consumerLagBucket: bucket(maxLag, BACKLOG_BUCKETS),
        queueBucket: bucket(maxQueued, BACKLOG_BUCKETS),
        fgenAgeBucket: bucket(maxCertAgeMs / (60 * 60 * 1000), FGEN_AGE_BUCKETS_H),
        quarantined,
        authority: opts.authorityEnabled,
        dualWrite: opts.dualWrite?.active ?? false,
        dualWriteFailedBucket: bucket(opts.dualWrite?.failed ?? 0, BACKLOG_BUCKETS),
        dualWriteDroppedBucket: bucket(opts.dualWrite?.dropped ?? 0, BACKLOG_BUCKETS),
        dualWriteBackfilledBucket: bucket(opts.dualWrite?.backfilled ?? 0, BACKLOG_BUCKETS),
        parityMismatchBucket: bucket(opts.parity?.mismatches ?? 0, BACKLOG_BUCKETS),
        parityPersistentMismatchBucket: bucket(
            opts.parity?.persistentMismatches ?? 0,
            BACKLOG_BUCKETS,
        ),
        parityRan: (opts.parity?.runs ?? 0) > 0,
        parityMissingInShadowBucket: bucket(opts.parity?.missingInShadow ?? 0, BACKLOG_BUCKETS),
        parityExtraInShadowBucket: bucket(opts.parity?.extraInShadow ?? 0, BACKLOG_BUCKETS),
        parityFieldMismatchBucket: bucket(opts.parity?.fieldMismatch ?? 0, BACKLOG_BUCKETS),
        transcriptPublish: opts.transcript?.active ?? false,
        transcriptPublishedBucket: bucket(opts.transcript?.published ?? 0, BACKLOG_BUCKETS),
        transcriptPublishFailedBucket: bucket(opts.transcript?.publishFailed ?? 0, BACKLOG_BUCKETS),
        transcriptDedupedBucket: bucket(opts.transcript?.deduped ?? 0, BACKLOG_BUCKETS),
        transcriptOversizedBucket: bucket(opts.transcript?.oversized ?? 0, BACKLOG_BUCKETS),
        transcriptDroppedBucket: bucket(opts.transcript?.dropped ?? 0, BACKLOG_BUCKETS),
        transcriptParityRan: (opts.transcriptParity?.runs ?? 0) > 0,
        transcriptParityMismatchBucket: bucket(opts.transcriptParity?.mismatches ?? 0, BACKLOG_BUCKETS),
        transcriptParityPersistentMismatchBucket: bucket(
            opts.transcriptParity?.persistentMismatches ?? 0,
            BACKLOG_BUCKETS,
        ),
        ...localDiagnostics,
    };
}
