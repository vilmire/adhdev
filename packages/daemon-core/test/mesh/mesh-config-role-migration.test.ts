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

import { listMeshes, getMesh, createMesh, addNode, migrateProviderRolesToSlots } from '../../src/config/mesh-config.js';

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

describe('mesh-config — legacy providerRoles → slots migration on load', () => {
    it('migrates providerRoles maxParallel onto derived slots and deletes the field', () => {
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
                                providerPriority: ['claude-cli', 'codex-cli'],
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
        // The removed field is gone…
        expect((node.policy as any).providerRoles).toBeUndefined();
        // …and its cap now lives on a slot for that provider (derived from providerPriority).
        const slots = (node.policy as any).slots as Array<{ provider: string; maxParallel?: number }>;
        const claude = slots.find(s => s.provider === 'claude-cli');
        const codex = slots.find(s => s.provider === 'codex-cli');
        expect(claude?.maxParallel).toBe(2);
        // codex had no maxParallel → its slot stays uncapped.
        expect(codex?.maxParallel).toBeUndefined();
    });

    it('folds the cap into an existing explicit slot lacking a cap', () => {
        writeRawMeshConfig({
            meshes: [
                {
                    id: 'mesh_e',
                    name: 'm',
                    repoIdentity: 'id_e',
                    policy: {},
                    coordinator: {},
                    nodes: [
                        {
                            id: 'node_e',
                            workspace: '/tmp/e',
                            userOverrides: {},
                            policy: {
                                slots: [{ provider: 'claude-cli', model: 'opus' }],
                                providerRoles: [{ providerType: 'claude-cli', maxParallel: 4 }],
                            },
                        },
                    ],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        const node = getMesh('mesh_e')!.nodes[0];
        expect((node.policy as any).providerRoles).toBeUndefined();
        const slots = (node.policy as any).slots;
        expect(slots).toHaveLength(1);
        expect(slots[0]).toMatchObject({ provider: 'claude-cli', model: 'opus', maxParallel: 4 });
    });

    it('does not overwrite an explicit slot that already declares its own cap', () => {
        writeRawMeshConfig({
            meshes: [
                {
                    id: 'mesh_f',
                    name: 'm',
                    repoIdentity: 'id_f',
                    policy: {},
                    coordinator: {},
                    nodes: [
                        {
                            id: 'node_f',
                            workspace: '/tmp/f',
                            userOverrides: {},
                            policy: {
                                slots: [{ provider: 'claude-cli', maxParallel: 1 }],
                                providerRoles: [{ providerType: 'claude-cli', maxParallel: 9 }],
                            },
                        },
                    ],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        const node = getMesh('mesh_f')!.nodes[0];
        expect((node.policy as any).providerRoles).toBeUndefined();
        // Explicit slot cap wins — the legacy cap is dropped, not merged over it.
        expect((node.policy as any).slots[0].maxParallel).toBe(1);
    });

    it('persists the migration to disk on the first (pure-read) load', () => {
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
                                providerPriority: ['claude-cli'],
                                providerRoles: [{ providerType: 'claude-cli', maxParallel: 5 }],
                            },
                        },
                    ],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        // listMeshes is a pure-read accessor; the on-load migration must still
        // rewrite the file so the removed field is gone from disk too.
        listMeshes();

        const onDisk = readRawMeshConfig();
        const policy = onDisk.meshes[0].nodes[0].policy;
        expect(policy.providerRoles).toBeUndefined();
        expect(policy.slots.find((s: any) => s.provider === 'claude-cli').maxParallel).toBe(5);
    });

    it('leaves a policy with no providerRoles untouched (no needless rewrite)', () => {
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
                                slots: [{ provider: 'claude-cli', maxParallel: 3 }],
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
        expect((node.policy as any).slots[0]).toEqual({ provider: 'claude-cli', maxParallel: 3 });
        // No legacy providerRoles present → no eager rewrite (file unchanged).
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
                        { id: 'n3', workspace: '/tmp/d3', userOverrides: {}, policy: { providerPriority: ['claude-cli'], providerRoles: [null, 'x', { providerType: 'claude-cli', maxParallel: 2, role: 'r' }] } as any },
                    ],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        const mesh = getMesh('mesh_d')!;
        expect(mesh.nodes).toHaveLength(3);
        // n2's non-array providerRoles is not a valid legacy shape → left untouched.
        expect((mesh.nodes[1].policy as any).providerRoles).toBe('nope');
        // n3: malformed entries skipped, the one valid cap migrates onto a slot.
        const n3 = mesh.nodes[2].policy as any;
        expect(n3.providerRoles).toBeUndefined();
        expect(n3.slots.find((s: any) => s.provider === 'claude-cli').maxParallel).toBe(2);
    });
});

describe('node creation never seeds providerRoles', () => {
    it('addNode with a plain policy produces no providerRoles field', () => {
        const mesh = createMesh({ name: 'n1', repoIdentity: 'r1' });
        const node = addNode(mesh.id, {
            workspace: '/tmp/new1',
            policy: { providerPriority: ['claude-cli'] },
        } as any)!;
        expect((node.policy as any).providerRoles).toBeUndefined();
    });

    it('an incoming legacy providerRoles arg folds into slots (via migrateProviderRolesToSlots)', () => {
        // Mirrors what the mesh_add_node handler does before calling addNode.
        const policy: Record<string, unknown> = {
            providerPriority: ['claude-cli'],
            providerRoles: [{ providerType: 'claude-cli', maxParallel: 7 }],
        };
        migrateProviderRolesToSlots(policy);
        const mesh = createMesh({ name: 'n2', repoIdentity: 'r2' });
        const node = addNode(mesh.id, { workspace: '/tmp/new2', policy } as any)!;
        expect((node.policy as any).providerRoles).toBeUndefined();
        const slot = (node.policy as any).slots.find((s: any) => s.provider === 'claude-cli');
        expect(slot.maxParallel).toBe(7);
    });
});
