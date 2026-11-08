// Live 2026-11-08: an upgrade hit ENOSPC mid-install and left the mesh host half-dead. daemon_upgrade
// must refuse before the detached helper starts when the disk is nearly full, and fail open when unmeasurable.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { UPGRADE_MIN_FREE_BYTES, readFreeDiskBytes, upgradeDiskShortfall } from '../../src/commands/upgrade-disk-guard';

describe('upgrade disk guard', () => {
    it('refuses below the floor, proceeds at or above it, fails open when unknown', () => {
        expect(upgradeDiskShortfall(UPGRADE_MIN_FREE_BYTES - 1)).toEqual({ freeBytes: UPGRADE_MIN_FREE_BYTES - 1, requiredBytes: UPGRADE_MIN_FREE_BYTES });
        expect(upgradeDiskShortfall(UPGRADE_MIN_FREE_BYTES)).toBeUndefined();
        expect(upgradeDiskShortfall(undefined)).toBeUndefined();
    });
    it('reads a real free-space number and nothing for a missing path', () => {
        expect(readFreeDiskBytes()).toBeGreaterThan(0);
        expect(readFreeDiskBytes('/definitely/not/a/path')).toBeUndefined();
    });
    it('daemon_upgrade checks the disk before spawning the detached helper', () => {
        const src = readFileSync(new URL('../../src/commands/low-family/daemon-lifecycle.ts', import.meta.url), 'utf8');
        const upgrade = src.slice(src.indexOf('daemon_upgrade'), src.indexOf('daemon_restart: async'));
        const guard = upgrade.indexOf("code: 'insufficient_disk'");
        expect(guard).toBeGreaterThan(0);
        expect(guard).toBeLessThan(upgrade.indexOf('spawnDetachedDaemonUpgradeHelper('));
    });
});
