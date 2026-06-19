import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Isolate all mesh file I/O to a per-run temp dir (same pattern as the other mesh tests).
const testTmpDir = join(tmpdir(), `adhdev-mesh-converge-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import {
    buildMeshNodeCapabilityTags,
    nodeSatisfiesRequiredTags,
    resolveConvergeRequiredTags,
    enqueueTask,
    getQueue,
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
} from '../../src/mesh/mesh-work-queue.js';
import {
    MESH_CONVERGE_REFINE_TAG,
    MESH_CONVERGE_FAST_FORWARD_TAG,
    resolveAutoConvergeCodeChange,
} from '../../src/repo-mesh-types.js';
import { createMesh, updateMesh } from '../../src/config/mesh-config.js';

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

// ─── (B) converge= synthetic capability tags ───────────────────────────────

describe('buildMeshNodeCapabilityTags — converge= tag (Part B)', () => {
    it('emits converge=refine for a local worktree node', () => {
        const tags = buildMeshNodeCapabilityTags({
            isLocalWorktree: true,
            worktreeBranch: 'feat/x',
        });
        expect(tags).toContain(MESH_CONVERGE_REFINE_TAG);
        expect(tags).not.toContain(MESH_CONVERGE_FAST_FORWARD_TAG);
    });

    it('emits converge=fast_forward for a non-worktree (machine) node', () => {
        const tags = buildMeshNodeCapabilityTags({ isLocalWorktree: false });
        expect(tags).toContain(MESH_CONVERGE_FAST_FORWARD_TAG);
        expect(tags).not.toContain(MESH_CONVERGE_REFINE_TAG);
    });

    it('treats a missing isLocalWorktree as a non-worktree node (fast_forward)', () => {
        expect(buildMeshNodeCapabilityTags(undefined)).toContain(MESH_CONVERGE_FAST_FORWARD_TAG);
        expect(buildMeshNodeCapabilityTags({})).toContain(MESH_CONVERGE_FAST_FORWARD_TAG);
    });

    it('makes converge=refine satisfiable only by worktree nodes (claim filter parity)', () => {
        const worktreeTags = buildMeshNodeCapabilityTags({ isLocalWorktree: true, worktreeBranch: 'b' });
        const machineTags = buildMeshNodeCapabilityTags({ isLocalWorktree: false });
        expect(nodeSatisfiesRequiredTags([MESH_CONVERGE_REFINE_TAG], worktreeTags)).toBe(true);
        expect(nodeSatisfiesRequiredTags([MESH_CONVERGE_REFINE_TAG], machineTags)).toBe(false);
    });
});

// ─── resolveAutoConvergeCodeChange opt-in resolver ─────────────────────────

describe('resolveAutoConvergeCodeChange', () => {
    it('defaults to false (strict opt-in)', () => {
        expect(resolveAutoConvergeCodeChange(undefined)).toBe(false);
        expect(resolveAutoConvergeCodeChange(null)).toBe(false);
        expect(resolveAutoConvergeCodeChange({})).toBe(false);
        expect(resolveAutoConvergeCodeChange({ autoConvergeCodeChange: false })).toBe(false);
    });

    it('is true only when explicitly enabled', () => {
        expect(resolveAutoConvergeCodeChange({ autoConvergeCodeChange: true })).toBe(true);
        expect(resolveAutoConvergeCodeChange({ autoConvergeCodeChange: 'true' as any })).toBe(false);
    });
});

// ─── (C) resolveConvergeRequiredTags — auto-inject decision (pure) ─────────

describe('resolveConvergeRequiredTags — auto-inject (Part C, opt-out paths)', () => {
    // These cases never need to touch the mesh policy: they short-circuit before
    // the getMesh lookup, so they are deterministic regardless of config.
    const meshId = 'mesh_does_not_matter';

    it('leaves non-code_change tasks unchanged (no convergence cost)', () => {
        for (const mode of ['validation', 'live_debug_readonly', 'launch_app', 'convergence'] as const) {
            expect(resolveConvergeRequiredTags(meshId, mode, ['cap=x'])).toEqual(['cap=x']);
        }
        expect(resolveConvergeRequiredTags(meshId, undefined, [])).toEqual([]);
    });

    it('leaves explicitly-targeted code_change tasks unchanged (operator chose the node)', () => {
        expect(
            resolveConvergeRequiredTags(meshId, 'code_change', ['cap=x'], { targetNodeId: 'node-1' }),
        ).toEqual(['cap=x']);
    });
});

// ─── (C) enqueue-time injection against a real mesh policy ─────────────────

describe('enqueueTask — converge=refine auto-injection (Part C)', () => {
    let meshId: string;

    beforeEach(() => {
        const mesh = createMesh({ name: 'converge-mesh', repoIdentity: `id_${randomUUID().slice(0, 8)}` });
        meshId = mesh.id;
        __clearMeshQueueForTests(meshId);
    });

    afterEach(() => {
        __clearMeshQueueForTests(meshId);
    });

    it('does NOT inject when the mesh has not opted in (default — backward compatible)', () => {
        const task = enqueueTask(meshId, 'edit src/foo.ts', { taskMode: 'code_change', requiredTags: ['cap=coding'] });
        expect(task.requiredTags).toEqual(['cap=coding']);
        expect(task.requiredTags).not.toContain(MESH_CONVERGE_REFINE_TAG);
    });

    it('injects converge=refine onto code_change once the mesh opts in', () => {
        updateMesh(meshId, { policy: { autoConvergeCodeChange: true } });
        const task = enqueueTask(meshId, 'edit src/foo.ts', { taskMode: 'code_change', requiredTags: ['cap=coding'] });
        expect(task.requiredTags).toContain(MESH_CONVERGE_REFINE_TAG);
        expect(task.requiredTags).toContain('cap=coding');
        // Persisted so the claim transaction enforces it too.
        expect(getQueue(meshId)[0].requiredTags).toContain(MESH_CONVERGE_REFINE_TAG);
    });

    it('is idempotent — no duplicate tag when already present', () => {
        updateMesh(meshId, { policy: { autoConvergeCodeChange: true } });
        const task = enqueueTask(meshId, 'edit', { taskMode: 'code_change', requiredTags: [MESH_CONVERGE_REFINE_TAG] });
        expect(task.requiredTags.filter(t => t === MESH_CONVERGE_REFINE_TAG)).toHaveLength(1);
    });

    it('does NOT inject onto read-only / validation tasks even when opted in', () => {
        updateMesh(meshId, { policy: { autoConvergeCodeChange: true } });
        const ro = enqueueTask(meshId, 'inspect logs', { taskMode: 'live_debug_readonly' });
        expect(ro.requiredTags).not.toContain(MESH_CONVERGE_REFINE_TAG);
        const val = enqueueTask(meshId, 'run tests', { taskMode: 'validation' });
        expect(val.requiredTags).not.toContain(MESH_CONVERGE_REFINE_TAG);
    });

    it('does NOT inject when the code_change task is explicitly targeted (target_node_id)', () => {
        updateMesh(meshId, { policy: { autoConvergeCodeChange: true } });
        const task = enqueueTask(meshId, 'edit', { taskMode: 'code_change', targetNodeId: 'node-1' });
        expect(task.requiredTags).not.toContain(MESH_CONVERGE_REFINE_TAG);
    });

    it('opt-in injection routes code_change to a worktree node and away from a machine node', () => {
        updateMesh(meshId, { policy: { autoConvergeCodeChange: true } });
        const task = enqueueTask(meshId, 'edit', { taskMode: 'code_change' });
        const worktreeTags = buildMeshNodeCapabilityTags({ isLocalWorktree: true, worktreeBranch: 'b' });
        const machineTags = buildMeshNodeCapabilityTags({ isLocalWorktree: false });
        expect(nodeSatisfiesRequiredTags(task.requiredTags, worktreeTags)).toBe(true);
        expect(nodeSatisfiesRequiredTags(task.requiredTags, machineTags)).toBe(false);
    });
});
