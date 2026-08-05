/**
 * Provider quota (rate-limit / remaining-usage) types.
 *
 * A "quota fetcher" answers one question for a CLI provider: how much of the
 * user's plan is left, and when does the window reset. Every fetcher is
 * strictly read-only with respect to credentials — see the auth philosophy
 * note in `fetchers/` — and returns this one normalized shape so the daemon,
 * dashboards and the mesh can render any provider without special-casing.
 *
 * Window vocabulary is deliberately provider-agnostic:
 *   - `session` — the short rolling window (Kimi 5h, Claude 5h, Codex 5h)
 *   - `weekly`  — the long rolling window (7d)
 *   - `monthly` — 30d billing-style window, only where a provider has one
 * A provider that lacks a window reports `null` for it rather than faking one.
 */
'use strict';

/** Providers that can report a quota. Kept narrow on purpose — adding one
 *  means an actual fetcher exists, not just a CLI we support. */
export type QuotaProvider = 'kimi' | 'claude-cli' | 'codex-cli' | 'antigravity-cli';

/**
 * Lifecycle of a quota snapshot.
 *  - `idle`        — never fetched
 *  - `fetching`    — a fetch is in flight
 *  - `ok`          — usable numbers present
 *  - `error`       — fetch attempted and failed (may still carry stale windows)
 *  - `unavailable` — provider not signed in / not installed; not an error the
 *                    user needs to act on beyond logging in
 */
export type QuotaStatus = 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable';

/**
 * Why a fetch failed, in machine-readable form. UI uses this to decide
 * between "log in", "wait", and "something is broken" — the human `error`
 * string alone is not reliable enough to branch on.
 */
export type QuotaFailureKind =
    | 'missing-credentials'
    | 'expired-token'
    | 'unauthorized'
    | 'rate-limited'
    | 'network'
    | 'server'
    | 'parse'
    | 'cli-unavailable'
    | 'unsupported'
    | 'unknown';

/** One rolling usage window. */
export interface QuotaWindow {
    /** Percentage of the window consumed, clamped to 0–100. */
    usedPercent: number;
    /** Window length in minutes (300 = 5h, 10080 = 7d, 43200 = 30d). */
    windowMinutes: number;
    /** Unix ms when the window resets, or null when the provider omits it. */
    resetsAt: number | null;
}

/** A provider-specific named bucket (e.g. one per model). */
export interface QuotaBucket extends QuotaWindow {
    name: string;
}

/** Extra provenance/diagnostic detail; never required to render a snapshot. */
export interface QuotaMetadata {
    /** Where the numbers came from, e.g. 'oauth' | 'statusline' | 'app-server'. */
    source?: string;
    failureKind?: QuotaFailureKind;
    /** Unix ms before which a refetch should not be attempted (HTTP Retry-After). */
    retryAtMs?: number;
    /** Subscription tier when the provider reports one (e.g. "plus"). */
    planType?: string | null;
    /**
     * The signed-in account this quota belongs to, when the provider's own CLI
     * reports it (codex: `account/read` → `account.email`). Present so a reader
     * can tell WHOSE 27% they are looking at when several accounts are in play.
     *
     * ★PII — P2P / local surfaces ONLY. This must never reach the server.
     * The status path is guarded by four independent allow-lists
     * (CLAUDE.md "Server content boundary"), and none of them carries quota
     * today: `buildCloudStatusReportPayload` does not even take a machine
     * object, and `RoutingSessionEntry` has no quota field. Adding this value
     * to any of those — or to the push-notification body — turns a one-line
     * allow-list edit into an irreversible personal-data leak. The regression
     * suite `test/quota/account-email-server-boundary.test.ts` fails if this
     * field name appears in any of those layers; do not weaken it.
     *
     * Never persisted alongside a token, and never logged.
     */
    accountEmail?: string | null;
}

/** Normalized quota snapshot for a single provider. */
export interface ProviderQuota {
    provider: QuotaProvider;
    /** Short rolling window, null when the provider has none / none is known. */
    session: QuotaWindow | null;
    /** 7-day rolling window, null when not applicable. */
    weekly: QuotaWindow | null;
    /** 30-day window, only for providers that bill monthly. */
    monthly?: QuotaWindow | null;
    /** Named per-model buckets, when a provider reports granular quota. */
    buckets?: QuotaBucket[];
    /** Unix ms of this snapshot. */
    updatedAt: number;
    /** Human-readable failure text; null when `status` is 'ok'. */
    error: string | null;
    status: QuotaStatus;
    metadata?: QuotaMetadata;
}

export const SESSION_WINDOW_MINUTES = 300;
export const WEEKLY_WINDOW_MINUTES = 10080;
export const MONTHLY_WINDOW_MINUTES = 43200;

/**
 * Clamp any ratio-ish number into a sane 0–100 percentage.
 *
 * NaN is unusable and reports 0. Infinity is not: it means the computation
 * overshot (e.g. a divide-by-tiny-limit), which is an *exhausted* quota —
 * reporting 0% there would tell the user they have full headroom left, the
 * worst direction to be wrong in.
 */
export function clampPercent(value: number): number {
    if (Number.isNaN(value)) {
        return 0;
    }
    return Math.min(100, Math.max(0, value));
}

/**
 * Build a window from a used/limit pair. Returns null when the inputs cannot
 * describe a real window — callers treat null as "this provider did not
 * report this window" rather than as zero usage.
 */
export function windowFromUsage(
    used: number | null,
    limit: number | null,
    windowMinutes: number,
    resetsAt: number | null = null,
): QuotaWindow | null {
    if (used === null || limit === null || !Number.isFinite(used) || !Number.isFinite(limit)) {
        return null;
    }
    if (limit <= 0) {
        return null;
    }
    return { usedPercent: clampPercent((used / limit) * 100), windowMinutes, resetsAt };
}

/** Build a window from an already-computed percentage. */
export function windowFromPercent(
    usedPercent: number | null,
    windowMinutes: number,
    resetsAt: number | null = null,
): QuotaWindow | null {
    if (usedPercent === null || !Number.isFinite(usedPercent)) {
        return null;
    }
    return { usedPercent: clampPercent(usedPercent), windowMinutes, resetsAt };
}

/** A failure snapshot with no usable windows. */
export function quotaFailure(
    provider: QuotaProvider,
    status: Extract<QuotaStatus, 'error' | 'unavailable'>,
    error: string,
    metadata?: QuotaMetadata,
): ProviderQuota {
    return {
        provider,
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error,
        status,
        ...(metadata ? { metadata } : {}),
    };
}
