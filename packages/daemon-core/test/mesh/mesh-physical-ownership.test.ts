import { afterEach, describe, expect, it, vi } from 'vitest';
// Local attestations carry this machine's id; a different id is another machine's scope.
vi.mock('../../src/config/config.js', async importOriginal => ({ ...await importOriginal<any>(), getMachineId: () => 'host-machine' }));
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeOwnedPaths } from '@adhdev/mesh-shared';
import { attestLocalOwnership, comparePhysicalOwnership, currentPhysicalScope, explainPhysicalOverlap, plannedPhysicalScope } from '../../src/mesh/mesh-physical-ownership.js';
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
    it('planning reuses an attestation for 30 s while admission always re-attests', () => {
        const { a, paths, attest } = fixture();
        const scope = attest(a);
        const now = 1_000_000;
        expect(plannedPhysicalScope(scope, paths, now)?.worktree).toBe(scope.worktree);
        rmSync(a, { recursive: true, force: true });
        expect(plannedPhysicalScope(scope, paths, now + 29_999)?.worktree).toBe(scope.worktree);
        expect(currentPhysicalScope(scope, paths)).toBeUndefined();
        expect(plannedPhysicalScope(scope, paths, now + 30_000)).toBeUndefined();
    });
    it('planning does not share an answer between declarations', () => {
        const { a, paths, attest } = fixture();
        const scope = attest(a);
        expect(plannedPhysicalScope(scope, paths, 5)?.worktree).toBe(scope.worktree);
        expect(plannedPhysicalScope(scope, normalizeOwnedPaths(['other.ts']).declaration, 5)).toBeUndefined();
    });
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
        mkdirSync(join(a, 'node_modules'));
        symlinkSync(join(a, 'node_modules'), join(b, 'node_modules'));
        const shared = attest(b);
        const explanation = explainPhysicalOverlap(paths, attest(a), paths, shared);
        expect(explanation.kind).toBe('resource');
        expect(comparePhysicalOwnership(paths, attest(a), paths, shared).physicalConflict).toBe(true);
    });
    it('fences a shared submodule store and allows a separate clone of the same gitlink', () => {
        const { dir } = fixture();
        const origin = join(dir, 'sub-origin'); mkdirSync(origin);
        const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
        git(origin, 'init', '--initial-branch=main'); writeFileSync(join(origin, 'file.ts'), 'export {};\n');
        git(origin, 'add', 'file.ts'); git(origin, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Nested');
        const parent = join(dir, 'parent'); mkdirSync(parent);
        git(parent, 'init', '--initial-branch=main'); writeFileSync(join(parent, 'root.ts'), 'export {};\n');
        git(parent, 'add', 'root.ts'); git(parent, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Root');
        git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'nested', origin, 'nested');
        git(parent, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Add nested');
        const linked = join(dir, 'linked');
        git(dir, '-c', 'protocol.file.allow=always', 'clone', '--recurse-submodules', parent, linked);
        rmSync(join(linked, '.git', 'modules', 'nested'), { recursive: true, force: true });
        symlinkSync(join(parent, '.git', 'modules', 'nested'), join(linked, '.git', 'modules', 'nested'));
        const cloned = join(dir, 'cloned');
        git(dir, '-c', 'protocol.file.allow=always', 'clone', '--recurse-submodules', parent, cloned);
        const nestedPaths = normalizeOwnedPaths(['nested/file.ts']).declaration;
        const attestAt = (workspace: string) => attestLocalOwnership({ repoIdentity: 'authenticated-repo', machineId: 'host-machine', nodeId: workspace, workspace, phase: 'source', paths: nestedPaths });
        const moduleConfigs = (workspace: string) => attestAt(workspace).resources.filter(resource => resource.path.includes('/modules/') && resource.path.endsWith('/config')).map(resource => resource.path);
        const sharedConfigs = moduleConfigs(parent);
        const linkedConfigs = moduleConfigs(linked);
        expect(sharedConfigs.length).toBeGreaterThan(0);
        const sameStore = sharedConfigs.some(path => linkedConfigs.includes(path));
        expect(sameStore).toBe(true);
        expect(comparePhysicalOwnership(nestedPaths, attestAt(parent), nestedPaths, attestAt(linked)).physicalConflict).toBe(sameStore);
        expect(explainPhysicalOverlap(nestedPaths, attestAt(parent), nestedPaths, attestAt(linked)).kind).toBe('resource');
        const clonedConfigs = moduleConfigs(cloned);
        const clonedShares = sharedConfigs.some(path => clonedConfigs.includes(path));
        expect(clonedShares).toBe(false);
        expect(comparePhysicalOwnership(nestedPaths, attestAt(parent), nestedPaths, attestAt(cloned)).physicalConflict).toBe(clonedShares);
    });
    it('keeps legacy rows conservative and rejects source gitlinks and generated writes', () => {
        const { a, paths, attest } = fixture();
        expect(comparePhysicalOwnership(paths, attest(a), paths, undefined).physicalConflict).toBe(true);
        for (const path of ['oss', '.git/config', 'packages/daemon-cloud/vendor/mcp-server/**']) {
            expect(() => attestLocalOwnership({ repoIdentity: 'repo', machineId: 'host', nodeId: 'a', workspace: a, phase: 'source', paths: normalizeOwnedPaths([path]).declaration })).toThrow(/source/);
        }
    });
});
