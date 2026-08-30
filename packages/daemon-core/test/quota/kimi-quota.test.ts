import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchKimiQuota } from '../../src/quota/fetchers/kimi';
import type { QuotaFetch, QuotaFetchResponse } from '../../src/quota/fetchers/deps';

const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);
const FRESH_EXPIRY = Math.floor(NOW / 1000) + 900;

const tempDirs: string[] = [];

function makeKimiHome(credentials: unknown | null): string {
    const home = mkdtempSync(join(tmpdir(), 'adhdev-kimi-quota-'));
    tempDirs.push(home);
    if (credentials !== null) {
        mkdirSync(join(home, 'credentials'), { recursive: true });
        writeFileSync(
            join(home, 'credentials', 'kimi-code.json'),
            typeof credentials === 'string' ? credentials : JSON.stringify(credentials),
        );
    }
    return home;
}

function writeManagedKimiConfig(home: string, oauthKey: string, baseUrl: string): void {
    writeFileSync(
        join(home, 'config.toml'),
        [
            '[providers."managed:kimi-code"]',
            'type = "kimi"',
            `base_url = "${baseUrl}"`,
            '',
            '[providers."managed:kimi-code".oauth]',
            'storage = "file"',
            `key = "${oauthKey}"`,
            '',
        ].join('\n'),
    );
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

/** A fetch stub that records calls and fails the test if never expected. */
function stubFetch(response: QuotaFetchResponse | Error): { fetch: QuotaFetch; calls: string[]; headers: Record<string, string>[] } {
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
        env: { KIMI_CODE_HOME: home, ...extraEnv } as NodeJS.ProcessEnv,
    };
}

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

describe('fetchKimiQuota', () => {
    it('maps weekly usage and the ~5h session window from a successful response', async () => {
        const home = makeKimiHome({ access_token: 'tok', expires_at: FRESH_EXPIRY });
        const resetIso = '2026-08-04T00:00:00.000Z';
        const stub = stubFetch(
            jsonResponse({
                usage: { limit: 1000, used: 250, resetTime: resetIso },
                limits: [
                    { window: { duration: 5, timeUnit: 'HOURS' }, detail: { limit: 100, remaining: 40 } },
                    { window: { duration: 30, timeUnit: 'DAYS' }, detail: { limit: 5000, used: 10 } },
                ],
            }),
        );

        const quota = await fetchKimiQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('ok');
        expect(quota.error).toBeNull();
        expect(quota.provider).toBe('kimi');
        // weekly: 250/1000
        expect(quota.weekly).toEqual({
            usedPercent: 25,
            windowMinutes: 10080,
            resetsAt: Date.parse(resetIso),
        });
        // session: the 5h bucket wins over the 30d one; used derived from remaining
        expect(quota.session).toEqual({ usedPercent: 60, windowMinutes: 300, resetsAt: null });
        expect(quota.metadata?.source).toBe('oauth');
    });

    it('sends the bearer token to the usages endpoint and honours the base-url override', async () => {
        const home = makeKimiHome({ access_token: 'secret-token', expires_at: FRESH_EXPIRY });
        const stub = stubFetch(jsonResponse({ usage: { limit: 10, used: 1 } }));

        await fetchKimiQuota(deps(home, stub.fetch, { KIMI_CODE_BASE_URL: 'https://example.test/v9/' }));

        expect(stub.calls).toEqual(['https://example.test/v9/usages']);
        expect(stub.headers[0]?.Authorization).toBe('Bearer secret-token');
    });

    it('follows the managed provider OAuth ref instead of a stale legacy credential', async () => {
        const home = makeKimiHome({
            access_token: 'stale-legacy-token',
            expires_at: Math.floor(NOW / 1000) - 1,
        });
        const activeKey = 'kimi-code-env-test';
        writeFileSync(
            join(home, 'credentials', `${activeKey}.json`),
            JSON.stringify({ access_token: 'fresh-active-token', expires_at: FRESH_EXPIRY }),
        );
        writeManagedKimiConfig(home, `oauth/${activeKey}`, 'https://active.kimi.test/coding/v1');
        const stub = stubFetch(jsonResponse({ usage: { limit: 10, used: 2 } }));

        const quota = await fetchKimiQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('ok');
        expect(stub.calls).toEqual(['https://active.kimi.test/coding/v1/usages']);
        expect(stub.headers[0]?.Authorization).toBe('Bearer fresh-active-token');
    });

    it('does not fall back to a leftover legacy token when the configured OAuth credential is missing', async () => {
        const home = makeKimiHome({ access_token: 'legacy-token', expires_at: FRESH_EXPIRY });
        writeManagedKimiConfig(home, 'oauth/kimi-code-env-missing', 'https://active.kimi.test/coding/v1');
        const stub = stubFetch(jsonResponse({ usage: { limit: 10, used: 2 } }));

        const quota = await fetchKimiQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('missing-credentials');
        expect(stub.calls).toEqual([]);
    });

    it('reports unavailable (not error) when the credentials file is absent', async () => {
        const home = makeKimiHome(null);
        const stub = stubFetch(jsonResponse({}));

        const quota = await fetchKimiQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('missing-credentials');
        expect(stub.calls).toEqual([]); // never hits the network without credentials
    });

    it('refuses to call the API with an expired token and never refreshes it', async () => {
        const home = makeKimiHome({ access_token: 'tok', expires_at: Math.floor(NOW / 1000) - 1 });
        const stub = stubFetch(jsonResponse({}));

        const quota = await fetchKimiQuota(deps(home, stub.fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('expired-token');
        expect(stub.calls).toEqual([]);
    });

    it('treats a token expiring within the skew margin as expired', async () => {
        const home = makeKimiHome({ access_token: 'tok', expires_at: Math.floor(NOW / 1000) + 2 });
        const stub = stubFetch(jsonResponse({}));

        const quota = await fetchKimiQuota(deps(home, stub.fetch));

        expect(quota.metadata?.failureKind).toBe('expired-token');
        expect(stub.calls).toEqual([]);
    });

    // REGRESSION (owner-reported false guidance): an expired ACCESS token with
    // a still-valid refresh_token is not a broken login — Kimi issues 15-minute
    // access tokens by design, and the CLI's own file-locked refresh handles it
    // on next use. The old message ("session expired — run kimi ... to
    // refresh") implied the login itself was invalid and that the user had to
    // launch an interactive session to fix it; neither is true, and there is
    // nothing for the user to do here. Locks the message so that false
    // guidance cannot silently return.
    it('does not claim the session/login expired or ask the user to take action, even with a valid refresh_token present', async () => {
        const home = makeKimiHome({
            access_token: 'tok', expires_at: Math.floor(NOW / 1000) - 1,
            refresh_token: 'still-valid-refresh-token', scope: 'usages', token_type: 'Bearer',
        });
        const stub = stubFetch(jsonResponse({}));

        const quota = await fetchKimiQuota(deps(home, stub.fetch));

        expect(quota.metadata?.failureKind).toBe('expired-token');
        expect(stub.calls).toEqual([]); // still never refreshes/calls out itself
        expect(quota.error).not.toMatch(/session expired|run kimi|log ?in/i);
        expect(quota.error).toMatch(/access token/i);
        expect(quota.error).toMatch(/refresh/i); // still explains recovery is automatic
    });

    it('classifies 401 as unauthorized', async () => {
        const home = makeKimiHome({ access_token: 'tok', expires_at: FRESH_EXPIRY });
        const quota = await fetchKimiQuota(deps(home, stubFetch(jsonResponse({}, 401)).fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('unauthorized');
    });

    it('classifies a 403 carrying the usage-limit body as quota-exhausted, NOT unauthorized', async () => {
        const home = makeKimiHome({ access_token: 'tok', expires_at: FRESH_EXPIRY });
        // Body text per Kimi's own error reference for an exhausted plan.
        const body = {
            error: {
                message: "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.",
                type: 'quota_exceeded_error',
            },
        };
        const quota = await fetchKimiQuota(deps(home, stubFetch(jsonResponse(body, 403)).fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('quota-exhausted');
        // Persistent: no short retry is stamped — the quota is gone until the reset.
        expect(quota.metadata?.retryAtMs).toBeUndefined();
    });

    it('keeps a 403 WITHOUT usage-limit markers as unauthorized (403 is not always exhaustion)', async () => {
        const home = makeKimiHome({ access_token: 'tok', expires_at: FRESH_EXPIRY });
        const body = {
            error: {
                message: 'Kimi For Coding is currently only available for Coding Agents such as Kimi CLI, Claude Code, Roo Code, Kilo Code, etc.',
                type: 'access_terminated_error',
            },
        };
        const quota = await fetchKimiQuota(deps(home, stubFetch(jsonResponse(body, 403)).fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('unauthorized');
    });

    it('keeps a 403 with an unreadable/empty body as unauthorized', async () => {
        const home = makeKimiHome({ access_token: 'tok', expires_at: FRESH_EXPIRY });
        const quota = await fetchKimiQuota(deps(home, stubFetch(jsonResponse({}, 403)).fetch));

        expect(quota.metadata?.failureKind).toBe('unauthorized');
    });

    it('classifies 429 and carries Retry-After into retryAtMs', async () => {
        const home = makeKimiHome({ access_token: 'tok', expires_at: FRESH_EXPIRY });
        const stub = stubFetch(jsonResponse({}, 429, { 'retry-after': '30' }));

        const quota = await fetchKimiQuota(deps(home, stub.fetch));

        expect(quota.metadata?.failureKind).toBe('rate-limited');
        expect(quota.metadata?.retryAtMs).toBe(NOW + 30_000);
    });

    it('classifies 5xx as a server failure', async () => {
        const home = makeKimiHome({ access_token: 'tok', expires_at: FRESH_EXPIRY });
        const quota = await fetchKimiQuota(deps(home, stubFetch(jsonResponse({}, 503)).fetch));

        expect(quota.metadata?.failureKind).toBe('server');
    });

    it('surfaces network failures without throwing', async () => {
        const home = makeKimiHome({ access_token: 'tok', expires_at: FRESH_EXPIRY });
        const quota = await fetchKimiQuota(deps(home, stubFetch(new Error('ECONNREFUSED')).fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('network');
        expect(quota.error).toContain('ECONNREFUSED');
    });

    it('reports a parse failure when the payload carries no usable window', async () => {
        const home = makeKimiHome({ access_token: 'tok', expires_at: FRESH_EXPIRY });
        const quota = await fetchKimiQuota(deps(home, stubFetch(jsonResponse({ limits: [] })).fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('parse');
    });

    it('rejects a malformed credentials file', async () => {
        const home = makeKimiHome('{ not json');
        const quota = await fetchKimiQuota(deps(home, stubFetch(jsonResponse({})).fetch));

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('parse');
    });

    it('still queries when the file records no expiry, letting the server decide', async () => {
        const home = makeKimiHome({ access_token: 'tok' });
        const stub = stubFetch(jsonResponse({ usage: { limit: 4, used: 1 } }));

        const quota = await fetchKimiQuota(deps(home, stub.fetch));

        expect(stub.calls).toHaveLength(1);
        expect(quota.status).toBe('ok');
    });
});
