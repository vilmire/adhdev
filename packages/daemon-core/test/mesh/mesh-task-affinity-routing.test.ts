import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Isolate all mesh file I/O to a per-run temp dir (same pattern as the other mesh tests).
const testTmpDir = join(tmpdir(), `adhdev-mesh-affinity-test-${randomUUID().slice(0, 8)}`);
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
    resolveTaskAffinityRequiredTags,
    buildMeshNodeCapabilityTags,
    nodeSatisfiesRequiredTags,
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
} from '../../src/mesh/mesh-work-queue.js';
import {
    STANDARD_MESH_ROLES,
    DEFAULT_TASKMODE_ROLE_MAP,
    resolveTaskAffinityRole,
    resolveMeshRoleOptions,
} from '../../src/repo-mesh-types.js';
import { createMesh, updateMesh, addNode, getMesh } from '../../src/config/mesh-config.js';

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

// ─── Standard role constants + default mapping (pure) ──────────────────────

describe('STANDARD_MESH_ROLES / DEFAULT_TASKMODE_ROLE_MAP', () => {
    it('defines the four standard roles', () => {
        expect([...STANDARD_MESH_ROLES]).toEqual(['investigator', 'coder', 'validator', 'converger']);
    });

    it('maps every task mode to the confirmed default role', () => {
        expect(DEFAULT_TASKMODE_ROLE_MAP.live_debug_readonly).toBe('investigator');
        expect(DEFAULT_TASKMODE_ROLE_MAP.code_change).toBe('coder');
        expect(DEFAULT_TASKMODE_ROLE_MAP.launch_app).toBe('coder');
        expect(DEFAULT_TASKMODE_ROLE_MAP.validation).toBe('validator');
        expect(DEFAULT_TASKMODE_ROLE_MAP.convergence).toBe('converger');
    });
});

describe('resolveTaskAffinityRole (pure precedence)', () => {
    it('falls back to the default mapping when no policy block exists', () => {
        expect(resolveTaskAffinityRole('code_change', undefined)).toBe('coder');
        expect(resolveTaskAffinityRole('validation', null)).toBe('validator');
        expect(resolveTaskAffinityRole('live_debug_readonly', {})).toBe('investigator');
    });

    it('returns null for an unknown mode or missing mode', () => {
        expect(resolveTaskAffinityRole(undefined, {})).toBeNull();
        expect(resolveTaskAffinityRole('not_a_mode', {})).toBeNull();
    });

    it('honors a byTaskMode override (standard or custom role)', () => {
        expect(resolveTaskAffinityRole('code_change', { byTaskMode: { code_change: 'validator' } })).toBe('validator');
        expect(resolveTaskAffinityRole('validation', { byTaskMode: { validation: 'qa-bot' } })).toBe('qa-bot');
    });

    it('treats a blank override as an explicit per-mode opt-out', () => {
        expect(resolveTaskAffinityRole('code_change', { byTaskMode: { code_change: '' } })).toBeNull();
        expect(resolveTaskAffinityRole('code_change', { byTaskMode: { code_change: '   ' } })).toBeNull();
    });

    it('disables affinity entirely when enabled:false', () => {
        expect(resolveTaskAffinityRole('code_change', { enabled: false })).toBeNull();
        expect(resolveTaskAffinityRole('code_change', { enabled: false, byTaskMode: { code_change: 'coder' } })).toBeNull();
    });
});

describe('resolveMeshRoleOptions — dashboard dropdown union', () => {
    it('returns the four standards when no custom roles are declared', () => {
        expect(resolveMeshRoleOptions(undefined)).toEqual(['investigator', 'coder', 'validator', 'converger']);
    });

    it('appends config-declared custom roles (byTaskMode values + customRoles), deduped, standard-first', () => {
        const options = resolveMeshRoleOptions({
            byTaskMode: { validation: 'qa-bot', code_change: 'coder' },
            customRoles: ['Release-Bot', 'qa-bot'],
        });
        expect(options).toEqual(['investigator', 'coder', 'validator', 'converger', 'qa-bot', 'release-bot']);
    });
});

// ─── resolveTaskAffinityRequiredTags — opt-out short-circuits (need a real mesh) ──

describe('resolveTaskAffinityRequiredTags — precedence guards', () => {
    let meshId: string;
    let coderNodeId: string;

    beforeEach(() => {
        const mesh = createMesh({ name: 'affinity-mesh', repoIdentity: `id_${randomUUID().slice(0, 8)}` });
        meshId = mesh.id;
        // A node that advertises role=coder so SOFT affinity can actually inject.
        const node = addNode(meshId, {
            workspace: `/tmp/ws-${randomUUID().slice(0, 8)}`,
            policy: { providerRoles: [{ providerType: 'claude-cli', role: 'coder' }] },
        });
        coderNodeId = node!.id;
        __clearMeshQueueForTests(meshId);
    });

    afterEach(() => {
        __clearMeshQueueForTests(meshId);
    });

    it('injects role=coder for a code_change task (default mapping, role node present)', () => {
        const tags = resolveTaskAffinityRequiredTags(meshId, 'code_change', []);
        expect(tags).toContain('role=coder');
    });

    it('leaves the tags unchanged when the caller pinned a target_node_id', () => {
        const tags = resolveTaskAffinityRequiredTags(meshId, 'code_change', [], { targetNodeId: coderNodeId });
        expect(tags).toEqual([]);
    });

    it('leaves the tags unchanged when the caller supplied their own required_tags', () => {
        const tags = resolveTaskAffinityRequiredTags(meshId, 'code_change', ['role=validator'], { callerSpecifiedRequiredTags: true });
        expect(tags).toEqual(['role=validator']);
    });

    it('SOFT fallback: skips injection when no node advertises the resolved role', () => {
        // The only node advertises role=coder; a validation task maps to role=validator,
        // which no node can satisfy → injection is skipped (least_loaded fallback).
        const tags = resolveTaskAffinityRequiredTags(meshId, 'validation', []);
        expect(tags).toEqual([]);
        expect(tags).not.toContain('role=validator');
    });
});

// ─── enqueueTask — affinity auto-injection against a real mesh ─────────────

describe('enqueueTask — task_mode → role affinity auto-injection', () => {
    let meshId: string;

    function addRoleNode(role: string): string {
        const node = addNode(meshId, {
            workspace: `/tmp/ws-${role}-${randomUUID().slice(0, 8)}`,
            policy: { providerRoles: [{ providerType: 'claude-cli', role }] },
        });
        return node!.id;
    }

    beforeEach(() => {
        const mesh = createMesh({ name: 'affinity-enqueue-mesh', repoIdentity: `id_${randomUUID().slice(0, 8)}` });
        meshId = mesh.id;
        __clearMeshQueueForTests(meshId);
    });

    afterEach(() => {
        __clearMeshQueueForTests(meshId);
    });

    it('(1) injects the default role tag for each task mode when a matching role node exists', () => {
        // One node per standard role so every mode has a satisfiable destination.
        for (const role of STANDARD_MESH_ROLES) addRoleNode(role);
        const cases: Array<[string, string]> = [
            ['live_debug_readonly', 'role=investigator'],
            ['code_change', 'role=coder'],
            ['launch_app', 'role=coder'],
            ['validation', 'role=validator'],
            ['convergence', 'role=converger'],
        ];
        for (const [mode, expectedTag] of cases) {
            // live_debug_readonly forbids mutation verbs — keep messages benign.
            const task = enqueueTask(meshId, `do ${mode} work`, { taskMode: mode });
            expect(task.requiredTags, `${mode} should inject ${expectedTag}`).toContain(expectedTag);
            // Persisted so the claim transaction enforces it.
            expect(getQueue(meshId).find(t => t.id === task.id)!.requiredTags).toContain(expectedTag);
            __clearMeshQueueForTests(meshId);
        }
    });

    it('(2) does NOT override caller-specified required_tags', () => {
        addRoleNode('coder');
        addRoleNode('validator');
        const task = enqueueTask(meshId, 'edit src/x.ts', { taskMode: 'code_change', requiredTags: ['role=validator'] });
        // Caller asked for validator; affinity must not add coder on top.
        expect(task.requiredTags).toEqual(['role=validator']);
        expect(task.requiredTags).not.toContain('role=coder');
    });

    it('(2b) does NOT inject when a target_node_id pins the task', () => {
        const coderNode = addRoleNode('coder');
        const task = enqueueTask(meshId, 'edit src/x.ts', { taskMode: 'code_change', targetNodeId: coderNode });
        expect(task.requiredTags).not.toContain('role=coder');
        expect(task.targetNodeId).toBe(coderNode);
    });

    it('(3) injects a config-declared custom role override', () => {
        // Custom role: code_change → qa-bot, and a node advertising role=qa-bot.
        updateMesh(meshId, { policy: { taskAffinity: { byTaskMode: { code_change: 'qa-bot' } } } });
        addRoleNode('qa-bot');
        const task = enqueueTask(meshId, 'edit src/x.ts', { taskMode: 'code_change' });
        expect(task.requiredTags).toContain('role=qa-bot');
        expect(task.requiredTags).not.toContain('role=coder');
    });

    it('(4) SOFT fallback: does NOT block when no node advertises the role', () => {
        // No nodes advertise role=coder → the code_change task enqueues with NO role tag
        // so it falls back to ordinary least_loaded eligibility instead of being blocked.
        const task = enqueueTask(meshId, 'edit src/x.ts', { taskMode: 'code_change' });
        expect(task.requiredTags).toEqual([]);
        expect(task.status).toBe('pending');
        // An empty required-tags set is satisfied by ANY node (least_loaded fallback).
        const anyNodeTags = buildMeshNodeCapabilityTags({ isLocalWorktree: false });
        expect(nodeSatisfiesRequiredTags(task.requiredTags, anyNodeTags)).toBe(true);
    });

    it('respects { enabled:false } — fully restores pre-affinity routing', () => {
        updateMesh(meshId, { policy: { taskAffinity: { enabled: false } } });
        addRoleNode('coder');
        const task = enqueueTask(meshId, 'edit src/x.ts', { taskMode: 'code_change' });
        expect(task.requiredTags).toEqual([]);
    });
});

// ─── mergeMeshPolicy — taskAffinity merge/validation ──────────────────────

describe('mergeMeshPolicy — taskAffinity normalization', () => {
    let meshId: string;

    beforeEach(() => {
        const mesh = createMesh({ name: 'affinity-config-mesh', repoIdentity: `id_${randomUUID().slice(0, 8)}` });
        meshId = mesh.id;
    });

    it('does not persist a taskAffinity block when omitted (byte-for-byte untouched)', () => {
        const mesh = getMesh(meshId)!;
        expect(mesh.policy.taskAffinity).toBeUndefined();
    });

    it('trims/lowercases roles and drops blank custom roles; keeps custom (non-standard) roles', () => {
        updateMesh(meshId, {
            policy: {
                taskAffinity: {
                    byTaskMode: { code_change: '  QA-Bot  ', validation: '' },
                    customRoles: ['Release-Bot', '   ', 'qa-bot'],
                },
            },
        });
        const affinity = getMesh(meshId)!.policy.taskAffinity!;
        expect(affinity.byTaskMode).toEqual({ code_change: 'qa-bot', validation: '' });
        expect(affinity.customRoles).toEqual(['release-bot', 'qa-bot']);
    });

    it('persists enabled:false but drops the default enabled:true', () => {
        updateMesh(meshId, { policy: { taskAffinity: { enabled: false } } });
        expect(getMesh(meshId)!.policy.taskAffinity).toEqual({ enabled: false });

        updateMesh(meshId, { policy: { taskAffinity: { enabled: true, customRoles: ['x'] } } });
        const affinity = getMesh(meshId)!.policy.taskAffinity!;
        expect(affinity.enabled).toBeUndefined();
        expect(affinity.customRoles).toEqual(['x']);
    });

    it('drops an entirely empty taskAffinity block (no-op normalization)', () => {
        updateMesh(meshId, { policy: { taskAffinity: { byTaskMode: {}, customRoles: [] } } });
        expect(getMesh(meshId)!.policy.taskAffinity).toBeUndefined();
    });
});
