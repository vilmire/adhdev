import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/mesh-config.js', () => ({
    listMeshes: () => [
        {
            id: 'mesh_local_1',
            name: 'Local Mesh',
            repoIdentity: 'github.com/acme/app',
            repoRemoteUrl: 'https://github.com/acme/app.git',
            defaultBranch: 'main',
            policy: {},
            coordinator: {},
            nodes: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        },
    ],
    createMesh: vi.fn(),
}));

import { syncMeshes } from '../../src/mesh/mesh-sync.js';
import type { MeshSyncTransport } from '../../src/mesh/mesh-sync.js';

describe('mesh-sync', () => {
    it('syncs only mesh metadata and never calls Cloud/D1 ledger sync hooks', async () => {
        const transport = {
            listRemoteMeshes: vi.fn(async () => ({ meshes: [] })),
            createRemoteMesh: vi.fn(async () => ({
                mesh: {
                    id: 'mesh_remote_1',
                    name: 'Local Mesh',
                    repo_identity: 'github.com/acme/app',
                    repo_remote_url: 'https://github.com/acme/app.git',
                    default_branch: 'main',
                    policy: '{}',
                    status: 'active',
                    created_at: '2026-01-01T00:00:00.000Z',
                    updated_at: '2026-01-01T00:00:00.000Z',
                },
            })),
            deleteRemoteMesh: vi.fn(async () => undefined),
            // Intentional legacy method: syncMeshes must ignore it even if an
            // older cloud transport still exposes the deprecated hook at runtime.
            syncMeshLedger: vi.fn(async () => ({ missingEntries: [] })),
        } as MeshSyncTransport & { syncMeshLedger: ReturnType<typeof vi.fn> };

        const result = await syncMeshes(transport);

        expect(result).toEqual({ pushed: 1, pulled: 0, deleted: 0, errors: [] });
        expect(transport.createRemoteMesh).toHaveBeenCalledOnce();
        expect(transport.syncMeshLedger).not.toHaveBeenCalled();
    });
});
