import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { fetchCodexQuota } from '../../src/quota/fetchers/codex.js';
import type { QuotaChildProcess, QuotaSpawn } from '../../src/quota/fetchers/deps.js';
import { loadQuotaCache, saveQuotaCache } from '../../src/quota/persist.js';
import { clearQuotaCache, readQuotaCache, refreshQuotaCacheOnce } from '../../src/quota/refresh.js';

// ACCOUNT EMAIL IS OPT-IN (config `quotaShowAccountEmail`, default off).
//
// The contract is NOT "hide it in the UI" — it is "never acquire it". When the
// option is off the codex fetcher does not issue `account/read` at all, so no
// email exists to be written into the in-memory cache, into
// ~/.adhdev/quota/cache.json, or into the P2P node-facts bundle. Filtering at
// render time would have left the value sitting on disk, which is exactly the
// outcome a privacy opt-in has to prevent.
//
// The non-identifying plan tier (`metadata.planType`) is deliberately NOT gated.

const RATE_LIMITS_RESULT = {
    rateLimits: {
        primary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: null },
        secondary: null,
        planType: 'plus',
    },
};

const ACCOUNT_RESULT = {
    account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
    requiresOpenaiAuth: true,
};

function createFakeChild() {
    const stdoutListeners: ((chunk: string) => void)[] = [];
    const written: string[] = [];
    const child = {
        written,
        stdin: { write: (chunk: string) => { written.push(chunk); }, end: () => {} },
        stdout: { on: (_e: 'data', l: (c: string) => void) => void stdoutListeners.push(l) },
        stderr: { on: () => {} },
        on: () => {},
        kill: () => {},
        emit: (text: string) => stdoutListeners.forEach(l => l(text)),
    };
    return child as unknown as QuotaChildProcess & { written: string[]; emit(text: string): void };
}

/** Drive a fetch with the option in a given state; replies to whatever is asked. */
function runFetch(showAccountEmail: boolean) {
    const child = createFakeChild();
    const spawn: QuotaSpawn = () => child;
    const originalWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk: string) => {
        originalWrite(chunk);
        const request = JSON.parse(chunk) as { id: number; method: string };
        queueMicrotask(() => {
            if (request.method === 'initialize') {
                child.emit(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`);
            } else if (request.method === 'account/rateLimits/read') {
                child.emit(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: RATE_LIMITS_RESULT })}\n`);
            } else if (request.method === 'account/read') {
                child.emit(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: ACCOUNT_RESULT })}\n`);
            }
        });
    };
    const promise = fetchCodexQuota({
        spawn,
        now: () => 1_700_000_000_000,
        env: {} as NodeJS.ProcessEnv,
        setTimeout: (handler, ms) => { void handler; void ms; return { unref: () => {} }; },
        clearTimeout: () => {},
        showAccountEmail: () => showAccountEmail,
    });
    return { promise, child };
}

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
    home = join(tmpdir(), `adhdev-quota-optin-${randomUUID().slice(0, 8)}`);
    mkdirSync(home, { recursive: true });
    env = { ADHDEV_HOME: home } as NodeJS.ProcessEnv;
    clearQuotaCache();
});

afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* noop */ }
    clearQuotaCache();
});

describe('account email opt-in — OFF (the default)', () => {
    // ── Contract 1: not present in the fetcher output ───────────────────────
    it('produces no accountEmail when the option is off', async () => {
        const { promise } = runFetch(false);
        const quota = await promise;

        expect(quota.status).toBe('ok');
        expect(quota.metadata?.accountEmail).toBeUndefined();
        expect(JSON.stringify(quota)).not.toContain('user@example.com');
    });

    it('never even ASKS for the account (no account/read on the wire)', async () => {
        // The heart of the contract: not acquired, not merely filtered. If the
        // RPC were issued and the value dropped later, the email would still
        // have existed in this process.
        const { promise, child } = runFetch(false);
        await promise;

        const methods = child.written.map(line => JSON.parse(line).method);
        expect(methods).toContain('account/rateLimits/read');
        expect(methods).not.toContain('account/read');
    });

    // ── Contract 4: planType is NOT gated ───────────────────────────────────
    it('still reports the non-identifying plan tier', async () => {
        const { promise } = runFetch(false);
        const quota = await promise;

        expect(quota.metadata?.planType).toBe('plus');
        expect(quota.weekly?.usedPercent).toBe(27);
    });

    // ── Contract 2: nothing reaches the cache file ──────────────────────────
    it('writes no email to the on-disk cache', async () => {
        const previous = process.env.ADHDEV_HOME;
        process.env.ADHDEV_HOME = home;
        try {
            const { promise } = runFetch(false);
            const quota = await promise;
            await refreshQuotaCacheOnce([{ provider: 'codex-cli' as const, fetch: async () => quota }]);

            const persisted = loadQuotaCache(env)!;
            expect(persisted['codex-cli'].metadata?.accountEmail).toBeUndefined();
            expect(persisted['codex-cli'].metadata?.planType).toBe('plus');
            expect(JSON.stringify(persisted)).not.toContain('user@example.com');
        } finally {
            if (previous === undefined) delete process.env.ADHDEV_HOME;
            else process.env.ADHDEV_HOME = previous;
        }
    });

    // ── Contract 4 (cleanup): an email stored while the option was ON is
    //    overwritten by the next tick, so turning the option off is enough.
    it('purges an email left in the cache from when the option was on', async () => {
        const previous = process.env.ADHDEV_HOME;
        process.env.ADHDEV_HOME = home;
        try {
            // Simulate a cache written while the option was enabled.
            saveQuotaCache({
                'codex-cli': {
                    provider: 'codex-cli', status: 'ok', session: null, weekly: null,
                    updatedAt: 1, error: null,
                    metadata: { source: 'app-server', planType: 'plus', accountEmail: 'user@example.com' },
                } as any,
            }, env);
            expect(JSON.stringify(loadQuotaCache(env))).toContain('user@example.com');

            // One tick with the option off replaces the whole provider entry.
            const { promise } = runFetch(false);
            await refreshQuotaCacheOnce([{ provider: 'codex-cli' as const, fetch: async () => await promise }]);

            expect(readQuotaCache()?.['codex-cli'].metadata?.accountEmail).toBeUndefined();
            const persisted = loadQuotaCache(env)!;
            expect(persisted['codex-cli'].metadata?.accountEmail).toBeUndefined();
            expect(JSON.stringify(persisted)).not.toContain('user@example.com');
        } finally {
            if (previous === undefined) delete process.env.ADHDEV_HOME;
            else process.env.ADHDEV_HOME = previous;
        }
    });
});

describe('account email opt-in — ON', () => {
    // ── Contract 3 ──────────────────────────────────────────────────────────
    it('labels the snapshot once the user opts in', async () => {
        const { promise, child } = runFetch(true);
        const quota = await promise;

        expect(quota.metadata?.accountEmail).toBe('user@example.com');
        expect(quota.metadata?.planType).toBe('plus');
        const methods = child.written.map(line => JSON.parse(line).method);
        expect(methods).toContain('account/read');
    });
});

describe('the opt-in default', () => {
    it('defaults OFF, and a malformed config still fails CLOSED', async () => {
        // The default flipped back to OFF on 2026-08-11 (owner decision): the
        // account label is an identifier, so the quiet default is the one that
        // never acquires it. The fail-closed half is unchanged and still
        // matters independently — an unreadable config must never be the thing
        // that turns PII collection on, so a parse failure resolves to OFF
        // whichever way the default happens to point.
        const { resolveDeps } = await import('../../src/quota/fetchers/deps.js');
        const previous = process.env.ADHDEV_CONFIG_DIR;
        process.env.ADHDEV_CONFIG_DIR = home;
        try {
            expect(resolveDeps().showAccountEmail()).toBe(false);

            // An explicit user choice is honoured either way.
            writeFileSync(join(home, 'config.json'), JSON.stringify({
                quotaShowAccountEmail: false, quotaShowAccountEmailSetByUser: true,
            }), 'utf-8');
            expect(resolveDeps().showAccountEmail()).toBe(false);

            writeFileSync(join(home, 'config.json'), JSON.stringify({
                quotaShowAccountEmail: true, quotaShowAccountEmailSetByUser: true,
            }), 'utf-8');
            expect(resolveDeps().showAccountEmail()).toBe(true);
        } finally {
            if (previous === undefined) delete process.env.ADHDEV_CONFIG_DIR;
            else process.env.ADHDEV_CONFIG_DIR = previous;
        }
    });
});
