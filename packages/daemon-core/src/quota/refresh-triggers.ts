/**
 * Out-of-band quota refresh triggers: the one-shot boot refresh, the debounced
 * refresh on session lifecycle events, stale-while-revalidate reads, and the
 * operator's forced refresh (which bypasses TTLs and reports per-provider results).
 */
import { hasFreshlyMeasuredQuota, REFRESHERS, isRateLimitedSnapshot, cache, refreshQuotaCacheOnce, quotaProviderEnabledFromLoader, readQuotaCache, ambientIsEnabled, isRateLimitedCooldownActive, isDueBySwrTtl, type QuotaProviderEnabled } from './refresh.js';
import { LOG } from '../logging/logger.js';
import type { SessionLifecycleBus } from '../sessions/lifecycle-bus.js';
import type { ProviderState } from '../providers/provider-instance.js';
import type { QuotaRefreshLoopHandle } from './refresh-loop.js';
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import type { QuotaProvider } from './types.js';

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
 * Fire-and-forget by design — the caller (the boot's startLoops stage) must not
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
    // Restarting cannot lift a provider 429. Re-probing a cached rate-limited
    // snapshot on every boot is how a daemon that restarts during an outage
    // keeps the method budget exhausted. Last-good windows already sit on the
    // snapshot; recovery is the scheduled retry / the periodic tick.
    const fetchers = REFRESHERS.filter(({ provider }) => !isRateLimitedSnapshot(cache.get(provider)));
    void refreshQuotaCacheOnce(fetchers, isEnabled)
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
 * Every committed turn warrants an immediate re-read of the provider's quota —
 * whether it completed genuinely/weakly (the wire's `agent:generating_completed`)
 * or ended some other way, failed or cancelled (the wire's `agent:stopped`:
 * manual stop, PTY/ACP process exit, or a provider-reported error, all of
 * which route through the CLI/ACP FSMs into one `turn_end` / `process_exit`
 * evidence kind before the reducer commits). `TurnOutcome` is the closed union
 * `'completed' | 'failed' | 'cancelled'`, so every `phase:'committed'` bus
 * event already qualifies — there is no separate filter to apply.
 *
 * All three outcomes are covered because of an incident (2026-08-17) where a
 * session's only terminal signal was a failed/cancelled exit — the
 * event-driven path never armed on completion alone, so quota fell back to
 * the 15-minute cadence and a routing decision a few minutes later used a
 * 3-day-stale cached value. A turn ending abnormally is exactly when a
 * re-read matters most: it is the last chance to capture what the
 * just-finished (or just-aborted) turn spent before the next cadenced tick.
 *
 * Wiring-unification C-W5 follow-up (2026-09-24): migrated from the
 * transitional `provider_event` bag (`agent:generating_completed` /
 * `agent:stopped` object-literal matching) to the turn ledger's own
 * `turn{phase:'committed'}` bus event — the ONE place a turn is now decided
 * done, so this refresh can never miss a completion that fails to construct
 * the legacy wire name, and never double-fires on one that does.
 */

/**
 * Event-driven quota refresh: re-read ONE provider's quota right after one of
 * its agents finishes or ends a turn (see QUOTA_REFRESH_EVENTS) — the moment
 * the numbers are guaranteed to have just moved. The periodic loop alone
 * leaves the post-turn reading up to 15 minutes stale; the boot refresh
 * obviously cannot help mid-session either.
 *
 * This is deliberately a COMPLEMENT to the transient-failure retry above, not
 * a fix for the token race: the triggering event can fire in the same turn
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
 *  - per-provider debounce bounds a turn-heavy or stop-heavy session to one
 *    fetch per QUOTA_EVENT_REFRESH_DEBOUNCE_MS — this is what keeps repeated
 *    manual stops or a crash-looping provider from hammering the fetcher, the
 *    same bound that already applied to a burst of completions.
 *
 * Disk persistence is NOT reimplemented here: every refresh funnels through
 * refreshQuotaCacheOnce, which already persists via ./persist.ts.
 */
export function setupQuotaEventRefresh(
    components: {
        /** Turn commits arrive as the bus's `turn{phase:'committed'}` (wiring-unification C1/C5). */
        bus: Pick<SessionLifecycleBus, 'on'>;
        /** Resolves the committing session's providerType — a `TurnBusEvent` carries only `sessionId`. */
        instanceManager?: { getInstance?(sessionId: string): { getState?(): ProviderState | undefined } | undefined } | null;
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
    const resolveProviderType = (sessionId: string): string | undefined => {
        try {
            const getInstance = components.instanceManager?.getInstance;
            if (typeof getInstance !== 'function') return undefined;
            const state = getInstance.call(components.instanceManager, sessionId)?.getState?.();
            const type = (state as { type?: unknown } | undefined)?.type;
            return typeof type === 'string' && type ? type : undefined;
        } catch {
            return undefined;
        }
    };
    const off = components.bus.on('turn', (e) => {
        if (stopped || e.phase !== 'committed') return;
        const providerType = resolveProviderType(e.sessionId);
        const refresher = providerType ? REFRESHERS.find(({ provider }) => provider === providerType) : undefined;
        if (!refresher) return; // not a quota-reporting provider, or the instance is already gone
        if (isEnabled && !isEnabled(refresher.provider)) return;
        // A turn ending is the worst moment to re-hit a rate-limited quota
        // method: the owning CLI just ran its own doRefreshQuota. Leave
        // recovery to the scheduled retry / the periodic tick.
        if (isRateLimitedSnapshot(cache.get(refresher.provider))) return;
        const at = now();
        if (at - (lastRefreshAt.get(refresher.provider) ?? -Infinity) < debounceMs) return;
        lastRefreshAt.set(refresher.provider, at);
        void refreshQuotaCacheOnce([refresher], isEnabled)
            .catch((err: any) => LOG.warn('Quota', `Event-driven quota refresh failed: ${err?.message || err}`));
    }, { name: 'quota.event-refresh' });
    LOG.info('Quota', `Event-driven quota refresh armed (turn commits, ${debounceMs}ms debounce)`);
    return {
        stop() {
            stopped = true;
            try { off(); } catch { /* bus already closed */ }
            LOG.info('Quota', 'Event-driven quota refresh stopped');
        },
    };
}

// ─── Read-triggered revalidation (SWR) ───

/**
 * Providers with a revalidate already in flight. Single-flight, because the
 * surfaces that trigger one are bursty by nature: opening the machine page
 * fires get_machine_runtime_stats, and a dashboard that re-renders or a user
 * who clicks twice would otherwise stack N identical fetches against the same
 * third-party endpoint — precisely the burst the 429 cooldown exists to
 * survive, arriving from our own side.
 */
export const revalidateInFlight = new Set<string>();

/**
 * Read the cache and, when an entry has aged past its axis TTL, schedule a
 * background refresh — stale-while-revalidate.
 *
 * ★The return value is ALWAYS the current cached value, never the revalidated
 * one: this must not become an await point. Callers are user-facing read
 * surfaces (the machine page, the session-info popup, the force-refresh
 * reporter), and the value they render is the one already in hand; the fetch
 * this schedules improves the NEXT read.
 *
 * ★WHY THIS IS A SEPARATE FUNCTION FROM readQuotaCache(). readQuotaCache() is
 * called from the 4-second mesh reconcile tick and from every `git_status`.
 * Giving THAT function a fetch affordance — even a deferred one — would put a
 * third-party HTTP call behind the mesh's hottest read path, multiplied by node
 * count and provider count. The absence of the affordance there is the contract
 * (see the module header); this wrapper is how a low-rate caller opts in, and
 * the split is the whole reason it is safe to opt in at all.
 *
 * Everything the revalidate does goes through `refreshQuotaCacheOnce`, so the
 * 429 cooldown, the carry-forward, the enable gate and the persist all apply
 * unchanged — see the note on that function.
 */
export function readQuotaCacheWithRevalidate(
    now: number = Date.now(),
): Record<string, MeshNodeFactsProviderQuota> | undefined {
    const snapshot = readQuotaCache();
    try {
        scheduleStaleRevalidate(now);
    } catch (e: any) {
        // A read surface must never fail because a background refresh could not
        // be scheduled — the cached value it already holds is still correct.
        LOG.warn('Quota', `Quota revalidate scheduling failed: ${e?.message || e}`);
    }
    return snapshot;
}

/**
 * Kick off a background refresh for every provider whose axis TTL has elapsed.
 *
 * The TTL is measured off the last refresh ATTEMPT (`fetchedAt`), not off
 * `updatedAt` — see the two-clocks note. Driving this off `updatedAt` would
 * make a file-source provider whose file has not changed permanently "due", so
 * every read would fire a fetch: a hot loop on the cheap axis and, on the
 * network axis, an endpoint hit per dashboard render.
 */
function scheduleStaleRevalidate(now: number): void {
    const due = REFRESHERS.filter(({ provider }) => {
        if (ambientIsEnabled && !ambientIsEnabled(provider)) return false;
        if (revalidateInFlight.has(provider)) return false;
        // ★The 429 cooldown is checked HERE as well as inside
        // refreshQuotaCacheOnce. The inner filter is the real enforcement and
        // must never be removed; this outer check exists so a cooling-down
        // provider is not marked in-flight for a call that will fetch nothing.
        if (isRateLimitedCooldownActive(cache.get(provider), now)) return false;
        // ★The SWR table, not the cadence table — a read is demand, and demand
        // is what justifies a network-axis fetch that a timer does not.
        return isDueBySwrTtl(provider, now);
    });
    if (due.length === 0) return;
    for (const { provider } of due) revalidateInFlight.add(provider);
    const probeOnly = new Set(due.map(({ provider }) => provider));
    void refreshQuotaCacheOnce(REFRESHERS, ambientIsEnabled, { probeOnly })
        .catch((e: any) => LOG.warn('Quota', `Quota revalidate failed: ${e?.message || e}`))
        .finally(() => {
            for (const { provider } of due) revalidateInFlight.delete(provider);
        });
}

/** True while a read-triggered revalidate is in flight for the provider. */
export function isQuotaRevalidateInFlight(provider: QuotaProvider): boolean {
    return revalidateInFlight.has(provider);
}

// ─── Explicit force refresh ───

/** What a force refresh did to one provider. */
export interface QuotaForceRefreshEntry {
    provider: QuotaProvider;
    /**
     * `refreshed`  — probed, and the cache now holds this attempt's result.
     * `cooldown`   — ★skipped because the provider is in a 429 cooldown. The
     *                caller MUST surface this and `retryAtMs`; silently doing
     *                nothing is the failure mode this field exists to prevent.
     * `disabled`   — not probed: the machine has the provider (or its quota
     *                probe) turned off.
     * `unsupported`— the name is not a provider that reports quota here.
     */
    outcome: 'refreshed' | 'cooldown' | 'disabled' | 'unsupported';
    /** Unix ms the cooldown lifts. Only set when outcome is 'cooldown'. */
    retryAtMs?: number;
    /** Human-readable reason, always set for a non-'refreshed' outcome. */
    reason?: string;
}

export interface QuotaForceRefreshResult {
    entries: QuotaForceRefreshEntry[];
    /** The cache as it stands after the refresh — what the caller renders. */
    quota: Record<string, MeshNodeFactsProviderQuota> | undefined;
}

/**
 * ★EXPLICIT FORCE REFRESH — "read the numbers again, now."
 *
 * This is the affordance that makes the wider staleness window (60 min) an
 * acceptable trade: the one real cost of a long TTL is "I want the current
 * value and I have to wait for it", and this removes that cost without making
 * every other machine on the mesh poll harder.
 *
 * ★IT DOES NOT BYPASS THE 429 COOLDOWN, and that is deliberate rather than an
 * oversight. The tempting reading — "the user asked explicitly, so just hit the
 * endpoint" — is exactly how the 2026-08-20 antigravity incident happened: the
 * provider's own CLI throttles itself to ~7 minutes after a burst, and a
 * user-triggered override would let a few impatient clicks put the quota method
 * back into RESOURCE_EXHAUSTED, which then breaks quota reporting for everyone
 * including the person who clicked. So a cooling-down provider is REPORTED, not
 * probed and not silently ignored: the caller gets outcome 'cooldown' plus the
 * time the cooldown lifts, and tells the user. ★A refusal the user can see is
 * the correct behaviour here; the two wrong behaviours are hitting anyway and
 * saying nothing.
 *
 * ★The FILE axis has no cooldown to respect (network cost zero), so a force
 * refresh there is always an immediate re-read — which is what makes the
 * command feel instant for claude/codex/opencode even while a network-axis
 * provider is cooling down.
 *
 * Runs in the DAEMON, through refreshQuotaCacheOnce, so it warms the same cache
 * that routing and every dashboard read — unlike `adhdev quota <provider>`,
 * which calls a fetcher in a separate CLI process and leaves the daemon's cache
 * untouched.
 */
export async function forceRefreshQuota(
    providers?: ReadonlyArray<string>,
    now: number = Date.now(),
): Promise<QuotaForceRefreshResult> {
    const requested = providers && providers.length > 0
        ? providers.map((p) => String(p).trim()).filter(Boolean)
        : REFRESHERS.map(({ provider }) => provider);

    const entries: QuotaForceRefreshEntry[] = [];
    const probe: QuotaProvider[] = [];

    for (const name of requested) {
        const refresher = REFRESHERS.find(({ provider }) => provider === name);
        if (!refresher) {
            entries.push({
                provider: name as QuotaProvider,
                outcome: 'unsupported',
                reason: `'${name}' does not report quota on this machine`,
            });
            continue;
        }
        const provider = refresher.provider;
        if (ambientIsEnabled && !ambientIsEnabled(provider)) {
            entries.push({
                provider,
                outcome: 'disabled',
                reason: `${provider} is disabled on this machine (or its quota probe is turned off)`,
            });
            continue;
        }
        const entry = cache.get(provider);
        if (isRateLimitedCooldownActive(entry, now)) {
            const retryAtMs = Number(entry?.metadata?.retryAtMs);
            const seconds = Math.max(0, Math.ceil((retryAtMs - now) / 1000));
            entries.push({
                provider,
                outcome: 'cooldown',
                retryAtMs,
                reason: `${provider} hit its provider's rate limit — not re-probed for another ${formatDuration(seconds)}. The numbers shown are the last good reading.`,
            });
            continue;
        }
        probe.push(provider);
    }

    if (probe.length > 0) {
        // The full list is passed so the enable-gate prune still runs, exactly
        // as on a periodic tick; probeOnly narrows what is fetched.
        await refreshQuotaCacheOnce(REFRESHERS, ambientIsEnabled, { probeOnly: new Set(probe) })
            .catch((e: any) => LOG.warn('Quota', `Force quota refresh failed: ${e?.message || e}`));
        for (const provider of probe) entries.push({ provider, outcome: 'refreshed' });
    }

    // Stable, predictable ordering for a user-facing report.
    entries.sort((a, b) => a.provider.localeCompare(b.provider));
    return { entries, quota: readQuotaCache() };
}

/** "6m 12s" / "45s" — a cooldown remainder a person can act on. */
function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
