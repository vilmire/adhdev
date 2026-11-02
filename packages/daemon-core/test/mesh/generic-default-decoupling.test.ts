import { describe, expect, it } from 'vitest';
import { applyInlineMeshBranchConvergence } from '../../src/mesh/mesh-branch-convergence.js';

function classify(git: Record<string, unknown>, node: Record<string, unknown> = {}) {
    const status: Record<string, unknown> = { nodeId: 'node-1', git };
    applyInlineMeshBranchConvergence({ defaultBranch: 'main' }, node, status);
    return status.branchConvergence as { status: string; reason: string; nextStep: string | null; needsConvergence: boolean };
}

describe('generic branch report is not a release order', () => {
    it('a pushed feature branch does not inherit a mandatory merge', () => {
        const result = classify({
            isGitRepo: true,
            branch: 'fix/pr-ready',
            upstream: 'origin/fix/pr-ready',
            upstreamStatus: 'fresh',
            ahead: 0,
            behind: 0,
        });
        expect(result.status).toBe('pushed_feature_branch_needs_merge');
        expect(result.reason).toBe('clean_non_default_branch');
        expect(result.nextStep).toContain('done criteria include landing');
        expect(result.nextStep).not.toContain('do not report the task as fully complete');
        expect(result.nextStep).not.toContain('mesh_refine_node');
    });

    it('a clean local worktree does not order mesh_refine_node', () => {
        const result = classify({
            isGitRepo: true,
            branch: 'fix/local-tool',
            modified: 0,
        }, { isLocalWorktree: true });
        expect(result.status).toBe('cleanup_candidate');
        expect(result.reason).toBe('clean_non_default_worktree_branch');
        expect(result.nextStep).toContain('Report cleanup_candidate');
        expect(result.nextStep).not.toContain('mesh_refine_node');
    });

    it('keeps dirty work and default-branch drift on their existing verdicts', () => {
        const dirty = classify({ isGitRepo: true, branch: 'fix/dirty', modified: 2 });
        expect(dirty.status).toBe('not_mergeable');
        expect(dirty.reason).toBe('dirty_workspace');
        expect(dirty.nextStep).toContain('before any main convergence step');

        const drifted = classify({
            isGitRepo: true,
            branch: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'fresh',
            ahead: 1,
            behind: 0,
        });
        expect(drifted.status).toBe('blocked_review');
        expect(drifted.reason).toBe('default_branch_not_even_with_upstream');
    });
});
