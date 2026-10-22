import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireOwnedLock } from '../../src/launch-defaults/owned-lock.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'owned-lock-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const plant = (lock: string, record: Record<string, unknown>) => {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'old', acquiredAt: Date.now(), ...record }));
};

describe('acquireOwnedLock process start identity', () => {
    it('records the holder start identity', () => {
        const lock = join(dir, 'a.lock');
        const r = acquireOwnedLock(lock, { processStartId: () => 'start-1' });
        expect(r.ok && r.owner.startId).toBe('start-1');
    });

    it('reclaims a live pid whose start identity changed (pid reuse)', () => {
        const lock = join(dir, 'b.lock');
        plant(lock, { startId: 'start-old' });
        expect(acquireOwnedLock(lock, { processStartId: () => 'start-new' }).ok).toBe(true);
    });

    it('keeps a live pid whose start identity matches', () => {
        const lock = join(dir, 'c.lock');
        plant(lock, { startId: 'same' });
        expect(acquireOwnedLock(lock, { processStartId: () => 'same' })).toMatchObject({ ok: false, busy: true });
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
