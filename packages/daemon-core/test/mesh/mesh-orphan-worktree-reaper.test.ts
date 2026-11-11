import { describe, expect, it, afterEach, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';

const testConfigDir = join(tmpdir(), `adhdev-orphan-reaper-test-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'local-daemon' }),
    getMachineId: () => 'local-daemon',
    getMachineNickname: () => null,
}));

import { reapOrphanWorktrees, type OrphanReapDeps } from '../../src/mesh/mesh-orphan-worktree-reaper.js';
import { __clearLocalRecordsForTests } from '../../src/mesh/mesh-local-records.js';
import { seedLocalRecord } from '../helpers/local-records.js';

const HOUR = 3_600_000;
const NOW = Date.now();
const DETECTED = NOW - 72 * HOUR; // past the 48h default grace

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

interface Fixture { root: string; repo: string; base: string; mesh: any; meshId: string; wt: (n: string) => string; subRemote: string }

function makeFixture(withSubmodule: boolean): Fixture {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orphan-reaper-')));
    const origin = join(root, 'origin.git');
    const subRemote = join(root, 'sub.git');
    git(root, 'init', '--bare', '-b', 'main', origin);
    git(root, 'init', '--bare', '-b', 'main', subRemote);
    const subSeed = join(root, 'subseed');
    git(root, 'clone', subRemote, subSeed);
    writeFileSync(join(subSeed, 's.txt'), 's');
    git(subSeed, 'add', '.'); git(subSeed, 'commit', '-m', 's'); git(subSeed, 'push', 'origin', 'HEAD:main');
    const repo = join(root, 'repo');
    git(root, 'clone', origin, repo);
    git(repo, 'checkout', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'add', '.');
    if (withSubmodule) git(repo, 'submodule', 'add', subRemote, 'oss');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'push', 'origin', 'main');
    const base = join(root, 'wtbase');
    const meshId = `orphan-${randomUUID().slice(0, 8)}`;
    const mesh = {
        id: meshId, name: 'm1', policy: { worktreeBaseDir: base },
        nodes: [{ id: 'base', isLocalWorktree: false, workspace: repo, repoRoot: repo }],
    };
    return { root, repo, base, mesh, meshId, subRemote, wt: (n: string) => join(base, 'm1', n) };
}

function addWorktree(f: Fixture, name: string, submodule: boolean): string {
    const p = f.wt(name);
    git(f.repo, 'worktree', 'add', p, '-b', `feat/${name}`);
    if (submodule) git(p, 'submodule', 'update', '--init');
    mkdirSync(join(p, 'node_modules'), { recursive: true });
    writeFileSync(join(p, 'node_modules', 'big.bin'), 'x'); // ignored build output
    return p;
}

function signal(f: Fixture, path: string, at = DETECTED) {
    seedLocalRecord(f.meshId, {
        kind: 'worktree_cleanup_candidate',
        payload: { worktreePath: path, reason: 'no_matching_live_node', state: 'cleanup_candidate', detectedAt: new Date(at).toISOString() },
    });
}

const noSessions: OrphanReapDeps = { listSessions: async () => [], cwd: () => '/' };
const roots: string[] = [];

describe('reapOrphanWorktrees', () => {
    let f: Fixture;
    const setup = (sub = false) => { f = makeFixture(sub); roots.push(f.root); return f; };
    beforeEach(() => { delete process.env.MESH_WORKTREE_NODE_RETENTION_GRACE_MS; });
    afterEach(() => { if (f) __clearLocalRecordsForTests(f.meshId); delete process.env.MESH_WORKTREE_NODE_RETENTION_GRACE_MS; });
    afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

    const adminEntry = (name: string) => join(f.repo, '.git', 'worktrees', name);

    it('removes a clean, pushed, managed orphan past grace and its git admin entry', async () => {
        setup();
        const p = addWorktree(f, 'done1', false);
        signal(f, p);
        expect(existsSync(adminEntry('done1'))).toBe(true);
        const out = await reapOrphanWorktrees(f.mesh, noSessions, NOW);
        expect(out).toEqual([{ path: p, reason: 'removed', removed: true }]);
        expect(existsSync(p)).toBe(false);
        expect(existsSync(adminEntry('done1'))).toBe(false);
        expect(git(f.repo, 'branch', '--list', 'feat/done1').trim()).toBe(''); // pushed → safe -d
    });

    it('removes an orphan containing an initialized, clean submodule (modules/ copy gone)', async () => {
        setup(true);
        const p = addWorktree(f, 'sub-ok', true);
        signal(f, p);
        const out = await reapOrphanWorktrees(f.mesh, noSessions, NOW);
        expect(out[0]).toMatchObject({ reason: 'removed', removed: true });
        expect(existsSync(p)).toBe(false);
        expect(existsSync(adminEntry('sub-ok'))).toBe(false);
    });

    it('second pass after removal is a no-op', async () => {
        setup();
        const p = addWorktree(f, 'twice', false);
        signal(f, p);
        await reapOrphanWorktrees(f.mesh, noSessions, NOW);
        expect(await reapOrphanWorktrees(f.mesh, noSessions, NOW)).toEqual([]);
    });

    it('skips within grace', async () => {
        setup();
        const p = addWorktree(f, 'young', false);
        signal(f, p, NOW - 1 * HOUR);
        const out = await reapOrphanWorktrees(f.mesh, noSessions, NOW);
        expect(out[0]).toMatchObject({ reason: 'within_grace', removed: false });
        expect(existsSync(p)).toBe(true);
    });

    it('skips (and does not remove) when there is no candidate record yet', async () => {
        setup();
        const p = addWorktree(f, 'unseen', false);
        const out = await reapOrphanWorktrees(f.mesh, noSessions, NOW);
        expect(out[0]).toMatchObject({ reason: 'no_candidate_record', removed: false });
        expect(existsSync(p)).toBe(true);
    });

    it('uses the earliest detectedAt when a later re-signal exists', async () => {
        setup();
        const p = addWorktree(f, 'resig', false);
        signal(f, p, DETECTED);
        signal(f, p, NOW - HOUR);
        expect((await reapOrphanWorktrees(f.mesh, noSessions, NOW))[0].reason).toBe('removed');
    });

    it('skips when dirty (untracked, non-ignored file)', async () => {
        setup();
        const p = addWorktree(f, 'dirty', false);
        writeFileSync(join(p, 'new.txt'), 'wip');
        signal(f, p);
        expect((await reapOrphanWorktrees(f.mesh, noSessions, NOW))[0]).toMatchObject({ reason: 'dirty', removed: false });
        expect(existsSync(p)).toBe(true);
    });

    it('skips when it has unpushed commits', async () => {
        setup();
        const p = addWorktree(f, 'unpushed', false);
        writeFileSync(join(p, 'c.txt'), 'c');
        git(p, 'add', '.'); git(p, 'commit', '-m', 'local only');
        signal(f, p);
        expect((await reapOrphanWorktrees(f.mesh, noSessions, NOW))[0]).toMatchObject({ reason: 'unpushed_commits', removed: false });
        expect(existsSync(p)).toBe(true);
    });

    it('skips a detached HEAD whose commit is on no remote', async () => {
        setup();
        const p = addWorktree(f, 'detached', false);
        writeFileSync(join(p, 'c.txt'), 'c');
        git(p, 'add', '.'); git(p, 'commit', '-m', 'x');
        git(p, 'checkout', '--detach');
        signal(f, p);
        expect((await reapOrphanWorktrees(f.mesh, noSessions, NOW))[0]).toMatchObject({ reason: 'unpushed_commits', removed: false });
    });

    it('skips when a submodule has a commit absent from its remote (root pushed)', async () => {
        setup(true);
        const p = addWorktree(f, 'sub-unpushed', true);
        writeFileSync(join(p, 'oss', 'n.txt'), 'n');
        git(join(p, 'oss'), 'add', '.'); git(join(p, 'oss'), 'commit', '-m', 'sub local');
        git(p, 'add', 'oss'); git(p, 'commit', '-m', 'bump oss');
        git(p, 'push', 'origin', 'HEAD:refs/heads/feat/sub-unpushed');
        signal(f, p);
        expect((await reapOrphanWorktrees(f.mesh, noSessions, NOW))[0]).toMatchObject({ reason: 'submodule_unpushed', removed: false });
        expect(existsSync(p)).toBe(true);
    });

    it('skips when a submodule is dirty', async () => {
        setup(true);
        const p = addWorktree(f, 'sub-dirty', true);
        writeFileSync(join(p, 'oss', 's.txt'), 'changed');
        signal(f, p);
        const r = (await reapOrphanWorktrees(f.mesh, noSessions, NOW))[0];
        expect(r.removed).toBe(false);
        expect(['dirty', 'submodule_dirty']).toContain(r.reason);
        expect(existsSync(p)).toBe(true);
    });

    it('skips a path outside the managed base dir', async () => {
        setup();
        const outside = join(f.root, 'elsewhere', 'wt');
        git(f.repo, 'worktree', 'add', outside, '-b', 'feat/outside');
        signal(f, outside);
        expect((await reapOrphanWorktrees(f.mesh, noSessions, NOW))[0]).toMatchObject({ reason: 'outside_managed_base', removed: false });
        expect(existsSync(outside)).toBe(true);
    });

    it('skips when a live session works inside it', async () => {
        setup();
        const p = addWorktree(f, 'busy', false);
        signal(f, p);
        const deps: OrphanReapDeps = { cwd: () => '/', listSessions: async () => [{ sessionId: 's1', surfaceKind: 'live_runtime', workspace: join(p, 'packages') }] as any };
        const out = await reapOrphanWorktrees(f.mesh, deps, NOW);
        expect(out[0]).toMatchObject({ reason: 'session_inside', removed: false });
        expect(existsSync(p)).toBe(true);
    });

    it('skips when session inventory is unavailable (fail closed)', async () => {
        setup();
        const p = addWorktree(f, 'noinv', false);
        signal(f, p);
        const out = await reapOrphanWorktrees(f.mesh, { cwd: () => '/', listSessions: async () => { throw new Error('down'); } }, NOW);
        expect(out[0]).toMatchObject({ reason: 'session_inventory_unavailable', removed: false });
    });

    it('skips when process cwd is inside it', async () => {
        setup();
        const p = addWorktree(f, 'cwd', false);
        signal(f, p);
        const out = await reapOrphanWorktrees(f.mesh, { listSessions: async () => [], cwd: () => join(p, 'node_modules') }, NOW);
        expect(out[0]).toMatchObject({ reason: 'process_cwd_inside', removed: false });
    });

    it('grace 0 disables removal entirely', async () => {
        setup();
        const p = addWorktree(f, 'off', false);
        signal(f, p);
        process.env.MESH_WORKTREE_NODE_RETENTION_GRACE_MS = '0';
        expect(await reapOrphanWorktrees(f.mesh, noSessions, NOW)).toEqual([]);
        expect(existsSync(p)).toBe(true);
    });
});

describe('resolveLocalBaseRepoRoot', () => {
    it('skips another machine\'s base checkout whose path does not exist here', async () => {
        const { resolveLocalBaseRepoRoot } = await import('../../src/mesh/mesh-disk-retention.js');
        const local = realpathSync(mkdtempSync(join(tmpdir(), 'base-')));
        execFileSync('git', ['init', '-q', local]);
        try {
            const root = resolveLocalBaseRepoRoot([
                { isLocalWorktree: false, repoRoot: join(tmpdir(), `missing-${randomUUID()}`) },
                { isLocalWorktree: true, repoRoot: local },
                { isLocalWorktree: false, workspace: local },
            ]);
            expect(root).toBe(local);
            expect(resolveLocalBaseRepoRoot([{ isLocalWorktree: false, repoRoot: join(tmpdir(), `missing-${randomUUID()}`) }])).toBeUndefined();
        } finally {
            rmSync(local, { recursive: true, force: true });
        }
    });
});
