import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeRepoIdentity } from '../../src/config/mesh-config';
import { planMeshOnboarding } from '../../src/mesh/mesh-onboarding-plan';
import type { LocalMeshEntry } from '../../src/repo-mesh-types';

const roots: string[] = [];
let previousConfigDir: string | undefined;

function run(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function makeRepo(name: string, remote = 'git@github.com:acme/project.git'): string {
    const repo = mkdtempSync(join(tmpdir(), `${name}-`));
    roots.push(repo);
    run(repo, ['init', '-b', 'main']);
    run(repo, ['config', 'user.email', 'mesh-test@example.com']);
    run(repo, ['config', 'user.name', 'Mesh Test']);
    writeFileSync(join(repo, 'README.md'), '# test\n');
    run(repo, ['add', 'README.md']);
    run(repo, ['commit', '-m', 'initial']);
    run(repo, ['remote', 'add', 'origin', remote]);
    run(repo, ['config', 'branch.main.remote', 'origin']);
    return repo;
}

function mesh(repoIdentity: string, workspace?: string, id = 'mesh_test'): LocalMeshEntry {
    return {
        id,
        name: id,
        repoIdentity,
        defaultBranch: 'main',
        policy: {} as any,
        coordinator: {},
        meshHost: {} as any,
        nodes: workspace ? [{
            id: `node_${id}`,
            workspace,
            userOverrides: {},
            policy: {},
        }] : [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    };
}

beforeAll(() => {
    previousConfigDir = process.env.ADHDEV_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), 'mesh-onboarding-config-'));
    roots.push(configDir);
    process.env.ADHDEV_CONFIG_DIR = configDir;
});

afterAll(() => {
    if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = previousConfigDir;
    for (const root of roots.reverse()) {
        try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

describe('normalizeRepoIdentity', () => {
    it('normalizes alternate HTTPS, SSH URL and SCP remote syntax to one identity', () => {
        expect(normalizeRepoIdentity('https://github.com/acme/project.git/')).toBe('github.com/acme/project');
        expect(normalizeRepoIdentity('ssh://git@GitHub.COM/acme/project.git')).toBe('github.com/acme/project');
        expect(normalizeRepoIdentity('git@github.com:acme/project.git')).toBe('github.com/acme/project');
        expect(normalizeRepoIdentity('github.com/acme/project.git')).toBe('github.com/acme/project');
    });
});

describe('planMeshOnboarding', () => {
    it('discovers a main checkout and returns a create+onboarding dry-run when no mesh exists', async () => {
        const repo = makeRepo('mesh-plan-main');
        const result = await planMeshOnboarding({ workspace: repo, meshes: [] });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.discovery.repoRoot).toBe(realpathSync(repo));
        expect(result.discovery.repoIdentity).toBe('github.com/acme/project');
        expect(result.discovery.origin?.identities).toEqual(['github.com/acme/project']);
        expect(result.discovery.upstream?.identities).toEqual(['github.com/acme/project']);
        expect(result.discovery.currentBranch).toBe('main');
        expect(result.discovery.defaultBranch).toBe('main');
        expect(result.discovery.isMainCheckout).toBe(true);
        expect(result.discovery.isLinkedWorktree).toBe(false);
        expect(result.plan.kind).toBe('create_mesh_and_onboard');
        expect(result.plan.steps.some(step => step.command === 'mesh_init')).toBe(true);
        expect(result.plan.steps.every(step => step.approvalRequired === step.writes)).toBe(true);
        expect(existsSync(join(repo, '.adhdev'))).toBe(false);
        expect(existsSync(join(process.env.ADHDEV_CONFIG_DIR!, 'meshes.json'))).toBe(false);
    });

    it('detects a linked worktree and recommends adding the existing workspace to a compatible mesh', async () => {
        const repo = makeRepo('mesh-plan-linked');
        const worktree = `${repo}-linked`;
        roots.push(worktree);
        run(repo, ['worktree', 'add', '-b', 'feat/linked', worktree]);
        const result = await planMeshOnboarding({
            workspace: worktree,
            meshes: [mesh('https://github.com/acme/project.git')],
        });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.discovery.isLinkedWorktree).toBe(true);
        expect(result.discovery.isMainCheckout).toBe(false);
        expect(result.discovery.commonDir).not.toBe(result.discovery.gitDir);
        expect(result.plan.kind).toBe('add_existing_workspace');
        expect(result.plan.steps[0].args.isLocalWorktree).toBe(true);
    });

    it('returns add-existing for an existing compatible mesh and create for no mesh', async () => {
        const repo = makeRepo('mesh-plan-compatible');
        const compatible = await planMeshOnboarding({
            workspace: repo,
            meshes: [mesh('ssh://git@github.com/acme/project.git')],
        });
        expect(compatible.success && compatible.plan.kind).toBe('add_existing_workspace');

        const absent = await planMeshOnboarding({ workspace: repo, meshes: [] });
        expect(absent.success && absent.plan.kind).toBe('create_mesh_and_onboard');
    });

    it('fails closed for a duplicate workspace/node', async () => {
        const repo = makeRepo('mesh-plan-duplicate');
        const result = await planMeshOnboarding({
            workspace: repo,
            meshes: [mesh('github.com/acme/project', repo)],
        });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.code).toBe('duplicate_workspace');
        expect(result.membership?.[0].nodeId).toBeTruthy();
    });

    it('distinguishes a duplicate node root from an exact duplicate workspace path', async () => {
        const repo = makeRepo('mesh-plan-duplicate-node');
        const configured = mesh('github.com/acme/project');
        configured.nodes = [{
            id: 'node_alias',
            workspace: join(repo, 'stale-alias'),
            repoRoot: repo,
            userOverrides: {},
            policy: {},
        }];
        const result = await planMeshOnboarding({ workspace: repo, meshes: [configured] });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.code).toBe('duplicate_node');
    });

    it('fails closed for ambiguous unrelated remotes', async () => {
        const repo = makeRepo('mesh-plan-ambiguous');
        run(repo, ['remote', 'add', 'upstream', 'https://gitlab.com/other/project.git']);
        const result = await planMeshOnboarding({ workspace: repo, meshes: [] });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.code).toBe('ambiguous_remotes');
        expect(result.action).toMatch(/canonical remote/i);
    });

    it('derives a local/<root-sha> identity for a repository with no remote', async () => {
        const repo = mkdtempSync(join(tmpdir(), 'mesh-plan-local-only-'));
        roots.push(repo);
        run(repo, ['init', '-b', 'main']);
        run(repo, ['config', 'user.email', 'mesh-test@example.com']);
        run(repo, ['config', 'user.name', 'Mesh Test']);
        writeFileSync(join(repo, 'README.md'), '# local only\n');
        run(repo, ['add', 'README.md']);
        run(repo, ['commit', '-m', 'initial']);

        const rootCommit = run(repo, ['rev-list', '--max-parents=0', 'HEAD']);
        const result = await planMeshOnboarding({ workspace: repo, meshes: [] });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.discovery.repoIdentity).toBe(`local/${rootCommit}`);
        expect(result.discovery.remotes).toEqual([]);
        expect(result.discovery.selectedRemote).toBe('');
        expect(result.discovery.defaultBranch).toBe('main');
        expect(result.plan.kind).toBe('create_mesh_and_onboard');
        // The identity must survive the normalizer unchanged, otherwise mesh
        // membership matching would never find the mesh it just created.
        expect(normalizeRepoIdentity(result.discovery.repoIdentity)).toBe(result.discovery.repoIdentity);
    });

    it('matches an existing local-identity mesh, proving the derived identity round-trips', async () => {
        const repo = mkdtempSync(join(tmpdir(), 'mesh-plan-local-match-'));
        roots.push(repo);
        run(repo, ['init', '-b', 'main']);
        run(repo, ['config', 'user.email', 'mesh-test@example.com']);
        run(repo, ['config', 'user.name', 'Mesh Test']);
        writeFileSync(join(repo, 'README.md'), '# local match\n');
        run(repo, ['add', 'README.md']);
        run(repo, ['commit', '-m', 'initial']);

        const rootCommit = run(repo, ['rev-list', '--max-parents=0', 'HEAD']);
        const result = await planMeshOnboarding({
            workspace: repo,
            meshes: [mesh(`local/${rootCommit}`, undefined, 'mesh_local')],
        });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.plan.kind).toBe('add_existing_workspace');
        expect(result.compatibleMesh?.id).toBe('mesh_local');
    });

    it('derives a deterministic identity for a multi-root repository', async () => {
        const repo = mkdtempSync(join(tmpdir(), 'mesh-plan-multi-root-'));
        roots.push(repo);
        run(repo, ['init', '-b', 'main']);
        run(repo, ['config', 'user.email', 'mesh-test@example.com']);
        run(repo, ['config', 'user.name', 'Mesh Test']);
        writeFileSync(join(repo, 'a.txt'), 'a\n');
        run(repo, ['add', 'a.txt']);
        run(repo, ['commit', '-m', 'first history']);
        // Second independent history, merged in: the repository now has two
        // root commits and `git rev-list` does not order them stably.
        run(repo, ['checkout', '--orphan', 'second']);
        run(repo, ['rm', '-rf', '--cached', '.']);
        rmSync(join(repo, 'a.txt'), { force: true });
        writeFileSync(join(repo, 'b.txt'), 'b\n');
        run(repo, ['add', 'b.txt']);
        run(repo, ['commit', '-m', 'second history']);
        run(repo, ['checkout', 'main']);
        run(repo, ['merge', '--allow-unrelated-histories', '-m', 'merge histories', 'second']);

        const allRoots = run(repo, ['rev-list', '--max-parents=0', 'HEAD']).split(/\r?\n/).map(v => v.trim()).filter(Boolean);
        expect(allRoots.length).toBeGreaterThan(1);
        const expected = `local/${[...allRoots].sort()[0]}`;

        const first = await planMeshOnboarding({ workspace: repo, meshes: [] });
        const second = await planMeshOnboarding({ workspace: repo, meshes: [] });
        expect(first.success).toBe(true);
        expect(second.success).toBe(true);
        if (!first.success || !second.success) return;
        expect(first.discovery.repoIdentity).toBe(expected);
        // Repeated calls must agree, independent of branch/checkout ordering.
        expect(second.discovery.repoIdentity).toBe(first.discovery.repoIdentity);
    });

    it('fails closed for a repository with no remote and no commits', async () => {
        const repo = mkdtempSync(join(tmpdir(), 'mesh-plan-empty-'));
        roots.push(repo);
        run(repo, ['init', '-b', 'main']);
        run(repo, ['config', 'user.email', 'mesh-test@example.com']);
        run(repo, ['config', 'user.name', 'Mesh Test']);
        const result = await planMeshOnboarding({ workspace: repo, meshes: [] });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.code).toBe('no_commits_for_local_identity');
        expect(result.action).toMatch(/commit/i);
    });

    it('reports unselectable remotes separately from a missing remote', async () => {
        const repo = mkdtempSync(join(tmpdir(), 'mesh-plan-unselectable-'));
        roots.push(repo);
        run(repo, ['init', '-b', 'main']);
        run(repo, ['config', 'user.email', 'mesh-test@example.com']);
        run(repo, ['config', 'user.name', 'Mesh Test']);
        writeFileSync(join(repo, 'README.md'), '# unselectable\n');
        run(repo, ['add', 'README.md']);
        run(repo, ['commit', '-m', 'initial']);
        // Two remotes, neither named origin/upstream and neither tracked, so no
        // canonical remote can be chosen. This is not "no remote configured".
        run(repo, ['remote', 'add', 'alpha', 'https://github.com/acme/project.git']);
        run(repo, ['remote', 'add', 'beta', 'https://github.com/acme/project.git']);
        const result = await planMeshOnboarding({ workspace: repo, meshes: [] });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.code).toBe('remote_not_selected');
        expect(result.error).toMatch(/alpha/);
    });

    it('returns a typed non-git error', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mesh-plan-nongit-'));
        roots.push(dir);
        const result = await planMeshOnboarding({ workspace: dir, meshes: [] });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.code).toBe('not_git_repository');
    });

    it('blocks a dirty source when the chosen operation clones a worktree', async () => {
        const repo = makeRepo('mesh-plan-dirty');
        writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');
        const result = await planMeshOnboarding({
            workspace: repo,
            meshId: 'mesh_dirty',
            operation: 'clone_worktree',
            branch: 'feat/isolated',
            meshes: [mesh('github.com/acme/project', repo, 'mesh_dirty')],
        });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.code).toBe('dirty_workspace');
    });

    it('fails closed on detached HEAD', async () => {
        const repo = makeRepo('mesh-plan-detached');
        run(repo, ['checkout', '--detach']);
        const result = await planMeshOnboarding({ workspace: repo, meshes: [] });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.code).toBe('detached_head');
    });

    it('refuses an explicitly selected cross-repo mesh', async () => {
        const repo = makeRepo('mesh-plan-cross');
        const result = await planMeshOnboarding({
            workspace: repo,
            meshId: 'mesh_other',
            meshes: [mesh('github.com/other/unrelated', undefined, 'mesh_other')],
        });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.code).toBe('unrelated_repo_identity');
    });

    it('fails closed for a nested Git checkout', async () => {
        const outer = makeRepo('mesh-plan-outer', 'https://github.com/acme/outer.git');
        const nested = join(outer, 'nested');
        mkdirSync(nested);
        run(nested, ['init', '-b', 'main']);
        run(nested, ['config', 'user.email', 'mesh-test@example.com']);
        run(nested, ['config', 'user.name', 'Mesh Test']);
        writeFileSync(join(nested, 'README.md'), 'nested\n');
        run(nested, ['add', 'README.md']);
        run(nested, ['commit', '-m', 'nested']);
        run(nested, ['remote', 'add', 'origin', 'https://github.com/acme/nested.git']);
        const result = await planMeshOnboarding({ workspace: nested, meshes: [] });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.code).toBe('nested_worktree');
    });
});
