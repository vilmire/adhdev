/**
 * Codex CLI quota fetcher.
 *
 * Auth philosophy (see CLAUDE.md): ADHDev does NOT manage provider API keys.
 * This fetcher is the strictest possible expression of that rule — it never
 * reads, writes or even opens `$CODEX_HOME/auth.json`. We spawn the user's own
 * `codex` binary, which authenticates itself from its own on-disk session, and
 * ask it a question. When that session is missing or expired the CLI answers
 * with a JSON-RPC error and we report "cannot query"; refreshing it is the
 * CLI's job, done the next time the user runs `codex`.
 *
 * Transport: `codex app-server` speaks line-delimited JSON-RPC 2.0 over stdio.
 * We `initialize`, call `account/rateLimits/read` (which takes no params), and
 * exit. The child is spawned with `-s read-only -a untrusted` so that even if
 * the binary were induced to do something other than answer, it has neither
 * write access nor approval to act, and it is always terminated — see
 * `finish()` — including on the timeout path.
 *
 * The PTY `/status` fallback is deliberately NOT implemented; driving a PTY
 * would risk the CLI FSM and completion detection the daemon depends on. See
 * the scope note in `../index.ts`.
 *
 * Protocol facts (the `app-server` subcommand, the `account/rateLimits/read`
 * method, and the `usedPercent` / `resetsAt` / `windowDurationMins` field
 * names) were verified against `codex app-server generate-json-schema` from
 * codex-cli 0.146.0, and cross-checked against the reference implementation in
 * stablyai/orca (MIT). No Orca code is copied here.
 */
'use strict';

import {
    SESSION_WINDOW_MINUTES,
    WEEKLY_WINDOW_MINUTES,
    quotaFailure,
    windowFromPercent,
    type ProviderQuota,
    type QuotaFailureKind,
    type QuotaMetadata,
    type QuotaWindow,
} from '../types.js';
import type { QuotaChildProcess, QuotaFetchDeps } from './deps.js';
import { resolveDeps } from './deps.js';

/** Whole-operation budget: spawn, handshake and reply. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Grace between SIGTERM and SIGKILL, matching the daemon's usual escalation. */
const KILL_ESCALATION_MS = 2_000;

const INITIALIZE_ID = 1;
const RATE_LIMITS_ID = 2;
/**
 * `account/read` on the same app-server session reports `{ account: { type,
 * email, planType }, requiresOpenaiAuth }`. Asking the CLI keeps the standing
 * rule that we never read `$CODEX_HOME/auth.json` ourselves (see the header):
 * the account label comes from the tool that owns the credential, exactly like
 * the rate limits do.
 */
const ACCOUNT_ID = 3;

const CLIENT_NAME = 'adhdev';
const CLIENT_VERSION = '1.0.0';

/**
 * Sign-in phrases only. Bare `auth` / `token` are forbidden here: they match
 * `Unauthorized` (the `auth` in the middle) and `token_revoked`, which are
 * HTTP 401 / revoked-credential transients, not "never signed in".
 *
 * Live-observed no-session reply from a CODEX_HOME with no auth.json:
 * `codex account authentication required to read rate limits`.
 */
const MISSING_CREDENTIALS_PATTERN =
    /not\s+signed[\s-]?in|\bsign[\s-]?in\b|\blog[\s-]?in\b|\bno account\b|authentication required/i;

const NETWORK_PATTERN =
    /\bnetwork error\b|\bENOTFOUND\b|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|socket hang up|\bfetch failed\b|failed to fetch/i;

const RATE_LIMIT_TEXT_PATTERN = /\brate limit(?:ed|s)? exceeded\b|\btoo many requests\b/i;

/** Nested JSON `code` values that mean the credential was rejected, not absent. */
const UNAUTHORIZED_ERROR_CODES = new Set(['token_revoked', 'invalid_token', 'access_denied']);

function toHttpStatus(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) {
        return Number(value.trim());
    }
    return null;
}

function kindFromHttpStatus(status: number): QuotaFailureKind | null {
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 429) return 'rate-limited';
    if (status >= 500 && status <= 599) return 'server';
    return null;
}

/**
 * Pull an embedded HTTP status out of an app-server error string. The live
 * `account/rateLimits/read` failure wraps the upstream response as text:
 * `failed: 401 Unauthorized; body={"error":{...},"status":401}`.
 */
function extractEmbeddedHttpStatus(text: string): number | null {
    const bodyEq = text.match(/\bbody\s*=\s*(\{[\s\S]*\})\s*;?/);
    if (bodyEq?.[1]) {
        try {
            const parsed = JSON.parse(bodyEq[1]) as { status?: unknown; error?: { status?: unknown } };
            const nested = toHttpStatus(parsed.status) ?? toHttpStatus(parsed.error?.status);
            const fromNested = nested !== null ? kindFromHttpStatus(nested) : null;
            if (fromNested && nested !== null) return nested;
        } catch {
            // Fall through to regex on the same string.
        }
    }
    const jsonStatus = text.match(/"status"\s*:\s*(\d{3})/);
    if (jsonStatus) {
        const n = Number(jsonStatus[1]);
        if (kindFromHttpStatus(n)) return n;
    }
    const labelled = text.match(/\b(?:HTTP\s+|failed:\s*)(401|403|429|5\d{2})\b/i);
    if (labelled) return Number(labelled[1]);
    const phrase = text.match(/\b(401|403)\s+Unauthorized\b/i) ?? text.match(/\b(429)\s+Too Many Requests\b/i);
    if (phrase) return Number(phrase[1]);
    return null;
}

function extractEmbeddedErrorCode(text: string): string | null {
    const match = text.match(/"code"\s*:\s*"([^"]+)"/);
    return match?.[1] ?? null;
}

/**
 * Classify an `account/rateLimits/read` JSON-RPC error from its message (and
 * any HTTP status / error code embedded in that message). HTTP status wins;
 * `unknown` is reserved for a fetcher that broke its never-throw contract and
 * must not be used for a well-formed remote failure.
 */
export function classifyCodexAppServerError(message: string): QuotaFailureKind {
    const text = message.trim();
    const http = extractEmbeddedHttpStatus(text);
    if (http !== null) {
        const kind = kindFromHttpStatus(http);
        if (kind) return kind;
    }
    const code = extractEmbeddedErrorCode(text);
    if (code && UNAUTHORIZED_ERROR_CODES.has(code)) return 'unauthorized';
    if (/\bunauthorized\b/i.test(text)) return 'unauthorized';
    if (NETWORK_PATTERN.test(text)) return 'network';
    if (RATE_LIMIT_TEXT_PATTERN.test(text)) return 'rate-limited';
    if (MISSING_CREDENTIALS_PATTERN.test(text)) return 'missing-credentials';
    return 'server';
}

function describeCodexRateLimitFailure(kind: QuotaFailureKind, text: string): string {
    switch (kind) {
        case 'missing-credentials':
            return `Not signed in to Codex (${text}) — run codex on this machine to sign in, then retry`;
        case 'unauthorized':
            return `Codex rate-limit lookup was rejected: ${text}`;
        case 'rate-limited':
            return `Codex rate-limit lookup was rate limited: ${text}`;
        case 'network':
            return `Codex rate-limit lookup failed: ${text}`;
        default:
            return `Codex rate-limit request failed: ${text}`;
    }
}

function codexCommand(env: NodeJS.ProcessEnv): string {
    const override = env.ADHDEV_CODEX_BIN?.trim();
    return override ? override : 'codex';
}

interface JsonRpcMessage {
    id?: number | string;
    result?: unknown;
    error?: { code?: number; message?: string };
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

/**
 * `resetsAt` is Unix *seconds* in the app-server protocol; the rest of ADHDev
 * speaks milliseconds. Values already large enough to be milliseconds are
 * passed through, so a future protocol change to ms does not yield a reset
 * date in the year 58000.
 */
function toResetMs(value: unknown): number | null {
    const seconds = toNumber(value);
    if (seconds === null || seconds <= 0) {
        return null;
    }
    return seconds > 1e11 ? seconds : seconds * 1000;
}

/** One `RateLimitWindow`, or null when it carries no usable percentage. */
function mapWindow(raw: unknown, fallbackMinutes: number): QuotaWindow | null {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const record = raw as Record<string, unknown>;
    const minutes = toNumber(record.windowDurationMins) ?? fallbackMinutes;
    return windowFromPercent(toNumber(record.usedPercent), minutes, toResetMs(record.resetsAt));
}

/**
 * Sort reported windows into session/weekly by their *duration*, not by their
 * `primary`/`secondary` position.
 *
 * This matters: on a Plus account `primary` is the 7-day window and
 * `secondary` is absent entirely, so treating `primary` as the session window
 * would report weekly consumption as if it were the 5h window. Each window is
 * assigned to whichever slot it is closer to, and a slot already filled by a
 * better-matching window is not overwritten.
 */
function assignWindows(windows: QuotaWindow[]): { session: QuotaWindow | null; weekly: QuotaWindow | null } {
    let session: QuotaWindow | null = null;
    let weekly: QuotaWindow | null = null;

    for (const window of windows) {
        const toSession = Math.abs(window.windowMinutes - SESSION_WINDOW_MINUTES);
        const toWeekly = Math.abs(window.windowMinutes - WEEKLY_WINDOW_MINUTES);
        if (toSession <= toWeekly) {
            if (session === null || toSession < Math.abs(session.windowMinutes - SESSION_WINDOW_MINUTES)) {
                session = window;
            }
        } else if (weekly === null || toWeekly < Math.abs(weekly.windowMinutes - WEEKLY_WINDOW_MINUTES)) {
            weekly = window;
        }
    }
    return { session, weekly };
}

/**
 * Attach the signed-in account's email to a quota snapshot, when `account/read`
 * reported one. ONLY the email is taken — no token, no `sub`, nothing else from
 * the account object — so the value that travels is the minimum that answers
 * "whose quota is this?".
 *
 * Returns the snapshot unchanged when the account is unknown, so a provider
 * that cannot report one simply has no label rather than an empty placeholder.
 */
export function withAccountEmail(quota: ProviderQuota, accountResult: unknown): ProviderQuota {
    const root = (typeof accountResult === 'object' && accountResult !== null ? accountResult : {}) as Record<string, unknown>;
    const account = (typeof root.account === 'object' && root.account !== null ? root.account : {}) as Record<string, unknown>;
    const email = typeof account.email === 'string' ? account.email.trim() : '';
    if (!email) return quota;
    return { ...quota, metadata: { ...(quota.metadata ?? {}), accountEmail: email } };
}

function mapRateLimits(result: unknown, nowMs: number): ProviderQuota {
    const root = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>;
    const snapshot = (typeof root.rateLimits === 'object' && root.rateLimits !== null
        ? root.rateLimits
        : {}) as Record<string, unknown>;

    const reported: QuotaWindow[] = [];
    const primary = mapWindow(snapshot.primary, SESSION_WINDOW_MINUTES);
    if (primary) {
        reported.push(primary);
    }
    const secondary = mapWindow(snapshot.secondary, WEEKLY_WINDOW_MINUTES);
    if (secondary) {
        reported.push(secondary);
    }
    const { session, weekly } = assignWindows(reported);

    const planTypeRaw = snapshot.planType;
    const metadata: QuotaMetadata = {
        source: 'app-server',
        ...(typeof planTypeRaw === 'string' ? { planType: planTypeRaw } : {}),
    };

    if (!session && !weekly) {
        return quotaFailure('codex-cli', 'error', 'Codex rate-limit response contained no quota windows', {
            ...metadata,
            failureKind: 'parse',
        });
    }

    return {
        provider: 'codex-cli',
        session,
        weekly,
        updatedAt: nowMs,
        error: null,
        status: 'ok',
        metadata,
    };
}

/** Read line-delimited JSON, tolerating chunk boundaries mid-line. */
function createLineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
    let buffered = '';
    return (chunk) => {
        buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        let newline = buffered.indexOf('\n');
        while (newline !== -1) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            if (line !== '') {
                onLine(line);
            }
            newline = buffered.indexOf('\n');
        }
    };
}

/**
 * Query the Codex app-server for the account's rate limits. Never throws —
 * every failure path resolves to a snapshot whose `status` is 'error' or
 * 'unavailable', and never leaves the child process running.
 */
export async function fetchCodexQuota(overrides: QuotaFetchDeps = {}): Promise<ProviderQuota> {
    const deps = resolveDeps(overrides);

    return new Promise<ProviderQuota>((resolve) => {
        let child: QuotaChildProcess;
        try {
            child = deps.spawn(
                codexCommand(deps.env),
                ['-s', 'read-only', '-a', 'untrusted', 'app-server'],
                { env: deps.env },
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            resolve(
                quotaFailure('codex-cli', 'unavailable', `Codex CLI could not be started: ${message}`, {
                    source: 'app-server',
                    failureKind: 'cli-unavailable',
                }),
            );
            return;
        }

        let settled = false;
        let timeoutHandle: unknown;
        let killHandle: unknown;
        let stderr = '';
        /**
         * The quota snapshot, held between the rate-limits reply and the
         * account/read reply. If the timeout or a child exit fires in that gap,
         * `finish` below still resolves with it rather than losing a good
         * reading to a slow account lookup.
         */
        let pendingQuota: ProviderQuota | null = null;

        /**
         * Single exit point. Resolves once and always tears the child down:
         * SIGTERM first, then SIGKILL if it is still alive, so a wedged
         * app-server cannot outlive the daemon's interest in it.
         */
        const finish = (quota: ProviderQuota): void => {
            if (settled) {
                return;
            }
            // A good quota reading already in hand outranks any failure raised
            // while we were only enriching it with the account label — the
            // timeout and the child-exit paths both land here.
            if (pendingQuota !== null && quota.status !== 'ok') {
                quota = pendingQuota;
            }
            settled = true;
            deps.clearTimeout(timeoutHandle);
            try {
                child.kill('SIGTERM');
                const escalation = deps.setTimeout(() => {
                    try {
                        child.kill('SIGKILL');
                    } catch {
                        // Already gone — nothing to escalate to.
                    }
                }, KILL_ESCALATION_MS);
                // Do not hold the event loop open just to escalate a kill.
                escalation.unref?.();
                killHandle = escalation;
            } catch {
                // Child already exited; kill() on a dead child is not an error
                // we need to surface in the quota snapshot.
            }
            void killHandle;
            resolve(quota);
        };

        const handleLine = (line: string): void => {
            let message: JsonRpcMessage;
            try {
                message = JSON.parse(line) as JsonRpcMessage;
            } catch {
                // The app-server may emit non-JSON banner noise; ignore it.
                return;
            }

            if (message.id === INITIALIZE_ID) {
                if (message.error) {
                    finish(
                        quotaFailure(
                            'codex-cli',
                            'error',
                            `Codex app-server handshake failed: ${message.error.message ?? 'unknown error'}`,
                            { source: 'app-server', failureKind: 'unsupported' },
                        ),
                    );
                    return;
                }
                try {
                    child.stdin.write(
                        `${JSON.stringify({
                            jsonrpc: '2.0',
                            id: RATE_LIMITS_ID,
                            method: 'account/rateLimits/read',
                        })}\n`,
                    );
                } catch (err) {
                    const detail = err instanceof Error ? err.message : String(err);
                    finish(
                        quotaFailure('codex-cli', 'error', `Codex rate-limit request failed: ${detail}`, {
                            source: 'app-server',
                            failureKind: 'cli-unavailable',
                        }),
                    );
                }
                return;
            }

            if (message.id === RATE_LIMITS_ID) {
                if (message.error) {
                    const text = message.error.message ?? 'unknown error';
                    const failureKind = classifyCodexAppServerError(text);
                    finish(
                        quotaFailure(
                            'codex-cli',
                            failureKind === 'missing-credentials' ? 'unavailable' : 'error',
                            describeCodexRateLimitFailure(failureKind, text),
                            { source: 'app-server', failureKind },
                        ),
                    );
                    return;
                }
                pendingQuota = mapRateLimits(message.result, deps.now());
                // The account label is OPT-IN (config `quotaShowAccountEmail`,
                // off by default). When it is off we do not merely drop the
                // value later — we never ASK for it, so no email exists to leak
                // into the in-memory cache, ~/.adhdev/quota/cache.json, the
                // node-facts bundle or any dashboard. Filtering at render time
                // would still have written it to disk.
                if (!deps.showAccountEmail()) {
                    finish(pendingQuota);
                    return;
                }
                // Opted in: ask the SAME app-server session who is signed in, so
                // the reader can tell whose usage this is. Best-effort by
                // construction: any failure below still finishes with the quota
                // we already have, just without the account label.
                try {
                    child.stdin.write(
                        `${JSON.stringify({
                            jsonrpc: '2.0',
                            id: ACCOUNT_ID,
                            // `params` is REQUIRED even though it takes no
                            // arguments — omitting it makes the app-server
                            // answer `-32600 Invalid request: missing field
                            // params`, which reads as "no account" and silently
                            // drops the label. Verified against codex-cli 0.146.0.
                            method: 'account/read',
                            params: {},
                        })}\n`,
                    );
                } catch {
                    finish(pendingQuota);
                }
                return;
            }

            if (message.id === ACCOUNT_ID) {
                // Only reachable after the rate-limits reply set pendingQuota, but
                // an out-of-order/duplicate reply must not crash the fetcher.
                if (pendingQuota === null) return;
                // Never let account enrichment turn a good quota reading into a
                // failure — an unreadable account is a missing label, not an error.
                finish(withAccountEmail(pendingQuota, message.error ? undefined : message.result));
            }
        };

        child.stdout.on('data', createLineReader(handleLine));
        child.stderr.on('data', (chunk) => {
            stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        });

        child.on('error', (err) => {
            // ENOENT lands here: codex is not installed or not on PATH.
            finish(
                quotaFailure('codex-cli', 'unavailable', `Codex CLI is unavailable: ${err.message}`, {
                    source: 'app-server',
                    failureKind: 'cli-unavailable',
                }),
            );
        });

        child.on('exit', (code) => {
            // Only meaningful if it beat us to an answer.
            const detail = stderr.trim().split('\n').slice(-1)[0] ?? '';
            finish(
                quotaFailure(
                    'codex-cli',
                    'error',
                    `Codex app-server exited (code ${code ?? 'null'}) before reporting rate limits${
                        detail ? `: ${detail}` : ''
                    }`,
                    { source: 'app-server', failureKind: 'cli-unavailable' },
                ),
            );
        });

        timeoutHandle = deps.setTimeout(() => {
            finish(
                quotaFailure('codex-cli', 'error', 'Codex rate-limit request timed out', {
                    source: 'app-server',
                    failureKind: 'network',
                }),
            );
        }, REQUEST_TIMEOUT_MS);

        try {
            child.stdin.write(
                `${JSON.stringify({
                    jsonrpc: '2.0',
                    id: INITIALIZE_ID,
                    method: 'initialize',
                    params: { clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION } },
                })}\n`,
            );
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            finish(
                quotaFailure('codex-cli', 'error', `Codex app-server handshake failed: ${detail}`, {
                    source: 'app-server',
                    failureKind: 'cli-unavailable',
                }),
            );
        }
    });
}
