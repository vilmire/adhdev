import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Isolate all mesh file I/O to a per-run temp dir (same pattern as the other mesh tests).
const testTmpDir = join(tmpdir(), `adhdev-quota-routing-writer-${randomUUID().slice(0, 8)}`);
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
    getMesh,
    getMeshQuotaRouting,
    setMeshQuotaRouting,
} from '../../src/config/mesh-config.js';
import { meshCrudHandlers } from '../../src/commands/med-family/mesh-crud.js';
import {
    evaluateProviderQuotaGate,
    PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON,
} from '../../src/mesh/mesh-quota-routing.js';
import { DEFAULT_QUOTA_ROUTING_POLICY } from '../../src/repo-mesh-types.js';

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;

/** The set handler touches cache collaborators only when a cache entry exists. */
const HANDLER_CTX = {
    getCachedInlineMesh: () => undefined,
    invalidateAggregateMeshStatus: () => {},
    inlineMeshCache: new Map(),
} as any;

function nodeWithSessionQuota(usedPercent: number, updatedAt: number = NOW - MIN, reportedAt: number = NOW) {
    return {
        id: 'n1',
        nodeFacts: {
            schemaVersion: 1,
            reportedAt,
            quota: {
                'claude-cli': {
                    provider: 'claude-cli',
                    status: 'ok',
                    session: { usedPercent, windowMinutes: 300, resetsAt: null },
                    weekly: { usedPercent: 0, windowMinutes: 10080, resetsAt: null },
                    updatedAt,
                    error: null,
                },
            },
        },
    };
}

function readPersistedQuotaRouting(meshId: string): unknown {
    const raw = JSON.parse(readFileSync(join(testConfigDir, 'meshes.json'), 'utf-8'));
    return raw.meshes.find((m: any) => m.id === meshId)?.policy?.quotaRouting;
}

beforeEach(() => {
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
    mkdirSync(testConfigDir, { recursive: true });
});

afterEach(() => {
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('setMeshQuotaRouting — dedicated writer for RepoMeshPolicy.quotaRouting', () => {
    it('persists the overrides onto the mesh policy in meshes.json', () => {
        const mesh = createMesh({ name: 'm', repoIdentity: 'github.com/acme/m' });
        const persisted = setMeshQuotaRouting({ sessionMinRemainingPercent: 80, weeklyMinRemainingPercent: 60 }, mesh.id);
        expect(persisted).toEqual({ sessionMinRemainingPercent: 80, weeklyMinRemainingPercent: 60 });
        expect(readPersistedQuotaRouting(mesh.id)).toEqual({ sessionMinRemainingPercent: 80, weeklyMinRemainingPercent: 60 });
        expect(getMeshQuotaRouting(mesh.id)).toEqual({ sessionMinRemainingPercent: 80, weeklyMinRemainingPercent: 60 });
    });

    it('drops overrides that equal the defaults, and an empty object clears the key entirely', () => {
        const mesh = createMesh({ name: 'm', repoIdentity: 'github.com/acme/m' });
        setMeshQuotaRouting({ sessionMinRemainingPercent: DEFAULT_QUOTA_ROUTING_POLICY.sessionMinRemainingPercent }, mesh.id);
        expect(readPersistedQuotaRouting(mesh.id)).toBeUndefined();
        setMeshQuotaRouting({ sessionMinRemainingPercent: 80 }, mesh.id);
        expect(readPersistedQuotaRouting(mesh.id)).toEqual({ sessionMinRemainingPercent: 80 });
        const cleared = setMeshQuotaRouting({}, mesh.id);
        expect(cleared).toEqual({});
        expect(readPersistedQuotaRouting(mesh.id)).toBeUndefined();
    });

    it('rejects unknown fields, non-numbers, out-of-range percents, and negative durations', () => {
        const mesh = createMesh({ name: 'm', repoIdentity: 'github.com/acme/m' });
        expect(() => setMeshQuotaRouting({ sessionMinRemaining: 50 }, mesh.id)).toThrow(/invalid_quota_routing: unknown field/);
        expect(() => setMeshQuotaRouting({ sessionMinRemainingPercent: '50' }, mesh.id)).toThrow(/invalid_quota_routing: sessionMinRemainingPercent must be a finite number/);
        expect(() => setMeshQuotaRouting({ sessionMinRemainingPercent: 101 }, mesh.id)).toThrow(/between 0 and 100/);
        expect(() => setMeshQuotaRouting({ weeklyMinRemainingPercent: -1 }, mesh.id)).toThrow(/between 0 and 100/);
        expect(() => setMeshQuotaRouting({ staleAfterMs: -1000 }, mesh.id)).toThrow(/must be >= 0/);
        expect(() => setMeshQuotaRouting({ sessionResetImminentMs: -1 }, mesh.id)).toThrow(/must be >= 0/);
        // A rejected write must leave the mesh untouched — no pathological threshold
        // can reach the gate through this path.
        expect(readPersistedQuotaRouting(mesh.id)).toBeUndefined();
    });

    it('refuses an ambiguous write when several meshes are configured and no meshId is given', () => {
        createMesh({ name: 'a', repoIdentity: 'github.com/acme/a' });
        createMesh({ name: 'b', repoIdentity: 'github.com/acme/b' });
        expect(() => setMeshQuotaRouting({ sessionMinRemainingPercent: 80 })).toThrow(/quota_routing_mesh_ambiguous/);
    });
});

describe('quota gate reads the CONFIGURED thresholds (not the constants)', () => {
    it('a session reading above the default floor still blocks once the mesh raises the threshold', () => {
        const mesh = createMesh({ name: 'm', repoIdentity: 'github.com/acme/m' });
        // 50% session remaining: comfortably above the 10% default floor…
        const node = nodeWithSessionQuota(50);
        expect(evaluateProviderQuotaGate(node, 'claude-cli', getMesh(mesh.id)?.policy?.quotaRouting ?? null, NOW)).toBeNull();
        // …but below the configured 80% floor → the SAME reading now blocks.
        setMeshQuotaRouting({ sessionMinRemainingPercent: 80 }, mesh.id);
        const stored = getMesh(mesh.id)?.policy?.quotaRouting ?? null;
        const block = evaluateProviderQuotaGate(node, 'claude-cli', stored, NOW);
        expect(block?.reason).toBe(PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON);
        expect(block?.thresholdPercent).toBe(80);
        // Clearing the override restores the default judgement.
        setMeshQuotaRouting({}, mesh.id);
        expect(evaluateProviderQuotaGate(node, 'claude-cli', getMesh(mesh.id)?.policy?.quotaRouting ?? null, NOW)).toBeNull();
    });

    it('a configured staleAfterMs decides which snapshots the gate still trusts', () => {
        const mesh = createMesh({ name: 'm', repoIdentity: 'github.com/acme/m' });
        // Snapshot is 2h old — stale under the 30min default, so the gate fails OPEN…
        const node = nodeWithSessionQuota(95, NOW - 2 * 60 * MIN, NOW - 2 * 60 * MIN);
        expect(evaluateProviderQuotaGate(node, 'claude-cli', getMesh(mesh.id)?.policy?.quotaRouting ?? null, NOW)).toBeNull();
        // …but fresh under a configured 24h staleness budget → the gate applies.
        setMeshQuotaRouting({ staleAfterMs: 24 * 60 * MIN }, mesh.id);
        const block = evaluateProviderQuotaGate(node, 'claude-cli', getMesh(mesh.id)?.policy?.quotaRouting ?? null, NOW);
        expect(block?.reason).toBe(PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON);
    });
});

describe('the CLAIM PATH reads the written thresholds (write → getMeshWithCache → gate)', () => {
    // The tests above hand the gate a policy read straight from getMesh. This one
    // closes the last link: tryAssignQueueTask resolves the mesh through
    // getMeshWithCache and passes `mesh?.policy?.quotaRouting` to
    // evaluateProviderQuotaGate (mesh-queue-assignment.ts:808). If that resolver
    // ever served a memoized or inline-cached policy, a saved threshold would be
    // silently ignored on the very path the setup wizard exists to configure — so
    // assert the composition itself, not just the writer and the gate separately.
    it('picks up a freshly written threshold with no daemon restart or cache invalidation', async () => {
        const { getMeshWithCache } = await import('../../src/mesh/mesh-queue-assignment.js');
        const mesh = createMesh({ name: 'm', repoIdentity: 'github.com/acme/m' });
        const node = nodeWithSessionQuota(50); // 50% session remaining

        // An inline mesh cache holding the PRE-write policy: the claim path must not
        // serve this stale copy for the policy (it only contributes cache-only nodes).
        const components: any = {
            router: { getCachedInlineMesh: () => ({ ...getMesh(mesh.id), nodes: [] }) },
        };

        const before = getMeshWithCache(components, mesh.id);
        expect(evaluateProviderQuotaGate(node, 'claude-cli', before?.policy?.quotaRouting ?? null, NOW)).toBeNull();

        setMeshQuotaRouting({ sessionMinRemainingPercent: 80 }, mesh.id);

        const after = getMeshWithCache(components, mesh.id);
        expect(after?.policy?.quotaRouting).toEqual({ sessionMinRemainingPercent: 80 });
        const block = evaluateProviderQuotaGate(node, 'claude-cli', after?.policy?.quotaRouting ?? null, NOW);
        expect(block?.reason).toBe(PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON);
        expect(block?.thresholdPercent).toBe(80);
    });
});

describe('mesh_quota_routing_get / mesh_quota_routing_set commands', () => {
    it('round-trips overrides and reports the resolved thresholds the gate will apply', async () => {
        const mesh = createMesh({ name: 'm', repoIdentity: 'github.com/acme/m' });
        const setResult: any = await meshCrudHandlers.mesh_quota_routing_set(HANDLER_CTX, {
            meshId: mesh.id,
            quotaRouting: { weeklyMinRemainingPercent: 42 },
        });
        expect(setResult.success).toBe(true);
        expect(setResult.quotaRouting).toEqual({ weeklyMinRemainingPercent: 42 });
        expect(setResult.resolved.weeklyMinRemainingPercent).toBe(42);
        expect(setResult.resolved.sessionMinRemainingPercent).toBe(DEFAULT_QUOTA_ROUTING_POLICY.sessionMinRemainingPercent);

        const getResult: any = await meshCrudHandlers.mesh_quota_routing_get(HANDLER_CTX, { meshId: mesh.id });
        expect(getResult.success).toBe(true);
        expect(getResult.quotaRouting).toEqual({ weeklyMinRemainingPercent: 42 });
        expect(getResult.defaults).toEqual(DEFAULT_QUOTA_ROUTING_POLICY);
        expect(getResult.scope).toMatchObject({ kind: 'mesh', storage: 'machine_local', meshId: mesh.id });
        // And the gate judges by the value written THROUGH the command.
        const node = nodeWithSessionQuota(0);
        (node.nodeFacts.quota as any)['claude-cli'].session.usedPercent = 0;
        (node.nodeFacts.quota as any)['claude-cli'].weekly.usedPercent = 70; // 30% remaining < 42%
        const block = evaluateProviderQuotaGate(node, 'claude-cli', getMesh(mesh.id)?.policy?.quotaRouting ?? null, NOW);
        expect(block?.window).toBe('weekly');
        expect(block?.thresholdPercent).toBe(42);
    });

    it('surfaces validation failures as structured errors without writing', async () => {
        const mesh = createMesh({ name: 'm', repoIdentity: 'github.com/acme/m' });
        const result: any = await meshCrudHandlers.mesh_quota_routing_set(HANDLER_CTX, {
            meshId: mesh.id,
            quotaRouting: { sessionMinRemainingPercent: 500 },
        });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/invalid_quota_routing/);
        expect(readPersistedQuotaRouting(mesh.id)).toBeUndefined();
    });
});
