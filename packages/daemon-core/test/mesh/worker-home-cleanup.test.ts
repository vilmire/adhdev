import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, symlinkSync, lutimesSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import { workerPrivateHomePath } from '../../src/mesh/worker-private-home.js';
import {
    liveWorkerHomes,
    removeWorkerHomeDir,
    subscribeWorkerHomeCleanup,
    sweepStaleWorkerHomes,
    WORKER_HOME_SWEEP_MAX_AGE_MS,
} from '../../src/mesh/worker-home-cleanup.js';

let root = '';
let base = '';
let realHome = '';
const NOW = Date.now();
const HOUR = 3_600_000;

function makeHome(type: string, ws: string, sid: string, ageMs: number): string {
    const home = workerPrivateHomePath(type, ws, sid, base);
    mkdirSync(path.join(home, '.cursor'), { recursive: true });
    const f = path.join(home, '.cursor', 'cache.bin');
    writeFileSync(f, 'x');
    symlinkSync(path.join(realHome, 'auth.json'), path.join(home, 'auth.json'));
    const t = new Date(NOW - ageMs);
    for (const p of [f, path.join(home, '.cursor'), home]) utimesSync(p, t, t);
    lutimesSync(path.join(home, 'auth.json'), t, t);
    utimesSync(home, t, t);
    return home;
}

beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'adhdev-wh-test-'));
    base = path.join(root, 'adhdev-worker-home');
    realHome = path.join(root, 'real-home');
    mkdirSync(base, { recursive: true });
    mkdirSync(realHome, { recursive: true });
    writeFileSync(path.join(realHome, 'auth.json'), 'secret');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('worker home sweep', () => {
    it('removes only old, non-live homes; keeps live and recent ones; never touches symlink targets', () => {
        const old = makeHome('cursor-cli', '/w/a', 's-old', 5 * HOUR);
        const live = makeHome('cursor-cli', '/w/b', 's-live', 9 * HOUR);
        const recent = makeHome('codex-cli', '/w/c', 's-recent', 1 * HOUR);
        const live_set = liveWorkerHomes([{ type: 'cursor-cli', workspace: '/w/b', instanceId: 's-live' }], base);
        expect(live_set.has(live)).toBe(true);

        const r = sweepStaleWorkerHomes({ baseDir: base, liveHomes: live_set, nowMs: NOW, maxAgeMs: WORKER_HOME_SWEEP_MAX_AGE_MS });
        expect(r.removed).toEqual([path.basename(old)]);
        expect(r.keptLive).toBe(1);
        expect(r.keptRecent).toBe(1);
        expect(existsSync(old)).toBe(false);
        expect(existsSync(live)).toBe(true);
        expect(existsSync(recent)).toBe(true);
        expect(existsSync(path.join(realHome, 'auth.json'))).toBe(true);
    });

    it('a home whose newest file is old is removed (sweep far in the future) and the link target survives', () => {
        const old = makeHome('cursor-cli', '/w/a', 's-old', 5 * HOUR);
        const r = sweepStaleWorkerHomes({ baseDir: base, liveHomes: new Set(), nowMs: NOW + 10 * HOUR });
        expect(r.removed).toEqual([path.basename(old)]);
        expect(existsSync(old)).toBe(false);
        expect(readSafe(path.join(realHome, 'auth.json'))).toBe('secret');
    });

    it('ignores entries that are not home-shaped directories', () => {
        mkdirSync(path.join(base, 'notes'));
        writeFileSync(path.join(base, 'stray-0123456789abcdef'), 'file');
        const r = sweepStaleWorkerHomes({ baseDir: base, liveHomes: new Set(), nowMs: NOW + 100 * HOUR });
        expect(r.removed).toEqual([]);
        expect(existsSync(path.join(base, 'notes'))).toBe(true);
        expect(existsSync(path.join(base, 'stray-0123456789abcdef'))).toBe(true);
    });

    it('removeWorkerHomeDir refuses paths outside the base dir and symlinked entries', () => {
        const outside = path.join(root, 'outside-0123456789abcdef');
        mkdirSync(outside);
        expect(removeWorkerHomeDir(outside, base)).toBe(false);
        expect(existsSync(outside)).toBe(true);
        const link = path.join(base, 'cursor-cli-0123456789abcdef');
        symlinkSync(outside, link);
        expect(removeWorkerHomeDir(link, base)).toBe(false);
        expect(existsSync(outside)).toBe(true);
    });
});

describe('worker home removal at session end', () => {
    it('terminated removes that session\'s own home only (not on daemon_shutdown)', () => {
        const mine = makeHome('cursor-cli', '/w/a', 's1', 0);
        const other = makeHome('cursor-cli', '/w/a', 's2', 0);
        const bus = createSessionLifecycleBus();
        subscribeWorkerHomeCleanup(bus, base);
        const ev = (sessionId: string, cause: string) => ({
            kind: 'terminated', sessionId, at: NOW, cause, providerType: 'cursor-cli', workspace: '/w/a', runtimeSettings: {},
        }) as any;
        bus.emit(ev('s1', 'daemon_shutdown'));
        expect(existsSync(mine)).toBe(true);
        bus.emit(ev('s1', 'stopped'));
        expect(existsSync(mine)).toBe(false);
        expect(existsSync(other)).toBe(true);
    });
});

function readSafe(p: string): string { return readFileSync(p, 'utf8'); }
