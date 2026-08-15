import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchGrokQuota } from '../../src/quota/fetchers/grok';
import type { QuotaFetch, QuotaFetchResponse } from '../../src/quota/fetchers/deps';
import { WEEKLY_WINDOW_MINUTES } from '../../src/quota/types';

const NOW = Date.UTC(2026, 7, 15, 8, 0, 0);
const FRESH_EXPIRY = new Date(NOW + 60 * 60 * 1000).toISOString();

const tempDirs: string[] = [];

/** Write an auth.json shaped like the real one: keyed by `{issuer}::{clientId}`. */
function makeGrokHome(auth: unknown | null): string {
    const home = mkdtempSync(join(tmpdir(), 'adhdev-grok-quota-'));
    tempDirs.push(home);
    if (auth !== null) {
        writeFileSync(
            join(home, 'auth.json'),
            typeof auth === 'string' ? auth : JSON.stringify(auth),
        );
    }
    return home;
}

function authFile(overrides: Record<string, unknown> = {}) {
    return {
        'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
            key: 'grok-access-token',
            auth_mode: 'oidc',
            email: 'user@example.com',
            expires_at: FRESH_EXPIRY,
            refresh_token: 'refresh-value',
            ...overrides,
        },
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

function stubFetch(response: QuotaFetchResponse | Error): {
    fetch: QuotaFetch;
    calls: string[];
    headers: Record<string, string>[];
} {
    const calls: string[] = [];
    const headers: Record<string, string>[] = [];
    const fetchImpl: QuotaFetch = async (url, init) => {
        calls.push(url);
        headers.push((init?.headers as Record<string, string>) ?? {});
        if (response instanceof Error) {
            throw response;
        }
        return response;
    };
    return { fetch: fetchImpl, calls, headers };
}

function deps(home: string, fetchImpl: QuotaFetch, extraEnv: NodeJS.ProcessEnv = {}) {
    return {
        fetch: fetchImpl,
        now: () => NOW,
        env: { GROK_HOME: home, ...extraEnv } as NodeJS.ProcessEnv,
    };
}

/**
 * The live payload observed from `GET /billing?format=credits`, verbatim in
 * shape. Values are the ones the owner's `/usage` screen showed: 1% used, week
 * ending 2026-08-22T03:35:16Z.
 *
 * ★Note there is no `subscription_tier` here — the endpoint does not return
 * one. The TUI's "SuperGrok Lite" label is merged in from its auth response.
 * See `liveBillingBodyWithTier` for the shape that does carry it.
 */
function liveBillingBody() {
    return {
        config: {
            currentPeriod: {
                type: 'USAGE_PERIOD_TYPE_WEEKLY',
                start: '2026-08-15T03:35:16.039394+00:00',
                end: '2026-08-22T03:35:16.039394+00:00',
            },
            creditUsagePercent: 1.0,
            onDemandCap: { val: 0 },
            onDemandUsed: { val: 0 },
            productUsage: [{ product: 'GrokBuild', usagePercent: 1.0 }],
            isUnifiedBillingUser: true,
            prepaidBalance: { val: 0 },
            topUpMethod: 'TOP_UP_METHOD_SAVED_PAYMENT_METHOD',
            billingPeriodStart: '2026-08-15T03:35:16.039394+00:00',
            billingPeriodEnd: '2026-08-22T03:35:16.039394+00:00',
        },
    };
}

/** The ACP-merged shape, which does carry the plan name. */
function liveBillingBodyWithTier() {
    return { ...liveBillingBody(), subscription_tier: 'SuperGrok Lite' };
}

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

describe('fetchGrokQuota', () => {
    it('maps the weekly window from the live billing payload', async () => {
        const home = makeGrokHome(authFile());
        const stub = stubFetch(jsonResponse(liveBillingBody()));

        const quota = await fetchGrokQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('ok');
        expect(quota.error).toBeNull();
        expect(quota.provider).toBe('grok-cli');
        expect(quota.weekly).toEqual({
            usedPercent: 1,
            windowMinutes: WEEKLY_WINDOW_MINUTES,
            resetsAt: Date.parse('2026-08-22T03:35:16.039394+00:00'),
        });
        // Grok exposes no short rolling plan window — must be null, not faked
        // from the TUI's per-process "session usage" tally.
        expect(quota.session).toBeNull();
        expect(quota.metadata?.source).toBe('oauth');
        // The endpoint carries no plan name, so none is invented.
        expect(quota.metadata?.planType).toBeUndefined();
    });

    it('records the plan name only when the payload actually carries one', async () => {
        const home = makeGrokHome(authFile());
        const stub = stubFetch(jsonResponse(liveBillingBodyWithTier()));

        const quota = await fetchGrokQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('ok');
        expect(quota.metadata?.planType).toBe('SuperGrok Lite');
    });

    it('queries the CLI chat-proxy billing endpoint with the CLI bearer token', async () => {
        const home = makeGrokHome(authFile());
        const stub = stubFetch(jsonResponse(liveBillingBody()));

        await fetchGrokQuota(deps(home, stub.fetch));

        expect(stub.calls).toEqual([
            'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
        ]);
        expect(stub.headers[0]?.Authorization).toBe('Bearer grok-access-token');
    });

    it('honours the chat-proxy base URL override', async () => {
        const home = makeGrokHome(authFile());
        const stub = stubFetch(jsonResponse(liveBillingBody()));

        await fetchGrokQuota(
            deps(home, stub.fetch, { GROK_CLI_CHAT_PROXY_BASE_URL: 'https://proxy.test/v1/' }),
        );

        expect(stub.calls).toEqual(['https://proxy.test/v1/billing?format=credits']);
    });

    it('reads the auth file named by GROK_AUTH_PATH', async () => {
        const home = makeGrokHome(authFile());
        const stub = stubFetch(jsonResponse(liveBillingBody()));

        const quota = await fetchGrokQuota(
            deps(home, stub.fetch, { GROK_AUTH_PATH: join(home, 'auth.json'), GROK_HOME: '/nonexistent' }),
        );

        expect(quota.status).toBe('ok');
    });

    it('falls back to billingPeriodEnd when currentPeriod is absent', async () => {
        const home = makeGrokHome(authFile());
        const stub = stubFetch(
            jsonResponse({
                config: {
                    creditUsagePercent: 42,
                    billingPeriodEnd: '2026-08-22T03:35:16.039394+00:00',
                },
            }),
        );

        const quota = await fetchGrokQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('ok');
        expect(quota.weekly?.usedPercent).toBe(42);
        expect(quota.weekly?.resetsAt).toBe(Date.parse('2026-08-22T03:35:16.039394+00:00'));
        expect(quota.metadata?.planType).toBeUndefined();
    });

    it('keeps a usable window when no reset timestamp is reported', async () => {
        const home = makeGrokHome(authFile());
        const stub = stubFetch(jsonResponse({ config: { creditUsagePercent: 7 } }));

        const quota = await fetchGrokQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('ok');
        expect(quota.weekly).toEqual({
            usedPercent: 7,
            windowMinutes: WEEKLY_WINDOW_MINUTES,
            resetsAt: null,
        });
    });

    it('picks the unexpired entry when auth.json holds several', async () => {
        const home = makeGrokHome({
            'https://auth.x.ai::old-client': {
                key: 'stale-token',
                expires_at: new Date(NOW - 60_000).toISOString(),
            },
            'https://auth.x.ai::new-client': {
                key: 'fresh-token',
                expires_at: FRESH_EXPIRY,
            },
        });
        const stub = stubFetch(jsonResponse(liveBillingBody()));

        const quota = await fetchGrokQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('ok');
        expect(stub.headers[0]?.Authorization).toBe('Bearer fresh-token');
    });

    // --- failure paths: all fail-open (never throw, always a snapshot) ------

    it('reports unavailable when the user is not signed in', async () => {
        const home = makeGrokHome(null);
        const stub = stubFetch(jsonResponse(liveBillingBody()));

        const quota = await fetchGrokQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('missing-credentials');
        expect(stub.calls).toEqual([]);
    });

    it('does not spend an expired token', async () => {
        const home = makeGrokHome(
            authFile({ expires_at: new Date(NOW - 1000).toISOString() }),
        );
        const stub = stubFetch(jsonResponse(liveBillingBody()));

        const quota = await fetchGrokQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('expired-token');
        expect(stub.calls).toEqual([]);
    });

    it('classifies a rejected credential as unauthorized', async () => {
        const home = makeGrokHome(authFile());
        const stub = stubFetch(jsonResponse({ error: 'nope' }, 403));

        const quota = await fetchGrokQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('unauthorized');
        expect(quota.weekly).toBeNull();
    });

    it('carries Retry-After through a 429', async () => {
        const home = makeGrokHome(authFile());
        const stub = stubFetch(jsonResponse({}, 429, { 'retry-after': '30' }));

        const quota = await fetchGrokQuota(deps(home, stub.fetch));

        expect(quota.metadata?.failureKind).toBe('rate-limited');
        expect(quota.metadata?.retryAtMs).toBe(NOW + 30_000);
    });

    it('classifies a 5xx as a server failure', async () => {
        const home = makeGrokHome(authFile());
        const stub = stubFetch(jsonResponse({}, 503));

        const quota = await fetchGrokQuota(deps(home, stub.fetch));

        expect(quota.metadata?.failureKind).toBe('server');
    });

    it('never throws when the network fails', async () => {
        const home = makeGrokHome(authFile());
        const stub = stubFetch(new Error('ECONNREFUSED'));

        const quota = await fetchGrokQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('network');
        expect(quota.weekly).toBeNull();
    });

    it('reports a parse failure when the payload carries no percentage', async () => {
        const home = makeGrokHome(authFile());
        const stub = stubFetch(jsonResponse({ config: { currentPeriod: { end: '2026-08-22T03:35:16Z' } } }));

        const quota = await fetchGrokQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('parse');
    });

    it('reports a parse failure on a malformed auth file', async () => {
        const home = makeGrokHome('{ not json');
        const stub = stubFetch(jsonResponse(liveBillingBody()));

        const quota = await fetchGrokQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('parse');
        expect(stub.calls).toEqual([]);
    });
});
