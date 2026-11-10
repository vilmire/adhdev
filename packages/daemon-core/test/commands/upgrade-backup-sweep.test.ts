import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sweepStaleUpgradeBackups } from '../../src/commands/upgrade-backup-sweep.js';

const H = 3600_000;
describe('sweepStaleUpgradeBackups', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ub-sweep-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const mk = (name: string, ageH: number) => {
        const p = path.join(dir, name); fs.mkdirSync(path.join(p, 'package'), { recursive: true });
        const t = new Date(Date.now() - ageH * H); fs.utimesSync(p, t, t); return p;
    };

    it('removes backups older than 24h, keeps younger ones and unrelated entries', () => {
        const old1 = mk('upgrade-backup-aaa', 48); const old2 = mk('upgrade-backup-bbb', 120); const fresh = mk('upgrade-backup-ccc', 2); const other = mk('keep-me', 200);
        const removed = sweepStaleUpgradeBackups(dir);
        expect(removed.sort()).toEqual([old1, old2].sort());
        expect(fs.existsSync(fresh)).toBe(true);
        expect(fs.existsSync(other)).toBe(true);
    });

    it('keeps a backup the upgrade journal references', () => {
        const ref = mk('upgrade-backup-ref', 72); const old = mk('upgrade-backup-old', 72);
        fs.writeFileSync(path.join(dir, 'daemon-upgrade-journal.json'), JSON.stringify({ helperPid: 1, backupDir: ref, phase: 'installing', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
        sweepStaleUpgradeBackups(dir);
        expect(fs.existsSync(ref)).toBe(true);
        expect(fs.existsSync(old)).toBe(false);
    });
});
