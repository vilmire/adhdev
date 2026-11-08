import { afterEach, describe, expect, it } from 'vitest';
import { makeFixture, git, type MissionGitFixture } from './mission-git-fixture.js';
import { probeCommitContainment, resolveBase, clearContainmentMemo } from '../../src/mesh/mission-ref-containment.js';
import { checkWorktreeChangesPatchEquivalentInRef } from '../../src/mesh/mesh-refine-patch-equivalence.js';

let fx: MissionGitFixture;
afterEach(() => { fx?.cleanup(); clearContainmentMemo(); });

function squashLanded(): string {
    fx = makeFixture();
    git(fx.work, 'checkout', '-q', '-b', 'feat');
    const f1 = fx.commit('a.txt', 'a\n', 'a');
    fx.commit('b.txt', 'b\n', 'b');
    git(fx.work, 'checkout', '-q', 'main');
    git(fx.work, 'merge', '-q', '--squash', 'feat');
    git(fx.work, 'commit', '-q', '-m', 'squash feat');
    git(fx.work, 'push', '-q', 'origin', 'main');
    return git(fx.work, 'rev-parse', 'feat').trim() || f1;
}

describe('containment does not block the event loop and is memoized', () => {
    it('lets a heartbeat timer tick while the residual-patch check runs', async () => {
        const tip = squashLanded();
        let ticks = 0;
        const timer = setInterval(() => { ticks++; }, 1);
        try {
            const r = await checkWorktreeChangesPatchEquivalentInRef(fx.work, 'refs/remotes/origin/main', tip);
            expect(r.contained).toBe(true);
        } finally { clearInterval(timer); }
        // The sync implementation completes in one uninterrupted turn: zero ticks. Async yields repeatedly.
        expect(ticks).toBeGreaterThan(0);
    });

    it('returns the memoized verdict for the same SHAs without running git again, and recomputes when the base moves', async () => {
        const tip = squashLanded();
        const base = resolveBase(fx.work, 'main')!;
        const v1 = await probeCommitContainment(fx.work, base, tip, { tryCherry: false });
        expect(v1.status).toBe('contained_patch_equivalent');
        const v2 = await probeCommitContainment(fx.work, base, tip, { tryCherry: false });
        expect(v2).toBe(v1); // identical object == served from the memo
        // A different base SHA is a different key -> recomputed (new object).
        const v3 = await probeCommitContainment(fx.work, { ...base, sha: 'f'.repeat(40) }, tip, { tryCherry: false });
        expect(v3).not.toBe(v1);
        expect(v3.status).toBe(v1.status);
    });
});
