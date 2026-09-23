// ---------------------------------------------------------------------------
// turn-ledger/scheduler — ONE tick over ledger queries (C4)
// ---------------------------------------------------------------------------
// Wiring-unification Phase C4 (C-W4). The sole timer for turn lifecycle. It
// replaces the reconcile loop's turn phases (PHASE 2.5 stranded watchdog,
// 2.6 zombie + unsettled net, 4 transcript synth, 5 auto-prune, the acked-hold
// death / fast-track / ceiling machinery), the live-gate's 250 ms retry timer
// and the remote pull. Nothing here decides a turn: every phase turns time or
// a read into EVIDENCE and hands it to `ledger.observe()`.
//
// Fixed phase order per tick (single-flight):
//   1. sweep      `ledger.sweepExpiredHolds()` — every due hold becomes
//                 `hold_expired` evidence (H1 await_delivery → reclaim, H2
//                 await_consume → redeliver once then reclaim, H3 await_turn →
//                 reclaim, H4 liveness → probe, H5 hard_ceiling → failed,
//                 H7 live_pending/transcript_quiet → reevaluate, R13a
//                 weak_candidate → commit).
//   2. probeDue   targets.ts picks the owned attempts a read could move;
//                 probe.ts reads them (registry locally, P-γ cached status
//                 probe remotely) and maps the read to evidence; each attempt
//                 is stamped `store.markProbed`.
//   3. claim      the host's queue claim (`triggerMeshQueue` for hosted meshes
//                 with pending rows) — a reclaim above returns a row to
//                 `pending` and this re-dispatches it in the same tick.
//   4. republish  `ledger.republishPending()` closes the committed-but-not-
//                 appended crash window.
//   5. invariants WARN when a `pending` publish row is older than 2·tick, and
//                 when an open non-plain attempt has no hard_ceiling hold.
//   6. prune      `store.pruneTerminalPlainAttempts(7 d)` (C10-4), hourly.
//
// There is no deliver phase (the `turn.deliver` cursor is consumer-driven,
// C2) and no pull phase (replication). One `setInterval(tickMs)` plus one
// `setTimeout` at `nextHoldDeadline()` so a hold expiring mid-interval is
// swept on time rather than up to a tick late. A tick with nothing due does
// no writes.
// ---------------------------------------------------------------------------

import type { SummaryRef, TurnEvidence } from '@adhdev/mesh-shared';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import type { SessionLifecycleBus, Unsubscribe } from '../../sessions/lifecycle-bus.js';
import type { ObserveResult, TurnLedger, TurnLedgerLog } from './ledger.js';
import { DEFAULT_TURN_POLICY, type TurnPolicy } from './policy.js';
import { probeEvidence, type ProbeLocation, type TranscriptObservation, type TurnProbeReader } from './probe.js';
import type { TurnStore } from './store.js';
import { selectProbeTargets, type ProbeTarget } from './targets.js';
import type { TurnAttempt } from './types.js';

/** C10-4: terminal plain attempts are pruned after 7 days. */
export const PLAIN_ATTEMPT_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** The prune is a cleanup, not a latency path: at most once per hour. */
export const PLAIN_ATTEMPT_PRUNE_INTERVAL_MS = 60 * 60_000;
/** Concurrent probe reads per tick (remote reads are P2P round trips). */
export const PROBE_CONCURRENCY = 8;
/** Bound on the (attempt, generation, final bubble) → handoff ref memo. */
const HANDOFF_MEMO_MAX = 500;
/** An invariant WARN repeats at most this often while the condition persists (a down topic must not flood the log every tick). */
export const INVARIANT_WARN_INTERVAL_MS = 60_000;

/** The probe half, injected so the scheduler stays testable without a daemon. */
export interface TurnSchedulerProbe {
    reader: TurnProbeReader;
    locate(attempt: TurnAttempt): ProbeLocation;
    /**
     * Append a final-summary text to `mesh.<id>.handoff` and return its ref
     * (the text never enters evidence). Optional; failure → no ref.
     */
    handoff?(attempt: TurnAttempt, observation: TranscriptObservation): Promise<SummaryRef | null>;
}

export interface TurnSchedulerDeps {
    ledger: TurnLedger;
    /** Defaults to `ledger.store`. */
    store?: TurnStore;
    policy?: TurnPolicy;
    /** Defaults to `ledger.selfDaemonId`. */
    selfDaemonId?: string;
    probe?: TurnSchedulerProbe | null;
    /** Phase 3: the host's queue claim. */
    claim?: () => Promise<void> | void;
    /**
     * Phase 3b: deliver coordinator notices the `turn.deliver` cursor passed
     * while no local coordinator could take them (C-W3 `deliverBacklog`). Its
     * own no-op guard (no undelivered notice / no coordinator) keeps an idle
     * tick write-free.
     */
    deliverBacklog?: () => Promise<unknown> | unknown;
    /** `terminated` of a session holding an owned open attempt forces a probe. */
    bus?: SessionLifecycleBus | null;
    log?: TurnLedgerLog;
    /** Defaults to `policy.tickMs`. */
    intervalMs?: number;
    now?: () => number;
}

export interface TurnTickReport {
    at: number;
    swept: number;
    probed: number;
    probeEvidence: number;
    published: number;
    stalePending: number;
    missingCeiling: number;
    pruned: number;
}

export interface TurnScheduler {
    /** Run one tick now (single-flight: a call during a tick joins it and schedules one more). */
    tick(): Promise<TurnTickReport>;
    /** Probe this attempt on the next tick regardless of its due rule (the ledger's H4 `probe` port). */
    requestProbe(attemptId: string): void;
    /** Stop timers and bus subscriptions. Idempotent. */
    stop(): void;
    readonly started: boolean;
}

const NOOP_LOG: TurnLedgerLog = { info: () => {}, warn: () => {}, error: () => {} };

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Bounded parallel map (probe reads). */
async function mapLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const item = items[next++]!;
            await fn(item);
        }
    });
    await Promise.all(workers);
}

/**
 * The scheduler without timers — `tick()` and `requestProbe()` only. Tests
 * drive it directly; `startTurnScheduler` adds the interval + deadline timer.
 */
export function createTurnScheduler(deps: TurnSchedulerDeps): TurnScheduler & { __armWake(wake: () => void): void } {
    const ledger = deps.ledger;
    const store = deps.store ?? ledger.store;
    const policy = deps.policy ?? DEFAULT_TURN_POLICY;
    const selfDaemonId = deps.selfDaemonId ?? ledger.selfDaemonId;
    const log = deps.log ?? NOOP_LOG;
    const now = deps.now ?? (() => Date.now());
    const tickMs = deps.intervalMs ?? policy.tickMs;
    const forced = new Set<string>();
    let lastPruneAt: number | null = null;
    let inFlight: Promise<TurnTickReport> | null = null;
    let again = false;
    let wake: (() => void) | null = null;
    let offBus: Unsubscribe | null = null;
    let stopped = false;
    const handoffRefs = new Map<string, SummaryRef>();
    const lastWarnAt = new Map<string, { at: number; value: number }>();
    /** WARN on a new value, or at most once per INVARIANT_WARN_INTERVAL_MS while it persists. */
    function warnThrottled(key: string, value: number, at: number, message: string): void {
        const prev = lastWarnAt.get(key);
        if (prev && prev.value === value && at - prev.at < INVARIANT_WARN_INTERVAL_MS) return;
        lastWarnAt.set(key, { at, value });
        log.warn(message);
    }

    function observeAll(evidence: readonly TurnEvidence[]): ObserveResult[] {
        const out: ObserveResult[] = [];
        for (const ev of evidence) {
            try {
                out.push(ledger.observe(ev));
            } catch (error) {
                log.error(`turn-scheduler: observe ${ev.kind} ${ev.eventId} failed: ${describe(error)}`);
            }
        }
        return out;
    }

    async function probeOne(target: ProbeTarget, report: TurnTickReport): Promise<void> {
        const probe = deps.probe;
        if (!probe) return;
        const attempt = target.attempt;
        let location: ProbeLocation;
        try {
            location = probe.locate(attempt);
        } catch (error) {
            log.warn(`turn-scheduler: locate ${attempt.attemptId} failed: ${describe(error)}`);
            location = { kind: 'unknown' };
        }
        let read;
        try {
            read = await probe.reader.read(attempt, location, target.holds);
        } catch (error) {
            log.warn(`turn-scheduler: probe read ${attempt.attemptId} failed: ${describe(error)}`);
            read = { presence: 'present' as const, transcript: null };
        }
        const at = now();
        // The attempt may have moved while the read was in flight (a provider
        // turn_end landed): map against the CURRENT row so the evidence carries
        // the current generation and the stale-generation lane stays honest.
        const current = store.getAttempt(attempt.attemptId);
        if (!current || current.terminal) return;
        let evidence = probeEvidence(current, read, { nowMs: at, observedBy: selfDaemonId, policy });
        const t = read.transcript;
        if (t && t.finalSummary && probe.handoff && current.meshId && evidence.some((e) => e.kind === 'transcript_final')) {
            // One handoff entry per (attempt, generation, final bubble): a weak
            // candidate is re-read every tick and must not append each time.
            const key = `${current.attemptId}:g${current.generation}:${t.finalAssistantAt ?? 'marker'}`;
            let summary = handoffRefs.get(key);
            if (!summary) {
                try {
                    summary = (await probe.handoff(current, t)) ?? undefined;
                    if (summary) {
                        handoffRefs.set(key, summary);
                        if (handoffRefs.size > HANDOFF_MEMO_MAX) handoffRefs.delete(handoffRefs.keys().next().value!);
                    }
                } catch (error) {
                    log.warn(`turn-scheduler: handoff append for ${current.attemptId} failed: ${describe(error)} — transcript_final carries no summary ref`);
                }
            }
            if (summary) evidence = probeEvidence(current, read, { nowMs: at, observedBy: selfDaemonId, policy, summary });
        }
        observeAll(evidence);
        try {
            store.markProbed(current.attemptId, at);
        } catch (error) {
            log.warn(`turn-scheduler: markProbed ${current.attemptId} failed: ${describe(error)}`);
        }
        report.probed++;
        report.probeEvidence += evidence.length;
    }

    function checkInvariants(at: number, report: TurnTickReport): void {
        try {
            report.stalePending = ledger.pendingPublishCount(at - 2 * tickMs);
            if (report.stalePending > 0) {
                warnThrottled('stale_pending', report.stalePending, at, `turn-scheduler: ${report.stalePending} turn_events row(s) still publish_state='pending' after 2 ticks (${2 * tickMs} ms) — the mesh topic is not accepting appends; rows stay pending and are retried every tick`);
            } else {
                lastWarnAt.delete('stale_pending');
            }
        } catch (error) {
            log.warn(`turn-scheduler: publish-lag check failed: ${describe(error)}`);
        }
        try {
            const ceilinged = new Set((store.db.prepare(`SELECT attempt_id FROM turn_holds WHERE status = 'active' AND reason = 'hard_ceiling'`).all() as Array<{ attempt_id: string }>).map((r) => r.attempt_id));
            const missing = store.listOpenAttempts()
                .filter((a) => a.scope !== 'plain' && daemonIdsEquivalent(a.ownerDaemonId, selfDaemonId) && !ceilinged.has(a.attemptId));
            report.missingCeiling = missing.length;
            if (missing.length > 0) {
                warnThrottled('missing_ceiling', missing.length, at, `turn-scheduler: invariant — ${missing.length} open mesh attempt(s) without a hard_ceiling hold (${missing.slice(0, 5).map((a) => a.attemptId).join(', ')}) — nothing bounds them`);
            } else {
                lastWarnAt.delete('missing_ceiling');
            }
        } catch (error) {
            log.warn(`turn-scheduler: hard-ceiling invariant check failed: ${describe(error)}`);
        }
    }

    async function runTick(): Promise<TurnTickReport> {
        const at = now();
        const report: TurnTickReport = { at, swept: 0, probed: 0, probeEvidence: 0, published: 0, stalePending: 0, missingCeiling: 0, pruned: 0 };

        // 1. sweep
        try {
            report.swept = ledger.sweepExpiredHolds(at).length;
        } catch (error) {
            log.error(`turn-scheduler: hold sweep failed: ${describe(error)}`);
        }

        // 2. probeDue
        if (deps.probe) {
            const force = new Set(forced);
            forced.clear();
            let targets: ProbeTarget[] = [];
            try {
                targets = selectProbeTargets({ store, selfDaemonId, nowMs: now(), policy, forced: force });
            } catch (error) {
                log.error(`turn-scheduler: probe target query failed: ${describe(error)}`);
            }
            await mapLimited(targets, PROBE_CONCURRENCY, (target) => probeOne(target, report));
        }

        // 3. claim
        if (deps.claim) {
            try {
                await deps.claim();
            } catch (error) {
                log.warn(`turn-scheduler: queue claim failed: ${describe(error)}`);
            }
        }

        // 3b. notice backlog
        if (deps.deliverBacklog) {
            try {
                await deps.deliverBacklog();
            } catch (error) {
                log.warn(`turn-scheduler: notice backlog delivery failed: ${describe(error)}`);
            }
        }

        // 4. republish
        try {
            report.published = (await ledger.republishPending()).published;
        } catch (error) {
            log.error(`turn-scheduler: republish failed: ${describe(error)}`);
        }

        // 5. invariants
        checkInvariants(now(), report);

        // 6. prune (hourly)
        const pruneAt = now();
        if (lastPruneAt === null || pruneAt - lastPruneAt >= PLAIN_ATTEMPT_PRUNE_INTERVAL_MS) {
            lastPruneAt = pruneAt;
            try {
                report.pruned = store.pruneTerminalPlainAttempts(PLAIN_ATTEMPT_RETENTION_MS, pruneAt).attempts;
                if (report.pruned > 0) log.info(`turn-scheduler: pruned ${report.pruned} terminal plain attempt(s) older than 7 d`);
            } catch (error) {
                log.warn(`turn-scheduler: plain-attempt prune failed: ${describe(error)}`);
            }
        }
        return report;
    }

    function tick(): Promise<TurnTickReport> {
        if (inFlight) {
            again = true;
            return inFlight;
        }
        inFlight = runTick().finally(() => {
            inFlight = null;
            if (again && !stopped) {
                again = false;
                wake?.();
            }
        });
        return inFlight;
    }

    if (deps.bus) {
        offBus = deps.bus.on('terminated', (event) => {
            try {
                const attempt = ledger.openAttemptForSession(event.sessionId);
                if (attempt && daemonIdsEquivalent(attempt.ownerDaemonId, selfDaemonId)) {
                    forced.add(attempt.attemptId);
                    wake?.();
                }
            } catch { /* a lookup failure only delays the probe to its due rule */ }
        }, { name: 'turn-scheduler' });
    }

    return {
        tick,
        requestProbe(attemptId: string) {
            forced.add(attemptId);
            wake?.();
        },
        stop() {
            stopped = true;
            wake = null;
            try { offBus?.(); } catch { /* noop */ }
            offBus = null;
        },
        get started() { return false; },
        __armWake(fn: () => void) { wake = fn; },
    };
}

/**
 * Start the scheduler: one interval at `tickMs` plus one deadline timeout at
 * `nextHoldDeadline()`, both unref'd. `requestProbe` / a bus edge wakes an
 * early tick (coalesced through the same single-flight).
 */
export function startTurnScheduler(deps: TurnSchedulerDeps): TurnScheduler {
    const policy = deps.policy ?? DEFAULT_TURN_POLICY;
    const tickMs = deps.intervalMs ?? policy.tickMs;
    const now = deps.now ?? (() => Date.now());
    const log = deps.log ?? NOOP_LOG;
    const scheduler = createTurnScheduler(deps);
    let stopped = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let wakeQueued = false;

    const unref = (t: { unref?: () => void } | null | undefined): void => { if (t && typeof t.unref === 'function') t.unref(); };

    function armDeadline(): void {
        if (stopped) return;
        if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
        let next: number | null = null;
        try { next = deps.ledger.nextHoldDeadline(); } catch { next = null; }
        if (next === null) return;
        const delay = Math.max(0, next - now());
        // The interval covers anything a full tick away; only a shorter wait needs its own timer.
        if (delay >= tickMs) return;
        deadlineTimer = setTimeout(() => { deadlineTimer = null; run(); }, delay);
        unref(deadlineTimer);
    }

    function run(): void {
        if (stopped) return;
        void scheduler.tick()
            .catch((error) => log.error(`turn-scheduler: tick failed: ${describe(error)}`))
            .finally(armDeadline);
    }

    scheduler.__armWake(() => {
        if (stopped || wakeQueued) return;
        wakeQueued = true;
        setImmediate(() => { wakeQueued = false; run(); });
    });

    const interval = setInterval(run, tickMs);
    unref(interval);
    // First tick right away: boot recovery is just a tick over durable rows.
    setImmediate(run);

    return {
        tick: scheduler.tick,
        requestProbe: scheduler.requestProbe,
        stop() {
            if (stopped) return;
            stopped = true;
            clearInterval(interval);
            if (deadlineTimer) clearTimeout(deadlineTimer);
            scheduler.stop();
        },
        get started() { return !stopped; },
    };
}

/**
 * The ledger's `probe` port is constructed before the scheduler exists (the
 * ledger is built in S7, the scheduler starts in S8). Boot passes `port` to
 * `createMeshRuntimeTurnLedger({ports:{probe: port}})` and `bind`s the
 * scheduler once it starts; until then a request is remembered, not lost.
 */
export function createLateBoundProbePort(): {
    port: (e: { attemptId: string }) => void;
    bind(scheduler: Pick<TurnScheduler, 'requestProbe'> | null): void;
} {
    let target: Pick<TurnScheduler, 'requestProbe'> | null = null;
    const early = new Set<string>();
    return {
        port(e) {
            if (target) target.requestProbe(e.attemptId);
            else early.add(e.attemptId);
        },
        bind(scheduler) {
            target = scheduler;
            if (!scheduler) return;
            for (const id of early) scheduler.requestProbe(id);
            early.clear();
        },
    };
}
