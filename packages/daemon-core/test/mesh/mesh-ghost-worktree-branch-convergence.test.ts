// ---------------------------------------------------------------------------
// GHOST-WORKTREE-CLEANUP-DEADLOCK (mesh_status surface) — a local worktree node
// whose DIRECTORY is gone reports isGitRepo:false, which used to be classified
// as `blocked_review` with the next step "Resolve git status for node '<id>'
// before marking the task complete."
//
// That instruction is unactionable: there is no working tree left in which any
// git status could be resolved, so it sends the operator after a fix that
// cannot exist while the real action (remove the stale node) goes unmentioned.
// The node is now reported as `cleanup_candidate` / `worktree_path_missing`.
//
// A genuinely broken (but PRESENT) repo must keep the old blocked_review
// guidance — that one IS resolvable in place.
// ---------------------------------------------------------------------------
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyInlineMeshBranchConvergence } from '../../src/mesh/mesh-node-identity.js';

const MESH = { id: 'mesh_ghost', name: 'mesh_ghost', defaultBranch: 'main' };

function convergenceFor(node: any, git: Record<string, unknown>): Record<string, unknown> {
    const status: Record<string, unknown> = { git };
    applyInlineMeshBranchConvergence(MESH, node, status);
    return status.branchConvergence as Record<string, unknown>;
}

describe('inline mesh branch convergence — vanished local worktree', () => {
    it('classifies a local worktree whose directory is gone as cleanup_candidate, not blocked_review', () => {
        const node = {
            id: 'node-ghost',
            isLocalWorktree: true,
            workspace: join(tmpdir(), 'adhdev-definitely-not-here-9f3a1c'),
            worktreeBranch: 'feat/ghost',
        };
        // Precondition: the path really is absent.
        expect(fs.existsSync(node.workspace)).toBe(false);

        const convergence = convergenceFor(node, { isGitRepo: false, branch: 'feat/ghost' });

        expect(convergence.status).toBe('cleanup_candidate');
        expect(convergence.reason).toBe('worktree_path_missing');
        expect(convergence.needsConvergence).toBe(false);
        // The guidance must point at removal, not at an impossible git fix.
        expect(String(convergence.nextStep)).toContain('mesh_remove_node');
        expect(String(convergence.nextStep)).not.toContain('Resolve git status');
    });

    it('keeps blocked_review guidance for a PRESENT directory that is not a git repo', () => {
        const dir = mkdtempSync(join(tmpdir(), 'adhdev-present-nonrepo-'));
        try {
            const node = {
                id: 'node-present',
                isLocalWorktree: true,
                workspace: dir,
                worktreeBranch: 'feat/present',
            };

            const convergence = convergenceFor(node, { isGitRepo: false, branch: 'feat/present' });

            expect(convergence.status).toBe('blocked_review');
            expect(convergence.reason).toBe('git_status_unavailable');
            expect(String(convergence.nextStep)).toContain('Resolve git status');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('does not reclassify a NON-worktree node whose workspace is absent', () => {
        // Locality/worktree gating: only local worktree clone nodes are eligible
        // for this reclassification. A base or remote node's path says nothing
        // that justifies calling it a cleanup candidate.
        const node = {
            id: 'node-base',
            isLocalWorktree: false,
            workspace: join(tmpdir(), 'adhdev-definitely-not-here-9f3a1c'),
        };

        const convergence = convergenceFor(node, { isGitRepo: false, branch: 'main' });

        expect(convergence.status).toBe('blocked_review');
        expect(convergence.reason).toBe('git_status_unavailable');
    });
});
