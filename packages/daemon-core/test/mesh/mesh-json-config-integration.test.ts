/**
 * OPSRULES integration smoke — real load → merge → coordinator-prompt build.
 *
 * Exercises the actual `.adhdev/mesh.json` loader, the coordinator/operatingNotes
 * merge, and the real buildCoordinatorSystemPrompt path (not stubs). Policy is
 * machine-local: a `policy` block in the repo file is ignored, and the prompt's
 * parallel-task line always reflects the machine-local mesh policy. The repo file
 * shapes only the coordinator prompt + operating notes.
 *
 *   (i)   repo file carries a policy block → IGNORED; prompt reflects machine-local policy
 *   (ii)  machine-local policy drives the prompt
 *   (ii-append) repo append + local append both stack
 *   (iii) repo operatingNotes + ledger note → merged in ## Operating Notes (ledger wins on dup)
 *   (iv)  export scaffold → local coordinator prompt emitted as a .adhdev/mesh.json draft
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    loadRepoMeshJsonConfig,
    applyRepoMeshConfig,
    mergeEffectiveOperatingNotes,
    buildMeshJsonConfigScaffold,
    serializeMeshJsonConfigScaffold,
} from '../../src/config/mesh-json-config.js';
import { buildCoordinatorSystemPrompt } from '../../src/mesh/coordinator-prompt.js';
import { mergeAndNormalizePolicy } from '../../src/repo-mesh-types.js';

const tmpDirs: string[] = [];
function workspaceWith(meshJson: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'opsrules-'));
    tmpDirs.push(dir);
    mkdirSync(join(dir, '.adhdev'), { recursive: true });
    writeFileSync(join(dir, '.adhdev', 'mesh.json'), JSON.stringify(meshJson, null, 2), 'utf-8');
    return dir;
}
function localMesh(policyPatch?: Record<string, unknown>, coordinator?: Record<string, unknown>) {
    return {
        id: 'mesh_int',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        policy: mergeAndNormalizePolicy(undefined, policyPatch),
        coordinator: coordinator || {},
        nodes: [{ id: 'node_1', workspace: '/repo', daemonId: 'daemon_1', userOverrides: {}, policy: {} }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
    } as any;
}

afterEach(() => {
    while (tmpDirs.length) {
        const d = tmpDirs.pop()!;
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

describe('OPSRULES integration — load → merge → prompt', () => {
    it('case (i): a repo policy block is IGNORED — the prompt reflects the machine-local policy', () => {
        // Repo file says 5, machine-local says 3. Policy is machine-local → 3 wins, 5 never appears.
        const ws = workspaceWith({ version: 1, policy: { maxParallelTasks: 5 } });
        const loaded = loadRepoMeshJsonConfig(ws);
        expect(loaded.sourceType).toBe('repo_file');
        expect((loaded.config as any)?.policy).toBeUndefined();

        const effective = applyRepoMeshConfig(localMesh({ maxParallelTasks: 3 }), loaded.config);
        expect(effective.policy.maxParallelTasks).toBe(3);

        const prompt = buildCoordinatorSystemPrompt({ mesh: effective, coordinatorCliType: 'claude-cli' });
        expect(prompt).toContain('Maximum **3** tasks running in parallel');
        expect(prompt).not.toContain('Maximum **5** tasks running in parallel');
    });

    it('case (ii): machine-local policy drives the prompt', () => {
        const ws = workspaceWith({ version: 1, coordinator: { systemPromptAppend: 'X' } });
        const loaded = loadRepoMeshJsonConfig(ws);

        const effective = applyRepoMeshConfig(localMesh({ maxParallelTasks: 8 }), loaded.config);
        expect(effective.policy.maxParallelTasks).toBe(8);

        const prompt = buildCoordinatorSystemPrompt({ mesh: effective, coordinatorCliType: 'claude-cli' });
        expect(prompt).toContain('Maximum **8** tasks running in parallel');
    });

    it('case (ii-append): repo append + local append both stack in the prompt', () => {
        const ws = workspaceWith({ version: 1, coordinator: { systemPromptAppend: 'REPO-RULE' } });
        const loaded = loadRepoMeshJsonConfig(ws);

        const effective = applyRepoMeshConfig(localMesh(undefined, { systemPromptAppend: 'LOCAL-RULE' }), loaded.config);
        const prompt = buildCoordinatorSystemPrompt({ mesh: effective, coordinatorCliType: 'claude-cli' });

        expect(prompt).toContain('REPO-RULE');
        expect(prompt).toContain('LOCAL-RULE');
        expect(prompt.indexOf('REPO-RULE')).toBeLessThan(prompt.indexOf('LOCAL-RULE'));
    });

    it('case (iii): repo operatingNotes + ledger note merge into ## Operating Notes (ledger wins on dup)', () => {
        const ws = workspaceWith({
            version: 1,
            operatingNotes: [
                { text: 'repo baseline lesson', category: 'pattern_to_avoid' },
                { text: 'shared lesson', category: 'pattern_to_avoid' },
            ],
        });
        const loaded = loadRepoMeshJsonConfig(ws);

        // Simulated ledger notes (what buildOperatingNotesBestEffort would return).
        const ledgerNotes = [
            { text: 'shared lesson', category: 'recovery_lesson' as const },
            { text: 'runtime-only lesson', category: 'provider_quirk' as const },
        ];
        const effectiveNotes = mergeEffectiveOperatingNotes(loaded.config?.operatingNotes, ledgerNotes);

        const prompt = buildCoordinatorSystemPrompt({
            mesh: applyRepoMeshConfig(localMesh(), loaded.config),
            coordinatorCliType: 'claude-cli',
            operatingNotes: effectiveNotes,
        });

        expect(prompt).toContain('## Operating Notes');
        expect(prompt).toContain('repo baseline lesson');
        expect(prompt).toContain('runtime-only lesson');
        // Dedup: the shared lesson appears once, with the LEDGER category (recovery lesson).
        expect(prompt).toContain('[recovery lesson] shared lesson');
        expect(prompt).not.toContain('[pattern to avoid] shared lesson');
    });

    it('case (iv): export scaffold emits the local coordinator prompt as a .adhdev/mesh.json draft (no policy)', () => {
        const mesh = localMesh({ maxParallelTasks: 6 }, { systemPromptAppend: 'TEAM-RULE' });
        const scaffold = buildMeshJsonConfigScaffold(mesh);
        const json = serializeMeshJsonConfigScaffold(scaffold);

        // The draft round-trips and reloads as a valid repo config.
        const ws = mkdtempSync(join(tmpdir(), 'opsrules-export-'));
        tmpDirs.push(ws);
        mkdirSync(join(ws, '.adhdev'), { recursive: true });
        writeFileSync(join(ws, '.adhdev', 'mesh.json'), json, 'utf-8');

        const reloaded = loadRepoMeshJsonConfig(ws);
        expect(reloaded.sourceType).toBe('repo_file');
        // policy is NOT exported into the scaffold (machine-local only)
        expect((reloaded.config as any)?.policy).toBeUndefined();
        expect(reloaded.config?.coordinator?.systemPromptAppend).toBe('TEAM-RULE');

        // Sanity: the serialized text is the canonical 2-space JSON.
        expect(readFileSync(join(ws, '.adhdev', 'mesh.json'), 'utf-8')).toContain('"version": 1');
    });
});
