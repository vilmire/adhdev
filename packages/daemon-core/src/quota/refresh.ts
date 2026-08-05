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

export function hydrateQuotaCacheFromDisk(env: NodeJS.ProcessEnv = process.env): number {
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
): Promise<void> {
    await Promise.all(
        fetchers.map(async ({ provider, fetch }) => {
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
    // Persist whatever this tick produced, including per-provider failures —
    // "looked and could not read" is a state worth surviving a restart, exactly
    // like a successful reading. saveQuotaCache never throws, so a cache that
    // cannot be written leaves the in-memory result untouched.
    const snapshot = readQuotaCache();
    if (snapshot) saveQuotaCache(snapshot);
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
        if (!active) return;
        running = true;
        void refreshQuotaCacheOnce(options.fetchers)
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
}): QuotaRefreshLoopHandle {
    return startQuotaRefreshLoop({
        hasRecentCliActivity: () => hasRecentCliActivity(components.instanceManager.collectHotChatSessionStates()),
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

export function refreshQuotaCacheOnBoot(): void {
    // NOTE: the "already populated" guard deliberately ignores entries restored
    // from disk (`hydratedOnly`). Hydration exists to make a restart show its
    // last numbers INSTANTLY, not to skip re-measuring them — treating restored
    // values as "already refreshed" would pin a restarted daemon to stale
    // readings until the periodic tick 15 minutes later, which is the very gap
    // this boot refresh was added to close.
    if (bootRefreshInFlight || hasFreshlyMeasuredQuota()) return;
    bootRefreshInFlight = true;
    void refreshQuotaCacheOnce()
        .catch((e: any) => LOG.warn('Quota', `Boot quota refresh failed: ${e?.message || e}`))
        .finally(() => { bootRefreshInFlight = false; });
}

/** Test seam: reset the boot-refresh in-flight flag so cases start clean. */
export function __resetQuotaBootRefreshForTests(): void {
    bootRefreshInFlight = false;
}
