import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeOwnedPaths } from '@adhdev/mesh-shared';
import { attestLocalOwnership, comparePhysicalOwnership } from '../../src/mesh/mesh-physical-ownership.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'rc28-physical-')); dirs.push(dir);
    const a = join(dir, 'a'), b = join(dir, 'b'); mkdirSync(a);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
    git(a, 'init', '--initial-branch=main'); writeFileSync(join(a, 'file.ts'), 'export {};\n');
    git(a, 'add', 'file.ts'); git(a, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture');
    git(a, 'worktree', 'add', '-b', 'source', b);
    const paths = normalizeOwnedPaths(['file.ts']).declaration;
    const attest = (workspace: string, phase: 'source' | 'integration' = 'source') => attestLocalOwnership({ repoIdentity: 'authenticated-repo', machineId: 'host-machine', nodeId: workspace, workspace, phase, paths });
    return { dir, a, b, paths, attest };
}
describe('authenticated physical ownership', () => {
    it('allows separate real worktrees while warning about their future logical merge', () => {
        const { a, b, paths, attest } = fixture();
        expect(attest(a).gitResources.index).not.toBe(attest(b).gitResources.index);
        expect(attest(a).gitResources.hooks).toBe(attest(b).gitResources.hooks);
        expect(attest(a).gitResources.refs).toBe(attest(b).gitResources.refs);
        expect(attest(a).gitResources.config).toBe(attest(b).gitResources.config);
        expect(comparePhysicalOwnership(paths, attest(a), paths, attest(b))).toEqual({ physicalConflict: false, logicalOverlap: true });
    });
    it('fences aliases of the same workspace even for disjoint declarations', () => {
        const { dir, a, paths, attest } = fixture(); const alias = join(dir, 'alias'); symlinkSync(a, alias);
        expect(comparePhysicalOwnership(paths, attest(a), normalizeOwnedPaths(['other.ts']).declaration, attest(alias)).physicalConflict).toBe(true);
    });
    it('rejects symlink escapes and keeps shared integration resources global', () => {
        const { a, b, paths, attest } = fixture(); symlinkSync(b, join(a, 'escape'));
        expect(() => attestLocalOwnership({ repoIdentity: 'repo', machineId: 'host', nodeId: 'a', workspace: a, phase: 'source', paths: normalizeOwnedPaths(['escape/file.ts']).declaration })).toThrow(/escape/);
        mkdirSync(join(a, 'src')); symlinkSync(b, join(a, 'src', 'nested'));
        expect(() => attestLocalOwnership({ repoIdentity: 'repo', machineId: 'host', nodeId: 'a', workspace: a, phase: 'source', paths: normalizeOwnedPaths(['src/**']).declaration })).toThrow(/escape/);
        expect(comparePhysicalOwnership(paths, attest(a, 'integration'), paths, attest(b, 'integration')).physicalConflict).toBe(true);
    });
    it('detects shared hardlink resources and rejects shared build-output aliases', () => {
        const { a, b, paths, attest } = fixture();
        rmSync(join(b, 'file.ts')); linkSync(join(a, 'file.ts'), join(b, 'file.ts'));
        expect(comparePhysicalOwnership(paths, attest(a), paths, attest(b)).physicalConflict).toBe(true);
        symlinkSync(join(a, 'node_modules'), join(b, 'node_modules'));
        expect(() => attest(b)).toThrow(/escape/);
    });
    it('keeps legacy rows conservative and rejects source gitlinks and generated writes', () => {
        const { a, paths, attest } = fixture();
        expect(comparePhysicalOwnership(paths, attest(a), paths, undefined).physicalConflict).toBe(true);
        for (const path of ['oss', '.git/config', 'packages/daemon-cloud/vendor/mcp-server/**']) {
            expect(() => attestLocalOwnership({ repoIdentity: 'repo', machineId: 'host', nodeId: 'a', workspace: a, phase: 'source', paths: normalizeOwnedPaths([path]).declaration })).toThrow(/source/);
        }
    });
});
