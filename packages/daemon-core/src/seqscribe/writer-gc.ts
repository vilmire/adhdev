/**
 * Transcript topic housekeeping — the daemon-side hard cap G2b's retention
 * switch needs (design §7e G2, owner decision 2026-09-24).
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * `topics.ts#sessionTranscriptPolicy` switched `session.<id>.transcript` from
 * `retention: {mode:'ring', size:500}` to `retention: {mode:'full'}` — see
 * that function's doc comment for the full reasoning. `full` retention writes
 * a real durable `sq_log` row per message and is bounded, in the vendor
 * library, by exactly one mechanism: `ArchiveHub` moving cert-covered rows to
 * `sq_archive` once (a) a finality certificate has cut the topic and (b)
 * every registered consumer's cursor has advanced past the cut
 * (`oss/vendor/seqscribe/src/archive.ts`). Two gaps that leaves open:
 *
 *   1. Certification is the COORDINATOR-ONLY hourly `startFleetFinalityLoop`
 *      (`authority.ts`, gated on `opts.isCoordinator && fleetAuthority` —
 *      i.e. a FLEET authority specifically, never a local one, `node.ts`
 *      ~line 274), and it only certifies the STATIC topic list
 *      `contentTopicsFor(baseTopicDefinitions(...))` computed once at boot.
 *      Per-session transcript topics are defined ON DEMAND, after boot
 *      (`transcript-activation.ts`), so they are never in that list — this
 *      module does not add them to it (that is future work, a `node.ts`
 *      change outside this file's ownership); today no transcript topic is
 *      ever certified by that loop regardless of fleet-vs-local authority.
 *   2. Even where a fleet authority DOES exist for some future wiring,
 *      `ArchiveHub.archiveNow()` moves rows to `sq_archive` — it does not
 *      shrink `sq_log`'s row COUNT the way "prune" implies, and archiving
 *      only starts once a cert exists (`archive.ts`: "no cert → no
 *      compaction"). A long chat session between certs can accumulate
 *      unboundedly many rows before the first archive pass ever runs.
 *
 * Owner decision (2026-09-24), split by whether a fleet authority exists:
 *   (a) fleet authority present → bound via the existing cert+`ArchiveHub`
 *       cursor mechanism (folding transcript topics into the certification
 *       loop is the follow-up noted above, not done here).
 *   (b) no fleet authority (the common case — standalone, or a fleet daemon
 *       that has not yet folded transcript topics into (a)) → a per-topic
 *       HARD CAP enforced locally by THIS module: prune entries older than
 *       `TRANSCRIPT_PRUNE_MAX_AGE_MS` (default 7 days) or beyond
 *       `TRANSCRIPT_PRUNE_MAX_ENTRIES` (default 5,000).
 *
 * ── The vendor primitive this module needed has landed ─────────────────────
 * The gap noted in the original version of this module (`Node.retireTopic`/
 * `gcWriters` refuse on any topic with durable rows; `Store.deleteLogRange`
 * is store-internal, not exposed on `Node`; `ArchiveHub.archiveCovered` is
 * cert-gated) is now closed by `Node.pruneTopic(topic, {olderThanMs?,
 * keepNewest?}): Promise<{prunedRows: number}>` (`oss/vendor/seqscribe/src/
 * node.ts`, backed by `LogCore#processPruneTopic` in `log.ts`). It:
 *
 *   - only accepts `full`-retention, non-`full-sync` (i.e. `subscribe-only`),
 *     non-`register` topics — exactly this module's target shape, and it
 *     re-checks that shape itself, so this module does not duplicate the
 *     precondition;
 *   - goes through the same internal write queue `deleteLogRange`'s other
 *     callers use, so it never races a concurrent append;
 *   - never deletes past any registered `onEntry` consumer's cursor
 *     (`store.cursorsForTopic`), the same floor `ArchiveHub.archiveNow`
 *     honors;
 *   - REFUSES outright (`ERR_MISUSE`, message containing "active tail
 *     subscriber") while a `tail`-view SUB subscriber is attached to the
 *     topic — there is no per-subscriber durable cursor to narrow around,
 *     so the library blocks the whole call rather than silently serving a
 *     truncated window out from under a live subscriber. This module treats
 *     that specific refusal as a SKIPPED topic (debug log + `skippedActive`
 *     counter), not an error — a live transcript with an attached viewer is
 *     the expected common case, not a fault.
 *
 * ── Prune policy: two INDEPENDENT bounds, not one intersected call ─────────
 * The owner decision is "prune entries older than `maxAgeMs` OR beyond
 * `maxEntries`" — either cap alone should be enough to shrink a topic. But
 * `pruneTopic(topic, {olderThanMs, keepNewest})` does NOT implement an OR of
 * its two bounds: when both are given in ONE call, the vendor deletes only
 * rows that satisfy BOTH (`log.ts#processPruneTopic`: `belowRowid =
 * min(cursorFloor, keepNewestFloor)`, then the store DELETE additionally
 * requires `hlc_l < hlcBefore` — an intersection, confirmed against the
 * vendor's own test, "both bounds given: the intersection applies (never
 * prunes more than either bound alone would)"). A single combined call
 * therefore makes the ROW cap silently unenforceable for a fast-growing,
 * still-recent session: every row is younger than `maxAgeMs` (default 7
 * days), so the age condition admits nothing, and the count-over-cap rows
 * survive right along with everything else — exactly the case this sweep
 * exists to bound.
 *
 * So this sweep makes TWO separate `pruneTopic` calls per topic, one bound
 * each — an explicit OR, matching the owner decision's actual wording:
 *
 *   1. `{keepNewest: maxEntries}` alone — enforces the row-count cap
 *      immediately regardless of age.
 *   2. `{olderThanMs: maxAgeMs}` alone — enforces the age cap regardless of
 *      count, for a topic under the row cap but whose few rows are stale
 *      (e.g. an old session nobody ever revisits).
 *
 * Both calls run on every currently-defined transcript topic, every sweep
 * tick — cheap enough at the sweep's hourly cadence
 * (`TRANSCRIPT_PRUNE_INTERVAL_MS`, matching the coordinator's own
 * finality-loop order of magnitude) even across a large fleet's worth of
 * concurrently open sessions, and each call is independently idempotent (a
 * topic already within a bound is `prunedRows: 0` on that call, a documented
 * vendor no-op — see `prune-topic.test.ts` "is idempotent"). This sweep does
 * NOT pre-filter by `logRows > maxEntries` before calling (unlike the
 * pre-vendor-primitive version, which used `logRows` as its only signal
 * because it had nothing else to call) — `overCapTopics` still only counts
 * topics whose `logRows` exceeds `maxEntries` at read time, a distinct
 * question from "did a prune run", and stays useful as a health signal
 * independent of whether pruning succeeded, was skipped, or was a no-op.
 */

import { LOG } from '../logging/logger.js';
import type { SeqscribeNodeHandle } from './node.js';

/** Default age cap — prune entries older than this. */
export const TRANSCRIPT_PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default row-count cap — prune down to at most this many durable entries per topic. */
export const TRANSCRIPT_PRUNE_MAX_ENTRIES = 5_000;

/** Sweep cadence. Same order of magnitude as the coordinator's finality loop (`FINALITY_INTERVAL_MS`, 1h) — this is local housekeeping, not time-critical. */
export const TRANSCRIPT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const TRANSCRIPT_TOPIC_PREFIX = 'session.';
const TRANSCRIPT_TOPIC_SUFFIX = '.transcript';

function isTranscriptTopic(topic: string): boolean {
    return topic.startsWith(TRANSCRIPT_TOPIC_PREFIX) && topic.endsWith(TRANSCRIPT_TOPIC_SUFFIX);
}

/**
 * The vendor's `pruneTopic` refuses with `ERR_MISUSE` for several distinct
 * shape reasons (register-kind, full-sync, non-full retention) as well as
 * for an active tail subscriber — all as the SAME error code (`log.ts`'s
 * `misuse()` always mints `ERR_MISUSE`), so the only way to distinguish the
 * "active tail subscriber, try again later" case from a genuine shape defect
 * is the message text the vendor test suite pins
 * (`prune-topic.test.ts` "an active tail subscriber blocks pruning outright":
 * `` `pruneTopic: topic has an active tail subscriber (${topic})` ``).
 * Matching on a stable substring rather than the full message keeps this
 * resilient to topic-name interpolation differences.
 */
const ACTIVE_TAIL_SUBSCRIBER_MARKER = 'active tail subscriber';

function isActiveTailSubscriberRefusal(error: unknown): boolean {
    return error instanceof Error && error.message.includes(ACTIVE_TAIL_SUBSCRIBER_MARKER);
}

export interface TranscriptWriterGcCounters {
    /** Sweep passes run. */
    runs: number;
    /** `session.*.transcript` topics inspected across all sweeps (cumulative, not distinct). */
    topicsInspected: number;
    /** Times a topic was found over either cap (row-count signal only — see module header). */
    overCapTopics: number;
    /** Rows actually pruned, summed across every `pruneTopic` call this process has made. */
    rowsPruned: number;
    /**
     * Times a TOPIC's sweep pass was skipped because it has an active `tail`
     * SUB subscriber (the vendor's own precondition — see module header).
     * Counted once per topic per sweep even though two `pruneTopic` calls are
     * attempted (count bound, then age bound) — the sweep stops after the
     * first refusal for that topic rather than double-counting or attempting
     * the second bound against a topic already known to refuse. Not an
     * error: a transcript with a live viewer attached is the expected common
     * case, and the sweep simply retries it next tick.
     */
    skippedActive: number;
    /** Sweep failures (node error, a genuine prune failure other than the active-subscriber refusal, etc.) — swallowed so one bad tick never stops the next. */
    errors: number;
}

let counters: TranscriptWriterGcCounters = {
    runs: 0,
    topicsInspected: 0,
    overCapTopics: 0,
    rowsPruned: 0,
    skippedActive: 0,
    errors: 0,
};

/** Current counters. Local-only diagnostics — see `local-stats.ts` callers. */
export function transcriptWriterGcCounters(): TranscriptWriterGcCounters {
    return { ...counters };
}

/** Reset counters. TESTS ONLY. */
export function __resetTranscriptWriterGcForTests(): void {
    counters = { runs: 0, topicsInspected: 0, overCapTopics: 0, rowsPruned: 0, skippedActive: 0, errors: 0 };
}

export interface TranscriptWriterGcOptions {
    maxAgeMs?: number;
    maxEntries?: number;
    /** Injected for tests; defaults to `Date.now`. */
    now?: () => number;
}

/**
 * Prune one topic against a SINGLE bound (see module header for why this is
 * two separate calls rather than one combined `{olderThanMs, keepNewest}`
 * call). Shared by both bound applications below so the active-tail-
 * subscriber skip / error accounting stays identical for either axis.
 *
 * Returns `'skippedActive'` when the vendor refused because a `tail`
 * subscriber is attached (counted, not an error — the caller should not
 * attempt the OTHER bound's call either, since the refusal applies to the
 * whole topic, not to one bound).
 */
async function pruneOneBound(
    handle: SeqscribeNodeHandle,
    topic: string,
    bound: { olderThanMs: number } | { keepNewest: number },
): Promise<'pruned' | 'skippedActive' | 'error'> {
    try {
        const result = await handle.node.pruneTopic(topic, bound);
        if (result.prunedRows > 0) {
            counters.rowsPruned += result.prunedRows;
            LOG.info(
                'Seqscribe',
                `transcript writer-gc pruned topic=${topic} rows=${result.prunedRows} bound=${JSON.stringify(bound)}`,
            );
        }
        return 'pruned';
    } catch (error) {
        if (isActiveTailSubscriberRefusal(error)) {
            LOG.debug(
                'Seqscribe',
                `transcript writer-gc skipped topic=${topic}: active tail subscriber`,
            );
            return 'skippedActive';
        }
        counters.errors++;
        LOG.warn(
            'Seqscribe',
            `transcript writer-gc prune failed topic=${topic}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 'error';
    }
}

/**
 * One sweep: inspect every currently-defined `session.*.transcript` topic's
 * durable row count via `node.stats()` (pure read, P31 — safe to call from
 * any cadence, does not disturb the P24 interval counters) for the
 * `overCapTopics` health counter, then call `node.pruneTopic` TWICE per
 * topic — once for the row-count cap, once for the age cap (see module
 * header for why these must not be combined into one call).
 *
 * Never throws — this is housekeeping, matching every other seqscribe
 * background loop's never-throws contract (`fleet-status-parity.ts`,
 * `probe.ts`).
 */
export async function runTranscriptWriterGcSweep(
    handle: SeqscribeNodeHandle,
    opts: TranscriptWriterGcOptions = {},
): Promise<{ overCap: { topic: string; logRows: number }[] }> {
    const maxEntries = Math.max(1, opts.maxEntries ?? TRANSCRIPT_PRUNE_MAX_ENTRIES);
    const maxAgeMs = opts.maxAgeMs ?? TRANSCRIPT_PRUNE_MAX_AGE_MS;
    const overCap: { topic: string; logRows: number }[] = [];
    counters.runs++;
    try {
        const stats = handle.node.stats();
        for (const [topic, topicStats] of Object.entries(stats.topics)) {
            if (!isTranscriptTopic(topic)) continue;
            counters.topicsInspected++;
            const logRows = topicStats.logRows;
            if (logRows > maxEntries) {
                overCap.push({ topic, logRows });
                counters.overCapTopics++;
            }

            const countResult = await pruneOneBound(handle, topic, { keepNewest: maxEntries });
            if (countResult === 'skippedActive') {
                counters.skippedActive++;
                continue;
            }
            // The age-bound call is independent of the outcome of the
            // count-bound call above (both are meant to apply, OR-style) —
            // an error on one bound must not suppress the other.
            const ageResult = await pruneOneBound(handle, topic, { olderThanMs: maxAgeMs });
            if (ageResult === 'skippedActive') {
                counters.skippedActive++;
            }
        }
    } catch (error) {
        counters.errors++;
        LOG.warn(
            'Seqscribe',
            `transcript writer-gc sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    return { overCap };
}

export interface TranscriptWriterGcHandle {
    /** Run one sweep immediately (tests, or an on-demand trigger). */
    runOnce: () => Promise<{ overCap: { topic: string; logRows: number }[] }>;
    stop(): void;
}

let activeTimer: ReturnType<typeof setInterval> | null = null;
let activeHandle: SeqscribeNodeHandle | null = null;

/**
 * Arm/disarm the process-wide periodic sweep. Mirrors
 * `fleet-status-parity.ts#configureFleetStatusParity`'s self-arming shape —
 * `.unref()`ed so it never keeps the process alive, calling with `null`
 * disarms.
 *
 * Armed from `boot/stages/seqscribe-projections.ts`'s `armSeqscribeProjections`
 * arm/disarm chain, immediately after the transcript projection step — see
 * that file for the exact ordering.
 */
export function configureTranscriptWriterGc(
    handle: SeqscribeNodeHandle | null,
    opts: TranscriptWriterGcOptions & { intervalMs?: number; once?: boolean } = {},
): TranscriptWriterGcHandle | null {
    if (activeTimer) clearInterval(activeTimer);
    activeTimer = null;
    activeHandle = null;

    if (!handle) return null;

    activeHandle = handle;
    const ownedHandle = handle;
    const runOnce = () => runTranscriptWriterGcSweep(ownedHandle, opts);

    if (!opts.once) {
        activeTimer = setInterval(() => {
            void runOnce();
        }, Math.max(1, opts.intervalMs ?? TRANSCRIPT_PRUNE_INTERVAL_MS));
        activeTimer.unref?.();
    }
    LOG.info('Seqscribe', 'transcript writer-gc armed');

    return {
        runOnce: () => activeHandle === ownedHandle ? runOnce() : Promise.resolve({ overCap: [] }),
        stop(): void {
            if (activeHandle !== ownedHandle) return;
            configureTranscriptWriterGc(null);
        },
    };
}
