import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchAntigravityQuota } from '../../src/quota/fetchers/antigravity';
import type {
    QuotaChildProcess,
    QuotaFetch,
    QuotaFetchResponse,
    QuotaSpawn,
} from '../../src/quota/fetchers/deps';
import { SESSION_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES } from '../../src/quota/types';

const NOW = Date.UTC(2026, 7, 16, 9, 0, 0);
const FRESH_EXPIRY = new Date(NOW + 60 * 60 * 1000).toISOString();
const STALE_EXPIRY = new Date(NOW - 60 * 60 * 1000).toISOString();

const GO_KEYRING_PREFIX = 'go-keyring-base64:';

/**
 * Fake OAuth client patterns for the runtime binary scan. Deliberately SHORT
 * and obviously fake: real-shaped values must never appear in this repo
 * (GitHub push protection blocks Google OAuth client credentials — that is
 * exactly why the fetcher discovers them from the local binary instead of
 * hardcoding). Only the regex SHAPE matters to the code under test.
 */
const FAKE_ID_1 = '1-aaa.apps.googleusercontent.com';
const FAKE_ID_2 = '2-bbb.apps.googleusercontent.com';
const FAKE_SECRET_1 = 'GOCSPX-s1';
const FAKE_SECRET_2 = 'GOCSPX-s2';

/**
 * Write a fake `agy` binary and return its path. Unique file per call so the
 * fetcher's stat-keyed discovery cache never leaks between tests.
 */
function fakeAgyBinary(
    contents = `fake-binary-padding ${FAKE_ID_1} more-padding ${FAKE_SECRET_1} end`,
): string {
    const dir = mkdtempSync(join(tmpdir(), 'adhdev-fake-agy-'));
    const file = join(dir, 'agy');
    writeFileSync(file, contents, 'latin1');
    return file;
}

/**
 * ★VERBATIM live response captured from
 * POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
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

/** Same shape as stubFetch, but answers successive calls from a list. */
function stubFetchSequence(responses: Array<QuotaFetchResponse | Error>): FetchStub {
    const calls: string[] = [];
    const inits: FetchStub['inits'] = [];
    let index = 0;
    const fetchImpl: QuotaFetch = async (url, init) => {
        calls.push(url);
        inits.push({
            method: init?.method,
            headers: init?.headers as Record<string, string> | undefined,
            body: init?.body,
        });
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        if (response instanceof Error) throw response;
        return response;
    };
    return { fetch: fetchImpl, calls, inits };
}

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
    });

    it('also accepts an unprefixed plain-JSON secret', async () => {
        const spawn = stubSpawn(JSON.stringify(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.status).toBe('ok');
    });

    it('POSTs to the PRODUCTION host with an empty body', async () => {
        // Body must stay `{}`: sending `project`/`metadata` makes the server
        // answer 429/400 (verified live).
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        await fetchAntigravityQuota(deps(spawn, fetch));

        expect(fetch.calls).toEqual([
            'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
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

    it('refreshes an expired access token via the stored refresh token', async () => {
        // ★The field case: a daemon host where the CLI is rarely launched
        // would otherwise report expired-token forever. Verified live
        // 2026-08-20 that this refresh exchange succeeds and does NOT rotate
        // the refresh token. The OAuth client pair is discovered from the
        // local agy binary at runtime — never hardcoded (push protection).
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetchSequence([
            jsonResponse({ access_token: 'fresh-access-token', expires_in: 3599, token_type: 'Bearer' }),
            jsonResponse(LIVE_RESPONSE),
        ]);

        const quota = await fetchAntigravityQuota(
            deps(spawn, fetch, { ADHDEV_ANTIGRAVITY_AGY_PATH: fakeAgyBinary() }),
        );

        expect(quota.status).toBe('ok');
        expect(fetch.calls).toEqual([
            'https://oauth2.googleapis.com/token',
            'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
        ]);
        expect(fetch.inits[1].headers?.Authorization).toBe('Bearer fresh-access-token');
        // The refresh redeem carries the stored refresh token and the client
        // pair discovered from the binary — never the access token.
        expect(fetch.inits[0].body).toContain('grant_type=refresh_token');
        expect(fetch.inits[0].body).toContain('refresh_token=refresh-value');
        expect(fetch.inits[0].body).toContain(`client_id=${FAKE_ID_1}`);
        expect(fetch.inits[0].body).toContain(`client_secret=${FAKE_SECRET_1}`);
        // No rotation => no write-back to the store.
        expect(spawn.calls).toHaveLength(1);
    });

    it('finds the agy binary via the known install path when PATH is stale', async () => {
        // ★Measured 2026-08-20 on the Windows host: the daemon's inherited
        // PATH lacked %LOCALAPPDATA%\agy\bin and a PATH-only lookup missed the
        // binary entirely. The fallback install paths exist for that case.
        const localAppData = mkdtempSync(join(tmpdir(), 'adhdev-fake-lad-'));
        const binDir = join(localAppData, 'agy', 'bin');
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(binDir, 'agy.exe'), `pad ${FAKE_ID_1} pad ${FAKE_SECRET_1}`, 'latin1');
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetchSequence([
            jsonResponse({ access_token: 'fresh-access-token', expires_in: 3599 }),
            jsonResponse(LIVE_RESPONSE),
        ]);

        const quota = await fetchAntigravityQuota(
            deps(spawn, fetch, {
                ADHDEV_ANTIGRAVITY_PLATFORM: 'win32',
                PATH: '',
                LOCALAPPDATA: localAppData,
            }),
        );

        expect(quota.status).toBe('ok');
        expect(fetch.inits[0].body).toContain(`client_id=${FAKE_ID_1}`);
    });

    it('pairs binary candidates by trial and caches the working pair', async () => {
        // The binary carries more than one id/secret with no usable pairing
        // anchor, so the pair is found by trial; the winner is cached per
        // binary version and the SECOND refresh must not re-pair.
        const binary = fakeAgyBinary(
            `pad ${FAKE_ID_1} pad ${FAKE_ID_2} pad ${FAKE_SECRET_1} pad ${FAKE_SECRET_2}`,
        );
        const env = { ADHDEV_ANTIGRAVITY_AGY_PATH: binary };

        const first = await fetchAntigravityQuota(deps(
            stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY }))),
            stubFetchSequence([
                jsonResponse({ error: 'invalid_client' }, 401),
                jsonResponse({ access_token: 'fresh-access-token', expires_in: 3599 }),
                jsonResponse(LIVE_RESPONSE),
            ]),
            env,
        ));
        expect(first.status).toBe('ok');

        const secondFetch = stubFetchSequence([
            jsonResponse({ access_token: 'fresh-access-token-2', expires_in: 3599 }),
            jsonResponse(LIVE_RESPONSE),
        ]);
        const second = await fetchAntigravityQuota(deps(
            stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY }))),
            secondFetch,
            env,
        ));

        expect(second.status).toBe('ok');
        // One token call, straight to the cached winning pair — no re-pairing.
        expect(secondFetch.calls).toEqual([
            'https://oauth2.googleapis.com/token',
            'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
        ]);
        expect(secondFetch.inits[0].body).toContain(`client_id=${FAKE_ID_1}`);
        expect(secondFetch.inits[0].body).toContain(`client_secret=${FAKE_SECRET_2}`);
    });

    it('does not report signed-out when one pair answers invalid_grant but another works', async () => {
        // A valid pair that did NOT issue this refresh token also answers
        // invalid_grant — treating the first one as "signed out" would be a
        // false signed-out report on a healthy session. Pairing must try the
        // remaining candidates first.
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetchSequence([
            jsonResponse({ error: 'invalid_grant' }, 400),
            jsonResponse({ access_token: 'fresh-access-token', expires_in: 3599 }),
            jsonResponse(LIVE_RESPONSE),
        ]);

        const quota = await fetchAntigravityQuota(
            deps(spawn, fetch, {
                ADHDEV_ANTIGRAVITY_AGY_PATH: fakeAgyBinary(
                    `pad ${FAKE_ID_1} pad ${FAKE_ID_2} pad ${FAKE_SECRET_1}`,
                ),
            }),
        );

        expect(quota.status).toBe('ok');
    });

    it('splits back-to-back secrets concatenated in the binary string blob', async () => {
        // ★Verified in the wild (agy 1.1.13): two secrets sit ADJACENT in the
        // string table, so a greedy pattern swallows them as one unusable
        // candidate. They must be split on the prefix boundary before pairing.
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetchSequence([
            jsonResponse({ error: 'invalid_client' }, 401),
            jsonResponse({ access_token: 'fresh-access-token', expires_in: 3599 }),
            jsonResponse(LIVE_RESPONSE),
        ]);

        const quota = await fetchAntigravityQuota(
            deps(spawn, fetch, {
                ADHDEV_ANTIGRAVITY_AGY_PATH: fakeAgyBinary(
                    `pad ${FAKE_ID_1} pad ${FAKE_SECRET_1}${FAKE_SECRET_2} tail`,
                ),
            }),
        );

        expect(quota.status).toBe('ok');
        // inits[0] is the failed first combination; the second attempt wins.
        expect(fetch.inits[1].body).toContain(`client_secret=${FAKE_SECRET_2}`);
    });

    it('reports expired-token with the locate failure when no agy binary exists', async () => {
        // Explicit, not silent: the read path still works, only the automatic
        // refresh is disabled, and the error says why.
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(
            deps(spawn, fetch, {
                ADHDEV_ANTIGRAVITY_AGY_PATH: join(tmpdir(), 'adhdev-definitely-not-here', 'agy'),
                PATH: '',
                HOME: mkdtempSync(join(tmpdir(), 'adhdev-empty-home-')),
            }),
        );

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('expired-token');
        expect(quota.error).toMatch(/could not be located/);
        expect(fetch.calls).toEqual([]);
    });

    it('reports expired-token with the reason when the binary has no OAuth client pattern', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(
            deps(spawn, fetch, { ADHDEV_ANTIGRAVITY_AGY_PATH: fakeAgyBinary('no credentials in here at all') }),
        );

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('expired-token');
        expect(quota.error).toMatch(/no Google OAuth client pattern/);
        expect(fetch.calls).toEqual([]);
    });

    it('reports a parse failure when no extracted pair can redeem the token', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetchSequence([jsonResponse({ error: 'invalid_client' }, 401)]);

        const quota = await fetchAntigravityQuota(
            deps(spawn, fetch, { ADHDEV_ANTIGRAVITY_AGY_PATH: fakeAgyBinary() }),
        );

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('parse');
        expect(quota.error).toMatch(/no OAuth client pair/);
    });

    it('persists a rotated refresh token back to the store item', async () => {
        // If Google ever answers a refresh WITH a new refresh_token, not
        // persisting it would log the CLI's session out — so the full updated
        // payload is written back, re-encoded like the CLI's own write.
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetchSequence([
            jsonResponse({
                access_token: 'fresh-access-token',
                refresh_token: 'rotated-refresh-value',
                expires_in: 3599,
            }),
            jsonResponse(LIVE_RESPONSE),
        ]);

        const quota = await fetchAntigravityQuota(
            deps(spawn, fetch, { ADHDEV_ANTIGRAVITY_AGY_PATH: fakeAgyBinary() }),
        );

        expect(quota.status).toBe('ok');
        expect(spawn.calls).toHaveLength(2);
        const write = spawn.calls[1];
        expect(write.command).toBe('/usr/bin/security');
        expect(write.args.slice(0, 6)).toEqual([
            'add-generic-password', '-U', '-s', 'gemini', '-a', 'antigravity',
        ]);
        const blobArg = write.args[write.args.indexOf('-w') + 1];
        expect(blobArg.startsWith(GO_KEYRING_PREFIX)).toBe(true);
        const written = JSON.parse(
            Buffer.from(blobArg.slice(GO_KEYRING_PREFIX.length), 'base64').toString('utf-8'),
        );
        expect(written.token.refresh_token).toBe('rotated-refresh-value');
        expect(written.token.access_token).toBe('fresh-access-token');
        expect(written.auth_method).toBe('consumer');
    });

    it('reports signed-out when the refresh token is rejected (invalid_grant)', async () => {
        // Persistent, not transient: retrying re-hears the same answer until
        // the user signs in again, hence missing-credentials/unavailable.
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetchSequence([
            jsonResponse({ error: 'invalid_grant', error_description: 'Token has been revoked.' }, 400),
        ]);

        const quota = await fetchAntigravityQuota(
            deps(spawn, fetch, { ADHDEV_ANTIGRAVITY_AGY_PATH: fakeAgyBinary() }),
        );

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('missing-credentials');
        expect(quota.error).toMatch(/signed out/);
        // The quota endpoint is never hit with a dead session.
        expect(fetch.calls).toEqual(['https://oauth2.googleapis.com/token']);
    });

    it('treats a refresh transport error as a transient network failure', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetchSequence([new Error('socket hang up')]);

        const quota = await fetchAntigravityQuota(
            deps(spawn, fetch, { ADHDEV_ANTIGRAVITY_AGY_PATH: fakeAgyBinary() }),
        );

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('network');
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
        const spawn = stubSpawn(keyringBlob(credentialPayload()));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        await fetchAntigravityQuota(deps(spawn, fetch, {
            ANTIGRAVITY_CLOUDCODE_BASE_URL: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
        }));

        expect(fetch.calls[0]).toBe(
            'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
        );
    });
});
