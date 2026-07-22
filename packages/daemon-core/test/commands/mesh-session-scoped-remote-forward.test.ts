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
    // read_terminal (MESH-READ-TERMINAL feature 2) + send_keys (MESH-SEND-KEYS feature 3) +
    // interactive_prompt_response (mesh_answer_question, mission f1d25e11): each daemon verb
    // must be in MESH_FORWARDABLE_SESSION_COMMANDS so a read/inject/answer against a REMOTE
    // worker reaches the owning daemon (which holds the live viewport / PTY / activeInteractive
    // Prompt) instead of returning 'Session not found' / 'No running instance'.
    for (const cmd of ['invoke_provider_script', 'resolve_action', 'set_mode', 'change_model', 'set_thought_level', 'set_conversation_prefs', 'read_terminal', 'send_keys', 'interactive_prompt_response']) {
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

    // RESTORE-STICK / mission 6938892f: the specific defect was that a Hide/Mute RESTORE
    // ({hidden:false} / {muted:false}) for a remote worker session hit the coordinator's
    // local-only set_conversation_prefs handler, returned 'Session not found', and the
    // dashboard silently rolled back (restore appeared to do nothing + re-hide flicker).
    // Forwarding carries the user override to the owning worker so it clears userHidden/
    // userMuted and reports a fresh surfaceHidden=false.
    it('forwards a set_conversation_prefs restore ({hidden:false, muted:false}) to the owning worker verbatim', async () => {
        const dispatch = vi.fn(async () => ({ success: true, sessionId: REMOTE_SESSION_ID, userHidden: false, userMuted: false }));
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        router.getCachedInlineMesh('mesh-session-forward', meshWithRemoteWorkerSession('daemon-remote-worker'));

        const result: any = await router.execute('set_conversation_prefs', {
            targetSessionId: REMOTE_SESSION_ID,
            hidden: false,
            muted: false,
        });

        expect(dispatch).toHaveBeenCalledTimes(1);
        const [daemonId, forwardedCmd, args] = dispatch.mock.calls[0];
        expect(daemonId).toBe('daemon-remote-worker');
        expect(forwardedCmd).toBe('set_conversation_prefs');
        expect(args._meshDirectDispatch).toBe(true);
        expect(args.targetSessionId).toBe(REMOTE_SESSION_ID);
        // The user override must survive the forward so the worker can clear it.
        expect(args.hidden).toBe(false);
        expect(args.muted).toBe(false);
        expect(result).toMatchObject({ success: true, userHidden: false, userMuted: false });
    });

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

// [Z] Multi-session worker: the inline cache reliably retains only the node's single PRIMARY
// session (cachedStatus.activeSession). A worker hosting more than one session exposes the
// non-primary ones only through the plural live-session arrays (activeSessions /
// activeSessionDetails). A controlbar/modal command targeting a non-primary remote session must
// still resolve its owner daemon via the wider plural-shape scan.
const PRIMARY_SESSION_ID = 'sess_remote_worker_primary';
const SECONDARY_SESSION_ID = 'sess_remote_worker_secondary';

function meshWithMultiSessionWorker(daemonId: string, shape: 'plural_strings' | 'plural_details') {
    const node: Record<string, unknown> = {
        id: 'node-remote-worker',
        workspace: '/remote/machine/.adhdev-worktrees/m/feat-x',
        daemonId,
        isLocalWorktree: true,
        // Singular cache only ever retains ONE (primary) session.
        cachedStatus: {
            activeSession: { id: PRIMARY_SESSION_ID, providerType: 'claude-cli', status: 'idle' },
        },
    };
    if (shape === 'plural_strings') {
        node.activeSessions = [PRIMARY_SESSION_ID, SECONDARY_SESSION_ID];
    } else {
        node.activeSessionDetails = [
            { sessionId: PRIMARY_SESSION_ID, providerType: 'claude-cli', state: 'idle' },
            { sessionId: SECONDARY_SESSION_ID, providerType: 'codex-cli', state: 'generating' },
        ];
    }
    return {
        id: 'mesh-session-forward',
        name: 'Session Forward Mesh',
        repoIdentity: 'example/repo',
        defaultBranch: 'main',
        policy: {},
        coordinator: {},
        nodes: [node],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

describe('session-scoped command — multi-session worker owner resolution ([Z])', () => {
    for (const shape of ['plural_strings', 'plural_details'] as const) {
        it(`forwards a command for a NON-primary remote session carried in ${shape}`, async () => {
            const dispatch = vi.fn(async () => ({ success: true, forwarded: true }));
            const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
            router.getCachedInlineMesh('mesh-session-forward', meshWithMultiSessionWorker('daemon-remote-worker', shape));

            // The non-primary session id is NOT in cachedStatus.activeSession — only in the plural array.
            const result: any = await router.execute('resolve_action', {
                targetSessionId: SECONDARY_SESSION_ID,
                actionId: 'approve',
            });

            expect(dispatch).toHaveBeenCalledTimes(1);
            const [daemonId, forwardedCmd, args] = dispatch.mock.calls[0];
            expect(daemonId).toBe('daemon-remote-worker');
            expect(forwardedCmd).toBe('resolve_action');
            expect(args._meshDirectDispatch).toBe(true);
            expect(args.targetSessionId).toBe(SECONDARY_SESSION_ID);
            expect(result).toMatchObject({ success: true, forwarded: true });
        });
    }

    it('still resolves the PRIMARY session from the singular cache (regression guard)', async () => {
        const dispatch = vi.fn(async () => ({ success: true, forwarded: true }));
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        router.getCachedInlineMesh('mesh-session-forward', meshWithMultiSessionWorker('daemon-remote-worker', 'plural_strings'));

        await router.execute('invoke_provider_script', { targetSessionId: PRIMARY_SESSION_ID, scriptName: 'setModel' });

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0][0]).toBe('daemon-remote-worker');
    });

    it('does NOT forward a non-primary session hosted by THIS coordinator (locally-hosted worker)', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        router.getCachedInlineMesh('mesh-session-forward', meshWithMultiSessionWorker('daemon-coordinator', 'plural_details'));

        await router.execute('resolve_action', { targetSessionId: SECONDARY_SESSION_ID, actionId: 'approve' });

        expect(dispatch).not.toHaveBeenCalled();
    });
});

// CANCEL-STOP-RELAY: the live cancel-stop failure — a worktree-clone worker whose session id
// missed the coordinator's cached active-sessions snapshot (id-form mismatch / cache lag). The
// session-id scan misses, so the stop used to silently NOT forward. mesh_queue_cancel ships the
// authoritative owning nodeId in meshContext.nodeId; the router now uses it as a deterministic
// owner-resolution fallback (match the node by id, read its daemonId) so the stop still reaches
// the remote worker. The self-loopback guard applies to the fallback path too.
function meshWorkerNodeNoCachedSession(daemonId: string) {
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
                // NO cachedStatus.activeSession and NO plural session arrays — the worker's
                // session id is simply not reflected in the coordinator's cache yet.
            },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

describe('agent_command/stop — deterministic nodeId-hint owner fallback (CANCEL-STOP-RELAY)', () => {
    const UNCACHED_SESSION_ID = 'sess_worktree_worker_uncached';

    it('forwards stop via meshContext.nodeId when the session id missed the cache', async () => {
        const dispatch = vi.fn(async () => ({ success: true, stopped: true }));
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        router.getCachedInlineMesh('mesh-session-forward', meshWorkerNodeNoCachedSession('daemon-remote-worker'));

        const result: any = await router.execute('agent_command', {
            targetSessionId: UNCACHED_SESSION_ID, // NOT in any cached active-sessions shape
            agentType: 'claude-cli',
            action: 'stop',
            meshContext: { meshId: 'mesh-session-forward', nodeId: 'node-remote-worker' },
        });

        expect(dispatch).toHaveBeenCalledTimes(1);
        const [daemonId, forwardedCmd, args] = dispatch.mock.calls[0];
        expect(daemonId).toBe('daemon-remote-worker');
        expect(forwardedCmd).toBe('agent_command');
        expect(args.action).toBe('stop');
        expect(args._meshDirectDispatch).toBe(true);
        expect(result).toMatchObject({ success: true, stopped: true });
    });

    it('self-loopback guard holds on the nodeId-hint path (owner node is THIS coordinator)', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        // Owning node's daemonId == this coordinator → fallback must resolve to undefined → no forward.
        router.getCachedInlineMesh('mesh-session-forward', meshWorkerNodeNoCachedSession('daemon-coordinator'));

        await router.execute('agent_command', {
            targetSessionId: UNCACHED_SESSION_ID,
            agentType: 'claude-cli',
            action: 'stop',
            meshContext: { meshId: 'mesh-session-forward', nodeId: 'node-remote-worker' },
        });

        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does NOT forward when neither the session id nor a nodeId hint resolves an owner', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        router.getCachedInlineMesh('mesh-session-forward', meshWorkerNodeNoCachedSession('daemon-remote-worker'));

        // No meshContext.nodeId hint and the session id is uncached → fall through to local handling.
        await router.execute('agent_command', {
            targetSessionId: UNCACHED_SESSION_ID,
            agentType: 'claude-cli',
            action: 'stop',
        });

        expect(dispatch).not.toHaveBeenCalled();
    });
});
