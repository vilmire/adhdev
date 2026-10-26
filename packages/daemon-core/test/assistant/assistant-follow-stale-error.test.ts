/** rc34 807f3502 R-A1: a healthy follow must not keep showing an earlier access refusal. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { followedRemoteProjectKey } from '@adhdev/mesh-shared';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { wireAssistantRuntime } from '../../src/assistant/assistant-runtime.js';
import { setAssistantProjectPortsForTests, type AssistantProjectPorts } from '../../src/assistant/assistant-project-ports.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';

const MESH = 'mesh_follow';
const HOST = 'daemon_mach_host';
const KEY = followedRemoteProjectKey(HOST, MESH);
const okPoll = { ok: true, result: { success: true, coordinator: 'idle', coordinatorSessionId: 'coord-1', open: false, modal: false, commits: [], cursor: 'cur-1', cursorFound: true } };
const refused = { ok: false, kind: 'refused', code: 'remote_access_denied', error: 'denied' };

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

async function followWith(lastErrorCode: string, outcome: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'asst-follow-err-'));
    const bus = createSessionLifecycleBus();
    const registry = new AssistantRegistry({ configDir: dir });
    setAssistantRegistryForTests(registry);
    setAssistantServicesForTests(createAssistantServices({ configDir: dir, listMeshes: () => [] }));
    registry.reconcileOwnerBinding('daemon_mach_follower');
    registry.upsertFollowedRemoteProject({
        hostDaemonId: HOST, meshId: MESH, name: 'P', slug: 'p', sanitizedRepoIdentity: null,
        bindingRevision: 1, grantRevision: 1, state: 'followed', lastErrorCode, lastCursor: 'cur-0', coordinatorSessionId: 'coord-1',
    });
    setAssistantProjectPortsForTests(() => ({
        selfDaemonId: () => 'daemon_mach_follower', listMeshes: () => [], isHostedHere: () => false, aliases: () => ({}),
        coordinators: () => [], lastCoordinatorSessionId: () => null, queueCounts: () => null, activeMissionCount: () => null,
        pendingApprovals: () => 0, relay: {}, execute: vi.fn(async () => ({ success: true })) as any,
        remoteHost: () => ({ label: 'none', hostDaemonId: null, hostMeshId: MESH, reachable: false }),
        followedRemoteProjects: () => registry.listFollowedRemoteProjects(),
        followedRemoteHost: (entry) => ({ label: entry.name, hostDaemonId: entry.hostDaemonId, hostMeshId: entry.meshId, reachable: true,
            followerAccess: { accountSlot: entry.accountSlot, bindingRevision: entry.bindingRevision, grantRevision: entry.grantRevision, followedKey: entry.key } }),
        callHost: async () => outcome,
        coordinatorTurns: () => ({ open: false, committed: [] }), meshStatusLine: () => null, routePreview: async () => null,
    }) as unknown as AssistantProjectPorts);
    const store = new InMemoryAssistantRelayStore();
    store.openThread(MESH, Date.now() - 60_000);
    store.setThreadCursor(MESH, 'cur-0', 'coord-1');
    const runtime = wireAssistantRuntime({
        bus, cliManager: { input: { submit: vi.fn(async () => ({ kind: 'delivered' })) } } as any,
        instanceManager: { getInstance: () => null } as any, router: { execute: vi.fn(async () => ({ success: true })) } as any,
        statusInstanceId: 'daemon_mach_follower',
    } as any, { registry, store, metrics: null });
    cleanup = () => { runtime.dispose?.(); setAssistantProjectPortsForTests(null as any); setAssistantRegistryForTests(null as any); rmSync(dir, { recursive: true, force: true }); };
    await runtime.remotePoller.tick();
    return registry.getFollowedRemoteProject(KEY);
}

describe('followed remote project error state', () => {
    it('a successful poll clears an earlier access refusal on a healthy follow', async () => {
        const entry = await followWith('remote_access_denied', okPoll);
        expect(entry?.state).toBe('followed');
        expect(entry?.lastErrorCode).toBeUndefined();
    });

    it('keeps coordinator_replaced, which is cleared by its own acknowledgement', async () => {
        expect((await followWith('coordinator_replaced', okPoll))?.lastErrorCode).toBe('coordinator_replaced');
    });

    it('a refused poll still records the refusal without revoking', async () => {
        const entry = await followWith('remote_access_denied', refused);
        expect(entry?.state).toBe('followed');
        expect(entry?.lastErrorCode).toBe('remote_access_denied');
    });
});
