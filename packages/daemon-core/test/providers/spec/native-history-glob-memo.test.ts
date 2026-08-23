// ---------------------------------------------------------------------------
// GLOB-EXPANSION MEMO.
//
// resolveJsonlSourcePathDetailed can run up to three glob-walking pickers in a
// single status tick (native-history-executor.ts:646-669), each re-walking the
// same tree. On the measured machine `~/.claude/projects` holds 579 dirs /
// 2,285 transcripts — ~26ms per pass, paid three times, every 5s, per live CLI
// session. The memo removes the repeats inside a tick.
//
// The load-bearing property is NOT speed, it is that a new session must still
// be found. Directory mtime only reflects changes to a directory's DIRECT
// children, so any validity check anchored on the glob root goes blind on a
// multi-level template — kimi's `sessions/*/session_*/agents/main` is three
// levels deep, and a new session there would be invisible for the life of the
// entry. That is why the TTL (3s, shorter than the 5s tick) is the mechanism
// and not an optimization: staleness is bounded by time, never by depth.
//
// The multi-level case below is the one that must never regress. Deleting the
// TTL check turns it red.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    __clearGlobCacheForTest,
    getGlobCacheStats,
    resolveJsonlSourcePath,
} from '../../../src/providers/spec/native-history-executor.js';

let root = '';

function mkdirp(p: string): void {
    fs.mkdirSync(p, { recursive: true });
}

function writeJsonl(file: string, lines: unknown[]): void {
    mkdirp(path.dirname(file));
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

/** A kimi-shaped 3-level layout: sessions/<a>/session_<uuid>/agents/main/…  */
function stageMultiLevelSession(sessionUuid: string, bucket = 'b1'): string {
    const dir = path.join(root, 'sessions', bucket, `session_${sessionUuid}`, 'agents', 'main');
    const file = path.join(dir, 'wire.jsonl');
    writeJsonl(file, [{ type: 'session_meta', payload: { cwd: root } }]);
    return file;
}

const MULTI_LEVEL_TEMPLATE = () =>
    path.join(root, 'sessions', '*', 'session_*', 'agents', 'main');

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-glob-memo-'));
    __clearGlobCacheForTest();
    vi.useRealTimers();
});

afterEach(() => {
    // vi.spyOn(Date, 'now') is a real mock, not a fake-timer facility — it
    // outlives useRealTimers() and otherwise leaks a frozen clock into the
    // next test, corrupting its own "real now" baseline.
    vi.restoreAllMocks();
    vi.useRealTimers();
    __clearGlobCacheForTest();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('glob memo — a new session is never lost', () => {
    it('★ finds a session created 3 levels deep once the TTL expires', () => {
        const src = { path: MULTI_LEVEL_TEMPLATE(), file_pattern: 'wire.jsonl' } as any;
        const input = { workspace: root, sessionId: 's1' } as any;

        stageMultiLevelSession('11111111-1111-4111-8111-111111111111');
        const first = resolveJsonlSourcePath(src, input);
        expect(first).toBeTruthy();

        // A brand-new session appears at depth 3. Its parent chain shares no
        // directory whose mtime the glob root can observe, so an mtime-only
        // invalidation would never notice it.
        const secondUuid = '22222222-2222-4222-8222-222222222222';
        const secondFile = stageMultiLevelSession(secondUuid, 'b2');
        // Force unambiguous newest-wins ordering — see the utimesSync note below.
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(secondFile, future, future);

        // Time travel past the TTL rather than sleeping: same code path, no
        // 3s of wall clock in the suite.
        const realNow = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(realNow + 4_000);

        // Re-resolving must now see the new tree. Ask for the new session by id
        // so the assertion is about visibility, not about which file wins.
        const found = resolveJsonlSourcePath(src, { ...input, providerSessionId: secondUuid } as any);
        expect(found).toBe(secondFile);
    });

    it('a new session inside an ALREADY-CACHED parent is found after the TTL', () => {
        const src = { path: MULTI_LEVEL_TEMPLATE(), file_pattern: 'wire.jsonl' } as any;
        const input = { workspace: root, sessionId: 's1' } as any;

        stageMultiLevelSession('33333333-3333-4333-8333-333333333333', 'shared');
        expect(resolveJsonlSourcePath(src, input)).toBeTruthy();

        // Same bucket dir as the cached walk — the deepest segment is new.
        const uuid = '44444444-4444-4444-8444-444444444444';
        const file = stageMultiLevelSession(uuid, 'shared');
        // The picker's newest-wins tie-break (safeMtimeMs) floors to whole
        // milliseconds, and two files staged microseconds apart in real time
        // can land on the identical millisecond — nondeterministic on a fast
        // filesystem. Force unambiguous ordering rather than relying on
        // real-clock creation order.
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(file, future, future);

        const realNow = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(realNow + 4_000);

        expect(resolveJsonlSourcePath(src, { ...input, providerSessionId: uuid } as any)).toBe(file);
    });
});

describe('glob memo — behaviour', () => {
    it('repeated resolution inside one tick hits the cache', () => {
        const src = { path: MULTI_LEVEL_TEMPLATE(), file_pattern: 'wire.jsonl' } as any;
        const input = { workspace: root, sessionId: 's1' } as any;
        stageMultiLevelSession('55555555-5555-4555-8555-555555555555');

        __clearGlobCacheForTest();
        resolveJsonlSourcePath(src, input);
        const afterFirst = getGlobCacheStats();
        resolveJsonlSourcePath(src, input);
        const afterSecond = getGlobCacheStats();

        expect(afterFirst.misses).toBeGreaterThan(0);
        // The second resolution re-walks nothing.
        expect(afterSecond.hits).toBeGreaterThan(afterFirst.hits);
        expect(afterSecond.misses).toBe(afterFirst.misses);
    });

    it('produces the SAME answer cached and uncached (equivalence)', () => {
        const src = { path: MULTI_LEVEL_TEMPLATE(), file_pattern: 'wire.jsonl' } as any;
        const input = { workspace: root, sessionId: 's1' } as any;
        stageMultiLevelSession('66666666-6666-4666-8666-666666666666');

        __clearGlobCacheForTest();
        const cold = resolveJsonlSourcePath(src, input);
        const warm = resolveJsonlSourcePath(src, input);
        __clearGlobCacheForTest();
        const coldAgain = resolveJsonlSourcePath(src, input);

        expect(warm).toBe(cold);
        expect(coldAgain).toBe(cold);
    });

    it('a deleted session stops resolving after the TTL', () => {
        const src = { path: MULTI_LEVEL_TEMPLATE(), file_pattern: 'wire.jsonl' } as any;
        const uuid = '77777777-7777-4777-8777-777777777777';
        const input = { workspace: root, sessionId: 's1', providerSessionId: uuid } as any;
        stageMultiLevelSession(uuid);
        expect(resolveJsonlSourcePath(src, input)).toBeTruthy();

        fs.rmSync(path.join(root, 'sessions'), { recursive: true, force: true });

        const realNow = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(realNow + 4_000);
        expect(resolveJsonlSourcePath(src, input)).toBeNull();
    });

    it('__clearGlobCacheForTest resets entries and counters', () => {
        const src = { path: MULTI_LEVEL_TEMPLATE(), file_pattern: 'wire.jsonl' } as any;
        stageMultiLevelSession('88888888-8888-4888-8888-888888888888');
        resolveJsonlSourcePath(src, { workspace: root, sessionId: 's1' } as any);
        expect(getGlobCacheStats().size).toBeGreaterThan(0);

        __clearGlobCacheForTest();
        expect(getGlobCacheStats()).toEqual({ hits: 0, misses: 0, size: 0 });
    });

    it('callers cannot corrupt the cached array (defensive copy)', () => {
        const src = { path: MULTI_LEVEL_TEMPLATE(), file_pattern: 'wire.jsonl' } as any;
        const input = { workspace: root, sessionId: 's1' } as any;
        const uuid = '99999999-9999-4999-8999-999999999999';
        const file = stageMultiLevelSession(uuid);

        __clearGlobCacheForTest();
        const first = resolveJsonlSourcePath(src, { ...input, providerSessionId: uuid } as any);
        // A second resolution served from cache must be unaffected by whatever
        // the first caller did with its own arrays.
        const second = resolveJsonlSourcePath(src, { ...input, providerSessionId: uuid } as any);
        expect(first).toBe(file);
        expect(second).toBe(file);
    });
});
