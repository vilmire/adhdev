import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneStaleSuffixSeqscribeDbs, STALE_SUFFIX_DB_MIN_AGE_MS } from '../../src/seqscribe/stale-suffix-db-cleanup.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(files: Record<string, number /* age ms */>): string {
    const dir = mkdtempSync(join(tmpdir(), 'adhdev-stale-suffix-db-'));
    dirs.push(dir);
    for (const [name, ageMs] of Object.entries(files)) {
        const path = join(dir, name);
        writeFileSync(path, 'x');
        const t = (NOW - ageMs) / 1000;
        utimesSync(path, t, t);
    }
    return dir;
}

const SET = (pid: number) => [`seqscribe-standalone-${pid}.db`, `seqscribe-standalone-${pid}.db.lock`, `seqscribe-standalone-${pid}.db-wal`, `seqscribe-standalone-${pid}.db-shm`, `seqscribe-standalone-${pid}.db.lock-journal`];

describe('pruneStaleSuffixSeqscribeDbs', () => {
    it('removes the whole file set of a dead pid older than a day, and only that set', () => {
        const dir = fixture({
            ...Object.fromEntries(SET(17567).map((n) => [n, 3 * DAY])),
            ...Object.fromEntries(SET(30221).map((n) => [n, 2 * DAY])),
        });
        expect(pruneStaleSuffixSeqscribeDbs(dir, NOW, { isPidAlive: () => false })).toBe(10);
        for (const name of [...SET(17567), ...SET(30221)]) expect(existsSync(join(dir, name)), name).toBe(false);
    });

    it('NEVER removes a live pid files, however old', () => {
        const dir = fixture(Object.fromEntries(SET(4242).map((n) => [n, 30 * DAY])));
        expect(pruneStaleSuffixSeqscribeDbs(dir, NOW, { isPidAlive: (pid) => pid === 4242 })).toBe(0);
        for (const name of SET(4242)) expect(existsSync(join(dir, name)), name).toBe(true);
    });

    it('keeps a dead pid set while ANY file of it is younger than the age gate (pid reuse / just-exited run)', () => {
        const files = Object.fromEntries(SET(9001).map((n) => [n, 5 * DAY]));
        files['seqscribe-standalone-9001.db-wal'] = STALE_SUFFIX_DB_MIN_AGE_MS - 60_000;
        const dir = fixture(files);
        expect(pruneStaleSuffixSeqscribeDbs(dir, NOW, { isPidAlive: () => false })).toBe(0);
        for (const name of SET(9001)) expect(existsSync(join(dir, name)), name).toBe(true);
    });

    it('never touches the daemon DB, other suffixes, or unrelated files', () => {
        const keep = [
            'seqscribe.db', 'seqscribe.db-wal', 'seqscribe.db-shm', 'seqscribe.db.lock',
            'seqscribe-preview.db', 'seqscribe-standalone-abc.db', 'seqscribe-standalone-12.db.bak',
            'config.json', 'seqscribe-fleet-secret.json',
        ];
        const dir = fixture(Object.fromEntries(keep.map((n) => [n, 400 * DAY])));
        expect(pruneStaleSuffixSeqscribeDbs(dir, NOW, { isPidAlive: () => false })).toBe(0);
        for (const name of keep) expect(existsSync(join(dir, name)), name).toBe(true);
    });

    it('is safe on a missing directory', () => {
        expect(pruneStaleSuffixSeqscribeDbs(join(tmpdir(), 'adhdev-does-not-exist-xyz'), NOW)).toBe(0);
    });

    it('the default liveness check treats this very process as alive', () => {
        const dir = fixture(Object.fromEntries(SET(process.pid).map((n) => [n, 30 * DAY])));
        expect(pruneStaleSuffixSeqscribeDbs(dir, NOW)).toBe(0);
        expect(existsSync(join(dir, SET(process.pid)[0]!))).toBe(true);
    });
});
