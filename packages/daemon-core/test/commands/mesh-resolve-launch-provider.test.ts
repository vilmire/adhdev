/**
 * mesh_resolve_launch_provider: a manual `mesh_launch_session` with no `type` asks the
 * daemon which provider the AUTO-LAUNCH routing would pick (resolveUsableProvider), so a
 * node with neither slots nor providerPriority launches on the machine's enabled
 * providers exactly as the queue drain does. Also pins the config-dir identity the
 * onboarding planner stamps (MCP mesh-write guard).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-resolve-launch-provider-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_host000000000001' }),
    getMachineId: () => 'mach_host000000000001',
    getMachineNickname: () => null,
}));
const detectCliMocks = vi.hoisted(() => ({ detected: new Set<string>() }));
vi.mock('../../src/detection/cli-detector.js', () => ({
    detectCLI: async (id: string) => (detectCliMocks.detected.has(id) ? { id, installed: true, path: `/mock/${id}` } : null),
    getCachedCliInventory: async () => [],
}));

import { meshStatusViewHandlers } from '../../src/commands/high-family/mesh-status-view';
import { meshOnboardingHandlers } from '../../src/commands/med-family/mesh-onboarding';
import { configDirIdentity } from '../../src/config/config-identity';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { installLocalNodeProviderFallback } from '../../src/mesh/mesh-slot-provider-usability.js';

const MESH_ID = 'mesh_resolve_launch';

function providerLoader(enabled: string[]) {
    return {
        resolveAlias: (t: string) => t,
        isMachineProviderEnabled: (t: string) => enabled.includes(t),
        setCliDetectionResults: () => {},
        getCliDetectionList: () => enabled.map((id) => ({ id, displayName: id, icon: '', command: id, category: 'cli', enabled: true })),
    };
}

function ctxFor(node: any, loader: ReturnType<typeof providerLoader>) {
    return {
        getMeshForCommand: async () => ({ mesh: { id: MESH_ID, policy: {}, nodes: [node] } }),
        components: () => ({ providerLoader: loader }),
        deps: { providerLoader: loader },
    } as any;
}

afterEach(() => {
    detectCliMocks.detected.clear();
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('mesh_resolve_launch_provider', () => {
    it('a local node with no providerPriority and no slots resolves to this machine\'s detected enabled provider', async () => {
        detectCliMocks.detected.add('claude-cli');
        const loader = providerLoader(['claude-cli', 'kimi']);
        const node = { id: 'node_local', daemonId: 'mach_host000000000001', policy: {} };
        const off = installLocalNodeProviderFallback(loader as any);
        try {
            const res: any = await meshStatusViewHandlers.mesh_resolve_launch_provider(ctxFor(node, loader), { meshId: MESH_ID, nodeId: 'node_local' });
            expect(res.success).toBe(true);
            expect(res.providerType).toBe('claude-cli');
        } finally {
            off();
        }
    });

    it('reports the routing reason (not a guess) when nothing is launchable', async () => {
        const loader = providerLoader([]);
        const node = { id: 'node_local', daemonId: 'mach_host000000000001', policy: {} };
        const off = installLocalNodeProviderFallback(loader as any);
        try {
            const res: any = await meshStatusViewHandlers.mesh_resolve_launch_provider(ctxFor(node, loader), { meshId: MESH_ID, nodeId: 'node_local' });
            expect(res.success).toBe(false);
            expect(res.code).toBe('mesh_launch_provider_unresolved');
            expect(res.reason).toBe('missing_provider_priority');
        } finally {
            off();
        }
    });

    it('requires meshId and nodeId; an unknown node is refused', async () => {
        const loader = providerLoader([]);
        expect((await meshStatusViewHandlers.mesh_resolve_launch_provider(ctxFor({ id: 'n' }, loader), { meshId: MESH_ID }) as any).success).toBe(false);
        const res: any = await meshStatusViewHandlers.mesh_resolve_launch_provider(ctxFor({ id: 'n' }, loader), { meshId: MESH_ID, nodeId: 'other' });
        expect(res.code).toBe('mesh_node_unknown');
    });
});

describe('plan_mesh_onboarding stamps the daemon config-dir identity', () => {
    it('on every outcome, as a digest (never the path)', async () => {
        const res: any = await meshOnboardingHandlers.plan_mesh_onboarding(
            { deps: { providerLoader: providerLoader([]) } } as any,
            { workspace: join(testTmpDir, 'not-a-repo'), operation: 'auto' },
        );
        expect(res.daemonConfigIdentity).toBe(configDirIdentity());
        expect(res.daemonConfigIdentity).toMatch(/^[0-9a-f]{16}$/);
        expect(JSON.stringify(res)).not.toContain(testConfigDir);
    });
});
