/**
 * A node with no providerPriority and no capability slots defaults to the
 * providers it reports enabled, instead of being skipped with
 * `missing_provider_priority`.
 *
 * Live (2026-10-08/09, standalone multi-machine + cloud): both runs stalled on
 * `skipped: missing_provider_priority` although the node's own facts bundle said
 * exactly which CLI providers were enabled; the operator had to run
 * `update_mesh_node providerPriority` by hand.
 *
 * Pinned:
 *   - remote node: `nodeFacts.providerEnablement` (enabled only), narrowed to the
 *     detected CLIs when the node reports detection (`providerVersions`), in the
 *     stable built-in order;
 *   - local node without facts: this machine's enabled CLI providers;
 *   - explicit `providerPriority` / `slots` still win;
 *   - `missing_provider_priority` remains when nothing usable is known;
 *   - the difficulty-aware selection still runs over the defaulted slots.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-default-provider-priority-${randomUUID().slice(0, 8)}`);
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
}));

import { __resolveUsableProviderForTests } from '../../src/mesh/mesh-queue-assignment.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { defaultProviderPriorityForNode, resolveNodeCapabilitySlots } from '../../src/mesh/mesh-node-slots.js';
import { installLocalNodeProviderFallback } from '../../src/mesh/mesh-slot-provider-usability.js';

const MESH_ID = 'mesh_default_provider_priority';
const REMOTE_DAEMON = 'mach_member00000000002';

function components(localEnabled: string[] = []) {
    return {
        providerLoader: {
            resolveAlias: (t: string) => t,
            isMachineProviderEnabled: (t: string) => localEnabled.includes(t),
            setCliDetectionResults: () => {},
            getCliDetectionList: () => localEnabled.map((id) => ({ id, displayName: id, icon: '', command: id, category: 'cli', enabled: true })),
        },
    } as any;
}

function resolve(comps: any, node: any, difficulty = 'freeform') {
    return __resolveUsableProviderForTests(
        comps, node.id, node, MESH_ID, undefined,
        { difficulty, requiredTags: undefined } as any, null,
        { nodes: [node] }, 'task_1',
    );
}

function facts(enablement: Record<string, boolean>, providerVersions?: Record<string, string>) {
    return {
        schemaVersion: 1,
        reportedAt: Date.now(),
        providerEnablement: Object.fromEntries(Object.entries(enablement).map(([k, enabled]) => [k, { enabled, quotaEnabled: true }])),
        ...(providerVersions ? { providerVersions } : {}),
    };
}

beforeEach(() => { detectCliMocks.detected.clear(); });
afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('default provider priority from what the node reports', () => {
    it('a remote node with no priority launches its enabled provider (built-in order), not missing_provider_priority', async () => {
        const node = { id: 'node_remote', daemonId: REMOTE_DAEMON, policy: {}, nodeFacts: facts({ kimi: true, 'codex-cli': true, 'claude-cli': true, 'cursor-cli': false }) };
        expect(defaultProviderPriorityForNode(node)).toEqual(['claude-cli', 'codex-cli', 'kimi']);
        const res = await resolve(components(), node);
        expect(res.reason).toBeUndefined();
        expect(res.providerType).toBe('claude-cli');
    });

    it('narrows to the CLIs the node reports detected', async () => {
        const node = { id: 'node_remote', daemonId: REMOTE_DAEMON, policy: {}, nodeFacts: facts({ 'claude-cli': true, 'codex-cli': true }, { 'codex-cli': '0.50.0' }) };
        expect(defaultProviderPriorityForNode(node)).toEqual(['codex-cli']);
        const res = await resolve(components(), node);
        expect(res.providerType).toBe('codex-cli');
    });

    it('a local node without facts uses this machine\'s enabled CLI providers (boot-installed fallback), for every slot consumer', async () => {
        detectCliMocks.detected.add('claude-cli');
        const comps = components(['kimi', 'claude-cli']);
        const node = { id: 'node_local', daemonId: 'mach_host000000000001', policy: {} };
        const off = installLocalNodeProviderFallback(comps.providerLoader);
        try {
            expect(resolveNodeCapabilitySlots(node, MESH_ID).map((s) => s.provider)).toEqual(['claude-cli', 'kimi']);
            // A remote node is not given this machine's providers.
            expect(resolveNodeCapabilitySlots({ id: 'r', daemonId: REMOTE_DAEMON, policy: {} }, MESH_ID)).toEqual([]);
            const res = await resolve(comps, node);
            expect(res.reason).toBeUndefined();
            expect(res.providerType).toBe('claude-cli');
        } finally {
            off();
        }
        expect(resolveNodeCapabilitySlots(node, MESH_ID)).toEqual([]);
    });

    it('explicit providerPriority and explicit slots still win over the reported default', () => {
        const nodeFacts = facts({ 'claude-cli': true, 'codex-cli': true });
        expect(resolveNodeCapabilitySlots({ policy: { providerPriority: ['codex-cli'] }, nodeFacts }, MESH_ID).map((s) => s.provider)).toEqual(['codex-cli']);
        expect(resolveNodeCapabilitySlots({ policy: { slots: [{ provider: 'kimi' }] }, nodeFacts }, MESH_ID).map((s) => s.provider)).toEqual(['kimi']);
        expect(resolveNodeCapabilitySlots({ policy: {}, nodeFacts }, MESH_ID).map((s) => s.provider)).toEqual(['claude-cli', 'codex-cli']);
    });

    it('keeps missing_provider_priority when nothing usable is known', async () => {
        const remoteNoFacts = { id: 'node_remote', daemonId: REMOTE_DAEMON, policy: {} };
        expect((await resolve(components(), remoteNoFacts)).reason).toBe('missing_provider_priority');
        const allDisabled = { id: 'node_remote', daemonId: REMOTE_DAEMON, policy: {}, nodeFacts: facts({ 'claude-cli': false }) };
        expect((await resolve(components(), allDisabled)).reason).toBe('missing_provider_priority');
        const localNothingEnabled = { id: 'node_local', daemonId: 'mach_host000000000001', policy: {} };
        const comps = components([]);
        const off = installLocalNodeProviderFallback(comps.providerLoader);
        try {
            expect((await resolve(comps, localNothingEnabled)).reason).toBe('missing_provider_priority');
        } finally {
            off();
        }
    });

    it('difficulty-aware selection still runs over the defaulted slots', async () => {
        const node = { id: 'node_remote', daemonId: REMOTE_DAEMON, policy: {}, nodeFacts: facts({ 'claude-cli': true, 'codex-cli': true }) };
        for (const difficulty of ['easy', 'medium', 'difficult', 'freeform']) {
            const res = await resolve(components(), node, difficulty);
            expect(res.reason, difficulty).toBeUndefined();
            expect(['claude-cli', 'codex-cli']).toContain(res.providerType);
        }
    });
});
