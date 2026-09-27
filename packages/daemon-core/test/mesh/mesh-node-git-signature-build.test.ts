import { describe, expect, it } from 'vitest';
import { computeMeshNodeGitSignature } from '../../src/mesh/mesh-node-git-state.js';

// A restarted member on a new build must re-push git even when the worktree is
// unchanged, because the deploy-lag verdict (daemonBuildBehind) changed.
describe('computeMeshNodeGitSignature', () => {
    const base = { isGitRepo: true, branch: 'main', head: 'abc' };
    it('changes when the build-behind verdict changes', () => {
        const before = computeMeshNodeGitSignature({ ...base, daemonBuildBehind: { buildCommit: 'old', head: 'new' } });
        const after = computeMeshNodeGitSignature({ ...base });
        expect(before).not.toBe(after);
    });
    it('is stable for identical snapshots', () => {
        const a = computeMeshNodeGitSignature({ ...base, daemonBuildBehind: { buildCommit: 'old', head: 'new' } });
        const b = computeMeshNodeGitSignature({ ...base, daemonBuildBehind: { buildCommit: 'old', head: 'new' } });
        expect(a).toBe(b);
    });
});
