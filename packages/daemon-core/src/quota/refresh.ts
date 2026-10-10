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
import { fetchAntigravityQuota, readAntigravityKeychainMtimeMs } from './fetchers/antigravity.js';
import { fetchClaudeQuota } from './fetchers/claude.js';
import { fetchCodexQuota } from './fetchers/codex.js';
import { fetchCursorQuota } from './fetchers/cursor.js';
import { fetchGrokQuota, readGrokCredentialMtimeMs } from './fetchers/grok.js';
import { fetchKimiQuota, readKimiCredentialMtimeMs } from './fetchers/kimi.js';
import { fetchOpencodeUsage } from './fetchers/opencode.js';
import { loadQuotaCache, mergeLastGoodForPersist, saveQuotaCache } from './persist.js';
import { revalidateInFlight } from './refresh-triggers.js';

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
export const REFRESHERS: ReadonlyArray<{ provider: QuotaProvider; fetch: () => Promise<ProviderQuota> }> = [
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
export const cache = new Map<string, MeshNodeFactsProviderQuota>();

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
    // ★A REAL READING IS NOT ONLY session/weekly (owner report 2026-09-13:
    // antigravity showed a bald "token expired" with no numbers at all).
    // Antigravity's measurement lives on the per-pool `buckets` axis; its
    // session/weekly are a worst-bucket COLLAPSE of it, and a plan whose pools
    // do not map onto the 5h/weekly axes leaves both null while `buckets`
    // still holds a perfectly good reading. Judging "do we hold anything
    // worth keeping?" on session/weekly alone therefore declared that
    // reading absent and let the numberless error through — the chips the
    // user actually reads went blank. Buckets count as a real reading here.
    const prevHasBuckets = !!prev && Array.isArray(prev.buckets) && prev.buckets.length > 0;
    const prevHasWindows = (prevIsFreshOk || prevIsCarriedForward)
        && (prev!.session !== null || prev!.weekly !== null || prevHasBuckets);
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
export function lastAttemptAt(entry: MeshNodeFactsProviderQuota | undefined): number | undefined {
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
export let ambientIsEnabled: QuotaProviderEnabled | undefined;

/** Publish a refresh loop's enable gate for the out-of-band refresh paths. */
export function setAmbientQuotaEnableGate(isEnabled: QuotaProviderEnabled): void {
    ambientIsEnabled = isEnabled;
}

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
export let quotaCacheChangedListener: (() => void) | undefined;

/** Install (or clear) the refresh loop's reschedule hook; returns the previous hook. */
export function setQuotaCacheChangedListener(listener: (() => void) | undefined): (() => void) | undefined {
    const previous = quotaCacheChangedListener;
    quotaCacheChangedListener = listener;
    return previous;
}

export function notifyQuotaCacheChanged(): void {
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
export function hasFreshlyMeasuredQuota(): boolean {
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
export function isRateLimitedSnapshot(entry: MeshNodeFactsProviderQuota | undefined): boolean {
    return !!entry && entry.status !== 'ok' && entry.metadata?.failureKind === 'rate-limited';
}

/** True while a rate-limited snapshot's Retry-After / default delay has not elapsed. */
export function isRateLimitedCooldownActive(
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
    // ★Merged against what is already on disk, never written blind. An entry
    // that carries no numbers must not erase a stored one that does — that is
    // what made a transient failure survive a restart as a permanent numberless
    // error (see mergeLastGoodForPersist). The in-memory carry-forward above
    // covers the running process; this covers the file the next process reads.
    const snapshot = readQuotaCache();
    if (snapshot) saveQuotaCache(mergeLastGoodForPersist(snapshot, loadQuotaCache()));
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
 * — the entry keeps its last advertised retryAtMs (now past) and gains
 * `metadata.retryExhausted`, and `isFailureRetryDue` reports false, so the
 * loop's backfill gate stops firing on it too. Recovery from
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
    /**
     * True from the moment the retry timer fires until its refresh settles. The
     * timer handler nulls `timer` before probing, so without this flag the
     * loop's backfill gate (retryAtMs just passed, no timer) saw the retry as
     * "due" and probed in parallel with it.
     */
    retryInFlight?: boolean;
    /**
     * Credential-store mtime observed when this failure episode was last
     * recorded, for the renewal detector below. Undefined on every provider
     * but antigravity-cli, and on any machine where the stamp is unreadable.
     */
    credentialMtimeMs?: number;
}

export const failureRetries = new Map<string, FailureRetryState>();

function cancelFailureRetry(provider: QuotaProvider): void {
    const state = failureRetries.get(provider);
    if (state?.timer) clearTimeout(state.timer);
    failureRetries.delete(provider);
}

/**
 * ★RE-LOGIN RECOVERY — reset the retry budget when the CREDENTIAL ITSELF was
 * renewed (owner report: agy quota stayed `expired-token` long after signing
 * back in).
 *
 * The failure this closes, in order: the daemon reads the token in the seconds
 * BEFORE a re-login completes and records `expired-token`; `failures` only ever
 * resets on a SUCCESS, so the bounded budget (QUOTA_FAILURE_MAX_RETRIES) is
 * spent on probes that were all doomed to fail against the old token; once
 * spent, `isFailureRetryDue` reports false and the short-fuse retry stops
 * scheduling. The user then signs in — and nothing re-probes until the hourly
 * backfill, so a reading that is already valid renders as a stale error for up
 * to an hour. The budget is doing its job (it must not hammer a genuinely dead
 * token); it simply has no way to hear that the token is no longer the same
 * token.
 *
 * The credential store's own modification time is that missing signal, and a
 * cheap one: each CLI rewrites its credential when it refreshes or re-obtains
 * the token, so a stamp later than the one we saw at the last failure means a
 * NEW credential exists. Reset the budget, and the very next wake finds the
 * retry due again.
 *
 * ★THREE GUARDS, all narrow on purpose — this is a SHARED retry path and a
 * leak into another provider or kind is a regression:
 *   1. provider — only providers with a CREDENTIAL_MTIME_SOURCES entry below.
 *      Everything else has no source and short-circuits to "no evidence".
 *   2. failureKind — TOKEN-EXPIRY kinds only (`expired-token` / `unauthorized`).
 *      A `network`, `parse` or `rate-limited` failure is not a credential
 *      problem, so a new credential is not evidence it would now succeed.
 *   3. platform — per source. The antigravity arm is darwin-only because it
 *      reads a macOS keychain; the file arms are platform-agnostic because a
 *      `stat` is.
 *
 * ★AND IT IS A NO-OP WHEN THE TOKEN DID NOT CHANGE. An unchanged (or
 * unreadable) stamp returns false and the existing backoff stands untouched —
 * so a provider whose token is genuinely dead is probed no more often than it
 * is today. That asymmetry is the whole safety argument: the only thing that
 * can spend a fresh budget is the user actually re-authenticating.
 */
const CREDENTIAL_RENEWAL_FAILURE_KINDS: ReadonlySet<string> = new Set([
    'expired-token',
    'unauthorized',
]);

/**
 * Per-provider "has the credential been renewed?" sources. A provider ABSENT
 * from this table can never trigger the reset — that absence is the gate, so
 * adding an entry is the whole cost of extending this, and forgetting to add
 * one is a silent no-op rather than a misfire.
 *
 * ★Two source shapes, deliberately not unified further:
 *   - antigravity-cli keeps its token in the macOS keychain, so its stamp is
 *     the item's `mdat`, read via `security` WITHOUT `-w` (attributes only).
 *     darwin-gated inside the fetcher; win32/linux resolve null.
 *   - kimi / grok keep theirs in a plain file, so a `stat` on the path each
 *     fetcher already resolves is the entire implementation.
 * Both shapes return unix ms or null, and NEITHER reads the token value.
 *
 * ★codex is deliberately absent: it is a file-axis rollout reader with no OAuth
 * token of its own, so the budget-exhaustion stall this detector exists to
 * rescue cannot occur there.
 */
const CREDENTIAL_MTIME_SOURCES: Partial<
    Record<QuotaProvider, (() => Promise<number | null>)>
> = {
    'antigravity-cli': () => (
        // The keychain probe is macOS-only; skip the spawn entirely elsewhere.
        process.platform === 'darwin' ? readAntigravityKeychainMtimeMs() : Promise.resolve(null)
    ),
    kimi: () => readKimiCredentialMtimeMs(),
    'grok-cli': () => readGrokCredentialMtimeMs(),
};

/**
 * Reads the credential stamp for a provider, or null when this provider has no
 * source. Indirected through a mutable binding so tests can drive the detector
 * without a real keychain or credential file; production never reassigns it.
 */
const defaultCredentialMtimeReader = async (provider: QuotaProvider): Promise<number | null> => {
    const source = CREDENTIAL_MTIME_SOURCES[provider];
    return source ? source() : null;
};

let credentialMtimeReader: (provider: QuotaProvider) => Promise<number | null> =
    defaultCredentialMtimeReader;

/** Test seam for the credential-renewal detector; undefined restores production. */
export function __setQuotaCredentialMtimeReaderForTests(
    reader: ((provider: QuotaProvider) => Promise<number | null>) | undefined,
): void {
    credentialMtimeReader = reader ?? defaultCredentialMtimeReader;
}

/**
 * Does this provider's cached failure qualify for the renewal detector at all?
 *
 * Provider membership is the table above — no provider name is hardcoded here,
 * so extending the detector is one entry and never an edit to this predicate.
 * The platform gate lives inside each source (keychain: darwin-only; file
 * stat: platform-agnostic).
 */
function isCredentialRenewalCandidate(provider: QuotaProvider): boolean {
    if (!CREDENTIAL_MTIME_SOURCES[provider]) return false;
    const entry = cache.get(provider);
    if (!entry || entry.status === 'ok') return false;
    const kind = entry.metadata?.failureKind;
    return typeof kind === 'string' && CREDENTIAL_RENEWAL_FAILURE_KINDS.has(kind);
}

/**
 * If the credential behind a token-expiry failure has been renewed since that
 * failure was recorded, clear the consumed retry budget so the provider becomes
 * immediately re-probeable. Resolves true only when it actually reset something.
 *
 * Never throws: a probe that fails for any reason resolves false and leaves the
 * backoff exactly as it found it.
 */
export async function resetFailureBudgetOnCredentialRenewal(
    provider: QuotaProvider,
): Promise<boolean> {
    if (!isCredentialRenewalCandidate(provider)) return false;
    const state = failureRetries.get(provider);
    // Nothing has failed yet, or the budget is untouched — the ordinary retry
    // schedule is already going to re-probe, so there is nothing to rescue.
    if (!state || state.failures === 0) return false;
    let mtimeMs: number | null = null;
    try {
        mtimeMs = await credentialMtimeReader(provider);
    } catch {
        return false; // fail safe: keep the existing backoff
    }
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return false;
    const previous = state.credentialMtimeMs;
    if (previous === undefined) {
        // First stamp of this failure episode — record it as the baseline so a
        // LATER renewal is detectable. Resetting here would be guessing.
        state.credentialMtimeMs = mtimeMs;
        return false;
    }
    if (mtimeMs <= previous) return false; // ★unchanged token → no-op
    // A new credential exists. Drop the spent budget and let the ordinary
    // scheduling paths (isFailureRetryDue → the loop's backfill gate) re-probe.
    if (state.timer) clearTimeout(state.timer);
    failureRetries.set(provider, { failures: 0, timer: null, credentialMtimeMs: mtimeMs });
    LOG.info('Quota', `${provider}: credential renewed since the last failure — retry budget reset`);
    return true;
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
    // An armed retry timer owns this episode's next probe — firing the loop's
    // backfill gate as well would double-probe the same retry.
    if (hasArmedFailureRetryTimer(provider)) return false;
    return (failureRetries.get(provider)?.failures ?? 0) <= QUOTA_FAILURE_MAX_RETRIES;
}

/**
 * True while updateFailureRetry has a backoff timer pending for this provider.
 * That timer is the single owner of the next retry: the refresh loop's chain
 * wake and backfill gate must stand down (they remain the safety net for the
 * no-timer states — hydrated-from-disk entries, a spent budget, a lost timer).
 */
export function hasArmedFailureRetryTimer(provider: QuotaProvider): boolean {
    const state = failureRetries.get(provider);
    return !!state && (!!state.timer || state.retryInFlight === true);
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
export function isBackfillDueByAttemptClock(provider: QuotaProvider, now: number = Date.now()): boolean {
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
    // Carry the credential stamp across the episode: it is the baseline the
    // renewal detector compares against, and losing it on each new failure
    // would restart the "first stamp" handshake forever.
    const credentialMtimeMs = previous?.credentialMtimeMs;
    if (failures > QUOTA_FAILURE_MAX_RETRIES) {
        failureRetries.set(provider, { failures, timer: null, credentialMtimeMs });
        // Tell every reader the daemon has stopped retrying: retained numbers
        // must stop reading "refreshing" (assessQuotaFreshness in mesh-shared).
        if (entry && entry.metadata) {
            cache.set(provider, { ...entry, metadata: { ...entry.metadata, retryExhausted: true } });
        }
        // Budget just went from spendable to spent — this is exactly the state
        // a later re-login has to be able to rescue, so make sure a baseline
        // stamp exists to compare future reads against.
        void resetFailureBudgetOnCredentialRenewal(provider)
            .catch(() => { /* advisory only — never disturb the tick */ });
        LOG.info('Quota', `${provider}: transient failure persists after ${QUOTA_FAILURE_MAX_RETRIES} retries — back to the normal refresh cadence`);
        return;
    }
    const backoffMs = Math.min(
        QUOTA_TRANSIENT_RETRY_DELAY_MS * 2 ** (failures - 1),
        QUOTA_REFRESH_INTERVAL_MS,
    );
    // A server-dictated retry time (HTTP Retry-After) wins when it is later.
    const delayMs = Math.max(retryAtMs - Date.now(), backoffMs, 0);
    // ★Advertise the REAL next-retry time on the entry. quotaFailure stamps
    // retryAtMs = fetchTime + 120s on every fetch; without this re-stamp the
    // 2→4→8→15m backoff lived only in the timer while isFailureRetryDue and the
    // loop's chain wake kept reading the flat 120s stamp, re-probing every 2
    // minutes and spending the 4-retry budget in ~6 min instead of ~29.
    if (entry && entry.metadata) {
        cache.set(provider, { ...entry, metadata: { ...entry.metadata, retryAtMs: Date.now() + delayMs } });
    }
    const timer = setTimeout(() => {
        const state = failureRetries.get(provider);
        if (state) state.timer = null;
        // The enable gate is re-evaluated at fire time: a provider disabled
        // since the failure was recorded is never re-probed.
        if (isEnabled && !isEnabled(provider)) return;
        if (state) state.retryInFlight = true;
        void refreshQuotaCacheOnce([{ provider, fetch }], isEnabled)
            .catch((e: any) => LOG.warn('Quota', `${provider}: scheduled retry failed: ${e?.message || e}`))
            // updateFailureRetry normally replaced `state` already; this only
            // matters when the refresh threw before it could.
            .finally(() => { if (state) state.retryInFlight = false; });
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    failureRetries.set(provider, { failures, timer, credentialMtimeMs });
    LOG.info('Quota', `${provider}: transient failure — retry scheduled in ${Math.round(delayMs / 1000)}s (attempt ${failures}/${QUOTA_FAILURE_MAX_RETRIES})`);
}
