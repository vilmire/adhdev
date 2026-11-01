import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, git, type MissionGitFixture } from './mission-git-fixture.js';
import { probeCommitContainment, resolveBase, resolveBranchSha } from '../../src/mesh/mission-ref-containment.js';

// Design 2026-11-01-mission-git-refs §8 acceptance 1-7, 12: real git repositories, no stubs.
let fx: MissionGitFixture;
afterEach(() => fx?.cleanup());

const base = (repo: string) => resolveBase(repo, 'main')!;

describe('mission ref containment (real git)', () => {
    it('1. a merged commit is contained_ancestor', async () => {
        fx = makeFixture();
        git(fx.work, 'checkout', '-q', '-b', 'feat');
        const f = fx.commit('f.txt', 'f\n', 'feat work');
        git(fx.work, 'checkout', '-q', 'main');
        git(fx.work, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat');
        git(fx.work, 'push', '-q', 'origin', 'main');
        const v = await probeCommitContainment(fx.work, base(fx.work), f, { tryCherry: true });
        expect(v).toMatchObject({ status: 'contained_ancestor', method: 'ancestry' });
        expect(base(fx.work).name).toBe('origin/main');
    });

    it('2. a cherry-picked commit (different SHA on main) is contained_patch_equivalent via cherry', async () => {
        fx = makeFixture();
        git(fx.work, 'checkout', '-q', '-b', 'feat');
        const f = fx.commit('f.txt', 'f\n', 'feat work');
        git(fx.work, 'checkout', '-q', 'main');
        fx.commit('other.txt', 'o\n', 'unrelated main work');
        git(fx.work, 'cherry-pick', f);
        git(fx.work, 'push', '-q', 'origin', 'main');
        const v = await probeCommitContainment(fx.work, base(fx.work), f, { tryCherry: true });
        expect(v).toMatchObject({ status: 'contained_patch_equivalent', method: 'cherry' });
    });

    it('3a. a squash-merged multi-commit branch is contained_patch_equivalent via residual_patch', async () => {
        fx = makeFixture();
        git(fx.work, 'checkout', '-q', '-b', 'feat');
        fx.commit('a.txt', 'a\n', 'feat 1');
        const tip = fx.commit('b.txt', 'b\n', 'feat 2');
        git(fx.work, 'checkout', '-q', 'main');
        fx.commit('other.txt', 'o\n', 'unrelated main work');
        git(fx.work, 'merge', '-q', '--squash', 'feat');
        git(fx.work, 'commit', '-q', '-m', 'squash feat');
        git(fx.work, 'push', '-q', 'origin', 'main');
        const v = await probeCommitContainment(fx.work, base(fx.work), tip, { tryCherry: false });
        expect(v).toMatchObject({ status: 'contained_patch_equivalent', method: 'residual_patch' });
    });

    it('3b. a branch rebased onto main before landing (new SHAs) is contained_patch_equivalent via residual_patch', async () => {
        fx = makeFixture();
        git(fx.work, 'checkout', '-q', '-b', 'feat');
        fx.commit('a.txt', 'a\n', 'feat 1');
        const tip = fx.commit('b.txt', 'b\n', 'feat 2');
        git(fx.work, 'checkout', '-q', 'main');
        fx.commit('other.txt', 'o\n', 'unrelated main work');
        git(fx.work, 'checkout', '-q', '-b', 'feat-rebased', tip);
        git(fx.work, 'rebase', '-q', 'main');
        git(fx.work, 'checkout', '-q', 'main');
        git(fx.work, 'merge', '-q', '--ff-only', 'feat-rebased');
        git(fx.work, 'push', '-q', 'origin', 'main');
        expect(() => git(fx.work, 'merge-base', '--is-ancestor', tip, 'main')).toThrow(); // the original tip is NOT an ancestor of main
        const v = await probeCommitContainment(fx.work, base(fx.work), tip, { tryCherry: false });
        expect(v).toMatchObject({ status: 'contained_patch_equivalent', method: 'residual_patch' });
    });

    it('4. a change that never landed is not_contained with a classified reason', async () => {
        fx = makeFixture();
        git(fx.work, 'checkout', '-q', '-b', 'feat');
        const f = fx.commit('g.txt', 'g\n', 'feat work');
        git(fx.work, 'checkout', '-q', 'main');
        fx.commit('other.txt', 'o\n', 'unrelated main work');
        git(fx.work, 'push', '-q', 'origin', 'main');
        const v = await probeCommitContainment(fx.work, base(fx.work), f, { tryCherry: true });
        expect(v.status).toBe('not_contained');
        expect(v.detail?.reasonCode).toBe('actual_patch_diff');
        expect(v.detail?.residualPatchId).toBeTruthy();
    });

    it('5. a missing object is unknown(object_missing), never not_contained', async () => {
        fx = makeFixture();
        const v = await probeCommitContainment(fx.work, base(fx.work), 'deadbeef'.repeat(5), { tryCherry: true });
        expect(v).toMatchObject({ status: 'unknown', detail: { unknownReason: 'object_missing' } });
    });

    it('5. a shallow clone cannot prove "not an ancestor": unknown(shallow)', async () => {
        fx = makeFixture();
        git(fx.work, 'checkout', '-q', '-b', 'feat');
        const f = fx.commit('f.txt', 'f\n', 'feat work');
        git(fx.work, 'push', '-q', 'origin', 'feat');
        git(fx.work, 'checkout', '-q', 'main');
        fx.commit('m2.txt', 'm2\n', 'main 2');
        fx.commit('m3.txt', 'm3\n', 'main 3');
        git(fx.work, 'push', '-q', 'origin', 'main');
        const shallow = join(fx.root, 'shallow');
        git(fx.root, 'clone', '-q', '--depth', '1', '--no-single-branch', `file://${fx.origin}`, shallow);
        expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('true');
        const v = await probeCommitContainment(shallow, base(shallow), f, { tryCherry: true });
        expect(v).toMatchObject({ status: 'unknown', detail: { unknownReason: 'shallow' } });
    });

    it('7. a commit message naming the mission is not evidence: content absent from main stays not_contained', async () => {
        fx = makeFixture();
        git(fx.work, 'checkout', '-q', '-b', 'feat');
        const f = fx.commit('h.txt', 'h\n', 'mission 7fa96203: implement git refs');
        git(fx.work, 'checkout', '-q', 'main');
        fx.commit('unrelated.txt', 'u\n', 'mission 7fa96203: docs only');
        git(fx.work, 'push', '-q', 'origin', 'main');
        const v = await probeCommitContainment(fx.work, base(fx.work), f, { tryCherry: true });
        expect(v.status).toBe('not_contained');
    });

    it('squash landed but main later edited the same lines: not_contained with the modified-since-landing hint', async () => {
        fx = makeFixture();
        fx.commit('shared.txt', 'line1\nline2\n', 'shared file');
        git(fx.work, 'push', '-q', 'origin', 'main');
        git(fx.work, 'checkout', '-q', '-b', 'feat');
        writeFileSync(join(fx.work, 'shared.txt'), 'line1\nline2 changed by feat\n');
        git(fx.work, 'commit', '-q', '-am', 'feat edit');
        const tip = git(fx.work, 'rev-parse', 'HEAD');
        git(fx.work, 'checkout', '-q', 'main');
        git(fx.work, 'merge', '-q', '--squash', 'feat');
        git(fx.work, 'commit', '-q', '-m', 'squash feat');
        writeFileSync(join(fx.work, 'shared.txt'), 'line1\nline2 rewritten later on main\n');
        git(fx.work, 'commit', '-q', '-am', 'later edit of the same line');
        git(fx.work, 'push', '-q', 'origin', 'main');
        const v = await probeCommitContainment(fx.work, base(fx.work), tip, { tryCherry: false });
        expect(v.status).toBe('not_contained');
        expect(v.detail?.note).toBe('modified_since_landing_possible');
    });

    it('resolveBranchSha prefers the remote-tracking branch and resolves nothing for an unknown name', () => {
        fx = makeFixture();
        git(fx.work, 'checkout', '-q', '-b', 'feat');
        const f = fx.commit('f.txt', 'f\n', 'feat work');
        git(fx.work, 'push', '-q', 'origin', 'feat');
        expect(resolveBranchSha(fx.work, 'feat')).toBe(f);
        expect(resolveBranchSha(fx.work, 'origin/feat')).toBe(f);
        expect(resolveBranchSha(fx.work, 'nope')).toBeUndefined();
        appendFileSync(join(fx.work, 'f.txt'), 'x');
    });
});
