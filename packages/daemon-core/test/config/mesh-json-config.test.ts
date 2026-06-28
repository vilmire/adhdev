import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    loadRepoMeshJsonConfig,
    normalizeRepoMeshDeclarativeConfig,
    mergeEffectiveCoordinatorConfig,
    mergeEffectiveOperatingNotes,
    applyRepoMeshConfig,
    buildMeshJsonConfigScaffold,
    MESH_JSON_CONFIG_LOCATIONS,
} from '../../src/config/mesh-json-config.js';
import { mergeAndNormalizePolicy } from '../../src/repo-mesh-types.js';

const tmpDirs: string[] = [];
function makeWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-json-cfg-'));
    tmpDirs.push(dir);
    mkdirSync(join(dir, '.adhdev'), { recursive: true });
    return dir;
}
function writeMeshJson(workspace: string, body: unknown): void {
    writeFileSync(join(workspace, '.adhdev', 'mesh.json'), JSON.stringify(body, null, 2), 'utf-8');
}

afterEach(() => {
    while (tmpDirs.length) {
        const d = tmpDirs.pop()!;
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

describe('mesh-json-config — normalize', () => {
    it('rejects a non-object / wrong-version document', () => {
        expect(normalizeRepoMeshDeclarativeConfig(null).valid).toBe(false);
        expect(normalizeRepoMeshDeclarativeConfig('nope' as any).valid).toBe(false);
        expect(normalizeRepoMeshDeclarativeConfig({ version: 2 }).valid).toBe(false);
    });

    it('keeps known zones and drops unknown top-level keys', () => {
        const { valid, config } = normalizeRepoMeshDeclarativeConfig({
            version: 1,
            coordinator: { systemPromptAppend: 'extra', maxPromptChars: 1000 },
            operatingNotes: [{ text: 'note', category: 'provider_quirk' }, { text: '   ' }],
            limits: { maxNotes: 10 },
            futureUnknown: { whatever: true },
        });
        expect(valid).toBe(true);
        expect(config!.coordinator).toEqual({ systemPromptAppend: 'extra', maxPromptChars: 1000 });
        expect(config!.operatingNotes).toEqual([{ text: 'note', category: 'provider_quirk' }]);
        expect(config!.limits).toEqual({ maxNotes: 10 });
        expect((config as any).futureUnknown).toBeUndefined();
    });

    it('policy is NOT a zone — a policy block is silently dropped (machine-local only)', () => {
        const { valid, config } = normalizeRepoMeshDeclarativeConfig({
            version: 1,
            policy: { maxParallelTasks: 4 },
            coordinator: { systemPromptAppend: 'x' },
        });
        expect(valid).toBe(true);
        expect((config as any).policy).toBeUndefined();
        expect(config!.coordinator).toEqual({ systemPromptAppend: 'x' });
    });
});

describe('mesh-json-config — loader', () => {
    it('loads .adhdev/mesh.json from the workspace (coordinator zone)', () => {
        const ws = makeWorkspace();
        writeMeshJson(ws, { version: 1, coordinator: { systemPromptAppend: 'REPO' } });
        const result = loadRepoMeshJsonConfig(ws);
        expect(result.sourceType).toBe('repo_file');
        expect(result.source).toBe('.adhdev/mesh.json');
        expect(result.config?.coordinator).toEqual({ systemPromptAppend: 'REPO' });
    });

    it('a policy block in the repo file is dropped on load (machine-local only)', () => {
        const ws = makeWorkspace();
        writeMeshJson(ws, { version: 1, policy: { maxParallelTasks: 5 } });
        const result = loadRepoMeshJsonConfig(ws);
        expect(result.sourceType).toBe('repo_file');
        expect((result.config as any)?.policy).toBeUndefined();
    });

    it('returns unavailable when no file exists', () => {
        const ws = makeWorkspace();
        const result = loadRepoMeshJsonConfig(ws);
        expect(result.sourceType).toBe('unavailable');
        expect(result.config).toBeUndefined();
    });

    it('returns invalid (not throwing) on malformed JSON', () => {
        const ws = makeWorkspace();
        writeFileSync(join(ws, '.adhdev', 'mesh.json'), '{ not json', 'utf-8');
        const result = loadRepoMeshJsonConfig(ws);
        expect(result.sourceType).toBe('invalid');
        expect(result.config).toBeUndefined();
        expect(result.error).toBeTruthy();
    });

    it('exposes the checked location list with mesh.json first (backward compat)', () => {
        expect(MESH_JSON_CONFIG_LOCATIONS[0]).toBe('.adhdev/mesh.json');
    });
});

describe('mesh-json-config — coordinator merge', () => {
    it('systemPromptOverride: local wins, else repo', () => {
        expect(mergeEffectiveCoordinatorConfig({ systemPromptOverride: 'REPO' }, {}).systemPromptOverride).toBe('REPO');
        expect(mergeEffectiveCoordinatorConfig({ systemPromptOverride: 'REPO' }, { systemPromptOverride: 'LOCAL' }).systemPromptOverride).toBe('LOCAL');
        expect(mergeEffectiveCoordinatorConfig(undefined, {}).systemPromptOverride).toBeUndefined();
    });

    it('systemPromptAppend: repo + local both stack, repo first', () => {
        const merged = mergeEffectiveCoordinatorConfig(
            { systemPromptAppend: 'REPO-APPEND' },
            { systemPromptAppend: 'LOCAL-APPEND' },
        );
        expect(merged.systemPromptAppend).toBe('REPO-APPEND\n\nLOCAL-APPEND');
    });

    it('folds the legacy local systemPromptSuffix into the stacked append', () => {
        const merged = mergeEffectiveCoordinatorConfig(
            { systemPromptAppend: 'REPO-APPEND' },
            { systemPromptSuffix: 'LEGACY' } as any,
        );
        expect(merged.systemPromptAppend).toBe('REPO-APPEND\n\nLEGACY');
        expect(merged.systemPromptSuffix).toBeUndefined();
    });

    it('preserves other coordinator fields (providerType/preferredNodeId)', () => {
        const merged = mergeEffectiveCoordinatorConfig(undefined, { providerType: 'claude-cli', preferredNodeId: 'node_1' });
        expect(merged.providerType).toBe('claude-cli');
        expect(merged.preferredNodeId).toBe('node_1');
    });
});

describe('mesh-json-config — operating notes merge (ledger wins)', () => {
    it('merges repo baseline with ledger notes, repo first', () => {
        const merged = mergeEffectiveOperatingNotes(
            [{ text: 'repo lesson', category: 'pattern_to_avoid' }],
            [{ text: 'ledger lesson', category: 'recovery_lesson' }],
        );
        expect(merged).toEqual([
            { text: 'repo lesson', category: 'pattern_to_avoid' },
            { text: 'ledger lesson', category: 'recovery_lesson' },
        ]);
    });

    it('dedup by text → ledger note wins (repo duplicate dropped)', () => {
        const merged = mergeEffectiveOperatingNotes(
            [{ text: 'same', category: 'pattern_to_avoid' }],
            [{ text: 'same', category: 'recovery_lesson', createdAt: '2026-06-27T00:00:00Z' }],
        );
        expect(merged).toEqual([{ text: 'same', category: 'recovery_lesson', createdAt: '2026-06-27T00:00:00Z' }]);
    });

    it('returns undefined when nothing usable', () => {
        expect(mergeEffectiveOperatingNotes(undefined, undefined)).toBeUndefined();
        expect(mergeEffectiveOperatingNotes([{ text: '  ' }], [])).toBeUndefined();
    });
});

describe('mesh-json-config — applyRepoMeshConfig (coordinator-only)', () => {
    it('layers the repo coordinator zone under local without mutating inputs; policy untouched', () => {
        const mesh = {
            policy: mergeAndNormalizePolicy(undefined, { maxParallelTasks: 7 }),
            coordinator: { providerType: 'claude-cli' },
        };
        const snapshot = JSON.parse(JSON.stringify(mesh));
        const effective = applyRepoMeshConfig(mesh, {
            version: 1,
            coordinator: { systemPromptAppend: 'REPO' },
        });
        expect(effective.coordinator.systemPromptAppend).toBe('REPO');
        expect(effective.coordinator.providerType).toBe('claude-cli');
        // policy is machine-local: carried through verbatim, never sourced from the repo file
        expect(effective.policy.maxParallelTasks).toBe(7);
        // input mesh untouched
        expect(mesh).toEqual(snapshot);
        expect(effective).not.toBe(mesh);
    });

    it('returns the same mesh when there is no repo config', () => {
        const mesh = { coordinator: {} };
        expect(applyRepoMeshConfig(mesh, null)).toBe(mesh);
    });
});

describe('mesh-json-config — export scaffold (coordinator-only)', () => {
    it('builds a draft from the coordinator prompt; policy is NOT exported', () => {
        const scaffold = buildMeshJsonConfigScaffold({
            coordinator: { systemPromptOverride: 'OVR', systemPromptAppend: 'APP' },
        } as any);
        expect(scaffold.version).toBe(1);
        expect((scaffold as any).policy).toBeUndefined();
        expect(scaffold.coordinator).toEqual({ systemPromptOverride: 'OVR', systemPromptAppend: 'APP' });
        // operating notes are intentionally NOT exported
        expect(scaffold.operatingNotes).toBeUndefined();
    });

    it('omits the coordinator block when there is no prompt customization', () => {
        const scaffold = buildMeshJsonConfigScaffold({ coordinator: {} } as any);
        expect(scaffold.coordinator).toBeUndefined();
    });
});
