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

export interface CliRateLimitEvidence {
    /** Unix ms (this daemon's clock) the CLI reported its usage limit. */
    observedAt: number;
    /** Unix ms the CLI said the limit resets, when it said so. */
    resetsAt?: number;
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

export function readCliRateLimitEvidence(quota: Pick<MeshNodeFactsProviderQuota, 'metadata'> | undefined | null): CliRateLimitEvidence | null {
    const raw = (quota?.metadata as { cliRateLimit?: unknown } | undefined)?.cliRateLimit;
    if (!raw || typeof raw !== 'object') return null;
    const observedAt = Number((raw as { observedAt?: unknown }).observedAt);
    if (!Number.isFinite(observedAt) || observedAt <= 0) return null;
    const resetsAt = Number((raw as { resetsAt?: unknown }).resetsAt);
    return { observedAt, ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}) };
}

function minRemaining(quota: MeshNodeFactsProviderQuota): number | undefined {
    const values = [quota.session, quota.weekly, quota.monthly, ...(Array.isArray(quota.buckets) ? quota.buckets : [])]
        .map(w => remaining(w as HoldWindow)).filter((v): v is number => v !== undefined);
    return values.length ? Math.min(...values) : undefined;
}

/**
 * Is the CLI's own rate-limit report still binding for this snapshot? Only a
 * real ('ok') measurement taken after the report can end it: after the stated
 * reset when there is one, otherwise with real headroom on every window.
 */
export function cliRateLimitHoldActive(evidence: CliRateLimitEvidence, quota: MeshNodeFactsProviderQuota): boolean {
    if (quota.status !== 'ok' || !(Number(quota.updatedAt) > evidence.observedAt)) return true;
    if (evidence.resetsAt !== undefined) return Number(quota.updatedAt) < evidence.resetsAt;
    const left = minRemaining(quota);
    return left === undefined || left < CLI_RATE_LIMIT_CLEAR_MIN_PERCENT;
}

/** Keep the evidence on `next` while it still binds (called where a refresh replaces the cache entry). */
export function preserveCliRateLimitEvidence(
    prev: MeshNodeFactsProviderQuota | undefined,
    next: MeshNodeFactsProviderQuota,
): MeshNodeFactsProviderQuota {
    const evidence = readCliRateLimitEvidence(prev);
    if (!evidence || readCliRateLimitEvidence(next)) return next;
    if (!cliRateLimitHoldActive(evidence, next)) return next;
    return { ...next, metadata: { ...next.metadata, cliRateLimit: evidence } };
}

/** The entry with the CLI's rate-limit report stamped on (creating a minimal error entry when none exists). */
export function withCliRateLimitEvidence(
    provider: string,
    prev: MeshNodeFactsProviderQuota | undefined,
    evidence: CliRateLimitEvidence,
): MeshNodeFactsProviderQuota {
    const base: MeshNodeFactsProviderQuota = prev ?? {
        provider, status: 'error', session: null, weekly: null, updatedAt: evidence.observedAt,
        error: 'CLI reported its usage limit', metadata: { failureKind: 'quota-exhausted', source: 'cli-evidence' },
    };
    return { ...base, metadata: { ...base.metadata, cliRateLimit: evidence } };
}
