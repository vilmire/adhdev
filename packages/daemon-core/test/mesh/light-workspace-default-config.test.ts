import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultLightWorkspaceConfig, loadLightWorkspaceConfig } from '../../src/mesh/light-workspace-config.js';

// Owner 2026-11-05: a repository without .adhdev/light-workspace.json no longer
// refuses light tasks; it gets a default from what it already declares.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function repo(pkg?: object, rootNodeModules = true): string {
    const d = mkdtempSync(join(tmpdir(), 'light-default-')); dirs.push(d);
    if (pkg) writeFileSync(join(d, 'package.json'), JSON.stringify(pkg));
    if (rootNodeModules) mkdirSync(join(d, 'node_modules'));
    return d;
}

describe('light workspace default config', () => {
    it('links the root node_modules and every declared workspace, nothing else', () => {
        const r = repo({ workspaces: ['packages/*', './apps/web', 'oss/packages/*', '!excluded', 'deep/**', '../escape'] });
        const loaded = loadLightWorkspaceConfig(r);
        expect(loaded.ok).toBe(true);
        if (!loaded.ok) return;
        expect(loaded.source).toBe('default');
        expect(loaded.config.linkNodeModules).toEqual(['node_modules', 'packages/*/node_modules', 'apps/web/node_modules', 'oss/packages/*/node_modules']);
        expect(loaded.config.copyDirs).toEqual([]);
        expect(loaded.config.freshDirs).toEqual([]);
    });

    it('reads yarn-style { packages } workspaces and works for a repo with no manifest at all', () => {
        expect(defaultLightWorkspaceConfig(repo({ workspaces: { packages: ['libs/*'] } }, false))).toEqual({ version: 1, linkNodeModules: ['libs/*/node_modules'] });
        const bare = loadLightWorkspaceConfig(repo(undefined, false));
        expect(bare.ok && bare.config.linkNodeModules).toEqual([]);
    });

    it('still refuses an invalid file (a typo never silently changes the setup)', () => {
        const r = repo({ workspaces: ['packages/*'] });
        mkdirSync(join(r, '.adhdev'));
        writeFileSync(join(r, '.adhdev', 'light-workspace.json'), JSON.stringify({ version: 1, linkNodeModule: ['node_modules'] }));
        const loaded = loadLightWorkspaceConfig(r);
        expect(loaded.ok).toBe(false);
        if (loaded.ok) return;
        expect(loaded.reason).toBe('invalid');
        expect(loaded.message).toContain('unknown key: linkNodeModule');
    });

    it('prefers the file when one exists', () => {
        const r = repo({ workspaces: ['packages/*'] });
        mkdirSync(join(r, '.adhdev'));
        writeFileSync(join(r, '.adhdev', 'light-workspace.json'), JSON.stringify({ version: 1, linkNodeModules: ['node_modules'], freshDirs: ['artifacts'] }));
        const loaded = loadLightWorkspaceConfig(r);
        expect(loaded.ok && loaded.source).toBe('file');
        expect(loaded.ok && loaded.config.linkNodeModules).toEqual(['node_modules']);
    });
});
