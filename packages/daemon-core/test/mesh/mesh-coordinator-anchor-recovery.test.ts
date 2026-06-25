import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// MESHID-DROP coordinator-anchor recovery (Fix B): when an unresolved-delegate forward
// reaches the coordinator with no resolvable meshId (workspace + nodeId scan both missed)
// but carries the worker's coordinator anchor (meshCoordinatorDaemonId), the coordinator
// recovers the meshId from the meshes IT hosts. Verifies the matcher reuses the canonical
// daemonIdsEquivalent (daemon_mach_/mach_ form-agnostic) + meshNodeIdMatches, and guards
// ambiguity (anchor hosts >1 mesh + no node disambiguation → unresolved, never a guess).

const testTmpDir = join(tmpdir(), `adhdev-mesh-anchor-recovery-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import { recoverMeshIdByCoordinatorAndNode } from '../../src/mesh/mesh-event-forwarding.js';

function writeRawMeshConfig(meshes: unknown[]): void {
    if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    writeFileSync(join(testConfigDir, 'meshes.json'), JSON.stringify({ meshes }, null, 2), 'utf-8');
}

function hostedMesh(id: string, hostDaemonId: string, nodeIds: string[]) {
    return {
        id,
        name: id,
        repoIdentity: `repo_${id}`,
        policy: {},
        coordinator: {},
        meshHost: { role: 'host', hostDaemonId },
        nodes: nodeIds.map(nid => ({ id: nid, workspace: `/tmp/${nid}`, userOverrides: {}, policy: {} })),
    };
}

afterEach(() => {
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('recoverMeshIdByCoordinatorAndNode (Fix B)', () => {
    it('recovers meshId by node when the anchor hosts the node (form-agnostic anchor match)', () => {
        writeRawMeshConfig([
            hostedMesh('mesh_1', 'daemon_mach_coord', ['node_wt']),
            hostedMesh('mesh_2', 'daemon_mach_other', ['node_x']),
        ]);
        // Worker stamped the bare-form anchor; host stored the daemon_-prefixed form.
        expect(recoverMeshIdByCoordinatorAndNode('mach_coord', 'node_wt')).toBe('mesh_1');
    });

    it('falls back to the single hosted mesh when nodeId is absent', () => {
        writeRawMeshConfig([hostedMesh('mesh_only', 'daemon_mach_coord', ['node_a'])]);
        expect(recoverMeshIdByCoordinatorAndNode('mach_coord', '')).toBe('mesh_only');
    });

    it('returns unresolved (no guess) when the anchor hosts multiple meshes and no node disambiguates', () => {
        writeRawMeshConfig([
            hostedMesh('mesh_a', 'daemon_mach_coord', ['node_a']),
            hostedMesh('mesh_b', 'daemon_mach_coord', ['node_b']),
        ]);
        expect(recoverMeshIdByCoordinatorAndNode('mach_coord', '')).toBe('');
    });

    it('returns unresolved when a present nodeId matches no hosted mesh (never single-mesh guess)', () => {
        writeRawMeshConfig([hostedMesh('mesh_a', 'daemon_mach_coord', ['node_a'])]);
        expect(recoverMeshIdByCoordinatorAndNode('mach_coord', 'node_not_here')).toBe('');
    });

    it('returns unresolved when the anchor hosts nothing', () => {
        writeRawMeshConfig([hostedMesh('mesh_a', 'daemon_mach_other', ['node_a'])]);
        expect(recoverMeshIdByCoordinatorAndNode('mach_coord', 'node_a')).toBe('');
    });

    it('returns unresolved for an empty coordinator anchor', () => {
        writeRawMeshConfig([hostedMesh('mesh_a', 'daemon_mach_coord', ['node_a'])]);
        expect(recoverMeshIdByCoordinatorAndNode('', 'node_a')).toBe('');
    });
});
