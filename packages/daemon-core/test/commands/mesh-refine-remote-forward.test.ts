import { describe, expect, it, vi } from 'vitest';

import { DaemonCommandRouter } from '../../src/commands/router';

// Build a router with a controllable statusInstanceId (this daemon's identity) and a
// spy dispatchMeshCommand so we can observe whether refine_mesh_node forwards to a
// remote daemon. The router never reaches real git here — every forwarded call is
// intercepted by the spy, and the local-execution path is exercised only by the
// _meshDirectDispatch guard test (which we short-circuit before git via a node that
// declares no usable workspace, asserting the error comes from local handling, not a
// forward).
function createRouter(opts: {
    statusInstanceId?: string;
    dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
}) {
    return new DaemonCommandRouter({
        commandHandler: { handle: async () => ({ success: false }) } as any,
        cliManager: {} as any,
        cdpManagers: new Map(),
        providerLoader: {} as any,
        instanceManager: {
            collectAllStates: () => [],
            listInstanceIds: () => [],
            getInstance: () => null,
            getByCategory: () => [],
        } as any,
        detectedIdes: { value: [] },
        sessionRegistry: {} as any,
        packageName: 'adhdev',
        statusVersion: '0.9.76',
        statusInstanceId: opts.statusInstanceId,
        dispatchMeshCommand: opts.dispatchMeshCommand,
    } as any);
}

function meshWith(nodes: any[]) {
    return {
        id: 'mesh-refine-forward',
        name: 'Refine Forward Mesh',
        repoIdentity: 'example/repo',
        defaultBranch: 'main',
        policy: {},
        coordinator: {},
        nodes,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

describe('refine_mesh_node — remote forward guard (Part A)', () => {
    const remoteWorktreeNode = {
        id: 'node-remote-wt',
        workspace: '/remote/machine/.adhdev-worktrees/m/feat-x',
        repoRoot: '/remote/machine/.adhdev-worktrees/m/feat-x',
        daemonId: 'daemon-remote',
        isLocalWorktree: true,
        worktreeBranch: 'feat/x',
        clonedFromNodeId: 'node-source',
        policy: {},
        userOverrides: {},
    };
    const sourceNode = { id: 'node-source', workspace: '/remote/machine/repo', repoRoot: '/remote/machine/repo', daemonId: 'daemon-remote', policy: {} };

    it('forwards an EXECUTE refine for a remote-daemon worktree to that daemon, stamping the coordinator id', async () => {
        const dispatch = vi.fn(async () => ({ success: true, async: true, status: 'accepted', jobId: 'refine_x' }));
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        const mesh = meshWith([sourceNode, remoteWorktreeNode]);

        const result: any = await router.execute('refine_mesh_node', {
            meshId: mesh.id,
            nodeId: 'node-remote-wt',
            execute: true,
            inlineMesh: mesh,
        });

        expect(dispatch).toHaveBeenCalledTimes(1);
        const [daemonId, cmd, args] = dispatch.mock.calls[0];
        expect(daemonId).toBe('daemon-remote');
        expect(cmd).toBe('refine_mesh_node');
        expect(args._meshDirectDispatch).toBe(true);
        // Async completion events must route back to THIS coordinator's inbox.
        expect(args.coordinatorDaemonId).toBe('daemon-coordinator');
        expect(args.nodeId).toBe('node-remote-wt');
        expect(args.execute).toBe(true);
        // The forwarded daemon's response is returned verbatim.
        expect(result).toMatchObject({ success: true, status: 'accepted', jobId: 'refine_x' });
    });

    it('forwards a DRY-RUN refine for a remote-daemon worktree (plan reads remote git state)', async () => {
        const dispatch = vi.fn(async () => ({ success: true, dryRun: true, nodeId: 'node-remote-wt' }));
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        const mesh = meshWith([sourceNode, remoteWorktreeNode]);

        await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-remote-wt', inlineMesh: mesh });

        expect(dispatch).toHaveBeenCalledTimes(1);
        const [, cmd, args] = dispatch.mock.calls[0];
        expect(cmd).toBe('refine_mesh_node');
        expect(args._meshDirectDispatch).toBe(true);
        expect(args.coordinatorDaemonId).toBe('daemon-coordinator');
    });

    it('preserves a caller-supplied coordinatorDaemonId across the forward', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        const mesh = meshWith([sourceNode, remoteWorktreeNode]);

        await router.execute('refine_mesh_node', {
            meshId: mesh.id,
            nodeId: 'node-remote-wt',
            execute: true,
            inlineMesh: mesh,
            coordinatorDaemonId: 'daemon-original-coordinator',
        });

        const [, , args] = dispatch.mock.calls[0];
        expect(args.coordinatorDaemonId).toBe('daemon-original-coordinator');
    });

    it('does NOT forward when the worktree node belongs to THIS daemon (local refine)', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        // statusInstanceId matches the node's daemonId → local path, no forward. The
        // local path then fails at startMeshRefineJob (node has no real workspace), which
        // is fine — the point is dispatch was never called.
        const localNode = { ...remoteWorktreeNode, daemonId: 'daemon-coordinator', workspace: '' };
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        const mesh = meshWith([{ ...sourceNode, daemonId: 'daemon-coordinator' }, localNode]);

        const result: any = await router.execute('refine_mesh_node', {
            meshId: mesh.id,
            nodeId: 'node-remote-wt',
            execute: true,
            inlineMesh: mesh,
        });

        expect(dispatch).not.toHaveBeenCalled();
        // Local handling reached (and rejected the empty workspace) — not a forward.
        expect(result).toMatchObject({ success: false });
    });

    it('does NOT re-forward an already-forwarded call (_meshDirectDispatch guard prevents loop)', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        // Even though the node is remote relative to this daemon, _meshDirectDispatch
        // means the call already landed here for local execution — it must NOT bounce
        // back out. It proceeds to local handling (which rejects the empty workspace).
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: dispatch });
        const mesh = meshWith([sourceNode, { ...remoteWorktreeNode, workspace: '' }]);

        const result: any = await router.execute('refine_mesh_node', {
            meshId: mesh.id,
            nodeId: 'node-remote-wt',
            execute: true,
            inlineMesh: mesh,
            _meshDirectDispatch: true,
        });

        expect(dispatch).not.toHaveBeenCalled();
        expect(result).toMatchObject({ success: false });
    });

    it('does NOT forward when no dispatchMeshCommand transport is available (standalone)', async () => {
        const router = createRouter({ statusInstanceId: 'daemon-coordinator', dispatchMeshCommand: undefined });
        const mesh = meshWith([sourceNode, { ...remoteWorktreeNode, workspace: '' }]);

        const result: any = await router.execute('refine_mesh_node', {
            meshId: mesh.id,
            nodeId: 'node-remote-wt',
            execute: true,
            inlineMesh: mesh,
        });

        // No transport → falls through to local handling (rejects empty workspace).
        expect(result).toMatchObject({ success: false });
    });
});
