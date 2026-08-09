import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Isolate all mesh file I/O to a per-run temp dir (same pattern as the other mesh tests).
const testTmpDir = join(tmpdir(), `adhdev-difficulty-brains-scope-${randomUUID().slice(0, 8)}`);
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
    getMesh,
    getDifficultyBrains,
    setDifficultyBrains,
} from '../../src/config/mesh-config.js';
import { resolveNodeCapabilitySlots } from '../../src/mesh/mesh-node-slots.js';
import { meshCrudHandlers } from '../../src/commands/med-family/mesh-crud.js';
import { enqueueTask, getQueue, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { __decideSlotForModelForTests } from '../../src/mesh/mesh-queue-assignment.js';
import { DEFAULT_DIFFICULTY_BRAINS } from '@adhdev/mesh-shared';

/** The med-family handlers under test take a ctx they never read for these two. */
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

function seedTwoMeshes(): { meshA: string; meshB: string } {
    const a = createMesh({ name: 'mesh-a', repoIdentity: 'github.com/acme/a' });
    const b = createMesh({ name: 'mesh-b', repoIdentity: 'github.com/acme/b' });
    return { meshA: a.id, meshB: b.id };
}

beforeEach(() => {
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
    mkdirSync(testConfigDir, { recursive: true });
});

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('difficultyBrains — per-mesh scope (no cross-mesh overwrite)', () => {
    // ★ THE CORE DEFECT, identical in shape to the MAGI kind-panel one: a top-level
    // map keyed by difficulty alone means a write in mesh B silently clobbers mesh
    // A's presets. This is the setting that decides which MODEL a task runs on, so
    // the clobber is a direct cost/behaviour issue.
    it('a set in mesh B does NOT overwrite mesh A\'s presets', () => {
        const { meshA, meshB } = seedTwoMeshes();

        setDifficultyBrains({ difficult: { model: 'sonnet', thinkingLevel: 'high' } }, meshA);
        setDifficultyBrains({ difficult: { model: 'opus', thinkingLevel: 'high' } }, meshB);

        expect(getDifficultyBrains(meshA).difficult).toEqual({ model: 'sonnet', thinkingLevel: 'high' });
        expect(getDifficultyBrains(meshB).difficult).toEqual({ model: 'opus', thinkingLevel: 'high' });
    });

    it('stores presets inside the mesh entry, not at config root', () => {
        const { meshA } = seedTwoMeshes();
        setDifficultyBrains({ easy: { model: 'haiku' } }, meshA);

        const raw = readRawMeshConfig();
        expect(raw.difficultyBrains).toBeUndefined();
        const stored = raw.meshes.find((m: any) => m.id === meshA);
        expect(stored.difficultyBrains).toEqual({ easy: { model: 'haiku' } });
    });

    it('clearing one mesh\'s override leaves the other mesh\'s intact', () => {
        const { meshA, meshB } = seedTwoMeshes();
        setDifficultyBrains({ difficult: { model: 'sonnet' } }, meshA);
        setDifficultyBrains({ difficult: { model: 'sonnet' } }, meshB);

        // An empty map clears the override → that mesh falls back to defaults.
        setDifficultyBrains({}, meshB);

        expect(getDifficultyBrains(meshA).difficult).toEqual({ model: 'sonnet' });
        expect(getDifficultyBrains(meshB)).toEqual(DEFAULT_DIFFICULTY_BRAINS);
    });

    it('an unset mesh still falls back to the shipped defaults', () => {
        const { meshA } = seedTwoMeshes();
        expect(getDifficultyBrains(meshA)).toEqual(DEFAULT_DIFFICULTY_BRAINS);
    });
});

describe('difficultyBrains — optional meshId resolves to the active mesh', () => {
    it('with exactly one mesh, an omitted meshId targets that mesh', () => {
        const mesh = createMesh({ name: 'solo', repoIdentity: 'github.com/acme/solo' });

        // Legacy call shape — no meshId argument at all.
        setDifficultyBrains({ difficult: { model: 'sonnet' } });

        expect(getDifficultyBrains().difficult).toEqual({ model: 'sonnet' });
        expect(getDifficultyBrains(mesh.id).difficult).toEqual({ model: 'sonnet' });
        const raw = readRawMeshConfig();
        expect(raw.difficultyBrains).toBeUndefined();
        expect(raw.meshes[0].difficultyBrains).toEqual({ difficult: { model: 'sonnet' } });
    });

    it('an omitted meshId with two meshes is an explicit error, never a silent write', () => {
        seedTwoMeshes();
        expect(() => setDifficultyBrains({ difficult: { model: 'opus' } }))
            .toThrow(/difficulty_brains_mesh_ambiguous/);
    });

    it('an ambiguous read returns the defaults rather than another mesh\'s presets', () => {
        const { meshA } = seedTwoMeshes();
        setDifficultyBrains({ difficult: { model: 'sonnet' } }, meshA);
        // No meshId + several meshes → must NOT leak mesh A's override.
        expect(getDifficultyBrains()).toEqual(DEFAULT_DIFFICULTY_BRAINS);
    });
});

describe('difficultyBrains — legacy top-level fold', () => {
    it('folds a legacy top-level map into the sole mesh and drops the root key', () => {
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
            difficultyBrains: { difficult: { model: 'sonnet', thinkingLevel: 'high' } },
        });

        expect(getDifficultyBrains('mesh_solo').difficult).toEqual({ model: 'sonnet', thinkingLevel: 'high' });

        const raw = readRawMeshConfig();
        expect(raw.difficultyBrains).toBeUndefined();
        expect(raw.meshes[0].difficultyBrains).toEqual({ difficult: { model: 'sonnet', thinkingLevel: 'high' } });
    });

    it('drops a legacy top-level map when several meshes exist (owner cannot be inferred)', () => {
        writeRawMeshConfig({
            meshes: [
                { id: 'mesh_a', name: 'a', repoIdentity: 'id_a', policy: {}, coordinator: {}, nodes: [], createdAt: 'x', updatedAt: 'x' },
                { id: 'mesh_b', name: 'b', repoIdentity: 'id_b', policy: {}, coordinator: {}, nodes: [], createdAt: 'x', updatedAt: 'x' },
            ],
            difficultyBrains: { difficult: { model: 'opus' } },
        });

        // Both meshes fall back to defaults — neither inherits the ambiguous map.
        expect(getDifficultyBrains('mesh_a')).toEqual(DEFAULT_DIFFICULTY_BRAINS);
        expect(getDifficultyBrains('mesh_b')).toEqual(DEFAULT_DIFFICULTY_BRAINS);

        const raw = readRawMeshConfig();
        expect(raw.difficultyBrains).toBeUndefined();
        expect(raw.meshes[0].difficultyBrains).toBeUndefined();
        expect(raw.meshes[1].difficultyBrains).toBeUndefined();
    });

    it('a mesh-scoped override wins over a stray legacy top-level map', () => {
        writeRawMeshConfig({
            meshes: [
                {
                    id: 'mesh_solo',
                    name: 'solo',
                    repoIdentity: 'id_solo',
                    policy: {},
                    coordinator: {},
                    nodes: [],
                    difficultyBrains: { difficult: { model: 'sonnet' } },
                    createdAt: 'x',
                    updatedAt: 'x',
                },
            ],
            difficultyBrains: { difficult: { model: 'opus' } },
        });

        expect(getDifficultyBrains('mesh_solo').difficult).toEqual({ model: 'sonnet' });
        expect(readRawMeshConfig().difficultyBrains).toBeUndefined();
    });
});

describe('difficulty_brains_* handlers — meshId threading and scope reporting', () => {
    it('get/set are scoped by the meshId argument', async () => {
        const { meshA, meshB } = seedTwoMeshes();

        await meshCrudHandlers.difficulty_brains_set(HANDLER_CTX, {
            meshId: meshA, difficultyBrains: { difficult: { model: 'sonnet' } },
        });
        await meshCrudHandlers.difficulty_brains_set(HANDLER_CTX, {
            meshId: meshB, difficultyBrains: { difficult: { model: 'opus' } },
        });

        const gotA: any = await meshCrudHandlers.difficulty_brains_get(HANDLER_CTX, { meshId: meshA });
        const gotB: any = await meshCrudHandlers.difficulty_brains_get(HANDLER_CTX, { meshId: meshB });
        expect(gotA.difficultyBrains.difficult).toEqual({ model: 'sonnet' });
        expect(gotB.difficultyBrains.difficult).toEqual({ model: 'opus' });
    });

    it('_get reports which mesh the presets were resolved from', async () => {
        const { meshA } = seedTwoMeshes();
        const res: any = await meshCrudHandlers.difficulty_brains_get(HANDLER_CTX, { meshId: meshA });
        expect(res.scope).toMatchObject({
            kind: 'mesh', storage: 'machine_local', meshId: meshA, resolvedFrom: 'explicit',
        });
    });

    it('_get flags ambiguity instead of silently returning another mesh\'s presets', async () => {
        seedTwoMeshes();
        const res: any = await meshCrudHandlers.difficulty_brains_get(HANDLER_CTX, {});
        expect(res.success).toBe(true);
        expect(res.scope).toMatchObject({ meshId: null, resolvedFrom: 'ambiguous' });
        expect(res.difficultyBrains).toEqual(DEFAULT_DIFFICULTY_BRAINS);
    });

    it('_set refuses an unscoped write when several meshes exist', async () => {
        seedTwoMeshes();
        const res: any = await meshCrudHandlers.difficulty_brains_set(HANDLER_CTX, {
            difficultyBrains: { difficult: { model: 'opus' } },
        });
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/difficulty_brains_mesh_ambiguous/);
    });

    it('_get resolves the sole mesh when meshId is omitted', async () => {
        const mesh = createMesh({ name: 'solo', repoIdentity: 'github.com/acme/solo' });
        await meshCrudHandlers.difficulty_brains_set(HANDLER_CTX, {
            difficultyBrains: { easy: { model: 'haiku' } },
        });
        const res: any = await meshCrudHandlers.difficulty_brains_get(HANDLER_CTX, {});
        expect(res.scope).toMatchObject({ meshId: mesh.id, resolvedFrom: 'sole_mesh' });
        expect(res.difficultyBrains.easy).toEqual({ model: 'haiku' });
    });
});

describe('difficultyBrains × slot-model guard — the cost defect end to end', () => {
    // ★ The interaction that produced this session's actual cost issue: nobody set
    // difficult→opus, but the shipped default applied to EVERY mesh, and opus got
    // stamped onto tasks. Per-mesh scoping is what lets one mesh say "difficult =
    // sonnet" without touching another, and the merged slot guard is what stops an
    // undeclared model reaching launch. These two must compose.
    it('a mesh can pin difficult→sonnet while another pins opus', () => {
        const { meshA, meshB } = seedTwoMeshes();
        addNode(meshA, { workspace: '/tmp/a' });
        addNode(meshB, { workspace: '/tmp/b' });

        // Each mesh pins its own model. (Nothing is shipped by default any more —
        // DEFAULT_DIFFICULTY_BRAINS is {} — so mesh B states its choice explicitly.)
        setDifficultyBrains({ difficult: { model: 'sonnet', thinkingLevel: 'high' } }, meshA);
        setDifficultyBrains({ difficult: { model: 'opus', thinkingLevel: 'high' } }, meshB);

        expect(getDifficultyBrains(meshA).difficult?.model).toBe('sonnet');
        // Mesh B keeps its own — unchanged by mesh A's write.
        expect(getDifficultyBrains(meshB).difficult?.model).toBe('opus');
    });

    it('an UNCONFIGURED mesh gets no preset at all (nothing is shipped)', () => {
        const { meshA } = seedTwoMeshes();
        addNode(meshA, { workspace: '/tmp/a' });
        expect(getDifficultyBrains(meshA).difficult).toBeUndefined();
    });

    it('legacy-derived node slots use the OWNING mesh\'s presets, not another mesh\'s', () => {
        const { meshA, meshB } = seedTwoMeshes();
        // A node with no explicit slots derives them from providerPriority + the
        // difficulty presets. Those presets must come from the node's OWN mesh —
        // otherwise the derived slot declares a model the other mesh chose, and the
        // slot guard then enforces a model this mesh never selected.
        addNode(meshA, { workspace: '/tmp/a', policy: { providerPriority: ['claude-cli'] } });
        addNode(meshB, { workspace: '/tmp/b', policy: { providerPriority: ['claude-cli'] } });

        setDifficultyBrains({ difficult: { model: 'sonnet' } }, meshA);
        setDifficultyBrains({ difficult: { model: 'opus' } }, meshB);

        const nodeA = getMesh(meshA)!.nodes[0];
        const nodeB = getMesh(meshB)!.nodes[0];

        const modelsA = resolveNodeCapabilitySlots(nodeA, meshA).map(s => s.model).filter(Boolean);
        const modelsB = resolveNodeCapabilitySlots(nodeB, meshB).map(s => s.model).filter(Boolean);

        expect(modelsA).toContain('sonnet');
        expect(modelsA).not.toContain('opus');
        expect(modelsB).toContain('opus');
    });

    // ★ The two changes composing: per-mesh presets decide WHICH model gets stamped
    // at enqueue, the merged slot guard decides whether that model may LAUNCH. A mesh
    // that pins difficult→sonnet now enqueues sonnet, which the sonnet-only node
    // declares, so the guard says 'run' — where the global opus default previously
    // produced an undeclared model and a blocked/notified task.
    it('a mesh pinned to sonnet enqueues sonnet and the sonnet-only node runs it', () => {
        const meshId = createMesh({ name: 'm', repoIdentity: `id_${randomUUID().slice(0, 8)}` }).id;
        setDifficultyBrains({ difficult: { model: 'sonnet', thinkingLevel: 'high' } }, meshId);

        enqueueTask(meshId, 'redesign the scheduler', { difficulty: 'difficult' });
        const task = getQueue(meshId)[0];
        expect(task.model).toBe('sonnet');

        const node = { id: 'node_sonnet_only', policy: { slots: [{ provider: 'claude-cli', model: 'sonnet' }] } };
        const decision = __decideSlotForModelForTests(meshId, node.id, node, {
            model: task.model, difficulty: 'difficult',
        });
        expect(decision.outcome).toBe('run');
    });

    // The un-pinned mesh still inherits the shipped default, and on the SAME node the
    // guard correctly refuses it. This is the pre-existing guard behaviour — asserted
    // here so the per-mesh change is shown not to weaken it.
    it('a mesh pinned to an undeclared model stamps it and the guard still blocks it', () => {
        const meshId = createMesh({ name: 'm2', repoIdentity: `id_${randomUUID().slice(0, 8)}` }).id;
        // Explicit now: opus is no longer stamped by default, so pin it to keep
        // exercising the guard's block on a model the node's slots never declare.
        setDifficultyBrains({ difficult: { model: 'opus' } }, meshId);

        enqueueTask(meshId, 'redesign the scheduler', { difficulty: 'difficult' });
        const task = getQueue(meshId)[0];
        expect(task.model).toBe('opus');

        const node = { id: 'node_sonnet_only', policy: { slots: [{ provider: 'claude-cli', model: 'sonnet' }] } };
        const decision = __decideSlotForModelForTests(meshId, node.id, node, {
            model: task.model, difficulty: 'difficult',
        });
        expect(decision.outcome).toBe('notify');
    });

    // Two meshes, same machine, same node shape: the pinned one runs, the default one
    // is blocked. Before per-mesh scoping this pair was impossible to express — one
    // mesh's preset was every mesh's preset.
    it('two meshes on one machine reach OPPOSITE guard outcomes for the same difficulty', () => {
        const pinned = createMesh({ name: 'pinned', repoIdentity: `id_${randomUUID().slice(0, 8)}` }).id;
        const defaulted = createMesh({ name: 'defaulted', repoIdentity: `id_${randomUUID().slice(0, 8)}` }).id;
        setDifficultyBrains({ difficult: { model: 'sonnet' } }, pinned);
        setDifficultyBrains({ difficult: { model: 'opus' } }, defaulted);

        enqueueTask(pinned, 'hard work', { difficulty: 'difficult' });
        enqueueTask(defaulted, 'hard work', { difficulty: 'difficult' });
        expect(getQueue(pinned)[0].model).toBe('sonnet');
        expect(getQueue(defaulted)[0].model).toBe('opus');

        const node = { id: 'node_sonnet_only', policy: { slots: [{ provider: 'claude-cli', model: 'sonnet' }] } };
        expect(__decideSlotForModelForTests(pinned, node.id, node,
            { model: getQueue(pinned)[0].model, difficulty: 'difficult' }).outcome).toBe('run');
        expect(__decideSlotForModelForTests(defaulted, node.id, node,
            { model: getQueue(defaulted)[0].model, difficulty: 'difficult' }).outcome).toBe('notify');
    });
});
