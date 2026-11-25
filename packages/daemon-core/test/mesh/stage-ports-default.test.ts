import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

vi.mock('../../src/config/config.js', () => ({ getConfigDir: () => join(tmpdir(), 'adhdev-stage-ports-cfg'), loadConfig: () => ({}), getMachineId: () => 'm', getMachineNickname: () => null }));
vi.mock('../../src/config/mesh-config.js', () => ({ getMesh: vi.fn(() => undefined), getMeshByRepo: vi.fn(), listMeshes: vi.fn(() => []) }));

import { ArtifactGuardError } from '../../src/artifacts/types.js';
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
        expect(id).toEqual({ ok: true, artifactId: 'art_1' });
        expect(calls[0]).toMatchObject({ sessionId: 'stage:task-1', taskId: 'task-1', meshId: 'm', missionId: 'mi', producerRole: 'pipeline' });
        expect(String(calls[0]?.path)).toMatch(/^diff-[0-9a-f]{16}\.diff$/);
        const again = ports.artifacts.register({ meshId: 'm', missionId: 'mi', taskId: 'task-1', kind: 'diff', title: 'Diff', content: 'x', ext: '.diff' });
        expect(again).toEqual({ ok: true, artifactId: 'art_1' });
        expect(calls).toHaveLength(2);
        setStageArtifactRegistrar(null);
        expect(ports.artifacts.register({ meshId: 'm', taskId: 't', kind: 'diff', title: 'D', content: 'x', ext: '.diff' })).toMatchObject({
            ok: false,
            code: 'artifact_storage_unavailable',
        });
    });

    it('stable operationKey same-bytes no-ops; changed bytes and prefix-extension conflict preserve finals', () => {
        const calls: Array<Record<string, unknown>> = [];
        setStageArtifactRegistrar((input) => { calls.push(input); return `art_${calls.length}`; });
        const ports = createProductionStagePorts({} as never);
        const base = {
            meshId: 'm', taskId: 'task-op', kind: 'self_check' as const, title: 'Self-check', ext: '.md' as const,
            operationKey: 'self_check-r0-b0',
        };
        const first = ports.artifacts.register({ ...base, content: '# Self-check (passed)\n\nok\n' });
        expect(first).toEqual({ ok: true, artifactId: 'art_1' });
        expect(String(calls[0]?.path)).toBe('self_check-r0-b0.md');
        const noop = ports.artifacts.register({ ...base, content: '# Self-check (passed)\n\nok\n' });
        expect(noop).toEqual({ ok: true, artifactId: 'art_2' });
        const conflict = ports.artifacts.register({ ...base, content: '# Self-check (failed)\n\nbad\n' });
        expect(conflict).toMatchObject({ ok: false, code: 'artifact_revision_conflict', preserved: true });

        // R4-01: a successful shorter body that is a proper prefix of the retry must NOT be unlinked/replaced.
        const dir = join(tmpdir(), 'adhdev-stage-ports-cfg', 'stage-artifacts', 'task-op');
        const prefixPath = join(dir, 'self_check-r0-b1.md');
        mkdirSync(dir, { recursive: true });
        const shortBody = 'abc';
        writeFileSync(prefixPath, shortBody);
        const beforeCalls = calls.length;
        const prefixConflict = ports.artifacts.register({
            ...base,
            operationKey: 'self_check-r0-b1',
            content: 'abcdef',
        });
        expect(prefixConflict).toMatchObject({ ok: false, code: 'artifact_revision_conflict', preserved: true });
        expect(readFileSync(prefixPath, 'utf8')).toBe(shortBody);
        expect(calls.length).toBe(beforeCalls);

        // Leftover .publishing temp is cleaned; a missing final still publishes via temp+rename.
        writeFileSync(join(dir, 'self_check-r0-b2.md.publishing.999.1'), 'partial');
        const published = ports.artifacts.register({
            ...base,
            operationKey: 'self_check-r0-b2',
            content: 'fresh body\n',
        });
        expect(published).toEqual({ ok: true, artifactId: `art_${beforeCalls + 1}` });
        expect(readFileSync(join(dir, 'self_check-r0-b2.md'), 'utf8')).toBe('fresh body\n');
        setStageArtifactRegistrar(null);
    });

    it('ArtifactGuardError details/retryable propagate on registrar failure without replacing finals', () => {
        let attempts = 0;
        setStageArtifactRegistrar(() => {
            attempts += 1;
            if (attempts === 1) return 'art_ok';
            throw new ArtifactGuardError('artifact_storage_budget_exceeded', 'budget', {
                scope: 'mesh',
                currentBytes: 10,
                deltaBytes: 5,
                limitBytes: 12,
                retryable: false,
                preserved: true,
            });
        });
        const ports = createProductionStagePorts({} as never);
        const base = {
            meshId: 'm', taskId: 'task-guard', kind: 'diff' as const, title: 'Diff', ext: '.diff' as const,
            operationKey: 'diff-guard',
        };
        expect(ports.artifacts.register({ ...base, content: 'abc' })).toEqual({ ok: true, artifactId: 'art_ok' });
        const fail = ports.artifacts.register({ ...base, content: 'abcdef' });
        expect(fail).toMatchObject({
            ok: false,
            code: 'artifact_revision_conflict',
            preserved: true,
        });
        const dir = join(tmpdir(), 'adhdev-stage-ports-cfg', 'stage-artifacts', 'task-guard');
        expect(readFileSync(join(dir, 'diff-guard.diff'), 'utf8')).toBe('abc');

        // Same bytes retry still reaches registrar; GuardError details are preserved.
        const budget = ports.artifacts.register({ ...base, content: 'abc' });
        expect(budget).toMatchObject({
            ok: false,
            code: 'artifact_storage_budget_exceeded',
            retryable: false,
            preserved: true,
            details: expect.objectContaining({ scope: 'mesh', currentBytes: 10, limitBytes: 12 }),
        });
        expect(readFileSync(join(dir, 'diff-guard.diff'), 'utf8')).toBe('abc');
        setStageArtifactRegistrar(null);
    });

    it('pipeline ceiling defaults to 4h and clamps the env override', () => {
        expect(resolveStagePipelineCeilingMs({})).toBe(4 * 3600_000);
        expect(resolveStagePipelineCeilingMs({ ADHDEV_STAGE_PIPELINE_CEILING_MS: '10' } as never)).toBe(60_000);
        expect(resolveStagePipelineCeilingMs({ ADHDEV_STAGE_PIPELINE_CEILING_MS: String(99 * 3600_000) } as never)).toBe(24 * 3600_000);
        expect(resolveStagePipelineCeilingMs({ ADHDEV_STAGE_PIPELINE_CEILING_MS: '600000' } as never)).toBe(600_000);
    });

    it('reviewInputValid accepts a resumed round-6 managed review child at the attested head/submodule and rejects head or artifact drift', async () => {
        const { default: Database } = await import('better-sqlite3');
        const { ArtifactStore } = await import('../../src/artifacts/artifact-store.js');
        const { MeshRuntimeStore } = await import('../../src/mesh/mesh-runtime-store.js');
        const { registerStageDiff } = await import('../../src/mesh/stage-diff-stream.js');
        const { realpathSync } = await import('node:fs');
        const { attestStageReviewInput, stageReviewArtifactGrants } = await import('../../src/mesh/stage-review-input.js');
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

        const st = initialStageState(new Date().toISOString());
        Object.assign(st, {
            phase: 'awaiting_review', round: 6, released: false,
            baseSha: oldHead,
            stageHeads: [...[1, 2, 3, 4, 5].map(r => ({ round: r, rootSha: oldHead })), { round: 6, rootSha: newHead }],
            reviewTaskIds: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
            artifacts: { diff: ['d_old', 'd_r6'], selfCheck: ['sc_old'], verdict: ['v1', 'v2', 'v3', 'v4', 'v5'] },
            selfCheck: 'unavailable',
        });
        const parent: any = { id: basename(ws), meshId: 'm', status: 'assigned', stagePlan: { review: true, maxRevisions: 2, independence: 'different_provider' }, stageState: st };
        dirs.push(join(tmpdir(), 'adhdev-stage-ports-cfg', 'stage-artifacts', parent.id));
        const db = new Database(':memory:');
        const artifacts = new ArtifactStore(db);
        const facade = { db, findQueueEntryById: () => parent } as any;
        const storeSpy = vi.spyOn(MeshRuntimeStore, 'getInstance').mockReturnValue(facade);
        setStageArtifactRegistrar(input => artifacts.register(input).record.artifactId);
        try {
            const ports = createProductionStagePorts({ statusInstanceId: 'm' } as never);
            const continuationId = artifacts.register({ sessionId: 'implementation', taskId: parent.id, meshId: parent.meshId,
                producerRole: 'worker', workspaceRoot: realpathSync.native(ws), path: 'art_cont.md', kind: 'markdown', title: 'Continuation evidence' }).record.artifactId;
            const diff = await registerStageDiff({ git: defaultStageGit, artifacts: ports.artifacts, workspace: ws, base: oldHead, head: newHead,
                meshId: parent.meshId, taskId: parent.id, round: 6, originDaemonId: 'm', operationKey: 'diff-round6' });
            st.artifacts.diff = ['d_old', diff.artifactId];
            const grants = stageReviewArtifactGrants(facade, parent, [diff.artifactId, continuationId]);
            expect(grants.map(g => g.id)).toEqual([diff.artifactId, ...diff.manifest.chunks.map(c => c.id), continuationId]);
            expect(diff.manifest.scope).toMatchObject({ baseSha: oldHead, headSha: newHead, round: 6, taskId: parent.id, producerRole: 'pipeline', originDaemonId: 'm' });
            const proof = attestStageReviewInput(parent, { repoIdentity: 'repo', machineId: 'm', nodeId: 'fixture-node', workspace: ws }, grants);
            proof.childTaskId = 'c6';
            parent.stageReviewInput = proof;
            const child: any = { id: 'c6', origin: 'stage', parentTaskId: parent.id, stageRole: 'review', stageRound: 6, readonly: true, inputArtifactIds: grants.map(g => g.id) };
            expect(ports.queue.reviewInputValid!(parent, child)).toBe(true);
            expect(st.baseSha).toBe(oldHead);
            expect(st.selfCheck).toBe('unavailable');
            expect(st.artifacts.selfCheck).toEqual(['sc_old']);

            // Missing latest diff, stale historical diff and continuation-only input stay refused.
            for (const ids of [[], ['d_old'], [continuationId], [diff.artifactId, continuationId]]) {
                expect(ports.queue.reviewInputValid!(parent, { ...child, inputArtifactIds: ids })).toBe(false);
            }
            expect(() => attestStageReviewInput(parent, { repoIdentity: 'repo', machineId: 'm', nodeId: 'fixture-node', workspace: ws }, grants.filter(g => g.id === continuationId))).toThrow('review_diff_latest_missing');
            st.round = 7;
            expect(ports.queue.reviewInputValid!(parent, child)).toBe(false);
            st.round = 6;
            writeFileSync(artFile, 'tampered');
            expect(ports.queue.reviewInputValid!(parent, child)).toBe(false);
            writeFileSync(artFile, 'continuation evidence');
            expect(ports.queue.reviewInputValid!(parent, child)).toBe(true);
            git(ws, 'commit', '--allow-empty', '-m', 'changed head');
            expect(ports.queue.reviewInputValid!(parent, child)).toBe(false);
        } finally {
            setStageArtifactRegistrar(null);
            storeSpy.mockRestore();
            db.close();
        }
    });

    it('R7-02: writeRecovery is digest-immutable — same bytes no-op; different bytes coexist without overwrite', () => {
        const ports = createProductionStagePorts({} as never);
        const taskId = 'task-recovery-digest';
        const op = 'self_check-r0-b0';
        const bodyA = `recovery-A\n${'a'.repeat(2_000)}\n`;
        const bodyB = `recovery-B\n${'b'.repeat(2_000)}\n`;
        const first = ports.artifacts.writeRecovery!({ taskId, operationKey: op, content: bodyA, ext: '.md' });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const reused = ports.artifacts.writeRecovery!({ taskId, operationKey: op, content: bodyA, ext: '.md' });
        expect(reused).toMatchObject({ ok: true, reused: true, sha256: first.sha256, relPath: first.relPath });
        const second = ports.artifacts.writeRecovery!({ taskId, operationKey: op, content: bodyB, ext: '.md' });
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.sha256).not.toBe(first.sha256);
        expect(second.relPath).not.toBe(first.relPath);
        expect(ports.artifacts.readRecovery!({ taskId, operationKey: op, sha256: first.sha256 })).toBe(bodyA);
        expect(ports.artifacts.readRecovery!({ taskId, operationKey: op, sha256: second.sha256 })).toBe(bodyB);
        const dir = join(tmpdir(), 'adhdev-stage-ports-cfg', 'stage-artifacts', taskId, '.recovery');
        expect(readFileSync(join(dir, `${op}.${first.sha256.slice(0, 12)}.md`), 'utf8')).toBe(bodyA);
        expect(readFileSync(join(dir, `${op}.${second.sha256.slice(0, 12)}.md`), 'utf8')).toBe(bodyB);
    });

    it('R9-01: production readRecovery refuses digest-prefix file whose contents no longer match sha256', () => {
        const ports = createProductionStagePorts({} as never);
        // Unique task dir so a prior corrupt overwrite cannot make writeRecovery hit revision_conflict.
        const taskId = `task-recovery-corrupt-${Date.now()}`;
        const op = 'review_verdict-r1-child';
        const bodyA = JSON.stringify({
            round: 1,
            reviewTaskId: 'child',
            independenceUsed: 'different_provider',
            verdict: 'changes_requested',
            findings: [{ id: 'F1', severity: 'major', category: 'correctness', claim: 'c', evidence: 'e' }],
            checked: ['a'],
            notChecked: ['b'],
        }, null, 2);
        const written = ports.artifacts.writeRecovery!({ taskId, operationKey: op, content: bodyA, ext: '.json' });
        expect(written).toMatchObject({ ok: true });
        if (!written.ok) return;
        const dir = join(tmpdir(), 'adhdev-stage-ports-cfg', 'stage-artifacts', taskId, '.recovery');
        const fileName = `${op}.${written.sha256.slice(0, 12)}.json`;
        const bodyB = JSON.stringify({
            round: 1,
            reviewTaskId: 'child',
            independenceUsed: 'different_provider',
            verdict: 'approve',
            findings: [],
            checked: ['a'],
            notChecked: ['b'],
        }, null, 2);
        writeFileSync(join(dir, fileName), bodyB);
        // Same digest-prefix path, different bytes → must not return the corrupt body.
        expect(ports.artifacts.readRecovery!({ taskId, operationKey: op, sha256: written.sha256 })).toBeNull();
    });

    it('R7-01: production writeRecovery persistence failure returns preserved=false without discarding prior digest files', () => {
        const ports = createProductionStagePorts({} as never);
        const taskId = 'task-recovery-enospc';
        const op = 'diff-base-head';
        const prior = ports.artifacts.writeRecovery!({ taskId, operationKey: op, content: 'prior-body\n', ext: '.diff' });
        expect(prior.ok).toBe(true);
        if (!prior.ok) return;
        const dir = join(tmpdir(), 'adhdev-stage-ports-cfg', 'stage-artifacts', taskId, '.recovery');
        // Real fs failure (no ESM spy on fsync): make the recovery dir non-writable so the next publish fails.
        chmodSync(dir, 0o555);
        try {
            const failed = ports.artifacts.writeRecovery!({ taskId, operationKey: op, content: 'new-body-after-enospc\n', ext: '.diff' });
            expect(failed).toMatchObject({
                ok: false,
                code: 'artifact_storage_unavailable',
                preserved: false,
            });
        } finally {
            chmodSync(dir, 0o755);
        }
        // Prior digest file must still be readable (failed write did not clobber it).
        expect(ports.artifacts.readRecovery!({ taskId, operationKey: op, sha256: prior.sha256 })).toBe('prior-body\n');
    });
});
