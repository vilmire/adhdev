import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchCursorQuota } from '../../src/quota/fetchers/cursor';
import type {
    QuotaChildProcess,
    QuotaFetch,
    QuotaFetchResponse,
    QuotaSpawn,
} from '../../src/quota/fetchers/deps';
import { MONTHLY_WINDOW_MINUTES } from '../../src/quota/types';

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const RESET_AT = Date.UTC(2026, 8, 1, 0, 0, 0);
const tempDirs: string[] = [];

function makeConfig(auth: unknown | null): string {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-cursor-quota-'));
    tempDirs.push(root);
    if (auth !== null) {
        const dir = join(root, 'cursor');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'auth.json'), JSON.stringify(auth));
    }
    return root;
}

function jsonResponse(body: unknown, status = 200): QuotaFetchResponse {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

function stubFetch(responses: QuotaFetchResponse[]): {
    fetch: QuotaFetch;
    calls: Array<{ url: string; init: Parameters<QuotaFetch>[1] }>;
} {
    const calls: Array<{ url: string; init: Parameters<QuotaFetch>[1] }> = [];
    const fetch: QuotaFetch = async (url, init) => {
        calls.push({ url, init });
        const response = responses.shift();
        if (!response) throw new Error(`Unexpected fetch: ${url}`);
        return response;
    };
    return { fetch, calls };
}

function deps(
    configHome: string,
    fetch: QuotaFetch,
    env: NodeJS.ProcessEnv = {},
    spawn?: QuotaSpawn,
) {
    return {
        fetch,
        now: () => NOW,
        env: {
            ADHDEV_CURSOR_PLATFORM: 'linux',
            XDG_CONFIG_HOME: configHome,
            CURSOR_CLI_VERSION: '2026.08.11-e8db854',
            ...env,
        } as NodeJS.ProcessEnv,
        ...(spawn ? { spawn } : {}),
    };
}

function keychainMissingSpawn(): QuotaSpawn {
    return () => {
        const child: QuotaChildProcess = {
            stdin: { write: () => {}, end: () => {} },
            stdout: { on: () => {} },
            stderr: { on: () => {} },
            on: (event, listener) => {
                if (event === 'exit') queueMicrotask(() => listener(44));
            },
            kill: () => {},
        };
        return child;
    };
}

function fixedUsage() {
    return {
        billing_cycle_start: String(Date.UTC(2026, 7, 1)),
        billing_cycle_end: String(RESET_AT),
        plan_usage: { total_spend: 1200, limit: 2000 },
        spend_limit_usage: {
            individual_used: 1234,
            individual_limit: 5000,
            limit_type: 'individual',
        },
        enabled: true,
        display_message: 'On-demand usage',
    };
}

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

describe('fetchCursorQuota', () => {
    it('maps current-period spend and reset into a monthly ProviderQuota window', async () => {
        const config = makeConfig({ accessToken: 'cursor-access-token' });
        const stub = stubFetch([jsonResponse(fixedUsage())]);

        const quota = await fetchCursorQuota(deps(config, stub.fetch));

        expect(quota).toMatchObject({
            provider: 'cursor-cli',
            status: 'ok',
            error: null,
            session: null,
            weekly: null,
            monthly: {
                usedPercent: 24.68,
                windowMinutes: MONTHLY_WINDOW_MINUTES,
                resetsAt: RESET_AT,
            },
            metadata: {
                source: 'oauth',
                cursorUsage: {
                    kind: 'fixed',
                    usedDollars: 12.34,
                    limitDollars: 50,
                    enabled: true,
                    displayMessage: 'On-demand usage',
                },
            },
        });
        expect(stub.calls).toHaveLength(1);
        expect(stub.calls[0]?.url).toBe(
            'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
        );
        expect(stub.calls[0]?.init).toMatchObject({ method: 'POST', body: '{}' });
        expect(stub.calls[0]?.init?.headers).toMatchObject({
            authorization: 'Bearer cursor-access-token',
            'x-cursor-client-type': 'cli',
            'x-cursor-client-version': 'cli-2026.08.11-e8db854',
        });
    });

    it('falls back to GetHardLimit when individual_limit is absent', async () => {
        const config = makeConfig({ access_token: 'cursor-access-token' });
        const current = fixedUsage();
        delete (current.spend_limit_usage as Record<string, unknown>).individual_limit;
        const stub = stubFetch([
            jsonResponse(current),
            jsonResponse({ hard_limit: 40, no_usage_based_allowed: false }),
        ]);

        const quota = await fetchCursorQuota(deps(config, stub.fetch));

        expect(stub.calls.map((call) => call.url.split('/').at(-1))).toEqual([
            'GetCurrentPeriodUsage',
            'GetHardLimit',
        ]);
        expect(quota.metadata?.cursorUsage).toMatchObject({
            kind: 'fixed', usedDollars: 12.34, limitDollars: 40,
        });
        expect(quota.monthly?.usedPercent).toBeCloseTo(30.85);
    });

    it('mirrors unlimited and disabled hard-limit kinds', async () => {
        for (const [hard, expected] of [
            [{ hardLimit: 2_147_483_647, noUsageBasedAllowed: false }, 'unlimited'],
            [{ hardLimit: 100, noUsageBasedAllowed: true }, 'disabled'],
        ] as const) {
            const config = makeConfig({ accessToken: 'cursor-access-token' });
            const current = fixedUsage();
            delete (current.spend_limit_usage as Record<string, unknown>).individual_limit;
            const stub = stubFetch([jsonResponse(current), jsonResponse(hard)]);

            const quota = await fetchCursorQuota(deps(config, stub.fetch));

            expect(quota.status).toBe('ok');
            expect(quota.monthly).toBeNull();
            expect(quota.metadata?.cursorUsage?.kind).toBe(expected);
        }
    });

    it('reports missing-credentials without touching the network', async () => {
        const config = makeConfig(null);
        const stub = stubFetch([]);

        const quota = await fetchCursorQuota(deps(config, stub.fetch));

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('missing-credentials');
        expect(stub.calls).toEqual([]);
    });

    it('reads the file store before the macOS keychain', async () => {
        const home = makeConfig(null);
        const authDir = join(home, '.cursor');
        mkdirSync(authDir, { recursive: true });
        writeFileSync(join(authDir, 'auth.json'), JSON.stringify({ accessToken: 'file-token' }));
        const stub = stubFetch([jsonResponse(fixedUsage())]);
        const forbiddenSpawn: QuotaSpawn = () => { throw new Error('keychain must not be read'); };

        const quota = await fetchCursorQuota(deps(home, stub.fetch, {
            ADHDEV_CURSOR_PLATFORM: 'darwin',
            HOME: home,
        }, forbiddenSpawn));

        expect(quota.status).toBe('ok');
        expect(stub.calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer file-token' });
    });

    it('reads the Windows APPDATA credential path', async () => {
        const appData = makeConfig(null);
        const authDir = join(appData, 'Cursor');
        mkdirSync(authDir, { recursive: true });
        writeFileSync(join(authDir, 'auth.json'), JSON.stringify({ accessToken: 'windows-token' }));
        const stub = stubFetch([jsonResponse(fixedUsage())]);

        const quota = await fetchCursorQuota(deps(appData, stub.fetch, {
            ADHDEV_CURSOR_PLATFORM: 'win32',
            APPDATA: appData,
        }));

        expect(quota.status).toBe('ok');
        expect(stub.calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer windows-token' });
    });

    it('treats an absent or locked macOS keychain item as missing-credentials', async () => {
        const home = makeConfig(null);
        const stub = stubFetch([]);

        const quota = await fetchCursorQuota(deps(home, stub.fetch, {
            ADHDEV_CURSOR_PLATFORM: 'darwin',
            HOME: home,
        }, keychainMissingSpawn()));

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('missing-credentials');
        expect(stub.calls).toEqual([]);
    });

    it('treats a missing plan_usage as benign unavailable, not a quota error', async () => {
        const config = makeConfig({ accessToken: 'cursor-access-token' });
        const stub = stubFetch([jsonResponse({
            billing_cycle_end: String(RESET_AT),
            spend_limit_usage: { individual_used: 0 },
            enabled: true,
        })]);

        const quota = await fetchCursorQuota(deps(config, stub.fetch));

        expect(quota.status).toBe('unavailable');
        expect(quota.error).toBe('Usage details are not available for this plan in the CLI.');
        expect(quota.metadata?.failureKind).toBe('no-data');
        expect(quota.metadata?.cursorUsage?.kind).toBe('unavailable');
        expect(stub.calls).toHaveLength(1);
    });

    it('uses CURSOR_API_KEY only as an in-memory exchange and honours the endpoint override', async () => {
        const config = makeConfig(null);
        const stub = stubFetch([
            jsonResponse({ accessToken: 'exchanged-access-token', refreshToken: 'ignored' }),
            jsonResponse(fixedUsage()),
        ]);

        const quota = await fetchCursorQuota(deps(config, stub.fetch, {
            CURSOR_API_KEY: 'cursor-api-key',
            CURSOR_API_ENDPOINT: 'https://cursor.test/',
        }));

        expect(quota.status).toBe('ok');
        expect(stub.calls.map((call) => call.url)).toEqual([
            'https://cursor.test/auth/exchange_user_api_key',
            'https://cursor.test/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
        ]);
        expect(stub.calls[0]?.init?.headers).toMatchObject({ Authorization: 'Bearer cursor-api-key' });
        expect(stub.calls[1]?.init?.headers).toMatchObject({ authorization: 'Bearer exchanged-access-token' });
    });
});
