/**
 * Inline-mesh branch convergence — the per-node "is this branch converged, and
 * what should the operator do next" classification surfaced by mesh_status.
 *
 * Extracted from mesh-node-identity.ts (behavior-preserving pure move) when that
 * file reached the 2,400-line gate. mesh-node-identity.ts re-exports the public
 * symbols, so existing import paths keep working.
 */
import * as fs from 'fs';
import { normalizeMeshNodeId } from '@adhdev/mesh-shared';
import { readStringValue, readObjectRecord, readBooleanValue, readNumberValue, countGitWorktreeChanges, isInlineMeshAutoFastForwardEligible } from './mesh-node-identity.js';

function readMeshNodeLabel(status: Record<string, unknown>, node: any): string {
    return readStringValue(status.nodeId, normalizeMeshNodeId(node)) ?? 'unknown';
}

function buildInlineMeshBranchConvergence(args: {
    mesh: any;
    node: any;
    status: Record<string, unknown>;
}): Record<string, unknown> {
    const git = readObjectRecord(args.status.git);
    const nodeLabel = readMeshNodeLabel(args.status, args.node);
    const defaultBranch = readStringValue(args.mesh?.defaultBranch) ?? 'main';
    const branch = readStringValue(git.branch, args.node?.worktreeBranch) ?? null;
    const upstream = readStringValue(git.upstream) ?? null;
    const upstreamStatus = readStringValue(git.upstreamStatus, git.upstream_status)
        ?? (upstream ? 'unchecked' : 'no_upstream');
    const ahead = readNumberValue(git.ahead) ?? 0;
    const behind = readNumberValue(git.behind) ?? 0;
    const uncommittedChanges = countGitWorktreeChanges(git);
    const hasConflicts = readBooleanValue(git.hasConflicts)
        ?? (Array.isArray(git.conflictFiles) && git.conflictFiles.length > 0);
    const base = {
        defaultBranch,
        branch,
        upstream,
        upstreamStatus,
        ahead,
        behind,
        isWorktree: args.node?.isLocalWorktree === true || args.status.isLocalWorktree === true,
        isDefaultBranch: branch === defaultBranch,
    };

    if (readBooleanValue(git.isGitRepo) !== true) {
        // GHOST-WORKTREE-CLEANUP-DEADLOCK: a local worktree node whose DIRECTORY is
        // gone also reports isGitRepo:false, and "resolve git status" is misdirection
        // there — no working tree remains to resolve anything in, so the only real
        // action is cleanup. `isLocalWorktree` (the locality signal the sibling branch
        // below uses) keeps the fs probe off remote paths; an fs throw means "present",
        // so a transient stat failure never downgrades a node.
        const ghostPath = readStringValue(args.node?.workspace);
        const worktreeGone = args.node?.isLocalWorktree === true && !!ghostPath
            && !((): boolean => { try { return fs.existsSync(ghostPath); } catch { return true; } })();
        if (worktreeGone) {
            return {
                ...base,
                status: 'cleanup_candidate',
                needsConvergence: false,
                reason: 'worktree_path_missing',
                nextStep: `The worktree directory for node '${nodeLabel}' no longer exists, so there is no git status to resolve. Remove the stale node with mesh_remove_node (or let the worktree-node retention pass reclaim it); any unmerged branch ref is preserved, never deleted.`,
            };
        }
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: 'git_status_unavailable',
            nextStep: `Resolve git status for node '${nodeLabel}' before marking the task complete.`,
        };
    }

    if (!branch) {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: 'branch_unknown',
            nextStep: `Inspect node '${nodeLabel}' git branch before deciding whether it is merged to ${defaultBranch}.`,
        };
    }

    if (hasConflicts || uncommittedChanges > 0) {
        return {
            ...base,
            status: 'not_mergeable',
            needsConvergence: true,
            reason: hasConflicts ? 'conflicts_present' : 'dirty_workspace',
            nextStep: `Commit, checkpoint, or resolve node '${nodeLabel}' before any main convergence step.`,
        };
    }

    if (branch === defaultBranch) {
        if (upstream && upstreamStatus !== 'fresh') {
            return {
                ...base,
                status: 'blocked_review',
                needsConvergence: true,
                reason: 'default_branch_upstream_unverified',
                nextStep: `Refresh ${defaultBranch}'s upstream refs or resolve the fetch failure before declaring convergence complete for node '${nodeLabel}'.`,
            };
        }
        if (ahead > 0 || behind > 0) {
            return {
                ...base,
                status: 'blocked_review',
                needsConvergence: true,
                reason: 'default_branch_not_even_with_upstream',
                nextStep: `Bring ${defaultBranch} even with its upstream before declaring convergence complete.`,
            };
        }
        return {
            ...base,
            status: 'merged_to_main',
            needsConvergence: false,
            reason: 'clean_default_branch',
            nextStep: null,
        };
    }

    if (args.node?.isLocalWorktree === true || args.status.isLocalWorktree === true) {
        return {
            ...base,
            status: 'cleanup_candidate',
            needsConvergence: true,
            reason: 'clean_non_default_worktree_branch',
            nextStep: `Run mesh_refine_node(node_id: "${nodeLabel}") or explicitly classify this worktree as blocked_review/not_mergeable before ending the task.`,
        };
    }

    if (upstream && upstreamStatus !== 'fresh') {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: 'feature_branch_upstream_unverified',
            nextStep: `Refresh branch '${branch}' upstream refs or resolve the fetch failure before deciding whether it is ready to merge into ${defaultBranch}.`,
        };
    }

    if (!upstream || ahead > 0 || behind > 0) {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: !upstream ? 'feature_branch_missing_upstream' : 'feature_branch_not_even_with_upstream',
            nextStep: `Push or reconcile branch '${branch}', then merge it into ${defaultBranch} or mark it not_mergeable with a reason.`,
        };
    }

    return {
        ...base,
        status: 'pushed_feature_branch_needs_merge',
        needsConvergence: true,
        reason: 'clean_non_default_branch',
        nextStep: `Review and merge branch '${branch}' into ${defaultBranch}; do not report the task as fully complete while it remains off main.`,
    };
}

export function applyInlineMeshBranchConvergence(mesh: any, node: any, status: Record<string, unknown>): void {
    const git = readObjectRecord(status.git);
    if (Object.keys(git).length === 0 && !status.gitProbePending) return;
    const uncommittedChanges = countGitWorktreeChanges(git);
    status.isDirty = uncommittedChanges > 0;
    status.uncommittedChanges = uncommittedChanges;
    status.branchConvergence = buildInlineMeshBranchConvergence({ mesh, node, status });
    status.autoFastForwardEligible = isInlineMeshAutoFastForwardEligible(git);
    if (status.autoFastForwardEligible) {
        status.suggestedAction = 'auto_fast_forward';
    } else {
        delete status.suggestedAction;
    }
}
