import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireOwnedLock, processStartId } from '../../src/launch-defaults/owned-lock.js';

vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'owned-lock-')); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const plant = (lock: string, record: Record<string, unknown>) => {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'old', acquiredAt: Date.now(), ...record }));
};

describe('acquireOwnedLock process start identity', () => {
    it('records the holder start identity', () => {
        const lock = join(dir, 'a.lock');
        const r = acquireOwnedLock(lock, { processStartId: () => 'darwin-epoch-seconds-v1:1' });
        expect(r.ok && r.owner.startId).toBe('darwin-epoch-seconds-v1:1');
    });

    it('reclaims a live pid whose start identity changed (pid reuse)', () => {
        const lock = join(dir, 'b.lock');
        plant(lock, { startId: 'darwin-epoch-seconds-v1:1' });
        expect(acquireOwnedLock(lock, { processStartId: () => 'darwin-epoch-seconds-v1:2' }).ok).toBe(true);
    });

    it('keeps a live pid whose start identity matches', () => {
        const lock = join(dir, 'c.lock');
        plant(lock, { startId: 'darwin-epoch-seconds-v1:3' });
        expect(acquireOwnedLock(lock, { processStartId: () => 'darwin-epoch-seconds-v1:3' })).toMatchObject({ ok: false, busy: true });
    });

    it('keeps a live pid when start identity is unavailable or the record has none', () => {
        const a = join(dir, 'd.lock'); plant(a, { startId: 'x' });
        expect(acquireOwnedLock(a, { processStartId: () => undefined }).ok).toBe(false);
        const b = join(dir, 'e.lock'); plant(b, {});
        expect(acquireOwnedLock(b, { processStartId: () => 'anything' }).ok).toBe(false);
    });

    it('still honours the opt-in maxAgeMs for receipt-style locks', () => {
        const lock = join(dir, 'f.lock');
        plant(lock, { acquiredAt: 1_000 });
        expect(acquireOwnedLock(lock, { now: () => 40_000, maxAgeMs: 30_000, processStartId: () => undefined }).ok).toBe(true);
        const young = join(dir, 'g.lock'); plant(young, { acquiredAt: 39_000 });
        expect(acquireOwnedLock(young, { now: () => 40_000, maxAgeMs: 30_000, processStartId: () => undefined }).ok).toBe(false);
    });
});


describe('numeric process identity regressions', () => {
    it.skipIf(process.platform === 'win32')('is equal across locale and timezone environments and never reclaims the same PID', () => {
        vi.stubEnv('TZ', 'UTC'); vi.stubEnv('LC_ALL', 'C');
        const first = processStartId(process.pid);
        vi.stubEnv('TZ', 'Asia/Seoul'); vi.stubEnv('LC_ALL', 'ko_KR.UTF-8');
        const second = processStartId(process.pid);
        expect(first).toMatch(/^(darwin-epoch-seconds-v1:\d+|linux-start-ticks-v1:[a-f0-9-]{36}:\d+)$/);
        expect(second).toBe(first);
        const lock = join(dir, 'environment.lock');
        plant(lock, { startId: first });
        expect(acquireOwnedLock(lock).ok).toBe(false);
    });

    it('treats a legacy text identity or a different identity format as unknown', () => {
        for (const [index, startId] of ['Thu Jan  1 00:00:00 1970', 'future-v2:123'].entries()) {
            const lock = join(dir, `legacy-${index}.lock`);
            plant(lock, { startId });
            expect(acquireOwnedLock(lock, { processStartId: () => 'darwin-epoch-seconds-v1:123' }).ok).toBe(false);
        }
    });
});


it('returns unknown without throwing when Windows has no process start identity', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try { expect(processStartId(process.pid)).toBeUndefined(); }
    finally { Object.defineProperty(process, 'platform', { value: original }); }
});


it('reads Linux field 22 after a comm containing spaces and parentheses, combined with boot identity', () => {
    const original = process.platform;
    const boot = '00112233-4455-6677-8899-aabbccddeeff';
    const stat = `42 (worker (task)) S ${[...Array(18).fill('0'), '123456'].join(' ')}`;
    vi.mocked(readFileSync).mockReturnValueOnce(boot).mockReturnValueOnce(stat);
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try { expect(processStartId(42)).toBe(`linux-start-ticks-v1:${boot}:123456`); }
    finally { Object.defineProperty(process, 'platform', { value: original }); }
});

it('treats a failed OS identity probe as unknown', () => {
    const original = process.platform;
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw new Error('probe failed'); });
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try { expect(processStartId(42)).toBeUndefined(); }
    finally { Object.defineProperty(process, 'platform', { value: original }); }
});
