// Mesh tool implementations — git domain.
// Pure move out of mesh-tools.ts (no behavior change). Shared helpers, types, module
// state and dependency re-exports live in ./mesh-tools-internal.ts; mesh-tools.ts is a barrel.

import {
    IpcTransport,
    appendLedgerEntry,
    buildCoordinatorP2pRelayFailure,
    buildRemoveNodeArgs,
    collectRelatedRepoStatuses,
    commandForNode,
    extractCloneNodePayload,
    extractGitDiff,
    extractGitStatus,
    extractSubmodules,
    findNodeWithRefresh,
    isP2pTransportUnavailableError,
    refreshMeshFromDaemon,
    syncCoordinatorDaemonMeshCache,
    unwrapCommandPayload,
} from './mesh-tools-internal.js';
import type {
    MeshContext,
} from './mesh-tools-internal.js';

export async function meshGitStatus(
    ctx: MeshContext,
    args: { node_id: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    // Determine submodule options from node policy
    const autoDiscoverSubmodules = (node.policy as any)?.autoDiscoverSubmodules !== false;
    const submoduleIgnorePaths = (node.policy as any)?.submoduleIgnorePaths || [];

    try {
        const statusResult = await commandForNode(ctx, node, 'git_status', {
            workspace: node.workspace,
            refreshUpstream: true,
            includeSubmodules: autoDiscoverSubmodules,
            submoduleIgnorePaths: submoduleIgnorePaths.length > 0 ? submoduleIgnorePaths : undefined,
        });
        const diffResult = await commandForNode(ctx, node, 'git_diff_summary', {
            workspace: node.workspace,
        });
        return JSON.stringify({
            nodeId: args.node_id,
            workspace: node.workspace,
            status: extractGitStatus(statusResult),
            diff: extractGitDiff(diffResult),
            submodules: autoDiscoverSubmodules ? extractSubmodules(statusResult, submoduleIgnorePaths) : undefined,
            relatedRepos: await collectRelatedRepoStatuses(ctx, node),
        }, null, 2);
    } catch (e: any) {
        const failure = buildCoordinatorP2pRelayFailure(e, {
            command: 'git_status',
            targetDaemonId: node.daemonId,
            nodeId: args.node_id,
        });
        return JSON.stringify({
            ...failure,
            workspace: node.workspace,
        }, null, 2);
    }
}

export async function meshReadNodeLogs(
    ctx: MeshContext,
    args: { node_id: string; grep?: string; since_ms?: number; tail_bytes?: number; date?: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);
    try {
        const result = await commandForNode(ctx, node, 'get_mesh_node_logs', {
            meshId: ctx.mesh.id,
            nodeId: args.node_id,
            ...(typeof args.grep === 'string' && args.grep.trim() ? { grep: args.grep.trim() } : {}),
            ...(Number.isFinite(args.since_ms) ? { sinceMs: args.since_ms } : {}),
            ...(Number.isFinite(args.tail_bytes) ? { tailBytes: args.tail_bytes } : {}),
            ...(typeof args.date === 'string' && args.date.trim() ? { date: args.date.trim() } : {}),
        });
        const payload = unwrapCommandPayload(result);
        return JSON.stringify(payload, null, 2);
    } catch (e: any) {
        const failure = buildCoordinatorP2pRelayFailure(e, {
            command: 'get_mesh_node_logs',
            targetDaemonId: node.daemonId,
            nodeId: args.node_id,
        });
        return JSON.stringify(failure, null, 2);
    }
}

export async function meshFastForwardNode(
    ctx: MeshContext,
    args: { node_id: string; mode?: 'merge' | 'push'; branch?: string; execute?: boolean; dry_run?: boolean; update_submodules?: boolean; push_submodules?: boolean },
): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    const node = await findNodeWithRefresh(ctx, args.node_id);
    const submoduleIgnorePaths = (node.policy as any)?.submoduleIgnorePaths || [];

    if (node.policy?.readOnly) {
        return JSON.stringify({
            success: false,
            code: 'node_read_only',
            nodeId: args.node_id,
            workspace: node.workspace,
            allowed: false,
            willRun: false,
            executed: false,
            blockingReasons: ['node_read_only'],
        }, null, 2);
    }

    try {
        const dryRun = args.dry_run === true || args.execute !== true;
        const result = await commandForNode(ctx, node, 'fast_forward_mesh_node', {
            meshId: ctx.mesh.id,
            nodeId: node.id,
            workspace: node.workspace,
            mode: args.mode === 'push' ? 'push' : 'merge',
            branch: typeof args.branch === 'string' ? args.branch : undefined,
            execute: args.execute === true && args.dry_run !== true,
            dryRun,
            updateSubmodules: args.update_submodules === true,
            pushSubmodules: args.push_submodules === true,
            submoduleIgnorePaths: submoduleIgnorePaths.length > 0 ? submoduleIgnorePaths : undefined,
        });
        return JSON.stringify(unwrapCommandPayload(result), null, 2);
    } catch (e: any) {
        const failure = buildCoordinatorP2pRelayFailure(e, {
            command: 'fast_forward_mesh_node',
            targetDaemonId: node.daemonId,
            nodeId: args.node_id,
        });
        return JSON.stringify({
            ...failure,
            workspace: node.workspace,
            allowed: false,
            willRun: false,
            executed: false,
            blockingReasons: [failure.code || 'mesh_fast_forward_unavailable'],
        }, null, 2);
    }
}

export async function meshRestartDaemon(
    ctx: MeshContext,
    args: {
        node_id: string;
        channel?: 'stable' | 'preview';
        mode?: 'upgrade' | 'restart';
        force?: boolean;
        self_only?: boolean;
        when_idle?: boolean;
        cancel_when_idle?: boolean;
        timeout_ms?: number;
        kill_session_host?: boolean;
    },
): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    const node = await findNodeWithRefresh(ctx, args.node_id);

    try {
        // inlineMesh lets the owning daemon resolve this node for the
        // remote-forward guard; channel is forwarded only when explicitly set so
        // an unset call keeps the daemon on its configured channel. The opt-in
        // gate overrides are forwarded only when set so a bare call is
        // byte-identical to the pre-extension behavior.
        const result = await commandForNode(ctx, node, 'restart_daemon_node', {
            meshId: ctx.mesh.id,
            nodeId: node.id,
            inlineMesh: ctx.mesh,
            ...(args.channel ? { channel: args.channel } : {}),
            ...(args.mode ? { mode: args.mode } : {}),
            ...(args.force === true ? { force: true } : {}),
            ...(args.self_only === true ? { selfOnly: true } : {}),
            ...(args.when_idle === true ? { whenIdle: true } : {}),
            ...(args.cancel_when_idle === true ? { cancelWhenIdle: true } : {}),
            ...(typeof args.timeout_ms === 'number' ? { timeoutMs: args.timeout_ms } : {}),
            ...(args.kill_session_host === true ? { killSessionHost: true } : {}),
        });
        return JSON.stringify(unwrapCommandPayload(result), null, 2);
    } catch (e: any) {
        const failure = buildCoordinatorP2pRelayFailure(e, {
            command: 'restart_daemon_node',
            targetDaemonId: node.daemonId,
            nodeId: args.node_id,
        });
        return JSON.stringify(failure, null, 2);
    }
}

export async function meshCheckpoint(
    ctx: MeshContext,
    args: { node_id: string; message: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    // Policy checks
    if (node.policy?.readOnly) {
        return JSON.stringify({ error: `Node '${args.node_id}' is read-only — cannot checkpoint` });
    }

    const result = await commandForNode(ctx, node, 'git_checkpoint', {
        workspace: node.workspace,
        message: args.message,
        includeUntracked: true,
    });

    // Record checkpoint in ledger
    try {
        appendLedgerEntry(ctx.mesh.id, {
            kind: 'checkpoint_created',
            nodeId: args.node_id,
            payload: {
                message: args.message,
                commit: (result as any)?.checkpoint?.commit,
                outcome: (result as any)?.checkpoint?.status || ((result as any)?.checkpoint?.noop ? 'skipped' : undefined),
                noop: (result as any)?.checkpoint?.noop === true,
                reason: (result as any)?.checkpoint?.reason,
            },
        });
    } catch { /* ledger append is best-effort */ }

    return JSON.stringify(result, null, 2);
}

export async function meshCloneNode(
    ctx: MeshContext,
    args: { source_node_id: string; branch: string; base_branch?: string },
): Promise<string> {
    const sourceNode = await findNodeWithRefresh(ctx, args.source_node_id);

    const result = await commandForNode(ctx, sourceNode, 'clone_mesh_node', {
        meshId: ctx.mesh.id,
        sourceNodeId: args.source_node_id,
        branch: args.branch,
        baseBranch: args.base_branch,
        inlineMesh: ctx.mesh,
    });
    const clonePayload = extractCloneNodePayload(result);
    if (clonePayload?.success && clonePayload.node?.id) {
        const existingIndex = ctx.mesh.nodes.findIndex(n => n.id === clonePayload.node.id);
        if (existingIndex >= 0) ctx.mesh.nodes[existingIndex] = clonePayload.node;
        else ctx.mesh.nodes.push(clonePayload.node);
        ctx.mesh.updatedAt = new Date().toISOString();
        await syncCoordinatorDaemonMeshCache(ctx);
    }
    return JSON.stringify(result, null, 2);
}

export async function meshRemoveNode(
    ctx: MeshContext,
    args: { node_id: string; session_cleanup_mode?: string; force?: boolean },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    const removeArgs = buildRemoveNodeArgs(ctx, args.node_id, args.session_cleanup_mode, args.force === true);
    let result: any;
    let transportFallback: Record<string, unknown> | undefined;
    try {
        result = await commandForNode(ctx, node, 'remove_mesh_node', removeArgs);
    } catch (e: any) {
        if (ctx.transport instanceof IpcTransport && (node as any).isLocalWorktree && isP2pTransportUnavailableError(e)) {
            result = await ctx.transport.command('remove_mesh_node', removeArgs);
            transportFallback = {
                from: 'p2p_mesh_relay',
                to: 'local_control_plane',
                reason: e?.message || String(e),
            };
        } else {
            return JSON.stringify({
                success: false,
                code: isP2pTransportUnavailableError(e) ? 'p2p_unavailable' : 'mesh_remove_node_failed',
                error: e?.message || String(e),
                recoveryHint: isP2pTransportUnavailableError(e)
                    ? 'If this is an ADHDev-managed local worktree, retry from a coordinator connected to the daemon that owns the worktree; dashboard command/data-plane traffic still requires P2P.'
                    : 'Inspect mesh_status and retry after resolving the reported failure.',
            }, null, 2);
        }
    }
    if (result?.success && result.removed !== false) {
        const idx = ctx.mesh.nodes.findIndex(n => n.id === args.node_id);
        if (idx >= 0) {
            ctx.mesh.nodes.splice(idx, 1);
            ctx.mesh.updatedAt = new Date().toISOString();
        }
    }
    return JSON.stringify({ ...(result || {}), ...(transportFallback ? { transportFallback } : {}) }, null, 2);
}
