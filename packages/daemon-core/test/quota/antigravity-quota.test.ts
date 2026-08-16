import { afterEach, describe, expect, it } from 'vitest';

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
 * Fake `/usr/bin/security`. `stdout === null` simulates the item being absent
 * (non-zero exit), which is how "not signed in" reaches the fetcher.
 */
function stubSpawn(stdout: string | null, options: { neverExits?: boolean } = {}): SpawnStub {
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
            stderr: { on: () => {} },
            on: (event: string, listener: (arg: never) => void) => {
                (listeners[event] ??= []).push(listener);
                if (event === 'exit' && !options.neverExits) {
                    queueMicrotask(() => queueMicrotask(() => listener((stdout === null ? 44 : 0) as never)));
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

function deps(spawnStub: SpawnStub, fetchStub: FetchStub, env: Record<string, string> = {}) {
    return {
        spawn: spawnStub.spawn,
        fetch: fetchStub.fetch,
        now: () => NOW,
        env: env as NodeJS.ProcessEnv,
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

    it('reports unsupported on non-darwin WITHOUT touching the keychain', async () => {
        for (const platform of ['linux', 'win32']) {
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

    it('explains WHY per platform, since the two reasons differ', async () => {
        // win32: backend merely UNIDENTIFIED (a positive finding could enable
        // support later). linux: Secret Service structurally unavailable on a
        // headless host, so no implementation would help. Collapsing both into
        // one message would hide that from whoever picks this up.
        const win = await fetchAntigravityQuota(
            deps(stubSpawn(null), stubFetch(jsonResponse({})), { ADHDEV_ANTIGRAVITY_PLATFORM: 'win32' }),
        );
        expect(win.error).toMatch(/Windows/);
        expect(win.error).toMatch(/PasswordVault/);

        const linux = await fetchAntigravityQuota(
            deps(stubSpawn(null), stubFetch(jsonResponse({})), { ADHDEV_ANTIGRAVITY_PLATFORM: 'linux' }),
        );
        expect(linux.error).toMatch(/Linux/);
        expect(linux.error).toMatch(/headless/);

        // An unknown platform still gets an honest, non-misleading answer.
        const other = await fetchAntigravityQuota(
            deps(stubSpawn(null), stubFetch(jsonResponse({})), { ADHDEV_ANTIGRAVITY_PLATFORM: 'freebsd' }),
        );
        expect(other.error).toMatch(/only supported on macOS/);
        expect(other.error).toMatch(/freebsd/);
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

    it('reports expired-token without sending a request', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: STALE_EXPIRY })));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('expired-token');
        expect(fetch.calls).toEqual([]);
    });

    it('parses the RFC3339 offset expiry the CLI actually writes', async () => {
        const spawn = stubSpawn(keyringBlob(credentialPayload({ expiry: '2026-07-28T21:30:05.171451+09:00' })));
        const fetch = stubFetch(jsonResponse(LIVE_RESPONSE));

        const quota = await fetchAntigravityQuota(deps(spawn, fetch));

        expect(quota.metadata?.failureKind).toBe('expired-token');
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
