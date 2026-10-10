/**
 * The periodic quota refresh loop: a self-rescheduling timer that wakes at the
 * earliest per-provider due time (axis TTL, failure-retry backoff, SWR) and only
 * for providers with recent CLI activity, so an idle daemon stops polling vendors.
 */
import {
    QUOTA_ACTIVITY_WINDOW_MS,
    cache,
    failureRetries,
    QUOTA_FAILURE_MAX_RETRIES,
    QUOTA_ROUTABLE_MAX_AGE_MS,
    lastAttemptAt,
    QUOTA_AXIS_TTL_MS,
    QUOTA_REFRESH_INTERVAL_MS,
    REFRESHERS,
    quotaCacheChangedListener,
    setQuotaCacheChangedListener,
    setAmbientQuotaEnableGate,
    isFailureRetryDue,
    hasArmedFailureRetryTimer,
    isSnapshotStaleForRouting,
    isBackfillDueByAttemptClock,
    isDueByAxisTtl,
    resetFailureBudgetOnCredentialRenewal,
    notifyQuotaCacheChanged,
    refreshQuotaCacheOnce,
    quotaProviderEnabledFromLoader,
    type QuotaProviderEnabled,
} from './refresh.js';
import type { QuotaProvider, ProviderQuota } from './types.js';
import { LOG } from '../logging/logger.js';

/**
 * Statuses that mean an agent is consuming quota RIGHT NOW. Deliberately the
 * same vocabulary the restart-blocking and live-task-holder gates use, so
 * "busy" means one thing across the daemon.
 */
const WORKING_STATUSES = new Set([
    'generating',
    'waiting_approval',
    'waiting_choice',
    'starting',
    'streaming',
    'working',
    'no_progress',
    'long_generating',
]);

/**
 * Has this machine used an agent recently enough that its quota could have
 * moved? Two signals, either sufficient:
 *   - a session is in a working status (quota is being spent right now), or
 *   - a session produced a message inside the activity window (quota was spent
 *     recently, and the post-turn reading is the one worth capturing).
 *
 * Read through `collectHotChatSessionStates()` — the explicitly CHEAP
 * projection. The richer `collectAllStates()` would be wrong here: it can run
 * transcript parsing on every tick. (It used to also DRAIN each instance's
 * pendingEvents into event listeners; since wiring-unification B5 provider
 * events reach consumers only through the lifecycle bus.)
 */
export function hasRecentCliActivity(
    sessions: ReadonlyArray<{ status?: unknown; lastMessageAt?: unknown }>,
    now: number = Date.now(),
    windowMs: number = QUOTA_ACTIVITY_WINDOW_MS,
): boolean {
    for (const session of sessions) {
        if (typeof session?.status === 'string' && WORKING_STATUSES.has(session.status)) return true;
        const lastMessageAt = typeof session?.lastMessageAt === 'number'
            ? session.lastMessageAt
            : Number(session?.lastMessageAt);
        if (Number.isFinite(lastMessageAt) && lastMessageAt > 0 && now - lastMessageAt <= windowMs) return true;
    }
    return false;
}

export interface QuotaRefreshLoopHandle {
    stop(): void;
}

export interface QuotaRefreshLoopOptions {
    /**
     * Returns true when this machine has used a CLI provider recently. When it
     * returns false the tick is skipped entirely: quota only moves when an
     * agent runs, so polling an idle machine spends a codex process spawn to
     * re-learn a number that cannot have changed.
     */
    hasRecentCliActivity: () => boolean;
    /**
     * The FIRST wake's delay, the fallback cadence when no next expiry is
     * computable, and the sleep ceiling while any provider is disabled (see
     * startQuotaRefreshLoop). ★No longer a fixed tick period — the chain
     * otherwise sleeps per computeNextWakeDelayMs.
     */
    intervalMs?: number;
    /** Injectable for tests; defaults to the real per-provider fetchers. */
    fetchers?: ReadonlyArray<{ provider: QuotaProvider; fetch: () => Promise<ProviderQuota> }>;
    /**
     * Machine-level enable gate (see QuotaProviderEnabled). Evaluated on every
     * tick, so a provider enabled or disabled between ticks takes effect on the
     * next one — no restart, no cache flush needed.
     */
    isEnabled?: QuotaProviderEnabled;
}

/**
 * Floor under a computed chain wake: a provider that is due NOW still waits a
 * beat, so a pathological entry that stays "due" after being probed cannot
 * spin the chain in a tight loop. Applied BEFORE the intervalMs ceiling so
 * tests injecting a tiny interval still get their cadence.
 */
const MIN_CHAIN_WAKE_DELAY_MS = 1_000;

/**
 * How long the timer chain may sleep before the next wake has work to do, or
 * undefined when nothing is computable (no enable gate, or no enabled
 * provider at all) and the caller should fall back to the fixed interval.
 *
 * ★This must mirror the wake's own selection logic EXACTLY. Predicting short
 * costs an early wake that finds nothing due (harmless); predicting long
 * skips a refresh the design promises (the 2026-08-15 class of defect). The
 * candidates are therefore the same three the wake checks, read off the same
 * two clocks:
 *
 *   - missing entry            → due now (0);
 *   - transient-failure retry  → its retryAtMs, while the retry budget lasts
 *                                (mirrors isFailureRetryDue);
 *   - staleness backfill       → the LATER of the two clocks' horizons, because
 *                                the wake requires BOTH: isSnapshotStaleForRouting
 *                                reads `updatedAt` and isBackfillDueByAttemptClock
 *                                reads `fetchedAt`. A clock that cannot be dated
 *                                counts as already satisfied, matching those
 *                                predicates;
 *   - axis TTL (file axis)     → `fetchedAt` + TTL, but ONLY while the machine
 *                                is active. An idle machine's number cannot
 *                                have moved, so the TTL must not wake the chain
 *                                every 60s to fetch nothing. This is the
 *                                idle-quiet win: a settled idle machine sleeps
 *                                straight to the backfill horizon.
 */
function computeNextWakeDelayMs(
    fetchers: ReadonlyArray<{ provider: QuotaProvider }>,
    isEnabled: QuotaProviderEnabled | undefined,
    active: boolean,
    now: number = Date.now(),
): number | undefined {
    if (!isEnabled) return undefined;
    let nextAt = Number.POSITIVE_INFINITY;
    for (const { provider } of fetchers) {
        if (!isEnabled(provider)) continue;
        const entry = cache.get(provider);
        if (!entry) return 0; // missing entry → the backfill is due now
        if (entry.status !== 'ok') {
            const retryAtMs = entry.metadata?.retryAtMs;
            if (typeof retryAtMs === 'number'
                && !hasArmedFailureRetryTimer(provider) // the armed timer owns this retry
                && (failureRetries.get(provider)?.failures ?? 0) <= QUOTA_FAILURE_MAX_RETRIES) {
                nextAt = Math.min(nextAt, retryAtMs);
            }
        }
        const updatedAtMs = Number(entry.updatedAt);
        const dataDueAt = Number.isFinite(updatedAtMs) && updatedAtMs > 0
            ? updatedAtMs + QUOTA_ROUTABLE_MAX_AGE_MS
            : Number.NEGATIVE_INFINITY;
        const attemptedAt = lastAttemptAt(entry);
        const attemptDueAt = attemptedAt === undefined
            ? Number.NEGATIVE_INFINITY
            : attemptedAt + QUOTA_ROUTABLE_MAX_AGE_MS;
        nextAt = Math.min(nextAt, Math.max(dataDueAt, attemptDueAt));
        if (active) {
            const ttl = QUOTA_AXIS_TTL_MS[provider];
            if (Number.isFinite(ttl)) {
                nextAt = Math.min(nextAt, attemptedAt === undefined ? now : attemptedAt + ttl);
            }
        }
    }
    if (!Number.isFinite(nextAt)) return undefined; // no enabled provider at all
    return Math.max(nextAt - now, 0);
}

/**
 * Start the periodic refresh. A single non-overlapping chain of one-shot
 * timers — NOT a fixed setInterval: each wake recomputes the next wake from
 * the per-provider expiry landscape (computeNextWakeDelayMs) and re-arms
 * itself, and every out-of-band refresh (event-driven, SWR, force, scheduled
 * retry) nudges the chain through quotaCacheChangedListener so a mid-chain
 * refresh is always followed by a freshly computed wake. Timers unref
 * themselves so the chain never keeps the process alive, plus a stop() handle
 * for shutdown.
 *
 * ★Why a chain: an idle machine whose snapshots are all inside the routing
 * horizon has no work until the oldest one ages out — waking every 15 minutes
 * to discover that was the last reason the "idle daemon is never quiet"
 * complaint (owner reason ②) survived the axis split. A settled idle machine
 * now sleeps straight to the backfill horizon (up to
 * QUOTA_ROUTABLE_MAX_AGE_MS), while an ACTIVE machine wakes at the file axis's
 * short TTL — fresher cheap numbers than the fixed interval ever gave.
 *
 * ★The backfill safety net is UNAFFECTED: the chain's candidates include the
 * staleness horizon for every enabled provider, and the computed sleep is
 * CEILINGED at QUOTA_ROUTABLE_MAX_AGE_MS, so a broken expiry computation or a
 * clock-skewed entry can delay a wake, never cancel it. The wake's own
 * selection logic (backfillDue + the idle gate) is unchanged below — only the
 * timer shape changed.
 */
export function startQuotaRefreshLoop(options: QuotaRefreshLoopOptions): QuotaRefreshLoopHandle {
    const intervalMs = options.intervalMs ?? QUOTA_REFRESH_INTERVAL_MS;
    const fetchers = options.fetchers ?? REFRESHERS;
    // Publish this loop's enable gate for the out-of-band refresh paths (SWR
    // revalidate, force refresh) — see ambientIsEnabled.
    if (options.isEnabled) setAmbientQuotaEnableGate(options.isEnabled);
    let running = false;
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    /**
     * Compute the next wake and (re)arm the single chain timer. Any pending
     * timer is cleared first, so a reschedule never stacks a second chain.
     */
    const scheduleNext = (): void => {
        if (stopped) return;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        let delayMs = intervalMs; // fallback: the pre-chain fixed cadence
        try {
            let active = false;
            try {
                active = options.hasRecentCliActivity();
            } catch {
                // Same contract as the wake itself: an unreadable activity
                // signal reads as idle — staleness, never a spawn storm.
                active = false;
            }
            const computed = computeNextWakeDelayMs(fetchers, options.isEnabled, active);
            if (computed !== undefined) {
                delayMs = Math.max(computed, MIN_CHAIN_WAKE_DELAY_MS);
                // ★Ceiling: never sleep past the routing staleness horizon. The
                // backfill MUST fire within it (the 2026-08-15 safety net), so
                // this is also what makes "the chain sleeps forever" impossible
                // even if the expiry computation or the wall clock misbehaves.
                delayMs = Math.min(delayMs, QUOTA_ROUTABLE_MAX_AGE_MS);
                // Enable-latency ceiling: while ANY provider is disabled, a
                // later enable can create a missing entry the chain cannot
                // otherwise observe until it wakes. Cap the sleep at the old
                // interval so "enable takes effect on the next tick" keeps its
                // pre-chain meaning. A machine whose gate admits every fetcher
                // has no such surprise coming and gets the full horizon sleep.
                if (options.isEnabled && fetchers.some(({ provider }) => !options.isEnabled!(provider))) {
                    delayMs = Math.min(delayMs, intervalMs);
                }
            }
        } catch {
            delayMs = intervalMs; // a computation failure must never kill the chain
        }
        timer = setTimeout(runWake, delayMs);
        if (typeof timer.unref === 'function') timer.unref();
    };

    // Out-of-band refreshes (event-driven, SWR, force, scheduled retry, boot)
    // all land in the cache between wakes; recompute the next wake from the
    // fresh state. Skipped while a wake is in flight — that wake reschedules
    // itself in its finally, with even fresher state.
    const rescheduleFromOutside = (): void => {
        if (stopped || running) return;
        scheduleNext();
    };
    setQuotaCacheChangedListener(rescheduleFromOutside);

    const runWake = (): void => {
        timer = null;
        if (stopped) return;
        if (running) {
            // Cannot happen with a single non-overlapping chain — but if it
            // ever did, dropping the wake without rescheduling would kill the
            // chain, and that failure mode is not acceptable.
            scheduleNext();
            return;
        }
        let active = false;
        try {
            active = options.hasRecentCliActivity();
        } catch {
            // An unreadable activity signal must not wedge the loop shut; treat
            // it as idle so a broken probe costs staleness, never a spawn storm.
            active = false;
        }
        // Backfill exception to the idle gate: an ENABLED provider with no
        // USABLE snapshot has a real quota number we have simply never read,
        // so one fetch is worth it even on an idle machine. "No usable
        // snapshot" covers two states:
        //   - no entry at all (typically a provider enabled after the boot
        //     refresh ran), and
        //   - a cached TRANSIENT failure whose retry time has passed — the
        //     scheduled short-fuse retry (updateFailureRetry) is the primary
        //     path, and this is the safety net for a timer lost to process
        //     sleep. cache.has() alone could not tell that failure from a
        //     real measurement, which is what pinned the expired-token race
        //     error for a full 15-minute tick.
        // A PERSISTENT failure (no retryAtMs) or an exhausted retry budget
        // still counts as a snapshot, so a failing fetcher cannot re-trigger
        // this every tick.
        //   - a snapshot that has aged past the ROUTING staleness horizon
        //     (isSnapshotStaleForRouting). An idle machine's number cannot have
        //     moved, but it still ages out of the quota gate's trust window,
        //     and the gate then fails open as if the provider had never been
        //     measured. Since the event-driven refresh only re-reads the
        //     provider that just ran, the ALTERNATIVE providers the gate exists
        //     to divert work to were the ones going stale — see
        //     isSnapshotStaleForRouting for the full failure loop.
        //
        // ★SAFETY NET (do not remove — the 2026-08-15 defect). needsBackfill is
        // evaluated per provider and is AXIS-BLIND on purpose: the network axis
        // is excluded from cadenced TTL refresh, but it is emphatically NOT
        // excluded from this. It is the only rule that guarantees a snapshot
        // never ages out of the routing gate's trust window forever, and it
        // fires with zero events, zero readers and zero user attention.
        //
        // Backfill requires an enable gate, exactly as before this change. The
        // gate is what makes "no snapshot yet" mean "we have not read a number
        // this machine can actually use": without it, EVERY provider looks
        // un-backfilled on an empty cache and an idle machine would probe all
        // six — including the ones it does not run. A daemon always supplies the
        // gate (setupQuotaRefreshLoop derives it from the ProviderLoader); the
        // ungated form is a test/embedding shape, and for it the idle machine
        // stays silent.
        //
        // ★The staleness arm is BOTH clocks, and needs both (2026-08-22 defect).
        // isSnapshotStaleForRouting is the routing-facing question — "is the data
        // too old for the gate?" — and remains the reason a backfill is WANTED.
        // isBackfillDueByAttemptClock is the scheduling question — "would a fetch
        // help?" — and is what stops us re-asking a provider that is already
        // being probed on schedule and simply keeps failing. Requiring both is
        // what keeps the 2026-08-15 safety net intact while ending the storm a
        // carry-forward entry's frozen `updatedAt` used to cause; see that
        // function for the full account.
        const backfillDue = (provider: QuotaProvider): boolean =>
            !!options.isEnabled
            && (!cache.has(provider)
                || isFailureRetryDue(provider)
                || (isSnapshotStaleForRouting(provider) && isBackfillDueByAttemptClock(provider)));
        // ★AXIS SPLIT: a tick no longer refreshes all six providers. Each is
        // selected on its own terms —
        //   - backfillDue          → always, on either axis (the safety net);
        //   - active && TTL due    → the cadenced path, which for the network
        //                            axis is never (TTL Infinity) and for the
        //                            file axis is cheap and short.
        // The idle gate still applies to the cadenced half only: an idle
        // machine's number cannot have moved, so re-reading it buys nothing the
        // safety net does not already cover.
        const due = fetchers.filter(({ provider }) => {
            if (options.isEnabled && !options.isEnabled(provider)) return false;
            if (backfillDue(provider)) return true;
            return active && isDueByAxisTtl(provider);
        });
        // ★RE-LOGIN RESCUE. A provider whose retry budget is spent is, by
        // design, NOT in `due` — that is what stops us hammering a dead token.
        // But the budget cannot hear a re-login, so probe the credential stamp
        // for the narrow cases that can be rescued (see
        // resetFailureBudgetOnCredentialRenewal: a provider with a
        // CREDENTIAL_MTIME_SOURCES entry, on a token-expiry failure kind).
        // Deliberately fire-and-forget and OUTSIDE the
        // `due` decision: this wake proceeds on the state it already computed,
        // and a reset merely notifies the cache-changed listener, which
        // reschedules the chain so the NEXT wake sees the retry as due. An
        // unchanged stamp resets nothing and costs one `security` call (agy) or
        // one `stat` (kimi/grok) per wake — and only for a provider already
        // sitting on a token-expiry failure. No extra provider probe, ever.
        for (const { provider } of fetchers) {
            if (options.isEnabled && !options.isEnabled(provider)) continue;
            if (due.some((f) => f.provider === provider)) continue;
            void resetFailureBudgetOnCredentialRenewal(provider)
                .then((reset) => { if (reset) notifyQuotaCacheChanged(); })
                .catch(() => { /* advisory only — the tick must not depend on it */ });
        }
        // A provider that was disabled since the last tick still has to be
        // PRUNED from the cache, and only refreshQuotaCacheOnce does that (it
        // drops the entry and rewrites the persisted file). Selecting nothing to
        // fetch must therefore not mean "skip the call" whenever a disabled
        // provider is still holding a stale entry — otherwise its "unavailable"
        // reading outlives the disable forever, which is the phantom-failure
        // state the enable gate exists to prevent. The FULL fetcher list is
        // handed down for exactly that reason; `probeOnly` is what narrows the
        // actual probing to what this tick selected.
        const needsPrune = !!options.isEnabled
            && fetchers.some(({ provider }) => !options.isEnabled!(provider) && cache.has(provider));
        if (due.length === 0 && !needsPrune) {
            // Nothing to do — the idle-quiet path. Re-arm for the next real
            // expiry instead of the fixed interval.
            scheduleNext();
            return;
        }
        running = true;
        const probeOnly = new Set(due.map(({ provider }) => provider));
        void refreshQuotaCacheOnce(fetchers, options.isEnabled, { probeOnly })
            .catch((e: any) => LOG.warn('Quota', `Quota refresh tick error: ${e?.message || e}`))
            .finally(() => {
                running = false;
                scheduleNext();
            });
    };

    // The first wake runs on the interval, not at boot — a daemon that just
    // started has no activity to have consumed quota, and a boot-time codex
    // spawn would compete with startup work for no benefit. From the second
    // wake on, the chain sleeps per computeNextWakeDelayMs.
    timer = setTimeout(runWake, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    LOG.info('Quota', `Quota refresh loop started (first wake ${intervalMs}ms, then per-provider expiry chain; per-axis TTL, idle machines skipped)`);
    return {
        stop() {
            stopped = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (quotaCacheChangedListener === rescheduleFromOutside) {
                setQuotaCacheChangedListener(undefined);
            }
            LOG.info('Quota', 'Quota refresh loop stopped');
        },
    };
}

/**
 * Daemon-lifecycle entry point: bind the loop's idle gate to this daemon's live
 * provider instances. Kept separate from startQuotaRefreshLoop so the loop
 * itself stays testable without constructing a DaemonComponents bag.
 */
export function setupQuotaRefreshLoop(components: {
    instanceManager: { collectHotChatSessionStates(): Array<{ status?: unknown; lastMessageAt?: unknown }> };
    providerLoader?: {
        isMachineProviderEnabled(providerType: string): boolean;
        isMachineQuotaEnabled?(providerType: string): boolean;
    };
}): QuotaRefreshLoopHandle {
    return startQuotaRefreshLoop({
        hasRecentCliActivity: () => hasRecentCliActivity(components.instanceManager.collectHotChatSessionStates()),
        isEnabled: components.providerLoader
            ? quotaProviderEnabledFromLoader(components.providerLoader)
            : undefined,
    });
}
