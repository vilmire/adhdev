// Dry-run must report the same publication-contract verdict the execute job reaches (read-only).
import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fastForwardHandlers } from '../../src/commands/med-family/fast-forward.js';
import { buildMeshRefineBatchDryRunResult } from '../../src/mesh/mesh-refine-submodule-preflight.js';
import { analyzeMeshRefineNodeChangeArea } from '../../src/mesh/mesh-refine-batch.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(repo: string, text: string, name = 'file') {
    writeFileSync(join(repo, name), text); git(repo, 'add', name); git(repo, 'commit', '-qm', 'Fixture change');
    return git(repo, 'rev-parse', 'HEAD');
}
/** moved=true advances origin/main past the candidate's parent (the live incident). */
function fixture(moved: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'refine-dry-pub-')); dirs.push(dir);
    const repo = join(dir, 'repo'), bare = join(dir, 'remote.git'), workspace = join(dir, 'feature');
    mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'init', '-q', '--bare', '-b', 'main', bare);
    git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'user.email', 't@example.invalid');
    commit(repo, 'base\n'); git(repo, 'remote', 'add', 'origin', bare); git(repo, 'push', '-qu', 'origin', 'main');
    git(repo, 'worktree', 'add', '-qb', 'feature', workspace, 'main');
    const target = commit(workspace, 'candidate\n', 'cand');
    if (moved) { commit(repo, 'moved\n', 'other'); git(repo, 'push', '-q', 'origin', 'main'); }
    const node = { id: 'node', workspace, repoRoot: workspace, isLocalWorktree: true, worktreeBranch: 'feature', clonedFromNodeId: 'source', policy: {} };
    const mesh = { id: 'm', nodes: [{ id: 'source', workspace: repo, repoRoot: repo, policy: {} }, node], policy: {} };
    return { repo, workspace, target, node, mesh };
}
const ctx = (mesh: any) => ({ deps: {}, getMeshForCommand: async () => ({ mesh }) }) as any;
const dry = (f: ReturnType<typeof fixture>, extra: any) =>
    fastForwardHandlers.refine_mesh_node(ctx(f.mesh), { meshId: 'm', nodeId: 'node', dryRun: true, ...extra }) as Promise<any>;
const contract = (f: ReturnType<typeof fixture>) => ({ approvedTargetShas: { node: f.target }, approvedPublishShas: [f.target] });

it('contract + base moved past candidate parent: dry-run refuses approved_history_requires_ff', async () => {
    const f = fixture(true); const before = git(f.workspace, 'rev-parse', 'HEAD');
    const r = await dry(f, contract(f));
    expect(r.success).toBe(false); expect(r.dryRun).toBe(true);
    expect(r.code).toBe('approved_history_requires_ff');
    expect(r.mergeWillRun).toBe(false); expect(r.convergenceStatus).toBe('blocked_review');
    expect(r.publicationContract).toMatchObject({ ok: false, code: 'approved_history_requires_ff', branchHead: f.target });
    expect(r.nextAction).toContain("mergeMode:'merge'");
    expect(git(f.workspace, 'rev-parse', 'HEAD')).toBe(before);
});

it('ff-only on a moved base refuses ff_only_required', async () => {
    const f = fixture(true);
    const r = await dry(f, { ...contract(f), mergeMode: 'ff-only' });
    expect(r.code).toBe('ff_only_required');
});

it('contract + fast-forwardable base: dry-run ok with publicationContract', async () => {
    const f = fixture(false);
    const r = await dry(f, contract(f));
    expect(r.success).toBe(true); expect(r.publicationContract).toMatchObject({ ok: true, branchHead: f.target });
});

it('no contract args: unchanged dry-run (no publicationContract field, even on a moved base)', async () => {
    const f = fixture(true);
    const r = await dry(f, {});
    expect(r.success).toBe(true); expect(r.publicationContract).toBeUndefined();
});

it('batch dry-run applies the same preview per node', async () => {
    const f = fixture(true);
    const area = await analyzeMeshRefineNodeChangeArea({ nodeId: 'node', workspace: f.workspace, branch: 'feature', baseRef: 'origin/main', branchRef: f.target, diffCwd: f.workspace, repoRoot: f.repo, submodulePaths: new Set() });
    const ordering: any = { order: ['node'], changeAreas: { node: area }, rationale: '' };
    const blocked: any = await buildMeshRefineBatchDryRunResult({ mesh: f.mesh, orderedNodes: [f.node], ordering, commandArgs: contract(f) as any });
    expect(blocked.success).toBe(false); expect(blocked.publicationContract.node.code).toBe('approved_history_requires_ff');
    const legacy: any = await buildMeshRefineBatchDryRunResult({ mesh: f.mesh, orderedNodes: [f.node], ordering, commandArgs: {} });
    expect(legacy.success).toBe(true); expect(legacy.publicationContract).toBeUndefined();
});
