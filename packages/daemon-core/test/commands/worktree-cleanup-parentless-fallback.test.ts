import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
import { cleanupLocalWorktreeNode, precheckLocalWorktreeRemovable, bestEffortRemoveWorktreeDir, getWorktreeForceCleanupConvergence } from '../../src/commands/router-worktree-cleanup.js';
import { resolveLinkedWorktreeSource } from '../../src/git/linked-worktree-source.js';

const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('worktree removal when the parent node is gone', () => {
    let root: string;
    let repo: string;
    let baseDir: string;
    let self: any;

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-parentless-')));
        repo = path.join(root, 'repo');
        baseDir = path.join(root, 'wtbase');
        fs.mkdirSync(repo);
        git(repo, 'init', '-q', '-b', 'main');
        git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
        self = { deps: { sessionHostControl: { listSessions: async () => [] } } };
        self.bestEffortRemoveWorktreeDir = (dir: string) => bestEffortRemoveWorktreeDir(self, dir);
        self.getWorktreeForceCleanupConvergence = (a: any) => getWorktreeForceCleanupConvergence(self, a);
    });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    const addWorktree = () => {
        const wt = path.join(baseDir, 'm', 'feat-x');
        fs.mkdirSync(path.dirname(wt), { recursive: true });
        git(repo, 'worktree', 'add', '-q', '-b', 'feat-x', wt);
        return wt;
    };
    const mesh = () => ({ id: 'm', name: 'm', policy: { worktreeBaseDir: baseDir }, nodes: [] as any[] });
    const nodeFor = (wt: string) => ({ id: 'n1', workspace: wt, repoRoot: wt, isLocalWorktree: true, worktreeBranch: 'feat-x', clonedFromNodeId: 'gone' });

    it('resolves the source repo of a real linked worktree', async () => {
        const wt = addWorktree();
        const r = await resolveLinkedWorktreeSource(wt);
        expect(r.ok).toBe(true);
        if (r.ok) expect(fs.realpathSync(r.repoRoot)).toBe(repo);
    });

    it('refuses a main checkout and an unrelated plain directory', async () => {
        expect((await resolveLinkedWorktreeSource(repo)).ok).toBe(false);
        const plain = path.join(root, 'plain');
        fs.mkdirSync(plain);
        expect((await resolveLinkedWorktreeSource(plain)).ok).toBe(false);
    });

    it('refuses a forged .git pointer without a matching back-link', async () => {
        const wt = addWorktree();
        const other = path.join(root, 'other');
        fs.mkdirSync(other);
        fs.copyFileSync(path.join(wt, '.git'), path.join(other, '.git'));
        expect((await resolveLinkedWorktreeSource(other)).ok).toBe(false);
    });

    it('precheck and cleanup remove the worktree with no parent node', async () => {
        const wt = addWorktree();
        const args = { mesh: mesh(), node: nodeFor(wt), nodeId: 'n1' };
        expect((await precheckLocalWorktreeRemovable(self, args)).ok).toBe(true);
        const res: any = await cleanupLocalWorktreeNode(self, args);
        expect(res.success).toBe(true);
        expect(fs.existsSync(wt)).toBe(false);
    });

    it('never deletes a directory that is not a linked worktree of a real repo', async () => {
        const fake = path.join(baseDir, 'm', 'feat-x');
        fs.mkdirSync(fake, { recursive: true });
        fs.writeFileSync(path.join(fake, 'keep.txt'), 'x');
        const res: any = await cleanupLocalWorktreeNode(self, { mesh: mesh(), node: nodeFor(fake), nodeId: 'n1' });
        expect(res.success).toBe(false);
        expect(res.code).toBe('mesh_worktree_cleanup_missing_source_repo');
        expect(fs.existsSync(path.join(fake, 'keep.txt'))).toBe(true);
    });
});
