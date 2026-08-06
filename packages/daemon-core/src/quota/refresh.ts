/**
 * Quota refresh cache — the ONLY place the daemon fetches provider quota on a
 * schedule, and the buffer that keeps that cost off the request path.
 *
 * Why a cache at all, rather than fetching where the value is read: the reader
 * is `buildLocalNodeFacts`, which runs inside every `git_status` — and
 * `git_status` is what `mesh_status` probes on EVERY node, every call. Codex's
 * fetcher spawns a `codex app-server` child process (~900ms); wiring that into
 * the builder would add that cost per node per mesh_status, turning a cheap
 * coordinator poll into a multi-second one. So the timer writes, the builder
 * only reads, and the read is a synchronous map lookup that cannot block, throw
 * or await. `readQuotaCache()` deliberately exposes no way to trigger a fetch —
 * the absence of that affordance is the contract.
 *
 * Freshness is NOT asserted here: entries carry their own `updatedAt` and ride
 * a bundle stamped with `reportedAt`, and a reader judges age from those. This
 * module publishes no TTL because neither the refresh cadence nor the delivery
 * cadence is in its control (delivery is driven by whoever calls git_status).
 */
'use strict';

import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import type { ProviderQuota, QuotaProvider } from './types.js';
import { QUOTA_TRANSIENT_RETRY_DELAY_MS } from './types.js';
import { fetchClaudeQuota } from './fetchers/claude.js';
import { fetchCodexQuota } from './fetchers/codex.js';
import { fetchKimiQuota } from './fetchers/kimi.js';
import { loadQuotaCache, saveQuotaCache } from './persist.js';

/**
 * How often a node re-reads its own quota. Deliberately coarse: quota moves on
 * the scale of a work session, and every tick costs a codex child-process spawn.
 */
export const QUOTA_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How recently a CLI provider must have been touched for this machine to count
 * as "in use". Set a little above the refresh interval so a machine that is
 * being worked on continuously never flickers into the idle-skip between ticks.
 */
export const QUOTA_ACTIVITY_WINDOW_MS = 20 * 60 * 1000;

/** The providers a node reports. One entry per shipped fetcher. */
const REFRESHERS: ReadonlyArray<{ provider: QuotaProvider; fetch: () => Promise<ProviderQuota> }> = [
    { provider: 'claude-cli', fetch: () => fetchClaudeQuota() },
    { provider: 'codex-cli', fetch: () => fetchCodexQuota() },
    { provider: 'kimi', fetch: () => fetchKimiQuota() },
];

/**
 * Whether a provider's quota is probed on THIS machine. The daemon already has
 * exactly one authority for "this machine uses provider X":
 * `ProviderLoader.isMachineProviderEnabled` — the same gate cli-manager
 * consults before launching an instance and mesh-queue-assignment consults
 * before claiming a task. A provider that fails that gate can never run here,
 * so its quota can never be spent here: probing it would spend a codex
 * app-server spawn (or surface a `missing-credentials` "failure") for a number
 * nothing on this machine can use — and that phantom failure reads like a real
 * defect next to genuine ones. The predicate is evaluated per refresh, never
 * cached, so enabling a provider later takes effect on the next tick.
 */
export type QuotaProviderEnabled = (provider: QuotaProvider) => boolean;

/**
 * Adapt the machine provider-enable authorities to the quota predicate.
 * Defined once here so the loop, the boot refresh and hydration all share one
 * mapping instead of each re-deriving "enabled" from the loader their own way.
 *
 * Two INDEPENDENT axes must BOTH pass: `isMachineProviderEnabled` says "this
 * machine uses provider X" and gates launching, mesh claims and quota probes;
 * `isMachineQuotaEnabled` gates ONLY the probe (a machine can use a provider
 * and still not want its quota read here). The quota method is optional in the
 * structural type so loaders written before the axis existed (and minimal test
 * doubles) behave as quota-enabled — absent means enabled, same as the config
 * default.
 */
export function quotaProviderEnabledFromLoader(loader: {
    isMachineProviderEnabled(providerType: string): boolean;
    isMachineQuotaEnabled?(providerType: string): boolean;
}): QuotaProviderEnabled {
    return (provider) =>
        loader.isMachineProviderEnabled(provider)
        && (loader.isMachineQuotaEnabled ? loader.isMachineQuotaEnabled(provider) : true);
}

/**
 * Latest snapshot per provider — the runtime authority.
 *
 * Backed by a file (see ./persist.ts) so a restart can restore the last
 * measurement instead of reporting nothing until the boot refresh lands. The
 * Map remains the only thing readers touch; the file is purely its
 * serialization, written after a refresh and read once at hydration. "No report
 * yet" is still a real state readers handle (absent `quota` = unknown) — it is
 * just no longer forced on every restart.
 */
const cache = new Map<string, MeshNodeFactsProviderQuota>();

/**
 * Project a fetcher result into the wire shape. daemon-core's ProviderQuota is
 * structurally assignable to the mesh-shared type, so this copies rather than
 * maps — no field-by-field translation that could drift as either side grows.
 * Failures are recorded, not dropped: a reader must be able to tell "this node
 * looked and could not read the quota" from "this node never told us".
 */
function toWireQuota(quota: ProviderQuota): MeshNodeFactsProviderQuota {
    return quota as MeshNodeFactsProviderQuota;
}

/**
 * Read the cached quota snapshots. Synchronous, side-effect free, and never
 * triggers a fetch — see the module header. Returns undefined (not an empty
 * object) when nothing has been cached, so the bundle omits the field entirely
 * rather than shipping a misleading empty map.
 */
export function readQuotaCache(): Record<string, MeshNodeFactsProviderQuota> | undefined {
    if (cache.size === 0) return undefined;
    return Object.fromEntries(cache);
}

/**
 * Providers whose entry came from the on-disk cache rather than from a fetch in
 * THIS process. Tracked so the boot refresh can tell "we already measured" from
 * "we restored someone else's measurement" — see refreshQuotaCacheOnBoot.
 */
const hydratedOnly = new Set<string>();

/** True when at least one provider was measured in this process (not restored). */
function hasFreshlyMeasuredQuota(): boolean {
    for (const provider of cache.keys()) {
        if (!hydratedOnly.has(provider)) return true;
    }
    return false;
}

/** Test seam: drop all cached snapshots. */
export function clearQuotaCache(): void {
    cache.clear();
    hydratedOnly.clear();
    hydrated = false;
    for (const state of failureRetries.values()) {
        if (state.timer) clearTimeout(state.timer);
    }
    failureRetries.clear();
}

/**
 * Restore the last persisted snapshots into the Map. One-shot per process and
 * deliberately NOT called from `readQuotaCache` — the read path must stay a
 * synchronous Map lookup with no file I/O (see the module header).
 *
 * Never overwrites a live entry: anything already measured in this process is
 * newer than anything on disk, so hydration only fills gaps. That also makes a
 * late call harmless.
 *
 * Fail-soft by construction — `loadQuotaCache` resolves every error to "no
 * cache", which is the state a daemon is in before its first refresh anyway.
 */
let hydrated = false;

export function hydrateQuotaCacheFromDisk(
    env: NodeJS.ProcessEnv = process.env,
    isEnabled?: QuotaProviderEnabled,
): number {
    if (hydrated) return 0;
    hydrated = true;
    let restored: Record<string, MeshNodeFactsProviderQuota> | undefined;
    try {
        restored = loadQuotaCache(env);
    } catch (e: any) {
        // loadQuotaCache does not throw, but a hydration failure must never be
        // able to take down daemon startup.
        LOG.warn('Quota', `Quota cache hydration failed (starting empty): ${e?.message || e}`);
        return 0;
    }
    if (!restored) return 0;
    let count = 0;
    for (const [provider, quota] of Object.entries(restored)) {
        if (cache.has(provider)) continue; // a live measurement always wins
        // A provider disabled since the snapshot was written is not restored:
        // its stale "unavailable" reading would otherwise keep showing for a
        // provider this machine no longer runs — the exact phantom-failure
        // noise the enable gate exists to remove.
        if (isEnabled && !isEnabled(provider as QuotaProvider)) continue;
        cache.set(provider, quota);
        hydratedOnly.add(provider);
        count += 1;
    }
    if (count > 0) LOG.info('Quota', `Restored ${count} provider quota snapshot(s) from the on-disk cache`);
    return count;
}

/** Test seam: allow a fresh hydration in the same process. */
export function __resetQuotaHydrationForTests(): void {
    hydrated = false;
}

/**
 * Refresh every provider once and store the results.
 *
 * Fetchers never throw by contract (each failure path resolves to a snapshot
 * whose `status` is 'error'/'unavailable'), but this still guards each one: a
 * fetcher that breaks that contract must not take down the tick and starve the
 * other providers' snapshots.
 */
export async function refreshQuotaCacheOnce(
    fetchers: ReadonlyArray<{ provider: QuotaProvider; fetch: () => Promise<ProviderQuota> }> = REFRESHERS,
    isEnabled?: QuotaProviderEnabled,
): Promise<void> {
    // A disabled provider is not probed at all — no spawn, no request — and any
    // snapshot it left behind (live or hydrated) is dropped, so a stale
    // "unavailable" reading cannot outlive the disable and keep masquerading as
    // a current problem. The prune runs even when the active list ends up
    // empty: the persist below then rewrites the file without those entries.
    const active = isEnabled ? fetchers.filter(({ provider }) => isEnabled(provider)) : fetchers;
    if (isEnabled) {
        for (const { provider } of fetchers) {
            if (!isEnabled(provider)) {
                cache.delete(provider);
                hydratedOnly.delete(provider);
                cancelFailureRetry(provider);
            }
        }
    }
    await Promise.all(
        active.map(async ({ provider, fetch }) => {
            try {
                cache.set(provider, toWireQuota(await fetch()));
                hydratedOnly.delete(provider); // measured in this process now
            } catch (e: any) {
                // Contract violation, not an ordinary quota failure — record it
                // as one so the provider still reports a definite "could not
                // read" instead of silently vanishing from the bundle.
                cache.set(provider, {
                    provider,
                    status: 'error',
                    session: null,
                    weekly: null,
                    updatedAt: Date.now(),
                    error: `Quota fetch threw: ${e?.message || e}`,
                    metadata: { failureKind: 'unknown' },
                });
                hydratedOnly.delete(provider);
            }
        }),
    );
    // Transient-failure retry bookkeeping, driven by what this tick actually
    // recorded (success resets, persistent failure cancels, transient failure
    // schedules a bounded retry — see updateFailureRetry).
    for (const { provider, fetch } of active) {
        updateFailureRetry(provider, fetch, isEnabled);
    }
    // Persist whatever this tick produced, including per-provider failures —
    // "looked and could not read" is a state worth surviving a restart, exactly
    // like a successful reading. saveQuotaCache never throws, so a cache that
    // cannot be written leaves the in-memory result untouched.
    const snapshot = readQuotaCache();
    if (snapshot) saveQuotaCache(snapshot);
}

/**
 * Bounded retries for TRANSIENT failures (see TRANSIENT_QUOTA_FAILURE_KINDS in
 * ./types.ts — those carry a `retryAtMs` stamp).
 *
 * Why this exists: Kimi's access tokens live ~15 minutes and the refresh loop
 * ticks every 15 minutes, so a daemon that reads the token file in the seconds
 * before the CLI refreshes it records `expired-token` and would otherwise
 * report that stale error for a whole tick even though the token was renewed
 * moments later. A failure whose kind can resolve itself is therefore retried
 * on a short fuse instead of waiting for the next cadenced tick.
 *
 * Why it cannot run away: each consecutive transient failure doubles the delay
 * (2m → 4m → 8m → 15m, capped at the normal refresh interval), and after
 * QUOTA_FAILURE_MAX_RETRIES consecutive failures the scheduler stops entirely
 * — the entry keeps its (past) retryAtMs but `isFailureRetryDue` then reports
 * false, so the loop's backfill gate stops firing on it too. Recovery from
 * that state comes from the ordinary activity-gated tick or an event-driven
 * refresh, both of which reset the counter on success. A persistent failure
 * (no retryAtMs) never schedules anything, matching the pre-existing "a
 * recorded failure counts as a snapshot" rule. At steady state the worst case
 * is one extra fetch per normal interval — never a storm, and an idle machine
 * with a permanently failing provider pays at most a handful of fetches per
 * failure episode.
 */
export const QUOTA_FAILURE_MAX_RETRIES = 4;

interface FailureRetryState {
    /** Consecutive transient failures since the last success. */
    failures: number;
    timer: NodeJS.Timeout | null;
}

const failureRetries = new Map<string, FailureRetryState>();

function cancelFailureRetry(provider: QuotaProvider): void {
    const state = failureRetries.get(provider);
    if (state?.timer) clearTimeout(state.timer);
    failureRetries.delete(provider);
}

/**
 * True when the cached entry is a transient failure whose retry time has
 * passed AND its retry budget is not exhausted. The loop's backfill gate uses
 * this so a cached failure no longer masquerades as a usable snapshot
 * (`cache.has()` alone could not tell the two apart), while an exhausted
 * budget still counts as "has a snapshot" and stays on the normal cadence.
 */
export function isFailureRetryDue(provider: QuotaProvider, now: number = Date.now()): boolean {
    const entry = cache.get(provider);
    if (!entry || entry.status === 'ok') return false;
    const retryAtMs = entry.metadata?.retryAtMs;
    if (typeof retryAtMs !== 'number' || retryAtMs > now) return false;
    return (failureRetries.get(provider)?.failures ?? 0) <= QUOTA_FAILURE_MAX_RETRIES;
}

/**
 * Reconcile the retry schedule with the entry this refresh just recorded.
 * Called once per refreshed provider from refreshQuotaCacheOnce so every
 * refresh path — boot, periodic tick, event-driven, retry itself — funnels
 * through the same bookkeeping. The retry re-uses the SAME fetch function
 * that produced the failure, so injected test fetchers stay injected.
 */
function updateFailureRetry(
    provider: QuotaProvider,
    fetch: () => Promise<ProviderQuota>,
    isEnabled?: QuotaProviderEnabled,
): void {
    const entry = cache.get(provider);
    const retryAtMs = entry && entry.status !== 'ok' ? entry.metadata?.retryAtMs : undefined;
    if (typeof retryAtMs !== 'number') {
        // Success, or a persistent failure: nothing to retry soon.
        cancelFailureRetry(provider);
        return;
    }
    const previous = failureRetries.get(provider);
    if (previous?.timer) clearTimeout(previous.timer);
    const failures = (previous?.failures ?? 0) + 1;
    if (failures > QUOTA_FAILURE_MAX_RETRIES) {
        failureRetries.set(provider, { failures, timer: null });
        LOG.info('Quota', `${provider}: transient failure persists after ${QUOTA_FAILURE_MAX_RETRIES} retries — back to the normal refresh cadence`);
        return;
    }
    const backoffMs = Math.min(
        QUOTA_TRANSIENT_RETRY_DELAY_MS * 2 ** (failures - 1),
        QUOTA_REFRESH_INTERVAL_MS,
    );
    // A server-dictated retry time (HTTP Retry-After) wins when it is later.
    const delayMs = Math.max(retryAtMs - Date.now(), backoffMs, 0);
    const timer = setTimeout(() => {
        const state = failureRetries.get(provider);
        if (state) state.timer = null;
        // The enable gate is re-evaluated at fire time: a provider disabled
        // since the failure was recorded is never re-probed.
        if (isEnabled && !isEnabled(provider)) return;
        void refreshQuotaCacheOnce([{ provider, fetch }], isEnabled)
            .catch((e: any) => LOG.warn('Quota', `${provider}: scheduled retry failed: ${e?.message || e}`));
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    failureRetries.set(provider, { failures, timer });
    LOG.info('Quota', `${provider}: transient failure — retry scheduled in ${Math.round(delayMs / 1000)}s (attempt ${failures}/${QUOTA_FAILURE_MAX_RETRIES})`);
}

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
 * projection. The richer `collectAllStates()` would be wrong here twice over:
 * it can run transcript parsing, and it DRAINS each instance's pendingEvents
 * into event listeners, so polling it on a timer would consume events out from
 * under the real consumer.
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
 * Start the periodic refresh. Mirrors the mesh reconcile loop's shape: a single
 * non-overlapping interval that unrefs itself so it never keeps the process
 * alive, plus a stop() handle for shutdown.
 *
 * The first tick runs on the interval, not at boot — a daemon that just started
 * has no activity to have consumed quota, and a boot-time codex spawn would
 * compete with startup work for no benefit.
 */
export function startQuotaRefreshLoop(options: QuotaRefreshLoopOptions): QuotaRefreshLoopHandle {
    const intervalMs = options.intervalMs ?? QUOTA_REFRESH_INTERVAL_MS;
    const fetchers = options.fetchers ?? REFRESHERS;
    let running = false;
    const timer = setInterval(() => {
        if (running) return; // never overlap ticks
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
        const needsBackfill = options.isEnabled
            ? fetchers.some(({ provider }) =>
                options.isEnabled!(provider) && (!cache.has(provider) || isFailureRetryDue(provider)))
            : false;
        if (!active && !needsBackfill) return;
        running = true;
        void refreshQuotaCacheOnce(fetchers, options.isEnabled)
            .catch((e: any) => LOG.warn('Quota', `Quota refresh tick error: ${e?.message || e}`))
            .finally(() => { running = false; });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    LOG.info('Quota', `Quota refresh loop started (interval ${intervalMs}ms, idle machines skipped)`);
    return {
        stop() {
            clearInterval(timer);
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

/**
 * One-shot boot-time refresh so a freshly started daemon does not sit for a
 * full QUOTA_REFRESH_INTERVAL_MS (15 min) before quota shows up anywhere
 * (get_machine_runtime_stats / get_session_info / mesh_status). The periodic
 * loop's first tick is deliberately NOT at boot (see startQuotaRefreshLoop) —
 * this is the one call that IS.
 *
 * Deliberately bypasses hasRecentCliActivity: the whole point of the idle gate
 * is "an agent hasn't run recently, so the number can't have moved" — but in
 * the seconds after boot there is BY DEFINITION no recent activity yet, so
 * gating this call on the same signal would always skip it and the boot
 * refresh would never fire, defeating the feature entirely. Every tick after
 * this one still goes through the unmodified idle gate via
 * startQuotaRefreshLoop.
 *
 * Fire-and-forget by design — the caller (initDaemonComponents) must not
 * await this. Codex's fetcher spawns an `codex app-server` child (~900ms);
 * that cost must never be added to daemon startup latency, which is exactly
 * the cost this module's cache exists to keep off any synchronous path (see
 * module header). A fetch failure is caught and logged, never thrown, so it
 * can never fail the boot sequence it doesn't block.
 *
 * Idempotent per process: skips outright if the cache already holds anything
 * OR a boot refresh is already in flight, so calling this more than once —
 * including twice back-to-back before the first fetch resolves, which the
 * cache-emptiness check alone would not catch — never spends more than one
 * codex spawn per process. A daemon that restarts often each gets its own
 * fresh empty cache and `bootRefreshInFlight` flag (see the `cache` doc
 * above), so that case still costs one spawn per restart, which is the
 * unavoidable price of the feature this call implements.
 */
let bootRefreshInFlight = false;

export function refreshQuotaCacheOnBoot(isEnabled?: QuotaProviderEnabled): void {
    // NOTE: the "already populated" guard deliberately ignores entries restored
    // from disk (`hydratedOnly`). Hydration exists to make a restart show its
    // last numbers INSTANTLY, not to skip re-measuring them — treating restored
    // values as "already refreshed" would pin a restarted daemon to stale
    // readings until the periodic tick 15 minutes later, which is the very gap
    // this boot refresh was added to close.
    if (bootRefreshInFlight || hasFreshlyMeasuredQuota()) return;
    bootRefreshInFlight = true;
    void refreshQuotaCacheOnce(REFRESHERS, isEnabled)
        .catch((e: any) => LOG.warn('Quota', `Boot quota refresh failed: ${e?.message || e}`))
        .finally(() => { bootRefreshInFlight = false; });
}

/** Test seam: reset the boot-refresh in-flight flag so cases start clean. */
export function __resetQuotaBootRefreshForTests(): void {
    bootRefreshInFlight = false;
}

/**
 * Minimum gap between two event-triggered refreshes of the SAME provider. A
 * busy session can complete many turns a minute; quota moves on the scale of
 * a 5-hour window, so anything finer than this buys nothing but fetch cost.
 */
export const QUOTA_EVENT_REFRESH_DEBOUNCE_MS = 60_000;

export interface QuotaEventRefreshOptions {
    debounceMs?: number;
    /** Injectable for tests; defaults to Date.now. */
    now?: () => number;
}

/**
 * Event-driven quota refresh: re-read ONE provider's quota right after one of
 * its agents finishes a turn (`agent:generating_completed`) — the moment the
 * numbers are guaranteed to have just moved. The periodic loop alone leaves
 * the post-turn reading up to 15 minutes stale; the boot refresh obviously
 * cannot help mid-session either.
 *
 * This is deliberately a COMPLEMENT to the transient-failure retry above, not
 * a fix for the token race: the completion event can fire in the same turn
 * whose token expired, i.e. BEFORE the CLI renewed it, so an event-triggered
 * refetch may still record `expired-token`. The retry scheduler is what
 * recovers from that; this path is what keeps successful readings fresh.
 *
 * Selectivity rules:
 *  - only the provider the event belongs to is refetched (a kimi turn never
 *    spends a codex app-server spawn);
 *  - a provider with no fetcher (or a non-quota provider type) is ignored;
 *  - the machine enable gate is consulted per event, so a disabled provider
 *    is never probed;
 *  - per-provider debounce bounds a turn-heavy session to one fetch per
 *    QUOTA_EVENT_REFRESH_DEBOUNCE_MS.
 *
 * Disk persistence is NOT reimplemented here: every refresh funnels through
 * refreshQuotaCacheOnce, which already persists via ./persist.ts.
 */
export function setupQuotaEventRefresh(
    components: {
        instanceManager: {
            onEvent(listener: (event: { event?: unknown; providerType?: unknown }) => void): void;
        };
        providerLoader?: {
            isMachineProviderEnabled(providerType: string): boolean;
            isMachineQuotaEnabled?(providerType: string): boolean;
        };
    },
    options: QuotaEventRefreshOptions = {},
): QuotaRefreshLoopHandle {
    const isEnabled = components.providerLoader
        ? quotaProviderEnabledFromLoader(components.providerLoader)
        : undefined;
    const debounceMs = options.debounceMs ?? QUOTA_EVENT_REFRESH_DEBOUNCE_MS;
    const now = options.now ?? Date.now;
    const lastRefreshAt = new Map<string, number>();
    let stopped = false;
    components.instanceManager.onEvent((event) => {
        if (stopped) return;
        if (event.event !== 'agent:generating_completed') return;
        const refresher = typeof event.providerType === 'string'
            ? REFRESHERS.find(({ provider }) => provider === event.providerType)
            : undefined;
        if (!refresher) return; // not a quota-reporting provider
        if (isEnabled && !isEnabled(refresher.provider)) return;
        const at = now();
        if (at - (lastRefreshAt.get(refresher.provider) ?? -Infinity) < debounceMs) return;
        lastRefreshAt.set(refresher.provider, at);
        void refreshQuotaCacheOnce([refresher], isEnabled)
            .catch((e: any) => LOG.warn('Quota', `Event-driven quota refresh failed: ${e?.message || e}`));
    });
    LOG.info('Quota', `Event-driven quota refresh armed (agent:generating_completed, ${debounceMs}ms debounce)`);
    return {
        stop() {
            stopped = true;
            LOG.info('Quota', 'Event-driven quota refresh stopped');
        },
    };
}
