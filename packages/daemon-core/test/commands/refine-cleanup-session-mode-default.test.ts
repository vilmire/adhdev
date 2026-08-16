import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DaemonCommandRouter } from '../../src/commands/router';
import {
    cleanupLocalWorktreeNode,
    precheckLocalWorktreeRemovable,
} from '../../src/commands/router-worktree-cleanup';
import { runRefineMergeAndFinalizeLocked } from '../../src/commands/router-refine';
import { createWorktree } from '../../src/git/git-worktree';

const execFileAsync = promisify(execFile);

// router-worktree-cleanup loads git-worktree via a dynamic `await import()`, so a
// spy on the statically-imported module object would never be consulted. Mock the
// module itself and keep every other export real via importActual.
const removeWorktreeMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/git/git-worktree.js', async (importActual) => {
    const actual = await importActual<typeof import('../../src/git/git-worktree.js')>();
    return {
        ...actual,
        removeWorktree: (...args: unknown[]) => (removeWorktreeMock as any).getMockImplementation()
            ? (removeWorktreeMock as any)(...args)
            : (actual.removeWorktree as any)(...args),
    };
});

/**
 * Regression pack for the Refinery cleanup failure caused by a sessionCleanupMode
 * default asymmetry.
 *
 * Refinery and a manual mesh_remove_node share the SAME handler and the same
 * worktree removal code. The only difference was the args they passed: refine
 * ALWAYS computed a mode (an unset policy normalizing to 'preserve'), while
 * mcp-server's buildRemoveNodeArgs OMITS the key when unset. Because the value is
 * a string, it won remove_mesh_node's `??` chain and suppressed the worktree
 * default ('stop_and_delete') — so the delegate session stayed alive, held a lock
 * on the worktree directory, and cleanup failed.
 *
 * Group A pins the args shape; group B pins the fs-fallback reachability; group C
 * pins that merge-failure paths still preserve the worktree.
 */

async function createTempGitRepo(prefix: string) {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    const repoRoot = join(dir, 'repo');
    await execFileAsync('git', ['init', repoRoot]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
    await writeFile(join(repoRoot, 'README.md'), '# test\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot });
    const worktreeBaseDir = join(dir, 'worktrees');
    return { dir, repoRoot, worktreeBaseDir };
}

/**
 * Build a router whose `execute` is spied so refine's cleanup call args can be
 * captured verbatim. Only the sessionCleanupMode key shape is under test here, so
 * remove_mesh_node itself is stubbed out.
 */
function createArgsCapturingRouter() {
    const removeCalls: Array<Record<string, unknown>> = [];
    const router = new DaemonCommandRouter({
        commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
        cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
        cdpManagers: new Map(),
        providerLoader: {} as any,
        instanceManager: {
            collectAllStates: () => [],
            listInstanceIds: () => [],
            getInstance: () => null,
        } as any,
        detectedIdes: { value: [] },
        sessionRegistry: {} as any,
        sessionHostControl: {
            listSessions: vi.fn(async () => []),
            stopSession: vi.fn(async (sessionId: string) => ({ sessionId })),
            deleteSession: vi.fn(async (sessionId: string) => ({ sessionId, deleted: true })),
        } as any,
    });

    const realExecute = router.execute.bind(router);
    vi.spyOn(router, 'execute').mockImplementation(async (command: string, args: any) => {
        if (command === 'remove_mesh_node') {
            removeCalls.push(args ?? {});
            return { success: true, removed: true };
        }
        return realExecute(command as any, args);
    });

    return { router, removeCalls };
}

/**
 * Drive the REAL refine merge/finalize stage end-to-end (bare remote + feature
 * branch + push) so the captured remove_mesh_node args come from
 * router-refine.ts itself. Reproducing the arg construction in the test instead
 * would be tautological — it would stay green with the fix reverted.
 */
async function runRealRefineCleanup(policy: Record<string, unknown>) {
    const dir = await mkdtemp(join(tmpdir(), 'adhdev-refine-real-'));
    const remote = join(dir, 'remote.git');
    const repoRoot = join(dir, 'repo');
    await execFileAsync('git', ['init', '--bare', remote]);
    await execFileAsync('git', ['clone', remote, repoRoot]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
    await writeFile(join(repoRoot, 'README.md'), '# test\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot });
    const { stdout: baseBranchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
    const baseBranch = baseBranchOut.trim();
    await execFileAsync('git', ['push', '-u', 'origin', baseBranch], { cwd: repoRoot });

    const branch = 'feat/refine-real';
    const worktreeBaseDir = join(dir, 'worktrees');
    const created = await createWorktree({ repoRoot, branch, meshName: 'refine-real-mesh', worktreeBaseDir });
    await writeFile(join(created.worktreePath, 'feature.txt'), 'work\n');
    await execFileAsync('git', ['add', 'feature.txt'], { cwd: created.worktreePath });
    await execFileAsync('git', ['commit', '-m', 'feature'], { cwd: created.worktreePath });

    const { stdout: baseHeadOut } = await execFileAsync('git', ['rev-parse', baseBranch], { cwd: repoRoot });
    const { stdout: branchHeadOut } = await execFileAsync('git', ['rev-parse', branch], { cwd: repoRoot });

    const node = {
        id: 'node-worktree',
        workspace: created.worktreePath,
        repoRoot: created.worktreePath,
        isLocalWorktree: true,
        worktreeBranch: branch,
        clonedFromNodeId: 'source',
    };
    const mesh = {
        id: 'mesh-refine-real',
        name: 'refine-real-mesh',
        policy: { worktreeBaseDir, requireApprovalForPush: false, ...policy },
        nodes: [{ id: 'source', workspace: repoRoot, repoRoot }, node],
    };

    const { router, removeCalls } = createArgsCapturingRouter();
    const outcome: any = await runRefineMergeAndFinalizeLocked(router, {
        meshId: mesh.id,
        nodeId: 'node-worktree',
        args: { inlineMesh: mesh },
        refineStages: [],
        execFileAsync: execFileAsync as any,
        mesh,
        node,
        sourceNode: mesh.nodes[0],
        repoRoot,
        branch,
        baseBranch,
        baseHead: baseHeadOut.trim(),
        branchHead: branchHeadOut.trim(),
        validationSummary: { status: 'passed' } as any,
        patchEquivalence: { equivalent: true } as any,
        submoduleReachability: { status: 'passed' } as any,
    });

    return { dir, removeCalls, outcome };
}

describe('A. Refinery cleanup sessionCleanupMode arg shape', () => {
    it('OMITS sessionCleanupMode entirely when the policy does not set it (worktree default survives)', async () => {
        // No sessionCleanupOnNodeRemove — the exact case that regressed.
        const { dir, removeCalls } = await runRealRefineCleanup({});
        try {
            expect(removeCalls).toHaveLength(1);
            // The key must be ABSENT. remove_mesh_node resolves it with a `??`
            // chain, so an omitted key falls through to the worktree default
            // 'stop_and_delete'; a present 'preserve' string short-circuits that
            // chain and leaves the delegate session holding the directory lock.
            expect(Object.prototype.hasOwnProperty.call(removeCalls[0], 'sessionCleanupMode')).toBe(false);
            expect(removeCalls[0].sessionCleanupMode).toBeUndefined();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }, 60000);

    it('honors an explicitly configured policy value verbatim (existing behavior preserved)', async () => {
        for (const mode of ['stop_and_delete', 'stop', 'preserve'] as const) {
            const { dir, removeCalls } = await runRealRefineCleanup({ sessionCleanupOnNodeRemove: mode });
            try {
                expect(removeCalls).toHaveLength(1);
                // An explicit 'preserve' is still passed through — the fix must not
                // silently upgrade a deliberate preserve into a delete.
                expect(removeCalls[0].sessionCleanupMode).toBe(mode);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        }
    }, 120000);
});

describe('B. fs fallback reachability for non-submodule removal failures', () => {
    it('reaches the best-effort fs fallback when removal fails for a NON-submodule reason', async () => {
        const { dir, repoRoot, worktreeBaseDir } = await createTempGitRepo('adhdev-fallback-nonsubmodule-');
        try {
            const branch = 'feat/lock-fallback';
            const meshName = 'lock-fallback-mesh';
            const created = await createWorktree({ repoRoot, branch, meshName, worktreeBaseDir });
            expect(existsSync(created.worktreePath)).toBe(true);

            const node = {
                id: 'node-worktree',
                workspace: created.worktreePath,
                repoRoot: created.worktreePath,
                isLocalWorktree: true,
                worktreeBranch: branch,
                clonedFromNodeId: 'source',
            };
            const mesh = {
                id: 'mesh-lock-fallback',
                name: meshName,
                policy: { worktreeBaseDir },
                nodes: [{ id: 'source', workspace: repoRoot, repoRoot }, node],
            };

            const router = new DaemonCommandRouter({
                commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
                cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
                cdpManagers: new Map(),
                providerLoader: {} as any,
                instanceManager: {
                    collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null,
                } as any,
                detectedIdes: { value: [] },
                sessionRegistry: {} as any,
                sessionHostControl: {} as any,
            });

            const bestEffortSpy = vi.spyOn(router as any, 'bestEffortRemoveWorktreeDir');

            // Simulate a session lock: removal fails with a message that does NOT
            // match the submodule guard regex — exactly the class that previously
            // skipped the fallback outright.
            removeWorktreeMock.mockRejectedValue(
                new Error("fatal: failed to delete '" + created.worktreePath + "': Device or resource busy"),
            );

            const result: any = await cleanupLocalWorktreeNode(router, {
                mesh, node, nodeId: 'node-worktree', force: true,
            });

            // The fallback branch must have been ENTERED — the defining assertion.
            // Before the fix this error text failed the submodule regex, so the
            // whole branch was skipped and cleanup returned success:false.
            expect(result.success).toBe(true);
            // The forced `git worktree remove --force` inside the branch succeeds
            // here (the on-disk worktree is genuinely clean), so recovery stops at
            // that step rather than needing the fs rm. Either way the branch ran.
            expect(result.fallback).toBe('git_worktree_remove_force');
            // The reason must reflect the real cause, not a bogus submodule label.
            expect(result.reason).toBe('worktree_remove_failed');
            expect(result.forced).toBe(true);
            expect(existsSync(created.worktreePath)).toBe(false);

            removeWorktreeMock.mockReset();
            bestEffortSpy.mockRestore();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }, 60000);

    it('falls through to the best-effort fs removal when the forced git remove ALSO fails (non-submodule)', async () => {
        const { dir, repoRoot, worktreeBaseDir } = await createTempGitRepo('adhdev-fallback-fsrm-');
        try {
            const branch = 'feat/fs-rm-fallback';
            const meshName = 'fs-rm-fallback-mesh';
            const created = await createWorktree({ repoRoot, branch, meshName, worktreeBaseDir });

            const node = {
                id: 'node-worktree',
                workspace: created.worktreePath,
                repoRoot: created.worktreePath,
                isLocalWorktree: true,
                worktreeBranch: branch,
                clonedFromNodeId: 'source',
            };
            const mesh = {
                id: 'mesh-fs-rm-fallback',
                name: meshName,
                policy: { worktreeBaseDir },
                nodes: [{ id: 'source', workspace: repoRoot, repoRoot }, node],
            };

            const router = new DaemonCommandRouter({
                commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
                cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
                cdpManagers: new Map(),
                providerLoader: {} as any,
                instanceManager: {
                    collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null,
                } as any,
                detectedIdes: { value: [] },
                sessionRegistry: {} as any,
                sessionHostControl: {} as any,
            });

            // The worktree stays registered (so the earlier "already de-registered
            // residue" recovery path does NOT claim this case). Both git removal
            // steps fail with a NON-submodule error, driving execution to the final
            // best-effort fs removal — the step that was previously unreachable for
            // any non-submodule failure.
            removeWorktreeMock.mockRejectedValue(
                new Error("fatal: failed to delete '" + created.worktreePath + "': Device or resource busy"),
            );
            // Corrupt the worktree's gitdir link so the in-branch `git worktree
            // remove --force` also fails, while git still LISTS the worktree (so the
            // earlier "already de-registered residue" recovery does not claim this
            // case). Execution therefore reaches the final best-effort fs removal.
            await rm(join(created.worktreePath, '.git'), { force: true });

            const bestEffortSpy = vi.spyOn(router as any, 'bestEffortRemoveWorktreeDir');

            const result: any = await cleanupLocalWorktreeNode(router, {
                mesh, node, nodeId: 'node-worktree', force: true,
            });

            expect(bestEffortSpy).toHaveBeenCalledWith(created.worktreePath);
            expect(result.success).toBe(true);
            expect(result.fallback).toBe('fs_rm_worktree_prune');
            expect(result.reason).toBe('worktree_remove_failed');
            expect(existsSync(created.worktreePath)).toBe(false);

            removeWorktreeMock.mockReset();

            bestEffortSpy.mockRestore();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }, 60000);

    it('still refuses a dirty worktree when force was NOT given (no fallback, no data loss)', async () => {
        const { dir, repoRoot, worktreeBaseDir } = await createTempGitRepo('adhdev-fallback-dirty-');
        try {
            const branch = 'feat/dirty-guard';
            const meshName = 'dirty-guard-mesh';
            const created = await createWorktree({ repoRoot, branch, meshName, worktreeBaseDir });
            // Uncommitted work in the worktree — must never be force-removed.
            await writeFile(join(created.worktreePath, 'uncommitted.txt'), 'precious\n');

            const node = {
                id: 'node-worktree',
                workspace: created.worktreePath,
                repoRoot: created.worktreePath,
                isLocalWorktree: true,
                worktreeBranch: branch,
                clonedFromNodeId: 'source',
            };
            const mesh = {
                id: 'mesh-dirty-guard',
                name: meshName,
                policy: { worktreeBaseDir },
                nodes: [{ id: 'source', workspace: repoRoot, repoRoot }, node],
            };

            const router = new DaemonCommandRouter({
                commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
                cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
                cdpManagers: new Map(),
                providerLoader: {} as any,
                instanceManager: {
                    collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null,
                } as any,
                detectedIdes: { value: [] },
                sessionRegistry: {} as any,
                // An EMPTY session inventory, not an empty stub: the precheck's
                // live-occupancy guard fails closed when it cannot enumerate
                // sessions, and would otherwise mask the dirty refusal this test
                // is about. Idle-and-dirty is the case under test.
                sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
            });
            const bestEffortSpy = vi.spyOn(router as any, 'bestEffortRemoveWorktreeDir');

            // The dirty refusal is enforced by the non-destructive precheck that
            // remove_mesh_node runs BEFORE cleanup — that is the guard that must
            // still fire, since the widened fallback gate sits downstream of it.
            const precheck: any = await precheckLocalWorktreeRemovable(router, {
                mesh, node, nodeId: 'node-worktree', force: false,
            });

            expect(precheck.ok).toBe(false);
            expect(precheck.code).toBe('mesh_worktree_cleanup_dirty');
            // The widened gate must NOT have swallowed the dirty refusal.
            expect(bestEffortSpy).not.toHaveBeenCalled();
            expect(existsSync(join(created.worktreePath, 'uncommitted.txt'))).toBe(true);

            bestEffortSpy.mockRestore();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }, 60000);
});

describe('C. merge-failure paths still preserve the worktree', () => {
    it('does not remove the node when the branch is not merged — branch ref is preserved', async () => {
        const { dir, repoRoot, worktreeBaseDir } = await createTempGitRepo('adhdev-unmerged-preserve-');
        try {
            const branch = 'feat/unmerged-work';
            const meshName = 'unmerged-mesh';
            const created = await createWorktree({ repoRoot, branch, meshName, worktreeBaseDir });
            // Real, committed, UNMERGED work on the branch.
            await writeFile(join(created.worktreePath, 'feature.txt'), 'unmerged work\n');
            await execFileAsync('git', ['add', 'feature.txt'], { cwd: created.worktreePath });
            await execFileAsync('git', ['commit', '-m', 'unmerged feature'], { cwd: created.worktreePath });

            const node = {
                id: 'node-worktree',
                workspace: created.worktreePath,
                repoRoot: created.worktreePath,
                isLocalWorktree: true,
                worktreeBranch: branch,
                clonedFromNodeId: 'source',
            };
            const mesh = {
                id: 'mesh-unmerged',
                name: meshName,
                policy: { worktreeBaseDir },
                nodes: [{ id: 'source', workspace: repoRoot, repoRoot }, node],
            };

            const router = new DaemonCommandRouter({
                commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
                cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
                cdpManagers: new Map(),
                providerLoader: {} as any,
                instanceManager: {
                    collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null,
                } as any,
                detectedIdes: { value: [] },
                sessionRegistry: {} as any,
                sessionHostControl: {} as any,
            });

            // force:true removes the worktree DIRECTORY (refine only reaches cleanup
            // post-merge), but branch-ref deletion keys off mergeConvergence, NOT the
            // force flag — so an unmerged branch ref must survive. This is the
            // property the widened fallback gate could plausibly have broken.
            const result: any = await cleanupLocalWorktreeNode(router, {
                mesh, node, nodeId: 'node-worktree', force: true,
            });

            expect(result.success).toBe(true);
            expect(result.branchRefDeleted).toBe(false);
            expect(String(result.branchRefReason)).toContain('branch_not_merged_preserved');

            // The commit must still be reachable through the preserved branch ref.
            const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%s', branch], { cwd: repoRoot });
            expect(stdout.trim()).toBe('unmerged feature');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }, 60000);
});
