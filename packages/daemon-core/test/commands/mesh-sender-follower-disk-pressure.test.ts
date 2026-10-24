/**
 * Host-side: a meshes.json READ FAILURE (ENFILE/EMFILE/EIO) must never read as
 * "mesh missing" / "not on roster" for a follower (the 2026-10-22 false revocation).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { evaluateMeshSender, MESH_SENDER_DAEMON_ID_ARG, type MeshSenderGateDeps } from '../../src/commands/mesh-sender.js';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { ASSISTANT_ACCOUNT_SLOT } from '@adhdev/mesh-shared';
import { ASSISTANT_REMOTE_PROJECT_COMMAND } from '../../src/assistant/assistant-remote-host.js';
import { setAssistantProjectPortsForTests, type AssistantProjectPorts } from '../../src/assistant/assistant-project-ports.js';
import { loadMeshConfig, loadMeshConfigStrict, MeshConfigUnreadableError, saveMeshConfig } from '../../src/config/mesh-config-store.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { clearFollowerSendReceiptsForTest } from '../../src/commands/high-family/assistant-remote.js';

const SELF = 'daemon_mach_host0001';
const FOLLOWER = 'daemon_mach_follow0001';
const MESH = 'mesh_follow_1';

const aclMesh = (status: 'active' | 'revoked' = 'active', grantRevision = 1) => ({
    id: MESH,
    name: 'Follow1',
    repoIdentity: 'github.com/acme/follow1',
    meshHost: { role: 'host', hostDaemonId: SELF },
    nodes: [{ id: 'n1', workspace: '/w', daemonId: SELF, role: 'host' }],
    assistantRemoteAccess: {
        status, hostDaemonId: SELF, activeDaemonId: FOLLOWER, meshId: MESH,
        grantRevision, bindingRevision: 1, allowedOps: ['poll', 'send', 'status', 'read', 'report'], accountSlot: ASSISTANT_ACCOUNT_SLOT, grantedAt: 1,
        ...(status === 'revoked' ? { revokedAt: 2 } : {}),
    },
});

function deps(over: Partial<MeshSenderGateDeps>): MeshSenderGateDeps {
    return {
        selfDaemonId: SELF,
        getLocalMesh: async () => null,
        listLocalMeshes: () => [],
        getSessionSettings: () => null,
        listSessionSettings: () => [],
        resolveForwardEventMeshId: () => '',
        ...over,
    } as MeshSenderGateDeps;
}
const args = { [MESH_SENDER_DAEMON_ID_ARG]: FOLLOWER, meshId: MESH, op: 'poll', bindingRevision: 1, grantRevision: 1 };
const enfile = () => Object.assign(new Error('ENFILE: file table overflow'), { code: 'ENFILE' });

describe('follower ACL under disk read pressure', () => {
    for (const code of ['ENFILE', 'EMFILE', 'EIO']) {
        it(`${code} on the disk read is a transient refusal, never not_on_roster/remote_access_denied`, async () => {
            const v = await evaluateMeshSender('roster', args, deps({
                getDiskMesh: async () => { throw Object.assign(new Error(code), { code }); },
            }), ASSISTANT_REMOTE_PROJECT_COMMAND);
            expect(v.ok).toBe(false);
            if (!v.ok) {
                expect(v.refusal).toBe('host_unavailable_transient');
                expect(v.detail).not.toContain('remote_access_denied');
                expect(v.detail).not.toContain('host_revoked');
            }
        });
    }

    it('never consults unsynchronized in-memory fallback when disk read fails (Scenario A: stale revoked cache, Scenario B: stale active cache)', async () => {
        // Scenario A: after revoke then re-grant on disk, inlineMeshCache still says revoked.
        // Under ENFILE, must return host_unavailable_transient — NEVER host_revoked.
        const vRevokedCache = await evaluateMeshSender('roster', { ...args, grantRevision: 2 }, deps({
            getDiskMesh: async () => { throw enfile(); },
            getLocalMesh: async () => aclMesh('revoked', 1),
        }), ASSISTANT_REMOTE_PROJECT_COMMAND);
        expect(vRevokedCache.ok).toBe(false);
        if (!vRevokedCache.ok) {
            expect(vRevokedCache.refusal).toBe('host_unavailable_transient');
            expect(vRevokedCache.detail).not.toContain('host_revoked');
        }

        // Scenario B: after grant then revoke on disk, inlineMeshCache still says active.
        // Under ENFILE, must return host_unavailable_transient — NEVER admit the revoked follower.
        const vActiveCache = await evaluateMeshSender('roster', args, deps({
            getDiskMesh: async () => { throw enfile(); },
            getLocalMesh: async () => aclMesh('active', 1),
        }), ASSISTANT_REMOTE_PROJECT_COMMAND);
        expect(vActiveCache.ok).toBe(false);
        if (!vActiveCache.ok) {
            expect(vActiveCache.refusal).toBe('host_unavailable_transient');
        }
    });

    it('a genuinely absent mesh still follows the old (non-transient) path', async () => {
        const v = await evaluateMeshSender('roster', args, deps({ getDiskMesh: async () => null }), ASSISTANT_REMOTE_PROJECT_COMMAND);
        expect(v.ok).toBe(false);
        if (!v.ok) expect(v.refusal).toBe('mesh_sender_not_on_roster');
    });
});

describe('end-to-end router follower ACL with stale inlineMeshCache + ENFILE', () => {
    let dir = '';
    let prev: string | undefined;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'router-enfile-'));
        prev = process.env.ADHDEV_CONFIG_DIR;
        process.env.ADHDEV_CONFIG_DIR = dir;
        setAssistantProjectPortsForTests(() => ({
            selfDaemonId: () => SELF,
            listMeshes: () => loadMeshConfig().meshes,
            isHostedHere: () => true,
            aliases: () => ({}),
            coordinators: () => [{ sessionId: 'coord-1', idle: true, modalParked: false, managedByAssistant: true }],
            lastCoordinatorSessionId: () => 'coord-1',
            queueCounts: () => ({ pending: 0, assigned: 0, failed: 0 }),
            activeMissionCount: () => 0,
            pendingApprovals: () => 0,
            relay: {},
            execute: vi.fn(async () => ({ success: true, queued: true })) as any,
            remoteHost: () => { throw new Error('unused'); },
            callHost: () => { throw new Error('unused'); },
            coordinatorTurns: () => ({ open: false, committed: [] }),
            meshStatusLine: () => '[Mesh] idle',
        }) as unknown as AssistantProjectPorts);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        setAssistantProjectPortsForTests(null);
        if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR;
        else process.env.ADHDEV_CONFIG_DIR = prev;
        rmSync(dir, { recursive: true, force: true });
    });

    function makeRouter(): DaemonCommandRouter {
        return new DaemonCommandRouter({
            commandHandler: { handleSpec: vi.fn(async () => ({ success: true })), rejectUnknown: vi.fn(async (cmd: string) => ({ success: false, error: `Unknown command: ${cmd}` })) } as any,
            cliManager: {} as any,
            cdpManagers: new Map(),
            providerLoader: {} as any,
            instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
            detectedIdes: { value: [] },
            sessionRegistry: { get: () => undefined } as any,
            statusInstanceId: SELF,
        } as any);
    }

    it('Scenario A & B: router with stale inlineMeshCache under ENFILE returns host_unavailable_transient (never host_revoked or admitted)', async () => {
        const router = makeRouter();
        // Disk has re-granted (grantRevision=2, active), but inlineMeshCache still has revoked (grantRevision=1).
        saveMeshConfig({ meshes: [aclMesh('active', 2) as any] });
        router.inlineMeshCache.set(MESH, aclMesh('revoked', 1));

        // Simulate ENFILE by replacing meshes.json with a directory (causes EISDIR on readFileSync)
        rmSync(join(dir, 'meshes.json'), { force: true });
        mkdirSync(join(dir, 'meshes.json'));

        const resA: any = await router.execute(
            ASSISTANT_REMOTE_PROJECT_COMMAND,
            { _meshDirectDispatch: true, [MESH_SENDER_DAEMON_ID_ARG]: FOLLOWER, meshId: MESH, op: 'poll', bindingRevision: 1, grantRevision: 2 },
            'mesh',
        );
        expect(resA.success).toBe(false);
        expect(resA.code).toBe('host_unavailable_transient');
        expect(String(resA.detail ?? resA.error)).not.toContain('host_revoked');

        // Scenario B: inlineMeshCache still says active (grantRevision=1), while disk is unreadable under ENFILE.
        router.inlineMeshCache.set(MESH, aclMesh('active', 1));
        const resB: any = await router.execute(
            ASSISTANT_REMOTE_PROJECT_COMMAND,
            { _meshDirectDispatch: true, [MESH_SENDER_DAEMON_ID_ARG]: FOLLOWER, meshId: MESH, op: 'poll', bindingRevision: 1, grantRevision: 1 },
            'mesh',
        );
        expect(resB.success).toBe(false);
        expect(resB.code).toBe('host_unavailable_transient');
    });

    it('Finding 4: post-gate ENFILE in assistantRemoteProject and followerProjectSend returns host_unavailable_transient (never project_not_found)', async () => {
        const router = makeRouter();
        const meshPath = join(dir, 'meshes.json');
        saveMeshConfig({ meshes: [aclMesh('active', 1) as any] });

        let chmodOnPortsInit = true;
        let chmodOnCoordinators = false;
        setAssistantProjectPortsForTests(() => {
            if (chmodOnPortsInit) chmodSync(meshPath, 0o000);
            return {
                selfDaemonId: () => SELF,
                listMeshes: () => loadMeshConfig().meshes,
                isHostedHere: () => true,
                aliases: () => ({}),
                coordinators: () => {
                    if (chmodOnCoordinators) chmodSync(meshPath, 0o000);
                    return [{ sessionId: 'coord-1', idle: true, modalParked: false, managedByAssistant: true }];
                },
                lastCoordinatorSessionId: () => 'coord-1',
                queueCounts: () => ({ pending: 0, assigned: 0, failed: 0 }),
                activeMissionCount: () => 0,
                pendingApprovals: () => 0,
                relay: {},
                execute: vi.fn(async () => ({ success: true, queued: true })) as any,
                remoteHost: () => { throw new Error('unused'); },
                callHost: () => { throw new Error('unused'); },
                coordinatorTurns: () => ({ open: false, committed: [] }),
                meshStatusLine: () => '[Mesh] idle',
            } as unknown as AssistantProjectPorts;
        });

        try {
            // 1. Gate read succeeds (0600); projectPortsFor flips meshes.json to 0000 before assistantRemoteProject reads it.
            const pollRes: any = await router.execute(
                ASSISTANT_REMOTE_PROJECT_COMMAND,
                { _meshDirectDispatch: true, [MESH_SENDER_DAEMON_ID_ARG]: FOLLOWER, meshId: MESH, op: 'poll', bindingRevision: 1, grantRevision: 1 },
                'mesh',
            );
            expect(pollRes.success).toBe(false);
            expect(pollRes.code).toBe('host_unavailable_transient');

            // 2. Gate read + assistantRemoteProject + initial followerProjectSend read succeed (0600);
            // coordinators() flips meshes.json to 0000 right before followerProjectSend's pre-enqueue re-check.
            chmodSync(meshPath, 0o600);
            chmodOnPortsInit = false;
            chmodOnCoordinators = true;

            const sendRes: any = await router.execute(
                ASSISTANT_REMOTE_PROJECT_COMMAND,
                { _meshDirectDispatch: true, [MESH_SENDER_DAEMON_ID_ARG]: FOLLOWER, meshId: MESH, op: 'send', text: 'hello', clientId: 'c-1', bindingRevision: 1, grantRevision: 1 },
                'mesh',
            );
            expect(sendRes.success).toBe(false);
            expect(sendRes.code).toBe('host_unavailable_transient');
        } finally {
            try { chmodSync(meshPath, 0o600); } catch { /* ignore */ }
        }
    });

    for (const phase of ['pre_reservation', 'before_launch', 'after_launch'] as const) {
        it(`merge: ${phase} disk failure refuses a cold wake transiently without sending`, async () => {
            MeshRuntimeStore.resetForTests();
            clearFollowerSendReceiptsForTest();
            const mesh = aclMesh('active', 1);
            const meshPath = join(dir, 'meshes.json');
            saveMeshConfig({ meshes: [mesh as any] });
            let coordinatorReads = 0;
            let launched = false;
            let failReads = true;
            const breakDiskRead = () => {
                rmSync(meshPath, { force: true });
                mkdirSync(meshPath);
            };
            const execute = vi.fn(async (command: string) => {
                if (command === 'launch_mesh_coordinator') {
                    launched = true;
                    if (failReads && phase === 'after_launch') breakDiskRead();
                    return { success: true, sessionId: 'coord-woken' };
                }
                return { success: true, queued: true };
            });
            setAssistantProjectPortsForTests(() => ({
                selfDaemonId: () => SELF,
                listMeshes: () => [mesh], // stale active memory must never hide an unreadable disk
                isHostedHere: () => true,
                coordinators: () => {
                    coordinatorReads += 1;
                    if (failReads && ((phase === 'pre_reservation' && coordinatorReads === 1)
                        || (phase === 'before_launch' && coordinatorReads === 2))) breakDiskRead();
                    return launched ? [{ sessionId: 'coord-woken', idle: true, modalParked: false, managedByAssistant: true }] : [];
                },
                coordinatorTurns: () => ({ open: false, committed: [] }),
                execute,
            }) as unknown as AssistantProjectPorts);
            const router = makeRouter();
            const send = () => router.execute(ASSISTANT_REMOTE_PROJECT_COMMAND, {
                _meshDirectDispatch: true, [MESH_SENDER_DAEMON_ID_ARG]: FOLLOWER,
                meshId: MESH, op: 'send', text: 'hello', clientId: `merge-${phase}`,
                bindingRevision: 1, grantRevision: 1,
            }, 'mesh');
            try {
                const refused: any = await send();
                expect(refused).toMatchObject({ success: false, code: 'host_unavailable_transient' });
                expect(execute.mock.calls.filter(([cmd]) => cmd === 'send_chat')).toHaveLength(0);
                expect(execute.mock.calls.filter(([cmd]) => cmd === 'launch_mesh_coordinator'))
                    .toHaveLength(phase === 'after_launch' ? 1 : 0);

                // A pre-launch read failure releases its reservation. After a real launch,
                // recovery may use that live coordinator without another cold wake.
                rmSync(meshPath, { recursive: true, force: true });
                saveMeshConfig({ meshes: [mesh as any] });
                failReads = false;
                const recovered: any = await send();
                expect(recovered.success).toBe(true);
                expect(execute.mock.calls.filter(([cmd]) => cmd === 'launch_mesh_coordinator')).toHaveLength(1);
                expect(execute.mock.calls.filter(([cmd]) => cmd === 'send_chat')).toHaveLength(1);
            } finally {
                clearFollowerSendReceiptsForTest();
                MeshRuntimeStore.resetForTests();
            }
        });
    }

});

describe('loadMeshConfigStrict', () => {
    let dir = '';
    let prev: string | undefined;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mesh-strict-')); prev = process.env.ADHDEV_CONFIG_DIR; process.env.ADHDEV_CONFIG_DIR = dir; });
    afterEach(() => { if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

    it('ENOENT → empty config; unreadable (EISDIR) / torn JSON → throws', () => {
        expect(loadMeshConfigStrict()).toEqual({ meshes: [] });
        mkdirSync(join(dir, 'meshes.json'));
        expect(() => loadMeshConfigStrict()).toThrow(MeshConfigUnreadableError);
        rmSync(join(dir, 'meshes.json'), { recursive: true });
        writeFileSync(join(dir, 'meshes.json'), '{"meshes": [');
        expect(() => loadMeshConfigStrict()).toThrow(MeshConfigUnreadableError);
        writeFileSync(join(dir, 'meshes.json'), JSON.stringify({ meshes: [{ id: MESH }] }));
        expect(loadMeshConfigStrict().meshes[0]!.id).toBe(MESH);
    });
});
