import { describe, expect, it, vi } from 'vitest';

import { DaemonCommandRouter } from '../../src/commands/router';

// [Z] Session-scoped commands (controlbar Model/Mode → invoke_provider_script, modal
// approval → resolve_action, set_mode/change_model/set_thought_level) issued from the
// dashboard against a REMOTE mesh worker session must be forwarded to the owning worker
// daemon. The coordinator does not host the remote worker's live instance, so without
// the forward the command dies as "Live session not found" and the controlbar appears
// to do nothing. send_chat already reaches the worker by its own route; this closes the
// gap for the controlbar/modal commands by mirroring the node-level remote-forward
// pattern (refine_mesh_node etc.).

function createRouter(opts: {
    statusInstanceId?: string;
    dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    getInstance?: (id: string) => unknown;
    sessionRegistryGet?: (id: string) => unknown;
}) {
    return new DaemonCommandRouter({
        commandHandler: { handle: async () => ({ success: false, error: 'Live session not found' }) } as any,
        cliManager: { handleCliCommand: async () => ({ success: false }) } as any,
        cdpManagers: new Map(),
        providerLoader: {} as any,
        instanceManager: {
            collectAllStates: () => [],
            listInstanceIds: () => [],
            getInstance: (id: string) => (opts.getInstance ? opts.getInstance(id) : null),
            getByCategory: () => [],
        } as any,
        detectedIdes: { value: [] },
        sessionRegistry: { get: (id: string) => (opts.sessionRegistryGet ? opts.sessionRegistryGet(id) : undefined) } as any,
        packageName: 'adhdev',
        statusVersion: '0.9.76',
        statusInstanceId: opts.statusInstanceId,
        dispatchMeshCommand: opts.dispatchMeshCommand,
    } as any);
}

const REMOTE_SESSION_ID = 'sess_remote_worker_1';

function meshWithRemoteWorkerSession(daemonId: string) {
    return {
        id: 'mesh-session-forward',
        name: 'Session Forward Mesh',
        repoIdentity: 'example/repo',
        defaultBranch: 'main',
        policy: {},
        coordinator: {},
        nodes: [
            {
                id: 'node-remote-worker',
                workspace: '/remote/machine/.adhdev-worktrees/m/feat-x',
                daemonId,
                isLocalWorktree: true,
                cachedStatus: {
                    activeSession: { id: REMOTE_SESSION_ID, providerType: 'claude-cli', status: 'idle' },
                },
            },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

describe('session-scoped command — remote mesh worker forward ([Z])', () => {
    for (const cmd of ['invoke_provider_script', 'resolve_action', 'set_mode', 'change_model', 'set_thought_level']) {
        it(`forwards ${cmd} for a remote worker session to the owning worker daemon`, async () => {
            const dispatch = vi.fn(async () => ({ success: true, forwarded: true }));
            const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
            // Warm the inline-mesh cache so the forward branch can resolve the owner daemon.
            router.getCachedInlineMesh('mesh-session-forward', meshWithRemoteWorkerSession('daemon-remote-worker'));

            const result: any = await router.execute(cmd, {
                targetSessionId: REMOTE_SESSION_ID,
                scriptName: 'setModel',
                value: 'opus',
            });

            expect(dispatch).toHaveBeenCalledTimes(1);
            const [daemonId, forwardedCmd, args] = dispatch.mock.calls[0];
            expect(daemonId).toBe('daemon-remote-worker');
            expect(forwardedCmd).toBe(cmd);
            expect(args._meshDirectDispatch).toBe(true);
            expect(args.targetSessionId).toBe(REMOTE_SESSION_ID);
            // The worker daemon's response is returned verbatim.
            expect(result).toMatchObject({ success: true, forwarded: true });
        });
    }

    it('does NOT forward when the session is hosted LOCALLY on this coordinator (regression guard)', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        // A live local instance exists for the session → the command must be handled
        // locally (delegated to the CommandHandler), never forwarded.
        const router = createRouter({
            statusInstanceId: 'daemon-coordinator',
            dispatchMeshCommand: dispatch,
            getInstance: (id) => (id === REMOTE_SESSION_ID ? { getState: () => ({}) } : null),
        });
        router.getCachedInlineMesh('mesh-session-forward', meshWithRemoteWorkerSession('daemon-remote-worker'));

        await router.execute('invoke_provider_script', { targetSessionId: REMOTE_SESSION_ID, scriptName: 'setModel' });

        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does NOT forward when the owning node is THIS coordinator (locally-hosted worker)', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        // Owner node daemonId == this daemon → resolve returns undefined → no forward.
        router.getCachedInlineMesh('mesh-session-forward', meshWithRemoteWorkerSession('daemon-coordinator'));

        await router.execute('invoke_provider_script', { targetSessionId: REMOTE_SESSION_ID, scriptName: 'setModel' });

        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does NOT re-forward an already-forwarded call (_meshDirectDispatch loop guard)', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        router.getCachedInlineMesh('mesh-session-forward', meshWithRemoteWorkerSession('daemon-remote-worker'));

        await router.execute('invoke_provider_script', {
            targetSessionId: REMOTE_SESSION_ID,
            scriptName: 'setModel',
            _meshDirectDispatch: true,
        });

        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does NOT forward send_chat (it reaches the worker by its own route)', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        router.getCachedInlineMesh('mesh-session-forward', meshWithRemoteWorkerSession('daemon-remote-worker'));

        await router.execute('send_chat', { targetSessionId: REMOTE_SESSION_ID, message: 'hi' });

        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does NOT forward when no transport is available (standalone)', async () => {
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: undefined });
        router.getCachedInlineMesh('mesh-session-forward', meshWithRemoteWorkerSession('daemon-remote-worker'));

        const result: any = await router.execute('invoke_provider_script', {
            targetSessionId: REMOTE_SESSION_ID,
            scriptName: 'setModel',
        });

        // No transport → falls through to local handling (session-not-found).
        expect(result).toMatchObject({ success: false });
    });

    it('does NOT forward when the target session is not a known remote worker', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        router.getCachedInlineMesh('mesh-session-forward', meshWithRemoteWorkerSession('daemon-remote-worker'));

        await router.execute('invoke_provider_script', { targetSessionId: 'sess_unknown', scriptName: 'setModel' });

        expect(dispatch).not.toHaveBeenCalled();
    });
});
