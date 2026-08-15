/**
 * Grok CLI (xAI) quota fetcher.
 *
 * Auth philosophy (see CLAUDE.md): ADHDev does NOT manage provider API keys.
 * We read the OIDC access token the `grok` CLI already wrote to disk and use it
 * for a single authenticated GET. We never refresh, rotate or rewrite
 * `~/.grok/auth.json` — grok's refresh flow rotates the refresh token, so
 * writing it back from here would log out a live `grok` session. When the token
 * has expired we report "cannot query" and let the CLI refresh it on next run.
 *
 * ★Endpoint provenance — this was previously (twice) judged IMPOSSIBLE, so the
 * evidence is recorded here rather than left to be re-derived:
 *
 * The TUI's `/usage` view is NOT backed by `api.x.ai` or `management-api.x.ai`
 * (both were probed and answer 403/404 for a CLI OAuth token — that axis is
 * team-API billing and needs a separate management key). It is backed by the
 * CLI's own chat-proxy host. Establishing that took observing the CLI, not
 * reading its `--help`: `/usage` is a TUI slash command, so it appears in no
 * subcommand list.
 *
 * Chain of evidence:
 *   1. `grok --debug --debug-file F` logs its ACP gateway traffic. Driving the
 *      TUI and issuing `/usage` produces an `x.ai/billing` ext_method whose
 *      response is the exact object this fetcher parses.
 *   2. The binary carries the upstream request as a literal:
 *      `/billing?format=credits`, sent with `Bearer` + `x-grok-client-mode`
 *      (crate path `xai-grok-shell/src/extensions/billing.rs`).
 *   3. The base URL is the chat proxy the CLI already uses for models/chat —
 *      `https://cli-chat-proxy.grok.com/v1` — recorded in `~/.grok/models_cache.json`
 *      as `origin` and overridable via `GROK_CLI_CHAT_PROXY_BASE_URL`.
 *   4. Verified live: `GET {base}/billing?format=credits` → HTTP 200 with
 *      `creditUsagePercent` and a weekly `currentPeriod`, matching the TUI.
 *
 * Window mapping: grok bills a single WEEKLY period
 * (`USAGE_PERIOD_TYPE_WEEKLY`), reported as a percentage already computed by
 * the server — so `weekly` comes from `windowFromPercent`, not a used/limit
 * pair. There is NO session (5h) axis: the TUI's "Session usage" line is a
 * per-process token tally the CLI itself accumulates, not a plan window, so
 * `session` is deliberately null rather than faked from it.
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    WEEKLY_WINDOW_MINUTES,
    quotaFailure,
    windowFromPercent,
    type ProviderQuota,
} from '../types.js';
import type { QuotaFetchDeps } from './deps.js';
import { resolveDeps } from './deps.js';

const DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const REQUEST_TIMEOUT_MS = 10_000;
/** Refuse to spend a token that expires mid-flight. */
const EXPIRY_SKEW_MS = 5_000;

function grokHome(env: NodeJS.ProcessEnv): string {
    const override = env.GROK_HOME?.trim();
    return override ? override : path.join(os.homedir(), '.grok');
}

/** `GROK_AUTH_PATH` points at the auth file directly; `GROK_HOME` at its dir. */
function authPath(env: NodeJS.ProcessEnv): string {
    const direct = env.GROK_AUTH_PATH?.trim();
    return direct ? direct : path.join(grokHome(env), 'auth.json');
}

function baseUrl(env: NodeJS.ProcessEnv): string {
    const override = env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim();
    return (override ? override : DEFAULT_BASE_URL).replace(/\/+$/, '');
}

interface GrokCredentials {
    accessToken: string;
    /** Unix ms, or null when the file records no parseable expiry. */
    expiresAtMs: number | null;
}

type CredentialsResult =
    | { kind: 'ok'; credentials: GrokCredentials }
    | { kind: 'missing' }
    | { kind: 'invalid'; reason: string };

/**
 * `~/.grok/auth.json` is keyed by `{issuer}::{client_id}`, e.g.
 * `"https://auth.x.ai::b1a00492-..."`, with the token under `key`. The key name
 * is an implementation detail of whichever issuer the user logged in against,
 * so we scan entries rather than hard-coding one — and prefer the entry that is
 * still valid when several are present (a re-login against a new client id
 * leaves the old entry behind).
 */
function parseCredentials(raw: string, nowMs: number): CredentialsResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { kind: 'invalid', reason: 'Grok auth file is not valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { kind: 'invalid', reason: 'Grok auth file is not an object' };
    }

    const candidates: GrokCredentials[] = [];
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
        if (typeof entry !== 'object' || entry === null) {
            continue;
        }
        const record = entry as Record<string, unknown>;
        // The CLI writes the access token under `key`; tolerate `access_token`
        // too, which is what the auth response itself calls the same value.
        const token = typeof record.key === 'string' && record.key.length > 0
            ? record.key
            : typeof record.access_token === 'string' && record.access_token.length > 0
                ? record.access_token
                : null;
        if (token === null) {
            continue;
        }
        const expiresRaw = record.expires_at;
        let expiresAtMs: number | null = null;
        if (typeof expiresRaw === 'string' && expiresRaw.trim() !== '') {
            const ms = new Date(expiresRaw).getTime();
            expiresAtMs = Number.isNaN(ms) ? null : ms;
        } else if (typeof expiresRaw === 'number' && Number.isFinite(expiresRaw)) {
            // Seconds vs ms is ambiguous in the raw number form; treat anything
            // below year-2001-in-ms as seconds.
            expiresAtMs = expiresRaw < 1e11 ? expiresRaw * 1000 : expiresRaw;
        }
        candidates.push({ accessToken: token, expiresAtMs });
    }

    if (candidates.length === 0) {
        return { kind: 'invalid', reason: 'Grok auth file has no access token' };
    }
    // Prefer an unexpired entry; otherwise keep the longest-lived one so the
    // expiry branch reports the most favourable truth available.
    const usable = candidates.filter(
        (c) => c.expiresAtMs === null || c.expiresAtMs - nowMs > EXPIRY_SKEW_MS,
    );
    const pool = usable.length > 0 ? usable : candidates;
    const best = pool.reduce((a, b) => {
        if (a.expiresAtMs === null) return a;
        if (b.expiresAtMs === null) return b;
        return b.expiresAtMs > a.expiresAtMs ? b : a;
    });
    return { kind: 'ok', credentials: best };
}

function readCredentials(deps: Required<QuotaFetchDeps>): CredentialsResult {
    const file = authPath(deps.env);
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf-8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return { kind: 'missing' };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'invalid', reason: `Unable to read Grok auth file: ${message}` };
    }
    return parseCredentials(raw, deps.now());
}

function isExpired(credentials: GrokCredentials, nowMs: number): boolean {
    if (credentials.expiresAtMs === null) {
        // No expiry recorded — let the server be the judge rather than
        // refusing to ask. A 401 is classified below.
        return false;
    }
    return credentials.expiresAtMs - nowMs <= EXPIRY_SKEW_MS;
}

// --- response shape -------------------------------------------------------
// { config: { creditUsagePercent, currentPeriod: { type, start, end },
//             billingPeriodEnd, ... }, subscription_tier? }

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

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function mapBillingResponse(data: unknown): ProviderQuota {
    const root = asRecord(data) ?? {};
    const config = asRecord(root.config) ?? {};
    const period = asRecord(config.currentPeriod);

    const usedPercent = toNumber(config.creditUsagePercent);
    // `currentPeriod.end` is the authoritative reset; `billingPeriodEnd` is the
    // same instant on a unified-billing account and serves as the fallback.
    const resetsAt = toResetMs(period?.end) ?? toResetMs(config.billingPeriodEnd);

    const weekly = windowFromPercent(usedPercent, WEEKLY_WINDOW_MINUTES, resetsAt);
    if (!weekly) {
        return quotaFailure('grok-cli', 'error', 'Grok billing response contained no usage percentage', {
            source: 'oauth',
            failureKind: 'parse',
        });
    }

    // ★The plan name is NOT part of the /billing payload. The TUI shows
    // "SuperGrok Lite" because it merges `subscription_tier` in from its own
    // auth/authenticate response before rendering; the raw endpoint omits it,
    // and the JWT carries only an opaque numeric `tier` claim (6), not a
    // display name. So planType is populated only when the field is actually
    // present — today that means it stays absent rather than being guessed
    // from the tier number, which has no documented mapping.
    const tier = typeof root.subscription_tier === 'string' && root.subscription_tier.trim() !== ''
        ? root.subscription_tier
        : null;

    return {
        provider: 'grok-cli',
        // Grok has no short rolling plan window — see the header note.
        session: null,
        weekly,
        updatedAt: Date.now(),
        error: null,
        status: 'ok',
        metadata: { source: 'oauth', ...(tier ? { planType: tier } : {}) },
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
 * Fetch Grok subscription usage. Never throws — every failure path resolves to
 * a snapshot whose `status` is 'error' or 'unavailable', so a quota problem can
 * never exclude the provider from routing (fail-open).
 */
export async function fetchGrokQuota(overrides: QuotaFetchDeps = {}): Promise<ProviderQuota> {
    const deps = resolveDeps(overrides);

    const credentialsResult = readCredentials(deps);
    if (credentialsResult.kind === 'missing') {
        return quotaFailure('grok-cli', 'unavailable', 'Not signed in to Grok', {
            source: 'oauth',
            failureKind: 'missing-credentials',
        });
    }
    if (credentialsResult.kind === 'invalid') {
        return quotaFailure('grok-cli', 'error', credentialsResult.reason, {
            source: 'oauth',
            failureKind: 'parse',
        });
    }

    const credentials = credentialsResult.credentials;
    if (isExpired(credentials, deps.now())) {
        // Deliberately do not refresh: the CLI owns the token lifecycle.
        return quotaFailure(
            'grok-cli',
            'error',
            'Grok access token expired — the grok CLI refreshes it on next use; quota will report again after that.',
            { source: 'oauth', failureKind: 'expired-token' },
        );
    }

    try {
        const response = await deps.fetch(`${baseUrl(deps.env)}/billing?format=credits`, {
            headers: {
                Authorization: `Bearer ${credentials.accessToken}`,
                Accept: 'application/json',
                // The CLI identifies itself on this call; sent for parity so the
                // upstream sees the same client shape it does from `grok`.
                'x-grok-client-mode': 'headless',
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.status === 401 || response.status === 403) {
            // Unlike Kimi, grok does NOT answer 403 for an exhausted plan —
            // exhaustion shows up as creditUsagePercent reaching 100 on a 200.
            // So both codes here mean the credential was rejected.
            return quotaFailure(
                'grok-cli',
                'error',
                `Grok billing request was rejected (HTTP ${response.status})`,
                { source: 'oauth', failureKind: 'unauthorized' },
            );
        }
        if (response.status === 429) {
            return quotaFailure('grok-cli', 'error', 'Grok billing request was rate limited', {
                source: 'oauth',
                failureKind: 'rate-limited',
                retryAtMs: retryAfterMs(response.headers?.get?.('retry-after') ?? null, deps.now()),
            });
        }
        if (!response.ok) {
            return quotaFailure(
                'grok-cli',
                'error',
                `Grok billing request failed (HTTP ${response.status})`,
                { source: 'oauth', failureKind: response.status >= 500 ? 'server' : 'unknown' },
            );
        }

        return mapBillingResponse(await response.json());
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return quotaFailure('grok-cli', 'error', `Grok billing request failed: ${message}`, {
            source: 'oauth',
            failureKind: 'network',
        });
    }
}
