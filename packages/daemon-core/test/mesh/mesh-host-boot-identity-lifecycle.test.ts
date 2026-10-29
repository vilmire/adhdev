/** Integration: authoritative host boot identity through server diagnostics,
 * control.resolveHostBootId, idle inventory, and stop_session_if_expected.
 * Covers upgradeBinding UUID match, mismatch/restart fail-closed, and
 * non-upgrade hs: compatibility — without weakening claim/reuse/input fences. */
import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createSessionHostControlPlane,
    hostBootIdFromStartedAt,
    type SessionCleanupExpectedAssignment,
    type SessionHostRecord,
} from '@adhdev/session-host-core';
import { SessionHostServer } from '../../../session-host-daemon/src/server.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { idleSessionLifetimeCommand } from '../../src/commands/mesh-idle-session-lifetime.js';
import { sessionIsStopping } from '../../src/mesh/mesh-session-stop-fence.js';

const mac = process.platform === 'darwin';

function makeRecord(sessionId: string, meshId: string, at: number): SessionHostRecord {
    return {
        sessionId,
        runtimeKey: `rt-${sessionId}`,
        displayName: 'Worker',
        workspaceLabel: 'test',
        transport: 'pty',
        providerType: 'codex-cli',
        category: 'cli',
        workspace: '/fake/worktree',
        launchCommand: { command: 'fake-worker', args: [] },
        osPid: 417,
        createdAt: at,
        startedAt: at,
        lastActivityAt: at,
        lifecycle: 'running',
        writeOwner: null,
        attachedClients: [],
        buffer: { scrollbackBytes: 0, snapshotSeq: 0 },
        meta: { meshNodeFor: meshId, meshNodeId: 'n1', launchedByCoordinator: true },
    };
}

function planeFor(server: SessionHostServer) {
    return createSessionHostControlPlane({
        request: async <T>(type, payload) => {
            const reply = await server.handleRequest({ type, payload } as any);
            if (!reply.success) throw new Error(reply.error || `request_failed:${type}`);
            return (reply.result ?? null) as T;
        },
    });
}

async function idleHost(
    server: SessionHostServer,
    control: ReturnType<typeof planeFor>,
    record: SessionHostRecord,
    meshId: string,
) {
    const state: any = {
        instanceId: record.sessionId,
        status: 'idle',
        type: 'codex-cli',
        settings: {
            meshNodeFor: meshId,
            meshNodeId: 'n1',
            launchedByCoordinator: true,
            meshActiveDispatchNonce: null,
        },
    };
    const host: any = {
        deps: {
            idleSessionLifetimeControl: control,
            getInstanceManager: () => ({ getByCategory: () => [{ getState: () => state }] }),
        },
    };
    return { host, state };
}

describe('host boot identity lifecycle (non-upgrade hs:)', () => {
    it('inventory, control.resolveHostBootId, and stop share hs: boot id', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'boot-id-nonupgrade-'));
        try {
            const server = new SessionHostServer({ appName: 'boot-id-nonupgrade', storageRootDir: dir }) as any;
            const meshId = randomUUID();
            const sessionId = randomUUID();
            const at = Date.now();
            const record = makeRecord(sessionId, meshId, at);
            server.registry.restoreSession(record);
            const stops: string[] = [];
            server.runtimes.set(sessionId, { stop: () => stops.push('stop') });

            const control = planeFor(server);
            const bootId = await control.resolveHostBootId();
            expect(bootId).toBe(hostBootIdFromStartedAt(server.startedAt));
            const diagnostics = await control.getDiagnostics({});
            expect(diagnostics.hostBootId).toBe(bootId);

            const { host, state } = await idleHost(server, control, record, meshId);
            const inventory = await idleSessionLifetimeCommand(host, {
                action: 'mesh_idle_session_inventory',
                targetSessionId: sessionId,
                meshContext: { meshId },
            } as any);
            expect(inventory).toMatchObject({ success: true, hostBootId: bootId });
            expect((inventory as any).sessions[0].hostBootId).toBe(bootId);

            const claimFence = { taskId: null, attemptId: null, generation: null, dispatchNonce: null };
            const expected: SessionCleanupExpectedAssignment = {
                sessionId, hostBootId: bootId!, runtimeKey: record.runtimeKey, startedAt: at, ...claimFence,
            };
            const stop = await idleSessionLifetimeCommand(host, {
                action: 'mesh_idle_session_stop',
                targetSessionId: sessionId,
                meshContext: { meshId },
                idleSessionLifetime: {
                    lastActivityAt: at,
                    stopId: randomUUID(),
                    claimFence,
                    expected,
                },
            } as any);
            expect(stop).toMatchObject({ success: true, stoppedSessionIds: [sessionId] });
            expect(stops).toEqual(['stop']);
            void state;
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('fail-closes when expected hostBootId drifts (restart fence)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'boot-id-mismatch-'));
        try {
            const server = new SessionHostServer({ appName: 'boot-id-mismatch', storageRootDir: dir }) as any;
            const meshId = randomUUID();
            const sessionId = randomUUID();
            const at = Date.now();
            const record = makeRecord(sessionId, meshId, at);
            server.registry.restoreSession(record);
            const stops: string[] = [];
            server.runtimes.set(sessionId, { stop: () => stops.push('stop') });
            const control = planeFor(server);
            const bootId = await control.resolveHostBootId();
            const { host } = await idleHost(server, control, record, meshId);
            const claimFence = { taskId: null, attemptId: null, generation: null, dispatchNonce: null };
            const result = await idleSessionLifetimeCommand(host, {
                action: 'mesh_idle_session_stop',
                targetSessionId: sessionId,
                meshContext: { meshId },
                idleSessionLifetime: {
                    lastActivityAt: at,
                    stopId: randomUUID(),
                    claimFence,
                    expected: {
                        sessionId, hostBootId: 'hs:1', runtimeKey: record.runtimeKey, startedAt: at, ...claimFence,
                    },
                },
            } as any);
            expect(result).toMatchObject({ success: false, error: 'cleanup_host_boot_mismatch', retained: true });
            expect(stops).toEqual([]);
            expect(sessionIsStopping(MeshRuntimeStore.getInstance().db, sessionId)).toBe(false);
            expect(bootId).not.toBe('hs:1');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('host boot identity lifecycle (upgradeBinding UUID)', () => {
    it('inventory captures upgrade lease UUID and matching stop succeeds; hs:/restart fail closed', async ({ skip }) => {
        if (!mac) {
            skip();
            return;
        }
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'boot-id-upgrade-')));
        const helper = join(root, 'lock-helper');
        const here = dirname(fileURLToPath(import.meta.url));
        const lockSrcCandidates = [
            join(here, '../../../session-host-daemon/native/instance-lock.c'),
            join(process.cwd(), 'native/instance-lock.c'),
            join(process.cwd(), '../session-host-daemon/native/instance-lock.c'),
        ];
        const lockSrc = lockSrcCandidates.find((p) => existsSync(p));
        if (!lockSrc) {
            skip();
            return;
        }
        execFileSync('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror', lockSrc, '-o', helper]);
        const pin = createHash('sha256').update(readFileSync(helper)).digest('hex');
        const stateDir = join(root, 'state');
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        chmodSync(stateDir, 0o700);
        const storageRootDir = join(stateDir, 'records');
        mkdirSync(storageRootDir, { recursive: true, mode: 0o700 });
        const endpoint = join(root, 'host.sock');
        try {
            const server = new SessionHostServer({
                endpoint: { kind: 'unix', path: endpoint },
                storageRootDir,
                upgradeBinding: { helperPath: helper, helperSha256: pin, stateDir },
            }) as any;
            await server.upgradeLease.start();
            try {
                const meshId = randomUUID();
                const sessionId = randomUUID();
                const at = Date.now();
                const record = makeRecord(sessionId, meshId, at);
                server.registry.restoreSession(record);
                const stops: string[] = [];
                server.runtimes.set(sessionId, { stop: () => stops.push('stop') });

                const upgradeBootId = server.upgradeLease.bootId as string;
                expect(upgradeBootId).toMatch(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
                );
                expect(upgradeBootId).not.toBe(hostBootIdFromStartedAt(server.startedAt));

                const control = planeFor(server);
                const resolved = await control.resolveHostBootId();
                expect(resolved).toBe(upgradeBootId);
                const diagnostics = await control.getDiagnostics({});
                expect(diagnostics.hostBootId).toBe(upgradeBootId);

                const { host } = await idleHost(server, control, record, meshId);
                const inventory = await idleSessionLifetimeCommand(host, {
                    action: 'mesh_idle_session_inventory',
                    targetSessionId: sessionId,
                    meshContext: { meshId },
                } as any);
                expect(inventory).toMatchObject({ success: true, hostBootId: upgradeBootId });

                const claimFence = { taskId: null, attemptId: null, generation: null, dispatchNonce: null };
                // hs: timestamp must fail closed against upgrade UUID identity.
                const hsMismatch = await idleSessionLifetimeCommand(host, {
                    action: 'mesh_idle_session_stop',
                    targetSessionId: sessionId,
                    meshContext: { meshId },
                    idleSessionLifetime: {
                        lastActivityAt: at,
                        stopId: randomUUID(),
                        claimFence,
                        expected: {
                            sessionId,
                            hostBootId: hostBootIdFromStartedAt(server.startedAt),
                            runtimeKey: record.runtimeKey,
                            startedAt: at,
                            ...claimFence,
                        },
                    },
                } as any);
                expect(hsMismatch).toMatchObject({ success: false, error: 'cleanup_host_boot_mismatch', retained: true });
                expect(stops).toEqual([]);

                // Incarnation restart fence still refuses without stopping.
                const incarnation = await idleSessionLifetimeCommand(host, {
                    action: 'mesh_idle_session_stop',
                    targetSessionId: sessionId,
                    meshContext: { meshId },
                    idleSessionLifetime: {
                        lastActivityAt: at,
                        stopId: randomUUID(),
                        claimFence,
                        expected: {
                            sessionId,
                            hostBootId: upgradeBootId,
                            runtimeKey: 'rt-replaced',
                            startedAt: at + 1,
                            ...claimFence,
                        },
                    },
                } as any);
                expect(incarnation.success).toBe(false);
                expect(stops).toEqual([]);

                const matched = await idleSessionLifetimeCommand(host, {
                    action: 'mesh_idle_session_stop',
                    targetSessionId: sessionId,
                    meshContext: { meshId },
                    idleSessionLifetime: {
                        lastActivityAt: at,
                        stopId: randomUUID(),
                        claimFence,
                        expected: {
                            sessionId, hostBootId: upgradeBootId, runtimeKey: record.runtimeKey, startedAt: at, ...claimFence,
                        },
                    },
                } as any);
                expect(matched).toMatchObject({ success: true, stoppedSessionIds: [sessionId] });
                expect(stops).toEqual(['stop']);
            } finally {
                await server.upgradeLease.close();
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('control.resolveHostBootId transport contract', () => {
    it('uses diagnostics.hostBootId when present without guessing', async () => {
        const calls: string[] = [];
        const plane = createSessionHostControlPlane({
            request: async <T>(type) => {
                calls.push(type);
                if (type === 'get_host_diagnostics') {
                    return { hostStartedAt: 100, endpoint: '/x', hostBootId: 'upgrade-uuid', runtimeCount: 0,
                        recentLogs: [], recentRequests: [], recentTransitions: [] } as T;
                }
                throw new Error(`unexpected:${type}`);
            },
        });
        expect(await plane.resolveHostBootId()).toBe('upgrade-uuid');
        expect(calls).toEqual(['get_host_diagnostics']);
    });

    it('proves upgrade lease when diagnostics omit hostBootId', async () => {
        const plane = createSessionHostControlPlane({
            request: async <T>(type) => {
                if (type === 'get_host_diagnostics') {
                    return { hostStartedAt: 200, endpoint: '/x', runtimeCount: 0,
                        recentLogs: [], recentRequests: [], recentTransitions: [] } as T;
                }
                if (type === 'get_upgrade_lease') return { bootId: 'lease-uuid' } as T;
                throw new Error(`unexpected:${type}`);
            },
        });
        expect(await plane.resolveHostBootId()).toBe('lease-uuid');
    });

    it('falls back to hs: when upgrade binding is unavailable', async () => {
        const plane = createSessionHostControlPlane({
            request: async <T>(type) => {
                if (type === 'get_host_diagnostics') {
                    return { hostStartedAt: 300, endpoint: '/x', runtimeCount: 0,
                        recentLogs: [], recentRequests: [], recentTransitions: [] } as T;
                }
                if (type === 'get_upgrade_lease') throw new Error('native_host_upgrade_binding_unavailable');
                throw new Error(`unexpected:${type}`);
            },
        });
        expect(await plane.resolveHostBootId()).toBe(hostBootIdFromStartedAt(300));
    });

    it('fail-closes on ambiguous upgrade-lease errors', async () => {
        const plane = createSessionHostControlPlane({
            request: async <T>(type) => {
                if (type === 'get_host_diagnostics') {
                    return { hostStartedAt: 400, endpoint: '/x', runtimeCount: 0,
                        recentLogs: [], recentRequests: [], recentTransitions: [] } as T;
                }
                if (type === 'get_upgrade_lease') throw new Error('native_host_lease_corrupt');
                throw new Error(`unexpected:${type}`);
            },
        });
        expect(await plane.resolveHostBootId()).toBeNull();
    });
});
