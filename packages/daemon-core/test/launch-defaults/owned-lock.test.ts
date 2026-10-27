import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

    it('still honours opt-in live-owner expiry for callers with external fencing', () => {
        const lock = join(dir, 'f.lock');
        plant(lock, { acquiredAt: 1_000 });
        expect(acquireOwnedLock(lock, { now: () => 40_000, maxAgeMs: 30_000, processStartId: () => undefined }).ok).toBe(true);
        const young = join(dir, 'g.lock'); plant(young, { acquiredAt: 39_000 });
        expect(acquireOwnedLock(young, { now: () => 40_000, maxAgeMs: 30_000, processStartId: () => undefined }).ok).toBe(false);
    });

    it('expires ownerless records at the configured age without expiring a live owner', () => {
        const options = { now: () => 40_000, ownerlessMaxAgeMs: 30_000, processStartId: () => undefined };
        const live = join(dir, 'live.lock'); plant(live, { acquiredAt: 1_000 });
        expect(acquireOwnedLock(live, options)).toMatchObject({ ok: false, busy: true });
        const ownerless = join(dir, 'ownerless.lock'); mkdirSync(ownerless);
        utimesSync(ownerless, new Date(10_001), new Date(10_001));
        expect(acquireOwnedLock(ownerless, options)).toMatchObject({ ok: false, busy: true });
        utimesSync(ownerless, new Date(10_000), new Date(10_000));
        expect(acquireOwnedLock(ownerless, options).ok).toBe(true);
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

describe('acquireOwnedLock orphaned reclaim guard recovery', () => {
    const DEAD = 424242;
    const SID = (n: number) => `darwin-epoch-seconds-v1:${n}`;
    const alive = (pid: number) => pid !== DEAD && pid !== 999_999;
    // An abandoned lock (dead holder) whose reclaim guard was left behind.
    const setup = (name: string, guardRecord: Record<string, unknown> | string | null) => {
        const lock = join(dir, `${name}.lock`);
        mkdirSync(lock);
        const bytes = JSON.stringify({ pid: 999_999, nonce: 'abandoned', acquiredAt: 1 });
        writeFileSync(join(lock, 'owner.json'), bytes);
        mkdirSync(`${lock}.reclaim`);
        if (guardRecord !== null) writeFileSync(join(`${lock}.reclaim`, 'owner.json'),
            typeof guardRecord === 'string' ? guardRecord : JSON.stringify({ acquiredAt: 1, ...guardRecord }));
        return { lock, bytes };
    };
    const opts = { isPidAlive: alive, processStartId: (pid: number) => (pid === process.pid ? SID(1) : SID(50)) };

    it('recovers a guard whose reclaimer pid is dead, preserving unrelated bytes', () => {
        const { lock } = setup('dead', { pid: DEAD, nonce: 'n1', startId: SID(5) });
        const protectedFile = join(dir, 'journal.bin'); writeFileSync(protectedFile, 'JOURNAL-BYTES');
        expect(acquireOwnedLock(lock, opts).ok).toBe(true);
        expect(readFileSync(protectedFile, 'utf8')).toBe('JOURNAL-BYTES');
        expect(existsSync(`${lock}.reclaim`)).toBe(false);
    });

    it('recovers when the reclaimer pid was reused (start identity mismatch)', () => {
        const { lock } = setup('reused', { pid: 4321, nonce: 'n2', startId: SID(5) });
        expect(acquireOwnedLock(lock, opts).ok).toBe(true); // probe(4321) = SID(50) != SID(5)
    });

    it('keeps blocking while the reclaimer is alive with matching identity', () => {
        const { lock } = setup('live', { pid: 4321, nonce: 'n3', startId: SID(50) });
        const r = acquireOwnedLock(lock, opts);
        expect(r).toMatchObject({ ok: false, busy: true });
        expect(!r.ok && r.reason).toContain('write_lock_reclaim_in_progress');
        expect(existsSync(join(`${lock}.reclaim`, 'owner.json'))).toBe(true);
    });

    it('never recovers by age alone: legacy, garbled or unidentified markers fail closed', () => {
        for (const [i, rec] of ([null, '{not json', { pid: 'x' }, { pid: 4321, nonce: 'n' }] as const).entries()) {
            const { lock } = setup(`unk${i}`, rec as never);
            // Live pid without start identity is not proof of death; ancient mtime is irrelevant.
            const old = new Date(1000);
            utimesSync(`${lock}.reclaim`, old, old);
            expect(acquireOwnedLock(lock, { ...opts, now: () => Date.now() + 10 * 3600_000 })).toMatchObject({ ok: false, busy: true });
            expect(existsSync(`${lock}.reclaim`)).toBe(true);
        }
    });

    it('two concurrent recoverers: exactly one wins the guard, replay is safe', () => {
        const { lock } = setup('race', { pid: DEAD, nonce: 'n4', startId: SID(5) });
        // Second recoverer observes the same stale marker, but the first completes between its read and its claim.
        let interleaved = false;
        const racing = {
            ...opts,
            isPidAlive: (pid: number) => {
                if (!interleaved && pid === DEAD) { interleaved = true; acquireOwnedLock(lock, opts); }
                return alive(pid);
            },
        };
        const second = acquireOwnedLock(lock, racing);
        expect(interleaved).toBe(true);
        // The first recoverer took the lock (and holds it); the loser must not steal it.
        expect(second).toMatchObject({ ok: false, busy: true });
        expect(existsSync(join(lock, 'owner.json'))).toBe(true);
        expect(readFileSync(join(lock, 'owner.json'), 'utf8')).not.toContain('abandoned');
        // Replay: nothing left to recover, still no guard residue.
        expect(acquireOwnedLock(lock, opts)).toMatchObject({ ok: false, busy: true });
        expect(existsSync(`${lock}.reclaim`)).toBe(false);
    });
});
