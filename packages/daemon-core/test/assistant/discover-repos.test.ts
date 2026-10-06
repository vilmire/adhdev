/**
 * discover_repos scanner (design 2026-10-07-assistant-layer.md §4.4):
 * bounded (depth, directory count, time), returns only
 * {path, repoIdentity, lastCommitAt, alreadyProject}, never file contents.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDiscoverRoots, discoverRepos, explicitDiscoverRoots, readRepoIdentity } from '../../src/assistant/discover-repos.js';

let root: string;
const none = { repoIdentities: new Set<string>(), workspaces: new Set<string>() };

function fakeRepo(path: string, opts: { url?: string; ts?: number; secret?: string } = {}): void {
    mkdirSync(join(path, '.git', 'logs'), { recursive: true });
    writeFileSync(join(path, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const remote = opts.url ? `[remote "upstream"]\n\turl = https://example.com/other/fork.git\n[remote "origin"]\n\turl = ${opts.url}\n` : '';
    writeFileSync(join(path, '.git', 'config'), `[core]\n\tbare = false\n${remote}`);
    if (opts.ts) writeFileSync(join(path, '.git', 'logs', 'HEAD'), `0000 1111 Some One <x@example.com> ${opts.ts} +0900\tcommit: msg\n`);
    if (opts.secret) writeFileSync(join(path, 'README.md'), opts.secret);
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'adhdev-discover-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('discoverRepos', () => {
    it('finds repos to depth 3 with identity, last commit time and alreadyProject — and nothing else', () => {
        fakeRepo(join(root, 'adhdev'), { url: 'git@github.com:vilmire/adhdev.git', ts: 1_760_000_000, secret: 'SECRET-CONTENT' });
        fakeRepo(join(root, 'a', 'b', 'blog'), { url: 'https://github.com/vilmire/blog.git' });
        fakeRepo(join(root, 'a', 'b', 'c', 'too-deep'));
        fakeRepo(join(root, 'scratch'));
        mkdirSync(join(root, '.hidden', 'x'), { recursive: true });
        fakeRepo(join(root, '.hidden', 'x', 'hidden-repo'));
        const r = discoverRepos({
            roots: [{ path: root, depth: 3 }],
            known: { repoIdentities: new Set(['github.com/vilmire/adhdev']), workspaces: new Set([join(root, 'scratch')]) },
        });
        const byPath = Object.fromEntries(r.repos.map((x) => [x.path, x]));
        expect(Object.keys(byPath).sort()).toEqual([join(root, 'a', 'b', 'blog'), join(root, 'adhdev'), join(root, 'scratch')].sort());
        expect(byPath[join(root, 'adhdev')]).toEqual({
            path: join(root, 'adhdev'), repoIdentity: 'github.com/vilmire/adhdev', lastCommitAt: new Date(1_760_000_000_000).toISOString(), alreadyProject: true,
        });
        expect(byPath[join(root, 'a', 'b', 'blog')]).toMatchObject({ repoIdentity: 'github.com/vilmire/blog', alreadyProject: false });
        expect(byPath[join(root, 'scratch')]).toMatchObject({ repoIdentity: null, alreadyProject: true });
        expect(JSON.stringify(r)).not.toContain('SECRET-CONTENT');
        expect(JSON.stringify(r)).not.toContain('x@example.com');
        expect(r.truncated).toBeUndefined();
        expect(r.roots).toEqual([{ path: root, depth: 3, exists: true }]);
    });

    it('stops at the directory cap and at the time budget', () => {
        for (let i = 0; i < 6; i++) mkdirSync(join(root, `d${i}`, 'inner'), { recursive: true });
        expect(discoverRepos({ roots: [{ path: root, depth: 3 }], known: none, maxDirs: 3 })).toMatchObject({ dirsScanned: 3, truncated: 'dirs' });
        let t = 0;
        expect(discoverRepos({ roots: [{ path: root, depth: 3 }], known: none, now: () => (t += 1_000), timeBudgetMs: 2_000 }).truncated).toBe('time');
    });

    it('reports missing roots without failing', () => {
        const r = discoverRepos({ roots: [{ path: join(root, 'nope'), depth: 3 }], known: none });
        expect(r).toMatchObject({ roots: [{ path: join(root, 'nope'), depth: 3, exists: false }], repos: [], dirsScanned: 0 });
    });
});

describe('roots', () => {
    it('defaults: the five code dirs at depth 3, ~ at depth 1, mesh workspace parents at depth 1', () => {
        const roots = defaultDiscoverRoots(['/w/repos/adhdev', 'relative/ignored'], '/home/u');
        expect(roots).toEqual([
            ...['Work', 'code', 'src', 'dev', 'Projects'].map((d) => ({ path: `/home/u/${d}`, depth: 3 })),
            { path: '/home/u', depth: 1 },
            { path: '/w/repos', depth: 1 },
        ]);
    });

    it('explicit roots: absolute or ~-relative only', () => {
        expect(explicitDiscoverRoots(['~/Work', '/abs', 'rel', 3], '/home/u')).toEqual([
            { path: '/home/u/Work', depth: 3 }, { path: '/abs', depth: 3 },
        ]);
    });

    it('identity prefers origin over other remotes', () => {
        fakeRepo(join(root, 'r'), { url: 'https://github.com/vilmire/r.git' });
        expect(readRepoIdentity(join(root, 'r', '.git'))).toBe('github.com/vilmire/r');
    });
});
