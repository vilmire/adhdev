/**
 * Cursor CLI quota fetcher.
 *
 * Cursor's usage screen is backed by a private Connect-RPC unary method, not
 * the public/team REST API. Connect accepts protobuf JSON (`{}` for these
 * empty requests), so this reader needs no generated protobuf dependency.
 *
 * Auth is deliberately read-only. We consume the access token cursor-agent
 * already stored, or exchange CURSOR_API_KEY for an in-memory access token,
 * and never refresh, persist, rotate or rewrite credentials. Their lifecycle
 * remains owned by Cursor CLI.
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    MONTHLY_WINDOW_MINUTES,
    quotaFailure,
    windowFromUsage,
    type ProviderQuota,
    type QuotaMetadata,
} from '../types.js';
import type { QuotaChildProcess, QuotaFetchDeps, QuotaFetchResponse } from './deps.js';
import { assertInjectedNetworkFetchInTest, resolveDeps } from './deps.js';

const DEFAULT_BASE_URL = 'https://api2.cursor.sh';
const DASHBOARD_SERVICE = 'aiserver.v1.DashboardService';
const REQUEST_TIMEOUT_MS = 10_000;
const CREDENTIAL_STORE_TIMEOUT_MS = 5_000;
const UNLIMITED_HARD_LIMIT = 2_147_483_647;

type CursorUsage = NonNullable<QuotaMetadata['cursorUsage']>;

type CredentialsResult =
    | { kind: 'ok'; accessToken: string }
    | { kind: 'missing' }
    | { kind: 'invalid'; reason: string };

function homeDir(env: NodeJS.ProcessEnv): string {
    return env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
}

function platform(env: NodeJS.ProcessEnv): string {
    // Test seam only; production inherits process.platform.
    return env.ADHDEV_CURSOR_PLATFORM?.trim() || process.platform;
}

function authPath(env: NodeJS.ProcessEnv): string {
    switch (platform(env)) {
        case 'win32': {
            const appData = env.APPDATA?.trim();
            return path.join(appData || path.join(homeDir(env), 'AppData', 'Roaming'), 'Cursor', 'auth.json');
        }
        case 'darwin':
            return path.join(homeDir(env), '.cursor', 'auth.json');
        default: {
            const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homeDir(env), '.config');
            return path.join(configHome, 'cursor', 'auth.json');
        }
    }
}

function baseUrl(env: NodeJS.ProcessEnv): string {
    const override = env.CURSOR_API_BASE_URL?.trim() || env.CURSOR_API_ENDPOINT?.trim();
    return (override || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function clientVersion(env: NodeJS.ProcessEnv): string {
    const raw = env.CURSOR_CLI_VERSION?.trim();
    const normalized = raw?.startsWith('cli-') ? raw.slice(4) : raw;
    if (normalized) return `cli-${normalized}`;

    // The installer keeps the active executable under
    // `.../cursor-agent/versions/<version>/cursor-agent` and normally exposes
    // it through a symlink. Resolving that link is cheaper and more read-only
    // than spawning cursor-agent just to ask for --version.
    const names = platform(env) === 'win32'
        ? ['cursor-agent.exe', 'cursor-agent.cmd', 'cursor-agent']
        : ['cursor-agent', 'agent'];
    const candidates = [
        ...String(env.PATH ?? '').split(path.delimiter).flatMap((dir) =>
            dir.trim() === '' ? [] : names.map((name) => path.join(dir, name))),
        ...names.map((name) => path.join(homeDir(env), '.local', 'bin', name)),
    ];
    for (const candidate of candidates) {
        try {
            const parts = fs.realpathSync(candidate).split(/[\\/]+/);
            const versions = parts.lastIndexOf('versions');
            const discovered = versions >= 0 ? parts[versions + 1] : undefined;
            if (discovered && /^\d{4}\.\d{2}\.\d{2}-[A-Za-z0-9]+$/.test(discovered)) {
                return `cli-${discovered}`;
            }
        } catch {
            // Candidate is absent or not resolvable; keep looking.
        }
    }

    // Cursor's own interceptor uses cli-unknown when its build version is absent.
    return 'cli-unknown';
}

function parseStoredCredential(raw: string): CredentialsResult {
    const trimmed = raw.trim();
    if (trimmed === '') return { kind: 'missing' };

    // macOS Keychain installations may store the access token directly.
    if (!trimmed.startsWith('{')) return { kind: 'ok', accessToken: trimmed };

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return { kind: 'invalid', reason: 'Cursor auth file is not valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { kind: 'invalid', reason: 'Cursor auth file is not an object' };
    }
    const record = parsed as Record<string, unknown>;
    const token = record.accessToken ?? record.access_token;
    if (typeof token !== 'string' || token.trim() === '') {
        return { kind: 'invalid', reason: 'Cursor auth file has no access token' };
    }
    return { kind: 'ok', accessToken: token.trim() };
}

function readCredentialFile(env: NodeJS.ProcessEnv): CredentialsResult {
    try {
        return parseStoredCredential(fs.readFileSync(authPath(env), 'utf8'));
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' };
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'invalid', reason: `Unable to read Cursor auth file: ${message}` };
    }
}

function runKeychainRead(deps: Required<QuotaFetchDeps>): Promise<string | null> {
    return new Promise((resolve) => {
        let child: QuotaChildProcess;
        try {
            child = deps.spawn(
                '/usr/bin/security',
                ['find-generic-password', '-s', 'cursor', '-w'],
                { env: deps.env },
            );
        } catch {
            resolve(null);
            return;
        }

        let settled = false;
        let stdout = '';
        const finish = (value: string | null): void => {
            if (settled) return;
            settled = true;
            deps.clearTimeout(timer);
            resolve(value);
        };
        const timer = deps.setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already exited */ }
            finish(null);
        }, CREDENTIAL_STORE_TIMEOUT_MS);
        timer.unref?.();

        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', () => { /* never surface credential-store diagnostics */ });
        child.on('error', () => finish(null));
        child.on('exit', (code) => finish(code === 0 && stdout.trim() !== '' ? stdout.trim() : null));
        child.stdin.end();
    });
}

async function readCredentials(deps: Required<QuotaFetchDeps>): Promise<CredentialsResult> {
    // File first on every platform: it is the native store on Windows/Linux
    // and is also the explicit AGENT_CLI_CREDENTIAL_STORE=file store on macOS.
    const fromFile = readCredentialFile(deps.env);
    if (fromFile.kind !== 'missing') return fromFile;

    if (platform(deps.env) !== 'darwin' || deps.env.AGENT_CLI_CREDENTIAL_STORE === 'file') {
        return { kind: 'missing' };
    }

    // A missing/locked keychain is an ordinary signed-out state, not an error.
    const raw = await runKeychainRead(deps);
    return raw === null ? { kind: 'missing' } : parseStoredCredential(raw);
}

function rpcUrl(env: NodeJS.ProcessEnv, method: string): string {
    return `${baseUrl(env)}/${DASHBOARD_SERVICE}/${method}`;
}

function requestHeaders(env: NodeJS.ProcessEnv, accessToken?: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Connect-Protocol-Version': '1',
        'x-cursor-client-type': 'cli',
        'x-cursor-client-version': clientVersion(env),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    };
}

async function exchangeApiKey(
    deps: Required<QuotaFetchDeps>,
    apiKey: string,
): Promise<CredentialsResult> {
    try {
        const response = await deps.fetch(`${baseUrl(deps.env)}/auth/exchange_user_api_key`, {
            method: 'POST',
            headers: { ...requestHeaders(deps.env), Authorization: `Bearer ${apiKey}` },
            body: '{}',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) return { kind: 'missing' };
        const data = asRecord(await response.json());
        const token = data?.accessToken ?? data?.access_token;
        return typeof token === 'string' && token.trim() !== ''
            ? { kind: 'ok', accessToken: token.trim() }
            : { kind: 'invalid', reason: 'Cursor API key exchange returned no access token' };
    } catch {
        return { kind: 'missing' };
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function field(record: Record<string, unknown> | null, snake: string, camel: string): unknown {
    return record?.[snake] ?? record?.[camel];
}

function toNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function toOptionalNumber(value: unknown): number | undefined {
    return value === undefined || value === null ? undefined : toNumber(value) ?? undefined;
}

function toBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function retryAfterMs(response: QuotaFetchResponse, nowMs: number): number | undefined {
    const raw = response.headers?.get?.('retry-after') ?? null;
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return nowMs + seconds * 1000;
    const at = new Date(raw).getTime();
    return Number.isNaN(at) ? undefined : at;
}

/** Mirrors cursor-agent's usage-data.ts on-demand kind calculation. */
function mapCursorUsage(current: Record<string, unknown>, hard: Record<string, unknown> | null): CursorUsage {
    const spend = asRecord(field(current, 'spend_limit_usage', 'spendLimitUsage'));
    const usedDollars = (toNumber(field(spend, 'individual_used', 'individualUsed')) ?? 0) / 100;
    const individualLimitCents = toOptionalNumber(field(spend, 'individual_limit', 'individualLimit'));
    const direct = individualLimitCents === undefined
        ? undefined
        : individualLimitCents > 0
            ? { kind: 'fixed' as const, usedDollars, limitDollars: individualLimitCents / 100 }
            : { kind: 'disabled' as const, usedDollars };

    if (field(spend, 'limit_type', 'limitType') === 'team') {
        if (direct) return direct;
        if (hard) {
            const hardLimit = toNumber(field(hard, 'hard_limit', 'hardLimit')) ?? 0;
            return toBoolean(field(hard, 'no_usage_based_allowed', 'noUsageBasedAllowed')) === true || hardLimit <= 0
                ? { kind: 'disabled', usedDollars }
                : { kind: 'unlimited', usedDollars, scope: 'team-member' };
        }
        return (toNumber(field(spend, 'pooled_limit', 'pooledLimit')) ?? 0) > 0
            ? { kind: 'unlimited', usedDollars, scope: 'team-member' }
            : { kind: 'unavailable', usedDollars };
    }

    if (!hard) return direct ?? { kind: 'unavailable', usedDollars };
    if (toBoolean(field(hard, 'no_usage_based_allowed', 'noUsageBasedAllowed')) === true) {
        return { kind: 'disabled', usedDollars };
    }
    const hardLimit = toNumber(field(hard, 'hard_limit', 'hardLimit')) ?? 0;
    if (hardLimit >= UNLIMITED_HARD_LIMIT) {
        return { kind: 'unlimited', usedDollars, scope: 'personal' };
    }
    if (hardLimit > 0) return { kind: 'fixed', usedDollars, limitDollars: hardLimit };
    return { kind: 'disabled', usedDollars };
}

function mapUsageResponse(
    data: unknown,
    hardLimitData: unknown,
    nowMs: number,
): ProviderQuota {
    const current = asRecord(data);
    if (!current) {
        return quotaFailure('cursor-cli', 'error', 'Cursor usage response is not an object', {
            source: 'oauth', failureKind: 'parse',
        });
    }

    const planUsage = asRecord(field(current, 'plan_usage', 'planUsage'));
    if (!planUsage) {
        return quotaFailure(
            'cursor-cli',
            'unavailable',
            'Usage details are not available for this plan in the CLI.',
            {
                source: 'oauth',
                failureKind: 'no-data',
                cursorUsage: { kind: 'unavailable', usedDollars: 0 },
            },
        );
    }

    const enabled = toBoolean(current.enabled);
    const displayMessageRaw = field(current, 'display_message', 'displayMessage');
    const displayMessage = typeof displayMessageRaw === 'string' && displayMessageRaw.trim() !== ''
        ? displayMessageRaw.trim()
        : undefined;
    let cursorUsage = mapCursorUsage(current, asRecord(hardLimitData));
    if (enabled === false) cursorUsage = { kind: 'disabled', usedDollars: cursorUsage.usedDollars };
    cursorUsage = { ...cursorUsage, ...(enabled === undefined ? {} : { enabled }), ...(displayMessage ? { displayMessage } : {}) };

    const resetRaw = toNumber(field(current, 'billing_cycle_end', 'billingCycleEnd'));
    const resetAt = resetRaw !== null && resetRaw > 0 ? resetRaw : null;
    const monthly = cursorUsage.kind === 'fixed'
        ? windowFromUsage(
            cursorUsage.usedDollars,
            cursorUsage.limitDollars ?? null,
            MONTHLY_WINDOW_MINUTES,
            resetAt,
        )
        : null;

    return {
        provider: 'cursor-cli',
        session: null,
        weekly: null,
        monthly,
        updatedAt: nowMs,
        error: null,
        status: 'ok',
        metadata: { source: 'oauth', cursorUsage },
    };
}

async function postRpc(
    deps: Required<QuotaFetchDeps>,
    accessToken: string,
    method: string,
): Promise<QuotaFetchResponse> {
    return deps.fetch(rpcUrl(deps.env, method), {
        method: 'POST',
        headers: requestHeaders(deps.env, accessToken),
        body: '{}',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
}

/** Fetch Cursor's current billing-period usage. Never throws. */
export async function fetchCursorQuota(overrides: QuotaFetchDeps = {}): Promise<ProviderQuota> {
    assertInjectedNetworkFetchInTest(overrides, 'fetchCursorQuota');
    const deps = resolveDeps(overrides);

    let credentials = await readCredentials(deps);
    if (credentials.kind === 'missing') {
        const apiKey = deps.env.CURSOR_API_KEY?.trim();
        if (apiKey) credentials = await exchangeApiKey(deps, apiKey);
    }
    if (credentials.kind === 'missing') {
        return quotaFailure('cursor-cli', 'unavailable', 'Not signed in to Cursor CLI', {
            source: 'oauth', failureKind: 'missing-credentials',
        });
    }
    if (credentials.kind === 'invalid') {
        return quotaFailure('cursor-cli', 'error', credentials.reason, {
            source: 'oauth', failureKind: 'parse',
        });
    }

    try {
        const currentResponse = await postRpc(deps, credentials.accessToken, 'GetCurrentPeriodUsage');
        if (currentResponse.status === 401 || currentResponse.status === 403) {
            return quotaFailure(
                'cursor-cli',
                'error',
                `Cursor usage request was rejected (HTTP ${currentResponse.status})`,
                { source: 'oauth', failureKind: 'unauthorized' },
            );
        }
        if (currentResponse.status === 429) {
            return quotaFailure('cursor-cli', 'error', 'Cursor usage request was rate limited', {
                source: 'oauth',
                failureKind: 'rate-limited',
                retryAtMs: retryAfterMs(currentResponse, deps.now()),
            });
        }
        if (!currentResponse.ok) {
            return quotaFailure(
                'cursor-cli',
                'error',
                `Cursor usage request failed (HTTP ${currentResponse.status})`,
                { source: 'oauth', failureKind: currentResponse.status >= 500 ? 'server' : 'unknown' },
            );
        }

        const current = await currentResponse.json();
        const currentRecord = asRecord(current);
        if (!asRecord(field(currentRecord, 'plan_usage', 'planUsage'))) {
            return mapUsageResponse(current, null, deps.now());
        }

        const spend = asRecord(field(currentRecord, 'spend_limit_usage', 'spendLimitUsage'));
        const hasIndividualLimit = field(spend, 'individual_limit', 'individualLimit') !== undefined;
        let hardLimit: unknown = null;
        if (!hasIndividualLimit) {
            const hardResponse = await postRpc(deps, credentials.accessToken, 'GetHardLimit');
            if (hardResponse.ok) hardLimit = await hardResponse.json();
        }
        return mapUsageResponse(current, hardLimit, deps.now());
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return quotaFailure('cursor-cli', 'error', `Cursor usage request failed: ${message}`, {
            source: 'oauth', failureKind: 'network',
        });
    }
}
