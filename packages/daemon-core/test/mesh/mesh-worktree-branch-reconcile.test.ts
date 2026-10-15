import { describe, it, expect } from 'vitest';
import {
    reconcileWorktreeBranch,
    refreshWorktreeCapabilityTag,
} from '../../src/mesh/mesh-worktree-branch-reconcile.js';

/**
 * Regression coverage for the stale `worktreeBranch` defect (2026-10-16).
 *
 * The observed production shape: the worktree DIRECTORY is named for the
 * original branch while git reports a later `-reuse` branch, because
 * `worktreeBranch` is written once at clone time and never updated. The
 * cleanup guard (router-worktree-cleanup.ts) then refuses removal forever,
 * which pinned the mesh at its node cap.
 */
describe('reconcileWorktreeBranch', () => {
    const worktreeNode = (over: Record<string, unknown> = {}) => ({
        isLocalWorktree: true,
        worktreeBranch: 'feat/assistant-remaining-surface',
        capabilityTags: ['os=darwin', 'arch=arm64', 'worktree=feat/assistant-remaining-surface'],
        ...over,
    });

    it('detects the real production mismatch and patches record + capability tag', () => {
        // Exact observed case: dir named feat-assistant-remaining-surface,
        // git on fix/dashboard-fsm-idle-oscillation-reuse.
        const result = reconcileWorktreeBranch({
            node: worktreeNode(),
            observedBranch: 'fix/dashboard-fsm-idle-oscillation-reuse',
        });

        expect(result.stale).toBe(true);
        expect(result.reason).toBe('reconciled');
        expect(result.patch?.worktreeBranch).toBe('fix/dashboard-fsm-idle-oscillation-reuse');
        // The routing tag must follow the branch, else a pinned follow-up task
        // for this branch is routed to the wrong workspace.
        expect(result.patch?.capabilityTags).toEqual([
            'os=darwin',
            'arch=arm64',
            'worktree=fix/dashboard-fsm-idle-oscillation-reuse',
        ]);
    });

    it('is a no-op when record and git already agree', () => {
        const result = reconcileWorktreeBranch({
            node: worktreeNode({
                worktreeBranch: 'review/orphan-worker-observability-recovery',
                capabilityTags: ['worktree=review/orphan-worker-observability-recovery'],
            }),
            observedBranch: 'review/orphan-worker-observability-recovery',
        });

        expect(result.stale).toBe(false);
        expect(result.reason).toBe('in_sync');
        expect(result.patch).toBeNull();
    });

    it('never rewrites the record when git branch is unobservable', () => {
        // Detached HEAD / unreadable worktree. Overwriting with '' would
        // destroy the only record of which branch this workspace serves.
        for (const observed of ['', null, undefined, '   ']) {
            const result = reconcileWorktreeBranch({
                node: worktreeNode(),
                observedBranch: observed,
            });
            expect(result.stale).toBe(false);
            expect(result.reason).toBe('branch_unobservable');
            expect(result.patch).toBeNull();
        }
    });

    it('does not invent a branch for a record that has none', () => {
        // This is the mesh_worktree_cleanup_missing_branch case: it must keep
        // refusing rather than be granted a branch by inference.
        const result = reconcileWorktreeBranch({
            node: { isLocalWorktree: true },
            observedBranch: 'fix/something',
        });

        expect(result.stale).toBe(false);
        expect(result.reason).toBe('no_recorded_branch');
        expect(result.patch).toBeNull();
    });

    it('ignores base (non-worktree) nodes entirely', () => {
        const result = reconcileWorktreeBranch({
            node: { isLocalWorktree: false, worktreeBranch: 'main' },
            observedBranch: 'some-other-branch',
        });

        expect(result.stale).toBe(false);
        expect(result.reason).toBe('not_a_worktree_node');
        expect(result.patch).toBeNull();
    });

    it('accepts the snake_case record variant readers already tolerate', () => {
        const result = reconcileWorktreeBranch({
            node: { isLocalWorktree: true, worktree_branch: 'old/branch' },
            observedBranch: 'new/branch',
        });

        expect(result.stale).toBe(true);
        expect(result.patch?.worktreeBranch).toBe('new/branch');
    });
});

describe('refreshWorktreeCapabilityTag', () => {
    it('replaces the worktree tag in place, preserving order and siblings', () => {
        expect(
            refreshWorktreeCapabilityTag(['os=darwin', 'worktree=old', 'arch=arm64'], 'new'),
        ).toEqual(['os=darwin', 'worktree=new', 'arch=arm64']);
    });

    it('appends when no worktree tag exists yet', () => {
        expect(refreshWorktreeCapabilityTag(['os=linux'], 'b')).toEqual(['os=linux', 'worktree=b']);
    });

    it('returns undefined when the tag is already correct (no needless write)', () => {
        expect(refreshWorktreeCapabilityTag(['worktree=same'], 'same')).toBeUndefined();
    });

    it('returns undefined for a node with no tag array', () => {
        expect(refreshWorktreeCapabilityTag(undefined, 'b')).toBeUndefined();
        expect(refreshWorktreeCapabilityTag(null, 'b')).toBeUndefined();
    });
});
