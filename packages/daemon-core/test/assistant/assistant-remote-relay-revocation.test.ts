/** Follower side: only an explicit host_revoked persists a revocation; stale non-explicit ones self-heal. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { followedRemoteProjectKey } from '@adhdev/mesh-shared';
import {
    AssistantRemoteRelayPoller, REVOCATION_REFUSAL_CODES, isSelfHealableRevocationReason,
} from '../../src/assistant/assistant-remote-relay.js';
import type { RemoteCallOutcome, RemoteHostView } from '../../src/assistant/assistant-remote-host.js';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { wireAssistantRuntime } from '../../src/assistant/assistant-runtime.js';
import { setAssistantProjectPortsForTests, type AssistantProjectPorts } from '../../src/assistant/assistant-project-ports.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';

const MESH = 'mesh_x';
const HOST_1 = 'daemon_mach_h';
const KEY_1 = followedRemoteProjectKey(HOST_1, MESH);
const target: RemoteHostView = { label: 'host', hostDaemonId: HOST_1, hostMeshId: MESH, reachable: true };

function make(out: RemoteCallOutcome, extra: Record<string, unknown> = {}) {
    const onAccessRevoked = vi.fn();
    const onAccessRefused = vi.fn();
    const closeThread = vi.fn();
    const poller = new AssistantRemoteRelayPoller({
        openThreads: () => [{ meshId: MESH, lastSendAt: 0 }],
        remoteTarget: () => target,
        poll: async () => out,
        relay: { onRemoteCommitted: vi.fn(), observeRemote: vi.fn(), remoteUnreachable: vi.fn(), closeThread } as any,
        onAccessRevoked, onAccessRefused,
        ...extra,
    } as any);
    return { poller, onAccessRevoked, onAccessRefused, closeThread };
}
const refused = (code: string): RemoteCallOutcome => ({ ok: false, kind: 'refused', code, error: `${code} err` });

describe('follower revocation policy', () => {
    for (const code of ['remote_access_denied', 'binding_revision_mismatch', 'binding_revision_stale', 'grant_revision_stale', 'host_unavailable_transient', 'mesh_sender_not_on_roster', 'local_owner_binding_unreadable']) {
        it(`${code} keeps the follow active: lastError recorded, no revocation`, async () => {
            const h = make(refused(code));
            await h.poller.tick();
            expect(h.onAccessRevoked).not.toHaveBeenCalled();
            expect(h.closeThread).not.toHaveBeenCalled();
            expect(h.onAccessRefused).toHaveBeenCalledWith(MESH, code, `${code} err`);
        });
    }
    it('an explicit host_revoked still revokes', async () => {
        const h = make(refused('host_revoked'));
        await h.poller.tick();
        expect(h.onAccessRevoked).toHaveBeenCalledWith(MESH, 'host_revoked', 'host_revoked err');
        expect(REVOCATION_REFUSAL_CODES.has('remote_access_denied')).toBe(false);
    });
});

describe('self-heal of a stale non-explicit revocation', () => {
    it('restores on a successful poll keyed by canonical hostDaemonId::meshId, never for host_revoked', async () => {
        expect(isSelfHealableRevocationReason('remote_access_denied')).toBe(true);
        expect(isSelfHealableRevocationReason('host_revoked')).toBe(false);
        const onAccessRecovered = vi.fn();
        const h = make(
            { ok: true, result: { success: true } } as any,
            { openThreads: () => [], staleRevoked: () => [{ key: KEY_1, meshId: MESH, target }], onAccessRecovered },
        );
        await h.poller.tick();
        expect(onAccessRecovered).toHaveBeenCalledWith(KEY_1);
    });
    it('stays revoked (and backs off) while the host refuses with a transient non-explicit code', async () => {
        const onAccessRecovered = vi.fn();
        const h = make(refused('remote_access_denied'), { openThreads: () => [], staleRevoked: () => [{ key: KEY_1, meshId: MESH, target }], onAccessRecovered });
        await h.poller.tick();
        expect(onAccessRecovered).not.toHaveBeenCalled();
        expect(h.onAccessRevoked).not.toHaveBeenCalled();
    });

    it('transitions to host_revoked and stops probing when a healStaleRevoked probe fails with an explicit revocation code', async () => {
        const onAccessRecovered = vi.fn();
        let reason = 'remote_access_denied';
        const onAccessRevoked = vi.fn((_key: string, code: string) => {
            reason = code;
        });
        const poll = vi.fn(async () => refused('host_revoked'));
        const h = make(refused('host_revoked'), {
            openThreads: () => [],
            poll,
            staleRevoked: () => (isSelfHealableRevocationReason(reason) ? [{ key: KEY_1, meshId: MESH, target }] : []),
            onAccessRecovered,
            onAccessRevoked,
        });
        await h.poller.tick();
        expect(onAccessRecovered).not.toHaveBeenCalled();
        expect(onAccessRevoked).toHaveBeenCalledWith(KEY_1, 'host_revoked', 'host_revoked err');
        expect(reason).toBe('host_revoked');
        expect(poll).toHaveBeenCalledTimes(1);

        // Subsequent tick does not probe again because the entry transitioned to host_revoked
        await h.poller.tick();
        expect(poll).toHaveBeenCalledTimes(1);
    });

    it('cross-host same-meshId: keys healAt and recovery by canonical entry.key (hostDaemonId::meshId), never bare meshId', async () => {
        const hostA = 'daemon_mach_host_a';
        const hostB = 'daemon_mach_host_b';
        const keyA = followedRemoteProjectKey(hostA, MESH);
        const keyB = followedRemoteProjectKey(hostB, MESH);
        const targetA: RemoteHostView = { label: 'hostA', hostDaemonId: hostA, hostMeshId: MESH, reachable: true };
        const targetB: RemoteHostView = { label: 'hostB', hostDaemonId: hostB, hostMeshId: MESH, reachable: true };
        const onAccessRecovered = vi.fn();
        const poll = vi.fn(async (t: RemoteHostView) => {
            if (t.hostDaemonId === hostA) return refused('remote_access_denied');
            return { ok: true, result: { success: true, cursor: 'c-b', coordinatorSessionId: 'coord-b' } } as RemoteCallOutcome;
        });
        const poller = new AssistantRemoteRelayPoller({
            openThreads: () => [],
            remoteTarget: () => null,
            poll,
            staleRevoked: () => [
                { key: keyA, meshId: MESH, target: targetA },
                { key: keyB, meshId: MESH, target: targetB },
            ],
            onAccessRecovered,
            relay: { onRemoteCommitted: vi.fn(), observeRemote: vi.fn(), remoteUnreachable: vi.fn() } as any,
        });
        await poller.tick();
        // Host A failed first and entered healAt backoff, but Host B shares meshId and MUST still be probed and recovered by keyB!
        expect(poll).toHaveBeenCalledTimes(2);
        expect(onAccessRecovered).toHaveBeenCalledTimes(1);
        expect(onAccessRecovered).toHaveBeenCalledWith(keyB);
    });

    it('wireAssistantRuntime self-heal: reopens relay thread, restores cursor + noteSent, and recovers only the matching hostDaemonId::meshId entry', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'asst-heal-rt-'));
        const bus = createSessionLifecycleBus();
        let runtime: ReturnType<typeof wireAssistantRuntime> | null = null;
        try {
            const registry = new AssistantRegistry({ configDir: dir });
            setAssistantRegistryForTests(registry);
            setAssistantServicesForTests(createAssistantServices({ configDir: dir, listMeshes: () => [] }));
            registry.reconcileOwnerBinding('daemon_mach_follower1');

            const hostA = 'daemon_mach_host_a';
            const hostB = 'daemon_mach_host_b';
            const keyA = followedRemoteProjectKey(hostA, MESH);
            const keyB = followedRemoteProjectKey(hostB, MESH);

            registry.upsertFollowedRemoteProject({
                hostDaemonId: hostA,
                meshId: MESH,
                name: 'SharedA',
                slug: 'shared-a',
                sanitizedRepoIdentity: null,
                bindingRevision: 1,
                grantRevision: 1,
                state: 'revoked',
                revokedAt: 100,
                revokedReason: 'remote_access_denied',
                lastErrorCode: 'remote_access_denied',
                lastCursor: 'cur-a',
                coordinatorSessionId: 'coord-a',
            });
            registry.upsertFollowedRemoteProject({
                hostDaemonId: hostB,
                meshId: MESH,
                name: 'SharedB',
                slug: 'shared-b',
                sanitizedRepoIdentity: null,
                bindingRevision: 1,
                grantRevision: 1,
                state: 'revoked',
                revokedAt: 100,
                revokedReason: 'remote_access_denied',
                lastErrorCode: 'remote_access_denied',
                lastCursor: 'cur-b',
                coordinatorSessionId: 'coord-b',
            });

            const pollArgsSeen: Array<{ hostDaemonId: string | null; args: Record<string, unknown> }> = [];
            setAssistantProjectPortsForTests(() => ({
                selfDaemonId: () => 'daemon_mach_follower1',
                listMeshes: () => [],
                isHostedHere: () => false,
                aliases: () => ({}),
                coordinators: () => [],
                lastCoordinatorSessionId: () => null,
                queueCounts: () => null,
                activeMissionCount: () => null,
                pendingApprovals: () => 0,
                relay: {},
                execute: vi.fn(async () => ({ success: true })) as any,
                remoteHost: () => ({ label: 'none', hostDaemonId: null, hostMeshId: MESH, reachable: false }),
                followedRemoteProjects: () => registry.listFollowedRemoteProjects(),
                followedRemoteHost: (entry) => ({
                    label: entry.name,
                    hostDaemonId: entry.hostDaemonId,
                    hostMeshId: entry.meshId,
                    reachable: true,
                    followerAccess: {
                        accountSlot: entry.accountSlot,
                        bindingRevision: entry.bindingRevision,
                        grantRevision: entry.grantRevision,
                        followedKey: entry.key,
                    },
                }),
                callHost: async (t, _op, args) => {
                    pollArgsSeen.push({ hostDaemonId: t.hostDaemonId, args });
                    if (t.hostDaemonId === hostA) return refused('remote_access_denied');
                    return {
                        ok: true,
                        result: {
                            success: true,
                            coordinator: 'idle',
                            coordinatorSessionId: 'coord-b',
                            open: false,
                            modal: false,
                            commits: [],
                            cursor: 'cur-b',
                            cursorFound: true,
                        },
                    };
                },
                coordinatorTurns: () => ({ open: false, committed: [] }),
                meshStatusLine: () => null,
                routePreview: async () => null,
            }) as unknown as AssistantProjectPorts);

            const store = new InMemoryAssistantRelayStore();
            // Thread was closed when the follow was previously marked revoked
            expect(store.isThreadOpen(MESH)).toBe(false);

            runtime = wireAssistantRuntime({
                bus,
                cliManager: { input: { submit: vi.fn(async () => ({ kind: 'delivered' })) } } as any,
                instanceManager: { getInstance: () => null } as any,
                router: { execute: vi.fn(async () => ({ success: true })) } as any,
                statusInstanceId: 'daemon_mach_follower1',
            } as any, { registry, store, metrics: null });

            // First tick: probes stale-revoked entries; hostA fails, hostB succeeds -> recovers keyB AND reopens thread with cursor 'cur-b'
            await runtime.remotePoller.tick();

            expect(registry.getFollowedRemoteProject(keyA)?.state).toBe('revoked');
            expect(registry.getFollowedRemoteProject(keyB)?.state).toBe('followed');
            expect(registry.getFollowedRemoteProject(keyB)?.revokedReason).toBeUndefined();
            expect(registry.getFollowedRemoteProject(keyB)?.lastErrorCode).toBeUndefined();

            // Thread must be reopened with cursor 'cur-b' and coordinatorSessionId 'coord-b' restored
            expect(store.isThreadOpen(MESH)).toBe(true);
            const openRow = store.openThreads().find((t) => t.meshId === MESH);
            expect(openRow?.lastCursor).toBe('cur-b');
            expect(openRow?.coordinatorSessionId).toBe('coord-b');

            // Second tick: background polling resumes on the reopened thread using the restored cursor 'cur-b'
            pollArgsSeen.length = 0;
            await runtime.remotePoller.tick();
            expect(pollArgsSeen.some((p) => p.hostDaemonId === hostB && p.args.afterAttemptId === 'cur-b')).toBe(true);
        } finally {
            runtime?.dispose();
            setAssistantProjectPortsForTests(null);
            setAssistantServicesForTests(null);
            setAssistantRegistryForTests(null);
            bus.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
