import { afterEach, describe, expect, it } from 'vitest';
import { loadMeshConfigEntry, peekMeshNodes, saveMeshConfig } from '../../src/config/mesh-config-store.js';

// rc34 d49f221d: per-tick scheduling cloned the whole mesh entry once per slot
// just to read its node list (≈20% of the preview daemon's CPU on 2026-10-26).
// peekMeshNodes serves the cached snapshot's list without cloning, and still
// follows meshes.json changes.
describe('peekMeshNodes', () => {
    afterEach(() => { saveMeshConfig({ meshes: [] }); });

    it('returns the same cached node list across reads instead of a fresh clone', () => {
        saveMeshConfig({ meshes: [{ id: 'm', policyStorage: 2, nodes: [{ id: 'n1' }, { id: 'n2' }] }] } as any);
        const first = peekMeshNodes('m');
        expect(first?.map((n: any) => n.id)).toEqual(['n1', 'n2']);
        expect(peekMeshNodes('m')).toBe(first);
        // The mutable path still hands out an independent clone.
        expect(loadMeshConfigEntry('m')?.nodes).not.toBe(first);
    });

    it('picks up a rewritten meshes.json and returns undefined for an unknown mesh', () => {
        saveMeshConfig({ meshes: [{ id: 'm', policyStorage: 2, nodes: [{ id: 'n1' }] }] } as any);
        expect(peekMeshNodes('m')?.length).toBe(1);
        saveMeshConfig({ meshes: [{ id: 'm', policyStorage: 2, nodes: [{ id: 'n1' }, { id: 'n3' }] }] } as any);
        expect(peekMeshNodes('m')?.map((n: any) => n.id)).toEqual(['n1', 'n3']);
        expect(peekMeshNodes('absent')).toBeUndefined();
    });
});
