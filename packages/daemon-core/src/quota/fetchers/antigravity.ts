/**
 * Antigravity CLI (`agy`, Google) quota fetcher.
 *
 * Auth philosophy (see CLAUDE.md): ADHDev does NOT manage provider API keys.
 * We read the OAuth access token the `agy` CLI already wrote to disk and use it
 * for a single authenticated POST. We never refresh, rotate or rewrite
 * `~/.gemini/antigravity-cli/antigravity-oauth-token` — Google's refresh flow
 * can rotate the refresh token, so writing it back from here risks logging out
 * a live `agy` session. When the token has expired we report "cannot query" and
 * let the CLI refresh it on next run (`failureKind: 'expired-token'`, which is
 * TRANSIENT, so the retry scheduler re-reads the file minutes later).
 *
 * ★Endpoint provenance — antigravity-cli was previously judged "quota not
 * supportable", so the evidence is recorded here rather than left to be
 * re-derived. The earlier verdict came from reading `agy --help`, which lists
 * no quota subcommand (usage is a TUI view, `UsageModel.renderQuotaGroup` in
 * the binary) — the same `--help`-only mistake that produced the wrong verdict
 * for grok-cli.
 *
 * Chain of evidence:
 *   1. The CLI's own logs (`~/.gemini/antigravity-cli/log/cli-*.log`) show a
 *      `quota_manager.go doRefreshQuota` loop and record every backend call it
 *      makes against ONE host: `https://daily-cloudcode-pa.googleapis.com`.
 *   2. The `agy` binary carries the upstream route as a literal —
 *      `/v1internal:retrieveUserQuotaSummary` — next to the generated protobuf
 *      handler `google3/google/internal/cloud/code/v1internal/
 *      v1internal_prediction_service_go_proto._PredictionService_
 *      RetrieveUserQuotaSummary_Handler`.
 *   3. Verified live against the real host: an unauthenticated
 *      `POST /v1internal:retrieveUserQuotaSummary` answers HTTP 401
 *      UNAUTHENTICATED, and the error body names the resolved method
 *      `google.internal.cloud.code.v1internal.PredictionService.
 *      RetrieveUserQuotaSummary`. A deliberately misspelled sibling route
 *      (`…SummaryXYZ`) answers HTTP 404 instead — so the 401 proves this exact
 *      method exists and is JSON-transcoded, not that the host 401s everything.
 *
 * ★NOT verified with a live 200: the only account on this machine has an
 * access token that expired 2026-07-28, and minting a fresh one means spending
 * the refresh token — precisely the write this fetcher refuses to do. So the
 * response MAPPING below is derived from the generated protobuf field
 * descriptors in the binary rather than from an observed body. Those give the
 * JSON names exactly (proto3 JSON uses the `json=` name):
 *   RetrieveUserQuotaSummaryResponse { groups[], buckets[] }
 *   QuotaSummaryGroup  { displayName, description, buckets[] }
 *   QuotaSummaryBucket { bucketId, displayName, description, window,
 *                        resetTime, disabled,
 *                        remainingFraction | remainingAmount }  // oneof
 * Every field is read defensively and any shape we cannot understand degrades
 * to a `parse` failure rather than a fabricated number — see mapQuotaSummary.
 *
 * Window mapping: Antigravity reports named BUCKETS (per model family / credit
 * pool), not the fixed session+weekly axes other providers use, and the bucket
 * carries its own `window` and `resetTime`. So buckets are reported as
 * `buckets[]`, and `session`/`weekly` are filled only when a bucket's own
 * window duration actually matches that axis — never guessed from bucket order.
 * `remainingFraction` is REMAINING, so usedPercent = (1 - fraction) * 100.
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    SESSION_WINDOW_MINUTES,
    WEEKLY_WINDOW_MINUTES,
    clampPercent,
    quotaFailure,
    type ProviderQuota,
    type QuotaBucket,
    type QuotaWindow,
} from '../types.js';
import type { QuotaFetchDeps } from './deps.js';
import { resolveDeps } from './deps.js';

const DEFAULT_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal';
const REQUEST_TIMEOUT_MS = 10_000;
/** Refuse to spend a token that expires mid-flight. */
const EXPIRY_SKEW_MS = 5_000;

function antigravityHome(env: NodeJS.ProcessEnv): string {
    const override = env.ANTIGRAVITY_CLI_HOME?.trim();
    return override ? override : path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

/** `ANTIGRAVITY_OAUTH_TOKEN_PATH` points at the file; `ANTIGRAVITY_CLI_HOME` at its dir. */
function tokenPath(env: NodeJS.ProcessEnv): string {
    const direct = env.ANTIGRAVITY_OAUTH_TOKEN_PATH?.trim();
    return direct ? direct : path.join(antigravityHome(env), 'antigravity-oauth-token');
}

function baseUrl(env: NodeJS.ProcessEnv): string {
    const override = env.ANTIGRAVITY_CLOUDCODE_BASE_URL?.trim();
    return (override ? override : DEFAULT_BASE_URL).replace(/\/+$/, '');
}

interface AntigravityCredentials {
    accessToken: string;
    /** Unix ms, or null when the file records no parseable expiry. */
    expiresAtMs: number | null;
}

type CredentialsResult =
    | { kind: 'ok'; credentials: AntigravityCredentials }
    | { kind: 'missing' }
    | { kind: 'invalid'; reason: string };

/**
 * `antigravity-oauth-token` is a single JSON object:
 *   { token: { access_token, token_type: "Bearer", refresh_token,
 *              expiry: "2026-07-28T21:30:05.171451+09:00" },
 *     id_token, auth_method: "consumer" }
 * `expiry` is RFC3339 with an offset (Go's `time.Time` marshalling), NOT the
 * unix-seconds form kimi uses — parsing it as a number would silently treat
 * every token as having no expiry.
 */
function parseCredentials(raw: string): CredentialsResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { kind: 'invalid', reason: 'Antigravity token file is not valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { kind: 'invalid', reason: 'Antigravity token file is not an object' };
    }
    const root = parsed as Record<string, unknown>;
    // Tolerate a flattened file as well as the nested `token` object the CLI
    // writes today — the shape is the CLI's private detail, not a contract.
    const token = typeof root.token === 'object' && root.token !== null
        ? (root.token as Record<string, unknown>)
        : root;

    const accessToken = token.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
        return { kind: 'invalid', reason: 'Antigravity token file has no access token' };
    }

    const expiryRaw = token.expiry ?? token.expires_at;
    let expiresAtMs: number | null = null;
    if (typeof expiryRaw === 'string' && expiryRaw.trim() !== '') {
        const ms = new Date(expiryRaw).getTime();
        expiresAtMs = Number.isNaN(ms) ? null : ms;
    } else if (typeof expiryRaw === 'number' && Number.isFinite(expiryRaw)) {
        // Seconds vs ms is ambiguous in the raw number form; treat anything
        // below year-2001-in-ms as seconds.
        expiresAtMs = expiryRaw < 1e11 ? expiryRaw * 1000 : expiryRaw;
    }

    return { kind: 'ok', credentials: { accessToken, expiresAtMs } };
}

function readCredentials(deps: Required<QuotaFetchDeps>): CredentialsResult {
    const file = tokenPath(deps.env);
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf-8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return { kind: 'missing' };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'invalid', reason: `Unable to read Antigravity token file: ${message}` };
    }
    return parseCredentials(raw);
}

function isExpired(credentials: AntigravityCredentials, nowMs: number): boolean {
    if (credentials.expiresAtMs === null) {
        // No expiry recorded — let the server be the judge rather than
        // refusing to ask. A 401 is classified below.
        return false;
    }
    return credentials.expiresAtMs - nowMs <= EXPIRY_SKEW_MS;
}

// --- response shape -------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function toNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function toResetMs(value: unknown): number | null {
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
}

/**
 * `window` is a proto3 Duration, which JSON-encodes as a seconds string with an
 * `s` suffix ("604800s"). Returns minutes, or null when absent/unparseable —
 * a bucket with no window is still reported, just without an axis mapping.
 */
function windowMinutes(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value / 60;
    }
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    const seconds = Number(value.trim().replace(/s$/, ''));
    return Number.isFinite(seconds) ? seconds / 60 : null;
}

/**
 * A bucket's consumed percentage. `remainingFraction` (0..1) and
 * `remainingAmount` are a protobuf `oneof`, so at most one is present, and BOTH
 * express what is LEFT — hence the inversion. `remainingAmount` alone cannot
 * produce a percentage (no total is reported), so it yields null rather than a
 * made-up denominator; such a bucket is dropped instead of shown as 0% used,
 * which would claim full headroom.
 */
function bucketUsedPercent(bucket: Record<string, unknown>): number | null {
    const fraction = toNumber(bucket.remainingFraction);
    if (fraction !== null) {
        return clampPercent((1 - fraction) * 100);
    }
    return null;
}

/**
 * Flatten `groups[].buckets[]` + top-level `buckets[]` into named buckets.
 * The group's display name prefixes the bucket's so a reader can tell two
 * same-named buckets from different pools apart ("Pro · Claude Sonnet").
 */
function collectBuckets(data: Record<string, unknown>): QuotaBucket[] {
    const out: QuotaBucket[] = [];

    const pushBucket = (raw: unknown, groupLabel: string | null): void => {
        const bucket = asRecord(raw);
        if (!bucket) return;
        // A disabled bucket is not part of this account's plan; reporting it
        // as 0%-used would invent headroom that does not exist.
        if (bucket.disabled === true) return;
        const usedPercent = bucketUsedPercent(bucket);
        if (usedPercent === null) return;
        const own = typeof bucket.displayName === 'string' && bucket.displayName.trim() !== ''
            ? bucket.displayName.trim()
            : typeof bucket.bucketId === 'string' && bucket.bucketId.trim() !== ''
                ? bucket.bucketId.trim()
                : 'quota';
        out.push({
            name: groupLabel ? `${groupLabel} · ${own}` : own,
            usedPercent,
            windowMinutes: windowMinutes(bucket.window) ?? 0,
            resetsAt: toResetMs(bucket.resetTime),
        });
    };

    for (const rawGroup of asArray(data.groups)) {
        const group = asRecord(rawGroup);
        if (!group) continue;
        const label = typeof group.displayName === 'string' && group.displayName.trim() !== ''
            ? group.displayName.trim()
            : null;
        for (const bucket of asArray(group.buckets)) pushBucket(bucket, label);
    }
    for (const bucket of asArray(data.buckets)) pushBucket(bucket, null);

    return out;
}

/**
 * Map a bucket onto a fixed axis ONLY when its own reported window matches
 * that axis. Antigravity's buckets are per-pool, not per-window, so picking
 * "the first bucket" as the session window would be a guess that renders a
 * confident wrong number; a mismatch simply leaves the axis null and the
 * buckets carry the real information.
 */
function axisWindow(buckets: QuotaBucket[], targetMinutes: number): QuotaWindow | null {
    // Allow 10% slack: providers report 7d as 604800s but a month as 30d/31d.
    const tolerance = targetMinutes * 0.1;
    const match = buckets.find(
        (b) => b.windowMinutes > 0 && Math.abs(b.windowMinutes - targetMinutes) <= tolerance,
    );
    if (!match) return null;
    return {
        usedPercent: match.usedPercent,
        windowMinutes: match.windowMinutes,
        resetsAt: match.resetsAt,
    };
}

function mapQuotaSummary(data: unknown): ProviderQuota {
    const root = asRecord(data);
    if (!root) {
        return quotaFailure('antigravity-cli', 'error', 'Antigravity quota response was not an object', {
            source: 'oauth',
            failureKind: 'parse',
        });
    }

    const buckets = collectBuckets(root);
    if (buckets.length === 0) {
        // Distinct from a transport failure: the call worked, the account just
        // has no readable quota bucket (metered/enterprise accounts report
        // none). 'no-data' is the kind for "channel fine, no current reading".
        return quotaFailure(
            'antigravity-cli',
            'unavailable',
            'Antigravity reported no quota buckets for this account',
            { source: 'oauth', failureKind: 'no-data' },
        );
    }

    return {
        provider: 'antigravity-cli',
        session: axisWindow(buckets, SESSION_WINDOW_MINUTES),
        weekly: axisWindow(buckets, WEEKLY_WINDOW_MINUTES),
        buckets,
        updatedAt: Date.now(),
        error: null,
        status: 'ok',
        metadata: { source: 'oauth' },
    };
}

function retryAfterMs(header: string | null, nowMs: number): number | undefined {
    if (!header) {
        return undefined;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
        return nowMs + seconds * 1000;
    }
    const at = new Date(header).getTime();
    return Number.isNaN(at) ? undefined : at;
}

/**
 * Fetch Antigravity subscription quota. Never throws — every failure path
 * resolves to a snapshot whose `status` is 'error' or 'unavailable', so a quota
 * problem can never exclude the provider from routing (fail-open).
 */
export async function fetchAntigravityQuota(overrides: QuotaFetchDeps = {}): Promise<ProviderQuota> {
    const deps = resolveDeps(overrides);

    const credentialsResult = readCredentials(deps);
    if (credentialsResult.kind === 'missing') {
        return quotaFailure('antigravity-cli', 'unavailable', 'Not signed in to Antigravity', {
            source: 'oauth',
            failureKind: 'missing-credentials',
        });
    }
    if (credentialsResult.kind === 'invalid') {
        return quotaFailure('antigravity-cli', 'error', credentialsResult.reason, {
            source: 'oauth',
            failureKind: 'parse',
        });
    }

    const credentials = credentialsResult.credentials;
    if (isExpired(credentials, deps.now())) {
        // Deliberately do not refresh: the CLI owns the token lifecycle.
        return quotaFailure(
            'antigravity-cli',
            'error',
            'Antigravity access token expired — the agy CLI refreshes it on next use; quota will report again after that.',
            { source: 'oauth', failureKind: 'expired-token' },
        );
    }

    try {
        const response = await deps.fetch(`${baseUrl(deps.env)}:retrieveUserQuotaSummary`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${credentials.accessToken}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            // `forceRefresh` deliberately omitted (defaults false): the CLI's
            // own quota_manager throttles forced reloads, and a daemon polling
            // on a 15-minute cadence has no reason to bypass the server cache.
            body: '{}',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.status === 401 || response.status === 403) {
            return quotaFailure(
                'antigravity-cli',
                'error',
                `Antigravity quota request was rejected (HTTP ${response.status})`,
                { source: 'oauth', failureKind: 'unauthorized' },
            );
        }
        if (response.status === 429) {
            return quotaFailure('antigravity-cli', 'error', 'Antigravity quota request was rate limited', {
                source: 'oauth',
                failureKind: 'rate-limited',
                retryAtMs: retryAfterMs(response.headers?.get?.('retry-after') ?? null, deps.now()),
            });
        }
        if (!response.ok) {
            return quotaFailure(
                'antigravity-cli',
                'error',
                `Antigravity quota request failed (HTTP ${response.status})`,
                { source: 'oauth', failureKind: response.status >= 500 ? 'server' : 'unknown' },
            );
        }

        return mapQuotaSummary(await response.json());
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return quotaFailure('antigravity-cli', 'error', `Antigravity quota request failed: ${message}`, {
            source: 'oauth',
            failureKind: 'network',
        });
    }
}
