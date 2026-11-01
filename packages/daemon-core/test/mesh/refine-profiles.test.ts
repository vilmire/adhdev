import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateMeshRefineConfig } from '../../src/mesh/refine-config.js';
import { runMeshRefineValidationProfile } from '../../src/mesh/refine-profile-run.js';
import { runMeshRefineValidationGate } from '../../src/mesh/mesh-refine-gates.js';

const cmd = (id: string, script: string) => ({ id, command: 'node', args: [script], category: 'custom', writes: [] as string[] });

function cfg(profiles?: unknown, commands = [cmd('a', 'a.js'), cmd('b', 'b.js'), cmd('c', 'c.js')]) {
    return { version: 1, validation: { required: true, bootstrap: 'skip', commands, ...(profiles ? { profiles } : {}) } };
}

describe('validation.profiles config parsing', () => {
    it('accepts a profile that selects configured ids', () => {
        const r = validateMeshRefineConfig(cfg({ fast: { commands: ['a', 'c'] } }));
        expect(r.errors).toEqual([]);
        expect(r.profiles).toEqual({ fast: { commands: ['a', 'c'] } });
    });
    it('rejects unknown ids, duplicates, empty lists and bad names', () => {
        expect(validateMeshRefineConfig(cfg({ fast: { commands: ['zzz'] } })).errors.join(' ')).toMatch(/unknown command id "zzz"/);
        expect(validateMeshRefineConfig(cfg({ fast: { commands: ['a', 'a'] } })).errors.join(' ')).toMatch(/twice/);
        expect(validateMeshRefineConfig(cfg({ fast: { commands: [] } })).valid).toBe(false);
        expect(validateMeshRefineConfig(cfg({ 'Bad Name': { commands: ['a'] } })).valid).toBe(false);
        expect(validateMeshRefineConfig(cfg('nope')).valid).toBe(false);
    });
    it('a config without profiles is unchanged', () => {
        const r = validateMeshRefineConfig(cfg());
        expect(r.valid).toBe(true);
        expect(r.profiles).toBeUndefined();
    });
});

describe('runMeshRefineValidationProfile', () => {
    const roots: string[] = [];
    afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
    function ws(): string {
        const dir = mkdtempSync(join(tmpdir(), 'adhdev-refine-profile-'));
        roots.push(dir);
        writeFileSync(join(dir, 'a.js'), 'process.exit(0)\n');
        writeFileSync(join(dir, 'b.js'), 'process.exit(1)\n'); // would fail if run
        writeFileSync(join(dir, 'c.js'), "process.exit(process.env.ADHDEV_REFINE_BASE_SHA === 'abc1234' ? 0 : 3)\n");
        return dir;
    }
    const mesh = (c: unknown) => ({ id: 'm', policy: { refineConfig: c } });

    it('runs only profile commands, records the rest skipped_by_profile, injects the base sha', async () => {
        const summary = await runMeshRefineValidationProfile(mesh(cfg({ fast: { commands: ['a', 'c'] } })), ws(), 'fast', { baseSha: 'abc1234' });
        expect(summary.status).toBe('passed');
        const by = new Map(summary.commandsRun.map((r: any) => [r.displayCommand, r]));
        expect(by.get('node a.js')).toMatchObject({ passed: true });
        expect(by.get('node a.js')?.skipped).toBeUndefined();
        expect(by.get('node c.js')?.skipped).toBeUndefined();
        expect(by.get('node b.js')).toMatchObject({ skipped: true, skipReason: 'skipped_by_profile', profile: 'fast' });
        expect(summary.bootstrap).toMatchObject({ stage: 'skipped' });
    });

    it('without a base sha the env-dependent command fails (env really is plumbed)', async () => {
        const summary = await runMeshRefineValidationProfile(mesh(cfg({ fast: { commands: ['c'] } })), ws(), 'fast');
        expect(summary.status).toBe('failed');
    });

    it('an unknown profile fails instead of running everything or nothing', async () => {
        const summary = await runMeshRefineValidationProfile(mesh(cfg({ fast: { commands: ['a'] } })), ws(), 'slow');
        expect(summary).toMatchObject({ status: 'failed', failureCode: 'validation_profile_unknown' });
        expect(summary.commandsRun).toEqual([]);
    });

    it('the full gate (no profile) is unaffected and runs everything', async () => {
        const summary = await runMeshRefineValidationGate(mesh(cfg({ fast: { commands: ['a'] } })), ws(), {});
        expect(summary.status).toBe('failed'); // b.js exits 1
        expect(summary.commandsRun.some((r: any) => r.skipReason === 'skipped_by_profile')).toBe(false);
    });
});
