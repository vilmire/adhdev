import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRefineMergeAndFinalizeLocked } from '../../src/commands/router-refine-merge.js';
import { refineSyncBaseStage } from '../../src/commands/router-refine-sync-stages.js';
import { assertRefineryPublishApproved, runMeshRefineSubmoduleReachabilityGate } from '../../src/mesh/mesh-refine-gitlink-utils.js';
import { checkPush } from '../../src/git/public-push-guard.mjs';
import { bindPushDestination, useSyntheticPublicPushPatterns } from '../helpers/public-push-patterns.js';

useSyntheticPublicPushPatterns();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
async function run(f: ReturnType<typeof fixture>, args: any = {}, beforePush?: () => void) {
    const calls: string[][] = [];
    const ctx: any = {
        meshId: 'fixture', nodeId: 'node', args: { mergeMode: 'ff-only', approvedTargetShas: { node: f.target }, approvedPublishShas: { [f.key]: [f.target] }, ...args },
        repoRoot: f.repo, node: { id: 'node', workspace: f.workspace }, branch: 'feature', baseBranch: 'main', baseHead: f.base, branchHead: f.target,
        mesh: { policy: { requireApprovalForPush: false } }, refineStages: [], validationSummary: {}, patchEquivalence: {},
        execFileAsync: async (file: string, argv: string[], opts: any) => { calls.push(argv); if (argv.includes('push')) beforePush?.(); return { stdout: execFileSync(file, argv, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }; },
    };
    const result: any = await runRefineMergeAndFinalizeLocked({ deps: {}, execute: async () => ({ success: true }) } as any, ctx);
    return { result: result.result, calls, ctx };
}
it('rc28 approved fast-forward publishes the exact candidate without creating a commit', async () => {
    const f = fixture(); const before = git(f.repo, 'rev-list', '--all', '--count');
    const { result, calls } = await run(f);
    expect(result.pushed, JSON.stringify(result)).toBe(true);
    expect(git(f.bare, 'rev-parse', 'main')).toBe(f.target);
    expect(git(f.repo, 'rev-list', '--all', '--count')).toBe(before);
    expect(calls.some(a => a[0] === 'merge' && a.includes('--ff-only'))).toBe(true);
    expect(result.refineStages.find((s: any) => s.stage === 'integration_range')).toMatchObject({ target: f.target, checked: 1, policy: 'private' });
});
it('rc28 divergence refuses in sync before rewriting the candidate or creating/pushing a commit', async () => {
    const f = fixture(); f.base = commit(f.repo, 'base moved\n', 'other'); git(f.repo, 'push', '-q', 'origin', 'main');
    const before = git(f.repo, 'rev-list', '--all', '--count');
    const { ctx, result, calls } = await run(f);
    expect(result.code).toBe('ff_only_required');
    expect(calls.some(a => a[0] === 'merge' || a[0] === 'push')).toBe(false);
    const outcome: any = await refineSyncBaseStage({} as any, ctx);
    expect(outcome.kind).toBe('terminal'); expect(outcome.result.code).toBe('ff_only_required');
    expect(git(f.workspace, 'rev-parse', 'HEAD')).toBe(f.target);
    expect(git(f.bare, 'rev-parse', 'main')).toBe(f.base);
    expect(git(f.repo, 'rev-list', '--all', '--count')).toBe(before);
});
it('rc28 changed target pin refuses before merge or push', async () => {
    const f = fixture(); const { result, calls } = await run(f, { approvedTargetShas: { node: f.base } });
    expect(result.code).toBe('approved_target_mismatch');
    expect(calls.some(a => a[0] === 'merge' || a[0] === 'push')).toBe(false);
    expect(git(f.bare, 'rev-parse', 'main')).toBe(f.base);
});
it('R2 explicit merge with approval preserves and publishes only the exact approved history', async () => {
    const f = fixture(); const { result, calls } = await run(f, { mergeMode: 'merge' });
    expect(result.pushed, JSON.stringify(result)).toBe(true);
    expect(git(f.repo, 'rev-parse', 'main')).toBe(f.target);
    expect(git(f.bare, 'rev-parse', 'main')).toBe(f.target);
    expect(calls.some(a => a[0] === 'merge' && a.includes('--ff-only'))).toBe(true);
});
for (const bad of [false, true]) it(`rc28 advertised feature full 13-commit integration range ${bad ? 'blocks removed intermediate path' : 'records every commit'}`, async () => {
    const f = fixture('oss'); const pending = [f.target];
    for (let i = 1; i < 13; i++) pending.push(commit(f.workspace, bad && i === 4 ? 'synthetic-private-token\n' : `clean ${i}\n`));
    f.target = pending.at(-1)!;
    git(f.repo, 'push', '-q', 'origin', `${f.target}:refs/heads/feature`);
    const ordinary = await checkPush([{ localRef: f.target, localSha: f.target, remoteRef: 'refs/heads/main', remoteSha: f.base }], { cwd: f.repo });
    expect(ordinary.checked).toBe(0); // Existing pre-push advertisement exclusion.
    const { result } = await run(f, { approvedPublishShas: { oss: pending } });
    if (bad) {
        expect(result.pushed).not.toBe(true); expect(git(f.bare, 'rev-parse', 'main')).toBe(f.base);
    } else {
        expect(result.pushed, JSON.stringify(result)).toBe(true);
        expect(result.refineStages.find((s: any) => s.stage === 'integration_range')).toMatchObject({ base: f.base, target: f.target, checked: 13, policy: 'public' });
        expect(git(f.bare, 'rev-parse', 'main')).toBe(f.target);
    }
});
for (const bad of [false, true]) it(`rc28 actual submodule auto-publication ${bad ? 'blocks advertised intermediate leak removed at tip' : 'records clean full 13-commit range'}`, async () => {
    const f = fixture('oss');
    const pending = [f.target];
    for (let i = 1; i < 13; i++) pending.push(commit(f.workspace, bad && i === 4 ? 'synthetic-private-token\n' : `clean ${i}\n`));
    f.target = pending.at(-1)!;
    git(f.repo, 'push', '-q', 'origin', `${f.target}:refs/heads/feature`);
    // A real superproject gitlink and initialized checkout drive the actual gate.
    const parent = join(f.repo, '..', 'parent'); mkdirSync(parent); git(parent, 'init', '-q', '-b', 'main');
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', f.bare, 'oss');
    const child = join(parent, 'oss'); bindPushDestination(child, f.bare, 'oss');
    git(child, 'fetch', '-q', f.workspace, f.target); git(child, 'checkout', '-q', '--detach', f.target);
    git(parent, 'add', 'oss'); const tree = git(parent, 'write-tree');
    const gate = await runMeshRefineSubmoduleReachabilityGate(parent, tree, { allowAutoPublishSubmoduleMainCommits: true, approvedPublishShas: { oss: pending } });
    if (bad) {
        expect(gate.status).toBe('failed');
        expect(gate.entries[0].publishApproval?.commits.find(c => c.sha === pending[4])?.guardScan).toBe('blocked');
        expect(git(f.bare, 'rev-parse', 'main')).toBe(f.base);
    } else {
        expect(gate.status, JSON.stringify(gate)).toBe('passed');
        expect(gate.entries[0].publishStdout).toContain('"checked":13');
        expect(gate.entries[0].publishStdout).toContain(`"base":"${f.base}"`);
        expect(gate.entries[0].publishStdout).toContain(`"target":"${f.target}"`);
        expect(git(f.bare, 'rev-parse', 'main')).toBe(f.target);
    }
});
it('rc28 private root path findings are reported as private policy, while public findings block', async () => {
    const f = fixture(); f.target = commit(f.workspace, 'synthetic-private-token\n');
    const approved = git(f.workspace, 'rev-list', `${f.base}..${f.target}`).split('\n');
    const { result } = await run(f, { approvedPublishShas: { root: approved } });
    expect(result.pushed, JSON.stringify(result)).toBe(true);
    expect(result.refineStages.find((s: any) => s.stage === 'integration_range')).toMatchObject({ policy: 'private', checked: 2, pathFindings: expect.any(Number) });
    expect(result.refineStages.find((s: any) => s.stage === 'integration_range').pathFindings).toBeGreaterThan(0);
});
it('rc28 publication refuses stale remote main and missing required patterns', async () => {
    const f = fixture('oss');
    await expect(assertRefineryPublishApproved(f.repo, f.target, 'main', { oss: [f.target] }, 'origin', undefined, 1, { integrationBase: f.target })).rejects.toThrow();
    const saved = process.env.ADHDEV_PUBLIC_PUSH_PATTERNS_SHA256;
    try {
        process.env.ADHDEV_PUBLIC_PUSH_PATTERNS_SHA256 = '0'.repeat(64);
        await expect(run(f)).resolves.toMatchObject({ result: { pushed: false } });
        expect(git(f.bare, 'rev-parse', 'main')).toBe(f.base);
    } finally { process.env.ADHDEV_PUBLIC_PUSH_PATTERNS_SHA256 = saved; }
});
it('rc28 a remote base moving during the immediate scan refuses publication', async () => {
    const f = fixture('oss');
    await expect(assertRefineryPublishApproved(f.repo, f.target, 'main', { oss: [f.target] }, 'origin', undefined, 1, {
        integrationBase: f.base,
        onScan: () => { git(f.repo, 'push', '-q', 'origin', `${f.target}:refs/heads/main`); },
    })).rejects.toThrow(/integration base moved/);
});
it('rc28 a base moving between the scan and push advertisement refuses even an otherwise valid fast-forward', async () => {
    const f = fixture(); const intermediate = f.target; f.target = commit(f.workspace, 'final\n');
    const { result } = await run(f, { approvedPublishShas: { root: [intermediate, f.target] } }, () => {
        git(f.repo, 'push', '-q', 'origin', `${intermediate}:refs/heads/main`);
    });
    expect(result.pushed).toBe(false);
    expect(git(f.bare, 'rev-parse', 'main')).toBe(intermediate);
});
for (const exit of [0, 1]) it(`rc28 pinned push runs the existing pre-push hook and respects exit ${exit}`, async () => {
    const f = fixture(); const marker = join(f.repo, '..', 'hook-result');
    const hookDir = join(f.repo, '..', "hooks 'with spaces'"); mkdirSync(hookDir);
    git(f.repo, 'config', 'core.hooksPath', hookDir);
    writeFileSync(join(hookDir, 'pre-push'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, require('node:fs').readFileSync(0, 'utf8')); process.exit(${exit});\n`, { mode: 0o755 });
    const { result } = await run(f);
    expect(readFileSync(marker, 'utf8')).toContain(`${f.target} refs/heads/main ${f.base}`);
    expect(result.pushed).toBe(exit === 0);
    expect(git(f.bare, 'rev-parse', 'main')).toBe(exit === 0 ? f.target : f.base);
});
