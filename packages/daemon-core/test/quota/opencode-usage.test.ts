import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
    OPENCODE_USAGE_DAYS,
    fetchOpencodeUsage,
    parseDollars,
    parseOpencodeStats,
    parseTokenCount,
} from '../../src/quota/fetchers/opencode.js';

// opencode usage fetcher (M-QUOTA-EXPAND, owner request 2026-08-10).
// opencode is a BYO-provider router with no account rate limit, so the entry
// is USAGE-shaped: absolute tokens/cost over a trailing window from
// `opencode stats --days N`, parsed from its box-drawing tables.

const SAMPLE = `
┌────────────────────────────────────────────────────────┐
│                       OVERVIEW                         │
├────────────────────────────────────────────────────────┤
│Sessions                                             62 │
│Messages                                            156 │
│Days                                                135 │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                    COST & TOKENS                       │
├────────────────────────────────────────────────────────┤
│Total Cost                                        $1,234.56 │
│Avg Cost/Day                                      $0.00 │
│Input                                            181.5K │
│Output                                             7.4K │
│Cache Read                                       610.8K │
│Cache Write                                      113.1K │
└────────────────────────────────────────────────────────┘
`;

describe('parse helpers', () => {
    it('parses K/M/B token counts and plain integers', () => {
        expect(parseTokenCount('181.5K')).toBe(181_500);
        expect(parseTokenCount('7.4M')).toBe(7_400_000);
        expect(parseTokenCount('2B')).toBe(2_000_000_000);
        expect(parseTokenCount('62')).toBe(62);
        expect(parseTokenCount('1,024')).toBe(1024);
        expect(parseTokenCount('garbage')).toBeNull();
    });

    it('parses dollar amounts with separators', () => {
        expect(parseDollars('$0.00')).toBe(0);
        expect(parseDollars('$1,234.56')).toBe(1234.56);
        expect(parseDollars('12.34')).toBeNull(); // no $ — not a cost cell
    });
});

describe('parseOpencodeStats', () => {
    it('extracts the usage block from the box tables', () => {
        const usage = parseOpencodeStats(SAMPLE, 7);
        expect(usage).not.toBeNull();
        expect(usage!.days).toBe(7);
        expect(usage!.totalCostUsd).toBe(1234.56);
        expect(usage!.inputTokens).toBe(181_500);
        expect(usage!.outputTokens).toBe(7_400);
        expect(usage!.cacheReadTokens).toBe(610_800);
        expect(usage!.cacheWriteTokens).toBe(113_100);
        expect(usage!.sessions).toBe(62);
    });

    it('fails closed on an unknown layout (anchor labels missing)', () => {
        expect(parseOpencodeStats('completely different output', 7)).toBeNull();
        expect(parseOpencodeStats('│Unrelated   1 │', 7)).toBeNull();
    });
});

describe('fetchOpencodeUsage', () => {
    function fakeChild() {
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { write() {}, end() {} };
        child.kill = () => {};
        return child;
    }

    it('reports a usage-shaped OK snapshot on a clean run', async () => {
        const child = fakeChild();
        const promise = fetchOpencodeUsage({
            spawn: (cmd, args) => {
                expect(cmd).toBe('opencode');
                expect(args).toEqual(['stats', '--days', String(OPENCODE_USAGE_DAYS)]);
                return child;
            },
            now: () => 42,
            env: {} as NodeJS.ProcessEnv,
        });
        child.stdout.emit('data', SAMPLE);
        child.emit('exit', 0);
        const quota = await promise;
        expect(quota.status).toBe('ok');
        expect(quota.session).toBeNull();
        expect(quota.weekly).toBeNull();
        expect(quota.metadata?.usage?.totalCostUsd).toBe(1234.56);
        expect(quota.metadata?.usage?.days).toBe(OPENCODE_USAGE_DAYS);
        expect(quota.updatedAt).toBe(42);
    });

    it('spawn failure → cli-unavailable', async () => {
        const quota = await fetchOpencodeUsage({
            spawn: () => { throw new Error('ENOENT'); },
            env: {} as NodeJS.ProcessEnv,
        });
        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('cli-unavailable');
    });

    it('nonzero exit → error with stderr excerpt', async () => {
        const child = fakeChild();
        const promise = fetchOpencodeUsage({ spawn: () => child, env: {} as NodeJS.ProcessEnv });
        child.stderr.emit('data', 'db locked');
        child.emit('exit', 3);
        const quota = await promise;
        expect(quota.status).toBe('error');
        expect(quota.error).toContain('exited 3');
        expect(quota.error).toContain('db locked');
    });

    it('unknown layout → parse failure (fail closed, no wrong numbers)', async () => {
        const child = fakeChild();
        const promise = fetchOpencodeUsage({ spawn: () => child, env: {} as NodeJS.ProcessEnv });
        child.stdout.emit('data', 'BRAND NEW LAYOUT v9');
        child.emit('exit', 0);
        const quota = await promise;
        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('parse');
    });

    it('honors ADHDEV_OPENCODE_BIN', async () => {
        const child = fakeChild();
        const promise = fetchOpencodeUsage({
            spawn: (cmd) => { expect(cmd).toBe('/custom/opencode'); return child; },
            env: { ADHDEV_OPENCODE_BIN: '/custom/opencode' } as NodeJS.ProcessEnv,
        });
        child.stdout.emit('data', SAMPLE);
        child.emit('exit', 0);
        await promise;
    });
});
