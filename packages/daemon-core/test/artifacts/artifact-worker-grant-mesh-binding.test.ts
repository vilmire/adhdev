import { describe, expect, it } from 'vitest';
import { isSameBoundMesh } from '../../src/commands/med-family/artifact-sharing.js';

// OD-4 worker grants are scoped by mesh, not mission (2026-10-29). The mesh must be
// positively bound on both sides, or a coordinator could hand a worker an artifact
// that lives outside its mesh.
describe('worker artifact grant — mesh binding', () => {
    it('allows only an artifact bound to the same mesh as the task', () => {
        expect(isSameBoundMesh('mesh_a', 'mesh_a')).toBe(true);
        expect(isSameBoundMesh('mesh_b', 'mesh_a')).toBe(false);
    });
    it('never reaches an unbound artifact or an unbound task', () => {
        expect(isSameBoundMesh('', 'mesh_a')).toBe(false);
        expect(isSameBoundMesh(null, 'mesh_a')).toBe(false);
        expect(isSameBoundMesh(undefined, 'mesh_a')).toBe(false);
        expect(isSameBoundMesh('mesh_a', '')).toBe(false);
        expect(isSameBoundMesh('  ', '  ')).toBe(false);
    });
});
