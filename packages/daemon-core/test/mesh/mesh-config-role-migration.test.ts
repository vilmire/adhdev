import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Isolate all mesh file I/O to a per-run temp dir (same pattern as the other mesh tests).
const testTmpDir = join(tmpdir(), `adhdev-mesh-role-migration-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import { listMeshes, getMesh } from '../../src/config/mesh-config.js';

function configPath(): string {
    return join(testConfigDir, 'meshes.json');
}

function writeRawMeshConfig(config: unknown): void {
    if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8');
}

function readRawMeshConfig(): any {
    return JSON.parse(readFileSync(configPath(), 'utf-8'));
}

afterEach(() => {
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('mesh-config — dead providerRoles.role migration (Part A)', () => {
    it('strips the legacy role field from providerRoles on load, keeping maxParallel', () => {
        writeRawMeshConfig({
            meshes: [
                {
                    id: 'mesh_a',
                    name: 'm',
                    repoIdentity: 'id_a',
                    policy: {},
                    coordinator: {},
                    nodes: [
                        {
                            id: 'node_a',
                            workspace: '/tmp/a',
                            userOverrides: {},
                            policy: {
                                providerPriority: ['claude-cli'],
                                providerRoles: [
                                    { providerType: 'claude-cli', maxParallel: 2, role: 'validator' },
                                    { providerType: 'codex-cli', role: 'worker' },
                                ],
                            },
                        },
                    ],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        const node = getMesh('mesh_a')!.nodes[0];
        const roles = (node.policy as any).providerRoles;
        expect(roles).toHaveLength(2);
        // role must be gone…
        expect(Object.prototype.hasOwnProperty.call(roles[0], 'role')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(roles[1], 'role')).toBe(false);
        // …while providerType + maxParallel survive.
        expect(roles[0]).toEqual({ providerType: 'claude-cli', maxParallel: 2 });
        expect(roles[1]).toEqual({ providerType: 'codex-cli' });
    });

    it('persists the stripped config to disk on the first load (pure-read path converges)', () => {
        writeRawMeshConfig({
            meshes: [
                {
                    id: 'mesh_b',
                    name: 'm',
                    repoIdentity: 'id_b',
                    policy: {},
                    coordinator: {},
                    nodes: [
                        {
                            id: 'node_b',
                            workspace: '/tmp/b',
                            userOverrides: {},
                            policy: {
                                providerRoles: [{ providerType: 'claude-cli', role: 'validator' }],
                            },
                        },
                    ],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        // listMeshes is a pure-read accessor; the on-load migration must still
        // rewrite the file so the dead field is gone from disk too.
        listMeshes();

        const onDisk = readRawMeshConfig();
        const role = onDisk.meshes[0].nodes[0].policy.providerRoles[0];
        expect(Object.prototype.hasOwnProperty.call(role, 'role')).toBe(false);
        expect(role).toEqual({ providerType: 'claude-cli' });
    });

    it('leaves a clean providerRoles array untouched (no role fields, no needless rewrite)', () => {
        writeRawMeshConfig({
            meshes: [
                {
                    id: 'mesh_c',
                    name: 'm',
                    repoIdentity: 'id_c',
                    policy: {},
                    coordinator: {},
                    nodes: [
                        {
                            id: 'node_c',
                            workspace: '/tmp/c',
                            userOverrides: {},
                            policy: {
                                providerRoles: [{ providerType: 'claude-cli', maxParallel: 3 }],
                            },
                        },
                    ],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        const before = readFileSync(configPath(), 'utf-8');
        const node = getMesh('mesh_c')!.nodes[0];
        expect((node.policy as any).providerRoles[0]).toEqual({ providerType: 'claude-cli', maxParallel: 3 });
        // No `role` field present → no eager rewrite (file unchanged).
        expect(readFileSync(configPath(), 'utf-8')).toBe(before);
    });

    it('is defensive against missing/malformed policy and providerRoles', () => {
        writeRawMeshConfig({
            meshes: [
                {
                    id: 'mesh_d',
                    name: 'm',
                    repoIdentity: 'id_d',
                    policy: {},
                    coordinator: {},
                    nodes: [
                        { id: 'n1', workspace: '/tmp/d1', userOverrides: {}, policy: {} },
                        { id: 'n2', workspace: '/tmp/d2', userOverrides: {}, policy: { providerRoles: 'nope' } as any },
                        { id: 'n3', workspace: '/tmp/d3', userOverrides: {}, policy: { providerRoles: [null, 'x', { providerType: 'claude-cli', role: 'r' }] } as any },
                    ],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        const mesh = getMesh('mesh_d')!;
        expect(mesh.nodes).toHaveLength(3);
        const n3Roles = (mesh.nodes[2].policy as any).providerRoles;
        // Malformed entries are left as-is; the one valid object loses its role.
        expect(Object.prototype.hasOwnProperty.call(n3Roles[2], 'role')).toBe(false);
        expect(n3Roles[2]).toEqual({ providerType: 'claude-cli' });
    });
});
