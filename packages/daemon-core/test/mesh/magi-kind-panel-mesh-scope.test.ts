import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Isolate all mesh file I/O to a per-run temp dir (same pattern as the other mesh tests).
const testTmpDir = join(tmpdir(), `adhdev-magi-kind-panel-scope-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import {
    createMesh,
    addNode,
    removeNode,
    getMagiKindPanel,
    listMagiKindPanels,
    listMagiKindPanelsReadOnly,
    setMagiKindPanel,
    removeMagiKindPanel,
    resolveMagiPanelMeshId,
} from '../../src/config/mesh-config.js';
import { meshCrudHandlers } from '../../src/commands/med-family/mesh-crud.js';

/** The med-family handlers under test take a ctx they never read for these three. */
const HANDLER_CTX = {} as any;

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

/** Two meshes, each with one node, created through the real API. */
function seedTwoMeshes(): { meshA: string; meshB: string; nodeA: string; nodeB: string } {
    const a = createMesh({ name: 'mesh-a', repoIdentity: 'github.com/acme/a' });
    const b = createMesh({ name: 'mesh-b', repoIdentity: 'github.com/acme/b' });
    const nodeA = addNode(a.id, { workspace: '/tmp/ws-a' })!;
    const nodeB = addNode(b.id, { workspace: '/tmp/ws-b' })!;
    return { meshA: a.id, meshB: b.id, nodeA: nodeA.id, nodeB: nodeB.id };
}

beforeEach(() => {
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
    mkdirSync(testConfigDir, { recursive: true });
});

afterEach(() => {
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('MAGI kind-panel — per-mesh scope (no cross-mesh overwrite)', () => {
    // ★ THE CORE DEFECT: with a top-level `magiKindPanels` map keyed only by
    // task_kind, a write in mesh B silently clobbers mesh A's binding for the
    // same kind, and the survivor points at the other mesh's node IDs.
    it('a _set in mesh B does NOT overwrite mesh A\'s panel for the same kind', () => {
        const { meshA, meshB, nodeA, nodeB } = seedTwoMeshes();

        setMagiKindPanel('rca', [{ provider: 'claude-cli', nodeId: nodeA }], meshA);
        setMagiKindPanel('rca', [{ provider: 'codex-cli', nodeId: nodeB }], meshB);

        // Mesh A's binding must survive mesh B's write, still pointing at ITS node.
        expect(getMagiKindPanel('rca', meshA)).toEqual([{ provider: 'claude-cli', nodeId: nodeA }]);
        expect(getMagiKindPanel('rca', meshB)).toEqual([{ provider: 'codex-cli', nodeId: nodeB }]);
    });

    it('stores panels inside the mesh entry, not at config root', () => {
        const { meshA, nodeA } = seedTwoMeshes();
        setMagiKindPanel('design', [{ provider: 'claude-cli', nodeId: nodeA }], meshA);

        const raw = readRawMeshConfig();
        expect(raw.magiKindPanels).toBeUndefined();
        const stored = raw.meshes.find((m: any) => m.id === meshA);
        expect(stored.magiKindPanels).toEqual({ design: [{ provider: 'claude-cli', nodeId: nodeA }] });
    });

    it('remove in one mesh leaves the other mesh untouched', () => {
        const { meshA, meshB, nodeA, nodeB } = seedTwoMeshes();
        setMagiKindPanel('rca', [{ provider: 'claude-cli', nodeId: nodeA }], meshA);
        setMagiKindPanel('rca', [{ provider: 'codex-cli', nodeId: nodeB }], meshB);

        expect(removeMagiKindPanel('rca', meshB)).toBe(true);
        expect(getMagiKindPanel('rca', meshB)).toBeUndefined();
        expect(getMagiKindPanel('rca', meshA)).toEqual([{ provider: 'claude-cli', nodeId: nodeA }]);
    });

    it('list is scoped to one mesh', () => {
        const { meshA, meshB, nodeA, nodeB } = seedTwoMeshes();
        setMagiKindPanel('rca', [{ provider: 'claude-cli', nodeId: nodeA }], meshA);
        setMagiKindPanel('design', [{ provider: 'codex-cli', nodeId: nodeB }], meshB);

        expect(Object.keys(listMagiKindPanels(meshA))).toEqual(['rca']);
        expect(Object.keys(listMagiKindPanels(meshB))).toEqual(['design']);
    });
});

describe('MAGI kind-panel — optional meshId resolves to the active mesh', () => {
    it('with exactly one mesh, an omitted meshId binds to that mesh', () => {
        const mesh = createMesh({ name: 'solo', repoIdentity: 'github.com/acme/solo' });
        const node = addNode(mesh.id, { workspace: '/tmp/solo' })!;

        // Legacy call shape — no meshId argument at all.
        setMagiKindPanel('rca', [{ provider: 'claude-cli', nodeId: node.id }]);

        expect(getMagiKindPanel('rca')).toEqual([{ provider: 'claude-cli', nodeId: node.id }]);
        const raw = readRawMeshConfig();
        expect(raw.magiKindPanels).toBeUndefined();
        expect(raw.meshes[0].magiKindPanels.rca).toHaveLength(1);
    });

    it('resolveMagiPanelMeshId returns the sole mesh, and is ambiguous with two', () => {
        const solo = createMesh({ name: 'solo', repoIdentity: 'github.com/acme/solo' });
        expect(resolveMagiPanelMeshId()).toBe(solo.id);

        createMesh({ name: 'second', repoIdentity: 'github.com/acme/second' });
        expect(resolveMagiPanelMeshId()).toBeUndefined();
    });

    it('an omitted meshId with two meshes is an explicit error, never a silent write', () => {
        seedTwoMeshes();
        expect(() => setMagiKindPanel('rca', [{ provider: 'claude-cli' }]))
            .toThrow(/magi_kind_panel_mesh_ambiguous/);
    });
});

describe('MAGI kind-panel — legacy top-level fold', () => {
    it('folds a legacy top-level map into the sole mesh and drops the root key', () => {
        writeRawMeshConfig({
            meshes: [
                {
                    id: 'mesh_solo',
                    name: 'solo',
                    repoIdentity: 'id_solo',
                    policy: {},
                    coordinator: {},
                    nodes: [{ id: 'node_1', workspace: '/tmp/a', userOverrides: {} }],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
            magiKindPanels: { rca: [{ provider: 'claude-cli', nodeId: 'node_1' }] },
        });

        expect(getMagiKindPanel('rca', 'mesh_solo')).toEqual([{ provider: 'claude-cli', nodeId: 'node_1' }]);

        // The fold is persisted eagerly: root key gone, mesh entry owns it.
        const raw = readRawMeshConfig();
        expect(raw.magiKindPanels).toBeUndefined();
        expect(raw.meshes[0].magiKindPanels.rca).toEqual([{ provider: 'claude-cli', nodeId: 'node_1' }]);
    });

    it('drops a legacy top-level map when several meshes exist (owner cannot be inferred)', () => {
        writeRawMeshConfig({
            meshes: [
                { id: 'mesh_a', name: 'a', repoIdentity: 'id_a', policy: {}, coordinator: {}, nodes: [], createdAt: 'x', updatedAt: 'x' },
                { id: 'mesh_b', name: 'b', repoIdentity: 'id_b', policy: {}, coordinator: {}, nodes: [], createdAt: 'x', updatedAt: 'x' },
            ],
            magiKindPanels: { rca: [{ provider: 'claude-cli', nodeId: 'node_1' }] },
        });

        expect(listMagiKindPanels('mesh_a')).toEqual({});
        expect(listMagiKindPanels('mesh_b')).toEqual({});

        const raw = readRawMeshConfig();
        expect(raw.magiKindPanels).toBeUndefined();
        expect(raw.meshes[0].magiKindPanels).toBeUndefined();
        expect(raw.meshes[1].magiKindPanels).toBeUndefined();
    });

    it('a mesh-scoped binding wins over a stray legacy top-level map', () => {
        writeRawMeshConfig({
            meshes: [
                {
                    id: 'mesh_solo',
                    name: 'solo',
                    repoIdentity: 'id_solo',
                    policy: {},
                    coordinator: {},
                    nodes: [{ id: 'node_1', workspace: '/tmp/a', userOverrides: {} }],
                    magiKindPanels: { rca: [{ provider: 'codex-cli', nodeId: 'node_1' }] },
                    createdAt: 'x',
                    updatedAt: 'x',
                },
            ],
            magiKindPanels: { rca: [{ provider: 'claude-cli', nodeId: 'node_1' }] },
        });

        expect(getMagiKindPanel('rca', 'mesh_solo')).toEqual([{ provider: 'codex-cli', nodeId: 'node_1' }]);
        expect(readRawMeshConfig().magiKindPanels).toBeUndefined();
    });

    it('the read-only list never persists the fold', () => {
        writeRawMeshConfig({
            meshes: [
                {
                    id: 'mesh_solo',
                    name: 'solo',
                    repoIdentity: 'id_solo',
                    policy: {},
                    coordinator: {},
                    nodes: [],
                    createdAt: 'x',
                    updatedAt: 'x',
                },
            ],
            magiKindPanels: { rca: [{ provider: 'claude-cli' }] },
        });

        expect(listMagiKindPanelsReadOnly('mesh_solo')).toEqual({ rca: [{ provider: 'claude-cli' }] });
        // Disk untouched by the read-only path.
        expect(readRawMeshConfig().magiKindPanels).toEqual({ rca: [{ provider: 'claude-cli' }] });
    });
});

describe('MAGI kind-panel — nodeId validation against the mesh node list', () => {
    it('rejects a slot pinned to a node that is not in the mesh', () => {
        const { meshA, nodeB } = seedTwoMeshes();
        // nodeB belongs to mesh B — pinning it inside mesh A is exactly the
        // cross-mesh mistake the old global key produced silently.
        expect(() => setMagiKindPanel('rca', [{ provider: 'claude-cli', nodeId: nodeB }], meshA))
            .toThrow(/invalid_magi_kind_panel: slot\[0\]\.nodeId/);
    });

    it('accepts a slot with no nodeId (provider-only, resolved at fan-out)', () => {
        const { meshA } = seedTwoMeshes();
        expect(setMagiKindPanel('rca', [{ provider: 'claude-cli' }], meshA))
            .toEqual([{ provider: 'claude-cli' }]);
    });

    it('accepts a slot pinned to a node that IS in the mesh', () => {
        const { meshA, nodeA } = seedTwoMeshes();
        expect(setMagiKindPanel('rca', [{ provider: 'claude-cli', nodeId: nodeA }], meshA))
            .toEqual([{ provider: 'claude-cli', nodeId: nodeA }]);
    });

    it('removing a node prunes the slots that referenced it', () => {
        const mesh = createMesh({ name: 'solo', repoIdentity: 'github.com/acme/solo' });
        const keep = addNode(mesh.id, { workspace: '/tmp/keep' })!;
        const drop = addNode(mesh.id, { workspace: '/tmp/drop' })!;
        setMagiKindPanel('rca', [
            { provider: 'claude-cli', nodeId: keep.id },
            { provider: 'codex-cli', nodeId: drop.id },
        ], mesh.id);

        expect(removeNode(mesh.id, drop.id)).toBe(true);
        expect(getMagiKindPanel('rca', mesh.id)).toEqual([{ provider: 'claude-cli', nodeId: keep.id }]);
    });

    it('removing the last referenced node drops the now-empty kind binding entirely', () => {
        const mesh = createMesh({ name: 'solo', repoIdentity: 'github.com/acme/solo' });
        const only = addNode(mesh.id, { workspace: '/tmp/only' })!;
        setMagiKindPanel('rca', [{ provider: 'claude-cli', nodeId: only.id }], mesh.id);

        expect(removeNode(mesh.id, only.id)).toBe(true);
        // An empty slot list is not a legal binding — the kind is removed, so
        // mesh_magi_review reports magi_kind_not_configured rather than a
        // silently-degraded panel.
        expect(getMagiKindPanel('rca', mesh.id)).toBeUndefined();
    });
});

describe('magi_kind_panel_* handlers — meshId threading and scope reporting', () => {
    it('set/list/remove are scoped by the meshId argument', async () => {
        const { meshA, meshB, nodeA, nodeB } = seedTwoMeshes();

        await meshCrudHandlers.magi_kind_panel_set(HANDLER_CTX, {
            kind: 'rca', meshId: meshA, slots: [{ provider: 'claude-cli', nodeId: nodeA }],
        });
        await meshCrudHandlers.magi_kind_panel_set(HANDLER_CTX, {
            kind: 'rca', meshId: meshB, slots: [{ provider: 'codex-cli', nodeId: nodeB }],
        });

        const listA: any = await meshCrudHandlers.magi_kind_panel_list(HANDLER_CTX, { meshId: meshA });
        const listB: any = await meshCrudHandlers.magi_kind_panel_list(HANDLER_CTX, { meshId: meshB });
        expect(listA.kindPanels.rca).toEqual([{ provider: 'claude-cli', nodeId: nodeA }]);
        expect(listB.kindPanels.rca).toEqual([{ provider: 'codex-cli', nodeId: nodeB }]);

        const removed: any = await meshCrudHandlers.magi_kind_panel_remove(HANDLER_CTX, { kind: 'rca', meshId: meshB });
        expect(removed).toMatchObject({ success: true, removed: true, meshId: meshB });
        const afterA: any = await meshCrudHandlers.magi_kind_panel_list(HANDLER_CTX, { meshId: meshA });
        expect(afterA.kindPanels.rca).toEqual([{ provider: 'claude-cli', nodeId: nodeA }]);
    });

    // ★ The old response said scope: 'machine_local' — a flat string that read as one
    // global binding per kind. It must now name the mesh the panels came from.
    it('_list reports which mesh the panels were resolved from', async () => {
        const { meshA } = seedTwoMeshes();
        const explicit: any = await meshCrudHandlers.magi_kind_panel_list(HANDLER_CTX, { meshId: meshA });
        expect(explicit.scope).toMatchObject({
            kind: 'mesh', storage: 'machine_local', meshId: meshA, resolvedFrom: 'explicit',
        });
    });

    it('_list flags ambiguity instead of silently returning another mesh\'s panels', async () => {
        seedTwoMeshes();
        const bare: any = await meshCrudHandlers.magi_kind_panel_list(HANDLER_CTX, {});
        expect(bare.success).toBe(true);
        expect(bare.kindPanels).toEqual({});
        expect(bare.scope).toMatchObject({ meshId: null, resolvedFrom: 'ambiguous' });
        expect(bare.scope.note).toMatch(/Pass meshId/);
    });

    it('_list resolves the sole mesh when meshId is omitted', async () => {
        const mesh = createMesh({ name: 'solo', repoIdentity: 'github.com/acme/solo' });
        const node = addNode(mesh.id, { workspace: '/tmp/solo' })!;
        await meshCrudHandlers.magi_kind_panel_set(HANDLER_CTX, {
            kind: 'design', slots: [{ provider: 'claude-cli', nodeId: node.id }],
        });

        const bare: any = await meshCrudHandlers.magi_kind_panel_list(HANDLER_CTX, {});
        expect(bare.scope).toMatchObject({ meshId: mesh.id, resolvedFrom: 'sole_mesh' });
        expect(bare.kindPanels.design).toEqual([{ provider: 'claude-cli', nodeId: node.id }]);
    });

    it('_set surfaces an unknown nodeId as a structured error, not a silent write', async () => {
        const { meshA, nodeB } = seedTwoMeshes();
        const res: any = await meshCrudHandlers.magi_kind_panel_set(HANDLER_CTX, {
            kind: 'rca', meshId: meshA, slots: [{ provider: 'claude-cli', nodeId: nodeB }],
        });
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/invalid_magi_kind_panel: slot\[0\]\.nodeId/);
        expect(listMagiKindPanels(meshA)).toEqual({});
    });

    it('_set refuses an unscoped write when several meshes exist', async () => {
        seedTwoMeshes();
        const res: any = await meshCrudHandlers.magi_kind_panel_set(HANDLER_CTX, {
            kind: 'rca', slots: [{ provider: 'claude-cli' }],
        });
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/magi_kind_panel_mesh_ambiguous/);
    });
});
