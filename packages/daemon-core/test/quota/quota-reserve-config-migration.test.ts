import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getQuotaReserveConfig, invalidateConfigFieldMemos, loadConfig } from '../../src/config/config.js';
import { migrateMeshQuotaThresholdsToMachineReserve } from '../../src/config/mesh-quota-reserve-migration.js';
import { setMeshQuotaRouting } from '../../src/config/mesh-config-routing.js';
import { quotaReserveHandlers, quotaReserveSpecs } from '../../src/commands/low-family/quota-reserve-commands.js';
import { buildLocalNodeFacts } from '../../src/mesh/node-facts.js';
import { quotaReserveStats, resetQuotaReserveStats } from '../../src/quota/quota-reserve-metrics.js';

let configDir: string;
let previous: string | undefined;

beforeEach(() => {
    configDir = join(tmpdir(), `adhdev-quota-reserve-${randomUUID().slice(0, 8)}`);
    mkdirSync(configDir, { recursive: true });
    previous = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = configDir;
    invalidateConfigFieldMemos();
    resetQuotaReserveStats();
});
afterEach(() => {
    if (previous === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = previous;
    invalidateConfigFieldMemos();
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function writeMeshes(meshes: any[]) {
    writeFileSync(join(configDir, 'meshes.json'), JSON.stringify({ meshes }, null, 2));
}
const readMeshes = () => JSON.parse(readFileSync(join(configDir, 'meshes.json'), 'utf-8')).meshes as any[];
const mesh = (id: string, quotaRouting?: Record<string, unknown>) => ({
    id, name: id, repoIdentity: `github.com/acme/${id}`, nodes: [], policyStorage: 2,
    policy: quotaRouting ? { quotaRouting } : {},
});

describe('migrateMeshQuotaThresholdsToMachineReserve', () => {
    it('merges A=30 / B=20 / C=default to the most conservative value, strips mesh fields, keeps originals, and is idempotent', () => {
        writeMeshes([
            mesh('a', { sessionMinRemainingPercent: 30, staleAfterMs: 120000, sessionResetImminentMs: 600000 }),
            mesh('b', { sessionMinRemainingPercent: 20, weeklyMinRemainingPercent: 25, sessionResetImminentMs: 120000 }),
            mesh('c'),
        ]);
        const first = migrateMeshQuotaThresholdsToMachineReserve('2026-11-01T00:00:00.000Z');
        expect(first).toMatchObject({ migrated: true, meshesWithValues: 2 });
        expect(first.conflictsResolved).toBeGreaterThan(0);

        invalidateConfigFieldMemos();
        const reserve = getQuotaReserveConfig()!;
        expect(reserve.defaults).toEqual({
            routingSessionMinPercent: 30, routingLongMinPercent: 25, routingSessionResetImminentMs: 120000,
        });
        expect(reserve.migration?.resolution).toBe('max');
        expect(reserve.migration?.fromMeshes.map(m => m.meshId).sort()).toEqual(['a', 'b']);
        expect(reserve.migration?.fromMeshes.find(m => m.meshId === 'a')?.fields).toEqual({ routingSessionMinPercent: 30, routingSessionResetImminentMs: 600000 });

        const meshes = readMeshes();
        expect(meshes.find(m => m.id === 'a').policy.quotaRouting).toEqual({ staleAfterMs: 120000 }); // scheduling pref kept
        expect(meshes.find(m => m.id === 'b').policy.quotaRouting).toBeUndefined();
        expect(quotaReserveStats().migrationConflictsResolved).toBeGreaterThan(0);

        // Re-run: nothing left to move, nothing changes.
        const before = readFileSync(join(configDir, 'config.json'), 'utf-8');
        expect(migrateMeshQuotaThresholdsToMachineReserve('2026-11-02T00:00:00.000Z')).toEqual({ migrated: false, conflictsResolved: 0, meshesWithValues: 0 });
        expect(readFileSync(join(configDir, 'config.json'), 'utf-8')).toBe(before);
    });

    it('strips default-valued legacy fields without inventing a reserve, and tolerates no meshes.json', () => {
        expect(migrateMeshQuotaThresholdsToMachineReserve().migrated).toBe(false);
        writeMeshes([mesh('a', { sessionMinRemainingPercent: 10, weeklyMinRemainingPercent: 15 })]);
        const result = migrateMeshQuotaThresholdsToMachineReserve();
        expect(result).toMatchObject({ migrated: true, meshesWithValues: 0 });
        invalidateConfigFieldMemos();
        expect(getQuotaReserveConfig()).toBeUndefined();
        expect(readMeshes()[0].policy.quotaRouting).toBeUndefined();
    });

    it('reads pre-sparse (policyStorage 1) stores raw, before the loader normalizes the fields away', () => {
        writeMeshes([{ ...mesh('old', { sessionMinRemainingPercent: 45, spreadBonusMax: 30 }), policyStorage: undefined }]);
        expect(migrateMeshQuotaThresholdsToMachineReserve().meshesWithValues).toBe(1);
        invalidateConfigFieldMemos();
        expect(getQuotaReserveConfig()?.defaults).toEqual({ routingSessionMinPercent: 45 });
    });

    it('the mesh writer now rejects the moved fields so an old client sees the regression', () => {
        writeMeshes([mesh('a')]);
        expect(() => setMeshQuotaRouting({ weeklyMinRemainingPercent: 50 }, 'a')).toThrow(/moved_to_machine_reserve/);
    });
});

describe('quota_reserve_get / quota_reserve_set', () => {
    const ctx = { deps: {} } as any;

    it('sets, merges, clears and persists through config.json; edits are counted', async () => {
        const set: any = await quotaReserveHandlers.quota_reserve_set(ctx, { scope: 'defaults', policy: { routingSessionMinPercent: 25 } });
        expect(set.success).toBe(true);
        expect(set.raw.defaults).toEqual({ routingSessionMinPercent: 25 });
        await quotaReserveHandlers.quota_reserve_set(ctx, { scope: 'pool', key: 'antigravity-cli:gemini', policy: { routingLongMinPercent: 35 } });
        expect(loadConfig().quotaReserve?.pools).toEqual({ 'antigravity-cli:gemini': { routingLongMinPercent: 35 } });
        const got: any = await quotaReserveHandlers.quota_reserve_get(ctx, {});
        expect(got.success).toBe(true);
        const gem = got.rows.find((r: any) => r.poolKey === 'antigravity-cli:gemini');
        expect(gem.policy).toMatchObject({ routingSessionMinPercent: 25, routingLongMinPercent: 35 });
        const cleared: any = await quotaReserveHandlers.quota_reserve_set(ctx, { scope: 'defaults', policy: null });
        expect(cleared.raw.defaults).toBeUndefined();
        expect(quotaReserveStats().edits).toBe(3);
    });

    it('rejects invalid input as a structured error without writing', async () => {
        const bad: any = await quotaReserveHandlers.quota_reserve_set(ctx, { scope: 'defaults', policy: { routingSessionMinPercent: 400 } });
        expect(bad).toMatchObject({ success: false });
        expect(bad.error).toMatch(/invalid_quota_reserve/);
        expect((await quotaReserveHandlers.quota_reserve_set(ctx, { scope: 'defaults' }) as any).success).toBe(false);
        expect(loadConfig().quotaReserve).toBeUndefined();
    });

    it('is OWNER-ONLY: set is not reachable from ipc (agents/MCP), mesh, or push_relay; get is readable over ipc', () => {
        const set = quotaReserveSpecs.find(s => s.name === 'quota_reserve_set')!;
        const get = quotaReserveSpecs.find(s => s.name === 'quota_reserve_get')!;
        for (const blocked of ['ipc', 'mesh', 'push_relay', 'internal']) expect(set.sources).not.toContain(blocked);
        for (const allowed of ['p2p', 'ws', 'standalone']) expect(set.sources).toContain(allowed);
        expect(get.sources).toContain('ipc');
        expect(get.sources).not.toContain('mesh');
    });
});

describe('node facts carry the machine reserve', () => {
    it('buildLocalNodeFacts ships the stored reserve (no migration trail) and omits it when unset', async () => {
        expect(buildLocalNodeFacts().quotaReserve).toBeUndefined();
        await quotaReserveHandlers.quota_reserve_set({ deps: {} } as any, { scope: 'defaults', policy: { routingLongMinPercent: 40 } });
        const facts = buildLocalNodeFacts();
        expect(facts.quotaReserve).toMatchObject({ version: 1, defaults: { routingLongMinPercent: 40 } });
        expect((facts.quotaReserve as any).migration).toBeUndefined();
    });
});
