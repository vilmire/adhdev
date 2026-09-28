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
 *       `TRANSCRIPT_PRUNE_MAX_ENTRIES` (default 600 — see that constant for
 *       why it is derived from the tail window, not a round number).
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
 *   - while a `tail`-view SUB subscriber is attached, prunes only strictly
 *     BELOW the tail window (the newest `TRANSCRIPT_TAIL_WINDOW_ROWS` rows a
 *     SNAP(reset) can serve — no subscriber state re-reads anything older),
 *     and REFUSES outright (`ERR_MISUSE`, message containing "active tail
 *     subscriber") a call whose floor would reach into that window. This
 *     module's count-bound steps always keep `rows - step >=
 *     TRANSCRIPT_PRUNE_MAX_ENTRIES > TRANSCRIPT_TAIL_WINDOW_ROWS` rows, so
 *     they proceed on a watched topic; only an age-bound call that would dip
 *     into the window is refused. This module treats that refusal as a
 *     SKIPPED topic (debug log + `skippedActive` counter), not an error.
 *     (Before 2026-09-28 the library refused EVERY prune while subscribed, so
 *     a session with a permanently open viewer was never pruned — measured
 *     160k rows / 2.3 GB on one topic.)
 *   - computes the `keepNewest` floor with a rowid-only index walk. It used
 *     to read the kept rows in full, which for this module's
 *     `keepNewest = rows - step` calls was a whole-topic materialization —
 *     the 2026-09-28 preview-daemon OOM (V8 heap exhausted from the append
 *     queue's flush timer).
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
 * Both bounds run on every transcript topic the sweep reaches, and each is
 * independently idempotent (a topic already within a bound is `prunedRows:
 * 0`, a documented vendor no-op — see `prune-topic.test.ts` "is idempotent").
 * `overCapTopics` still only counts topics whose `logRows` exceeds
 * `maxEntries` at read time — a health signal independent of whether
 * pruning succeeded, was skipped, or was a no-op.
 *
 * ── Which topics: defined here OR merely present on disk ───────────────────
 * Transcript topics are defined on demand (`transcript-activation.ts`), so
 * `node.stats().topics` only lists sessions this process has touched. A
 * session that died before the last restart keeps its rows forever unless
 * the sweep also looks at the DB itself (measured 2026-09-27: every one of
 * the 20 transcript topics holding the preview copy's 318 MB was undefined
 * in the running process). Each sweep therefore also discovers
 * `session.<seg>.transcript` topics that have writer heads on disk
 * (`maintenance.storedTopicsLike`, read-only), keeps only those that
 * actually have prunable rows (`topicHasPrunableRows`, two index lookups),
 * and defines up to `TRANSCRIPT_DISCOVERY_MAX_TOPICS_PER_SWEEP` of them with
 * the same `sessionTranscriptPolicy()` — a bare `node.defineTopic`, WITHOUT
 * the claim, `node.topics` push or activation announcement that
 * `ensureSessionTranscriptTopic` performs. Not being in `node.topics` means
 * no transport grants it (grants are derived from `node.topics`), so the
 * housekeeping define exposes nothing to peers; `defineTopic` with an
 * identical policy is idempotent in the library, so a later real activation
 * of the same session still defines, pushes and announces normally.
 *
 * ── Bounded work per sweep ─────────────────────────────────────────────────
 * One `pruneTopic` call deletes its whole range inside the library's append
 * flush, synchronously. A transcript row can be ~36 KB (a revision chunk),
 * so an unbounded call on a 5,000-row topic is a multi-hundred-ms stall.
 * The sweep therefore walks each bound down in steps of at most
 * `TRANSCRIPT_PRUNE_STEP_ROWS` rows (count bound: `keepNewest = rows -
 * step`; age bound: `{olderThanMs, keepNewest: rows - step}` — the
 * library's intersection semantics are exactly the "at most `step` of the
 * oldest rows, and only the old ones" we want), yields to the event loop
 * between steps, and stops at `TRANSCRIPT_PRUNE_SWEEP_ROW_BUDGET` rows per
 * sweep. A sweep that ran out of budget schedules a follow-up after
 * `TRANSCRIPT_PRUNE_CONTINUATION_DELAY_MS` instead of waiting an hour.
 *
 * ── Space reclaim ──────────────────────────────────────────────────────────
 * After pruning, the sweep runs `PRAGMA incremental_vacuum` in steps of
 * `INCREMENTAL_VACUUM_PAGES_PER_STEP` pages (at most
 * `INCREMENTAL_VACUUM_MAX_STEPS_PER_SWEEP` steps, yielding between them) and
 * then `wal_checkpoint(TRUNCATE)`. This only does anything once the DB is in
 * `auto_vacuum = INCREMENTAL` mode — new DBs are created that way
 * (`node.ts`), and existing ones are converted once at shutdown by
 * `db-maintenance.ts#compactSeqscribeDbAtShutdown`.
 */

import { LOG } from '../logging/logger.js';
import type { SeqscribeNodeHandle } from './node.js';
import { sessionTranscriptPolicy } from './topics.js';
import { MAX_TRANSCRIPT_REVISION_ROWS } from './transcript-revision-codec.js';

/** Default age cap — prune entries older than this. */
export const TRANSCRIPT_PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Rows the vendor's `tail` SUB view serves for a `full`-retention topic —
 * mirrors `FULL_TAIL_DEFAULT` in `oss/vendor/seqscribe/src/subs.ts`, which
 * the library does not export. `writer-gc.test.ts` reads the vendor source
 * and fails if the two drift apart.
 */
export const TRANSCRIPT_TAIL_WINDOW_ROWS = 500;

/** Extra rows kept above the tail window so a prune never races the window edge. */
export const TRANSCRIPT_PRUNE_MARGIN_ROWS = 100;

/**
 * Default row-count cap — prune down to at most this many durable entries per
 * topic. Readers only ever see the tail window (`TRANSCRIPT_TAIL_WINDOW_ROWS`)
 * and only use the latest COMPLETE revision in it
 * (`TranscriptRevisionAssembler`); a revision is at most
 * `MAX_TRANSCRIPT_REVISION_ROWS` rows, so the cap must also hold one complete
 * revision plus one in-flight one. Rows older than that are unreachable by any
 * reader — the old 5,000 kept ten tail windows of dead weight per session.
 */
export const TRANSCRIPT_PRUNE_MAX_ENTRIES =
    Math.max(TRANSCRIPT_TAIL_WINDOW_ROWS, 2 * MAX_TRANSCRIPT_REVISION_ROWS) + TRANSCRIPT_PRUNE_MARGIN_ROWS;

/** Sweep cadence. Same order of magnitude as the coordinator's finality loop (`FINALITY_INTERVAL_MS`, 1h) — this is local housekeeping, not time-critical. */
export const TRANSCRIPT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** First sweep after arming — soon enough to drain a backlog left by a previous process, late enough to stay off the boot path. */
export const TRANSCRIPT_PRUNE_INITIAL_DELAY_MS = 5 * 60 * 1000;

/** Follow-up delay when a sweep stopped at its row budget with work left. */
export const TRANSCRIPT_PRUNE_CONTINUATION_DELAY_MS = 30 * 1000;

/**
 * Max rows one `pruneTopic` call may delete (one synchronous library flush).
 * Measured on a preview DB copy (2026-09-27, ~19 KB average transcript row):
 * 1,000-row steps took p50 80 ms / max 630 ms, 250-row steps p50 ~150 ms
 * under concurrent disk load — the tail is WAL checkpoint I/O, so a smaller
 * step mostly trims the worst case.
 */
export const TRANSCRIPT_PRUNE_STEP_ROWS = 250;

/** Max rows one sweep deletes across all topics before deferring to a continuation. */
export const TRANSCRIPT_PRUNE_SWEEP_ROW_BUDGET = 20_000;

/** Max on-disk-only transcript topics one sweep newly defines for pruning. */
export const TRANSCRIPT_DISCOVERY_MAX_TOPICS_PER_SWEEP = 32;

/** Pages one `PRAGMA incremental_vacuum(N)` step may free (4 MiB at the default 4 KiB page). */
export const INCREMENTAL_VACUUM_PAGES_PER_STEP = 1_024;

/** Max incremental-vacuum steps after one sweep (bounds a sweep's reclaim to ~256 MiB). */
export const INCREMENTAL_VACUUM_MAX_STEPS_PER_SWEEP = 64;

const TRANSCRIPT_TOPIC_PREFIX = 'session.';
const TRANSCRIPT_TOPIC_SUFFIX = '.transcript';
/** SQL LIKE pattern for discovery; the JS check below is authoritative. */
const TRANSCRIPT_TOPIC_LIKE = 'session.%.transcript';
/** A discovered topic must be exactly `session.<one sanitized segment>.transcript` (topics.ts#safeSessionId alphabet). */
const DISCOVERED_TRANSCRIPT_TOPIC_RE = /^session\.[a-z0-9_-]+\.transcript$/;

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
    /** On-disk-only transcript topics newly defined for pruning (see module header, "Which topics"). */
    topicsDiscovered: number;
    /** Times a topic was found over either cap (row-count signal only — see module header). */
    overCapTopics: number;
    /** Rows actually pruned, summed across every `pruneTopic` call this process has made. */
    rowsPruned: number;
    /**
     * Times a TOPIC's sweep pass was skipped because the vendor refused a
     * prune reaching into the tail window of a topic with an active `tail`
     * SUB subscriber (see module header).
     * Counted once per topic per sweep; the sweep stops working on that
     * topic after the first refusal. Not an error: a transcript with a live
     * viewer attached is the expected common case, and the sweep simply
     * retries it next tick.
     */
    skippedActive: number;
    /** Sweeps that stopped at `TRANSCRIPT_PRUNE_SWEEP_ROW_BUDGET` with work left (a continuation was scheduled). */
    budgetExhausted: number;
    /** Pages returned to the OS by the post-sweep incremental vacuum. */
    vacuumedPages: number;
    /** Sweep failures (node error, a genuine prune failure other than the active-subscriber refusal, etc.) — swallowed so one bad tick never stops the next. */
    errors: number;
}

function zeroCounters(): TranscriptWriterGcCounters {
    return {
        runs: 0,
        topicsInspected: 0,
        topicsDiscovered: 0,
        overCapTopics: 0,
        rowsPruned: 0,
        skippedActive: 0,
        budgetExhausted: 0,
        vacuumedPages: 0,
        errors: 0,
    };
}

let counters: TranscriptWriterGcCounters = zeroCounters();

/** Current counters. Local-only diagnostics — see `local-stats.ts` callers. */
export function transcriptWriterGcCounters(): TranscriptWriterGcCounters {
    return { ...counters };
}

/** Reset counters. TESTS ONLY. */
export function __resetTranscriptWriterGcForTests(): void {
    counters = zeroCounters();
}

export interface TranscriptWriterGcOptions {
    maxAgeMs?: number;
    maxEntries?: number;
    /** Rows per `pruneTopic` call (default `TRANSCRIPT_PRUNE_STEP_ROWS`). */
    stepRows?: number;
    /** Rows per sweep (default `TRANSCRIPT_PRUNE_SWEEP_ROW_BUDGET`). */
    sweepRowBudget?: number;
    /** On-disk-only topics defined per sweep (default `TRANSCRIPT_DISCOVERY_MAX_TOPICS_PER_SWEEP`). */
    maxDiscoveredTopics?: number;
    /** Pages per incremental-vacuum step (default `INCREMENTAL_VACUUM_PAGES_PER_STEP`). */
    vacuumPagesPerStep?: number;
    /** Incremental-vacuum steps per sweep (default `INCREMENTAL_VACUUM_MAX_STEPS_PER_SWEEP`). */
    vacuumMaxSteps?: number;
    /** Injected for tests; defaults to `Date.now`. */
    now?: () => number;
    /** Checked between steps; returning false stops the sweep early (disarm). */
    shouldContinue?: () => boolean;
}

export interface TranscriptWriterGcSweepResult {
    overCap: { topic: string; logRows: number }[];
    /** Topics defined by this sweep's on-disk discovery. */
    discovered: string[];
    /** True when the sweep stopped at its row budget with prunable rows left. */
    budgetExhausted: boolean;
    /** Pages the post-sweep incremental vacuum returned to the OS. */
    vacuumedPages: number;
}

function emptyResult(): TranscriptWriterGcSweepResult {
    return { overCap: [], discovered: [], budgetExhausted: false, vacuumedPages: 0 };
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

type BoundOutcome =
    | { status: 'pruned'; prunedRows: number }
    | { status: 'skippedActive' }
    | { status: 'error' };

/**
 * Prune one topic against ONE bound (see module header for why the count and
 * age bounds are separate calls). Shared by every step so the
 * active-tail-subscriber skip / error accounting stays identical.
 *
 * `'skippedActive'` means the vendor refused because a `tail` subscriber is
 * attached — the caller stops working on the topic for this sweep, since the
 * refusal applies to the whole topic, not to one bound.
 */
async function pruneOneBound(
    handle: SeqscribeNodeHandle,
    topic: string,
    bound: { olderThanMs?: number; keepNewest?: number },
): Promise<BoundOutcome> {
    try {
        const result = await handle.node.pruneTopic(topic, bound);
        if (result.prunedRows > 0) {
            counters.rowsPruned += result.prunedRows;
            LOG.info(
                'Seqscribe',
                `transcript writer-gc pruned topic=${topic} rows=${result.prunedRows} bound=${JSON.stringify(bound)}`,
            );
        }
        return { status: 'pruned', prunedRows: result.prunedRows };
    } catch (error) {
        if (isActiveTailSubscriberRefusal(error)) {
            LOG.debug(
                'Seqscribe',
                `transcript writer-gc skipped topic=${topic}: active tail subscriber`,
            );
            return { status: 'skippedActive' };
        }
        counters.errors++;
        LOG.warn(
            'Seqscribe',
            `transcript writer-gc prune failed topic=${topic}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { status: 'error' };
    }
}

/**
 * Define on-disk-only transcript topics that have prunable rows, so the
 * sweep can prune them (module header, "Which topics"). Bare `defineTopic`
 * only: no claim, no `node.topics` push, no activation announcement.
 */
function discoverStoredTranscriptTopics(
    handle: SeqscribeNodeHandle,
    definedTopics: ReadonlySet<string>,
    bounds: { keepNewest: number; olderThanEpochMs: number },
    maxTopics: number,
): string[] {
    const maintenance = handle.maintenance;
    // Transcript policies name `finalityAuthority`; the library refuses to
    // define them without an authority, same gate as ensureSessionTranscriptTopic.
    if (!maintenance || !handle.authorityEnabled || maxTopics <= 0) return [];
    const discovered: string[] = [];
    for (const topic of maintenance.storedTopicsLike(TRANSCRIPT_TOPIC_LIKE)) {
        if (discovered.length >= maxTopics) break;
        if (definedTopics.has(topic) || !DISCOVERED_TRANSCRIPT_TOPIC_RE.test(topic)) continue;
        if (!maintenance.topicHasPrunableRows(topic, bounds)) continue;
        try {
            handle.node.defineTopic(topic, sessionTranscriptPolicy());
            discovered.push(topic);
            counters.topicsDiscovered++;
        } catch (error) {
            counters.errors++;
            LOG.warn(
                'Seqscribe',
                `transcript writer-gc could not define stored topic=${topic}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    if (discovered.length > 0) {
        LOG.info('Seqscribe', `transcript writer-gc discovered ${discovered.length} stored transcript topic(s) to prune`);
    }
    return discovered;
}

/**
 * Bounded incremental vacuum after a sweep (module header, "Space reclaim").
 * Returns pages freed; 0 when the DB is not in INCREMENTAL mode.
 */
async function reclaimFreePages(
    handle: SeqscribeNodeHandle,
    pagesPerStep: number,
    maxSteps: number,
    shouldContinue: () => boolean,
): Promise<number> {
    const maintenance = handle.maintenance;
    if (!maintenance) return 0;
    let freed = 0;
    for (let step = 0; step < maxSteps && shouldContinue(); step++) {
        const result = maintenance.incrementalVacuumStep(pagesPerStep);
        if (!result) break;
        freed += result.freedPages;
        if (result.remainingFreePages === 0 || result.freedPages === 0) break;
        await yieldToEventLoop();
    }
    if (freed > 0) {
        maintenance.checkpoint('TRUNCATE');
        counters.vacuumedPages += freed;
        LOG.info('Seqscribe', `transcript writer-gc incremental vacuum freed ${freed} page(s)`);
    }
    return freed;
}

/**
 * One sweep (never throws — housekeeping, matching every other seqscribe
 * background loop's contract, e.g. `fleet-status-parity.ts`, `probe.ts`):
 *
 *   1. define on-disk-only transcript topics with prunable rows (capped);
 *   2. for every defined `session.*.transcript` topic (via `node.stats()`,
 *      a pure read — P31), walk the count bound then the age bound down in
 *      bounded steps, within the sweep's row budget;
 *   3. bounded incremental vacuum + WAL checkpoint.
 */
export async function runTranscriptWriterGcSweep(
    handle: SeqscribeNodeHandle,
    opts: TranscriptWriterGcOptions = {},
): Promise<TranscriptWriterGcSweepResult> {
    const maxEntries = Math.max(1, opts.maxEntries ?? TRANSCRIPT_PRUNE_MAX_ENTRIES);
    const maxAgeMs = opts.maxAgeMs ?? TRANSCRIPT_PRUNE_MAX_AGE_MS;
    const stepRows = Math.max(1, opts.stepRows ?? TRANSCRIPT_PRUNE_STEP_ROWS);
    const now = opts.now ?? Date.now;
    const shouldContinue = opts.shouldContinue ?? (() => true);
    let budget = Math.max(1, opts.sweepRowBudget ?? TRANSCRIPT_PRUNE_SWEEP_ROW_BUDGET);
    const result = emptyResult();
    counters.runs++;
    try {
        const definedTopics = new Set(Object.keys(handle.node.stats().topics));
        result.discovered = discoverStoredTranscriptTopics(
            handle,
            definedTopics,
            { keepNewest: maxEntries, olderThanEpochMs: now() - maxAgeMs },
            opts.maxDiscoveredTopics ?? TRANSCRIPT_DISCOVERY_MAX_TOPICS_PER_SWEEP,
        );

        const stats = handle.node.stats();
        for (const [topic, topicStats] of Object.entries(stats.topics)) {
            if (!isTranscriptTopic(topic)) continue;
            if (!shouldContinue()) break;
            counters.topicsInspected++;
            let rows = topicStats.logRows;
            if (rows > maxEntries) {
                result.overCap.push({ topic, logRows: rows });
                counters.overCapTopics++;
            }

            // Count bound, stepped: each call keeps all but at most `step`
            // of the oldest rows above the cap.
            let skipped = false;
            let countErrored = false;
            let countDone = rows <= maxEntries;
            if (!countDone) {
                while (rows > maxEntries && budget > 0 && shouldContinue()) {
                    const step = Math.min(stepRows, rows - maxEntries, budget);
                    const outcome = await pruneOneBound(handle, topic, { keepNewest: rows - step });
                    if (outcome.status === 'skippedActive') { skipped = true; break; }
                    if (outcome.status === 'error') { countErrored = true; break; }
                    // Zero rows pruned = an `onEntry` consumer cursor floors the
                    // range; nothing more this axis can do this sweep.
                    if (outcome.prunedRows === 0) { countDone = true; break; }
                    rows -= outcome.prunedRows;
                    budget -= outcome.prunedRows;
                    await yieldToEventLoop();
                }
                if (rows <= maxEntries) countDone = true;
            } else {
                // Under the cap: still one (no-op) call so the vendor's own
                // preconditions — the active-subscriber refusal in particular —
                // are observed the same way for every topic.
                const outcome = await pruneOneBound(handle, topic, { keepNewest: maxEntries });
                if (outcome.status === 'skippedActive') skipped = true;
                else if (outcome.status === 'error') countErrored = true;
                else rows -= outcome.prunedRows;
            }
            if (skipped) {
                counters.skippedActive++;
                continue;
            }
            if (!countDone && !countErrored) {
                // Disarmed mid-topic: just stop. Otherwise the budget ran out
                // mid-topic — the age bound waits for the continuation so it
                // never runs as one unbounded call.
                if (!shouldContinue()) break;
                result.budgetExhausted = true;
                break;
            }

            // Age bound, stepped: `{olderThanMs, keepNewest: rows - step}` is
            // the library's intersection — only the oldest `step` rows, and
            // only those that are old. An error on the count bound must not
            // suppress this one (both bounds apply, OR-style).
            while (budget > 0 && shouldContinue()) {
                const step = Math.min(stepRows, budget);
                const bound = rows > step ? { olderThanMs: maxAgeMs, keepNewest: rows - step } : { olderThanMs: maxAgeMs };
                const outcome = await pruneOneBound(handle, topic, bound);
                if (outcome.status === 'skippedActive') { counters.skippedActive++; break; }
                if (outcome.status === 'error') break;
                rows -= outcome.prunedRows;
                budget -= outcome.prunedRows;
                // Fewer than `step` pruned = the oldest window already holds a
                // young row; rows are appended in time order, so none beyond it
                // is older.
                if (outcome.prunedRows < step || !('keepNewest' in bound)) break;
                await yieldToEventLoop();
            }
            if (budget <= 0) {
                result.budgetExhausted = true;
                break;
            }
        }
        if (result.budgetExhausted) counters.budgetExhausted++;

        result.vacuumedPages = await reclaimFreePages(
            handle,
            Math.max(1, opts.vacuumPagesPerStep ?? INCREMENTAL_VACUUM_PAGES_PER_STEP),
            Math.max(0, opts.vacuumMaxSteps ?? INCREMENTAL_VACUUM_MAX_STEPS_PER_SWEEP),
            shouldContinue,
        );
    } catch (error) {
        counters.errors++;
        LOG.warn(
            'Seqscribe',
            `transcript writer-gc sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    return result;
}

export interface TranscriptWriterGcHandle {
    /** Run one sweep immediately (tests, or an on-demand trigger). */
    runOnce: () => Promise<TranscriptWriterGcSweepResult>;
    stop(): void;
}

let activeTimer: ReturnType<typeof setInterval> | null = null;
let activeFollowUp: ReturnType<typeof setTimeout> | null = null;
let activeHandle: SeqscribeNodeHandle | null = null;

function clearFollowUp(): void {
    if (activeFollowUp) clearTimeout(activeFollowUp);
    activeFollowUp = null;
}

/**
 * Arm/disarm the process-wide periodic sweep. Mirrors
 * `fleet-status-parity.ts#configureFleetStatusParity`'s self-arming shape —
 * `.unref()`ed so it never keeps the process alive, calling with `null`
 * disarms (including a pending initial/continuation run, and an in-flight
 * sweep stops at its next step).
 *
 * Armed from `boot/stages/seqscribe-projections.ts`'s `armSeqscribeProjections`
 * arm/disarm chain, immediately after the transcript projection step — see
 * that file for the exact ordering.
 */
export function configureTranscriptWriterGc(
    handle: SeqscribeNodeHandle | null,
    opts: TranscriptWriterGcOptions & {
        intervalMs?: number;
        initialDelayMs?: number;
        continuationDelayMs?: number;
        once?: boolean;
    } = {},
): TranscriptWriterGcHandle | null {
    if (activeTimer) clearInterval(activeTimer);
    activeTimer = null;
    clearFollowUp();
    activeHandle = null;

    if (!handle) return null;

    activeHandle = handle;
    const ownedHandle = handle;
    const stillOwned = (): boolean => activeHandle === ownedHandle;
    let running = false;
    const runOnce = async (): Promise<TranscriptWriterGcSweepResult> => {
        if (!stillOwned()) return emptyResult();
        running = true;
        try {
            return await runTranscriptWriterGcSweep(ownedHandle, { ...opts, shouldContinue: stillOwned });
        } finally {
            running = false;
        }
    };
    const scheduleFollowUp = (delayMs: number): void => {
        if (!stillOwned()) return;
        clearFollowUp();
        activeFollowUp = setTimeout(() => {
            activeFollowUp = null;
            void tick();
        }, Math.max(1, delayMs));
        activeFollowUp.unref?.();
    };
    const tick = async (): Promise<void> => {
        if (running || !stillOwned()) return;
        const result = await runOnce();
        if (result.budgetExhausted) {
            scheduleFollowUp(opts.continuationDelayMs ?? TRANSCRIPT_PRUNE_CONTINUATION_DELAY_MS);
        }
    };

    if (!opts.once) {
        activeTimer = setInterval(() => {
            void tick();
        }, Math.max(1, opts.intervalMs ?? TRANSCRIPT_PRUNE_INTERVAL_MS));
        activeTimer.unref?.();
        scheduleFollowUp(opts.initialDelayMs ?? TRANSCRIPT_PRUNE_INITIAL_DELAY_MS);
    }
    LOG.info('Seqscribe', 'transcript writer-gc armed');

    return {
        runOnce,
        stop(): void {
            if (!stillOwned()) return;
            configureTranscriptWriterGc(null);
        },
    };
}
