import { describe, expect, it, vi, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DaemonCommandRouter } from '../../src/commands/router';
import { precheckLocalWorktreeRemovable } from '../../src/commands/router-worktree-cleanup';
import { createWorktree } from '../../src/git/git-worktree';

const execFileAsync = promisify(execFile);

/**
 * WORKTREE-DELETED-WHILE-RUNNING (2026-08-16) regression pack.
 *
 * A delegated worker had its worktree directory deleted while it was actively
 * working in it, losing everything not already pushed. Two guards that would
 * each have prevented that were missing from the manual removal path:
 *
 *   1. LIVE OCCUPANCY. `mesh_remove_node` prechecked only metadata / path /
 *      branch / dirtiness, then — for a worktree, whose default session cleanup
 *      mode is `stop_and_delete` — killed the session and deleted the
 *      directory. Nothing asked whether an agent was still working there. The
 *      retention reaper already refused on a live session, fail-closed; the
 *      manual path did not.
 *
 *   2. UNPUSHED COMMITS. The dirty guard sees only UNCOMMITTED changes. A
 *      worker who committed (as workers are told to, precisely so work
 *      survives) but had not yet pushed left a clean `git status`, so the
 *      removal proceeded and the commits died with the directory.
 *
 * Both guards live in `precheckLocalWorktreeRemovable`, which runs BEFORE the
 * destructive session cleanup — so a refusal leaves the session intact — and is
 * shared by the manual and retention paths. Both honor `force:true`.
 *
 * These tests drive REAL git repos and the REAL precheck. Reverting either
 * guard turns the corresponding `expect(...ok).toBe(false)` red.
 */

const tempDirs: string[] = [];

afterAll(async () => {
    for (const dir of tempDirs) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
});

/**
 * A real source repo + a real managed worktree at the path the precheck's
 * `resolveWorktreePath` will expect, so the run reaches the occupancy/unpushed
 * guards instead of short-circuiting on an `unexpected_path` refusal.
 *
 * `withRemote` controls whether the branch's commits exist on a remote, which
 * is exactly what the unpushed-commit guard keys on.
 */
async function buildWorktreeFixture(opts: { branch: string; withRemote: boolean }) {
    const dir = await mkdtemp(join(tmpdir(), 'adhdev-occupancy-'));
    tempDirs.push(dir);
    const repoRoot = join(dir, 'repo');

    if (opts.withRemote) {
        const remote = join(dir, 'remote.git');
        await execFileAsync('git', ['init', '-q', '--bare', remote]);
        await execFileAsync('git', ['clone', '-q', remote, repoRoot]);
    } else {
        await execFileAsync('git', ['init', '-q', repoRoot]);
    }
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
    await writeFile(join(repoRoot, 'README.md'), '# test\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repoRoot });
    if (opts.withRemote) {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
        await execFileAsync('git', ['push', '-q', '-u', 'origin', stdout.trim()], { cwd: repoRoot });
    }

    const meshName = 'occupancy-mesh';
    const worktreeBaseDir = join(dir, 'worktrees');
    const created = await createWorktree({ repoRoot, branch: opts.branch, meshName, worktreeBaseDir });

    const node = {
        id: 'node-worktree',
        workspace: created.worktreePath,
        isLocalWorktree: true,
        worktreeBranch: opts.branch,
        clonedFromNodeId: 'source',
    };
    const mesh = {
        id: 'mesh-occupancy',
        name: meshName,
        policy: { worktreeBaseDir },
        nodes: [{ id: 'source', workspace: repoRoot, repoRoot }, node],
    };
    return { dir, repoRoot, worktreePath: created.worktreePath, node, mesh };
}

/** A router whose only relevant collaborator is the session inventory. */
function createRouter(listSessions: (() => Promise<any[]>) | null) {
    return new DaemonCommandRouter({
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
        sessionHostControl: listSessions
            ? ({
                listSessions: vi.fn(listSessions),
                stopSession: vi.fn(async (sessionId: string) => ({ sessionId })),
                deleteSession: vi.fn(async (sessionId: string) => ({ sessionId, deleted: true })),
            } as any)
            : undefined,
    });
}

/** A session record the live-runtime surface classifier treats as live. */
function liveSessionOn(workspace: string, sessionId = 'sess-live') {
    return { sessionId, workspace, lifecycle: 'running', status: 'generating' };
}

describe('A. live-occupancy guard', () => {
    it('refuses removal while a live session is still working in the worktree', async () => {
        const { node, mesh, worktreePath } = await buildWorktreeFixture({ branch: 'fix/occupied', withRemote: true });
        const router = createRouter(async () => [liveSessionOn(worktreePath)]);

        const result = await precheckLocalWorktreeRemovable(router, { mesh, node, nodeId: node.id });

        // The defect: this used to be ok:true, and the caller went on to
        // stop_and_delete the session and delete the directory under it.
        expect(result.ok).toBe(false);
        if (result.ok === false) {
            expect(result.code).toBe('mesh_worktree_cleanup_live_session');
            expect(result.error).toContain('sess-live');
            // The precheck is the pre-session-cleanup gate; a refusal here must
            // advertise that the session was left running.
            expect(result.recoveryHint).toContain('left running');
        }
    }, 60_000);

    it('allows removal when only STOPPED session records match (they are not live)', async () => {
        const { node, mesh, worktreePath } = await buildWorktreeFixture({ branch: 'fix/stopped', withRemote: true });
        const router = createRouter(async () => [
            { sessionId: 'sess-done', workspace: worktreePath, lifecycle: 'stopped' },
        ]);

        const result = await precheckLocalWorktreeRemovable(router, { mesh, node, nodeId: node.id });
        expect(result.ok).toBe(true);
    }, 60_000);

    it('fails CLOSED when the session inventory is unavailable — never assumes idle', async () => {
        const { node, mesh } = await buildWorktreeFixture({ branch: 'fix/no-host', withRemote: true });
        const router = createRouter(null); // no sessionHostControl at all

        const result = await precheckLocalWorktreeRemovable(router, { mesh, node, nodeId: node.id });
        expect(result.ok).toBe(false);
        if (result.ok === false) {
            expect(result.code).toBe('mesh_worktree_cleanup_live_session_unverified');
        }
    }, 60_000);

    it('fails CLOSED when listSessions throws', async () => {
        const { node, mesh } = await buildWorktreeFixture({ branch: 'fix/host-throws', withRemote: true });
        const router = createRouter(async () => { throw new Error('session host down'); });

        const result = await precheckLocalWorktreeRemovable(router, { mesh, node, nodeId: node.id });
        expect(result.ok).toBe(false);
        if (result.ok === false) {
            expect(result.code).toBe('mesh_worktree_cleanup_live_session_unverified');
            expect(result.error).toContain('session host down');
        }
    }, 60_000);

    it('force:true overrides the occupancy guard (documented operator escape hatch)', async () => {
        const { node, mesh, worktreePath } = await buildWorktreeFixture({ branch: 'fix/forced', withRemote: true });
        const router = createRouter(async () => [liveSessionOn(worktreePath)]);

        const result = await precheckLocalWorktreeRemovable(router, { mesh, node, nodeId: node.id, force: true });
        expect(result.ok).toBe(true);
    }, 60_000);
});

describe('B. unpushed-commit guard', () => {
    it('refuses removal when the branch holds commits that exist on no remote', async () => {
        const { node, mesh, worktreePath } = await buildWorktreeFixture({ branch: 'fix/unpushed', withRemote: true });
        // The worker commits — as instructed — but has not pushed yet.
        await writeFile(join(worktreePath, 'work.txt'), 'hours of work\n');
        await execFileAsync('git', ['add', 'work.txt'], { cwd: worktreePath });
        await execFileAsync('git', ['commit', '-qm', 'work in progress'], { cwd: worktreePath });

        // Ground truth: the dirty guard cannot see this — the tree is CLEAN.
        const { stdout: porcelain } = await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreePath });
        expect(porcelain.trim()).toBe('');

        const router = createRouter(async () => []);
        const result = await precheckLocalWorktreeRemovable(router, { mesh, node, nodeId: node.id });

        expect(result.ok).toBe(false);
        if (result.ok === false) {
            expect(result.code).toBe('mesh_worktree_cleanup_unpushed_commits');
            expect(result.error).toContain('not present on any remote');
        }
    }, 60_000);

    it('allows removal once those commits are pushed', async () => {
        const { node, mesh, worktreePath } = await buildWorktreeFixture({ branch: 'fix/pushed', withRemote: true });
        await writeFile(join(worktreePath, 'work.txt'), 'hours of work\n');
        await execFileAsync('git', ['add', 'work.txt'], { cwd: worktreePath });
        await execFileAsync('git', ['commit', '-qm', 'work in progress'], { cwd: worktreePath });
        await execFileAsync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/fix/pushed'], { cwd: worktreePath });

        const router = createRouter(async () => []);
        const result = await precheckLocalWorktreeRemovable(router, { mesh, node, nodeId: node.id });
        expect(result.ok).toBe(true);
    }, 60_000);

    it('does NOT fire in a repo with no remote — there is nowhere to push to', async () => {
        // Without this scope, every commit in a purely local repo reads as
        // "unpushed" and the guard blocks every legitimate cleanup — a guard
        // that can never be satisfied is one operators learn to force past,
        // which would erode the occupancy guard alongside it.
        const { node, mesh, worktreePath } = await buildWorktreeFixture({ branch: 'fix/no-remote', withRemote: false });
        await writeFile(join(worktreePath, 'work.txt'), 'local only\n');
        await execFileAsync('git', ['add', 'work.txt'], { cwd: worktreePath });
        await execFileAsync('git', ['commit', '-qm', 'local work'], { cwd: worktreePath });

        const router = createRouter(async () => []);
        const result = await precheckLocalWorktreeRemovable(router, { mesh, node, nodeId: node.id });
        expect(result.ok).toBe(true);
    }, 60_000);

    it('force:true overrides the unpushed guard', async () => {
        const { node, mesh, worktreePath } = await buildWorktreeFixture({ branch: 'fix/unpushed-forced', withRemote: true });
        await writeFile(join(worktreePath, 'work.txt'), 'work\n');
        await execFileAsync('git', ['add', 'work.txt'], { cwd: worktreePath });
        await execFileAsync('git', ['commit', '-qm', 'wip'], { cwd: worktreePath });

        const router = createRouter(async () => []);
        const result = await precheckLocalWorktreeRemovable(router, { mesh, node, nodeId: node.id, force: true });
        expect(result.ok).toBe(true);
    }, 60_000);
});

describe('C. guard ordering', () => {
    it('reports the live session first when a worktree is BOTH occupied and unpushed', async () => {
        // Occupancy is the stronger objection: a busy worktree must not be
        // removed even when its content is safe, and naming the session is what
        // tells an operator who to wait for.
        const { node, mesh, worktreePath } = await buildWorktreeFixture({ branch: 'fix/both', withRemote: true });
        await writeFile(join(worktreePath, 'work.txt'), 'work\n');
        await execFileAsync('git', ['add', 'work.txt'], { cwd: worktreePath });
        await execFileAsync('git', ['commit', '-qm', 'wip'], { cwd: worktreePath });

        const router = createRouter(async () => [liveSessionOn(worktreePath)]);
        const result = await precheckLocalWorktreeRemovable(router, { mesh, node, nodeId: node.id });

        expect(result.ok).toBe(false);
        if (result.ok === false) expect(result.code).toBe('mesh_worktree_cleanup_live_session');
    }, 60_000);

    it('reports the DIRTY refusal ahead of the unpushed one (dirty is the more actionable code)', async () => {
        // A dirty worktree is almost always also unpushed. Ordering the unpushed
        // guard first would have silently relabelled every existing dirty
        // refusal, which callers and older tests branch on by code.
        const { node, mesh, worktreePath } = await buildWorktreeFixture({ branch: 'fix/dirty-and-unpushed', withRemote: true });
        await writeFile(join(worktreePath, 'committed.txt'), 'committed\n');
        await execFileAsync('git', ['add', 'committed.txt'], { cwd: worktreePath });
        await execFileAsync('git', ['commit', '-qm', 'unpushed commit'], { cwd: worktreePath });
        await writeFile(join(worktreePath, 'uncommitted.txt'), 'uncommitted\n');

        const router = createRouter(async () => []);
        const result = await precheckLocalWorktreeRemovable(router, { mesh, node, nodeId: node.id });

        expect(result.ok).toBe(false);
        if (result.ok === false) expect(result.code).toBe('mesh_worktree_cleanup_dirty');
    }, 60_000);
});
