import { describe, expect, it } from 'vitest';
import { applyInlineMeshBranchConvergence } from '../../src/mesh/mesh-branch-convergence.js';
import { STARTER_SKILLS } from '../../src/assistant/skills/starter-skills.js';
import { resolveCoordinatorRules } from '../../src/mesh/coordinator-rules.js';
import { buildPreviewFreshness } from '../../src/mesh/preview-freshness.js';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('assistant starter skills and prompt examples stay optional-procedure wording', () => {
    const body = (name: string) => STARTER_SKILLS.find((skill) => skill.name === name)!.body;

    it('deploy checklist applies only to a deploy request', () => {
        expect(body('deploy-verify-checklist')).toMatch(/Use this only when the user asked to deploy or release/);
    });

    it('branch report does not make merging the finish line', () => {
        const text = body('branch-convergence-report');
        expect(text).not.toMatch(/not fully complete unless/);
        expect(text).not.toMatch(/merging is the next step\./);
        expect(text).toMatch(/only when the request or the done criteria ask for landing/);
        // The five buckets stay available for reporting.
        for (const bucket of ['merged_to_main', 'pushed_feature_branch_needs_merge', 'blocked_review', 'cleanup_candidate', 'not_mergeable']) expect(text).toContain(bucket);
    });

    it('dispatch hygiene does not teach merge-to-deploy as the default chain', () => {
        expect(body('mesh-dispatch-hygiene')).not.toMatch(/merge to deploy/);
    });

    it('scope examples in the compiled prompts do not presuppose a merge on main', () => {
        const read = (file: string) => readFileSync(join(__dirname, '../../src/mesh', file), 'utf8');
        expect(read('coordinator-prompt.ts')).not.toContain('checked merge on main');
        expect(read('mesh-mission-prompt.ts')).not.toContain('checked X on main');
    });

    it('a repo without its own rules file gets the generic fallback, not this repo\'s release steps', () => {
        const dir = mkdtempSync(join(tmpdir(), 'generic-rules-'));
        try {
            const resolved = resolveCoordinatorRules(dir);
            expect(resolved.source).toBe('bundled');
            expect(resolved.text).not.toContain('RELEASE/DEPLOY runs here');
            expect(resolved.text).not.toContain('npm run deploy:preview');
            expect(resolved.text).not.toContain('A clean worktree branch →');
            // A stub file still falls back; a real file still wins wholesale.
            writeFileSync(join(dir, '.adhdev-stub'), '');
            expect(resolveCoordinatorRules(join(dir, 'missing')).source).toBe('bundled');
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('a repo with no preview pipeline gets no preview freshness at all', () => {
        const dir = mkdtempSync(join(tmpdir(), 'generic-preview-'));
        try { expect(buildPreviewFreshness(dir)).toBeNull(); }
        finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
