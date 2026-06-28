/**
 * loadRepoSettings — the unified `.adhdev/*` config aggregator.
 *
 * Verifies the loader CALLS each dedicated, file-separated loader and assembles
 * the results into one RepoSettings object — without inlining anything into
 * mesh.json. Coordinator + operatingNotes are lifted out of the mesh.json result;
 * refine / worktree-bootstrap / change-impact each keep their own load result.
 * Policy is never part of repo settings (machine-local only).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadRepoSettings } from '../../src/config/repo-settings.js';

const tmpDirs: string[] = [];
function makeWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'repo-settings-'));
    tmpDirs.push(dir);
    mkdirSync(join(dir, '.adhdev'), { recursive: true });
    return dir;
}
function writeFile(ws: string, rel: string, body: unknown): void {
    writeFileSync(join(ws, '.adhdev', rel), JSON.stringify(body, null, 2), 'utf-8');
}

afterEach(() => {
    while (tmpDirs.length) {
        const d = tmpDirs.pop()!;
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

describe('loadRepoSettings — assembly of file-separated configs', () => {
    it('assembles all four configs from their separate files', () => {
        const ws = makeWorkspace();
        writeFile(ws, 'mesh.json', {
            version: 1,
            coordinator: { systemPromptAppend: 'REPO-RULE' },
            operatingNotes: [{ text: 'a repo lesson', category: 'pattern_to_avoid' }],
            limits: { maxNotes: 5 },
        });
        writeFile(ws, 'refine.json', { version: 1, validation: { required: true, commands: [{ command: 'npm run typecheck', category: 'typecheck' }] } });
        writeFile(ws, 'worktree_bootstrap.json', { version: 1, commands: [{ command: 'npm ci' }] });
        writeFile(ws, 'change-impact.json', { daemonRuntimePackages: ['daemon-core'] });

        const settings = loadRepoSettings({ workspace: ws });

        // mesh.json coordinator/operatingNotes/limits lifted out for convenience.
        expect(settings.coordinator).toEqual({ systemPromptAppend: 'REPO-RULE' });
        expect(settings.operatingNotes).toEqual([{ text: 'a repo lesson', category: 'pattern_to_avoid' }]);
        expect(settings.limits).toEqual({ maxNotes: 5 });
        expect(settings.meshJson.sourceType).toBe('repo_file');

        // Each sub-config carries its own load result from its own file.
        expect(settings.refine.sourceType).toBe('repo_file');
        expect(settings.refine.source).toBe('.adhdev/refine.json');
        expect(settings.refine.config?.validation?.commands?.[0]?.command).toBe('npm run typecheck');

        expect(settings.worktreeBootstrap.sourceType).toBe('repo_file');
        expect(settings.worktreeBootstrap.source).toBe('.adhdev/worktree_bootstrap.json');

        expect(settings.changeImpact.sourceType).toBe('repo_file');
        expect(settings.changeImpact.config?.daemonRuntimePackages).toEqual(['daemon-core']);
    });

    it('does not throw when no config files exist — every sub-config is unavailable', () => {
        const ws = makeWorkspace();
        const settings = loadRepoSettings({ workspace: ws });
        expect(settings.coordinator).toBeUndefined();
        expect(settings.operatingNotes).toBeUndefined();
        expect(settings.meshJson.sourceType).toBe('unavailable');
        expect(settings.refine.sourceType).toBe('unavailable');
        expect(settings.worktreeBootstrap.sourceType).toBe('unavailable');
        expect(settings.changeImpact.sourceType).toBe('unavailable');
    });

    it('surfaces an invalid mesh.json as meshJson.sourceType=invalid without throwing', () => {
        const ws = makeWorkspace();
        writeFileSync(join(ws, '.adhdev', 'mesh.json'), '{ not json', 'utf-8');
        const settings = loadRepoSettings({ workspace: ws });
        expect(settings.meshJson.sourceType).toBe('invalid');
        expect(settings.coordinator).toBeUndefined();
    });

    it('honors the machine-local INLINE seam for refine/bootstrap via the mesh arg', () => {
        const ws = makeWorkspace();
        // No repo files on disk; the inline mesh policy seam provides the config.
        const mesh = {
            policy: {
                refine: { version: 1, validation: { required: true, commands: [{ command: 'npm test' }] } },
                worktreeBootstrap: { version: 1, commands: [{ command: 'npm ci' }] },
            },
        };
        const settings = loadRepoSettings({ workspace: ws, mesh });
        expect(settings.refine.sourceType).toBe('mesh_policy');
        expect(settings.refine.config?.validation?.commands?.[0]?.command).toBe('npm test');
        expect(settings.worktreeBootstrap.sourceType).toBe('mesh_policy');
    });

    it('change-impact resolves against repoRoot when provided (else workspace)', () => {
        const ws = makeWorkspace();
        const repoRoot = makeWorkspace();
        writeFile(repoRoot, 'change-impact.json', { webOnlyPackages: ['web-cloud'] });
        const settings = loadRepoSettings({ workspace: ws, repoRoot });
        expect(settings.changeImpact.sourceType).toBe('repo_file');
        expect(settings.changeImpact.config?.webOnlyPackages).toEqual(['web-cloud']);
        // The workspace itself has no change-impact file.
        expect(loadRepoSettings({ workspace: ws }).changeImpact.sourceType).toBe('unavailable');
    });
});
