import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/config/config.js', () => ({ getConfigDir: () => join(tmpdir(), 'adhdev-stage-ports-cfg'), loadConfig: () => ({}), getMachineId: () => 'm', getMachineNickname: () => null }));
vi.mock('../../src/config/mesh-config.js', () => ({ getMesh: vi.fn(() => undefined), getMeshByRepo: vi.fn(), listMeshes: vi.fn(() => []) }));

import { defaultStageGit, noReviewerWorkspace, resolveStagePipelineCeilingMs, unavailableSelfCheck, mapProfileSummary, createRefineProfileSelfCheck, createLightReviewerWorkspaceProvider, createProductionStagePorts, setStageArtifactRegistrar, setStagePorts } from '../../src/mesh/stage-ports-default.js';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); setStageArtifactRegistrar(null); setStagePorts({ selfCheck: undefined, reviewerWorkspace: undefined }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, stdio: 'pipe' }).toString();

describe('production stage ports', () => {
    it('git port: head, clean/dirty, diff and base against a real repo', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'stage-git-')); dirs.push(dir);
        git(dir, 'init', '-b', 'main'); writeFileSync(join(dir, 'a.txt'), '1\n'); git(dir, 'add', '.'); git(dir, 'commit', '-m', 'one');
        const base = (await defaultStageGit.headSha(dir))!;
        expect(await defaultStageGit.baseSha(dir)).toBe(base); // falls back to local main
        writeFileSync(join(dir, 'a.txt'), '2\n');
        expect(await defaultStageGit.isClean(dir)).toBe(false);
        git(dir, 'commit', '-am', 'two');
        expect(await defaultStageGit.isClean(dir)).toBe(true);
        const head = (await defaultStageGit.headSha(dir))!;
        expect(head).not.toBe(base);
        expect(await defaultStageGit.diff(dir, base, head)).toContain('+2');
        expect(await defaultStageGit.isClean('/opt/absent/workspace')).toBe(false);
        const fp = await defaultStageGit.fingerprint(dir);
        expect(fp).toBeTruthy();
        expect(await defaultStageGit.fingerprint(dir)).toBe(fp);
        writeFileSync(join(dir, 'new.txt'), 'x'); // an untracked file is a mutation too
        expect(await defaultStageGit.fingerprint(dir)).not.toBe(fp);
        expect(await defaultStageGit.fingerprint('/opt/absent/workspace')).toBeNull();
    });

    it('fingerprint is content-based: skip-worktree flags and untracked edits are detected, git-ignored output is not', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'stage-fp-')); dirs.push(dir);
        git(dir, 'init', '-b', 'main');
        writeFileSync(join(dir, '.gitignore'), 'secret.cfg\nbuild/\n'); writeFileSync(join(dir, 'a.txt'), '1\n'); writeFileSync(join(dir, 'secret.cfg'), 'v1');
        git(dir, 'add', '.'); git(dir, 'commit', '-m', 'one');
        const base = (await defaultStageGit.fingerprint(dir))!;
        expect(await defaultStageGit.fingerprint(dir)).toBe(base);
        // 1. a reviewer that runs tests/builds rewrites IGNORED output: not a source mutation, the verdict stays valid
        await new Promise(r => setTimeout(r, 15));
        writeFileSync(join(dir, 'secret.cfg'), 'v2-longer');
        expect(await defaultStageGit.fingerprint(dir)).toBe(base);
        const { mkdirSync } = await import('node:fs');
        mkdirSync(join(dir, 'build')); writeFileSync(join(dir, 'build', 'out.js'), 'x');
        await new Promise(r => setTimeout(r, 15));
        writeFileSync(join(dir, 'build', 'out.js'), 'xyz');
        expect(await defaultStageGit.fingerprint(dir)).toBe(base);
        // 2. an untracked (non-ignored) source file is still a mutation, and so is its in-place edit
        writeFileSync(join(dir, 'new.ts'), 'x');
        const withNew = (await defaultStageGit.fingerprint(dir))!;
        expect(withNew).not.toBe(base);
        await new Promise(r => setTimeout(r, 15));
        writeFileSync(join(dir, 'new.ts'), 'xyz');
        expect(await defaultStageGit.fingerprint(dir)).not.toBe(withNew);
        rmSync(join(dir, 'new.ts'));
        // 3. skip-worktree flag (hides later edits from status/diff)
        const before = (await defaultStageGit.fingerprint(dir))!;
        git(dir, 'update-index', '--skip-worktree', 'a.txt');
        expect(await defaultStageGit.fingerprint(dir)).not.toBe(before);
        // 4. tracked content edit under skip-worktree is hidden from diff, but the flag change above already tripped it;
        //    an ordinary tracked edit is caught by the diff hash
        git(dir, 'update-index', '--no-skip-worktree', 'a.txt');
        const clean = (await defaultStageGit.fingerprint(dir))!;
        writeFileSync(join(dir, 'a.txt'), '2\n');
        expect(await defaultStageGit.fingerprint(dir)).not.toBe(clean);
    });

    it('current fingerprints carry a version line; the legacy format still counts git-ignored output (in-flight reviews keep their old strictness)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'stage-fp-legacy-')); dirs.push(dir);
        git(dir, 'init', '-b', 'main');
        writeFileSync(join(dir, '.gitignore'), 'out.log\n'); writeFileSync(join(dir, 'a.txt'), '1\n'); writeFileSync(join(dir, 'out.log'), 'v1');
        git(dir, 'add', '.'); git(dir, 'commit', '-m', 'one');
        const current = (await defaultStageGit.fingerprint(dir))!;
        const legacy = (await defaultStageGit.fingerprint(dir, { legacy: true }))!;
        expect(current.split('\n')[0]).toBe('fp2');
        expect(legacy.split('\n')).toHaveLength(5);
        expect(current.split('\n').slice(1)[0]).toBe(legacy.split('\n')[0]); // same HEAD line
        await new Promise(r => setTimeout(r, 15));
        writeFileSync(join(dir, 'out.log'), 'v2-longer');
        expect(await defaultStageGit.fingerprint(dir)).toBe(current);
        expect(await defaultStageGit.fingerprint(dir, { legacy: true })).not.toBe(legacy);
    });

    it('fingerprint fails closed on a spent budget or too many entries, and never blocks the event loop on the stat pass', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'stage-fp2-')); dirs.push(dir);
        git(dir, 'init', '-b', 'main'); writeFileSync(join(dir, 'a.txt'), '1\n'); git(dir, 'add', '.'); git(dir, 'commit', '-m', 'one');
        for (let i = 0; i < 40; i++) writeFileSync(join(dir, `u${i}.txt`), String(i));
        expect(await defaultStageGit.fingerprint(dir, { budgetMs: -1 })).toBeNull();
        expect(await defaultStageGit.fingerprint(dir, { maxEntries: 10 })).toBeNull();
        let ticks = 0;
        const timer = setInterval(() => { ticks++; }, 1);
        const fp = await defaultStageGit.fingerprint(dir, { concurrency: 4 });
        clearInterval(timer);
        expect(fp).toBeTruthy();
        expect(ticks).toBeGreaterThan(0); // the loop kept turning while stats were in flight
    });

    it('fallback seams: self-check unavailable (no bounce), reviewer workspace null (read lease)', async () => {
        expect((await unavailableSelfCheck.run({ meshId: 'm', taskId: 't', workspace: '/opt/ws', baseSha: 'b', profile: 'fast' })).status).toBe('unavailable');
        expect(await noReviewerWorkspace.prepare({} as never)).toBeNull();
        const ports = createProductionStagePorts({ sessionRegistry: undefined, instanceManager: undefined } as never);
        // a connected runner replaces the fallback without re-creating the ports
        setStagePorts({ selfCheck: { run: async () => ({ status: 'passed', log: 'ok' }) } });
        expect((await ports.selfCheck.run({ meshId: 'm', taskId: 't', workspace: '/opt/ws', baseSha: 'b', profile: 'fast' })).status).toBe('passed');
        setStagePorts({ reviewerWorkspace: { prepare: async () => ({ path: '/opt/light', headSha: 'h', release: async () => undefined }) } });
        expect((await ports.reviewerWorkspace.prepare({} as never))?.path).toBe('/opt/light');
    });

    it('self-check maps the shared fast profile: passed / failed / not configured / infra error', async () => {
        const req = { meshId: 'm', taskId: 't', workspace: '/opt/ws', baseSha: 'b1', profile: 'fast' as const };
        const seen: Array<{ profile: string; baseSha: string }> = [];
        const mk = (impl: () => Promise<any>) => createRefineProfileSelfCheck({ getMesh: () => ({ id: 'm' }), run: async (_m, _w, profile, o) => { seen.push({ profile, baseSha: o.baseSha }); return impl(); } });
        expect((await mk(async () => ({ status: 'passed', commandsRun: [{ command: 'x', exit: 0 }] })).run(req)).status).toBe('passed');
        const failed = await mk(async () => ({ status: 'failed', failureCode: 'command_failed', commandsRun: [{ command: 'lint', exit: 1 }] })).run(req);
        expect(failed.status).toBe('failed'); expect(failed.log).toContain('lint');
        expect((await mk(async () => ({ status: 'failed', failureCode: 'validation_profile_unknown' })).run(req)).status).toBe('skipped_not_configured');
        expect((await mk(async () => ({ status: 'skipped', skippedReason: 'validation_unavailable' })).run(req)).status).toBe('skipped_not_configured');
        expect((await mk(async () => { throw new Error('spawn blew up'); }).run(req)).status).toBe('skipped_infra_error');
        expect(seen[0]).toEqual({ profile: 'fast', baseSha: 'b1' });
        expect(mapProfileSummary({ status: 'passed' }).status).toBe('passed');
    });

    it('light reviewer workspace: null without config, detached head checkout with config, release removes it', async () => {
        const req = { meshId: 'm', parentTaskId: 'p1', reviewTaskId: 'r1', round: 2, rootSha: 'abc123', baseSha: 'b', sourceWorkspace: '/opt/checkout' };
        const calls: any[] = []; const removed: any[] = [];
        const none = createLightReviewerWorkspaceProvider({ loadConfig: (() => ({ ok: false, reason: 'missing', message: 'x', path: 'p' })) as never, prepare: (async () => { throw new Error('unreachable'); }) as never, remove: (async () => ({ removed: true, linksUnlinked: 0 })) as never });
        expect(await none.prepare(req)).toBeNull();
        const cfg = { version: 1, linkNodeModules: ['node_modules'] };
        const ok = createLightReviewerWorkspaceProvider({
            loadConfig: (() => ({ ok: true, config: cfg, path: 'p' })) as never,
            prepare: (async (i: any) => { calls.push(i); return { path: '/opt/light/ws-r2', rootBaseSha: 'abc123' }; }) as never,
            remove: (async (i: any) => { removed.push(i); return { removed: true, linksUnlinked: 0 }; }) as never,
        });
        const ws = (await ok.prepare(req))!;
        expect(calls[0]).toMatchObject({ meshId: 'm', taskId: 'p1', checkoutRoot: '/opt/checkout', rootBaseSha: 'abc123', branch: false, keySuffix: 'review-r2' });
        expect(ws).toMatchObject({ path: '/opt/light/ws-r2', headSha: 'abc123' });
        await ws.release();
        expect(removed[0]).toMatchObject({ path: '/opt/light/ws-r2', checkoutRoot: '/opt/checkout' });
        const broken = createLightReviewerWorkspaceProvider({ loadConfig: (() => ({ ok: true, config: cfg, path: 'p' })) as never, prepare: (async () => { throw new Error('disk full'); }) as never, remove: removed as never });
        expect(await broken.prepare(req)).toBeNull();
    });

    it('artifact port registers through the injected registrar with producerRole pipeline', () => {
        const calls: Array<Record<string, unknown>> = [];
        setStageArtifactRegistrar((input) => { calls.push(input); return 'art_1'; });
        const ports = createProductionStagePorts({} as never);
        const id = ports.artifacts.register({ meshId: 'm', missionId: 'mi', taskId: 'task-1', kind: 'diff', title: 'Diff', content: 'x', ext: '.diff' });
        expect(id).toBe('art_1');
        expect(calls[0]).toMatchObject({ sessionId: 'stage:task-1', taskId: 'task-1', meshId: 'm', missionId: 'mi', producerRole: 'pipeline' });
        setStageArtifactRegistrar(null);
        expect(ports.artifacts.register({ meshId: 'm', taskId: 't', kind: 'diff', title: 'D', content: 'x', ext: '.diff' })).toBeNull();
    });

    it('pipeline ceiling defaults to 4h and clamps the env override', () => {
        expect(resolveStagePipelineCeilingMs({})).toBe(4 * 3600_000);
        expect(resolveStagePipelineCeilingMs({ ADHDEV_STAGE_PIPELINE_CEILING_MS: '10' } as never)).toBe(60_000);
        expect(resolveStagePipelineCeilingMs({ ADHDEV_STAGE_PIPELINE_CEILING_MS: String(99 * 3600_000) } as never)).toBe(24 * 3600_000);
        expect(resolveStagePipelineCeilingMs({ ADHDEV_STAGE_PIPELINE_CEILING_MS: '600000' } as never)).toBe(600_000);
    });

    it('reviewInputValid accepts a resumed round-6 managed review child at the attested head/submodule and rejects head or artifact drift', async () => {
        const { createHash } = await import('node:crypto');
        const { realpathSync } = await import('node:fs');
        const { attestStageReviewInput } = await import('../../src/mesh/stage-review-input.js');
        const { initialStageState } = await import('../../src/mesh/stage-state.js');
        const ws = mkdtempSync(join(tmpdir(), 'stage-ports-r6-')); dirs.push(ws);
        const sub = mkdtempSync(join(tmpdir(), 'stage-ports-sub-')); dirs.push(sub);
        git(sub, 'init', '-b', 'main'); writeFileSync(join(sub, 'mod.ts'), 'export const v = 1;\n'); git(sub, 'add', '.'); git(sub, 'commit', '-m', 'sub');
        git(ws, 'init', '-b', 'main');
        git(ws, '-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'oss');
        git(ws, 'commit', '-m', 'old head');
        const oldHead = (await defaultStageGit.headSha(ws))!;
        writeFileSync(join(ws, 'root.ts'), 'export const r5 = true;\n'); git(ws, 'add', '.'); git(ws, 'commit', '-m', 'new head');
        const newHead = (await defaultStageGit.headSha(ws))!;
        const artFile = join(realpathSync.native(ws), 'art_cont.md');
        writeFileSync(artFile, 'continuation evidence');
        const grant = { id: 'art_cont', file: artFile, sha256: createHash('sha256').update('continuation evidence').digest('hex'), size: Buffer.byteLength('continuation evidence') };

        const st = initialStageState(new Date().toISOString());
        Object.assign(st, {
            phase: 'awaiting_review', round: 6, released: false,
            baseSha: oldHead,
            stageHeads: [...[1, 2, 3, 4, 5].map(r => ({ round: r, rootSha: oldHead })), { round: 6, rootSha: newHead }],
            reviewTaskIds: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
            artifacts: { diff: ['d_old', 'd_r6'], selfCheck: ['sc_old'], verdict: ['v1', 'v2', 'v3', 'v4', 'v5'] },
            selfCheck: 'unavailable',
        });
        const parent: any = { id: 'parent_3e2', meshId: 'm', status: 'assigned', stagePlan: { review: true, maxRevisions: 2, independence: 'different_provider' }, stageState: st };
        const proof = attestStageReviewInput(parent, { repoIdentity: 'repo', machineId: 'm', nodeId: 'node_a992', workspace: ws }, [grant]);
        proof.childTaskId = 'c6';
        parent.stageReviewInput = proof;
        const child: any = { id: 'c6', origin: 'stage', parentTaskId: 'parent_3e2', stageRole: 'review', stageRound: 6, readonly: true, inputArtifactIds: ['art_cont'] };

        const ports = createProductionStagePorts({} as never);
        expect(ports.queue.reviewInputValid!(parent, child)).toBe(true);
        expect(parent.stageState.selfCheck).toBe('unavailable');
        expect(parent.stageState.artifacts.selfCheck).toEqual(['sc_old']);

        // Artifact tampering invalidates the review input fail-closed
        writeFileSync(artFile, 'tampered');
        expect(ports.queue.reviewInputValid!(parent, child)).toBe(false);
        writeFileSync(artFile, 'continuation evidence');
        expect(ports.queue.reviewInputValid!(parent, child)).toBe(true);
    });
});
