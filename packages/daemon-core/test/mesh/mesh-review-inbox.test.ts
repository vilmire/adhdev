import { describe, expect, it } from 'vitest';
import { deriveMeshReviewInboxItems } from '../../src/mesh/mesh-review-inbox.js';
import type { MeshLedgerEntry } from '../../src/mesh/mesh-ledger.js';

function makeNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        nodeId: 'node-1',
        isLocalWorktree: true,
        workspace: '/tmp/test-workspace',
        worktreeBranch: 'feature/my-branch',
        branchConvergence: {
            status: 'pushed_feature_branch_needs_merge',
            reason: null,
            nextStep: 'open_pr_or_merge',
            needsConvergence: true,
            branch: 'feature/my-branch',
            defaultBranch: 'main',
        },
        ...overrides,
    };
}

function makeLedgerEntry(overrides: Partial<MeshLedgerEntry> = {}): MeshLedgerEntry {
    return {
        id: 'entry-1',
        meshId: 'mesh-1',
        nodeId: 'node-1',
        kind: 'task_completed',
        timestamp: new Date().toISOString(),
        payload: {},
        ...overrides,
    } as MeshLedgerEntry;
}

describe('deriveMeshReviewInboxItems', () => {
    it('returns empty inbox when no nodes', () => {
        const result = deriveMeshReviewInboxItems({ nodes: [], ledgerEntries: [] });
        expect(result.items).toHaveLength(0);
        expect(result.remoteNodesExcluded).toBe(false);
    });

    it('includes local node with pushed_feature_branch_needs_merge', () => {
        const result = deriveMeshReviewInboxItems({
            nodes: [makeNode()],
            ledgerEntries: [],
        });
        expect(result.items).toHaveLength(1);
        expect(result.items[0].reviewReason).toBe('merge_candidate');
        expect(result.items[0].nodeId).toBe('node-1');
        expect(result.items[0].branch).toBe('feature/my-branch');
        expect(result.items[0].defaultBranch).toBe('main');
    });

    it('includes cleanup_candidate with clean_non_default_worktree_branch reason', () => {
        const node = makeNode({
            branchConvergence: {
                status: 'cleanup_candidate',
                reason: 'clean_non_default_worktree_branch',
                nextStep: 'merge_or_delete',
                needsConvergence: true,
                branch: 'feature/old-branch',
                defaultBranch: 'main',
            },
        });
        const result = deriveMeshReviewInboxItems({ nodes: [node], ledgerEntries: [] });
        expect(result.items).toHaveLength(1);
        expect(result.items[0].reviewReason).toBe('merge_candidate');
    });

    it('excludes node without convergence info', () => {
        const node = makeNode({ branchConvergence: null });
        const result = deriveMeshReviewInboxItems({ nodes: [node], ledgerEntries: [] });
        expect(result.items).toHaveLength(0);
    });

    it('excludes merged_to_main nodes', () => {
        const node = makeNode({
            branchConvergence: {
                status: 'merged_to_main',
                reason: null,
                nextStep: null,
                needsConvergence: false,
                branch: 'main',
                defaultBranch: 'main',
            },
        });
        const result = deriveMeshReviewInboxItems({ nodes: [node], ledgerEntries: [] });
        expect(result.items).toHaveLength(0);
    });

    it('excludes remote nodes and sets remoteNodesExcluded', () => {
        const remoteNode = makeNode({
            nodeId: 'node-remote',
            isLocalWorktree: false,
            connection: { state: 'connected' },
        });
        const result = deriveMeshReviewInboxItems({ nodes: [remoteNode], ledgerEntries: [] });
        expect(result.items).toHaveLength(0);
        expect(result.remoteNodesExcluded).toBe(true);
        expect(result.excludedRemoteNodeIds).toContain('node-remote');
    });

    it('detects local node via connection.state === self', () => {
        const selfNode = makeNode({
            isLocalWorktree: false,
            connection: { state: 'self' },
        });
        const result = deriveMeshReviewInboxItems({ nodes: [selfNode], ledgerEntries: [] });
        expect(result.items).toHaveLength(1);
        expect(result.items[0].reviewReason).toBe('merge_candidate');
    });

    it('resolves task_completion evidence from ledger', () => {
        const entry = makeLedgerEntry({
            nodeId: 'node-1',
            kind: 'task_completed',
            payload: {
                taskId: 'task-abc',
                evidence: {
                    transcriptHandle: { path: '/tmp/transcript.jsonl' },
                    workerResult: {
                        status: 'success',
                        classification: 'feature',
                        changedFiles: ['src/index.ts'],
                        validationResults: [],
                        errors: [],
                        requiresUserAction: false,
                    },
                },
            },
        });
        const result = deriveMeshReviewInboxItems({
            nodes: [makeNode()],
            ledgerEntries: [entry],
        });
        expect(result.items[0].evidence.available).toBe(true);
        expect(result.items[0].evidence.source).toBe('task_completion');
        expect(result.items[0].evidence.taskId).toBe('task-abc');
        expect(result.items[0].evidence.worker?.changedFiles).toContain('src/index.ts');
        expect(result.items[0].transcriptHandle).toEqual({ path: '/tmp/transcript.jsonl' });
    });

    it('resolves refine_job evidence and sets refine_blocked_review reason', () => {
        const refineEntry = makeLedgerEntry({
            nodeId: 'node-1',
            kind: 'task_completed',
            payload: {
                source: 'refine_mesh_node_async_job',
                result: {
                    validationSummary: {
                        bootstrap: { stage: 'ran', passed: true },
                        tests: { passed: false },
                    },
                    finalBranchConvergenceState: { status: 'blocked_review' },
                    code: 'blocked_review',
                },
            },
        });
        const result = deriveMeshReviewInboxItems({
            nodes: [makeNode()],
            ledgerEntries: [refineEntry],
        });
        expect(result.items[0].reviewReason).toBe('refine_blocked_review');
        expect(result.items[0].evidence.source).toBe('refine_job');
        expect(result.items[0].evidence.bootstrap).toEqual({ stage: 'ran', passed: true });
    });

    it('handles multiple nodes, mixes local and remote', () => {
        const localNode = makeNode({ nodeId: 'local-1' });
        const remoteNode = {
            ...makeNode({ nodeId: 'remote-1' }),
            isLocalWorktree: false,
            connection: { state: 'connected' },
        };
        const result = deriveMeshReviewInboxItems({
            nodes: [localNode, remoteNode],
            ledgerEntries: [],
        });
        expect(result.items).toHaveLength(1);
        expect(result.items[0].nodeId).toBe('local-1');
        expect(result.remoteNodesExcluded).toBe(true);
        expect(result.excludedRemoteNodeIds).toContain('remote-1');
    });
});
