/**
 * Queue auto-launch judges provider usability on the machine that will SPAWN the CLI.
 *
 * Live standalone multi-machine run (2026-10-08): claude-cli enabled only on the
 * member, the host's resolveUsableProvider consulted the HOST's
 * isMachineProviderEnabled + a host-local detectCLI, and the task stayed
 * `skipped: provider_priority_unusable: claude-cli: disabled` until the provider
 * was also enabled on the host. A remote node is now refused only on its OWN
 * reported verdict (nodeFacts.providerEnablement); otherwise the forwarded
 * launch_cli decides on the member. Local nodes keep the local check.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-remote-provider-usability-${randomUUID().slice(0, 8)}`);
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

const detectCliMocks = vi.hoisted(() => ({ detected: new Set<string>(), calls: [] as string[] }));
vi.mock('../../src/detection/cli-detector.js', () => ({
    detectCLI: async (id: string) => {
        detectCliMocks.calls.push(id);
        return detectCliMocks.detected.has(id) ? { id, installed: true, path: `/mock/${id}` } : null;
    },
}));

import { __resolveUsableProviderForTests } from '../../src/mesh/mesh-queue-assignment.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';

const MESH_ID = 'mesh_remote_provider_usability';
const REMOTE_DAEMON = 'mach_member00000000002';

/** Host loader: claude-cli DISABLED here, and the host's detection cache is observable. */
function hostComponents() {
    const detectionWrites: any[] = [];
    return {
        detectionWrites,
        components: {
            providerLoader: {
                resolveAlias: (t: string) => t,
                isMachineProviderEnabled: () => false,
                setCliDetectionResults: (r: any[]) => { detectionWrites.push(...r); },
            },
        } as any,
    };
}

function resolve(components: any, node: any, nodes?: any[]) {
    return __resolveUsableProviderForTests(
        components, node.id, node, MESH_ID, undefined,
        { difficulty: 'freeform', requiredTags: undefined }, null,
        { nodes: nodes ?? [node] }, 'task_1',
    );
}

const slots = [{ provider: 'claude-cli', difficulty: ['easy', 'medium', 'difficult'], maxParallel: 1 }];

beforeEach(() => {
    detectCliMocks.detected.clear();
    detectCliMocks.calls.length = 0;
});
afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('resolveUsableProvider — provider usability is judged on the spawning machine', () => {
    it('a remote node whose provider is enabled only on the member is launchable (host config is not consulted)', async () => {
        const { components, detectionWrites } = hostComponents();
        const node = {
            id: 'node_remote', daemonId: REMOTE_DAEMON, policy: { slots },
            nodeFacts: { schemaVersion: 1, reportedAt: Date.now(), providerEnablement: { 'claude-cli': { enabled: true, quotaEnabled: true } } },
        };
        const res = await resolve(components, node);
        expect(res.reason).toBeUndefined();
        expect(res.providerType).toBe('claude-cli');
        // The host neither detected the member's CLI locally nor wrote it into its own cache.
        expect(detectCliMocks.calls).toEqual([]);
        expect(detectionWrites).toEqual([]);
    });

    it('a remote node with no reported enablement fails open — the forwarded launch decides', async () => {
        const { components } = hostComponents();
        const node = { id: 'node_remote', daemonId: REMOTE_DAEMON, policy: { slots } };
        const res = await resolve(components, node);
        expect(res.providerType).toBe('claude-cli');
    });

    it('a remote node that itself reports the provider disabled is refused on ITS verdict', async () => {
        const { components } = hostComponents();
        const node = {
            id: 'node_remote', daemonId: REMOTE_DAEMON, policy: { slots },
            nodeFacts: { schemaVersion: 1, reportedAt: Date.now(), providerEnablement: { 'claude-cli': { enabled: false, quotaEnabled: true } } },
        };
        const res = await resolve(components, node);
        expect(res.providerType).toBeUndefined();
        expect(res.reason).toBe('provider_priority_unusable: claude-cli: disabled on node');
    });

    it('a remote worktree clone with no bundle of its own reads its source node report', async () => {
        const { components } = hostComponents();
        const source = {
            id: 'node_remote', daemonId: REMOTE_DAEMON, policy: { slots },
            nodeFacts: { schemaVersion: 1, reportedAt: Date.now(), providerEnablement: { 'claude-cli': { enabled: false, quotaEnabled: true } } },
        };
        const clone = { id: 'node_remote_wt', daemonId: REMOTE_DAEMON, clonedFromNodeId: 'node_remote', policy: { slots } };
        const res = await resolve(components, clone, [source, clone]);
        expect(res.reason).toBe('provider_priority_unusable: claude-cli: disabled on node');
    });

    it('a LOCAL node still uses the local enablement check', async () => {
        const { components } = hostComponents();
        detectCliMocks.detected.add('claude-cli');
        const node = { id: 'node_local', policy: { slots } };
        const res = await resolve(components, node);
        expect(res.reason).toBe('provider_priority_unusable: claude-cli: disabled');
    });

    it('a LOCAL node still uses local detection and records it in the host cache', async () => {
        const { components, detectionWrites } = hostComponents();
        components.providerLoader.isMachineProviderEnabled = () => true;
        const node = { id: 'node_local', daemonId: 'mach_host000000000001', policy: { slots } };
        const missing = await resolve(components, node);
        expect(missing.reason).toBe('provider_priority_unusable: claude-cli: not detected');
        detectCliMocks.detected.add('claude-cli');
        const ok = await resolve(components, node);
        expect(ok.providerType).toBe('claude-cli');
        expect(detectCliMocks.calls).toEqual(['claude-cli', 'claude-cli']);
        expect(detectionWrites.map(w => w.installed)).toEqual([false, true]);
    });
});
