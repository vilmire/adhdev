import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Isolate all mesh file I/O to a per-run temp dir (same pattern as the other mesh tests).
const testTmpDir = join(tmpdir(), `adhdev-brain-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import {
    enqueueTask,
    getQueue,
    __resetMeshRuntimeStoreForTests,
} from '../../src/mesh/mesh-work-queue.js';
import { createMesh, setDifficultyBrains } from '../../src/config/mesh-config.js';

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

function freshMesh(): string {
    return createMesh({ name: 'brain-mesh', repoIdentity: `id_${randomUUID().slice(0, 8)}` }).id;
}

describe('difficulty → brain resolution at enqueue', () => {
    it('fills model + thinkingLevel from the DEFAULT preset for the difficulty', () => {
        const meshId = freshMesh();
        // No difficultyBrains configured → getDifficultyBrains seeds the defaults.
        enqueueTask(meshId, 'rename a variable', { difficulty: 'easy' });
        const [task] = getQueue(meshId);
        expect(task.model).toBe('haiku');        // DEFAULT_DIFFICULTY_BRAINS.easy
        expect(task.thinkingLevel).toBe('low');
    });

    it('uses the difficult preset (opus / high)', () => {
        const meshId = freshMesh();
        enqueueTask(meshId, 'redesign the scheduler', { difficulty: 'difficult' });
        const [task] = getQueue(meshId);
        expect(task.model).toBe('opus');
        expect(task.thinkingLevel).toBe('high');
    });

    it('an explicit model/thinkingLevel WINS over the preset', () => {
        const meshId = freshMesh();
        enqueueTask(meshId, 'edit', { difficulty: 'easy', model: 'sonnet', thinkingLevel: 'high' });
        const [task] = getQueue(meshId);
        expect(task.model).toBe('sonnet');       // not the easy default 'haiku'
        expect(task.thinkingLevel).toBe('high'); // not 'low'
    });

    it('respects a custom preset saved via setDifficultyBrains', () => {
        const meshId = freshMesh();
        setDifficultyBrains({ easy: { model: 'custom-mini', thinkingLevel: 'low' } });
        enqueueTask(meshId, 'trivial', { difficulty: 'easy' });
        const [task] = getQueue(meshId);
        expect(task.model).toBe('custom-mini');
    });

    it('a preset that sets only thinkingLevel leaves model unset', () => {
        const meshId = freshMesh();
        setDifficultyBrains({ medium: { thinkingLevel: 'medium' } });
        enqueueTask(meshId, 'work', { difficulty: 'medium' });
        const [task] = getQueue(meshId);
        expect(task.thinkingLevel).toBe('medium');
        expect(task.model).toBeUndefined();
    });

    it('no difficulty → no preset-derived model/thinkingLevel', () => {
        const meshId = freshMesh();
        enqueueTask(meshId, 'plain task', {});
        const [task] = getQueue(meshId);
        expect(task.model).toBeUndefined();
        expect(task.thinkingLevel).toBeUndefined();
    });

    it('an unknown difficulty is ignored (no resolution, no throw)', () => {
        const meshId = freshMesh();
        enqueueTask(meshId, 'task', { difficulty: 'nonsense' as any });
        const [task] = getQueue(meshId);
        expect(task.model).toBeUndefined();
        expect(task.thinkingLevel).toBeUndefined();
    });

    it('freeform has no default preset → leaves model/thinking unset', () => {
        const meshId = freshMesh();
        enqueueTask(meshId, 'freeform work', { difficulty: 'freeform' });
        const [task] = getQueue(meshId);
        expect(task.model).toBeUndefined();
        expect(task.thinkingLevel).toBeUndefined();
    });
});
