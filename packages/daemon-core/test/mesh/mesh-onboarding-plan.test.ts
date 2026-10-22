import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeRepoIdentity } from '../../src/config/mesh-config-store';
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

    // ★ A dirty source is ADVISORY by default, not a block. `git worktree add` builds
    // the new tree from HEAD, so uncommitted changes are simply absent from the clone —
    // defined worktree behaviour, not a fault. Hard-failing here killed the whole
    // parallel-worktree workflow, because a coordinator's own checkout is dirty most of
    // the time it is working.
    it('allows cloning from a dirty source, with a warning', async () => {
        const repo = makeRepo('mesh-plan-dirty');
        writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');
        const result = await planMeshOnboarding({
            workspace: repo,
            meshId: 'mesh_dirty',
            operation: 'clone_worktree',
            branch: 'feat/isolated',
            meshes: [mesh('github.com/acme/project', repo, 'mesh_dirty')],
        });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.plan.kind).toBe('clone_new_worktree');
        // The operator must be told the uncommitted work does not travel.
        expect(result.warnings?.length).toBeGreaterThan(0);
        expect(result.warnings?.join(' ')).toMatch(/created from HEAD/i);
        expect(result.warnings?.join(' ')).toMatch(/NOT included/i);
        // ...and the plan no longer misdescribes itself as requiring a clean tree.
        expect(result.plan.requiresClean).toBe(false);
    });

    it('★ a retired dirtyWorkspaceBehavior: block left on a stored policy no longer refuses the clone', async () => {
        // docs/design/2026-10-07-mesh-workspace-policy.md B4: the field is retired; a
        // dirty source is information (the worktree is built from HEAD), never a refusal.
        const repo = makeRepo('mesh-plan-dirty-block');
        writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');
        const legacy = mesh('github.com/acme/project', repo, 'mesh_dirty_block');
        (legacy.policy as any).dirtyWorkspaceBehavior = 'block';
        const result = await planMeshOnboarding({
            workspace: repo,
            meshId: 'mesh_dirty_block',
            operation: 'clone_worktree',
            branch: 'feat/isolated',
            meshes: [legacy],
        });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.warnings?.join(' ')).toMatch(/NOT included/i);
    });

    it('emits no warning when the source is clean', async () => {
        const repo = makeRepo('mesh-plan-clean-clone');
        const result = await planMeshOnboarding({
            workspace: repo,
            meshId: 'mesh_clean',
            operation: 'clone_worktree',
            branch: 'feat/isolated',
            meshes: [mesh('github.com/acme/project', repo, 'mesh_clean')],
        });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.warnings).toBeUndefined();
    });

    // ★ The relaxation must NOT tunnel through genuinely dangerous states. Unresolved
    // conflicts hard-fail earlier (discoverWorkspace), independent of the dirty policy,
    // so a conflicted tree is still refused even under 'warn'.
    it('★ still refuses a CONFLICTED workspace under the permissive default policy', async () => {
        const repo = makeRepo('mesh-plan-conflict');
        // Build a real merge conflict.
        run(repo, ['checkout', '-b', 'side']);
        writeFileSync(join(repo, 'README.md'), '# side\n');
        run(repo, ['commit', '-am', 'side change']);
        run(repo, ['checkout', 'main']);
        writeFileSync(join(repo, 'README.md'), '# main\n');
        run(repo, ['commit', '-am', 'main change']);
        try { run(repo, ['merge', 'side']); } catch { /* expected conflict */ }

        const result = await planMeshOnboarding({
            workspace: repo,
            meshId: 'mesh_conflict',
            operation: 'clone_worktree',
            branch: 'feat/isolated',
            meshes: [mesh('github.com/acme/project', repo, 'mesh_conflict')],
        });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.code).toBe('conflicted_workspace');
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

describe('plan_mesh_onboarding cached CLI inventory & hot-path budget', () => {
    it('reuses the cached CLI inventory on clone_worktree so a slow detectCLIs never blocks past budget and never probes --version', async () => {
        const repo = makeRepo('mesh-plan-cache-hit');
        const cliDetector = await import('../../src/detection/cli-detector.js');
        const { meshOnboardingHandlers } = await import('../../src/commands/med-family/mesh-onboarding.js');

        const primeCachedCliInventory = (cliDetector as any).primeCachedCliInventory as
            | ((detected: any[], loader?: any, observedAt?: number) => void)
            | undefined;
        expect(typeof primeCachedCliInventory).toBe('function');

        let slowDetectCalls = 0;
        const seenIncludeVersion: Array<boolean | undefined> = [];
        const stubLoader: any = {
            getCliDetectionList() {
                return [{
                    id: 'claude-cli',
                    displayName: 'Claude Code',
                    icon: '🤖',
                    command: 'claude',
                    category: 'cli',
                    enabled: true,
                }];
            },
            getDetectedVersion(id: string) {
                return id === 'claude-cli' ? '2.1.0' : null;
            },
        };

        primeCachedCliInventory!(
            [{
                id: 'claude-cli',
                displayName: 'Claude Code',
                icon: '🤖',
                command: 'claude',
                category: 'cli',
                installed: true,
                path: '/usr/local/bin/claude',
            }],
            stubLoader,
        );

        const slowDetect = async (_loader?: any, opts?: { includeVersion?: boolean }) => {
            slowDetectCalls += 1;
            seenIncludeVersion.push(opts?.includeVersion);
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            return [];
        };

        const setTestOverrides = (cliDetector as any).__setCliInventoryTestOverridesForTests as
            | ((overrides: any) => void)
            | undefined;
        if (typeof setTestOverrides === 'function') setTestOverrides({ detectFn: slowDetect });

        let result: any;
        let elapsedMs = 0;
        try {
            const startedAt = Date.now();
            result = await meshOnboardingHandlers.plan_mesh_onboarding(
                { deps: { providerLoader: stubLoader } } as any,
                {
                    workspace: repo,
                    meshId: 'mesh_cached',
                    operation: 'clone_worktree',
                    branch: 'feat/fast-clone',
                    inlineMesh: mesh('github.com/acme/project', repo, 'mesh_cached'),
                },
            );
            elapsedMs = Date.now() - startedAt;
        } finally {
            if (typeof setTestOverrides === 'function') setTestOverrides(null);
        }

        expect(result.success).toBe(true);
        expect(result.plan?.kind).toBe('clone_new_worktree');
        expect(slowDetectCalls).toBe(0);
        expect(elapsedMs).toBeLessThan(1_500);
        expect(result.suggestedConfig?.providers?.providerPriority).toEqual(['claude-cli']);
        expect(result.suggestedConfig?.providers?.installedProviders?.[0]?.version).toBe('2.1.0');
    });

    it('invalidates the CLI inventory cache when providers change or expire and re-detects with includeVersion:false', async () => {
        const repo = makeRepo('mesh-plan-cache-invalidate');
        const cliDetector = await import('../../src/detection/cli-detector.js');
        const { meshOnboardingHandlers } = await import('../../src/commands/med-family/mesh-onboarding.js');

        const invalidateCachedCliInventory = (cliDetector as any).invalidateCachedCliInventory as
            | ((loader?: any) => void)
            | undefined;
        expect(typeof invalidateCachedCliInventory).toBe('function');

        let revision = 1;
        let currentInstalled = [
            {
                id: 'claude-cli',
                displayName: 'Claude Code',
                icon: '🤖',
                command: 'claude',
                category: 'cli',
                installed: true,
                path: '/usr/local/bin/claude',
            },
        ];
        const stubLoader: any = {
            getCliDetectionRevision() {
                return revision;
            },
            invalidateCliDetectionCache() {
                revision += 1;
            },
            getCliDetectionList() {
                return currentInstalled.map((item) => ({
                    id: item.id,
                    displayName: item.displayName,
                    icon: item.icon,
                    command: item.command,
                    category: 'cli',
                    enabled: true,
                }));
            },
        };

        const detectCalls: Array<{ includeVersion?: boolean }> = [];
        const fakeDetect = async (_loader?: any, opts?: { includeVersion?: boolean }) => {
            detectCalls.push({ includeVersion: opts?.includeVersion });
            return currentInstalled.map((entry) => ({ ...entry }));
        };

        const setTestOverrides = (cliDetector as any).__setCliInventoryTestOverridesForTests as
            | ((overrides: any) => void)
            | undefined;
        expect(typeof setTestOverrides).toBe('function');
        setTestOverrides!({ detectFn: fakeDetect });
        invalidateCachedCliInventory!(stubLoader);

        try {
            // First call: cold cache -> triggers 1 fresh detection with includeVersion: false
            const first: any = await meshOnboardingHandlers.plan_mesh_onboarding(
                { deps: { providerLoader: stubLoader } } as any,
                {
                    workspace: repo,
                    meshId: 'mesh_inv',
                    operation: 'clone_worktree',
                    branch: 'feat/inv-1',
                    inlineMesh: mesh('github.com/acme/project', repo, 'mesh_inv'),
                },
            );
            expect(first.success).toBe(true);
            expect(detectCalls).toEqual([{ includeVersion: false }]);
            expect(first.suggestedConfig?.providers?.providerPriority).toEqual(['claude-cli']);

            // Second call without invalidation: served from cache
            const second: any = await meshOnboardingHandlers.plan_mesh_onboarding(
                { deps: { providerLoader: stubLoader } } as any,
                {
                    workspace: repo,
                    meshId: 'mesh_inv',
                    operation: 'clone_worktree',
                    branch: 'feat/inv-2',
                    inlineMesh: mesh('github.com/acme/project', repo, 'mesh_inv'),
                },
            );
            expect(second.success).toBe(true);
            expect(detectCalls).toHaveLength(1);

            // Provider change / explicit invalidation -> next call re-detects with includeVersion: false
            currentInstalled = [
                ...currentInstalled,
                {
                    id: 'codex-cli',
                    displayName: 'Codex CLI',
                    icon: '⚡',
                    command: 'codex',
                    category: 'cli',
                    installed: true,
                    path: '/usr/local/bin/codex',
                },
            ];
            invalidateCachedCliInventory!(stubLoader);

            const third: any = await meshOnboardingHandlers.plan_mesh_onboarding(
                { deps: { providerLoader: stubLoader } } as any,
                {
                    workspace: repo,
                    meshId: 'mesh_inv',
                    operation: 'clone_worktree',
                    branch: 'feat/inv-3',
                    inlineMesh: mesh('github.com/acme/project', repo, 'mesh_inv'),
                },
            );
            expect(third.success).toBe(true);
            expect(detectCalls).toEqual([{ includeVersion: false }, { includeVersion: false }]);
            expect(third.suggestedConfig?.providers?.providerPriority).toEqual(['claude-cli', 'codex-cli']);
        } finally {
            setTestOverrides!(null);
        }
    });

    it('marks cold-cache timeout inventory as degraded/unknown, surfaces unknown in planMeshOnboarding, refuses runMeshInit write:true, and never serves stale items after revision change', async () => {
        const repo = makeRepo('mesh-plan-degraded');
        const cliDetector = await import('../../src/detection/cli-detector.js');
        const { runMeshInit } = await import('../../src/mesh/mesh-init.js');
        const getCachedCliInventory = (cliDetector as any).getCachedCliInventory as
            | ((loader?: any, opts?: any) => Promise<any[]>)
            | undefined;
        const isCliInventoryDegraded = (cliDetector as any).isCliInventoryDegraded as
            | ((items: any[]) => boolean)
            | undefined;
        expect(typeof getCachedCliInventory).toBe('function');
        expect(typeof isCliInventoryDegraded).toBe('function');

        let revision = 1;
        let cliEntries = [{
            id: 'hung-cli',
            displayName: 'Hung CLI',
            icon: '🔧',
            command: 'hung-cli',
            category: 'cli',
            enabled: true,
        }];
        const stubLoader: any = {
            getCliDetectionRevision() {
                return revision;
            },
            getCliDetectionList() {
                return cliEntries;
            },
        };
        const hungDetect = async () => {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            return [{ id: 'hung-cli', displayName: 'Hung CLI', icon: '🔧', command: 'hung-cli', installed: true }];
        };

        const startedAt = Date.now();
        const detected = await getCachedCliInventory!(stubLoader, {
            forceRefresh: true,
            budgetMs: 60,
            detectFn: hungDetect,
        });
        const elapsedMs = Date.now() - startedAt;

        expect(elapsedMs).toBeLessThan(500);
        expect(Array.isArray(detected)).toBe(true);
        expect(detected[0]?.id).toBe('hung-cli');
        expect(detected[0]?.degraded).toBe(true);
        expect(detected[0]?.installState).toBe('unknown');
        expect(isCliInventoryDegraded!(detected)).toBe(true);

        // planMeshOnboarding surfaces degraded/unknown status and warns
        const plan = await planMeshOnboarding({
            workspace: repo,
            operation: 'clone_worktree',
            branch: 'feat/degraded-plan',
            meshes: [mesh('github.com/acme/project', repo, 'mesh_deg')],
            detectedProviders: detected,
        });
        expect(plan.success).toBe(true);
        if (plan.success) {
            expect((plan.suggestedConfig.providers as any).degraded).toBe(true);
            expect((plan.suggestedConfig.providers as any).status).toBe('unknown');
            expect(plan.warnings?.some((w) => /unknown|degraded|timed out/i.test(w))).toBe(true);
        }

        // runMeshInit with write:true refuses to persist an empty providerPriority derived from degraded inventory
        expect(() =>
            runMeshInit({}, repo, detected, { write: true }),
        ).toThrow(/degraded|unknown/i);

        // Now warm the cache at revision=1, then bump revision=2 + change CLI list, and time out:
        // must NOT serve stale revision=1 items!
        await getCachedCliInventory!(stubLoader, {
            forceRefresh: true,
            budgetMs: 200,
            detectFn: async () => [{
                id: 'old-cli',
                displayName: 'Old CLI',
                icon: '🔧',
                command: 'old-cli',
                category: 'cli',
                installed: true,
                path: '/usr/bin/old-cli',
            }],
        });
        revision = 2;
        cliEntries = [{
            id: 'new-cli',
            displayName: 'New CLI',
            icon: '✨',
            command: 'new-cli',
            category: 'cli',
            enabled: true,
        }];
        const afterRevisionTimeout = await getCachedCliInventory!(stubLoader, {
            budgetMs: 50,
            detectFn: hungDetect,
        });
        expect(afterRevisionTimeout.map((c) => c.id)).toEqual(['new-cli']);
        expect(afterRevisionTimeout[0]?.degraded).toBe(true);
        expect(afterRevisionTimeout[0]?.installState).toBe('unknown');
    });
});

