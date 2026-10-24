// Actual bare-remote full-pipeline fixture adapted from independent rc28 review.
import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMeshRefineBatchConvergence } from '../../src/commands/router-refine-batch-jobs.js';
import { executeMeshRefineNodeSynchronously } from '../../src/commands/router-refine.js';
import { bindPushDestination, useSyntheticPublicPushPatterns } from '../helpers/public-push-patterns.js';

const savedTrace = process.env.GIT_TRACE;
useSyntheticPublicPushPatterns();
const dirs: string[] = [];
afterEach(() => { if (savedTrace === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = savedTrace; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(repo: string, text: string, name = 'file') {
    writeFileSync(join(repo, name), text); git(repo, 'add', name); git(repo, 'commit', '-qm', 'Fixture change');
    return git(repo, 'rev-parse', 'HEAD');
}
function fixture(key = 'root') {
    const dir = mkdtempSync(join(tmpdir(), 'refine-rc28-')); dirs.push(dir);
    const repo = join(dir, 'repo'), bare = join(dir, 'remote.git'), workspace = join(dir, 'feature');
    mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'init', '-q', '--bare', '-b', 'main', bare);
    git(repo, 'config', 'user.name', 'vilmire'); git(repo, 'config', 'user.email', 'vilmire@users.noreply.github.com');
    const base = commit(repo, 'base\n'); git(repo, 'remote', 'add', 'origin', bare); git(repo, 'push', '-qu', 'origin', 'main');
    bindPushDestination(repo, bare, key);
    git(repo, 'worktree', 'add', '-qb', 'feature', workspace, 'main');
    const target = commit(workspace, 'candidate\n');
    return { repo, bare, workspace, base, target, key };
}
function routerFixture(f: ReturnType<typeof fixture>) {
    const node = { id: 'node', workspace: f.workspace, repoRoot: f.workspace, isLocalWorktree: true, worktreeBranch: 'feature', clonedFromNodeId: 'source', policy: {} };
    const mesh = { id: 'fixture', nodes: [{ id: 'source', workspace: f.repo, repoRoot: f.repo, policy: {} }, node], policy: { requireApprovalForPush: false, refineConfig: { version: 1, validation: { required: true, commands: [{ command: 'node check.cjs', category: 'test' }] } } } };
    writeFileSync(join(f.workspace, 'check.cjs'), 'process.exit(0)\n');
    git(f.workspace, 'add', 'check.cjs'); git(f.workspace, 'commit', '-qm', 'Add fixture check');
    f.target = git(f.workspace, 'rev-parse', 'HEAD');
    const self: any = { deps: {}, refineBaseLeases: new Map(), getMeshForCommand: async () => ({ mesh }), execute: async () => ({ success: true }) };
    return { self, mesh, node };
}

function pending(f: ReturnType<typeof fixture>) { return git(f.workspace, 'rev-list', `${f.base}..${f.target}`).split('\n'); }
function snapshot(f: ReturnType<typeof fixture>) {
    return { refs: git(f.repo, 'show-ref', '--heads'), parents: git(f.workspace, 'show', '-s', '--format=%P', 'HEAD'),
        commits: git(f.repo, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype)').split('\n').filter(t => t === 'commit').length,
        remote: git(f.bare, 'rev-parse', 'main') };
}
function trace(f: ReturnType<typeof fixture>) {
    const path = join(f.repo, '..', 'git-trace'); writeFileSync(path, ''); process.env.GIT_TRACE = path;
    return () => readFileSync(path, 'utf8');
}
function expectNoMutation(log: string) {
    expect(log).not.toMatch(/built-in: git (?:[^\n]* )?(?:rebase|commit|commit-tree|merge|push)(?: |$)/m);
}
const invalidMaps = [
    ['missing node', { other: { root: ['a'.repeat(40)] } }], ['empty map', {}], ['undefined map', undefined],
    ['null map', null], ['array map', []], ['string map', 'invalid'], ['undefined node', { node: undefined }],
    ['empty node', { node: {} }], ['invalid SHA', { node: { root: ['invalid'] } }],
    ['malformed list', { node: { root: 'a'.repeat(40) } }],
] as const;
for (const mode of [undefined, 'merge'] as const) for (const [label, mapping] of invalidMaps) {
    it(`R2 ${mode ?? 'omitted'} batch refuses ${label} before any pipeline mutation`, async () => {
        const f = fixture(); const { self, node } = routerFixture(f); const before = snapshot(f); const log = trace(f);
        const result: any = await runMeshRefineBatchConvergence(self, 'fixture', [node], { order: [node.id] }, {
            ...(mode ? { mergeMode: mode } : {}), approvedPublishShasByNode: mapping as any,
            approvedPublishShas: { root: pending(f) },
        });
        expect(snapshot(f)).toEqual(before); expectNoMutation(log());
        expect(result.success).toBe(false); expect(result.code).toBe('publish_approval_required');
    });
}
for (const mode of [undefined, 'merge'] as const) for (const reverse of [false, true]) for (const complete of [false, true]) {
    it(`R2 mixed public/private batch ${mode ?? 'omitted'} ${reverse ? 'private first' : 'public first'} ${complete ? 'exact success' : 'missing private refuses entire batch'}`, async () => {
        const pub = fixture('oss'), priv = fixture('root'); const p = routerFixture(pub), q = routerFixture(priv);
        p.mesh.nodes[0].id = 'source-public'; p.node.id = 'node-public'; p.node.clonedFromNodeId = 'source-public';
        q.mesh.nodes[0].id = 'source-private'; q.node.id = 'node-private'; q.node.clonedFromNodeId = 'source-private';
        const mesh = { ...q.mesh, nodes: [...p.mesh.nodes, ...q.mesh.nodes] }; q.self.getMeshForCommand = async () => ({ mesh });
        const nodes = reverse ? [q.node, p.node] : [p.node, q.node]; const before = [snapshot(pub), snapshot(priv)]; const log = trace(priv);
        const result: any = await runMeshRefineBatchConvergence(q.self, 'fixture', nodes, { order: nodes.map(n => n.id) }, {
            ...(mode ? { mergeMode: mode } : {}), approvedPublishShasByNode: { [p.node.id]: { oss: pending(pub) }, ...(complete ? { [q.node.id]: { root: pending(priv) } } : {}) },
            approvedPublishShas: { root: pending(priv) },
        });
        console.info('R2_MIXED', JSON.stringify({ mode: mode ?? 'omitted', reverse, complete, result, public: { base: pub.base, target: pub.target, final: git(pub.bare, 'rev-parse', 'main') }, private: { base: priv.base, target: priv.target, final: git(priv.bare, 'rev-parse', 'main') } }));
        if (complete) {
            expect(result.summary.merged, JSON.stringify(result)).toBe(2);
            expect(git(pub.bare, 'rev-parse', 'main')).toBe(pub.target); expect(git(priv.bare, 'rev-parse', 'main')).toBe(priv.target);
            expect(snapshot(pub).commits).toBe(before[0].commits); expect(snapshot(priv).commits).toBe(before[1].commits);
        } else { expect([snapshot(pub), snapshot(priv)]).toEqual(before); expectNoMutation(log()); expect(result.success).toBe(false); }
    }, 60000);
}
for (const mode of [undefined, 'merge'] as const) for (const batch of [false, true]) {
    it(`R2 divergent approved branch ${mode ?? 'omitted'} ${batch ? 'batch' : 'single'} never rewrites, commits or pushes`, async () => {
        const f = fixture(); const { self, node } = routerFixture(f);
        f.base = commit(f.repo, 'base moved\n', 'other'); git(f.repo, 'push', '-q', 'origin', 'main');
        const before = snapshot(f); const log = trace(f);
        const args = { ...(mode ? { mergeMode: mode } : {}), ...(batch
            ? { approvedPublishShasByNode: { node: { root: pending(f) } } }
            : { approvedTargetShas: { node: f.target } }) };
        const result: any = batch ? await runMeshRefineBatchConvergence(self, 'fixture', [node], { order: ['node'] }, args)
            : await executeMeshRefineNodeSynchronously(self, 'fixture', 'node', args);
        const after = snapshot(f);
        console.info('R2_DIVERGENCE', JSON.stringify({ mode: mode ?? 'omitted', batch, before, after, result, mutationCommands: log().split('\n').filter(line => /built-in: git .*?(rebase|commit|commit-tree|merge|push)( |$)/.test(line)) }));
        expect(after).toEqual(before); expectNoMutation(log());
        expect(batch ? result.results[0].code : result.code).toBe('approved_history_requires_ff');
        expect(JSON.stringify(result)).toContain('approval');
    });
}
for (const mode of [undefined, 'merge'] as const) it(`R2 legacy private ${mode ?? 'omitted'} request with no contract retains ordinary merge publication`, async () => {
    const f = fixture(); const { self, node } = routerFixture(f);
    const result: any = await runMeshRefineBatchConvergence(self, 'fixture', [node], { order: ['node'] }, mode ? { mergeMode: mode } : {});
    expect(result.summary.merged, JSON.stringify(result)).toBe(1);
    const landed = git(f.bare, 'rev-parse', 'main'); expect(landed).not.toBe(f.target);
    expect(git(f.bare, 'show', '-s', '--format=%P', 'main')).toBe(`${f.base} ${f.target}`);
}, 60000);

it('R2 FF-only missing-node batch refuses before any pipeline mutation', async () => {
    const f = fixture(); const { self, node } = routerFixture(f); const before = snapshot(f); const log = trace(f);
    const result: any = await runMeshRefineBatchConvergence(self, 'fixture', [node], { order: ['node'] }, {
        mergeMode: 'ff-only', approvedTargetShas: { node: f.target }, approvedPublishShasByNode: {},
    });
    expect(result.code).toBe('publish_approval_required'); expect(snapshot(f)).toEqual(before); expectNoMutation(log());
});
