/**
 * MODEL-SOURCE precedence (defect 0fcec9f1): a preset-stamped task.model must
 * NOT override the difficulty-matched slot's own model.
 *
 * The defect: the difficulty→brain preset fills task.model at enqueue
 * (mesh-work-queue.ts), and the assignment path's unconditional
 * "task.model wins" then discarded the slot ranking — with the fail-closed
 * slot guard this BLOCKED e.g. a difficulty:'easy' task (preset 'haiku') on
 * every node whose easy slot declares a different model.
 *
 * The fix: enqueue stamps modelSource ('explicit' | 'preset'), and the
 * assignment path lets a difficulty-covering slot's model win over a
 * preset-stamped one, while an explicit model is never overridden.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-model-source-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import { enqueueTask, getQueue, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { createMesh, setDifficultyBrains } from '../../src/config/mesh-config.js';
import { __decideSlotForModelForTests } from '../../src/mesh/mesh-queue-assignment.js';

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

/**
 * A mesh with difficulty presets CONFIGURED EXPLICITLY.
 *
 * These presets are no longer shipped by default (DEFAULT_DIFFICULTY_BRAINS is {} —
 * `difficulty` is a routing hint and the slot owns the model). But the modelSource
 * precedence machinery this file covers still governs any mesh whose operator DID
 * configure presets, so the tests seed the former defaults explicitly to keep
 * exercising exactly that path.
 */
function freshMesh(): string {
    const meshId = createMesh({ name: 'm', repoIdentity: `id_${randomUUID().slice(0, 8)}` }).id;
    setDifficultyBrains({
        easy: { model: 'haiku', thinkingLevel: 'low' },
        medium: { model: 'sonnet', thinkingLevel: 'medium' },
        difficult: { model: 'opus', thinkingLevel: 'high' },
    }, meshId);
    return meshId;
}

/** M1-Server-like node: easy/medium on sonnet, difficult on opus. No haiku anywhere. */
const SPLIT_NODE = {
    id: 'node_split',
    policy: {
        slots: [
            { provider: 'claude-cli', model: 'sonnet', difficulty: ['easy', 'medium'] },
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'] },
        ],
    },
};

/** Node whose only slot declares sonnet for easy/medium (no haiku). */
const SONNET_EASY_NODE = {
    id: 'node_sonnet_easy',
    policy: { slots: [{ provider: 'claude-cli', model: 'sonnet', difficulty: ['easy', 'medium'] }] },
};

/** Node with a general-purpose slot (no difficulty list) declaring sonnet. */
const GENERAL_PURPOSE_NODE = {
    id: 'node_gp',
    policy: { slots: [{ provider: 'claude-cli', model: 'sonnet' }] },
};

describe('enqueue stamps the model/thinkingLevel source marker', () => {
    it('preset-filled values are marked preset', () => {
        const meshId = freshMesh();
        enqueueTask(meshId, 'rename a variable', { difficulty: 'easy' });
        const [task] = getQueue(meshId);
        expect(task.model).toBe('haiku'); // DEFAULT_DIFFICULTY_BRAINS.easy
        expect(task.modelSource).toBe('preset');
        expect(task.thinkingLevel).toBe('low');
        expect(task.thinkingLevelSource).toBe('preset');
    });

    it('caller-passed values are marked explicit, and win over the preset', () => {
        const meshId = freshMesh();
        enqueueTask(meshId, 'edit', { difficulty: 'easy', model: 'sonnet', thinkingLevel: 'high' });
        const [task] = getQueue(meshId);
        expect(task.model).toBe('sonnet');
        expect(task.modelSource).toBe('explicit');
        expect(task.thinkingLevel).toBe('high');
        expect(task.thinkingLevelSource).toBe('explicit');
    });

    // DIFFICULTY-REQUIRED: difficulty is now mandatory at enqueue, so "no model" is
    // expressed with 'freeform' — the one difficulty freshMesh() leaves unconfigured,
    // hence the only one that resolves no preset model/thinkingLevel to mark.
    it('a task with no model carries no marker', () => {
        const meshId = freshMesh();
        enqueueTask(meshId, 'plain task', { difficulty: 'freeform' });
        const [task] = getQueue(meshId);
        expect(task.model).toBeUndefined();
        expect(task.modelSource).toBeUndefined();
        expect(task.thinkingLevelSource).toBeUndefined();
    });
});

describe('assignment precedence: preset yields to the difficulty-covering slot', () => {
    it('★ preset model + slot covering the difficulty → the SLOT model runs', () => {
        const meshId = freshMesh();
        // Live repro: difficulty 'easy' presets 'haiku', which this node never declares.
        enqueueTask(meshId, 'rename a variable', { difficulty: 'easy' });
        const [task] = getQueue(meshId);

        const d = __decideSlotForModelForTests(meshId, 'node_split', SPLIT_NODE, task);
        expect(d.outcome).toBe('run');
        if (d.outcome === 'run') expect(d.model).toBe('sonnet'); // slot's own model, not 'haiku'
    });

    it('a general-purpose slot (no difficulty list) also covers → slot model runs', () => {
        const meshId = freshMesh();
        enqueueTask(meshId, 'rename a variable', { difficulty: 'easy' });
        const [task] = getQueue(meshId);

        const d = __decideSlotForModelForTests(meshId, 'node_gp', GENERAL_PURPOSE_NODE, task);
        expect(d.outcome).toBe('run');
        if (d.outcome === 'run') expect(d.model).toBe('sonnet');
    });

    it('★ explicit model → the slot never overrides it (guard still applies)', () => {
        const meshId = freshMesh();
        enqueueTask(meshId, 'hard edit', { difficulty: 'easy', model: 'opus' });
        const [task] = getQueue(meshId);
        expect(task.modelSource).toBe('explicit');

        // The easy slot covers the difficulty but declares sonnet; the explicit
        // opus is NOT swapped for sonnet — the fail-closed guard notifies.
        const d = __decideSlotForModelForTests(meshId, 'node_sonnet_easy', SONNET_EASY_NODE, task);
        expect(d.outcome).toBe('notify');
    });

    it('explicit model that a covering slot declares → runs with that model', () => {
        const meshId = freshMesh();
        enqueueTask(meshId, 'edit', { difficulty: 'easy', model: 'sonnet' });
        const [task] = getQueue(meshId);

        const d = __decideSlotForModelForTests(meshId, 'node_sonnet_easy', SONNET_EASY_NODE, task);
        expect(d.outcome).toBe('run');
        if (d.outcome === 'run') expect(d.model).toBe('sonnet');
    });

    it('★ slot NOT covering the difficulty → preset fallback (guard decides, as before)', () => {
        const meshId = freshMesh();
        // difficult presets 'opus'; SONNET_EASY_NODE covers only easy/medium.
        enqueueTask(meshId, 'redesign the scheduler', { difficulty: 'difficult' });
        const [task] = getQueue(meshId);
        expect(task.modelSource).toBe('preset');

        const d = __decideSlotForModelForTests(meshId, 'node_sonnet_easy', SONNET_EASY_NODE, task);
        // The preset 'opus' stands → no slot declares it → notify (pre-fix
        // behaviour preserved on non-covering nodes; no silent downgrade).
        expect(d.outcome).toBe('notify');
    });

    it('★ legacy row (no modelSource marker) is treated as explicit', () => {
        const meshId = freshMesh();
        // Rows enqueued before the marker existed must keep their old behaviour:
        // a slot must not override a value that might be a user's choice.
        const d = __decideSlotForModelForTests(meshId, 'node_sonnet_easy', SONNET_EASY_NODE, {
            model: 'haiku', difficulty: 'easy',
        });
        expect(d.outcome).toBe('notify');
    });
});
