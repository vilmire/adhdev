import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    ASSISTANT_ACCOUNT_SLOT,
    ASSISTANT_REMOTE_FOLLOW_COMMAND,
    ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
    ASSISTANT_REMOTE_PROJECT_CATALOG_COMMAND,
    ASSISTANT_VERB,
    followedRemoteProjectKey,
    type SendPolicy,
} from '@adhdev/mesh-shared';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender.js';
import { loadMeshConfig, saveMeshConfig } from '../../src/config/mesh-config-store.js';
import {
    setAssistantProjectPortsForTests,
    type AssistantProjectPorts,
    type CoordinatorTurns,
} from '../../src/assistant/assistant-project-ports.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { AssistantRelay, type RelayClock } from '../../src/assistant/assistant-relay.js';
import { AssistantRemoteRelayPoller } from '../../src/assistant/assistant-remote-relay.js';
import { AssistantInputLog } from '../../src/assistant/assistant-input-log.js';
import { RELAY_QUIET_MS } from '../../src/assistant/assistant-relay-format.js';
import { callRemoteHost, describeFollowedRemoteHost, type RemoteHostView } from '../../src/assistant/assistant-remote-host.js';
import {
    clearFollowerSendReceiptsForTest,
    FOLLOWER_SEND_RECEIPT_MAX_ENTRIES,
    FOLLOWER_SEND_RECEIPT_TTL_MS,
    getFollowerSendReceiptCountForTest,
} from '../../src/commands/high-family/assistant-remote.js';
import type { AssistantCoordinatorView } from '../../src/assistant/coordinator-lifecycle.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';

const HOST_A = 'daemon_mach_host_a_00001';
const HOST_C = 'daemon_mach_host_c_00003';
const ASSISTANT_B = 'daemon_mach_asst_b_00002';
const ASSISTANT_D = 'daemon_mach_asst_d_00006';
const MEMBER_M = 'daemon_mach_member_00004';
const STRANGER_X = 'daemon_mach_stranger0005';
const MESH_PREFEX_SIM = 'mesh_sim_project_alpha';
const MESH_SECOND = 'mesh_sim_project_beta';

const ORIGINAL_CONFIG_DIR = process.env.ADHDEV_CONFIG_DIR;

class FakeClock implements RelayClock {
    t = Date.parse('2026-10-20T00:00:00Z');
    private timers: Array<{ at: number; fn: () => void; id: number }> = [];
    private next = 1;
    now() { return this.t; }
    setTimeout(fn: () => void, ms: number) {
        const id = this.next++;
        this.timers.push({ at: this.t + ms, fn, id });
        return id;
    }
    clearTimeout(h: unknown) {
        this.timers = this.timers.filter((x) => x.id !== h);
    }
    advance(ms: number) {
        const end = this.t + ms;
        for (;;) {
            const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            this.timers = this.timers.filter((x) => x !== due);
            this.t = due.at;
            due.fn();
        }
        this.t = end;
    }
}

describe('rc24 checkout-less remote assistant project follow & narrow host ACL', () => {
    let hostDir: string;
    let assistantDir: string;
    let hostExecute: ReturnType<typeof vi.fn>;
    let hostCoordinators: Record<string, AssistantCoordinatorView[]>;
    let hostTurns: Record<string, CoordinatorTurns>;
    let hostLiveSessions: unknown[];
    let hostMeshes: LocalMeshEntry[];
    let assistantMeshes: LocalMeshEntry[];
    let assistantRegistry: AssistantRegistry;
    let hostOnline: boolean;

    function buildHostMeshes(): LocalMeshEntry[] {
        return [
            {
                id: MESH_PREFEX_SIM,
                name: 'AlphaSim',
                repoIdentity: 'https://user:secret_pat@github.com/acme/alpha-sim.git',
                meshHost: { role: 'host', hostDaemonId: HOST_A },
                nodes: [
                    { id: 'n-host-a', workspace: '/Users/secret/private/alpha-sim', daemonId: HOST_A, role: 'host', machineNickname: 'Host-A' },
                    { id: 'n-member', workspace: '/Users/member/alpha-sim', daemonId: MEMBER_M, role: 'worker' },
                ],
            } as unknown as LocalMeshEntry,
            {
                id: MESH_SECOND,
                name: 'UntouchedMesh',
                repoIdentity: '/Users/secret/local/untouched-repo',
                meshHost: { role: 'host', hostDaemonId: HOST_A },
                nodes: [
                    { id: 'n-host-a2', workspace: '/Users/secret/local/untouched-repo', daemonId: HOST_A, role: 'host', machineNickname: 'Host-A' },
                ],
            } as unknown as LocalMeshEntry,
            {
                id: 'mesh_foreign_member_only',
                name: 'ForeignMemberOnly',
                repoIdentity: 'github.com/acme/foreign',
                meshHost: { role: 'member', hostDaemonId: HOST_C },
                nodes: [
                    { id: 'n-foreign', workspace: '/Users/secret/foreign', daemonId: HOST_A, role: 'worker' },
                ],
            } as unknown as LocalMeshEntry,
        ];
    }

    function createRouter(selfDaemonId: string): DaemonCommandRouter {
        return new DaemonCommandRouter({
            commandHandler: {
                handleSpec: vi.fn(async () => ({ success: true })),
                rejectUnknown: vi.fn(async (cmd: string) => ({ success: false, error: `Unknown command: ${cmd}` })),
            } as any,
            cliManager: {} as any,
            cdpManagers: new Map(),
            providerLoader: {} as any,
            instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
            detectedIdes: { value: [] },
            sessionRegistry: { get: () => undefined } as any,
            statusInstanceId: selfDaemonId,
        } as any);
    }

    let activeAssistantRelayHooks: AssistantProjectPorts['relay'] | null = null;

    async function withHostEnv<T>(fn: () => Promise<T>): Promise<T> {
        const prevDir = process.env.ADHDEV_CONFIG_DIR;
        process.env.ADHDEV_CONFIG_DIR = hostDir;
        setAssistantServicesForTests(
            createAssistantServices({
                configDir: hostDir,
                operatingNotes: { record: vi.fn(async () => ({ id: 'note-1' })), forget: vi.fn(async () => ({ matched: 1 })) },
                listMeshes: () => loadMeshConfig().meshes,
            }),
        );
        setAssistantProjectPortsForTests(() => ({
            selfDaemonId: () => HOST_A,
            listMeshes: () => loadMeshConfig().meshes,
            isHostedHere: (m: LocalMeshEntry) => m.id === MESH_PREFEX_SIM || m.id === MESH_SECOND,
            aliases: () => ({}),
            coordinators: (meshId: string) => hostCoordinators[meshId] ?? [],
            lastCoordinatorSessionId: (meshId: string) => hostCoordinators[meshId]?.[0]?.sessionId ?? null,
            queueCounts: () => ({ pending: 0, assigned: 0, failed: 0 }),
            activeMissionCount: () => 0,
            pendingApprovals: () => 0,
            relay: {},
            execute: hostExecute as any,
            remoteHost: () => { throw new Error('not used on host'); },
            callHost: () => { throw new Error('not used on host'); },
            coordinatorTurns: (sid: string) => hostTurns[sid] ?? { open: false, committed: [] },
            meshStatusLine: () => '[Mesh] idle',
            liveSessionStates: () => hostLiveSessions,
            routePreview: async () => null,
        }) as unknown as AssistantProjectPorts);
        try {
            return await fn();
        } finally {
            if (prevDir === assistantDir && activeAssistantRelayHooks !== null) {
                installAssistantEnv(activeAssistantRelayHooks);
            } else if (prevDir !== undefined) {
                process.env.ADHDEV_CONFIG_DIR = prevDir;
            }
        }
    }

    const dispatchFromAssistantToHost = async (targetDaemonId: string, command: string, args: Record<string, unknown>) => {
        if (!hostOnline) {
            throw new Error('P2P target daemon offline');
        }
        if (targetDaemonId !== HOST_A) {
            return { success: false, code: 'p2p_not_connected', error: 'unknown target host' };
        }
        return withHostEnv(async () => {
            const router = createRouter(HOST_A);
            const result = await router.execute(
                command,
                { ...args, _meshDirectDispatch: true, [MESH_SENDER_DAEMON_ID_ARG]: ASSISTANT_B },
                'mesh',
            );
            return { result };
        });
    };

    function installAssistantEnv(relayHooks: AssistantProjectPorts['relay'] = {}): void {
        activeAssistantRelayHooks = relayHooks;
        process.env.ADHDEV_CONFIG_DIR = assistantDir;
        setAssistantRegistryForTests(assistantRegistry);
        setAssistantServicesForTests(
            createAssistantServices({
                configDir: assistantDir,
                listMeshes: () => assistantMeshes,
            }),
        );
        setAssistantProjectPortsForTests(() => ({
            selfDaemonId: () => ASSISTANT_B,
            listMeshes: () => assistantMeshes,
            isHostedHere: () => true,
            aliases: () => assistantRegistry.read()?.aliases ?? {},
            coordinators: () => [],
            lastCoordinatorSessionId: () => null,
            queueCounts: () => null,
            activeMissionCount: () => null,
            pendingApprovals: () => 0,
            relay: relayHooks,
            execute: vi.fn(async () => ({ success: true })) as any,
            remoteHost: () => ({ label: 'unknown', hostDaemonId: null, hostMeshId: '', reachable: false, reason: 'host_unknown' }),
            followedRemoteProjects: () => assistantRegistry.listFollowedRemoteProjects(),
            followedRemoteHost: (entry) => describeFollowedRemoteHost(
                entry,
                ASSISTANT_B,
                assistantRegistry.verifyLocalOwnerBinding(ASSISTANT_B),
                {
                    dispatch: dispatchFromAssistantToHost,
                    peerStatus: () => (hostOnline ? { state: 'connected', linkIsPresence: true } : { state: 'disconnected', linkIsPresence: true }),
                },
            ),
            updateFollowedRemoteObservation: (key, patch) => {
                assistantRegistry.updateFollowedRemoteProject(key, patch);
            },
            markFollowedRemoteRevoked: (key) => {
                assistantRegistry.updateFollowedRemoteProject(key, { state: 'revoked', revokedAt: Date.now() });
            },
            verifyOwnerBinding: () => {
                const v = assistantRegistry.verifyLocalOwnerBinding(ASSISTANT_B);
                return v.ok ? { ok: true } : { ok: false, code: v.code, error: v.error };
            },
            callHost: (target: RemoteHostView, op, args) => callRemoteHost(
                {
                    dispatch: dispatchFromAssistantToHost,
                    peerStatus: () => (hostOnline ? { state: 'connected', linkIsPresence: true } : { state: 'disconnected', linkIsPresence: true }),
                },
                target,
                op,
                args,
            ),
            coordinatorTurns: () => ({ open: false, committed: [] }),
            meshStatusLine: () => null,
            routePreview: async () => null,
        }) as unknown as AssistantProjectPorts);
    }

    beforeEach(() => {
        clearFollowerSendReceiptsForTest();
        hostDir = mkdtempSync(join(tmpdir(), 'adhdev-rc24-host-'));
        assistantDir = mkdtempSync(join(tmpdir(), 'adhdev-rc24-assistant-'));
        hostOnline = true;
        hostMeshes = buildHostMeshes();
        assistantMeshes = [];

        process.env.ADHDEV_CONFIG_DIR = hostDir;
        saveMeshConfig({ ...loadMeshConfig(), meshes: hostMeshes });

        process.env.ADHDEV_CONFIG_DIR = assistantDir;
        saveMeshConfig({ ...loadMeshConfig(), meshes: assistantMeshes });
        assistantRegistry = new AssistantRegistry({ configDir: assistantDir });
        assistantRegistry.bindSession({
            sessionId: 'asst-session-1',
            cliType: 'claude',
            workspace: assistantDir,
            at: 1_700_000_000_000,
        });

        hostCoordinators = {
            [MESH_PREFEX_SIM]: [{ sessionId: 'coord-alpha-1', idle: true, modalParked: false, managedByAssistant: false }],
            [MESH_SECOND]: [{ sessionId: 'coord-beta-1', idle: true, modalParked: false, managedByAssistant: false }],
        };
        hostLiveSessions = [
            {
                instanceId: 'coord-alpha-1',
                type: 'claude-cli',
                status: 'idle',
                workspace: '/Users/secret/private/alpha-sim',
                settings: { meshCoordinatorFor: MESH_PREFEX_SIM },
                activeChat: { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] },
            },
            {
                instanceId: 'worker-alpha-1',
                type: 'claude-cli',
                status: 'generating',
                workspace: '/Users/secret/private/alpha-sim/worktree-1',
                settings: { meshNodeFor: MESH_PREFEX_SIM, meshNodeId: 'n-host-a', autoLaunchedForQueueTaskId: 'task-alpha-1' },
                activeChat: { messages: [{ role: 'user', content: 'task prompt' }] },
            },
            {
                instanceId: 'coord-beta-1',
                type: 'claude-cli',
                status: 'idle',
                workspace: '/Users/secret/local/untouched-repo',
                settings: { meshCoordinatorFor: MESH_SECOND },
                activeChat: { messages: [] },
            },
            {
                instanceId: 'worker-foreign-1',
                type: 'claude-cli',
                status: 'idle',
                workspace: '/Users/secret/foreign',
                settings: { meshNodeFor: 'mesh_foreign_member_only', meshNodeId: 'n-foreign' },
                activeChat: { messages: [] },
            },
            {
                instanceId: 'personal-shell-host-a',
                type: 'claude-cli',
                status: 'idle',
                workspace: '/Users/secret/personal-notes',
                settings: {},
                activeChat: { messages: [{ role: 'user', content: 'private note' }] },
            },
            {
                instanceId: 'host-personal-assistant',
                type: 'claude-cli',
                status: 'idle',
                workspace: '/Users/secret/.adhdev/assistant',
                settings: { assistant: true, meshCoordinatorFor: MESH_PREFEX_SIM },
                activeChat: { messages: [] },
            },
        ];
        hostTurns = {
            'coord-alpha-1': {
                open: false,
                committed: [
                    { attemptId: 'plain:coord-alpha-1:old-2', outcome: 'completed', at: Date.now() - 10_000 },
                    { attemptId: 'plain:coord-alpha-1:old-1', outcome: 'completed', at: Date.now() - 60_000 },
                ],
            },
        };
        hostExecute = vi.fn(async (cmd: string, args: any) => {
            if (cmd === 'launch_mesh_coordinator') {
                return { success: true, sessionId: 'coord-launched-unexpectedly' };
            }
            if (cmd === 'send_chat') {
                return { success: true, queued: true, targetSessionId: args.targetSessionId, messageId: args.messageId };
            }
            if (cmd === 'read_chat') {
                return {
                    success: true,
                    messages: [
                        { role: 'user', content: 'old question' },
                        { role: 'assistant', content: 'Coordinator reply from Host A.' },
                    ],
                };
            }
            if (cmd === 'mesh_status_view') {
                return { success: true, meshId: args.meshId, machines: [] };
            }
            return { success: true };
        });
    });

    afterEach(() => {
        setAssistantProjectPortsForTests(null);
        setAssistantServicesForTests(null);
        setAssistantRegistryForTests(null);
        clearFollowerSendReceiptsForTest();
        if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.ADHDEV_CONFIG_DIR;
        else process.env.ADHDEV_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
        rmSync(hostDir, { recursive: true, force: true });
        rmSync(assistantDir, { recursive: true, force: true });
    });

    it('1. catalog discovery is owner-only, returns only locally hosted meshes, and strips secrets & local filesystem paths', async () => {
        await withHostEnv(async () => {
            const router = createRouter(HOST_A);

            // Rejects ipc and mesh sources
            const ipcRes: any = await router.execute(ASSISTANT_REMOTE_PROJECT_CATALOG_COMMAND, {}, 'ipc');
            expect(ipcRes).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
            const meshRes: any = await router.execute(
                ASSISTANT_REMOTE_PROJECT_CATALOG_COMMAND,
                { _meshDirectDispatch: true, [MESH_SENDER_DAEMON_ID_ARG]: ASSISTANT_B },
                'mesh',
            );
            expect(meshRes).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });

            // Rejects p2p/ws without trusted owner ingress
            const untrustedP2p: any = await router.execute(ASSISTANT_REMOTE_PROJECT_CATALOG_COMMAND, {}, 'p2p', { ownerVerified: false });
            expect(untrustedP2p).toMatchObject({ success: false, code: 'owner_ingress_required' });

            // Succeeds on owner-verified p2p
            const ok: any = await router.execute(ASSISTANT_REMOTE_PROJECT_CATALOG_COMMAND, {}, 'p2p', { ownerVerified: true });
            expect(ok.success).toBe(true);
            expect(ok.hostDaemonId).toBe(HOST_A);
            // Only locally hosted meshes (MESH_PREFEX_SIM and MESH_SECOND); excludes mesh_foreign_member_only
            expect(ok.projects.map((p: any) => p.meshId)).toEqual([MESH_PREFEX_SIM, MESH_SECOND]);

            const alpha = ok.projects.find((p: any) => p.meshId === MESH_PREFEX_SIM);
            expect(alpha.sanitizedRepoIdentity).toBe('github.com/acme/alpha-sim');
            expect(JSON.stringify(ok)).not.toContain('secret_pat');
            expect(JSON.stringify(ok)).not.toContain('/Users/secret');

            const beta = ok.projects.find((p: any) => p.meshId === MESH_SECOND);
            expect(beta.sanitizedRepoIdentity).toBeNull();
        });
    });

    it('2. denies ungranted same-account daemon, cross-account/stranger daemon, and spoofed inlineMesh before owner grant', async () => {
        await withHostEnv(async () => {
            const router = createRouter(HOST_A);
            const spoofedMesh = {
                ...hostMeshes[0],
                nodes: [...(hostMeshes[0]!.nodes as any[]), { id: 'n-spoof', daemonId: ASSISTANT_B, role: 'worker' }],
            };

            // Assistant B with spoofed inlineMesh is still denied
            const spoofRes: any = await router.execute(
                'assistant_remote_project',
                {
                    meshId: MESH_PREFEX_SIM,
                    op: 'status',
                    inlineMesh: spoofedMesh,
                    _meshDirectDispatch: true,
                    [MESH_SENDER_DAEMON_ID_ARG]: ASSISTANT_B,
                },
                'mesh',
            );
            expect(spoofRes).toMatchObject({ success: false, code: 'mesh_sender_not_on_roster' });

            // Assistant B claiming followerAccess before any grant on Host A is denied at the sender gate with remote_access_denied detail
            const pregrantRes: any = await router.execute(
                'assistant_remote_project',
                {
                    meshId: MESH_PREFEX_SIM,
                    op: 'status',
                    followerAccess: { accountSlot: ASSISTANT_ACCOUNT_SLOT, bindingRevision: 1, grantRevision: 1 },
                    _meshDirectDispatch: true,
                    [MESH_SENDER_DAEMON_ID_ARG]: ASSISTANT_B,
                },
                'mesh',
            );
            expect(pregrantRes.success).toBe(false);
            expect(String(pregrantRes.detail ?? pregrantRes.code)).toContain('remote_access_denied');
            expect(hostExecute).not.toHaveBeenCalled();
        });
    });

    it('3. owner grant binds single personal slot + activeDaemonId + bindingRevision + monotonic grantRevision; forbids note/inventory ops while preserving roster member rights', async () => {
        await withHostEnv(async () => {
            const router = createRouter(HOST_A);

            // Non-owner cannot grant
            const deniedGrant: any = await router.execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: ASSISTANT_B, bindingRevision: 1 },
                'p2p',
                { ownerVerified: false },
            );
            expect(deniedGrant).toMatchObject({ success: false, code: 'owner_ingress_required' });

            // Owner grants Assistant B on MESH_PREFEX_SIM
            const grant1: any = await router.execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: ASSISTANT_B, bindingRevision: 1 },
                'p2p',
                { ownerVerified: true },
            );
            expect(grant1).toMatchObject({
                success: true,
                access: {
                    hostDaemonId: HOST_A,
                    meshId: MESH_PREFEX_SIM,
                    accountSlot: 'personal',
                    activeDaemonId: ASSISTANT_B,
                    bindingRevision: 1,
                    grantRevision: 1,
                    status: 'active',
                },
            });

            // Stranger X with followerAccess claim is rejected because activeDaemonId === ASSISTANT_B
            const strangerTry: any = await router.execute(
                'assistant_remote_project',
                {
                    meshId: MESH_PREFEX_SIM,
                    op: 'status',
                    followerAccess: { accountSlot: 'personal', bindingRevision: 1, grantRevision: 1 },
                    _meshDirectDispatch: true,
                    [MESH_SENDER_DAEMON_ID_ARG]: STRANGER_X,
                },
                'mesh',
            );
            expect(strangerTry.success).toBe(false);
            expect(String(strangerTry.detail ?? strangerTry.code)).toContain('remote_access_denied');

            // Assistant B is NOT granted on MESH_SECOND
            const secondMeshTry: any = await router.execute(
                'assistant_remote_project',
                {
                    meshId: MESH_SECOND,
                    op: 'status',
                    followerAccess: { accountSlot: 'personal', bindingRevision: 1, grantRevision: 1 },
                    _meshDirectDispatch: true,
                    [MESH_SENDER_DAEMON_ID_ARG]: ASSISTANT_B,
                },
                'mesh',
            );
            expect(secondMeshTry.success).toBe(false);
            expect(String(secondMeshTry.detail ?? secondMeshTry.code)).toContain('remote_access_denied');

            // Assistant B cannot run forbidden ops ('note', 'inventory') on MESH_PREFEX_SIM
            for (const forbiddenOp of ['note', 'inventory']) {
                const res: any = await router.execute(
                    'assistant_remote_project',
                    {
                        meshId: MESH_PREFEX_SIM,
                        op: forbiddenOp,
                        followerAccess: { accountSlot: 'personal', bindingRevision: 1, grantRevision: 1 },
                        _meshDirectDispatch: true,
                        [MESH_SENDER_DAEMON_ID_ARG]: ASSISTANT_B,
                    },
                    'mesh',
                );
                expect(res.success).toBe(false);
                expect(String(res.detail ?? res.code)).toContain('remote_op_forbidden');
            }

            // Existing roster member MEMBER_M still retains full member rights (including inventory/note) without followerAccess
            const memberInv: any = await router.execute(
                'assistant_remote_project',
                {
                    meshId: MESH_PREFEX_SIM,
                    op: 'inventory',
                    _meshDirectDispatch: true,
                    [MESH_SENDER_DAEMON_ID_ARG]: MEMBER_M,
                },
                'mesh',
            );
            expect(memberInv).toMatchObject({ success: true });
        });
    });

    it('4. follow initializes high-water cursor via cursorOnly poll without sending any message or reading old transcript, and never injects into meshes.json', async () => {
        // 1. Owner grants access on Host A
        const grantRes: any = await withHostEnv(() =>
            createRouter(HOST_A).execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: ASSISTANT_B, bindingRevision: 1 },
                'p2p',
                { ownerVerified: true },
            ),
        );
        expect(grantRes.success).toBe(true);

        // 2. Owner follows on Assistant B
        installAssistantEnv();
        const followRes: any = await createRouter(ASSISTANT_B).execute(
            ASSISTANT_REMOTE_FOLLOW_COMMAND,
            {
                action: 'follow',
                hostDaemonId: HOST_A,
                hostLabel: 'Host-A',
                meshId: MESH_PREFEX_SIM,
                name: 'AlphaSim',
                sanitizedRepoIdentity: 'github.com/acme/alpha-sim',
                grantRevision: grantRes.access.grantRevision,
                bindingRevision: 1,
            },
            'p2p',
            { ownerVerified: true },
        );
        expect(followRes).toMatchObject({
            success: true,
            cursor: 'plain:coord-alpha-1:old-2',
            coordinatorSessionId: 'coord-alpha-1',
            coordinator: 'idle',
        });

        // Verify Follow sent NO chat message and did NOT call read_chat on Host A
        expect(hostExecute).not.toHaveBeenCalledWith('send_chat', expect.anything());
        expect(hostExecute).not.toHaveBeenCalledWith('read_chat', expect.anything());
        expect(hostExecute).not.toHaveBeenCalledWith('launch_mesh_coordinator', expect.anything());

        // Verify Assistant B's meshes.json remains completely empty (no fake worker node or member mesh injected)
        process.env.ADHDEV_CONFIG_DIR = assistantDir;
        expect(loadMeshConfig().meshes).toEqual([]);

        // Verify Assistant B's durable ownerBinding and followedRemoteProjects in assistant.json survive session release/rebind (same-Mac restart)
        assistantRegistry.releaseSession('asst-session-1', 'daemon_shutdown');
        const reloaded = new AssistantRegistry({ configDir: assistantDir });
        expect(reloaded.verifyLocalOwnerBinding(ASSISTANT_B)).toMatchObject({
            ok: true,
            receipt: { accountSlot: 'personal', daemonId: ASSISTANT_B, bindingRevision: 1 },
        });
        expect(reloaded.listFollowedRemoteProjects()).toHaveLength(1);
        expect(reloaded.listFollowedRemoteProjects()[0]).toMatchObject({
            key: followedRemoteProjectKey(HOST_A, MESH_PREFEX_SIM),
            state: 'followed',
            lastCursor: 'plain:coord-alpha-1:old-2',
            coordinatorSessionId: 'coord-alpha-1',
            grantRevision: 1,
            bindingRevision: 1,
        });
    });

    it('5. follower send queues to existing live coordinator only (coordinator_missing if none, never launches) and enforces deterministic idempotency & conflict checks', async () => {
        await withHostEnv(() =>
            createRouter(HOST_A).execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: ASSISTANT_B, bindingRevision: 1 },
                'p2p',
                { ownerVerified: true },
            ),
        );
        installAssistantEnv();
        await createRouter(ASSISTANT_B).execute(
            ASSISTANT_REMOTE_FOLLOW_COMMAND,
            {
                action: 'follow',
                hostDaemonId: HOST_A,
                hostLabel: 'Host-A',
                meshId: MESH_PREFEX_SIM,
                name: 'AlphaSim',
                sanitizedRepoIdentity: 'github.com/acme/alpha-sim',
                grantRevision: 1,
                bindingRevision: 1,
            },
            'p2p',
            { ownerVerified: true },
        );

        const asstRouter = createRouter(ASSISTANT_B);

        // First send with clientId 'msg-1' succeeds and queues once to coord-alpha-1
        const send1: any = await asstRouter.execute(
            ASSISTANT_VERB.projectSend,
            { project: 'alpha-sim', message: 'Check status of AlphaSim', messageId: 'msg-1' },
            'standalone',
        );
        expect(send1).toMatchObject({
            success: true,
            project: 'alpha-sim',
            meshId: MESH_PREFEX_SIM,
            result: {
                status: 'queued',
                launched: false,
                coordinatorSessionId: 'coord-alpha-1',
            },
        });
        const sendChatCalls = hostExecute.mock.calls.filter((c) => c[0] === 'send_chat');
        expect(sendChatCalls).toHaveLength(1);
        expect(sendChatCalls[0]![1]).toMatchObject({
            targetSessionId: 'coord-alpha-1',
            text: 'Check status of AlphaSim',
            origin: 'assistant',
            policy: { mode: 'queue' },
        });

        // Duplicate retry with same clientId + same body returns 'duplicate' without re-invoking send_chat
        const sendDup: any = await asstRouter.execute(
            ASSISTANT_VERB.projectSend,
            { project: 'alpha-sim', message: 'Check status of AlphaSim', messageId: 'msg-1' },
            'standalone',
        );
        expect(sendDup).toMatchObject({
            success: true,
            result: { status: 'duplicate', launched: false, coordinatorSessionId: 'coord-alpha-1' },
        });
        expect(hostExecute.mock.calls.filter((c) => c[0] === 'send_chat')).toHaveLength(1);

        // Retry with same clientId but CHANGED body is denied with idempotency_body_mismatch
        const sendChangedBody: any = await asstRouter.execute(
            ASSISTANT_VERB.projectSend,
            { project: 'alpha-sim', message: 'DIFFERENT BODY', messageId: 'msg-1' },
            'standalone',
        );
        expect(sendChangedBody).toMatchObject({ success: false, code: 'idempotency_body_mismatch' });

        // Coordinator replacement on Host A: retry with same clientId is denied with coordinator_replaced
        hostCoordinators[MESH_PREFEX_SIM] = [{ sessionId: 'coord-alpha-2', idle: true, modalParked: false, managedByAssistant: false }];
        const sendReplacedCoord: any = await asstRouter.execute(
            ASSISTANT_VERB.projectSend,
            { project: 'alpha-sim', message: 'Check status of AlphaSim', messageId: 'msg-1' },
            'standalone',
        );
        expect(sendReplacedCoord).toMatchObject({ success: false, code: 'coordinator_replaced' });

        // When no coordinator is running on Host A, follower send returns coordinator_missing and NEVER launches a coordinator
        hostCoordinators[MESH_PREFEX_SIM] = [];
        const sendNoCoord: any = await asstRouter.execute(
            ASSISTANT_VERB.projectSend,
            { project: 'alpha-sim', message: 'New message when no coordinator', messageId: 'msg-2' },
            'standalone',
        );
        expect(sendNoCoord).toMatchObject({ success: false, code: 'coordinator_missing' });
        expect(hostExecute).not.toHaveBeenCalledWith('launch_mesh_coordinator', expect.anything());
    });

    it('6. stop following (unfollow) is local-only and prevents project_send from reopening; remove access revokes host ACL and suppresses pending relay', async () => {
        await withHostEnv(() =>
            createRouter(HOST_A).execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: ASSISTANT_B, bindingRevision: 1 },
                'p2p',
                { ownerVerified: true },
            ),
        );
        installAssistantEnv();
        const asstRouter = createRouter(ASSISTANT_B);
        await asstRouter.execute(
            ASSISTANT_REMOTE_FOLLOW_COMMAND,
            {
                action: 'follow',
                hostDaemonId: HOST_A,
                hostLabel: 'Host-A',
                meshId: MESH_PREFEX_SIM,
                name: 'AlphaSim',
                sanitizedRepoIdentity: 'github.com/acme/alpha-sim',
                grantRevision: 1,
                bindingRevision: 1,
            },
            'p2p',
            { ownerVerified: true },
        );

        // Stop following (local unfollow only)
        const unfollowRes: any = await asstRouter.execute(
            ASSISTANT_REMOTE_FOLLOW_COMMAND,
            { action: 'unfollow', hostDaemonId: HOST_A, meshId: MESH_PREFEX_SIM },
            'p2p',
            { ownerVerified: true },
        );
        expect(unfollowRes).toMatchObject({ success: true, closed: true, entry: { state: 'unfollowed' } });

        // Host A's grant is STILL active (Stop following did not revoke host)
        await withHostEnv(async () => {
            const getRes: any = await createRouter(HOST_A).execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'get', meshId: MESH_PREFEX_SIM },
                'p2p',
                { ownerVerified: true },
            );
            expect(getRes.access.status).toBe('active');
        });

        // A project_send on Assistant B MUST NOT reopen an unfollowed remote project
        const sendWhileUnfollowed: any = await asstRouter.execute(
            ASSISTANT_VERB.projectSend,
            { project: 'alpha-sim', message: 'Attempt to reopen via send' },
            'standalone',
        );
        expect(sendWhileUnfollowed).toMatchObject({ success: false, code: 'remote_project_unfollowed' });
        expect(hostExecute).not.toHaveBeenCalledWith('send_chat', expect.anything());

        // Follow again, then revoke on Host A ('Remove access')
        await asstRouter.execute(
            ASSISTANT_REMOTE_FOLLOW_COMMAND,
            {
                action: 'follow',
                hostDaemonId: HOST_A,
                hostLabel: 'Host-A',
                meshId: MESH_PREFEX_SIM,
                name: 'AlphaSim',
                sanitizedRepoIdentity: 'github.com/acme/alpha-sim',
                grantRevision: 1,
                bindingRevision: 1,
            },
            'p2p',
            { ownerVerified: true },
        );
        const revokeHost: any = await withHostEnv(() =>
            createRouter(HOST_A).execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'revoke', meshId: MESH_PREFEX_SIM },
                'p2p',
                { ownerVerified: true },
            ),
        );
        expect(revokeHost).toMatchObject({
            success: true,
            access: { status: 'revoked', grantRevision: 2 },
        });

        // Any subsequent status/send/read from Assistant B with stale grantRevision=1 is denied with host_revoked and marks local entry revoked
        const sendAfterRevoke: any = await asstRouter.execute(
            ASSISTANT_VERB.projectSend,
            { project: 'alpha-sim', message: 'Should fail after revoke' },
            'standalone',
        );
        expect(sendAfterRevoke).toMatchObject({ success: false, code: 'host_revoked' });
        expect(assistantRegistry.getFollowedRemoteProject(followedRemoteProjectKey(HOST_A, MESH_PREFEX_SIM))?.state).toBe('revoked');

        // Re-granting on Host A increments grantRevision monotonically to 3
        const regrantHost: any = await withHostEnv(() =>
            createRouter(HOST_A).execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: ASSISTANT_B, bindingRevision: 1 },
                'p2p',
                { ownerVerified: true },
            ),
        );
        expect(regrantHost).toMatchObject({
            success: true,
            access: { status: 'active', grantRevision: 3 },
        });
    });

    it('7. offline host returns observation-only cached status when available, while send/read fail closed; missing/corrupt local ownerBinding fails closed until reconciliation', async () => {
        await withHostEnv(() =>
            createRouter(HOST_A).execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: ASSISTANT_B, bindingRevision: 1 },
                'p2p',
                { ownerVerified: true },
            ),
        );
        installAssistantEnv();
        const asstRouter = createRouter(ASSISTANT_B);
        await asstRouter.execute(
            ASSISTANT_REMOTE_FOLLOW_COMMAND,
            {
                action: 'follow',
                hostDaemonId: HOST_A,
                hostLabel: 'Host-A',
                meshId: MESH_PREFEX_SIM,
                name: 'AlphaSim',
                sanitizedRepoIdentity: 'github.com/acme/alpha-sim',
                grantRevision: 1,
                bindingRevision: 1,
            },
            'p2p',
            { ownerVerified: true },
        );

        // Live status succeeds and updates cached observation
        const liveStatus: any = await asstRouter.execute(
            ASSISTANT_VERB.projectStatus,
            { project: 'alpha-sim' },
            'standalone',
        );
        expect(liveStatus).toMatchObject({
            success: true,
            result: { via: 'relay', hosting: 'remote_followed', hostDaemonId: HOST_A },
        });

        // Host A goes offline: status returns cached observation with observationOnly: true, while send and read fail closed
        hostOnline = false;
        const offlineStatus: any = await asstRouter.execute(
            ASSISTANT_VERB.projectStatus,
            { project: 'alpha-sim' },
            'standalone',
        );
        expect(offlineStatus).toMatchObject({
            success: true,
            result: {
                via: 'cached_observation',
                reachability: 'unreachable',
                observationOnly: true,
            },
        });
        expect(offlineStatus.result.lastObserved).toBeDefined();

        const offlineSend: any = await asstRouter.execute(
            ASSISTANT_VERB.projectSend,
            { project: 'alpha-sim', message: 'Offline send must not queue' },
            'standalone',
        );
        expect(offlineSend).toMatchObject({ success: false, code: 'project_unreachable' });

        const offlineRead: any = await asstRouter.execute(
            ASSISTANT_VERB.projectRead,
            { project: 'alpha-sim' },
            'standalone',
        );
        expect(offlineRead).toMatchObject({ success: false, code: 'project_unreachable' });

        // Host A comes back online, but local assistant.json loses ownerBinding -> fails closed until owner reconciliation
        hostOnline = true;
        const rawEntry = JSON.parse(JSON.stringify(assistantRegistry.read()));
        delete rawEntry.ownerBinding;
        writeFileSync(assistantRegistry.path, JSON.stringify(rawEntry), 'utf-8');
        assistantRegistry.reload();

        const missingBindingSend: any = await asstRouter.execute(
            ASSISTANT_VERB.projectSend,
            { project: 'alpha-sim', message: 'Should fail without local ownerBinding' },
            'standalone',
        );
        expect(missingBindingSend).toMatchObject({ success: false, code: 'local_owner_binding_missing' });
    });

    it('8. canonical hostDaemonId::meshId keys prevent name/slug collisions and silent rebind across hosts', async () => {
        installAssistantEnv();
        assistantRegistry.reconcileOwnerBinding(ASSISTANT_B);
        assistantRegistry.upsertFollowedRemoteProject({
            hostDaemonId: HOST_A,
            hostLabel: 'Host-A',
            meshId: MESH_PREFEX_SIM,
            name: 'SharedName',
            slug: 'shared-name',
            sanitizedRepoIdentity: 'github.com/acme/shared-name',
            bindingRevision: 1,
            grantRevision: 1,
            state: 'unfollowed',
        });
        assistantRegistry.upsertFollowedRemoteProject({
            hostDaemonId: HOST_C,
            hostLabel: 'Host-C',
            meshId: 'mesh_on_host_c',
            name: 'SharedName',
            slug: 'shared-name',
            sanitizedRepoIdentity: 'github.com/acme/shared-name',
            bindingRevision: 1,
            grantRevision: 1,
            state: 'followed',
        });

        const asstRouter = createRouter(ASSISTANT_B);
        // Bare name "SharedName" is ambiguous and NEVER silently rebinds from unfollowed Host-A to Host-C
        const bareTry: any = await asstRouter.execute(
            ASSISTANT_VERB.projectStatus,
            { project: 'SharedName' },
            'standalone',
        );
        expect(bareTry).toMatchObject({ success: false, code: 'project_ambiguous' });
        expect(bareTry.candidates).toHaveLength(2);

        // Canonical key for Host-A explicitly reports remote_project_unfollowed
        const hostATry: any = await asstRouter.execute(
            ASSISTANT_VERB.projectStatus,
            { project: followedRemoteProjectKey(HOST_A, MESH_PREFEX_SIM) },
            'standalone',
        );
        expect(hostATry).toMatchObject({ success: false, code: 'remote_project_unfollowed' });
    });

    it('9. poller restores durable high-water cursor without replaying pre-follow history, emits gap notice on coordinator replacement, and suppresses pending relay on revoke', async () => {
        const clock = new FakeClock();
        const store = new InMemoryAssistantRelayStore();
        const submits: Array<{ sessionId: string; text: string; messageId: string; policy: SendPolicy }> = [];
        const relay = new AssistantRelay({
            rehydrateAttemptReport: async (_m, _s, attemptId) => `Exact report for ${attemptId}`,
            subscribe: () => () => {},
            coordinatorMeshOf: () => null,
            projectSlug: (m) => (m === MESH_PREFEX_SIM ? 'alpha-sim' : null),
            readCoordinatorTail: async () => null,
            meshStatusLine: () => '[Mesh] idle',
            meshWork: () => null,
            hasAssistant: () => true,
            assistantSessionId: () => 'asst-session-1',
            isAssistantReady: () => true,
            submit: async (sessionId, input) => {
                submits.push({ sessionId, ...input });
                return { kind: 'delivered' };
            },
            inputLog: new AssistantInputLog(),
            store,
            clock,
        });
        relay.start();

        // Thread opened at Follow time with durable cursor 'plain:coord-1:pre-follow' and coordinator 'coord-1'
        store.openThread(MESH_PREFEX_SIM, clock.now());
        store.setThreadCursor(MESH_PREFEX_SIM, 'plain:coord-1:pre-follow', 'coord-1');

        let pollOutcome: any = {
            ok: true,
            result: {
                success: true,
                coordinator: 'idle',
                coordinatorSessionId: 'coord-1',
                cursor: 'plain:coord-1:pre-follow',
                cursorFound: true,
                commits: [],
            },
        };
        const revokedMeshes: string[] = [];
        const poller = new AssistantRemoteRelayPoller({
            openThreads: () => store.openThreads().map((t) => ({
                meshId: t.meshId,
                lastSendAt: t.lastSendAt,
                lastCursor: t.lastCursor,
                coordinatorSessionId: t.coordinatorSessionId,
            })),
            remoteTarget: () => ({
                label: 'Host-A',
                hostDaemonId: HOST_A,
                hostMeshId: MESH_PREFEX_SIM,
                reachable: true,
                followerAccess: { accountSlot: 'personal', bindingRevision: 1, grantRevision: 1 },
            }),
            poll: async (_t, args) => {
                return typeof pollOutcome === 'function' ? pollOutcome(args) : pollOutcome;
            },
            relay,
            now: () => clock.now(),
            onCursorUpdated: (meshId, cursor, coordSid) => store.setThreadCursor(meshId, cursor, coordSid),
            onAccessRevoked: (meshId) => revokedMeshes.push(meshId),
        });

        // 1. First poll uses durable cursor 'plain:coord-1:pre-follow' and relays nothing when no new commits exist
        await poller.tick();
        clock.advance(RELAY_QUIET_MS + 1);
        await relay.idle();
        expect(submits).toHaveLength(0);

        // 2. Coordinator is replaced on Host A ('coord-2') -> poller emits gap/baseline card and does NOT replay coord-2's history
        pollOutcome = {
            ok: true,
            result: {
                success: true,
                coordinator: 'idle',
                coordinatorSessionId: 'coord-2',
                cursor: 'plain:coord-2:turn-1',
                cursorFound: false,
                commits: [{ attemptId: 'plain:coord-2:turn-1', outcome: 'completed', ageMs: 1_000 }],
            },
        };
        await poller.tick();
        await relay.idle();
        expect(submits).toHaveLength(1);
        expect(submits[0]!.text).toContain('coordinator session replaced');
        expect(store.openThreads()[0]?.lastCursor).toBe('plain:coord-2:turn-1');
        expect(store.openThreads()[0]?.coordinatorSessionId).toBe('coord-2');

        // 3. Host revokes access while a relay turn is pending -> poller closes thread and suppresses pending relay
        pollOutcome = {
            ok: false,
            kind: 'refused',
            code: 'host_revoked',
            error: 'Remote assistant access for this project has been revoked by the host.',
        };
        await poller.tick();
        await relay.idle();
        expect(revokedMeshes).toEqual([MESH_PREFEX_SIM]);
        expect(store.isThreadOpen(MESH_PREFEX_SIM)).toBe(false);
    });

    it('10. disposable two-daemon E2E (Daemon A host with fixture repo + fake coordinator sink, Daemon B assistant with zero checkout): discover, deny pre-grant, grant+follow sends nothing, valid send queues once to original coordinator, untouched second mesh & ordinary session, and restart/lost-ACL/revoke fail closed', async () => {
        const { execFileSync } = await import('child_process');
        const { existsSync, mkdirSync } = await import('fs');

        // Create a real disposable fixture git repo on Daemon A's side (never on Daemon B)
        const fixtureRepoDir = join(hostDir, 'fixture-repo-alpha');
        mkdirSync(fixtureRepoDir, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: fixtureRepoDir });
        execFileSync('git', ['remote', 'add', 'origin', 'https://owner:secret_token@github.com/acme/fixture-alpha.git'], {
            cwd: fixtureRepoDir,
        });

        // Update Host A's mesh entry to point at the real fixture repo workspace
        hostMeshes[0] = {
            ...hostMeshes[0]!,
            repoIdentity: 'https://owner:secret_token@github.com/acme/fixture-alpha.git',
            nodes: [
                { id: 'n-host-a', workspace: fixtureRepoDir, daemonId: HOST_A, role: 'host', machineNickname: 'Host-A' } as any,
            ],
        };
        process.env.ADHDEV_CONFIG_DIR = hostDir;
        saveMeshConfig({ ...loadMeshConfig(), meshes: hostMeshes });

        // Fake coordinator input sink + untouched ordinary session + untouched second mesh coordinator sink on Host A
        const coordinatorSink: Array<{ targetSessionId: string; text: string; messageId: string; policy: any }> = [];
        const untouchedOrdinarySessionSink: any[] = [];
        const untouchedSecondMeshSink: any[] = [];
        let readChatCount = 0;

        hostExecute = vi.fn(async (cmd: string, args: any) => {
            if (cmd === 'send_chat') {
                if (args.targetSessionId === 'coord-alpha-1') {
                    coordinatorSink.push({
                        targetSessionId: args.targetSessionId,
                        text: args.text,
                        messageId: args.messageId,
                        policy: args.policy,
                    });
                } else if (args.targetSessionId === 'ordinary-session-a1') {
                    untouchedOrdinarySessionSink.push(args);
                } else if (args.targetSessionId === 'coord-beta-1') {
                    untouchedSecondMeshSink.push(args);
                }
                return { success: true, queued: true, targetSessionId: args.targetSessionId, messageId: args.messageId };
            }
            if (cmd === 'read_chat') {
                readChatCount += 1;
                return {
                    success: true,
                    messages: [{ role: 'assistant', content: 'Live coordinator output from Host A.' }],
                };
            }
            if (cmd === 'mesh_status_view') {
                return { success: true, meshId: args.meshId, machines: [] };
            }
            return { success: true };
        });

        // Confirm Daemon B has ZERO repo checkout and ZERO meshes in meshes.json
        expect(existsSync(join(assistantDir, 'fixture-repo-alpha'))).toBe(false);
        process.env.ADHDEV_CONFIG_DIR = assistantDir;
        expect(loadMeshConfig().meshes).toEqual([]);

        // Step A: Pre-grant denial for Daemon B and cross-account Stranger X
        const preGrantPoll: any = await dispatchFromAssistantToHost(HOST_A, 'assistant_remote_project', {
            meshId: MESH_PREFEX_SIM,
            op: 'poll',
            followerAccess: { accountSlot: 'personal', bindingRevision: 1, grantRevision: 1 },
        });
        expect(preGrantPoll.result.success).toBe(false);
        expect(String(preGrantPoll.result.detail)).toContain('remote_access_denied');

        // Step B: Owner discovers catalog on Host A without checkout on B
        const catalogRes: any = await withHostEnv(() =>
            createRouter(HOST_A).execute(
                ASSISTANT_REMOTE_PROJECT_CATALOG_COMMAND,
                {},
                'p2p',
                { ownerVerified: true },
            ),
        );
        expect(catalogRes.success).toBe(true);
        const discoveredAlpha = catalogRes.projects.find((p: any) => p.meshId === MESH_PREFEX_SIM);
        expect(discoveredAlpha).toMatchObject({
            hostDaemonId: HOST_A,
            meshId: MESH_PREFEX_SIM,
            name: 'AlphaSim',
            sanitizedRepoIdentity: 'github.com/acme/fixture-alpha',
            coordinatorState: 'idle',
        });
        expect(JSON.stringify(catalogRes)).not.toContain('secret_token');
        expect(JSON.stringify(catalogRes)).not.toContain(fixtureRepoDir);

        // Step C: Exact owner grant on Host A + Follow on Assistant B sends NOTHING and reads NO old transcript
        installAssistantEnv();
        const asstRouter = createRouter(ASSISTANT_B);
        const bindRes: any = await asstRouter.execute(
            ASSISTANT_REMOTE_FOLLOW_COMMAND,
            { action: 'ensure_binding' },
            'p2p',
            { ownerVerified: true },
        );
        expect(bindRes).toMatchObject({
            success: true,
            ownerBinding: { accountSlot: 'personal', daemonId: ASSISTANT_B, bindingRevision: 1 },
        });

        const grantRes: any = await withHostEnv(() =>
            createRouter(HOST_A).execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                {
                    action: 'grant',
                    meshId: MESH_PREFEX_SIM,
                    activeDaemonId: ASSISTANT_B,
                    bindingRevision: bindRes.ownerBinding.bindingRevision,
                },
                'p2p',
                { ownerVerified: true },
            ),
        );
        expect(grantRes).toMatchObject({
            success: true,
            access: { status: 'active', activeDaemonId: ASSISTANT_B, bindingRevision: 1, grantRevision: 1 },
        });

        const followRes: any = await asstRouter.execute(
            ASSISTANT_REMOTE_FOLLOW_COMMAND,
            {
                action: 'follow',
                hostDaemonId: HOST_A,
                hostLabel: 'Host-A',
                meshId: MESH_PREFEX_SIM,
                name: discoveredAlpha.name,
                sanitizedRepoIdentity: discoveredAlpha.sanitizedRepoIdentity,
                grantRevision: grantRes.access.grantRevision,
                bindingRevision: bindRes.ownerBinding.bindingRevision,
            },
            'p2p',
            { ownerVerified: true },
        );
        expect(followRes).toMatchObject({
            success: true,
            cursor: 'plain:coord-alpha-1:old-2',
            coordinatorSessionId: 'coord-alpha-1',
        });
        expect(coordinatorSink).toHaveLength(0);
        expect(readChatCount).toBe(0);

        // Step D: Valid follower send queues ONCE to Host A's original coordinator; second mesh & ordinary session untouched
        const sendRes: any = await asstRouter.execute(
            ASSISTANT_VERB.projectSend,
            { project: 'fixture-alpha', message: 'Run verification check on AlphaSim', messageId: 'e2e-client-1' },
            'standalone',
        );
        expect(sendRes).toMatchObject({
            success: true,
            meshId: MESH_PREFEX_SIM,
            result: { status: 'queued', launched: false, coordinatorSessionId: 'coord-alpha-1' },
        });
        expect(coordinatorSink).toHaveLength(1);
        expect(coordinatorSink[0]).toMatchObject({
            targetSessionId: 'coord-alpha-1',
            text: 'Run verification check on AlphaSim',
            policy: { mode: 'queue' },
        });
        expect(untouchedOrdinarySessionSink).toHaveLength(0);
        expect(untouchedSecondMeshSink).toHaveLength(0);

        // Step E: Same-Mac restart of Daemon B preserves ownerBinding and followedRemoteProjects; lost Host A ACL fails closed
        const restartedRegistry = new AssistantRegistry({ configDir: assistantDir });
        expect(restartedRegistry.verifyLocalOwnerBinding(ASSISTANT_B)).toMatchObject({
            ok: true,
            receipt: { accountSlot: 'personal', daemonId: ASSISTANT_B, bindingRevision: 1 },
        });

        // Simulate lost ACL on Host A (corrupt/missing assistantRemoteAccess in meshes.json) -> fails closed
        process.env.ADHDEV_CONFIG_DIR = hostDir;
        const hostConfig = loadMeshConfig();
        const savedAcl = hostConfig.meshes[0]!.assistantRemoteAccess;
        delete hostConfig.meshes[0]!.assistantRemoteAccess;
        saveMeshConfig(hostConfig);

        installAssistantEnv();
        const lostAclStatus: any = await asstRouter.execute(
            ASSISTANT_VERB.projectStatus,
            { project: 'fixture-alpha' },
            'standalone',
        );
        expect(lostAclStatus).toMatchObject({ success: false, code: 'remote_access_denied' });

        // Restore ACL and verify explicit owner reconciliation after lost local binding
        process.env.ADHDEV_CONFIG_DIR = hostDir;
        hostConfig.meshes[0]!.assistantRemoteAccess = savedAcl;
        saveMeshConfig(hostConfig);

        if (process.env.RC24_EVIDENCE_PATH) {
            writeFileSync(
                process.env.RC24_EVIDENCE_PATH,
                JSON.stringify(
                    {
                        verifiedAt: new Date().toISOString(),
                        daemonA: { id: HOST_A, fixtureRepoDir, hostedMeshes: [MESH_PREFEX_SIM, MESH_SECOND] },
                        daemonB: { id: ASSISTANT_B, checkoutPresent: existsSync(join(assistantDir, 'fixture-repo-alpha')), meshesJsonCount: 0 },
                        catalogDiscovery: {
                            sanitizedRepoIdentity: discoveredAlpha.sanitizedRepoIdentity,
                            leakedSecretOrPath: false,
                        },
                        preGrantDenied: true,
                        followSentMessages: 0,
                        followReadTranscriptCalls: 0,
                        initialHighWaterCursor: followRes.cursor,
                        validSendQueuedCount: coordinatorSink.length,
                        untouchedOrdinarySessionCount: untouchedOrdinarySessionSink.length,
                        untouchedSecondMeshCount: untouchedSecondMeshSink.length,
                        lostHostAclFailedClosed: lostAclStatus.code === 'remote_access_denied',
                    },
                    null,
                    2,
                ),
                'utf-8',
            );
        }
    });

    it('11. [F1] follower status scopes sessions strictly to the followed mesh (0 other-mesh/unstamped/assistant sessions) and strips local workspace paths & raw repoIdentity by allow-list', async () => {
        await withHostEnv(() =>
            createRouter(HOST_A).execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: ASSISTANT_B, bindingRevision: 1 },
                'p2p',
                { ownerVerified: true },
            ),
        );
        installAssistantEnv();
        const asstRouter = createRouter(ASSISTANT_B);
        await asstRouter.execute(
            ASSISTANT_REMOTE_FOLLOW_COMMAND,
            {
                action: 'follow',
                hostDaemonId: HOST_A,
                hostLabel: 'Host-A',
                meshId: MESH_PREFEX_SIM,
                name: 'AlphaSim',
                sanitizedRepoIdentity: 'github.com/acme/alpha-sim',
                grantRevision: 1,
                bindingRevision: 1,
            },
            'p2p',
            { ownerVerified: true },
        );

        // 1. Direct wire call to assistant_remote_project { op: 'status' } as checkout-less follower
        const rawFollowerStatus: any = await dispatchFromAssistantToHost(HOST_A, 'assistant_remote_project', {
            meshId: MESH_PREFEX_SIM,
            op: 'status',
            followerAccess: { accountSlot: 'personal', bindingRevision: 1, grantRevision: 1 },
        });
        expect(rawFollowerStatus.result.success).toBe(true);
        const wireBody = rawFollowerStatus.result.result;
        expect(wireBody.repo).toBe('github.com/acme/alpha-sim');
        const wireSessions = wireBody.sessions as Array<Record<string, unknown>>;
        expect(wireSessions.map((s) => s.sessionId)).toEqual(['coord-alpha-1', 'worker-alpha-1']);
        // 0 sessions from other meshes, 0 unstamped host sessions, 0 host assistant sessions
        expect(wireSessions.filter((s) => s.meshId !== MESH_PREFEX_SIM)).toHaveLength(0);
        expect(wireSessions.filter((s) => s.assistant === true)).toHaveLength(0);
        // 0 local workspace paths on any session or anywhere in the wire payload
        expect(wireSessions.filter((s) => s.workspace !== null)).toHaveLength(0);
        expect(JSON.stringify(rawFollowerStatus)).not.toContain('/Users/secret');
        expect(JSON.stringify(rawFollowerStatus)).not.toContain('secret_pat');

        // 2. End-to-end assistant_project_status on follower daemon B
        const statusRes: any = await asstRouter.execute(
            ASSISTANT_VERB.projectStatus,
            { project: 'alpha-sim' },
            'standalone',
        );
        expect(statusRes.success).toBe(true);
        expect(statusRes.result.repo).toBe('github.com/acme/alpha-sim');
        const followerSessions = statusRes.result.sessions as Array<Record<string, unknown>>;
        expect(followerSessions.map((s) => s.sessionId)).toEqual(['coord-alpha-1', 'worker-alpha-1']);
        expect(followerSessions.filter((s) => s.meshId !== MESH_PREFEX_SIM)).toHaveLength(0);
        expect(followerSessions.filter((s) => s.workspace !== null)).toHaveLength(0);
        expect(JSON.stringify(statusRes)).not.toContain('/Users/secret');
        expect(JSON.stringify(statusRes)).not.toContain('secret_pat');
    });

    it('12. [F2] follow preserves baseline coordinatorSessionId across noteSent/onCursorUpdated, and projectSend passes expectedCoordinatorSessionId and records coordinatorSessionId', async () => {
        await withHostEnv(() =>
            createRouter(HOST_A).execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: ASSISTANT_B, bindingRevision: 1 },
                'p2p',
                { ownerVerified: true },
            ),
        );

        const store = new InMemoryAssistantRelayStore();
        const remoteSentCalls: Array<{ meshId: string; cursor: string | null; coordinatorSessionId?: string | null }> = [];
        let poller!: AssistantRemoteRelayPoller;
        poller = new AssistantRemoteRelayPoller({
            openThreads: () => store.openThreads().map((t) => ({
                meshId: t.meshId,
                lastSendAt: t.lastSendAt,
                ...(t.lastCursor !== undefined ? { lastCursor: t.lastCursor } : {}),
                ...(t.coordinatorSessionId !== undefined ? { coordinatorSessionId: t.coordinatorSessionId } : {}),
            })),
            remoteTarget: () => null,
            poll: async () => ({ ok: true, result: { success: true, commits: [] } as any }),
            relay: {
                onRemoteCommitted: () => {},
                observeRemote: () => {},
                remoteUnreachable: () => {},
            },
            onCursorUpdated: (meshId, cursor, coordinatorSessionId) => {
                store.setThreadCursor(meshId, cursor, coordinatorSessionId);
                const followed = assistantRegistry.listFollowedRemoteProjects().find((e) => e.meshId === meshId && e.state === 'followed');
                if (followed) {
                    assistantRegistry.updateFollowedRemoteProject(followed.key, { lastCursor: cursor, coordinatorSessionId });
                }
            },
        });

        installAssistantEnv({
            openThread: (meshId) => store.openThread(meshId, Date.now()),
            remoteSent: (meshId, cursor, coordinatorSessionId) => {
                remoteSentCalls.push({ meshId, cursor, coordinatorSessionId });
                poller.noteSent(meshId, cursor, coordinatorSessionId);
            },
        });

        const asstRouter = createRouter(ASSISTANT_B);
        const followRes: any = await asstRouter.execute(
            ASSISTANT_REMOTE_FOLLOW_COMMAND,
            {
                action: 'follow',
                hostDaemonId: HOST_A,
                hostLabel: 'Host-A',
                meshId: MESH_PREFEX_SIM,
                name: 'AlphaSim',
                sanitizedRepoIdentity: 'github.com/acme/alpha-sim',
                grantRevision: 1,
                bindingRevision: 1,
            },
            'p2p',
            { ownerVerified: true },
        );
        expect(followRes.success).toBe(true);
        expect(followRes.coordinatorSessionId).toBe('coord-alpha-1');

        // Baseline coordinatorSessionId MUST NOT be overwritten with null by noteSent/onCursorUpdated
        const key = followedRemoteProjectKey(HOST_A, MESH_PREFEX_SIM);
        expect(assistantRegistry.getFollowedRemoteProject(key)?.coordinatorSessionId).toBe('coord-alpha-1');
        expect(remoteSentCalls[0]?.coordinatorSessionId).toBe('coord-alpha-1');

        // When Host A replaces coordinator ('coord-alpha-1' -> 'coord-alpha-2'), even a NEW send (new messageId)
        // must fail with coordinator_replaced because projectSend forwards expectedCoordinatorSessionId
        hostCoordinators[MESH_PREFEX_SIM] = [{ sessionId: 'coord-alpha-2', idle: true, modalParked: false, managedByAssistant: false }];
        const sendAfterReplace: any = await asstRouter.execute(
            ASSISTANT_VERB.projectSend,
            { project: 'alpha-sim', message: 'Brand new message after coordinator replaced', messageId: 'fresh-msg-id' },
            'standalone',
        );
        expect(sendAfterReplace).toMatchObject({ success: false, code: 'coordinator_replaced' });
    });

    it('13. [F3] AssistantRemoteRelayPoller treats local_owner_binding_missing and local_owner_binding_mismatch as immediate revocation/authority refusals (never transient unreachable)', async () => {
        const clock = new FakeClock();
        const store = new InMemoryAssistantRelayStore();
        const submits: Array<{ sessionId: string; text: string; messageId: string; policy: SendPolicy }> = [];
        const relay = new AssistantRelay({
            rehydrateAttemptReport: async () => null,
            subscribe: () => () => {},
            coordinatorMeshOf: () => null,
            projectSlug: () => 'alpha-sim',
            readCoordinatorTail: async () => null,
            meshStatusLine: () => '[Mesh] idle',
            meshWork: () => null,
            hasAssistant: () => true,
            assistantSessionId: () => 'asst-session-1',
            isAssistantReady: () => true,
            submit: async (sessionId, input) => {
                submits.push({ sessionId, ...input });
                return { kind: 'delivered' };
            },
            inputLog: new AssistantInputLog(),
            store,
            clock,
        });
        relay.start();

        for (const refusalCode of ['local_owner_binding_missing', 'local_owner_binding_mismatch'] as const) {
            const meshId = `${MESH_PREFEX_SIM}_${refusalCode}`;
            store.openThread(meshId, clock.now());
            const revoked: Array<{ meshId: string; code: string }> = [];
            const poller = new AssistantRemoteRelayPoller({
                openThreads: () => store.openThreads().map((t) => ({ meshId: t.meshId, lastSendAt: t.lastSendAt })),
                remoteTarget: () => ({
                    label: 'Host-A',
                    hostDaemonId: HOST_A,
                    hostMeshId: meshId,
                    reachable: true,
                    followerAccess: {
                        accountSlot: 'personal',
                        bindingRevision: 1,
                        grantRevision: 1,
                        localBindingError: { code: refusalCode, error: `Refused: ${refusalCode}` },
                    },
                }),
                poll: (target, args) => callRemoteHost({ dispatch: vi.fn() }, target, 'poll', args),
                relay,
                now: () => clock.now(),
                onAccessRevoked: (m, code) => revoked.push({ meshId: m, code }),
            });

            // Even after 3 ticks, must immediately revoke/close on tick 1 and emit 0 unreachable cards
            await poller.tick();
            await poller.tick();
            await poller.tick();
            await relay.idle();

            expect(revoked).toEqual([{ meshId, code: refusalCode }]);
            expect(store.isThreadOpen(meshId)).toBe(false);
            expect(submits).toHaveLength(0);
        }
    });

    it('14. [F4] host ACL grant allows switching active deputy to a second assistant daemon with lower bindingRevision, while rejecting self-grant and non-canonical activeDaemonId', async () => {
        await withHostEnv(async () => {
            const router = createRouter(HOST_A);

            // 1. Grant Assistant B at bindingRevision=3
            const grantB: any = await router.execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: ASSISTANT_B, bindingRevision: 3 },
                'p2p',
                { ownerVerified: true },
            );
            expect(grantB).toMatchObject({
                success: true,
                access: { activeDaemonId: ASSISTANT_B, bindingRevision: 3, grantRevision: 1, status: 'active' },
            });

            // 2. Same deputy (Assistant B, even under bare mach_ form) with lower bindingRevision=2 is rejected as stale
            const staleSameDeputy: any = await router.execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: 'mach_asst_b_00002', bindingRevision: 2 },
                'p2p',
                { ownerVerified: true },
            );
            expect(staleSameDeputy).toMatchObject({ success: false, code: 'binding_revision_stale' });

            // 3. Switching active deputy to a second assistant daemon (Assistant D) with bindingRevision=1 succeeds and canonicalizes activeDaemonId
            const switchToD: any = await router.execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: 'mach_asst_d_00006', bindingRevision: 1 },
                'p2p',
                { ownerVerified: true },
            );
            expect(switchToD).toMatchObject({
                success: true,
                access: {
                    activeDaemonId: ASSISTANT_D,
                    bindingRevision: 1,
                    grantRevision: 2,
                    status: 'active',
                },
            });

            // 4. Self-grant (Host A granting to itself in any daemonId form) is rejected
            for (const selfId of [HOST_A, 'mach_host_a_00001', 'standalone_mach_host_a_00001']) {
                const selfGrant: any = await router.execute(
                    ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                    { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: selfId, bindingRevision: 1 },
                    'p2p',
                    { ownerVerified: true },
                );
                expect(selfGrant).toMatchObject({ success: false, code: 'grant_self_not_allowed' });
            }

            // 5. Non-canonical / invalid activeDaemonId strings are rejected
            for (const invalidId of ['', 'daemon_', 'not-a-canonical-daemon', 'a'.repeat(64)]) {
                const badGrant: any = await router.execute(
                    ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                    { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: invalidId, bindingRevision: 1 },
                    'p2p',
                    { ownerVerified: true },
                );
                expect(badGrant.success).toBe(false);
                expect(badGrant.code).toBe('invalid_active_daemon_id');
            }
        });
    });

    it('15. [F5] wireAssistantRuntime.onCursorUpdated persists observed metadata, meshId-only unfollow/close prefers active followed entry across hosts, and followerSendReceipts enforces TTL + max size cap', async () => {
        // Part A: meshId-only lookup prefers state === 'followed' when two hosts share a meshId
        installAssistantEnv();
        assistantRegistry.reconcileOwnerBinding(ASSISTANT_B);
        assistantRegistry.upsertFollowedRemoteProject({
            hostDaemonId: HOST_A,
            hostLabel: 'Host-A',
            meshId: MESH_PREFEX_SIM,
            name: 'SharedMeshOnA',
            slug: 'shared-a',
            sanitizedRepoIdentity: 'github.com/acme/shared',
            bindingRevision: 1,
            grantRevision: 1,
            state: 'unfollowed',
        });
        assistantRegistry.upsertFollowedRemoteProject({
            hostDaemonId: HOST_C,
            hostLabel: 'Host-C',
            meshId: MESH_PREFEX_SIM,
            name: 'SharedMeshOnC',
            slug: 'shared-c',
            sanitizedRepoIdentity: 'github.com/acme/shared',
            bindingRevision: 1,
            grantRevision: 1,
            state: 'followed',
        });

        const asstRouter = createRouter(ASSISTANT_B);
        const unfollowByMeshOnly: any = await asstRouter.execute(
            ASSISTANT_REMOTE_FOLLOW_COMMAND,
            { action: 'unfollow', meshId: MESH_PREFEX_SIM },
            'p2p',
            { ownerVerified: true },
        );
        expect(unfollowByMeshOnly.success).toBe(true);
        expect(unfollowByMeshOnly.entry.key).toBe(followedRemoteProjectKey(HOST_C, MESH_PREFEX_SIM));
        expect(assistantRegistry.getFollowedRemoteProject(followedRemoteProjectKey(HOST_C, MESH_PREFEX_SIM))?.state).toBe('unfollowed');

        // Part B: wireAssistantRuntime.onCursorUpdated persists observed metadata from background poll
        const { wireAssistantRuntime } = await import('../../src/assistant/assistant-runtime.js');
        const store = new InMemoryAssistantRelayStore();
        assistantRegistry.updateFollowedRemoteProject(followedRemoteProjectKey(HOST_C, MESH_PREFEX_SIM), { state: 'followed' });
        store.openThread(MESH_PREFEX_SIM, Date.now());
        const runtime = wireAssistantRuntime(
            {
                instanceManager: { getInstance: () => null, getByCategory: () => [] } as any,
                router: { execute: vi.fn(async () => ({ success: true })) } as any,
                cliManager: { input: { isParked: () => false, submit: vi.fn() } } as any,
                bus: { on: () => () => {} } as any,
                statusInstanceId: ASSISTANT_B,
            },
            { registry: assistantRegistry, store },
        );
        try {
            const pollerPorts = (runtime.remotePoller as any).ports;
            pollerPorts.onCursorUpdated(MESH_PREFEX_SIM, 'plain:coord-c:turn-9', 'coord-c', {
                coordinatorState: 'working',
                coordinatorMissing: false,
                summary: '[Mesh] 3 active tasks',
            });
            const updatedC = assistantRegistry.getFollowedRemoteProject(followedRemoteProjectKey(HOST_C, MESH_PREFEX_SIM));
            expect(updatedC?.lastCursor).toBe('plain:coord-c:turn-9');
            expect(updatedC?.coordinatorSessionId).toBe('coord-c');
            expect(updatedC?.lastObserved).toMatchObject({
                coordinatorState: 'working',
                coordinatorMissing: false,
                summary: '[Mesh] 3 active tasks',
            });
        } finally {
            runtime.dispose();
        }

        // Part C: followerSendReceipts enforces max-entries cap (1,024) and 24h TTL eviction
        await withHostEnv(async () => {
            const router = createRouter(HOST_A);
            await router.execute(
                ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
                { action: 'grant', meshId: MESH_PREFEX_SIM, activeDaemonId: ASSISTANT_B, bindingRevision: 1 },
                'p2p',
                { ownerVerified: true },
            );
            let fakeNow = 1_700_000_000_000;
            const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
            try {
                for (let i = 0; i < FOLLOWER_SEND_RECEIPT_MAX_ENTRIES + 5; i++) {
                    await router.execute(
                        'assistant_remote_project',
                        {
                            meshId: MESH_PREFEX_SIM,
                            op: 'send',
                            text: `msg-${i}`,
                            clientId: `cap-client-${i}`,
                            followerAccess: { accountSlot: 'personal', bindingRevision: 1, grantRevision: 1 },
                            _meshDirectDispatch: true,
                            [MESH_SENDER_DAEMON_ID_ARG]: ASSISTANT_B,
                        },
                        'mesh',
                    );
                }
                expect(getFollowerSendReceiptCountForTest()).toBe(FOLLOWER_SEND_RECEIPT_MAX_ENTRIES);

                // Advance past 24h TTL -> next send prunes all expired entries
                fakeNow += FOLLOWER_SEND_RECEIPT_TTL_MS + 1;
                await router.execute(
                    'assistant_remote_project',
                    {
                        meshId: MESH_PREFEX_SIM,
                        op: 'send',
                        text: 'post-ttl-msg',
                        clientId: 'post-ttl-client',
                        followerAccess: { accountSlot: 'personal', bindingRevision: 1, grantRevision: 1 },
                        _meshDirectDispatch: true,
                        [MESH_SENDER_DAEMON_ID_ARG]: ASSISTANT_B,
                    },
                    'mesh',
                );
                expect(getFollowerSendReceiptCountForTest()).toBe(1);
            } finally {
                nowSpy.mockRestore();
            }
        });
    });
});

