import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchAntigravityQuota } from '../../src/quota/fetchers/antigravity';
import type {
    QuotaChildProcess,
    QuotaFetch,
    QuotaFetchResponse,
    QuotaSpawn,
} from '../../src/quota/fetchers/deps';
import {
    QUOTA_RATE_LIMIT_RETRY_DELAY_MS,
    SESSION_WINDOW_MINUTES,
    TRANSIENT_QUOTA_FAILURE_KINDS,
    WEEKLY_WINDOW_MINUTES,
} from '../../src/quota/types';

const NOW = Date.UTC(2026, 7, 16, 9, 0, 0);
const FRESH_EXPIRY = new Date(NOW + 60 * 60 * 1000).toISOString();
const STALE_EXPIRY = new Date(NOW - 60 * 60 * 1000).toISOString();

const GO_KEYRING_PREFIX = 'go-keyring-base64:';

/**
 * Write a fake `agy` binary and return its path.
 *
 * ★The contents deliberately CONTAIN OAuth-client-shaped strings (short and
 * obviously fake — real-shaped values must never appear in this repo). The
 * fetcher used to scan the binary for exactly these and trial-pair them; the
 * point of the fixture now is the opposite one, that a binary sitting in
 * plain sight with harvestable-looking credentials changes nothing.
 */
function fakeAgyBinary(
    contents = 'fake-binary-padding 1-aaa.apps.googleusercontent.com more-padding GOCSPX-s1 end',
): string {
    const dir = mkdtempSync(join(tmpdir(), 'adhdev-fake-agy-'));
    const file = join(dir, 'agy');
    writeFileSync(file, contents, 'latin1');
    return file;
}

/**
 * ★VERBATIM live response captured from
 * POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
 * with body `{}` and the CLI's own keychain bearer token (2026-08-16).
 * Trimmed only of prose; field names/types/values are exactly as returned.
 *
 * Note `window` is a LABEL ("weekly" / "5h"), NOT a proto3 Duration — the
 * single most important fact this fixture pins.
 */
const LIVE_RESPONSE = {
    groups: [
        {
            buckets: [
                {
                    bucketId: 'gemini-weekly',
                    displayName: 'Weekly Limit Remaining',
                    window: 'weekly',
                    resetTime: '2026-08-17T16:28:23Z',
                    description: 'You have used some of your weekly limit…',
                    remainingFraction: 0.9967779,
                },
                {
                    bucketId: 'gemini-5h',
                    displayName: 'Five Hour Limit Remaining',
                    window: '5h',
                    resetTime: '2026-08-16T14:34:54Z',
                    remainingFraction: 1,
                },
            ],
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
        },
        {
            buckets: [
                {
                    bucketId: '3p-weekly',
                    displayName: 'Weekly Limit Remaining',
                    window: 'weekly',
                    resetTime: '2026-08-16T13:50:47Z',
                    remainingFraction: 0.9764644,
                },
                {
                    bucketId: '3p-5h',
                    displayName: 'Five Hour Limit Remaining',
                    window: '5h',
                    resetTime: '2026-08-16T13:58:17Z',
                    remainingFraction: 0.98662907,
                },
            ],
            displayName: 'Claude and GPT models',
            description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
        },
    ],
};

/** Live shape of the legacy sibling `retrieveUserQuota` (also captured). */
const LIVE_FLAT_RESPONSE = {
    buckets: [
        { tokenType: 'WTUS', modelId: 'chat_20706', remainingFraction: 1 },
        {
            resetTime: '2026-08-16T13:58:17Z',
            tokenType: 'WTUS',
            modelId: 'claude-sonnet-4-6',
            remainingFraction: 0.98662907,
        },
    ],
};

function credentialPayload(overrides: Record<string, unknown> = {}, authMethod = 'consumer') {
    return {
        token: {
            access_token: 'antigravity-access-token',
            token_type: 'Bearer',
            refresh_token: 'refresh-value',
            expiry: FRESH_EXPIRY,
            ...overrides,
        },
        auth_method: authMethod,
    };
}

/** Encode like go-keyring does for a non-clean-UTF8 secret. */
function keyringBlob(payload: unknown): string {
    const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return GO_KEYRING_PREFIX + Buffer.from(json, 'utf-8').toString('base64');
}

interface SpawnStub {
    spawn: QuotaSpawn;
    calls: Array<{ command: string; args: string[] }>;
}

/**
 * Fake credential-store command (`/usr/bin/security` on darwin, powershell.exe
 * on win32). `stdout === null` simulates the item being absent (exit 44 —
 * both real implementations use that code for "not signed in").
 */
function stubSpawn(
    stdout: string | null,
    options: { neverExits?: boolean; exitCode?: number; stderr?: string } = {},
): SpawnStub {
    const calls: SpawnStub['calls'] = [];
    const spawn: QuotaSpawn = (command, args) => {
        calls.push({ command, args });
        const listeners: Record<string, Array<(arg: never) => void>> = {};
        const child: QuotaChildProcess = {
            stdin: { write: () => {}, end: () => {} },
            stdout: {
                on: (_event, listener) => {
                    if (stdout !== null) queueMicrotask(() => listener(stdout));
                },
            },
            stderr: {
                on: (_event, listener) => {
                    if (options.stderr) queueMicrotask(() => listener(options.stderr as never));
                },
            },
            on: (event: string, listener: (arg: never) => void) => {
                (listeners[event] ??= []).push(listener);
                if (event === 'exit' && !options.neverExits) {
                    const code = options.exitCode ?? (stdout === null ? 44 : 0);
                    queueMicrotask(() => queueMicrotask(() => listener(code as never)));
                }
            },
            kill: () => {},
        };
        return child;
    };
    return { spawn, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): QuotaFetchResponse {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
}

interface FetchStub {
    fetch: QuotaFetch;
    calls: string[];
    inits: Array<{ method?: string; headers?: Record<string, string>; body?: string }>;
}

function stubFetch(response: QuotaFetchResponse | Error): FetchStub {
    const calls: string[] = [];
    const inits: FetchStub['inits'] = [];
    const fetchImpl: QuotaFetch = async (url, init) => {
        calls.push(url);
        inits.push({
            method: init?.method,
            headers: init?.headers as Record<string, string> | undefined,
            body: init?.body,
        });
        if (response instanceof Error) throw response;
        return response;
    };
    return { fetch: fetchImpl, calls, inits };
}

// NOTE: a `stubFetchSequence` helper lived here to script the two-call
// refresh-then-quota exchange. With the refresh gone this fetcher makes at
// most ONE request, so a sequence stub has nothing to express — and its
// absence is itself a small guard against casually reintroducing a two-call
// flow.

function deps(spawnStub: SpawnStub, fetchStub: FetchStub, env: Record<string, string> = {}) {
    return {
        spawn: spawnStub.spawn,
        fetch: fetchStub.fetch,
        now: () => NOW,
        // Pin the platform to darwin unless a test overrides it: the fetcher is
        // darwin-only by design (non-darwin short-circuits to 'unavailable'
        // before any spawn/fetch), so without this pin every keychain/endpoint
        // test inherited the HOST platform — green on a Mac, red on linux CI.
        env: { ADHDEV_ANTIGRAVITY_PLATFORM: 'darwin', ...env } as NodeJS.ProcessEnv,
    };
}

afterEach(() => {
    // Nothing global is mutated: the keychain is never written, and every
    // side effect goes through injected deps.
});

describe('fetchAntigravityQuota', () => {
    it('reads the credential from the macOS keychain, never from a file', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        await fetchAntigravityQuota(deps(spawn, fetch));

        expect(spawn.calls).toHaveLength(1);
        expect(spawn.calls[0].command).toBe('/usr/bin/security');
        expect(spawn.calls[0].args).toEqual([
            'find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w',
        ]);
    });

    it('decodes the go-keyring-base64 blob', async () => {
        // The raw keychain value is NOT plain JSON — a naive JSON.parse fails.
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.status).toBe('ok');
        expect(fetch.inits[0].headers?.Authorization).toBe('Bearer antigravity-access-token');
        expect(fetch.inits[0].headers?.['User-Agent']).toMatch(/^antigravity\/\S+ \S+\/\S+$/);
    });

    it('also accepts an unprefixed plain-JSON secret', async () => {
        const spawn = stubSpawn(JSON.stringify(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.status).toBe('ok');
    });

    it('POSTs to the daily host with an empty body', async () => {
        // Host must match `agy` (daily-cloudcode-pa). The unprefixed
        // cloudcode-pa host 429s Google AI Pro Antigravity accounts (sub2api
        // #5611); body must stay `{}`: sending `project`/`metadata` makes the
        // server answer 429/400 (verified live).
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        await fetchAntigravityQuota(deps(spawn, fetch));

        expect(fetch.calls).toEqual([
            'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
        ]);
        expect(fetch.inits[0].method).toBe('POST');
        expect(fetch.inits[0].body).toBe('{}');
    });

    it('maps the live response: window LABELS onto fixed axes', async () => {
        // ★`window` is "weekly"/"5h", NOT a Duration like "604800s". Parsing it
        // as a Duration returns null for every real bucket and leaves BOTH axes
        // unmapped — the bug this pins.
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.status).toBe('ok');
        expect(quota.weekly?.windowMinutes).toBe(WEEKLY_WINDOW_MINUTES);
        expect(quota.session?.windowMinutes).toBe(SESSION_WINDOW_MINUTES);
    });

    it('reports remainingFraction as CONSUMED percentage', async () => {
        // The field is what is LEFT: 0.9967779 remaining => ~0.32% used.
        // Inverting this would report an exhausted plan as untouched.
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        const geminiWeekly = quota.buckets?.find((b) => b.name.startsWith('Gemini Models'));
        expect(geminiWeekly?.usedPercent).toBeCloseTo(0.322, 2);
    });

    it('picks the WORST matching bucket for an axis', async () => {
        // Two groups each report a weekly bucket (0.32% and 2.35% used). The
        // axis is one headline number, and under-reporting consumption is the
        // dangerous direction, so the higher usage wins.
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.weekly?.usedPercent).toBeCloseTo(2.354, 2);
        expect(quota.session?.usedPercent).toBeCloseTo(1.337, 2);
    });

    it('prefixes bucket names with their group', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.buckets?.map((b) => b.name)).toEqual([
            'Gemini Models · Weekly Limit Remaining',
            'Gemini Models · Five Hour Limit Remaining',
            'Claude and GPT models · Weekly Limit Remaining',
            'Claude and GPT models · Five Hour Limit Remaining',
        ]);
    });

    it('parses the FLAT legacy shape, naming buckets by modelId', async () => {
        // The same endpoint can return model-bucket-shaped data, and the
        // legacy sibling always does. Without modelId handling these collapse
        // into anonymous rows.
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_FLAT_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.status).toBe('ok');
        expect(quota.buckets?.map((b) => b.name)).toEqual(['chat_20706', 'claude-sonnet-4-6']);
    });

    it('still tolerates a proto3 Duration window', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse({
            groups: [{ displayName: 'G', buckets: [
                { bucketId: 'w', displayName: 'W', window: '604800s', remainingFraction: 0.5 },
            ] }],
        }));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.weekly?.windowMinutes).toBe(WEEKLY_WINDOW_MINUTES);
        expect(quota.weekly?.usedPercent).toBe(50);
    });

    it('falls back to displayNameMappingKey then bucketId for a nameless bucket', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse({
            buckets: [
                { bucketId: 'id-only', remainingFraction: 0.5 },
                { displayNameMappingKey: 'mapped', bucketId: 'ignored', remainingFraction: 0.5 },
            ],
        }));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.buckets?.map((b) => b.name)).toEqual(['id-only', 'mapped']);
    });

    it('drops a bucket with no remainingFraction rather than showing 0% used', async () => {
        // remainingAmount alone carries no total, so no percentage exists.
        // Reporting 0% would claim full headroom.
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse({
            buckets: [
                { bucketId: 'amount-only', remainingAmount: '500' },
                { bucketId: 'good', remainingFraction: 0.25, window: 'weekly' },
            ],
        }));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.buckets?.map((b) => b.name)).toEqual(['good']);
    });

    it('skips disabled buckets', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse({
            buckets: [
                { bucketId: 'off', disabled: true, remainingFraction: 1 },
                { bucketId: 'on', remainingFraction: 0.8, window: 'weekly' },
            ],
        }));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.buckets?.map((b) => b.name)).toEqual(['on']);
    });

    it('reports no-data when the account has no quota buckets', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse({ groups: [] }));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('no-data');
    });

    it('reports missing-credentials when the keychain item is absent', async () => {
        const spawn = stubSpawn(null); // security exits non-zero
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('missing-credentials');
        expect(fetch.calls).toEqual([]);
    });

    it('reports unsupported on linux WITHOUT touching any credential store', async () => {
        for (const platform of ['linux', 'freebsd']) {
            const spawn = stubSpawn(keyringBlob(credentialPayload()));
            const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

            const quota = await fetchAntigravityQuota(
                deps(spawn, fetch, { ADHDEV_ANTIGRAVITY_PLATFORM: platform }),
            );

            expect(quota.status, platform).toBe('unavailable');
            expect(quota.metadata?.failureKind, platform).toBe('unsupported');
            expect(spawn.calls, platform).toEqual([]);
            expect(fetch.calls, platform).toEqual([]);
        }
    });

    it('explains WHY per platform, since the reasons differ', async () => {
        // linux: Secret Service structurally unavailable on a headless host,
        // so no implementation would help. An unknown platform still gets an
        // honest, non-misleading answer. (win32 used to sit in this test as
        // "backend unidentified" — the 2026-08-20 survey resolved it and
        // win32 is now SUPPORTED; see the wincred tests below.)
        const linux = await fetchAntigravityQuota(
            deps(stubSpawn(null), stubFetch(jsonResponse({})), { ADHDEV_ANTIGRAVITY_PLATFORM: 'linux' }),
        );
        expect(linux.error).toMatch(/Linux/);
        expect(linux.error).toMatch(/headless/);

        const other = await fetchAntigravityQuota(
            deps(stubSpawn(null), stubFetch(jsonResponse({})), { ADHDEV_ANTIGRAVITY_PLATFORM: 'freebsd' }),
        );
        expect(other.error).toMatch(/only supported on macOS/);
        expect(other.error).toMatch(/freebsd/);
    });

    it('reads the credential from the Windows Credential Manager on win32', async () => {
        // Recon (2026-08-20): `cmdkey /list` shows
        // `LegacyGeneric:target=gemini:antigravity` — the same go-keyring
        // service/account pair as macOS, read via a CredRead P/Invoke.
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(
            deps(spawn, fetch, { ADHDEV_ANTIGRAVITY_PLATFORM: 'win32' }),
        );

        expect(quota.status).toBe('ok');
        expect(spawn.calls).toHaveLength(1);
        expect(spawn.calls[0].command).toBe('powershell.exe');
        expect(spawn.calls[0].args).toContain('-EncodedCommand');
        // The encoded script targets the surveyed wincred item.
        const script = Buffer.from(
            spawn.calls[0].args[spawn.calls[0].args.indexOf('-EncodedCommand') + 1],
            'base64',
        ).toString('utf16le');
        expect(script).toContain('gemini:antigravity');
        expect(script).toContain('CredRead');
    });

    it('reports missing-credentials on win32 when the wincred item is absent', async () => {
        // CredRead's ERROR_NOT_FOUND surfaces as exit 44 from the script.
        const spawn = stubSpawn(null);
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(
            deps(spawn, fetch, { ADHDEV_ANTIGRAVITY_PLATFORM: 'win32' }),
        );

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('missing-credentials');
        expect(quota.metadata?.source).toBe('wincred');
        expect(fetch.calls).toEqual([]);
    });

    it('surfaces a wincred read failure instead of degrading to "not signed in"', async () => {
        // A CredRead error OTHER than not-found (e.g. access denied) must
        // reach the user with its reason — silently mapping it to
        // missing-credentials would send them re-logging in pointlessly.
        const spawn = stubSpawn('ignored', { exitCode: 1, stderr: 'CredRead failed: win32 error 5' });
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(
            deps(spawn, fetch, { ADHDEV_ANTIGRAVITY_PLATFORM: 'win32' }),
        );

        expect(quota.status).toBe('error');
        expect(quota.error).toMatch(/win32 error 5/);
        expect(fetch.calls).toEqual([]);
    });

    it('reports unsupported for a non-consumer (business) account', async () => {
        // Business accounts are served by businessaicode.googleapis.com /
        // FetchQuotaStatus, which was never verifiable here.
        const spawn = stubSpawn(keyringBlob(credentialPayload({}, 'business')));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('unsupported');
        expect(fetch.calls).toEqual([]);
    });

    it('reports expired-token without sending a request when there is no refresh token', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY, refresh_token: undefined })));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('expired-token');
        expect(fetch.calls).toEqual([]);
    });

    it('parses the RFC3339 offset expiry the CLI actually writes', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload({
            expiry: '2026-07-28T21:30:05.171451+09:00',
            refresh_token: undefined,
        })));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.metadata?.failureKind).toBe('expired-token');
    });

    /**
     * ★THE GATE FOR THIS CHANGE (incident 2026-08-20).
     *
     * A self-refresh that discovered OAuth client pairs by TRIAL — POSTing
     * wrong-secret combinations to Google's token endpoint until one worked —
     * got three machines answered 429 within minutes of rollout, while the
     * `agy` CLI itself kept working on the same hosts and accounts. That shape
     * is indistinguishable from credential stuffing, so the whole path was
     * removed and is pinned removed here.
     *
     * This is deliberately a WHITELIST over every request the module makes,
     * not a blacklist of oauth2.googleapis.com: a blacklist passes the moment
     * someone reintroduces an exchange against a different host or a mirror.
     * The only URL this fetcher may ever contact is the quota endpoint.
     */
    const QUOTA_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';

    it('NEVER performs an OAuth token exchange — expired token included', async () => {
        // The exact field state that motivated the reverted refresh: an
        // expired access token WITH a usable refresh token sitting right
        // there. The fetcher must still refuse to spend it.
        const spawn = stubSpawn(keyringBlob(credentialPayload({
            expiry: STALE_EXPIRY,
            refresh_token: 'refresh-value',
        })));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        // No request at all on this path — not to the token endpoint, not to
        // the quota endpoint with a token we minted.
        expect(fetch.calls).toEqual([]);
        expect(quota.metadata?.failureKind).toBe('expired-token');
    });

    it('contacts ONLY the quota endpoint on the happy path', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.status).toBe('ok');
        expect(fetch.calls).toEqual([QUOTA_URL]);
        // The bearer is the CLI's OWN stored token, verbatim — not one this
        // fetcher obtained.
        expect(fetch.inits[0].headers?.Authorization).toBe('Bearer antigravity-access-token');
        // Cloud Code 403s a Node/undici default UA on the daily host.
        expect(fetch.inits[0].headers?.['User-Agent']).toMatch(/^antigravity\/1\.1\.16 /);
    });

    it('sends no grant/client credentials in any request body it makes', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        await fetchAntigravityQuota(deps(spawn, fetch));

        for (const init of fetch.inits) {
            const body = init.body ?? '';
            expect(body).not.toMatch(/grant_type/);
            expect(body).not.toMatch(/client_secret/);
            expect(body).not.toMatch(/refresh_token/);
        }
    });

    it('never writes to the credential store — every spawn is a read', async () => {
        // The rotation write-back went out with the refresh. `security
        // add-generic-password` / CredWrite must not appear on any path.
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        await fetchAntigravityQuota(deps(spawn, fetch));

        for (const call of spawn.calls) {
            expect(call.args.join(' ')).not.toMatch(/add-generic-password/);
            expect(call.args.join(' ')).not.toMatch(/CredWrite/);
        }
        // Reading the credential is the only reason to spawn anything.
        expect(spawn.calls).toHaveLength(1);
        expect(spawn.calls[0].args).toContain('find-generic-password');
    });

    it('does not read the agy binary, even when one is present', async () => {
        // The binary scan (which produced the trial candidates) is gone. A
        // present binary must not change behaviour in any way.
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(
            deps(spawn, fetch, { ADHDEV_ANTIGRAVITY_AGY_PATH: fakeAgyBinary() }),
        );

        expect(fetch.calls).toEqual([]);
        expect(quota.metadata?.failureKind).toBe('expired-token');
    });

    it('tells the user the ONE action that refreshes the token', async () => {
        // ★Measured 2026-08-20: the keychain item's mtime tracks the last `agy`
        // launch, and the token had sat expired ~60h on a healthy account — so
        // the message must name the action. The prior wording ("the agy CLI
        // refreshes it on next use") described the CLI instead of telling the
        // reader what to do, which is the gap this pins closed.
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.error).toContain('run `agy` once');
    });

    it('classifies an expired token as TRANSIENT so last-good windows survive', async () => {
        // The caching the owner asked for is NOT implemented in this fetcher:
        // carryForwardLastGoodWindows (quota/refresh.ts) retains the previous
        // numbers for any TRANSIENT failure and marks them lastGoodWindows,
        // which renders as "refreshing". All this fetcher owes that mechanism
        // is the right failureKind — pinned here, since demoting it to a
        // non-transient kind would silently blank the dashboard numbers.
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(TRANSIENT_QUOTA_FAILURE_KINDS.has(quota.metadata?.failureKind as never)).toBe(true);
    });

    it('classifies 401 as unauthorized', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse({}, 401));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.metadata?.failureKind).toBe('unauthorized');
    });

    it('classifies 429 and honours Retry-After', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse({}, 429, { 'retry-after': '120' }));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.metadata?.failureKind).toBe('rate-limited');
        expect(quota.metadata?.retryAtMs).toBe(NOW + 120_000);
        expect(TRANSIENT_QUOTA_FAILURE_KINDS.has('rate-limited')).toBe(true);
    });

    it('classifies 429 without Retry-After at the 7-minute CLI-level floor', async () => {
        // Live cloudcode-pa 429s send no Retry-After (pinned in the fetcher
        // header). The default must not be the 2-minute token-race fuse —
        // that is what made us 3× more aggressive than the CLI's own throttle.
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse({}, 429));

        const before = Date.now();
        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.metadata?.failureKind).toBe('rate-limited');
        expect(quota.metadata?.retryAtMs).toBeGreaterThanOrEqual(before + QUOTA_RATE_LIMIT_RETRY_DELAY_MS);
        expect(TRANSIENT_QUOTA_FAILURE_KINDS.has(quota.metadata?.failureKind as never)).toBe(true);
    });

    it('classifies 5xx as a server failure', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse({}, 503));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.metadata?.failureKind).toBe('server');
    });

    it('never throws on a transport error', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(new Error('socket hang up'));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('network');
    });

    it('reports a parse failure on a malformed credential', async () => {
        const spawn = stubSpawn(keyringBlob('{not json'));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('parse');
    });

    it('honours the base-URL override', async () => {
        // Default is daily-; the override is the escape hatch for accounts
        // that 401 on daily- and need the unprefixed Gemini-CLI host.
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        await fetchAntigravityQuota(deps(spawn, fetch, {
            ANTIGRAVITY_CLOUDCODE_BASE_URL: 'https://cloudcode-pa.googleapis.com/v1internal',
        }));

        expect(fetch.calls[0]).toBe(
            'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
        );
    });
});
