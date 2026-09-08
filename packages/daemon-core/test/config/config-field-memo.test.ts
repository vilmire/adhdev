// ---------------------------------------------------------------------------
// config field memo — machineId/machineNickname are memoized, the CONFIG IS NOT
// ---------------------------------------------------------------------------
// Regression guard for the one way this optimization can go wrong. The memo
// exists because 33 call sites read only `.machineId`/`.machineNickname` off
// loadConfig(), paying a readFileSync + JSON.parse + full normalization each
// time. Promoting it to a whole-config cache would break `machineSecret`, which
// `daemon-cloud/src/server-connection.ts` deliberately RE-READS from disk on
// reconnect so a secret rewritten by `setup` is picked up by the running
// daemon. Cached, that turns into a permanent `machine_secret_not_found` loop.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testConfigDir: string;

const {
    loadConfig,
    saveConfig,
    getMachineId,
    getMachineNickname,
    invalidateConfigFieldMemos,
} = await import('../../src/config/config.js');

function configPath(): string {
    return join(testConfigDir, 'config.json');
}

function writeConfig(patch: Record<string, unknown>): void {
    const current = JSON.parse(readFileSync(configPath(), 'utf-8'));
    writeFileSync(configPath(), JSON.stringify({ ...current, ...patch }, null, 2));
}

describe('config field memo', () => {
    beforeEach(() => {
        testConfigDir = mkdtempSync(join(tmpdir(), 'adhdev-config-memo-'));
        process.env.ADHDEV_CONFIG_DIR = testConfigDir;
        invalidateConfigFieldMemos();
        loadConfig(); // materialize config.json + stamp a machineId
    });

    afterEach(() => {
        delete process.env.ADHDEV_CONFIG_DIR;
        invalidateConfigFieldMemos();
        rmSync(testConfigDir, { recursive: true, force: true });
    });

    it('serves the same machineId loadConfig() reports', () => {
        expect(getMachineId()).toBe(loadConfig().machineId);
        expect(getMachineId()).toMatch(/^mach_/);
    });

    it('★does NOT cache the whole config — machineSecret stays a live disk read', () => {
        // Prime the memo, which is what a whole-config cache would populate.
        getMachineId();
        getMachineNickname();

        // Simulate `setup` rewriting the credential out-of-process.
        writeConfig({ machineSecret: 'adm_rotated_by_setup' });

        // The reconnect path must observe the NEW secret without any invalidation.
        expect(loadConfig().machineSecret).toBe('adm_rotated_by_setup');
    });

    it('machineNickname memo is dropped by saveConfig', () => {
        expect(getMachineNickname()).toBeNull();

        saveConfig({ ...loadConfig(), machineNickname: 'renamed-box' } as never);

        expect(getMachineNickname()).toBe('renamed-box');
    });

    it('machineId survives a nickname write (immutable once stamped)', () => {
        const before = getMachineId();

        saveConfig({ ...loadConfig(), machineNickname: 'another-name' } as never);

        expect(getMachineId()).toBe(before);
    });
});
