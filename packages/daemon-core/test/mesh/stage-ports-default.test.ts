import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/config/config.js', () => ({ getConfigDir: () => join(tmpdir(), 'adhdev-stage-ports-cfg'), loadConfig: () => ({}), getMachineId: () => 'm', getMachineNickname: () => null }));
vi.mock('../../src/config/mesh-config.js', () => ({ getMesh: vi.fn(() => undefined), getMeshByRepo: vi.fn(), listMeshes: vi.fn(() => []) }));

import { defaultStageGit, noReviewerWorkspace, resolveStagePipelineCeilingMs, unavailableSelfCheck, createProductionStagePorts, setStageArtifactRegistrar, setStagePorts } from '../../src/mesh/stage-ports-default.js';

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

    it('fallback seams: self-check unavailable (no bounce), reviewer workspace null (read lease)', async () => {
        expect((await unavailableSelfCheck.run({ meshId: 'm', taskId: 't', workspace: '/opt/ws', baseSha: 'b', profile: 'fast' })).status).toBe('unavailable');
        expect(await noReviewerWorkspace.prepare({} as never)).toBeNull();
        const ports = createProductionStagePorts({ sessionRegistry: undefined, instanceManager: undefined } as never);
        expect((await ports.selfCheck.run({ meshId: 'm', taskId: 't', workspace: '/opt/ws', baseSha: 'b', profile: 'fast' })).status).toBe('unavailable');
        // a connected runner replaces the fallback without re-creating the ports
        setStagePorts({ selfCheck: { run: async () => ({ status: 'passed', log: 'ok' }) } });
        expect((await ports.selfCheck.run({ meshId: 'm', taskId: 't', workspace: '/opt/ws', baseSha: 'b', profile: 'fast' })).status).toBe('passed');
        setStagePorts({ reviewerWorkspace: { prepare: async () => ({ path: '/opt/light', headSha: 'h', release: async () => undefined }) } });
        expect((await ports.reviewerWorkspace.prepare({} as never))?.path).toBe('/opt/light');
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
});
