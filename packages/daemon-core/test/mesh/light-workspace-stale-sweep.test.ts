import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { prepareLightWorkspace, sweepLightWorkspaces } from '../../src/mesh/light-workspace.js';
import { runLightWorkspaceSweep, resolveLightWorkspaceStaleMs } from '../../src/mesh/light-workspace-sweep-runner.js';
import { validateLightWorkspaceConfig, type LightWorkspaceConfig } from '../../src/mesh/light-workspace-config.js';
import { ensureLightWorkspaceSchema, getLightWorkspace, setLightWorkspaceState } from '../../src/mesh/mesh-light-workspace-store.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const SIX_H = 6 * 3600_000;

describe('light workspace stale sweep', () => {
    let tmp: string; let checkout: string; let cfg: LightWorkspaceConfig; let db: Database.Database;
    beforeEach(() => {
        tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lw-stale-')));
        checkout = path.join(tmp, 'checkout');
        fs.mkdirSync(checkout); git(checkout, 'init', '-q', '-b', 'main');
        fs.writeFileSync(path.join(checkout, 'a.txt'), 'x\n'); git(checkout, 'add', '.'); git(checkout, 'commit', '-q', '-m', 'c');
        const v = validateLightWorkspaceConfig({ version: 1, baseDir: path.join(tmp, 'lwbase'), linkNodeModules: [], copyDirs: [], freshDirs: [], minFreeBytes: 1 });
        if (!v.ok) throw new Error(v.message);
        cfg = v.config;
        db = new Database(':memory:'); ensureLightWorkspaceSchema(db);
    });
    afterEach(() => { try { db.close(); } catch { /* */ } fs.rmSync(tmp, { recursive: true, force: true }); });
    const prep = (taskId: string) => prepareLightWorkspace({ meshId: 'm1', taskId, checkoutRoot: checkout, config: cfg, db });
    const later = Date.now() + SIX_H + 3600_000;

    it('removes a stale ready workspace whose task is not live, logging size', async () => {
        const h = await prep('deadtask0001');
        const logs: string[] = [];
        const rep = await sweepLightWorkspaces({ checkoutRoot: checkout, db, config: cfg, now: later, staleUntouchedMs: SIX_H, isTaskLive: () => false, log: m => logs.push(m) });
        expect(rep.removedExpired).toEqual([h.workspaceId]);
        expect(fs.existsSync(h.path)).toBe(false);
        expect(getLightWorkspace(db, h.workspaceId)?.state).toBe('removed');
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatch(/MiB/);
    });

    it('keeps a stale workspace whose task is live, and a recent one', async () => {
        const h = await prep('livetask0001');
        await sweepLightWorkspaces({ checkoutRoot: checkout, db, config: cfg, now: later, staleUntouchedMs: SIX_H, isTaskLive: () => true });
        expect(fs.existsSync(h.path)).toBe(true);
        await sweepLightWorkspaces({ checkoutRoot: checkout, db, config: cfg, now: Date.now() + 3600_000, staleUntouchedMs: SIX_H, isTaskLive: () => false });
        expect(fs.existsSync(h.path)).toBe(true);
    });

    it('keeps a preserved result_ready workspace (landable result) inside its retention', async () => {
        const h = await prep('preserved001');
        setLightWorkspaceState(db, h.workspaceId, 'result_ready');
        await sweepLightWorkspaces({ checkoutRoot: checkout, db, config: cfg, now: later, staleUntouchedMs: SIX_H, isTaskLive: () => false });
        expect(fs.existsSync(h.path)).toBe(true);
    });

    it('without staleUntouchedMs the legacy sweep leaves a stale ready workspace (the leak)', async () => {
        const h = await prep('legacytask001');
        await sweepLightWorkspaces({ checkoutRoot: checkout, db, config: cfg, now: later, isTaskLive: () => false });
        expect(fs.existsSync(h.path)).toBe(true);
    });

    it('env 0 disables the runner; default is 6h', async () => {
        expect(resolveLightWorkspaceStaleMs({})).toBe(SIX_H);
        expect(resolveLightWorkspaceStaleMs({ ADHDEV_LIGHT_WORKSPACE_STALE_HOURS: '2' } as any)).toBe(2 * 3600_000);
        expect(resolveLightWorkspaceStaleMs({ ADHDEV_LIGHT_WORKSPACE_STALE_HOURS: '0' } as any)).toBe(0);
        expect(await runLightWorkspaceSweep({ ADHDEV_LIGHT_WORKSPACE_STALE_HOURS: '0' } as any)).toEqual([]);
    });
});
