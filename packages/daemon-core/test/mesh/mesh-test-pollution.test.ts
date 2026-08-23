import { describe, expect, it } from 'vitest';
import {
    isMeshTestPollution,
    isSyntheticTestCoordinatorSession,
    isSyntheticTestMeshId,
} from '../../src/mesh/mesh-test-pollution.js';

describe('isMeshTestPollution — query-time exclude for leaked fixture rows', () => {
    it('flags the mcp-server fixture mesh-id prefixes', () => {
        expect(isSyntheticTestMeshId('mesh_adopt_0628d005')).toBe(true);
        expect(isSyntheticTestMeshId('mesh_graph_e_0b22fb38')).toBe(true);
        expect(isSyntheticTestMeshId('mesh_graph_g_0b83508d')).toBe(true);
        expect(isSyntheticTestMeshId('mesh_g4dup_abc12345')).toBe(true);
    });

    it('does not flag a real mesh id', () => {
        expect(isSyntheticTestMeshId('mesh_271444af883843e9b36c67155b87b22f')).toBe(false);
        expect(isSyntheticTestMeshId('mesh_a9f7aaed323849ba95d9f9afd6390dc2')).toBe(false);
    });

    it('flags the hard-coded sess-coord fixture and sess-A', () => {
        expect(isSyntheticTestCoordinatorSession('sess-coord')).toBe(true);
        expect(isSyntheticTestCoordinatorSession('sess-A')).toBe(true);
        expect(isSyntheticTestCoordinatorSession('38097791-758b-44aa-965e-f9f01b6ee3cf')).toBe(false);
    });

    it('ORs the two axes so an aggregator can drop a row on either', () => {
        expect(isMeshTestPollution({ meshId: 'mesh_adopt_x', coordinatorSessionId: 'real' })).toBe(true);
        expect(isMeshTestPollution({ meshId: 'mesh_271444af', coordinatorSessionId: 'sess-coord' })).toBe(true);
        expect(isMeshTestPollution({
            meshId: 'mesh_271444af883843e9b36c67155b87b22f',
            coordinatorSessionId: '38097791-758b-44aa-965e-f9f01b6ee3cf',
        })).toBe(false);
    });
});
