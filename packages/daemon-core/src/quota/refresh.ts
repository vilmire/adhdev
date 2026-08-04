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
 * Latest snapshot per provider. Process-local and intentionally not persisted:
 * a restarted daemon reports nothing until its first tick, and "no report yet"
 * is a state readers already handle (absent `quota` = unknown).
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

/** Test seam: drop all cached snapshots. */
export function clearQuotaCache(): void {
    cache.clear();
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
            }
        }),
    );
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
