/**
 * RF-ROUTER MED family — fast-forward / refine convergence commands.
 *
 * mesh_init, plan_mesh_refine_node, fast_forward_mesh_node, refine_mesh_node and
 * batch_refine_mesh_nodes. These resolve the target node, forward to the owning
 * daemon when the node is remote, and run (or plan) the fast-forward / refine
 * convergence. Extracted verbatim from executeDaemonCommand; the async execute
 * paths delegate back to the router's refine-job starters via ctx.
 */
import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { fastForwardMeshNode } from '../../mesh/mesh-fast-forward.js';
import { runMeshInit } from '../../mesh/mesh-init.js';
import { detectCLIs } from '../../detection/cli-detector.js';
import { buildMeshRefineValidationPlan } from '../router.js';
import type { CommandRouterResult } from '../router.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';

export const fastForwardHandlers: Record<string, MedFamilyHandler> = {
    mesh_init: async (ctx: MedFamilyContext, args: any) => {
        const workspace = typeof args?.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : process.cwd();
        const mesh = args?.inlineMesh || {};
        try {
            const detected = await detectCLIs(ctx.deps.providerLoader, { includeVersion: true });
            return { ...runMeshInit(mesh, workspace, detected, {
                write: args?.write === true,
                overwrite: args?.overwrite === true,
            }) };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    },

    plan_mesh_refine_node: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
        if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
        // preferInline: plan is the dry-run sibling of refine — clone nodes must resolve.
        const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
        const mesh = meshRecord?.mesh;
        const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
        if (!node?.workspace) return { success: false, error: `Node '${nodeId}' workspace not found` };
        return {
            success: true,
            dryRun: true,
            nodeId,
            workspace: node.workspace,
            validationPlan: buildMeshRefineValidationPlan(mesh, node.workspace),
            mergeWillRun: false,
            cleanupWillRun: false,
        };
    },

    fast_forward_mesh_node: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
        let workspace = typeof args?.workspace === 'string' ? args.workspace.trim() : '';
        let submoduleIgnorePaths = Array.isArray(args?.submoduleIgnorePaths)
            ? args.submoduleIgnorePaths.filter((value: unknown): value is string => typeof value === 'string')
            : undefined;
        let nodeDaemonId: string | undefined;
        let allowAutoPublishSubmoduleMainCommits = false;
        if (meshId && nodeId) {
            // preferInline so fast-forward can resolve inline-cache-only clone worktree nodes.
            const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const mesh = meshRecord?.mesh;
            const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
            if (!workspace) {
                workspace = typeof node?.workspace === 'string' ? node.workspace.trim() : '';
            }
            if (!submoduleIgnorePaths && Array.isArray(node?.policy?.submoduleIgnorePaths)) {
                submoduleIgnorePaths = node.policy.submoduleIgnorePaths.filter((value: unknown): value is string => typeof value === 'string');
            }
            allowAutoPublishSubmoduleMainCommits = mesh?.policy?.allowAutoPublishSubmoduleMainCommits === true;
            nodeDaemonId = typeof node?.daemonId === 'string' ? node.daemonId.trim() : undefined;
        }
        // If the target node belongs to a remote daemon, forward the command there.
        // _meshDirectDispatch prevents re-forwarding (and P2P self-dial) when the stored
        // daemonId uses a legacy format that doesn't match the receiving daemon's identity.
        const selfDaemonId = ctx.deps.statusInstanceId;
        // daemonIdsEquivalent: a legacy-form stored daemonId that resolves to THIS
        // machine's core must be treated as local (not remote) so it is not forwarded /
        // P2P self-dialed. Equivalent → local.
        const isRemote = nodeDaemonId && selfDaemonId && !daemonIdsEquivalent(nodeDaemonId, selfDaemonId);
        if (isRemote && ctx.deps.dispatchMeshCommand && !args?._meshDirectDispatch) {
            const forwarded = await ctx.deps.dispatchMeshCommand(nodeDaemonId!, 'fast_forward_mesh_node', {
                ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                workspace,
                _meshDirectDispatch: true,
            });
            return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
        }
        const result = await (fastForwardMeshNode({
            meshId: meshId || undefined,
            nodeId: nodeId || undefined,
            workspace,
            branch: typeof args?.branch === 'string' ? args.branch : undefined,
            execute: args?.execute === true,
            dryRun: args?.dryRun === true,
            updateSubmodules: args?.updateSubmodules === true,
            submoduleIgnorePaths,
            mode: args?.mode === 'push' ? 'push' : 'merge',
            pushSubmodules: args?.pushSubmodules === true,
            allowAutoPublishSubmoduleMainCommits,
        }) as Promise<unknown>);
        return result as CommandRouterResult;
    },

    refine_mesh_node: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
        if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };

        // Remote forward: a worktree node lives on its OWN daemon's machine, so the
        // refine (cd into node.workspace, merge → push → cleanup) must run on THAT
        // daemon — not the coordinator, whose filesystem has no such path. The sibling
        // fast_forward_mesh_node / clone_mesh_node handlers already forward to the
        // node's daemon; refine_mesh_node was the gap (the coordinator would cd into a
        // non-existent local path and fail), so remote-machine worktrees could not be
        // converged at all. Forward both dry-run (plan reads the worktree git state)
        // and execute (async merge job) so the same machine that owns the worktree
        // resolves it.
        //
        // coordinatorDaemonId: refine is ASYNC — the completed/failed event is queued
        // on the executing daemon's pending-events queue scoped to a coordinator id and
        // recovered by the coordinator's reconcile loop (pullRemoteNodeQueues →
        // get_pending_mesh_events). Without stamping our own status id, the remote
        // daemon would fall back to ITS OWN statusInstanceId as the coordinator
        // (startMeshRefineJob), scoping the terminal event to the wrong inbox where the
        // real coordinator never pulls it. Stamp the canonical status id (which is in
        // the coordinator's self-identity set used to scope the remote drain) so the
        // event routes back here. Preserve any caller-supplied coordinatorDaemonId.
        //
        // _meshDirectDispatch prevents re-forwarding (and P2P self-dial) once the call
        // has landed on the owning daemon — that daemon then executes locally even if
        // the stored daemonId uses a legacy form that doesn't match its own identity.
        {
            const meshRecordForForward = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const forwardNode = meshRecordForForward?.mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
            const nodeDaemonId = typeof forwardNode?.daemonId === 'string' ? forwardNode.daemonId.trim() : undefined;
            const selfDaemonId = ctx.deps.statusInstanceId;
            // daemonIdsEquivalent: a legacy-form daemonId resolving to this machine's core
            // is local — execute locally instead of forwarding. Equivalent → local.
            const isRemote = nodeDaemonId && selfDaemonId && !daemonIdsEquivalent(nodeDaemonId, selfDaemonId);
            if (isRemote && ctx.deps.dispatchMeshCommand && !args?._meshDirectDispatch) {
                const callerCoordinatorDaemonId = typeof args?.coordinatorDaemonId === 'string' && args.coordinatorDaemonId.trim()
                    ? args.coordinatorDaemonId.trim()
                    : undefined;
                const forwarded = await ctx.deps.dispatchMeshCommand(nodeDaemonId!, 'refine_mesh_node', {
                    ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                    coordinatorDaemonId: callerCoordinatorDaemonId || selfDaemonId,
                    _meshDirectDispatch: true,
                });
                return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
            }
        }

        // Dry-run (plan-only) is the default and stays synchronous: it does no
        // validation/merge/push and returns the plan instantly. Only execute=true
        // (and not dry_run) goes through the async refine job that actually
        // validates → merges → pushes → cleans up. Mirrors the
        // batch_refine_mesh_nodes / fast_forward_mesh_node dry_run/execute contract.
        const isDryRun = args?.dryRun !== false && args?.execute !== true;
        if (isDryRun) {
            // preferInline: plan is the dry-run sibling of refine — clone nodes must resolve.
            const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const mesh = meshRecord?.mesh;
            const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
            if (!node?.workspace) return { success: false, error: `Node '${nodeId}' workspace not found` };
            return {
                success: true,
                dryRun: true,
                nodeId,
                workspace: node.workspace,
                validationPlan: buildMeshRefineValidationPlan(mesh, node.workspace),
                mergeWillRun: false,
                cleanupWillRun: false,
                hint: 'Dry-run only — no merge/push/cleanup performed. Re-invoke with execute:true to converge this node.',
            };
        }
        return ctx.startMeshRefineJob(meshId, nodeId, args);
    },

    batch_refine_mesh_nodes: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        const requestedNodeIds = Array.isArray(args?.nodeIds)
            ? (args.nodeIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())
            : undefined;
        // Dry-run (plan-only) stays synchronous: it does no validation/merge and
        // returns instantly. Execute goes through the async batch job — immediate
        // {async:true, status:'accepted'} + background convergence + terminal event,
        // matching the single-node refine_mesh_node contract so long validation
        // suites can't time out the IPC and strand the coordinator.
        const isDryRun = args?.dryRun !== false && args?.execute !== true;
        if (isDryRun) return ctx.batchRefineMeshNodes(meshId, requestedNodeIds, args);
        return ctx.startMeshRefineBatchJob(meshId, requestedNodeIds, args);
    },
};
