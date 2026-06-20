import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Isolate all mesh file I/O to a per-run temp dir (same pattern as the other mesh tests).
const testTmpDir = join(tmpdir(), `adhdev-mesh-visibility-default-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import { createMesh, updateMesh } from '../../src/config/mesh-config.js';
import { DEFAULT_MESH_POLICY } from '../../src/repo-mesh-types.js';

afterEach(() => {
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('mesh policy — coordinator spawned-session visibility default', () => {
    it('DEFAULT_MESH_POLICY hides coordinator-spawned sessions', () => {
        expect(DEFAULT_MESH_POLICY.spawnedSessionVisibility).toBe('hidden');
    });

    it('a freshly created mesh (no explicit policy) defaults spawnedSessionVisibility to hidden', () => {
        const mesh = createMesh({ name: 'm', repoIdentity: 'id_default' });
        expect(mesh.policy.spawnedSessionVisibility).toBe('hidden');
    });

    it('preserves an explicit visible override (user opt-in to visible coordinator sessions)', () => {
        const mesh = createMesh({
            name: 'm',
            repoIdentity: 'id_visible',
            policy: { spawnedSessionVisibility: 'visible' },
        });
        expect(mesh.policy.spawnedSessionVisibility).toBe('visible');

        // And updating with an unrelated field keeps the user's visible choice.
        const updated = updateMesh(mesh.id, { policy: { maxParallelTasks: 3 } });
        expect(updated?.policy.spawnedSessionVisibility).toBe('visible');
    });

    it('falls back an invalid spawnedSessionVisibility to the hidden default', () => {
        const mesh = createMesh({
            name: 'm',
            repoIdentity: 'id_invalid',
            policy: { spawnedSessionVisibility: 'bogus' as any },
        });
        expect(mesh.policy.spawnedSessionVisibility).toBe('hidden');
    });
});
