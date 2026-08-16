import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchAntigravityQuota } from '../../src/quota/fetchers/antigravity';
import type { QuotaFetch, QuotaFetchResponse } from '../../src/quota/fetchers/deps';
import { SESSION_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES } from '../../src/quota/types';

const NOW = Date.UTC(2026, 7, 16, 8, 0, 0);
const FRESH_EXPIRY = new Date(NOW + 60 * 60 * 1000).toISOString();
const STALE_EXPIRY = new Date(NOW - 60 * 60 * 1000).toISOString();

const tempDirs: string[] = [];

/**
 * Write an `antigravity-oauth-token` shaped like the real one: the access token
 * lives under a nested `token` object and `expiry` is RFC3339 (Go time.Time),
 * NOT unix seconds.
 */
function makeHome(token: unknown | null): string {
    const home = mkdtempSync(join(tmpdir(), 'adhdev-antigravity-quota-'));
    tempDirs.push(home);
    if (token !== null) {
        writeFileSync(
            join(home, 'antigravity-oauth-token'),
            typeof token === 'string' ? token : JSON.stringify(token),
        );
    }
    return home;
}

function tokenFile(overrides: Record<string, unknown> = {}) {
    return {
        token: {
            access_token: 'antigravity-access-token',
            token_type: 'Bearer',
            refresh_token: 'refresh-value',
            expiry: FRESH_EXPIRY,
            ...overrides,
        },
        id_token: 'id-token-value',
        auth_method: 'consumer',
    };
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

interface StubbedFetch {
    fetch: QuotaFetch;
    calls: string[];
    inits: Array<{ method?: string; headers?: Record<string, string>; body?: string }>;
}

function stubFetch(response: QuotaFetchResponse | Error): StubbedFetch {
    const calls: string[] = [];
    const inits: StubbedFetch['inits'] = [];
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

function deps(home: string, stub: StubbedFetch) {
    return {
        fetch: stub.fetch,
        now: () => NOW,
        env: { ANTIGRAVITY_CLI_HOME: home } as NodeJS.ProcessEnv,
    };
}

/** The response shape the generated protobuf descriptors define. */
function quotaSummary(buckets: unknown[], groupName = 'Antigravity Pro') {
    return { groups: [{ displayName: groupName, description: 'plan', buckets }] };
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
});

describe('fetchAntigravityQuota', () => {
    it('POSTs to retrieveUserQuotaSummary with the CLI bearer token', async () => {
        const home = makeHome(tokenFile());
        const stub = stubFetch(jsonResponse(quotaSummary([
            { bucketId: 'sonnet', displayName: 'Claude Sonnet', remainingFraction: 0.75, window: '604800s' },
        ])));

        await fetchAntigravityQuota(deps(home, stub));

        expect(stub.calls).toEqual([
            'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
        ]);
        expect(stub.inits[0].method).toBe('POST');
        expect(stub.inits[0].headers?.Authorization).toBe('Bearer antigravity-access-token');
        expect(stub.inits[0].body).toBe('{}');
    });

    it('reports remainingFraction as CONSUMED percentage', async () => {
        // The field is what is LEFT: 0.75 remaining => 25% used. Getting this
        // inverted is the single most damaging bug possible here — it would
        // report an exhausted plan as nearly untouched.
        const home = makeHome(tokenFile());
        const stub = stubFetch(jsonResponse(quotaSummary([
            { bucketId: 'sonnet', displayName: 'Claude Sonnet', remainingFraction: 0.75, window: '604800s' },
        ])));

        const quota = await fetchAntigravityQuota(deps(home, stub));

        expect(quota.status).toBe('ok');
        expect(quota.buckets?.[0].usedPercent).toBe(25);
        expect(quota.metadata?.source).toBe('oauth');
    });

    it('maps a bucket onto the weekly axis only when its own window matches', async () => {
        const home = makeHome(tokenFile());
        const stub = stubFetch(jsonResponse(quotaSummary([
            { bucketId: 'weekly', displayName: 'Weekly', remainingFraction: 0.4, window: '604800s', resetTime: '2026-08-20T00:00:00Z' },
            { bucketId: 'session', displayName: 'Session', remainingFraction: 0.9, window: '18000s' },
        ])));

        const quota = await fetchAntigravityQuota(deps(home, stub));

        expect(quota.weekly?.windowMinutes).toBe(WEEKLY_WINDOW_MINUTES);
        expect(quota.weekly?.usedPercent).toBeCloseTo(60);
        expect(quota.weekly?.resetsAt).toBe(Date.parse('2026-08-20T00:00:00Z'));
        expect(quota.session?.windowMinutes).toBe(SESSION_WINDOW_MINUTES);
        expect(quota.session?.usedPercent).toBeCloseTo(10);
    });

    it('leaves fixed axes null when no bucket window matches them', async () => {
        // Antigravity buckets are per-pool, not per-window. Falling back to
        // "first bucket = session" would render a confident wrong number.
        const home = makeHome(tokenFile());
        const stub = stubFetch(jsonResponse(quotaSummary([
            { bucketId: 'monthly', displayName: 'Monthly credits', remainingFraction: 0.5, window: '2592000s' },
        ])));

        const quota = await fetchAntigravityQuota(deps(home, stub));

        expect(quota.status).toBe('ok');
        expect(quota.session).toBeNull();
        expect(quota.weekly).toBeNull();
        expect(quota.buckets).toHaveLength(1);
    });

    it('prefixes bucket names with their group so same-named pools stay distinct', async () => {
        const home = makeHome(tokenFile());
        const stub = stubFetch(jsonResponse(quotaSummary([
            { bucketId: 'sonnet', displayName: 'Sonnet', remainingFraction: 0.5, window: '604800s' },
        ], 'Pro')));

        const quota = await fetchAntigravityQuota(deps(home, stub));

        expect(quota.buckets?.[0].name).toBe('Pro · Sonnet');
    });

    it('skips disabled buckets rather than reporting them as unused', async () => {
        const home = makeHome(tokenFile());
        const stub = stubFetch(jsonResponse(quotaSummary([
            { bucketId: 'off', displayName: 'Not on this plan', disabled: true, remainingFraction: 1 },
            { bucketId: 'on', displayName: 'Active', remainingFraction: 0.2, window: '604800s' },
        ])));

        const quota = await fetchAntigravityQuota(deps(home, stub));

        expect(quota.buckets).toHaveLength(1);
        expect(quota.buckets?.[0].name).toBe('Antigravity Pro · Active');
    });

    it('reports no-data (not an error) when the account has no quota buckets', async () => {
        const home = makeHome(tokenFile());
        const stub = stubFetch(jsonResponse({ groups: [] }));

        const quota = await fetchAntigravityQuota(deps(home, stub));

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('no-data');
    });

    it('reports missing-credentials when the CLI has never signed in', async () => {
        const home = makeHome(null);
        const stub = stubFetch(jsonResponse({}));

        const quota = await fetchAntigravityQuota(deps(home, stub));

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('missing-credentials');
        expect(stub.calls).toEqual([]); // never spends a request without a token
    });

    it('reports expired-token WITHOUT sending a request, and never rewrites the file', async () => {
        // The CLI owns the token lifecycle; refreshing from here would rotate
        // the refresh token and could log out a live `agy` session.
        const home = makeHome(tokenFile({ expiry: STALE_EXPIRY }));
        const stub = stubFetch(jsonResponse({}));

        const quota = await fetchAntigravityQuota(deps(home, stub));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('expired-token');
        expect(stub.calls).toEqual([]);
    });

    it('parses the RFC3339 offset expiry the CLI actually writes', async () => {
        // Real files carry "+09:00"-style offsets, not unix seconds. Parsing
        // this as a number would treat every token as never-expiring.
        const home = makeHome(tokenFile({ expiry: '2026-07-28T21:30:05.171451+09:00' }));
        const stub = stubFetch(jsonResponse({}));

        const quota = await fetchAntigravityQuota(deps(home, stub));

        expect(quota.metadata?.failureKind).toBe('expired-token');
    });

    it('classifies 401 as unauthorized', async () => {
        const home = makeHome(tokenFile());
        const stub = stubFetch(jsonResponse({ error: {} }, 401));

        const quota = await fetchAntigravityQuota(deps(home, stub));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('unauthorized');
    });

    it('classifies 429 and honours Retry-After', async () => {
        const home = makeHome(tokenFile());
        const stub = stubFetch(jsonResponse({}, 429, { 'retry-after': '120' }));

        const quota = await fetchAntigravityQuota(deps(home, stub));

        expect(quota.metadata?.failureKind).toBe('rate-limited');
        expect(quota.metadata?.retryAtMs).toBe(NOW + 120_000);
    });

    it('classifies 5xx as a server failure', async () => {
        const home = makeHome(tokenFile());
        const stub = stubFetch(jsonResponse({}, 503));

        const quota = await fetchAntigravityQuota(deps(home, stub));

        expect(quota.metadata?.failureKind).toBe('server');
    });

    it('never throws on a transport error', async () => {
        const home = makeHome(tokenFile());
        const stub = stubFetch(new Error('socket hang up'));

        const quota = await fetchAntigravityQuota(deps(home, stub));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('network');
    });

    it('reports a parse failure on a malformed token file', async () => {
        const home = makeHome('{not json');
        const stub = stubFetch(jsonResponse({}));

        const quota = await fetchAntigravityQuota(deps(home, stub));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('parse');
    });

    it('honours the base-URL override', async () => {
        const home = makeHome(tokenFile());
        const stub = stubFetch(jsonResponse(quotaSummary([
            { bucketId: 'b', displayName: 'B', remainingFraction: 0.5, window: '604800s' },
        ])));

        await fetchAntigravityQuota({
            ...deps(home, stub),
            env: {
                ANTIGRAVITY_CLI_HOME: home,
                ANTIGRAVITY_CLOUDCODE_BASE_URL: 'https://staging.example.com/v1internal',
            } as NodeJS.ProcessEnv,
        });

        expect(stub.calls[0]).toBe('https://staging.example.com/v1internal:retrieveUserQuotaSummary');
    });
});
