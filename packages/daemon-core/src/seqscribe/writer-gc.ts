/**
 * seqscribe topic housekeeping — chat transcripts (design 2026-09-28,
 * message-keyed storage §4.8 and §6.2) and mesh full-sync retention (design
 * 2026-09-29 data-path audit P0-1).
 *
 * Three jobs, all without a signed authority. The first two are purely local;
 * the third deletes only below the floor every mesh peer has acknowledged:
 *
 * ── 1. Remove the v1 lane's rows (§6.2) ────────────────────────────────────
 * The whole-snapshot `session.<id>.transcript` topics were deleted with the
 * v1 lane, but their durable `sq_log` rows (measured up to 2.3 GB) stay until
 * something removes them. Every sweep discovers `session.<seg>.transcript`
 * topics that still have writer heads on disk (`maintenance.storedTopicsLike`
 * — the topic need not be defined in this process), bare-defines each with the
 * retired policy (no claim, no `node.topics` push, no announcement, so no
 * transport ever grants it) and deletes ALL of its rows with
 * `pruneTopic(t, {keepNewest})` walked down to 0 in bounded steps. Nothing
 * reads these topics any more; the `sq_writers` rows stay (a permanent
 * registry per SPEC, tens of bytes each).
 *
 * ── 2. Safety net for `session.<id>.chat` (§4.8) ───────────────────────────
 * The publisher compacts its own topics after each commit
 * (`pruneSuperseded`, transcript-keyed-publish-runtime.ts). This sweep covers
 * what that cannot: sessions whose producer died with superseded rows left,
 * and chat topics present only on disk. For each it runs
 * `pruneSuperseded(t, {uptoRowid: W})` (W = newest commit rowid) in bounded
 * steps — allowed while subscribed, never below W. `pruneTopic` is NOT used on
 * a live chat topic: dropping rows by age or count would delete live keys and
 * leave a state no commit describes. The one exception is a DEAD session —
 * its newest commit older than `TRANSCRIPT_PRUNE_MAX_AGE_MS` and no tail
 * subscriber — whose whole topic is removed.
 *
 * ── 3. Mesh full-sync retention (data-path audit P0-1) ─────────────────────
 * `mesh.<id>.events` and `mesh.<id>.handoff` are full-sync topics with no
 * finality authority issuing certificates, so nothing ever bounded them
 * (measured 2026-09-29: 66.5k rows / 19 MB on one preview mesh, growing), and
 * the library refuses `pruneTopic` on them for a good reason — a local delete
 * leaves a returning or newly added peer with a permanent gap. Each sweep runs
 * the library's acknowledged retention (`pruneAcked`, seqscribe host-guide
 * §4.8) on every such topic: a stream's rows go only when they are older than
 * `MESH_FULL_SYNC_RETENTION_MS` AND every mesh member this node has seen within
 * `MESH_FULL_SYNC_MAX_LAG_MS` has acknowledged them (its HAVE rounds on a
 * direct session, or — for a member this node only reaches through the
 * coordinator — its Beacon report, `beacon.ts` `noteBeaconAcks`) AND every
 * durable cursor (`mesh.index`, `turn.ingest`, `turn.deliver`) has read them.
 * A peer that is below the resulting floor anyway (new node, or offline past
 * max-lag) recovers with the library's TRUNCATED handshake instead of a gap.
 *
 * ★ Window = max-lag = 30 days, the same window every consumer of these
 * topics already keeps (`MESH_TOPIC_INDEX_RETENTION_MS`, the turn-ledger
 * attempt retention, the handoff ref resolver tolerating a missing entry): a
 * node bootstrapped past a floor misses only rows older than that window,
 * which its own consumers would have dropped anyway — its derived state
 * matches every other node's.
 *
 * ── Bounded work per sweep ─────────────────────────────────────────────────
 * Every call deletes at most `TRANSCRIPT_PRUNE_STEP_ROWS` rows inside one
 * library flush, the sweep yields between calls and stops at
 * `TRANSCRIPT_PRUNE_SWEEP_ROW_BUDGET`; a sweep that ran out of budget
 * schedules a follow-up after `TRANSCRIPT_PRUNE_CONTINUATION_DELAY_MS`.
 * Afterwards `PRAGMA incremental_vacuum` returns freed pages to the OS (only
 * once the DB is in `auto_vacuum = INCREMENTAL`, see db-maintenance.ts).
 */

import type { TopicPolicy } from 'seqscribe';
import { LOG } from '../logging/logger.js';
import { ADHDEV_AUTHORITY_ID } from './authority-id.js';
import type { SeqscribeNodeHandle } from './node.js';
import { sessionChatPolicy, sessionSegmentFromChatTopic } from './topics.js';
import { CHAT_COMMIT_KEY } from './transcript-keyed-codec.js';

/** A chat topic whose newest commit is older than this (and unwatched) is a dead session. */
export const TRANSCRIPT_PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Sweep cadence — local housekeeping, not time-critical. */
export const TRANSCRIPT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** First sweep after arming — drains a previous process's backlog (and the v1 rows) off the boot path. */
export const TRANSCRIPT_PRUNE_INITIAL_DELAY_MS = 5 * 60 * 1000;

/** Follow-up delay when a sweep stopped at its row budget with work left. */
export const TRANSCRIPT_PRUNE_CONTINUATION_DELAY_MS = 30 * 1000;

/**
 * Max rows one prune call may delete (one synchronous library flush). Measured
 * on a preview DB copy (2026-09-27): 250-row steps p50 ~150 ms under
 * concurrent disk load — the tail is WAL checkpoint I/O.
 */
export const TRANSCRIPT_PRUNE_STEP_ROWS = 250;

/**
 * Mesh full-sync retention window (§3): rows of `mesh.<id>.events|handoff`
 * younger than this are never deleted. Mirrors `MESH_TOPIC_INDEX_RETENTION_MS`
 * (mesh/mesh-runtime-store-turn-rows.ts — not importable from seqscribe/).
 */
export const MESH_FULL_SYNC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A mesh member (peer node) silent longer than this stops pinning the floor
 * (§3). Equal to the window on purpose — see the header's ★ note.
 */
export const MESH_FULL_SYNC_MAX_LAG_MS = MESH_FULL_SYNC_RETENTION_MS;

/** Max rows one sweep deletes across all topics before deferring to a continuation. */
export const TRANSCRIPT_PRUNE_SWEEP_ROW_BUDGET = 20_000;

/** Max on-disk-only topics one sweep newly defines (legacy and chat each). */
export const TRANSCRIPT_DISCOVERY_MAX_TOPICS_PER_SWEEP = 32;

/** Pages one `PRAGMA incremental_vacuum(N)` step may free (4 MiB at the default 4 KiB page). */
export const INCREMENTAL_VACUUM_PAGES_PER_STEP = 1_024;

/** Max incremental-vacuum steps after one sweep (bounds a sweep's reclaim to ~256 MiB). */
export const INCREMENTAL_VACUUM_MAX_STEPS_PER_SWEEP = 64;

/**
 * `assistant.journal` — retired 2026-09-29 with its only producer (the Stage 1
 * convergence probe, one 173 B heartbeat per writer per 30 min, no consumer).
 * Its rows are swept exactly like the v1 `.transcript` topics: bare-defined
 * with a retired policy and pruned to zero. The topic was `full-sync`, which
 * the library refuses to prune, so the sweep defines it LOCALLY as
 * `subscribe-only` — sound only because a bare-defined topic is never claimed,
 * announced or granted, so no peer can sync it under the changed policy.
 */
export const RETIRED_ASSISTANT_JOURNAL_TOPIC = 'assistant.journal';
/** Durable consumer the removed probe registered on the journal (would gate the prune floor). */
const RETIRED_JOURNAL_PROBE_CONSUMER = 'stage1-convergence-probe';

/** SQL LIKE patterns for discovery; the regexes below are authoritative. */
const LEGACY_TRANSCRIPT_TOPIC_LIKE = 'session.%.transcript';
const CHAT_TOPIC_LIKE = 'session.%.chat';
/** Exactly `session.<one sanitized segment>.transcript` (topics.ts#safeSessionId alphabet). */
const LEGACY_TRANSCRIPT_TOPIC_RE = /^session\.[a-z0-9_-]+\.transcript$/;
const CHAT_TOPIC_RE = /^session\.[a-z0-9_-]+\.chat$/;
/** `mesh.<sanitized meshId>.events` / `.handoff` (topics.ts meshEventsTopic / meshHandoffTopic). */
const MESH_FULL_SYNC_TOPIC_RE = /^mesh\.[a-z0-9_-]+\.(events|handoff)$/;

/** A mesh topic the full-sync retention pass (§3) bounds. */
export function isMeshFullSyncRetentionTopic(topic: string): boolean {
    return MESH_FULL_SYNC_TOPIC_RE.test(topic);
}

/** A removed `session.<id>.transcript` topic name (v1 lane, §6.2). */
export function isLegacyTranscriptTopic(topic: string): boolean {
    return LEGACY_TRANSCRIPT_TOPIC_RE.test(topic);
}

/** A retired topic whose rows this sweep deletes outright (v1 transcripts, the journal). */
export function isRetiredSweepTopic(topic: string): boolean {
    return isLegacyTranscriptTopic(topic) || topic === RETIRED_ASSISTANT_JOURNAL_TOPIC;
}

/**
 * The retired v1 transcript policy — also what the retired journal is
 * bare-defined with — needed only to define a leftover topic locally so its
 * rows can be deleted. Never announced, claimed or granted.
 */
function legacyTranscriptPolicy(): TopicPolicy {
    return {
        kind: 'append',
        retention: { mode: 'full' },
        replication: 'subscribe-only',
        access: 'content',
        finalityAuthority: ADHDEV_AUTHORITY_ID,
    };
}

/** Fragment of the vendor's refusal while a `tail` subscriber watches the window. */
const ACTIVE_TAIL_SUBSCRIBER_MARKER = 'active tail subscriber';

function isActiveTailSubscriberRefusal(error: unknown): boolean {
    return error instanceof Error && error.message.includes(ACTIVE_TAIL_SUBSCRIBER_MARKER);
}

export interface TranscriptWriterGcCounters {
    /** Sweep passes run. */
    runs: number;
    /** Chat topics inspected across all sweeps (cumulative, not distinct). */
    topicsInspected: number;
    /** On-disk-only topics newly defined for housekeeping (legacy + chat). */
    topicsDiscovered: number;
    /** Legacy `.transcript` topics fully emptied. */
    legacyTopicsCleared: number;
    /** Legacy `.transcript` rows deleted. */
    legacyRowsPruned: number;
    /** Superseded chat rows deleted by the safety net. */
    rowsPruned: number;
    /** Dead chat topics removed whole (newest commit past the age cap, unwatched). */
    deadTopicsRemoved: number;
    /** Prunes refused because a tail subscriber was attached. */
    skippedActive: number;
    /** Sweeps that stopped at `TRANSCRIPT_PRUNE_SWEEP_ROW_BUDGET` with work left. */
    budgetExhausted: number;
    /** Pages returned to the OS by the post-sweep incremental vacuum. */
    vacuumedPages: number;
    /** Mesh full-sync topics (§3) inspected across all sweeps (cumulative). */
    meshTopicsInspected: number;
    /** Mesh full-sync rows deleted below the acknowledged floor (§3). */
    meshRowsPruned: number;
    /** Gauge, last sweep: mesh streams whose floor a member's acknowledgment held down. */
    meshStreamsPinned: number;
    /** Gauge, last sweep: mesh members excluded from the floor for silence past max-lag. */
    meshLaggingMembers: number;
    /** Mesh full-sync prune calls that failed. */
    meshPruneErrors: number;
    /** Sweep failures — swallowed so one bad tick never stops the next. */
    errors: number;
}

function zeroCounters(): TranscriptWriterGcCounters {
    return {
        runs: 0,
        topicsInspected: 0,
        topicsDiscovered: 0,
        legacyTopicsCleared: 0,
        legacyRowsPruned: 0,
        rowsPruned: 0,
        deadTopicsRemoved: 0,
        skippedActive: 0,
        budgetExhausted: 0,
        vacuumedPages: 0,
        meshTopicsInspected: 0,
        meshRowsPruned: 0,
        meshStreamsPinned: 0,
        meshLaggingMembers: 0,
        meshPruneErrors: 0,
        errors: 0,
    };
}

let counters: TranscriptWriterGcCounters = zeroCounters();

/** Current counters. Local-only diagnostics. */
export function transcriptWriterGcCounters(): TranscriptWriterGcCounters {
    return { ...counters };
}

/** Reset counters. TESTS ONLY. */
export function __resetTranscriptWriterGcForTests(): void {
    counters = zeroCounters();
}

export interface TranscriptWriterGcOptions {
    /** Dead-session age cap (default `TRANSCRIPT_PRUNE_MAX_AGE_MS`). */
    maxAgeMs?: number;
    /** Mesh full-sync retention window (default `MESH_FULL_SYNC_RETENTION_MS`). */
    meshRetentionMs?: number;
    /** Mesh full-sync member max-lag (default `MESH_FULL_SYNC_MAX_LAG_MS`). */
    meshMaxLagMs?: number;
    /** Rows per prune call (default `TRANSCRIPT_PRUNE_STEP_ROWS`). */
    stepRows?: number;
    /** Rows per sweep (default `TRANSCRIPT_PRUNE_SWEEP_ROW_BUDGET`). */
    sweepRowBudget?: number;
    /** On-disk-only topics defined per sweep, per kind (default `TRANSCRIPT_DISCOVERY_MAX_TOPICS_PER_SWEEP`). */
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
    /** Legacy `.transcript` topics this sweep emptied. */
    legacyCleared: string[];
    /** Topics defined by this sweep's on-disk discovery (legacy + chat). */
    discovered: string[];
    /** True when the sweep stopped at its row budget with prunable rows left. */
    budgetExhausted: boolean;
    /** Mesh full-sync rows this sweep deleted (§3). */
    meshRowsPruned: number;
    /** Pages the post-sweep incremental vacuum returned to the OS. */
    vacuumedPages: number;
}

function emptyResult(): TranscriptWriterGcSweepResult {
    return { legacyCleared: [], discovered: [], budgetExhausted: false, meshRowsPruned: 0, vacuumedPages: 0 };
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function errText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Bare-define up to `maxTopics` on-disk topics matching `like`/`re` that this
 * node has not defined, with `policy` — no claim/push/announce (see header).
 */
function discoverStoredTopics(
    handle: SeqscribeNodeHandle,
    definedTopics: ReadonlySet<string>,
    like: string,
    re: RegExp,
    policy: () => TopicPolicy,
    maxTopics: number,
): string[] {
    const maintenance = handle.maintenance;
    if (!maintenance || !handle.authorityEnabled || maxTopics <= 0) return [];
    const discovered: string[] = [];
    for (const topic of maintenance.storedTopicsLike(like)) {
        if (discovered.length >= maxTopics) break;
        if (definedTopics.has(topic) || !re.test(topic)) continue;
        if (!maintenance.topicHasPrunableRows(topic, { keepNewest: 0, olderThanEpochMs: 0 })) continue;
        try {
            handle.node.defineTopic(topic, policy());
            discovered.push(topic);
            counters.topicsDiscovered++;
        } catch (error) {
            counters.errors++;
            LOG.warn('Seqscribe', `transcript writer-gc could not define stored topic=${topic}: ${errText(error)}`);
        }
    }
    return discovered;
}

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
 * One sweep: empty the legacy `.transcript` topics, then run the chat safety
 * net. Never throws — failures are counted and logged.
 */
export async function runTranscriptWriterGcSweep(
    handle: SeqscribeNodeHandle,
    opts: TranscriptWriterGcOptions = {},
): Promise<TranscriptWriterGcSweepResult> {
    const maxAgeMs = opts.maxAgeMs ?? TRANSCRIPT_PRUNE_MAX_AGE_MS;
    const stepRows = Math.max(1, opts.stepRows ?? TRANSCRIPT_PRUNE_STEP_ROWS);
    const now = opts.now ?? Date.now;
    const shouldContinue = opts.shouldContinue ?? (() => true);
    const maxDiscovered = opts.maxDiscoveredTopics ?? TRANSCRIPT_DISCOVERY_MAX_TOPICS_PER_SWEEP;
    let budget = Math.max(1, opts.sweepRowBudget ?? TRANSCRIPT_PRUNE_SWEEP_ROW_BUDGET);
    const result = emptyResult();
    counters.runs++;
    try {
        const definedTopics = new Set(Object.keys(handle.node.stats().topics));
        result.discovered.push(
            ...discoverStoredTopics(handle, definedTopics, LEGACY_TRANSCRIPT_TOPIC_LIKE, LEGACY_TRANSCRIPT_TOPIC_RE, legacyTranscriptPolicy, maxDiscovered),
            ...discoverStoredTopics(handle, definedTopics, RETIRED_ASSISTANT_JOURNAL_TOPIC, /^assistant\.journal$/, legacyTranscriptPolicy, 1),
            ...discoverStoredTopics(handle, definedTopics, CHAT_TOPIC_LIKE, CHAT_TOPIC_RE, sessionChatPolicy, maxDiscovered),
        );
        const topics = handle.node.stats().topics;

        // ── 1. legacy `.transcript` rows (§6.2) ─────────────────────────────
        for (const [topic, topicStats] of Object.entries(topics)) {
            if (!isRetiredSweepTopic(topic)) continue;
            if (!shouldContinue() || budget <= 0) break;
            if (topic === RETIRED_ASSISTANT_JOURNAL_TOPIC) {
                // The removed probe's durable cursor would hold the prune floor.
                try { handle.node.deleteConsumer(topic, RETIRED_JOURNAL_PROBE_CONSUMER); } catch { /* not registered */ }
            }
            let rows = topicStats.logRows;
            // Already empty (an earlier sweep or process emptied it): nothing to
            // report — a topic is "cleared" once, by the sweep that emptied it.
            if (rows === 0) continue;
            while (rows > 0 && budget > 0 && shouldContinue()) {
                const step = Math.min(stepRows, rows, budget);
                let pruned = 0;
                try {
                    pruned = (await handle.node.pruneTopic(topic, { keepNewest: rows - step })).prunedRows;
                } catch (error) {
                    if (isActiveTailSubscriberRefusal(error)) counters.skippedActive++;
                    else {
                        counters.errors++;
                        LOG.warn('Seqscribe', `transcript writer-gc legacy prune failed topic=${topic}: ${errText(error)}`);
                    }
                    break;
                }
                if (pruned === 0) break;
                rows -= pruned;
                budget -= pruned;
                counters.legacyRowsPruned += pruned;
                await yieldToEventLoop();
            }
            if (rows <= 0) {
                result.legacyCleared.push(topic);
                counters.legacyTopicsCleared++;
                LOG.info('Seqscribe', `transcript writer-gc removed legacy topic rows topic=${topic}`);
            }
        }

        // ── 2. chat safety net (§4.8) ───────────────────────────────────────
        for (const topic of Object.keys(topics)) {
            if (sessionSegmentFromChatTopic(topic) === null) continue;
            if (!shouldContinue() || budget <= 0) break;
            counters.topicsInspected++;
            let head: ReturnType<SeqscribeNodeHandle['node']['keyHead']>;
            try {
                head = handle.node.keyHead(topic, CHAT_COMMIT_KEY);
            } catch (error) {
                counters.errors++;
                LOG.warn('Seqscribe', `transcript writer-gc keyHead failed topic=${topic}: ${errText(error)}`);
                continue;
            }
            if (!head) continue;
            const dead = now() - head.entry.hlc.l > maxAgeMs && handle.node.tailSubscriberCount(topic) === 0;
            if (dead) {
                try {
                    // The whole topic: its newest commit is past the cap and
                    // nobody watches it, so no row of it can be live for anyone.
                    const { prunedRows } = await handle.node.pruneTopic(topic, { keepNewest: 0 });
                    budget -= prunedRows;
                    counters.rowsPruned += prunedRows;
                    if (prunedRows > 0) {
                        counters.deadTopicsRemoved++;
                        LOG.info('Seqscribe', `transcript writer-gc removed dead chat topic=${topic} rows=${prunedRows}`);
                    }
                } catch (error) {
                    if (isActiveTailSubscriberRefusal(error)) counters.skippedActive++;
                    else counters.errors++;
                }
                continue;
            }
            while (budget > 0 && shouldContinue()) {
                const maxRows = Math.min(stepRows, budget);
                let pruned = 0;
                try {
                    pruned = (await handle.node.pruneSuperseded(topic, { uptoRowid: head.rowid, maxRows })).prunedRows;
                } catch (error) {
                    counters.errors++;
                    LOG.warn('Seqscribe', `transcript writer-gc pruneSuperseded failed topic=${topic}: ${errText(error)}`);
                    break;
                }
                budget -= pruned;
                counters.rowsPruned += pruned;
                if (pruned < maxRows) break;
                await yieldToEventLoop();
            }
        }
        // ── 3. mesh full-sync retention (data-path audit P0-1) ─────────────
        const mesh = await sweepMeshFullSyncTopics(handle, Object.keys(topics), {
            retentionMs: opts.meshRetentionMs ?? MESH_FULL_SYNC_RETENTION_MS,
            maxLagMs: opts.meshMaxLagMs ?? MESH_FULL_SYNC_MAX_LAG_MS,
            stepRows,
            budget,
            shouldContinue,
        });
        budget -= mesh.pruned;
        result.meshRowsPruned = mesh.pruned;
        if (budget <= 0 || mesh.more) {
            result.budgetExhausted = true;
            counters.budgetExhausted++;
        }

        result.vacuumedPages = await reclaimFreePages(
            handle,
            Math.max(1, opts.vacuumPagesPerStep ?? INCREMENTAL_VACUUM_PAGES_PER_STEP),
            Math.max(0, opts.vacuumMaxSteps ?? INCREMENTAL_VACUUM_MAX_STEPS_PER_SWEEP),
            shouldContinue,
        );
    } catch (error) {
        counters.errors++;
        LOG.warn('Seqscribe', `transcript writer-gc sweep failed: ${errText(error)}`);
    }
    return result;
}

/**
 * §3 — acknowledged retention on every defined mesh full-sync topic, in
 * `pruneAcked` steps of at most `stepRows` rows, yielding between steps.
 * `more` = the budget ran out with deletable rows left (the caller schedules a
 * continuation). Failures are counted and logged, never thrown.
 */
async function sweepMeshFullSyncTopics(
    handle: SeqscribeNodeHandle,
    topics: string[],
    o: { retentionMs: number; maxLagMs: number; stepRows: number; budget: number; shouldContinue: () => boolean },
): Promise<{ pruned: number; more: boolean }> {
    let budget = o.budget;
    let pruned = 0;
    let more = false;
    let pinned = 0;
    let lagging = 0;
    for (const topic of topics) {
        if (!isMeshFullSyncRetentionTopic(topic)) continue;
        if (!o.shouldContinue()) break;
        if (budget <= 0) {
            more = true;
            break;
        }
        counters.meshTopicsInspected++;
        let first = true;
        for (;;) {
            let r: Awaited<ReturnType<SeqscribeNodeHandle['node']['pruneAcked']>>;
            try {
                r = await handle.node.pruneAcked(topic, {
                    olderThanMs: o.retentionMs,
                    maxLagMs: o.maxLagMs,
                    maxRows: Math.min(o.stepRows, budget),
                });
            } catch (error) {
                counters.meshPruneErrors++;
                counters.errors++;
                LOG.warn('Seqscribe', `mesh full-sync retention failed topic=${topic}: ${errText(error)}`);
                break;
            }
            if (first) {
                // Gauges describe the floor, which one call already fully reports.
                first = false;
                pinned += Object.values(r.writers).filter((w) => w.pinnedBy !== null).length;
                lagging += r.members.filter((m) => m.excluded === 'lagging').length;
            }
            budget -= r.prunedRows;
            pruned += r.prunedRows;
            counters.meshRowsPruned += r.prunedRows;
            if (!r.more) break;
            if (budget <= 0 || !o.shouldContinue()) {
                more = true;
                break;
            }
            await yieldToEventLoop();
        }
    }
    counters.meshStreamsPinned = pinned;
    counters.meshLaggingMembers = lagging;
    if (pruned > 0) LOG.info('Seqscribe', `mesh full-sync retention pruned ${pruned} row(s) below the acknowledged floor`);
    return { pruned, more };
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
 * Arm/disarm the process-wide periodic sweep. Self-arming —
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
