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
 * ★That contract is UNCHANGED by the 2026-08-21 SWR work. Read-triggered
 * revalidation is a separate function, `readQuotaCacheWithRevalidate()`, and
 * only the low-rate human-facing surfaces call it. The hot readers — the mesh
 * reconcile tick and `buildLocalNodeFacts` — still call `readQuotaCache()` and
 * still cannot cause a fetch. Do not merge the two.
 *
 * Freshness is NOT asserted here: entries carry their own `updatedAt` and ride
 * a bundle stamped with `reportedAt`, and a reader judges age from those. This
 * module publishes no TTL for DELIVERY because the delivery cadence is not in
 * its control (it is driven by whoever calls git_status); the per-provider
 * REFRESH TTLs it does publish (QUOTA_AXIS_TTL_MS) govern only when this module
 * re-probes, which is its own business.
 *
 * ★Two clocks ride each entry and mean different things — `updatedAt` is when
 * the DATA was captured (for file-source providers, the source file's own
 * stamp, which does not move when the file does not change) and
 * `metadata.fetchedAt` is when this process last ATTEMPTED a refresh. Scheduling
 * reads the latter, users and the routing gate read the former. See
 * `stampFetchedAt` before touching either.
 */
'use strict';

import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import type { ProviderQuota, QuotaProvider } from './types.js';
import { QUOTA_TRANSIENT_RETRY_DELAY_MS, TRANSIENT_QUOTA_FAILURE_KINDS } from './types.js';
import { fetchAntigravityQuota } from './fetchers/antigravity.js';
import { fetchClaudeQuota } from './fetchers/claude.js';
import { fetchCodexQuota } from './fetchers/codex.js';
import { fetchCursorQuota } from './fetchers/cursor.js';
import { fetchGrokQuota } from './fetchers/grok.js';
import { fetchKimiQuota } from './fetchers/kimi.js';
import { fetchOpencodeUsage } from './fetchers/opencode.js';
import { loadQuotaCache, saveQuotaCache } from './persist.js';

/**
 * How often a node re-reads its own quota. Deliberately coarse: quota moves on
 * the scale of a work session, and a tick used to cost a codex child-process
 * spawn for every provider.
 *
 * As of the 2026-08-21 axis split this is a scheduling FALLBACK, not the refresh
 * policy: what each wake actually probes is decided per provider by its axis TTL
 * (see QUOTA_AXIS and isDueByAxisTtl). The NETWORK axis is excluded from
 * cadenced ticking entirely — see QUOTA_AXIS.
 *
 * As of the timer-chain change (see startQuotaRefreshLoop) the loop no longer
 * wakes on this fixed period; it sleeps until the earliest per-provider EXPIRY.
 * This constant still serves three roles there: the first wake's delay, the
 * fallback when no expiry is computable, and the ceiling on sleeps while any
 * provider is disabled (so a later enable is still noticed within one
 * interval, exactly as when this was the tick period).
 */
export const QUOTA_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How recently a CLI provider must have been touched for this machine to count
 * as "in use". Set a little above the refresh interval so a machine that is
 * being worked on continuously never flickers into the idle-skip between ticks.
 */
export const QUOTA_ACTIVITY_WINDOW_MS = 20 * 60 * 1000;

/**
 * ★AXIS SPLIT (owner decision 2026-08-21, design
 * docs/design/2026-08-21-quota-refresh-lazy-transition.md).
 *
 * Before this, ALL SIX providers shared one 15-minute schedule — three file
 * reads (network cost 0) locked to the same cadence as three OAuth calls to
 * someone else's server. That single schedule is the whole waste: it made the
 * cheap providers needlessly stale to protect the expensive ones, and it kept
 * hitting third-party quota endpoints on a timer even when nothing had asked.
 *
 * Two axes now:
 *
 *  - `file`    — the reading is already on this machine. claude-cli reads the
 *                statusline snapshot file, codex-cli reads the newest rollout
 *                file, opencode spawns `opencode stats`. Network cost is ZERO,
 *                so a short TTL is nearly free and simply makes the numbers
 *                better. opencode gets a longer TTL than the two pure file
 *                reads because a child process is not free (see the TTL table).
 *  - `network` — the reading only exists on a third party's server (kimi,
 *                cursor-cli, grok-cli, antigravity-cli OAuth calls). ★These are REMOVED
 *                from cadenced ticking. They refresh on exactly four triggers:
 *                  1. a turn ending (setupQuotaEventRefresh, 60s debounce) —
 *                     the moment the number actually moved;
 *                  2. the routing-staleness backfill (isSnapshotStaleForRouting)
 *                     — ★the safety net, the only guarantee a snapshot never
 *                     ages out of the routing gate's trust window forever;
 *                  3. a read-triggered SWR revalidate (readQuotaCacheWithRevalidate);
 *                  4. boot, and an explicit force refresh.
 *
 * Axis membership is a property of where the number LIVES, not of the provider
 * — if a fetcher's source ever changes (codex already moved from an app-server
 * spawn to a local rollout read), move it here and the schedule follows.
 */
export type QuotaAxis = 'file' | 'network';

export const QUOTA_AXIS: Readonly<Record<QuotaProvider, QuotaAxis>> = {
    'antigravity-cli': 'network',
    'claude-cli': 'file',
    'codex-cli': 'file',
    'cursor-cli': 'network',
    'grok-cli': 'network',
    'kimi': 'network',
    'opencode': 'file',
};

/**
 * Per-provider TTL: how old this machine's last refresh ATTEMPT may be before a
 * cadenced tick (or an SWR read) re-probes it.
 *
 * ★These are refresh floors, NOT the routing gate's trust window — that is
 * QUOTA_ROUTABLE_MAX_AGE_MS, which every axis is still backstopped by. A TTL
 * here can only make a provider FRESHER than the safety net, never staler.
 *
 * Chosen values and why:
 *  - claude-cli / codex-cli — 60s. Both are a single local file read (statusline
 *    snapshot / newest rollout). The cost is a `readFileSync` in a timer that
 *    already fired; anything longer would leave the cheapest numbers we have
 *    needlessly old. Not lower than 60s because the underlying files are
 *    themselves written at human pace — re-reading faster re-reads the same
 *    bytes.
 *  - opencode — 5 min. Still local, but each read SPAWNS `opencode stats`. A
 *    child process on a timer is a real cost (and one the 15-minute cadence was
 *    originally sized around), so it sits between the file reads and the
 *    network axis.
 *  - kimi / cursor-cli / grok-cli / antigravity-cli — ★Infinity, meaning "never due on
 *    cadence". This is the axis split's entire point: a timer must not hit a
 *    third party's endpoint. They still refresh on the four triggers listed in
 *    QUOTA_AXIS, and the staleness backfill still guarantees a floor.
 */
export const QUOTA_AXIS_TTL_MS: Readonly<Record<QuotaProvider, number>> = {
    'antigravity-cli': Number.POSITIVE_INFINITY,
    'claude-cli': 60_000,
    'codex-cli': 60_000,
    'cursor-cli': Number.POSITIVE_INFINITY,
    'grok-cli': Number.POSITIVE_INFINITY,
    'kimi': Number.POSITIVE_INFINITY,
    'opencode': 5 * 60 * 1000,
};

/**
 * ★TTL for a READ-TRIGGERED (SWR) refresh, which is a different question from
 * the cadenced TTL above and must not reuse it.
 *
 * The cadenced TTL answers "should a TIMER spend a fetch on this?", and for the
 * network axis the answer is a flat no — that is the axis split. This one
 * answers "someone is LOOKING at this number right now; is it worth a fetch?",
 * and there the answer is different, because demand is exactly the evidence the
 * timer lacks. Reusing the Infinity would make SWR a no-op on the three
 * providers whose freshness a user is most likely to be checking, which quietly
 * deletes trigger #3 from the design.
 *
 * The network axis gets 10 min: long enough that a dashboard left open, or a
 * page reloaded a few times, does not turn into a stream of third-party calls;
 * short enough that "I opened the page to see my quota" gets a current number
 * well inside the 60-minute routing window. The file axis keeps its own cheap
 * TTL, since there is nothing to economise on.
 *
 * ★This is still bounded by the 429 cooldown on the way through — see
 * scheduleStaleRevalidate and refreshQuotaCacheOnce.
 */
export const QUOTA_SWR_TTL_MS: Readonly<Record<QuotaProvider, number>> = {
    'antigravity-cli': 10 * 60 * 1000,
    'claude-cli': QUOTA_AXIS_TTL_MS['claude-cli'],
    'codex-cli': QUOTA_AXIS_TTL_MS['codex-cli'],
    'cursor-cli': 10 * 60 * 1000,
    'grok-cli': 10 * 60 * 1000,
    'kimi': 10 * 60 * 1000,
    'opencode': QUOTA_AXIS_TTL_MS['opencode'],
};

/** The providers a node reports. One entry per shipped fetcher. */
const REFRESHERS: ReadonlyArray<{ provider: QuotaProvider; fetch: () => Promise<ProviderQuota> }> = [
    { provider: 'antigravity-cli', fetch: () => fetchAntigravityQuota() },
    { provider: 'claude-cli', fetch: () => fetchClaudeQuota() },
    { provider: 'codex-cli', fetch: () => fetchCodexQuota() },
    { provider: 'cursor-cli', fetch: () => fetchCursorQuota() },
    { provider: 'grok-cli', fetch: () => fetchGrokQuota() },
    { provider: 'kimi', fetch: () => fetchKimiQuota() },
    { provider: 'opencode', fetch: () => fetchOpencodeUsage() },
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
 * LAST-GOOD CARRY-FORWARD (owner report 2026-08-10: kimi shows a bald
 * "token expired" and drops its numbers; follow-up 2026-08-13: two
 * consecutive transient failures still dropped them).
 *
 * Every provider whose credential the CLI refreshes on its own cadence
 * (kimi's ~15-min tokens are the recurring case) periodically fails a quota
 * read for a few seconds through no fault of the user — a TRANSIENT failure.
 * The fetcher correctly returns status!='ok' with empty windows, but blindly
 * caching that erased the last good reading, so the dashboard flipped from
 * "28% used" to a scary error until the next successful tick.
 *
 * When the fresh read is a transient failure AND we still hold a real reading
 * — either a fresh 'ok' snapshot, or an ALREADY-carried-forward entry from a
 * prior transient failure (metadata.lastGoodWindows, still holding a window)
 * — keep those windows and the ORIGINAL updatedAt, but surface the fresh
 * failure's status/error/kind so the reader can render "28% used ·
 * (refreshing)" rather than either a stale-looking OK or a numberless error.
 * Chaining off an already-carried entry (not just a fresh 'ok') is what makes
 * this survive an unbounded run of consecutive transient failures — with only
 * `prev.status === 'ok'` accepted, the SECOND consecutive failure had no
 * 'ok' predecessor to carry from and the numbers vanished anyway, which is
 * the bug this widening fixes. A NON-transient failure (missing credentials,
 * parse, unauthorized) still replaces wholesale — those are real problems the
 * old numbers would mask. A fresh 'ok' always replaces.
 */
export function carryForwardLastGoodWindows(
    prev: MeshNodeFactsProviderQuota | undefined,
    fresh: MeshNodeFactsProviderQuota,
): MeshNodeFactsProviderQuota {
    if (fresh.status === 'ok') return fresh;
    const kind = typeof fresh.metadata?.failureKind === 'string' ? fresh.metadata.failureKind : '';
    const transient = TRANSIENT_QUOTA_FAILURE_KINDS.has(kind as any);
    if (!transient) return fresh;
    const prevIsFreshOk = !!prev && prev.status === 'ok';
    const prevIsCarriedForward = !!prev && prev.metadata?.lastGoodWindows === true;
    const prevHasWindows = (prevIsFreshOk || prevIsCarriedForward)
        && (prev!.session !== null || prev!.weekly !== null);
    if (!prevHasWindows) return fresh;
    // Keep the last good numbers + their ORIGINAL age; carry the fresh
    // failure signal. prev.updatedAt is already the original observation
    // time even when prev is itself a carried-forward entry, since that
    // entry never overwrote it either — so this never needs to look further
    // back than one hop.
    return {
        ...fresh,
        session: prev!.session,
        weekly: prev!.weekly,
        // The provider-specific axes ride along with the windows they belong
        // to: monthly (cursor) and per-pool buckets (antigravity). Dropping
        // them here blanked the per-pool chips on every transient failure —
        // exactly the flicker this carry-forward exists to prevent.
        ...(prev!.monthly !== undefined ? { monthly: prev!.monthly } : {}),
        ...(prev!.buckets !== undefined ? { buckets: prev!.buckets } : {}),
        updatedAt: prev!.updatedAt,
        metadata: {
            ...fresh.metadata,
            // Mark the windows as a retained last-good reading so a reader can
            // label them (e.g. "· refreshing") instead of treating them as
            // freshly measured.
            lastGoodWindows: true,
        },
    };
}

/**
 * ★TWO DIFFERENT CLOCKS — do not conflate them (owner finding 2026-08-21).
 *
 * `updatedAt` is the age of the DATA. For an OAuth fetcher it happens to equal
 * the fetch time, but for a FILE-SOURCE fetcher it is the source file's own
 * capture stamp: claude.ts returns `snapshot.capturedAt` (fetchers/claude.ts,
 * both the fresh and the aged-out branch), and codex-rollout does the same with
 * the rollout entry's timestamp. So a provider whose file has not changed
 * reports the SAME `updatedAt` no matter how many times we successfully re-read
 * it.
 *
 * That is correct for the data — a reader must know the number is 3 hours old —
 * but it is WRONG as a refresh clock. Driving TTL/SWR off `updatedAt` would ask
 * "has the file changed?" and, on every "no", re-read the file again
 * immediately: a hot loop on the cheap axis, and on the network axis a
 * permanently-due provider hammered by every SWR read. This is exactly why the
 * owner's claude reading looked 22 hours untouched while the backfill was in
 * fact fetching every 15 minutes on schedule: the fetches happened, the
 * capturedAt simply never moved.
 *
 * `metadata.fetchedAt` is therefore stamped here — the wall-clock time THIS
 * process last completed a refresh attempt for the provider, success or
 * failure. Every scheduling decision (axis TTL, SWR, force-refresh reporting)
 * reads it via `lastAttemptAt()`; every freshness decision the USER or the
 * ROUTING GATE sees still reads `updatedAt`. ★Do not "simplify" one into the
 * other.
 */
function stampFetchedAt(
    quota: MeshNodeFactsProviderQuota,
    now: number,
): MeshNodeFactsProviderQuota {
    return { ...quota, metadata: { ...quota.metadata, fetchedAt: now } };
}

/**
 * When this process last ATTEMPTED a refresh for the provider, per the contract
 * above. Falls back to `updatedAt` for an entry written before `fetchedAt`
 * existed (a hydrated on-disk cache from an older build) — that is the old
 * behaviour, so an upgrade degrades to what it did yesterday rather than
 * treating every legacy entry as never-attempted and re-probing all six
 * providers at once on the first tick after upgrade.
 */
function lastAttemptAt(entry: MeshNodeFactsProviderQuota | undefined): number | undefined {
    if (!entry) return undefined;
    const fetchedAt = Number(entry.metadata?.fetchedAt);
    if (Number.isFinite(fetchedAt) && fetchedAt > 0) return fetchedAt;
    const updatedAt = Number(entry.updatedAt);
    return Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : undefined;
}

/**
 * True when the provider's own axis TTL has elapsed since the last refresh
 * ATTEMPT — the cadenced-tick gate. A network-axis provider's TTL is Infinity,
 * so this is always false for it and the timer never probes it; its refreshes
 * come from events, the staleness backfill, SWR reads and force refresh (see
 * QUOTA_AXIS).
 */
export function isDueByAxisTtl(
    provider: QuotaProvider,
    now: number = Date.now(),
    ttlTable: Readonly<Record<QuotaProvider, number>> = QUOTA_AXIS_TTL_MS,
): boolean {
    const ttl = ttlTable[provider];
    if (!Number.isFinite(ttl)) return false;
    const attemptedAt = lastAttemptAt(cache.get(provider));
    if (attemptedAt === undefined) return true; // never attempted in a form we can date
    return now - attemptedAt >= ttl;
}

/**
 * Read-triggered counterpart of isDueByAxisTtl — same clock, different table.
 * Named separately so a caller has to state which question it is asking; the
 * two tables deliberately disagree on the network axis (see QUOTA_SWR_TTL_MS).
 */
export function isDueBySwrTtl(provider: QuotaProvider, now: number = Date.now()): boolean {
    return isDueByAxisTtl(provider, now, QUOTA_SWR_TTL_MS);
}

/**
 * Read the cached quota snapshots. Synchronous, side-effect free, and never
 * triggers a fetch — see the module header. Returns undefined (not an empty
 * object) when nothing has been cached, so the bundle omits the field entirely
 * rather than shipping a misleading empty map.
 *
 * ★This signature is load-bearing and must not grow a fetch affordance: the
 * callers are the 4-second mesh reconcile tick (mesh-quota-routing.ts) and
 * EVERY `git_status` (mesh/node-facts.ts). Read-triggered revalidation lives in
 * the separate `readQuotaCacheWithRevalidate()` below, which only the low-rate
 * human-facing surfaces call.
 */
export function readQuotaCache(): Record<string, MeshNodeFactsProviderQuota> | undefined {
    if (cache.size === 0) return undefined;
    return Object.fromEntries(cache);
}

/**
 * The enable gate captured at daemon boot, so refresh paths that are triggered
 * from OUTSIDE the loop — a read-driven SWR revalidate, an explicit force
 * refresh — probe exactly the providers the periodic loop would.
 *
 * Without this they would have to either take a ProviderLoader parameter
 * (which every caller, including a `git_status`-adjacent read surface, would
 * then have to thread) or run ungated, which would re-probe a provider the user
 * disabled — the phantom-failure noise the enable gate exists to remove. The
 * loop is the natural owner because it already receives the loader, and the
 * predicate is a live closure over it, so enabling a provider later still takes
 * effect without re-registering.
 *
 * Undefined until setupQuotaRefreshLoop runs (or in tests that never start a
 * loop): callers treat that as "no gate", which is the pre-existing behaviour of
 * refreshQuotaCacheOnce with no isEnabled argument.
 */
let ambientIsEnabled: QuotaProviderEnabled | undefined;

/** Test seam: drop the ambient enable gate registered by the loop. */
export function __resetQuotaAmbientEnableGateForTests(): void {
    ambientIsEnabled = undefined;
    quotaCacheChangedListener = undefined; // same ambient, same leak risk
}

/**
 * The refresh loop's reschedule hook. Every refresh path — periodic wake, boot,
 * event-driven, scheduled retry, SWR revalidate, force refresh — funnels
 * through refreshQuotaCacheOnce, so notifying from there is how the loop's
 * timer chain learns that the cache changed UNDER it and recomputes its next
 * wake (see startQuotaRefreshLoop). Without this a mid-chain refresh would
 * leave the chain sleeping on stale expiry times — e.g. an event-driven
 * refresh at turn end would not restart the file axis's TTL cadence while the
 * machine is active.
 *
 * A single slot, not a set: exactly one loop runs per daemon. A listener that
 * throws must never break the refresh that triggered it.
 */
let quotaCacheChangedListener: (() => void) | undefined;

function notifyQuotaCacheChanged(): void {
    const listener = quotaCacheChangedListener;
    if (!listener) return;
    try {
        listener();
    } catch (e: any) {
        LOG.warn('Quota', `Quota cache-change listener failed: ${e?.message || e}`);
    }
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
    revalidateInFlight.clear();
    // Also drop the loop's reschedule hook: a leaked listener from a loop that
    // was never stopped would otherwise let that loop keep re-arming itself
    // inside LATER tests (observed 2026-08-23: one mid-test assertion failure
    // before handle.stop() cascaded into phantom fetches in the next file).
    quotaCacheChangedListener = undefined;
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

/**
 * A cached 429. Distinct from other transient kinds: restarting or a turn
 * completing cannot lift the provider's method budget, so boot and
 * event-driven refresh must not re-probe it. Recovery is the scheduled
 * retry / the periodic tick, which still honour retryAtMs via
 * isRateLimitedCooldownActive.
 */
function isRateLimitedSnapshot(entry: MeshNodeFactsProviderQuota | undefined): boolean {
    return !!entry && entry.status !== 'ok' && entry.metadata?.failureKind === 'rate-limited';
}

/** True while a rate-limited snapshot's Retry-After / default delay has not elapsed. */
function isRateLimitedCooldownActive(
    entry: MeshNodeFactsProviderQuota | undefined,
    now: number = Date.now(),
): boolean {
    if (!isRateLimitedSnapshot(entry)) return false;
    const retryAtMs = entry!.metadata?.retryAtMs;
    return typeof retryAtMs === 'number' && retryAtMs > now;
}

/** Test seam: allow a fresh hydration in the same process. */
export function __resetQuotaHydrationForTests(): void {
    hydrated = false;
}

export interface RefreshQuotaCacheOptions {
    /**
     * Restrict which of `fetchers` are actually PROBED, without narrowing which
     * are considered for the disabled-provider prune below.
     *
     * The two lists have to be separable because they answer different
     * questions. The periodic loop passes every shipped fetcher (so a provider
     * disabled since the last tick still gets its stale entry dropped) but
     * probes only the ones whose axis TTL is due or which the safety net
     * selected. Passing a pre-filtered list instead would silently skip the
     * prune, leaving a disabled provider's "unavailable" reading on screen
     * forever. Omit to probe everything passed in — the original behaviour.
     */
    probeOnly?: ReadonlySet<QuotaProvider>;
}

/**
 * Refresh every provider once and store the results.
 *
 * ★THE SINGLE WRITE PATH. Every refresh — periodic tick, boot, event-driven,
 * scheduled retry, SWR revalidate, explicit force refresh — funnels through
 * here, and that is load-bearing rather than tidy: the 429 cooldown filter, the
 * last-good carry-forward, the enable-gate prune, the retry bookkeeping and the
 * disk persist all live in this function. A refresh path added AROUND it
 * silently opts out of all five. Do not add one.
 *
 * Fetchers never throw by contract (each failure path resolves to a snapshot
 * whose `status` is 'error'/'unavailable'), but this still guards each one: a
 * fetcher that breaks that contract must not take down the tick and starve the
 * other providers' snapshots.
 */
export async function refreshQuotaCacheOnce(
    fetchers: ReadonlyArray<{ provider: QuotaProvider; fetch: () => Promise<ProviderQuota> }> = REFRESHERS,
    isEnabled?: QuotaProviderEnabled,
    options: RefreshQuotaCacheOptions = {},
): Promise<void> {
    // A disabled provider is not probed at all — no spawn, no request — and any
    // snapshot it left behind (live or hydrated) is dropped, so a stale
    // "unavailable" reading cannot outlive the disable and keep masquerading as
    // a current problem. The prune runs even when the active list ends up
    // empty: the persist below then rewrites the file without those entries.
    const selected = options.probeOnly
        ? fetchers.filter(({ provider }) => options.probeOnly!.has(provider))
        : fetchers;
    const enabled = isEnabled ? selected.filter(({ provider }) => isEnabled(provider)) : selected;
    if (isEnabled) {
        for (const { provider } of fetchers) {
            if (!isEnabled(provider)) {
                cache.delete(provider);
                hydratedOnly.delete(provider);
                cancelFailureRetry(provider);
            }
        }
    }
    // A 429 whose retry time has not elapsed is not probed again — not by the
    // periodic tick, not by an event-driven refresh, not by a stacked retry.
    // The cached snapshot (last-good windows included) stays on screen, marked
    // refreshing. Re-hitting the same method is what kept Antigravity's quota
    // endpoint in RESOURCE_EXHAUSTED while the CLI itself throttled to ~7 min.
    const active = enabled.filter(({ provider }) => !isRateLimitedCooldownActive(cache.get(provider)));
    await Promise.all(
        active.map(async ({ provider, fetch }) => {
            try {
                const fresh = toWireQuota(await fetch());
                // stampFetchedAt runs AFTER the carry-forward so the attempt
                // clock always describes THIS attempt: carry-forward
                // deliberately keeps the previous entry's `updatedAt` (the data
                // is genuinely the older reading), and inheriting its
                // `fetchedAt` too would make a provider that keeps failing
                // transiently look permanently un-probed and re-probe forever.
                cache.set(
                    provider,
                    stampFetchedAt(carryForwardLastGoodWindows(cache.get(provider), fresh), Date.now()),
                );
                hydratedOnly.delete(provider); // measured in this process now
            } catch (e: any) {
                // Contract violation, not an ordinary quota failure — record it
                // as one so the provider still reports a definite "could not
                // read" instead of silently vanishing from the bundle.
                const now = Date.now();
                cache.set(provider, {
                    provider,
                    status: 'error',
                    session: null,
                    weekly: null,
                    updatedAt: now,
                    error: `Quota fetch threw: ${e?.message || e}`,
                    metadata: { failureKind: 'unknown', fetchedAt: now },
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
    // Tell the refresh loop's timer chain the expiry landscape just changed so
    // it can recompute its next wake (see quotaCacheChangedListener).
    notifyQuotaCacheChanged();
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
 * Age past which a cached snapshot is refreshed even on an IDLE machine.
 *
 * Deliberately equal to the routing gate's own staleness horizon
 * (DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs, 60 min) rather than to the
 * refresh interval: this constant exists to keep a snapshot INSIDE the window
 * where the quota gate will still act on it, so the number it protects is the
 * gate's, not the loop's. Duplicated as a literal rather than imported from
 * repo-mesh-types to keep this module free of mesh imports (quota/ is consumed
 * by daemons that never build a mesh); quota-routing-staleness-agreement.test.ts
 * asserts the two stay equal, so a change to either is caught.
 *
 * ★30 min → 60 min (owner decision 2026-08-21). Widening the routing trust
 * window halves the backfill floor — the single biggest remaining source of
 * unsolicited third-party calls on an idle machine, since the backfill is by
 * design the one refresh that fires with no demand behind it. The cost of a
 * wider fallback window is bounded by per-window resetsAt when present, and
 * force refresh gives anyone who needs the number NOW a way to get it without
 * shortening the window for everyone. ★Widening this WITHOUT force refresh
 * would be the bad trade; do not undo one and keep the other.
 */
export const QUOTA_ROUTABLE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * True when an enabled provider's snapshot has aged past the point where
 * ROUTING will still act on it — the idle-gate exception that keeps the quota
 * gate armed.
 *
 * ★WHY THIS EXISTS (the failure it fixes, observed on the owner's mesh
 * 2026-08-15). Three rules composed into a self-reinforcing loop that silently
 * disabled quota routing:
 *
 *   1. the periodic tick is skipped while the machine is idle
 *      (hasRecentCliActivity) — quota "cannot have moved";
 *   2. the event-driven refresh (setupQuotaEventRefresh) re-reads ONLY the
 *      provider that just finished a turn; and
 *   3. the routing gate fails OPEN on any snapshot older than staleAfterMs.
 *
 * So the provider currently doing the work stayed fresh, while every ALTERNATIVE
 * provider — precisely the ones the gate is supposed to divert work TO — aged
 * out and became ungateable. With `weeklyMinRemainingPercent: 80` set to steer
 * work off claude-cli (68% left) onto codex-cli (91% left), BOTH readings were
 * ~3h old, so both failed open, the threshold applied to nobody, and selection
 * fell back to slot order — which put claude-cli first. The setting the owner
 * configured did nothing, and the busier claude-cli got, the more reliably it
 * kept winning: the loop fed itself.
 *
 * Rule 1's premise ("idle ⇒ the number cannot have moved") is sound about the
 * VALUE but not about its ROUTABILITY: an unchanged number still ages out of
 * the gate's trust window, and routing then behaves as if it had never been
 * measured. This predicate closes exactly that gap and nothing more — one fetch
 * per provider per staleness horizon on an otherwise idle machine, which is
 * strictly cheaper than the pre-idle-gate cadence and only ever fires for
 * providers the machine is actually enabled to run.
 */
export function isSnapshotStaleForRouting(provider: QuotaProvider, now: number = Date.now()): boolean {
    const entry = cache.get(provider);
    if (!entry) return false; // no entry at all is the existing backfill case
    const updatedAt = Number(entry.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return true;
    return now - updatedAt >= QUOTA_ROUTABLE_MAX_AGE_MS;
}

/**
 * Should the BACKFILL spend a fetch on this provider right now?
 *
 * ★WHY THIS IS NOT JUST isSnapshotStaleForRouting (the defect, observed on the
 * owner's mesh 2026-08-22 and reproduced in
 * quota-carry-forward-backfill-storm.test.ts).
 *
 * The two questions look identical and are not:
 *
 *   - isSnapshotStaleForRouting asks "is the DATA too old for the routing gate
 *     to act on?" and must read `updatedAt`, the data clock. That is the whole
 *     point of the 2026-08-15 fix and it stays exactly as it was.
 *   - This asks "would a fetch IMPROVE anything?", and the honest input for
 *     that is `fetchedAt`, the attempt clock — because a fetch we just made and
 *     will make again in 15 minutes cannot make the data any newer than the
 *     provider is willing to give us.
 *
 * Conflating them produced a permanent fetch storm on exactly the three
 * providers the axis split exists to protect. `carryForwardLastGoodWindows`
 * DELIBERATELY preserves the previous entry's `updatedAt` when a refresh fails
 * transiently (see that function — the retained windows are genuinely the older
 * reading and must not claim to be fresh). So a provider whose credential keeps
 * expiring — kimi's ~15-minute OAuth tokens are the standing case — holds an
 * `updatedAt` that is FROZEN for as long as the failure lasts. It is therefore
 * stale-for-routing on every single tick, forever, and `backfillDue` fired every
 * tick forever: 96 fetches/24h against a third party's endpoint on an IDLE
 * machine, versus the 24 the design intends. The network axis had its cadenced
 * TTL set to Infinity precisely so a timer would never do this, and the backfill
 * walked straight around it — the more broken the provider, the harder we hit
 * it.
 *
 * Reading the attempt clock fixes it without weakening the safety net at all: a
 * provider genuinely going un-probed still has an ageing `fetchedAt` and still
 * backfills on schedule (that is the 2026-08-15 guarantee, and the tests for it
 * are unchanged). Only the case where we ARE probing and the probe keeps failing
 * is throttled back to the intended one-per-horizon — which is the case where
 * extra fetches were buying nothing anyway.
 *
 * A legacy entry with no `fetchedAt` falls back to `updatedAt` via
 * lastAttemptAt(), i.e. to yesterday's behaviour, so an upgrade never silently
 * stops backfilling.
 */
function isBackfillDueByAttemptClock(provider: QuotaProvider, now: number = Date.now()): boolean {
    const entry = cache.get(provider);
    if (!entry) return false; // no entry at all is handled by the caller's own check
    const attemptedAt = lastAttemptAt(entry);
    if (attemptedAt === undefined) return true; // never attempted in a form we can date
    return now - attemptedAt >= QUOTA_ROUTABLE_MAX_AGE_MS;
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
    if (options.isEnabled) ambientIsEnabled = options.isEnabled;
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
    quotaCacheChangedListener = rescheduleFromOutside;

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
                quotaCacheChangedListener = undefined;
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
 * Events that warrant an immediate re-read of the provider's quota: a turn
 * just completed (`agent:generating_completed`), or the session ended some
 * other way (`agent:stopped` — manual stop, PTY/ACP process exit, or a
 * provider-reported error, all of which route through this single status per
 * the CLI/ACP FSMs in status-transition.ts / acp-provider-instance.ts).
 *
 * `agent:stopped` was added 2026-08-17 after an incident where a session's
 * ONLY terminal event was `agent:stopped` (ready → generating_started ×2 →
 * stopped, `generating_completed` never fired) — the event-driven path never
 * armed, so quota fell back to the 15-minute cadence and a routing decision a
 * few minutes later used a 3-day-stale cached value. A session ending
 * abnormally is exactly when a re-read matters most: it is the last chance to
 * capture what the just-finished (or just-aborted) turn spent before the next
 * cadenced tick, and precisely the case the old completion-only filter
 * skipped.
 */
const QUOTA_REFRESH_EVENTS = new Set(['agent:generating_completed', 'agent:stopped']);

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
        if (typeof event.event !== 'string' || !QUOTA_REFRESH_EVENTS.has(event.event)) return;
        const refresher = typeof event.providerType === 'string'
            ? REFRESHERS.find(({ provider }) => provider === event.providerType)
            : undefined;
        if (!refresher) return; // not a quota-reporting provider
        if (isEnabled && !isEnabled(refresher.provider)) return;
        // A turn ending is the worst moment to re-hit a rate-limited quota
        // method: the owning CLI just ran its own doRefreshQuota. Leave
        // recovery to the scheduled retry / the periodic tick.
        if (isRateLimitedSnapshot(cache.get(refresher.provider))) return;
        const at = now();
        if (at - (lastRefreshAt.get(refresher.provider) ?? -Infinity) < debounceMs) return;
        lastRefreshAt.set(refresher.provider, at);
        void refreshQuotaCacheOnce([refresher], isEnabled)
            .catch((e: any) => LOG.warn('Quota', `Event-driven quota refresh failed: ${e?.message || e}`));
    });
    LOG.info('Quota', `Event-driven quota refresh armed (${[...QUOTA_REFRESH_EVENTS].join(', ')}, ${debounceMs}ms debounce)`);
    return {
        stop() {
            stopped = true;
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
const revalidateInFlight = new Set<string>();

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
