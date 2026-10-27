/**
 * Regression (mission b295ce35 U6): a coordinator listing the artifacts of a
 * worker session that has since STOPPED must be authorized by the mesh's
 * durable history (its queue rows), not only by live roster nodes — while a
 * session with no history in the mesh stays refused, on every ingress.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { DaemonCommandRouter, type CommandRouterDeps } from '../../src/commands/router.js';
import { attachAuthenticatedMcpCommand } from '../../src/commands/mcp-command-ingress.js';
import { setArtifactCommandRuntimeForDeps } from '../../src/commands/med-family/artifacts.js';
import { isSessionAuthorizedForMesh } from '../../src/commands/med-family/artifact-sharing.js';
import { registerMeshCoordinator, unregisterMeshCoordinator } from '../../src/mesh/coordinator-registry.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { SessionRegistry } from '../../src/sessions/registry.js';

describe('artifact list scope for stopped worker sessions', () => {
    let tempRoot: string;
    let workspace: string;
    let prevConfigDir: string | undefined;
    let meshStore: MeshRuntimeStore;
    let deps: CommandRouterDeps;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-stopped-worker-'));
        workspace = path.join(tempRoot, 'ws');
        fs.mkdirSync(workspace, { recursive: true });
        prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
        process.env.ADHDEV_CONFIG_DIR = path.join(tempRoot, 'config');
        fs.mkdirSync(process.env.ADHDEV_CONFIG_DIR, { recursive: true });
        MeshRuntimeStore.resetForTests();
        meshStore = MeshRuntimeStore.getInstance();
        deps = {
            commandHandler: { handle: async () => ({ success: true }) } as any,
            cliManager: {} as any,
            cdpManagers: new Map(),
            providerLoader: {} as any,
            instanceManager: { getInstance: () => undefined } as any,
            detectedIdes: { value: [] },
            sessionRegistry: new SessionRegistry(),
        };
        setArtifactCommandRuntimeForDeps(deps, { artifactStore: new ArtifactStore(meshStore.db), meshRuntimeStore: meshStore });
        const now = new Date().toISOString();
        meshStore.insertQueueEntry({
            id: 'task-done',
            meshId: 'mesh-1',
            message: 'fixture',
            status: 'completed',
            assignedSessionId: 'worker-stopped',
            workspace,
            createdAt: now,
            updatedAt: now,
        } as any);
        registerMeshCoordinator({ meshId: 'mesh-1', sessionId: 'coord-sess', workspace, startedAt: Date.now(), cliType: 'claude-cli' });
    });

    afterEach(() => {
        unregisterMeshCoordinator('coord-sess');
        MeshRuntimeStore.resetForTests();
        if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
        else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('treats a session with a terminal queue row as a member of that mesh only', async () => {
        const ctx = { deps, getMeshForCommand: async () => null, getCachedInlineMesh: () => undefined };
        expect(await isSessionAuthorizedForMesh(ctx, meshStore, 'mesh-1', 'worker-stopped')).toBe(true);
        expect(await isSessionAuthorizedForMesh(ctx, meshStore, 'mesh-2', 'worker-stopped')).toBe(false);
        expect(await isSessionAuthorizedForMesh(ctx, meshStore, 'mesh-1', 'never-ran-here')).toBe(false);
    });

    it('lets the verified coordinator list a stopped worker of its mesh and refuses a foreign session', async () => {
        const router = new DaemonCommandRouter(deps);
        const list = (sessionId: string) =>
            router.execute(
                'artifact_list',
                attachAuthenticatedMcpCommand(
                    { sessionId, meshId: 'mesh-1', requireMeshMembership: true },
                    'artifact_list',
                    () => true,
                    { sessionId: 'coord-sess', meshId: 'mesh-1', isCoordinator: true },
                ),
                'ipc',
            );
        const stopped: any = await list('worker-stopped');
        expect(stopped.success).toBe(true);
        expect(stopped.sessionId).toBe('worker-stopped');
        const foreign: any = await list('foreign-session');
        expect(foreign.success).toBe(false);
        expect(foreign.code).toBe('artifact_session_mismatch');
    });

    it('enforces requireMeshMembership even on owner-trusted ingress', async () => {
        const router = new DaemonCommandRouter(deps);
        (deps.sessionRegistry as SessionRegistry).register({
            sessionId: 'owner-visible',
            parentSessionId: null,
            providerType: 'claude-cli',
            transport: 'pty',
            workspace,
        });
        const plain: any = await router.execute('artifact_list', { sessionId: 'owner-visible', meshId: 'mesh-1' }, 'standalone', { ownerVerified: true });
        expect(plain.success).toBe(true);
        const scoped: any = await router.execute(
            'artifact_list',
            { sessionId: 'owner-visible', meshId: 'mesh-1', requireMeshMembership: true },
            'standalone',
            { ownerVerified: true },
        );
        expect(scoped.success).toBe(false);
        expect(scoped.code).toBe('artifact_session_mismatch');
        const noMesh: any = await router.execute(
            'artifact_list',
            { sessionId: 'owner-visible', requireMeshMembership: true },
            'standalone',
            { ownerVerified: true },
        );
        expect(noMesh.success).toBe(false);
        expect(noMesh.code).toBe('artifact_session_mismatch');
    });
});
