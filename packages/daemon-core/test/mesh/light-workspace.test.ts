import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { prepareLightWorkspace, removeLightWorkspace, sweepLightWorkspaces, resolveLightBaseSha } from '../../src/mesh/light-workspace.js';
import { validateLightWorkspaceConfig, type LightWorkspaceConfig } from '../../src/mesh/light-workspace-config.js';
import { ensureLightWorkspaceSchema, getLightWorkspace, listLightWorkspaces } from '../../src/mesh/mesh-light-workspace-store.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

describe('light workspace (real git)', () => {
    let tmp: string; let checkout: string; let base: string; let cfg: LightWorkspaceConfig; let db: Database.Database;
    beforeEach(() => {
        tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lw-test-')));
        const subSrc = path.join(tmp, 'sub-src');
        fs.mkdirSync(subSrc); git(subSrc, 'init', '-q', '-b', 'main');
        write(path.join(subSrc, 'a.txt'), 'sub\n'); git(subSrc, 'add', '.'); git(subSrc, 'commit', '-q', '-m', 'sub');
        checkout = path.join(tmp, 'checkout');
        fs.mkdirSync(checkout); git(checkout, 'init', '-q', '-b', 'main');
        write(path.join(checkout, '.gitignore'), 'node_modules/\ndist/\n');
        write(path.join(checkout, 'packages/pkg/package.json'), '{"name":"@adhdev/pkg"}\n');
        write(path.join(checkout, 'src.txt'), 'root\n');
        git(checkout, 'submodule', 'add', '-q', subSrc, 'oss');
        git(checkout, 'add', '.'); git(checkout, 'commit', '-q', '-m', 'root');
        // installed deps
        write(path.join(checkout, 'node_modules/leftpad/index.js'), 'module.exports=1\n');
        write(path.join(checkout, 'node_modules/@types/node/index.d.ts'), '// t\n');
        write(path.join(checkout, 'node_modules/.cache/x/blob'), 'cache\n');
        write(path.join(checkout, 'node_modules/leftpad/bin.js'), '#!/usr/bin/env node\n');
        fs.mkdirSync(path.join(checkout, 'node_modules/@adhdev'), { recursive: true });
        fs.symlinkSync('../../packages/pkg', path.join(checkout, 'node_modules/@adhdev/pkg'), 'dir');
        fs.mkdirSync(path.join(checkout, 'node_modules/.bin'));
        fs.symlinkSync('../leftpad/bin.js', path.join(checkout, 'node_modules/.bin/tool'));
        write(path.join(checkout, 'packages/pkg/dist/index.js'), 'orig\n');
        base = path.join(tmp, 'lwbase');
        const v = validateLightWorkspaceConfig({ version: 1, baseDir: base, linkNodeModules: ['node_modules'], copyDirs: ['packages/*/dist'], freshDirs: ['artifacts'], minFreeBytes: 1 });
        if (!v.ok) throw new Error(v.message);
        cfg = v.config;
        db = new Database(':memory:'); ensureLightWorkspaceSchema(db);
    });
    afterEach(() => { try { db.close(); } catch { /* */ } fs.rmSync(tmp, { recursive: true, force: true }); });

    const prep = (taskId = 'task12345678') => prepareLightWorkspace({ meshId: 'm1', taskId, checkoutRoot: checkout, config: cfg, db });

    it('T1 prepares root + submodule worktrees; @adhdev/* resolves to the workspace package', async () => {
        const h = await prep();
        expect(fs.readFileSync(path.join(h.path, 'src.txt'), 'utf8')).toBe('root\n');
        expect(fs.readFileSync(path.join(h.path, 'oss/a.txt'), 'utf8')).toBe('sub\n');
        expect(h.branchRefs).toEqual({ '.': 'mesh/light/task1234', oss: 'mesh/light/task1234' });
        expect(git(h.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('mesh/light/task1234');
        const linked = fs.realpathSync(path.join(h.path, 'node_modules/@adhdev/pkg'));
        expect(linked).toBe(fs.realpathSync(path.join(h.path, 'packages/pkg')));
        expect(linked.startsWith(fs.realpathSync(h.path))).toBe(true);
        expect(fs.realpathSync(path.join(h.path, 'node_modules/leftpad'))).toBe(fs.realpathSync(path.join(checkout, 'node_modules/leftpad')));
        expect(fs.readFileSync(path.join(h.path, 'node_modules/.bin/tool'), 'utf8')).toContain('node');
        expect(getLightWorkspace(db, h.workspaceId)?.state).toBe('ready');
        // marker sits outside the worktree so `git status` stays clean
        expect(git(h.path, 'status', '--porcelain')).toBe('');
        expect(fs.existsSync(path.join(h.path, 'artifacts'))).toBe(true);
    });

    it('T2 dot-cache directories are not linked', async () => {
        const h = await prep();
        expect(fs.existsSync(path.join(h.path, 'node_modules/.cache'))).toBe(false);
    });

    it('T3 dist is a copy: editing it leaves the original untouched', async () => {
        const h = await prep();
        const copy = path.join(h.path, 'packages/pkg/dist/index.js');
        expect(fs.lstatSync(path.dirname(copy)).isSymbolicLink()).toBe(false);
        fs.writeFileSync(copy, 'changed\n');
        expect(fs.readFileSync(path.join(checkout, 'packages/pkg/dist/index.js'), 'utf8')).toBe('orig\n');
    });

    it('T5 removal never deletes link targets and frees the git worktrees', async () => {
        const h = await prep();
        const res = await removeLightWorkspace({ path: h.path, checkoutRoot: checkout, config: cfg, db, workspaceId: h.workspaceId, submodules: Object.keys(h.submoduleBases) });
        expect(res.removed).toBe(true);
        expect(res.linksUnlinked).toBeGreaterThan(0);
        expect(fs.existsSync(h.path)).toBe(false);
        expect(fs.existsSync(path.join(checkout, 'node_modules/leftpad/index.js'))).toBe(true);
        expect(fs.existsSync(path.join(checkout, 'node_modules/@types/node/index.d.ts'))).toBe(true);
        expect(git(checkout, 'worktree', 'list', '--porcelain')).not.toContain(h.path);
        expect(getLightWorkspace(db, h.workspaceId)?.state).toBe('removed');
        // the branch ref survives for late landing
        expect(git(checkout, 'branch', '--list', 'mesh/light/task1234')).toContain('mesh/light/task1234');
    });

    it('refuses to remove a path outside the light base dir', async () => {
        const res = await removeLightWorkspace({ path: checkout, checkoutRoot: checkout, config: cfg });
        expect(res).toMatchObject({ removed: false, reason: 'outside_light_base_dir' });
        expect(fs.existsSync(path.join(checkout, 'src.txt'))).toBe(true);
    });

    it('T6 boot sweep only touches marker-bearing leaks and registry-missing rows', async () => {
        const h = await prep('aaaaaaaa1');
        const repoDir = path.dirname(h.path);
        const stranger = path.join(repoDir, 'not-ours'); fs.mkdirSync(stranger); fs.writeFileSync(path.join(stranger, 'keep.txt'), 'x');
        const leak = await prep('bbbbbbbb2');
        // forget the registry row: leaked directory with marker
        db.prepare('DELETE FROM mesh_light_workspaces WHERE workspace_id = ?').run(leak.workspaceId);
        // registry row whose directory vanished
        const gone = await prep('cccccccc3');
        await removeLightWorkspace({ path: gone.path, checkoutRoot: checkout, config: cfg, submodules: ['oss'] });
        const report = await sweepLightWorkspaces({ checkoutRoot: checkout, db, config: cfg, orphanGraceMs: 0 });
        expect(report.unmarked).toBe(1);
        expect(report.leaked).toBe(1);
        expect(report.removedOrphans).toHaveLength(1);
        expect(report.removedMissing).toContain(gone.workspaceId);
        expect(fs.existsSync(path.join(stranger, 'keep.txt'))).toBe(true);
        expect(fs.existsSync(h.path)).toBe(true);
        expect(fs.existsSync(leak.path)).toBe(false);
        expect(listLightWorkspaces(db).map(r => r.workspaceId)).toEqual([h.workspaceId]);
    });

    it('L12 base sha prefers a strictly-ahead remote-tracking ref', async () => {
        const head = git(checkout, 'rev-parse', 'HEAD');
        expect((await resolveLightBaseSha(checkout)).sha).toBe(head);
        git(checkout, 'commit', '-q', '--allow-empty', '-m', 'next');
        const next = git(checkout, 'rev-parse', 'HEAD');
        git(checkout, 'update-ref', 'refs/remotes/origin/main', next);
        git(checkout, 'reset', '-q', '--hard', head);
        expect(await resolveLightBaseSha(checkout)).toMatchObject({ sha: next, source: 'remote_tracking', head });
    });

    it('rejects unknown config keys and empty link lists', () => {
        expect(validateLightWorkspaceConfig({ version: 1, linkNodeModules: ['node_modules'], bogus: 1 })).toMatchObject({ ok: false });
        expect(validateLightWorkspaceConfig({ version: 1, linkNodeModules: [] })).toMatchObject({ ok: false });
        expect(validateLightWorkspaceConfig({ version: 1, linkNodeModules: ['../x'] })).toMatchObject({ ok: false });
    });
});
