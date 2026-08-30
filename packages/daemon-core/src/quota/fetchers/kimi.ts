/**
 * Kimi Code quota fetcher.
 *
 * Auth philosophy (see CLAUDE.md): ADHDev does NOT manage provider API keys.
 * We follow the managed provider's OAuth ref in Kimi's config, read the access
 * token the CLI already wrote to disk, and use it for a single authenticated
 * GET. We never refresh, rotate or rewrite that file — Kimi's refresh flow
 * rotates the refresh token, so writing it back from here would log out a live
 * `kimi` session. When the token has expired we simply report "cannot query"
 * and let the CLI refresh it on its next run.
 *
 * Endpoint/field facts (base URL, `/usages`, the `usage` + `limits` shape and
 * the `KIMI_CODE_HOME` / `KIMI_CODE_BASE_URL` env overrides) were established
 * from the Kimi CLI's own managed-usage code, cross-checked against the
 * reference implementation in stablyai/orca (MIT). No Orca code is copied here.
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    SESSION_WINDOW_MINUTES,
    WEEKLY_WINDOW_MINUTES,
    quotaFailure,
    windowFromUsage,
    type ProviderQuota,
    type QuotaWindow,
} from '../types.js';
import type { QuotaFetchDeps } from './deps.js';
import { assertInjectedNetworkFetchInTest, resolveDeps } from './deps.js';

const DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1';
const REQUEST_TIMEOUT_MS = 10_000;
/** Refuse to spend a token that expires mid-flight. */
const EXPIRY_SKEW_SECONDS = 5;

function kimiHome(env: NodeJS.ProcessEnv): string {
    const override = env.KIMI_CODE_HOME?.trim();
    return override ? override : path.join(os.homedir(), '.kimi-code');
}

interface ManagedKimiSettings {
    oauthKey?: string;
    baseUrl?: string;
}

/** Parse the single-line TOML string form Kimi writes for these fields. */
function tomlStringValue(line: string, key: 'base_url' | 'key'): string | undefined {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const basic = line.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*(?:#.*)?$`));
    if (basic?.[1]) {
        try {
            const value = JSON.parse(basic[1]);
            return typeof value === 'string' && value.trim() ? value.trim() : undefined;
        } catch {
            return undefined;
        }
    }
    const literal = line.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*'([^']*)'\\s*(?:#.*)?$`));
    return literal?.[1]?.trim() || undefined;
}

/**
 * Read only the managed Kimi provider fields needed to mirror the CLI's token
 * lookup. This intentionally is not a general TOML parser: Kimi writes both as
 * single-line strings, and falling back to the legacy defaults is safer than
 * rejecting credentials because an unrelated config feature uses new syntax.
 */
function readManagedKimiSettings(env: NodeJS.ProcessEnv): ManagedKimiSettings {
    let raw: string;
    try {
        raw = fs.readFileSync(path.join(kimiHome(env), 'config.toml'), 'utf-8');
    } catch {
        return {};
    }

    let section: 'provider' | 'oauth' | null = null;
    const settings: ManagedKimiSettings = {};
    for (const line of raw.split(/\r?\n/)) {
        const header = line.trim().match(/^\[\s*(.*?)\s*\](?:\s*#.*)?$/)?.[1];
        if (header !== undefined) {
            if (/^providers\s*\.\s*["']managed:kimi-code["']\s*$/.test(header)) {
                section = 'provider';
            } else if (/^providers\s*\.\s*["']managed:kimi-code["']\s*\.\s*oauth\s*$/.test(header)) {
                section = 'oauth';
            } else {
                section = null;
            }
            continue;
        }
        if (section === 'provider') {
            settings.baseUrl = tomlStringValue(line, 'base_url') ?? settings.baseUrl;
        } else if (section === 'oauth') {
            settings.oauthKey = tomlStringValue(line, 'key') ?? settings.oauthKey;
        }
    }
    return settings;
}

function credentialsPath(env: NodeJS.ProcessEnv, oauthKey?: string): string {
    // Mirrors Kimi CLI's `_credentials_path`: strip `oauth/`, keep the final
    // component, and store it under credentials/<name>.json. A configured ref
    // is authoritative — silently falling back to the leftover legacy token is
    // the exact failure mode that pinned quota to an expired credential.
    const configuredName = oauthKey?.replace(/^oauth\//, '').split('/').at(-1)?.trim();
    const name = configuredName
        && configuredName !== '.'
        && configuredName !== '..'
        && path.basename(configuredName) === configuredName
        ? configuredName
        : 'kimi-code';
    return path.join(kimiHome(env), 'credentials', `${name}.json`);
}

function baseUrl(env: NodeJS.ProcessEnv, configured?: string): string {
    const override = env.KIMI_CODE_BASE_URL?.trim();
    return (override || configured || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

interface KimiCredentials {
    accessToken: string;
    /** Unix *seconds*, as written by the CLI. */
    expiresAt: number | null;
}

type CredentialsResult =
    | { kind: 'ok'; credentials: KimiCredentials }
    | { kind: 'missing' }
    | { kind: 'invalid'; reason: string };

function parseCredentials(raw: string): CredentialsResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { kind: 'invalid', reason: 'Kimi credentials file is not valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { kind: 'invalid', reason: 'Kimi credentials file is not an object' };
    }
    const record = parsed as Record<string, unknown>;
    const accessToken = record.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
        return { kind: 'invalid', reason: 'Kimi credentials file has no access token' };
    }
    const expiresAtRaw = record.expires_at;
    const expiresAt = typeof expiresAtRaw === 'number' && Number.isFinite(expiresAtRaw)
        ? expiresAtRaw
        : null;
    return { kind: 'ok', credentials: { accessToken, expiresAt } };
}

function readCredentials(deps: Required<QuotaFetchDeps>, oauthKey?: string): CredentialsResult {
    const file = credentialsPath(deps.env, oauthKey);
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf-8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return { kind: 'missing' };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'invalid', reason: `Unable to read Kimi credentials: ${message}` };
    }
    return parseCredentials(raw);
}

function isExpired(credentials: KimiCredentials, nowMs: number): boolean {
    if (credentials.expiresAt === null) {
        // No expiry recorded — let the server be the judge rather than
        // refusing to ask. A 401 is classified below.
        return false;
    }
    return credentials.expiresAt - Math.floor(nowMs / 1000) <= EXPIRY_SKEW_SECONDS;
}

// --- response shape -------------------------------------------------------
// `usage` is the long (weekly) quota; `limits[]` carries shorter rolling
// windows, of which the ~5h one is the session view.

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

function windowMinutes(window: unknown): number | null {
    if (typeof window !== 'object' || window === null) {
        return null;
    }
    const record = window as Record<string, unknown>;
    const duration = toNumber(record.duration);
    if (duration === null) {
        return null;
    }
    const unit = String(record.timeUnit ?? '').toUpperCase();
    if (unit.includes('SECOND')) return Math.round(duration / 60);
    if (unit.includes('MINUTE')) return duration;
    if (unit.includes('HOUR')) return duration * 60;
    if (unit.includes('DAY')) return duration * 60 * 24;
    return duration;
}

/** Map one `detail` block, deriving `used` from `remaining` when needed. */
function mapDetail(detail: unknown, minutes: number): QuotaWindow | null {
    if (typeof detail !== 'object' || detail === null) {
        return null;
    }
    const record = detail as Record<string, unknown>;
    const limit = toNumber(record.limit);
    let used = toNumber(record.used);
    if (used === null) {
        const remaining = toNumber(record.remaining);
        if (remaining !== null && limit !== null) {
            used = limit - remaining;
        }
    }
    const resetsAt = toResetMs(record.resetTime) ?? toResetMs(record.resetAt);
    return windowFromUsage(used, limit, minutes, resetsAt);
}

function mapUsageResponse(data: unknown): ProviderQuota {
    const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
    const weekly = mapDetail(record.usage, WEEKLY_WINDOW_MINUTES);

    let session: QuotaWindow | null = null;
    const limits = Array.isArray(record.limits) ? record.limits : [];
    for (const entry of limits) {
        if (typeof entry !== 'object' || entry === null) {
            continue;
        }
        const limitRecord = entry as Record<string, unknown>;
        const minutes = windowMinutes(limitRecord.window) ?? SESSION_WINDOW_MINUTES;
        const mapped = mapDetail(limitRecord.detail, minutes);
        if (!mapped) {
            continue;
        }
        // Keep whichever reported window sits closest to a 5h session.
        const better =
            session === null ||
            Math.abs(minutes - SESSION_WINDOW_MINUTES) <
                Math.abs(session.windowMinutes - SESSION_WINDOW_MINUTES);
        if (better) {
            session = mapped;
        }
    }

    if (!session && !weekly) {
        return quotaFailure('kimi', 'error', 'Kimi usage response contained no quota windows', {
            source: 'oauth',
            failureKind: 'parse',
        });
    }
    return {
        provider: 'kimi',
        session,
        weekly,
        updatedAt: Date.now(),
        error: null,
        status: 'ok',
        metadata: { source: 'oauth' },
    };
}

/**
 * Body markers that mean "the plan is exhausted", per Kimi's own error
 * reference (403 + "You've reached your usage limit for this billing cycle").
 * Matched against the raw error body; deliberately narrow so an unrelated 403
 * (client allowlist, region block, ...) is never misclassified.
 */
const USAGE_LIMIT_BODY_PATTERN = /usage limit|quota\s*(exhausted|refresh)|billing cycle/i;

/** Best-effort error-body read; never throws, never blocks classification. */
async function readErrorBody(response: { text?(): Promise<string> }): Promise<string> {
    try {
        return (await response.text?.()) ?? '';
    } catch {
        return '';
    }
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
 * Fetch Kimi Code subscription usage. Never throws — every failure path
 * resolves to a snapshot whose `status` is 'error' or 'unavailable'.
 */
export async function fetchKimiQuota(overrides: QuotaFetchDeps = {}): Promise<ProviderQuota> {
    assertInjectedNetworkFetchInTest(overrides, 'fetchKimiQuota');
    const deps = resolveDeps(overrides);

    const settings = readManagedKimiSettings(deps.env);
    const credentialsResult = readCredentials(deps, settings.oauthKey);
    if (credentialsResult.kind === 'missing') {
        return quotaFailure('kimi', 'unavailable', 'Not signed in to Kimi Code', {
            source: 'oauth',
            failureKind: 'missing-credentials',
        });
    }
    if (credentialsResult.kind === 'invalid') {
        return quotaFailure('kimi', 'error', credentialsResult.reason, {
            source: 'oauth',
            failureKind: 'parse',
        });
    }

    const credentials = credentialsResult.credentials;
    if (isExpired(credentials, deps.now())) {
        // Deliberately do not refresh: the CLI owns the token lifecycle.
        return quotaFailure(
            'kimi',
            'error',
            'Kimi access token expired (they last ~15 min) — the kimi CLI refreshes it on next use; quota will report again after that.',
            { source: 'oauth', failureKind: 'expired-token' },
        );
    }

    try {
        const response = await deps.fetch(`${baseUrl(deps.env, settings.baseUrl)}/usages`, {
            headers: {
                Authorization: `Bearer ${credentials.accessToken}`,
                Accept: 'application/json',
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.status === 401) {
            return quotaFailure(
                'kimi',
                'error',
                'Kimi usage request was rejected (HTTP 401)',
                { source: 'oauth', failureKind: 'unauthorized' },
            );
        }
        if (response.status === 403) {
            // A 403 is NOT always an auth failure: Kimi answers 403 with
            // "You've reached your usage limit for this billing cycle..."
            // when the plan is exhausted (and with unrelated bodies — e.g. the
            // client-allowlist access_terminated_error — when it is not). Only
            // an explicit usage-limit marker in the body earns the
            // 'quota-exhausted' kind; anything else stays 'unauthorized' so an
            // auth problem is never misread as exhaustion.
            const body = await readErrorBody(response);
            if (USAGE_LIMIT_BODY_PATTERN.test(body)) {
                return quotaFailure(
                    'kimi',
                    'error',
                    'Kimi usage limit reached (HTTP 403) — quota refreshes at the next reset/billing cycle',
                    { source: 'oauth', failureKind: 'quota-exhausted' },
                );
            }
            return quotaFailure(
                'kimi',
                'error',
                'Kimi usage request was rejected (HTTP 403)',
                { source: 'oauth', failureKind: 'unauthorized' },
            );
        }
        if (response.status === 429) {
            return quotaFailure('kimi', 'error', 'Kimi usage request was rate limited', {
                source: 'oauth',
                failureKind: 'rate-limited',
                retryAtMs: retryAfterMs(response.headers?.get?.('retry-after') ?? null, deps.now()),
            });
        }
        if (!response.ok) {
            return quotaFailure(
                'kimi',
                'error',
                `Kimi usage request failed (HTTP ${response.status})`,
                { source: 'oauth', failureKind: response.status >= 500 ? 'server' : 'unknown' },
            );
        }

        return mapUsageResponse(await response.json());
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return quotaFailure('kimi', 'error', `Kimi usage request failed: ${message}`, {
            source: 'oauth',
            failureKind: 'network',
        });
    }
}
