/**
 * CONFIRMED quota exhaustion and how it ends.
 *
 * Two kinds of evidence say "this provider cannot run work right now", and both
 * are different from an unknown reading (no snapshot, expired token, network
 * blip), which keeps failing OPEN:
 *
 *   1. A MEASURED window with nothing left (remaining < QUOTA_HARD_EXHAUSTED_PERCENT).
 *   2. The CLI ITSELF said "usage limit reached" (cliRateLimit evidence, stamped
 *      onto the quota cache entry by recordCliRateLimitEvidence).
 *
 * The rule shared by both: ELAPSED TIME ALONE NEVER ENDS THE HOLD. A window's
 * `resetsAt` passing only says the old window is over; it does not prove the
 * account has quota again (the reset can be late, the plan can have changed, the
 * CLI may still be rate limited). The hold ends only when a measurement taken
 * AFTER the reset shows the provider usable. Until then the gate reports
 * PROVIDER_QUOTA_RESET_UNCONFIRMED — a block the OWNER can waive for one task
 * ("Run anyway"), which is the probe that produces the new measurement. Without
 * that escape, file-source providers (claude statusline) would deadlock: no
 * session can start, so no new reading can arrive.
 *
 * An unknown lookup (expired token, parse error) neither creates this hold nor
 * erases an existing one: carry-forward keeps the original updatedAt, so the
 * measurement still predates the reset.
 *
 * Pure and synchronous — safe for the 4s reconcile tick and direct dispatch.
 */
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';

/** Below this remaining percent a window is treated as fully used. */
export const QUOTA_HARD_EXHAUSTED_PERCENT = 0.5;
/** With no reset time known, a CLI rate-limit hold needs a newer reading with at least this much headroom everywhere. */
export const CLI_RATE_LIMIT_CLEAR_MIN_PERCENT = 5;
/** A CLI report with no readable reset time is a hard block for this long, then only reset-unconfirmed (owner-waivable): a misread banner can never hold a provider indefinitely. */
export const CLI_RATE_LIMIT_UNKNOWN_RESET_HARD_MS = 6 * 60 * 60_000;

/** Has the stated (or, lacking one, the assumed) reset passed on THIS clock? Decides hard block vs reset-unconfirmed. */
export function cliRateLimitResetPassed(evidence: CliRateLimitEvidence, now: number): boolean {
    return now >= (evidence.resetsAt ?? evidence.observedAt + CLI_RATE_LIMIT_UNKNOWN_RESET_HARD_MS);
}

export interface CliRateLimitEvidence {
    /** Unix ms (this daemon's clock) the CLI reported its usage limit. */
    observedAt: number;
    /** Unix ms the CLI said the limit resets, when it said so. */
    resetsAt?: number;
    /**
     * The quota pool (quota-pools.ts) of the model that hit the limit. Set only for a provider whose account
     * is split into pools; the hold then binds that pool alone (stored under metadata.cliRateLimitPools).
     */
    pool?: string;
    /** Exact live Claude screen: retained across unknown refreshes and elapsed resets. */
    runtime?: { sessionId: string; screenHash: string; resetText: string };
}

type HoldWindow = { usedPercent?: number | null; resetsAt?: number | null } | null | undefined;

function remaining(window: HoldWindow): number | undefined {
    if (!window) return undefined;
    const used = Number(window.usedPercent);
    return Number.isFinite(used) ? Math.min(100, Math.max(0, 100 - used)) : undefined;
}

function validReset(window: HoldWindow): number | undefined {
    const at = Number(window?.resetsAt);
    return Number.isFinite(at) && at > 0 ? at : undefined;
}

export interface WindowResetUnconfirmed {
    window: 'session' | 'weekly' | 'monthly';
    resetsAt: number;
}

/**
 * A window that was measured exhausted, whose reset time has passed on the
 * reporter's clock, but whose measurement predates that reset — i.e. the only
 * thing that changed since is the clock.
 */
export function windowResetUnconfirmed(
    windows: ReadonlyArray<readonly ['session' | 'weekly' | 'monthly', HoldWindow]>,
    quota: { updatedAt: number },
    reporterNowMs: number,
): WindowResetUnconfirmed | null {
    const measuredAt = Number(quota.updatedAt);
    if (!Number.isFinite(measuredAt) || measuredAt <= 0 || !Number.isFinite(reporterNowMs)) return null;
    for (const [window, w] of windows) {
        const left = remaining(w);
        const resetsAt = validReset(w);
        if (left === undefined || left >= QUOTA_HARD_EXHAUSTED_PERCENT || resetsAt === undefined) continue;
        if (reporterNowMs >= resetsAt && measuredAt < resetsAt) return { window, resetsAt };
    }
    return null;
}

function runtimeEvidence(raw: unknown): Pick<CliRateLimitEvidence, 'runtime'> {
    const runtime = (raw as CliRateLimitEvidence | null)?.runtime;
    return runtime && typeof runtime.sessionId === 'string' && typeof runtime.screenHash === 'string'
        && typeof runtime.resetText === 'string' ? { runtime } : {};
}

function parseEvidence(raw: unknown, pool?: string): CliRateLimitEvidence | null {
    if (!raw || typeof raw !== 'object') return null;
    const observedAt = Number((raw as { observedAt?: unknown }).observedAt);
    if (!Number.isFinite(observedAt) || observedAt <= 0) return null;
    const resetsAt = Number((raw as { resetsAt?: unknown }).resetsAt);
    return { observedAt, ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}), ...(pool ? { pool } : {}), ...runtimeEvidence(raw) };
}

/** Pool-scoped CLI reports, keyed by pool id. */
export function readPoolCliRateLimitEvidence(quota: Pick<MeshNodeFactsProviderQuota, 'metadata'> | undefined | null): Record<string, CliRateLimitEvidence> {
    const raw = (quota?.metadata as { cliRateLimitPools?: unknown } | undefined)?.cliRateLimitPools;
    const out: Record<string, CliRateLimitEvidence> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [pool, value] of Object.entries(raw as Record<string, unknown>)) {
        const parsed = parseEvidence(value, pool);
        if (parsed) out[pool] = parsed;
    }
    return out;
}

/** The PROVIDER-WIDE CLI report (no pool known). Pool-scoped reports are read with readPoolCliRateLimitEvidence. */
export function readCliRateLimitEvidence(quota: Pick<MeshNodeFactsProviderQuota, 'metadata'> | undefined | null): CliRateLimitEvidence | null {
    const raw = (quota?.metadata as { cliRateLimit?: unknown } | undefined)?.cliRateLimit;
    if (!raw || typeof raw !== 'object') return null;
    const observedAt = Number((raw as { observedAt?: unknown }).observedAt);
    if (!Number.isFinite(observedAt) || observedAt <= 0) return null;
    const resetsAt = Number((raw as { resetsAt?: unknown }).resetsAt);
    return { observedAt, ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}), ...runtimeEvidence(raw) };
}

function minRemaining(quota: MeshNodeFactsProviderQuota, pool?: string): number | undefined {
    const buckets = Array.isArray(quota.buckets) ? quota.buckets : [];
    // A pool-scoped report clears on its OWN pool's buckets: the other pool's headroom says nothing about it.
    const poolBuckets = pool ? buckets.filter(b => (b as { group?: string } | undefined)?.group === pool) : [];
    const values = (pool && poolBuckets.length ? poolBuckets : [quota.session, quota.weekly, quota.monthly, ...buckets])
        .map(w => remaining(w as HoldWindow)).filter((v): v is number => v !== undefined);
    return values.length ? Math.min(...values) : undefined;
}

/**
 * Is the CLI's own rate-limit report still binding for this snapshot? Only a
 * real ('ok') measurement taken after the report can end it: after the stated
 * reset when there is one, otherwise with real headroom on every window.
 */
export function cliRateLimitHoldActive(evidence: CliRateLimitEvidence, quota: MeshNodeFactsProviderQuota): boolean {
    if (evidence.runtime && evidence.resetsAt === undefined) return true;
    if (quota.status !== 'ok' || !(Number(quota.updatedAt) > evidence.observedAt)) return true;
    if (evidence.resetsAt !== undefined && Number(quota.updatedAt) < evidence.resetsAt) return true;
    if (!evidence.runtime && evidence.resetsAt !== undefined) return false;
    const left = minRemaining(quota, evidence.pool);
    return left === undefined || left < CLI_RATE_LIMIT_CLEAR_MIN_PERCENT;
}

/** Keep the evidence on `next` while it still binds (called where a refresh replaces the cache entry). */
export function preserveCliRateLimitEvidence(
    prev: MeshNodeFactsProviderQuota | undefined,
    next: MeshNodeFactsProviderQuota,
): MeshNodeFactsProviderQuota {
    let out = next;
    const evidence = readCliRateLimitEvidence(prev);
    if (evidence && !readCliRateLimitEvidence(next) && cliRateLimitHoldActive(evidence, next)) {
        out = { ...out, metadata: { ...out.metadata, cliRateLimit: evidence } };
    }
    const prevPools = readPoolCliRateLimitEvidence(prev);
    const nextPools = readPoolCliRateLimitEvidence(next);
    const kept: Record<string, CliRateLimitEvidence> = { ...nextPools };
    for (const [pool, ev] of Object.entries(prevPools)) {
        if (!kept[pool] && cliRateLimitHoldActive(ev, next)) kept[pool] = ev;
    }
    if (Object.keys(kept).length > Object.keys(nextPools).length) {
        out = { ...out, metadata: { ...out.metadata, cliRateLimitPools: stripPools(kept) } };
    }
    return out;
}

function stripPools(pools: Record<string, CliRateLimitEvidence>): Record<string, Omit<CliRateLimitEvidence, 'pool'>> {
    return Object.fromEntries(Object.entries(pools).map(([pool, { pool: _p, ...rest }]) => [pool, rest]));
}

/** The entry with the CLI's rate-limit report stamped on (creating a minimal error entry when none exists). */
export function withCliRateLimitEvidence(
    provider: string,
    prev: MeshNodeFactsProviderQuota | undefined,
    evidence: CliRateLimitEvidence,
): MeshNodeFactsProviderQuota {
    const base: MeshNodeFactsProviderQuota = prev ?? {
        provider, status: 'error', session: null, weekly: null, updatedAt: evidence.observedAt,
        // A pool-scoped report must not mark the whole provider exhausted (the gate hard-blocks that).
        error: 'CLI reported its usage limit', metadata: evidence.pool ? { source: 'cli-evidence' } : { failureKind: 'quota-exhausted', source: 'cli-evidence' },
    };
    if (evidence.pool) {
        const pools = { ...readPoolCliRateLimitEvidence(base), [evidence.pool]: evidence };
        return { ...base, metadata: { ...base.metadata, cliRateLimitPools: stripPools(pools) } };
    }
    return { ...base, metadata: { ...base.metadata, cliRateLimit: {
        ...readCliRateLimitEvidence(base), ...evidence,
    } } };
}
