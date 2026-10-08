import { describe, expect, it } from 'vitest';
import { projectSlugBase, projectSlugs, resolveAssistantProject } from '../../src/assistant/assistant-projects.js';

/** Project addressing (design 2026-10-07-assistant-layer.md §4.2): never guesses. */

const meshes = [
    { id: 'mesh_a', name: 'ADHDev', repoIdentity: 'github.com/vilmire/adhdev' },
    { id: 'mesh_b', name: 'Prefex', repoIdentity: 'github.com/acme/prefex' },
    { id: 'mesh_c', name: 'Fork', repoIdentity: 'github.com/other/prefex' },
];

describe('slugs', () => {
    it('is the last repoIdentity segment, lowercased; collisions get the owner prefix', () => {
        expect(projectSlugBase('github.com/o/Repo.git')).toBe('repo');
        const s = projectSlugs(meshes);
        expect(s.get('mesh_a')).toBe('adhdev');
        expect(s.get('mesh_b')).toBe('acme-prefex');
        expect(s.get('mesh_c')).toBe('other-prefex');
    });
});

describe('resolveAssistantProject', () => {
    it('resolves by meshId, then case-insensitive name, then alias, then slug, then repoIdentity tail', () => {
        expect(resolveAssistantProject('mesh_b', meshes)).toMatchObject({ ok: true, mesh: { id: 'mesh_b' } });
        expect(resolveAssistantProject('adhdev', meshes)).toMatchObject({ ok: true, mesh: { id: 'mesh_a' }, slug: 'adhdev' });
        expect(resolveAssistantProject('FORK', meshes)).toMatchObject({ ok: true, mesh: { id: 'mesh_c' } });
        expect(resolveAssistantProject('main', meshes, { main: 'mesh_a' })).toMatchObject({ ok: true, mesh: { id: 'mesh_a' } });
        expect(resolveAssistantProject('acme-prefex', meshes)).toMatchObject({ ok: true, mesh: { id: 'mesh_b' } });
        expect(resolveAssistantProject('acme/prefex', meshes)).toMatchObject({ ok: true, mesh: { id: 'mesh_b' } });
    });

    it("resolves a standalone-paired member mesh by the host's mesh id (live 1.0.78 two-machine test)", () => {
        // The member keeps its own local id; the host dashboard and mesh tools show the host's id.
        const member = [...meshes, { id: 'mesh_local', name: 'sa-pub-member', repoIdentity: 'github.com/acme/sa-mm-test', meshHost: { hostMeshId: 'mesh_host' } }];
        expect(resolveAssistantProject('mesh_host', member)).toMatchObject({ ok: true, mesh: { id: 'mesh_local' } });
        expect(resolveAssistantProject('mesh_local', member)).toMatchObject({ ok: true, mesh: { id: 'mesh_local' } });
        expect(resolveAssistantProject('mesh_host', meshes)).toMatchObject({ ok: false, code: 'project_not_found' });
    });

    it('returns project_ambiguous with candidates instead of picking one', () => {
        const r = resolveAssistantProject('prefex', meshes.slice(1).map((m) => ({ ...m, name: undefined })));
        expect(r.ok).toBe(false);
        if (!r.ok && r.code === 'project_ambiguous') expect(r.candidates.map((c) => c.meshId).sort()).toEqual(['mesh_b', 'mesh_c']);
        else throw new Error(`expected ambiguous, got ${JSON.stringify(r)}`);
    });

    it('returns project_not_found with the project list for an unknown or empty ref', () => {
        for (const ref of ['nope', '', undefined, 42]) {
            const r = resolveAssistantProject(ref, meshes);
            expect(r).toEqual({ ok: false, code: 'project_not_found', projects: ['adhdev', 'acme-prefex', 'other-prefex'] });
        }
    });
});
