// Mesh tool implementations — refine domain.
// Pure move out of mesh-tools.ts (no behavior change). Shared helpers, types, module
// state and dependency re-exports live in ./mesh-tools-internal.ts; mesh-tools.ts is a barrel.

import {
    commandForNode,
    findNodeWithRefresh,
    refreshMeshFromDaemon,
    resolveRefineConfigNode,
    unwrapCommandPayload,
} from './mesh-tools-internal.js';
import type {
    MeshContext,
} from './mesh-tools-internal.js';

export async function meshRefineConfigSchema(ctx: MeshContext): Promise<string> {
    const node = resolveRefineConfigNode(ctx);
    const result = await commandForNode(ctx, node, 'get_mesh_refine_config_schema', {});
    return JSON.stringify(result, null, 2);
}

export async function meshValidateRefineConfig(
    ctx: MeshContext,
    args: { node_id?: string; config?: Record<string, unknown> },
): Promise<string> {
    const node = resolveRefineConfigNode(ctx, args.node_id);
    const result = await commandForNode(ctx, node, 'validate_mesh_refine_config', {
        workspace: node.workspace,
        inlineMesh: ctx.mesh,
        ...(args.config ? { config: args.config } : {}),
    });
    return JSON.stringify(result, null, 2);
}

export async function meshSuggestRefineConfig(
    ctx: MeshContext,
    args: { node_id?: string },
): Promise<string> {
    const node = resolveRefineConfigNode(ctx, args.node_id);
    const result = await commandForNode(ctx, node, 'suggest_mesh_refine_config', {
        workspace: node.workspace,
        inlineMesh: ctx.mesh,
    });
    return JSON.stringify(result, null, 2);
}

export async function meshChangeImpactConfigSchema(ctx: MeshContext): Promise<string> {
    const node = resolveRefineConfigNode(ctx);
    const result = await commandForNode(ctx, node, 'get_mesh_change_impact_config_schema', {});
    return JSON.stringify(result, null, 2);
}

export async function meshValidateChangeImpactConfig(
    ctx: MeshContext,
    args: { node_id?: string; config?: Record<string, unknown> },
): Promise<string> {
    const node = resolveRefineConfigNode(ctx, args.node_id);
    const result = await commandForNode(ctx, node, 'validate_mesh_change_impact_config', {
        workspace: node.workspace,
        ...(args.config ? { config: args.config } : {}),
    });
    return JSON.stringify(result, null, 2);
}

export async function meshSuggestChangeImpactConfig(
    ctx: MeshContext,
    args: { node_id?: string },
): Promise<string> {
    const node = resolveRefineConfigNode(ctx, args.node_id);
    const result = await commandForNode(ctx, node, 'suggest_mesh_change_impact_config', {
        workspace: node.workspace,
    });
    return JSON.stringify(result, null, 2);
}

export async function meshInit(
    ctx: MeshContext,
    args: { node_id?: string; write?: boolean; overwrite?: boolean },
): Promise<string> {
    const node = resolveRefineConfigNode(ctx, args.node_id);
    const result = await commandForNode(ctx, node, 'mesh_init', {
        workspace: node.workspace,
        inlineMesh: ctx.mesh,
        ...(args.write !== undefined ? { write: args.write } : {}),
        ...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
    });
    return JSON.stringify(result, null, 2);
}

export async function meshRefinePlan(
    ctx: MeshContext,
    args: { node_id: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);
    const result = await commandForNode(ctx, node, 'plan_mesh_refine_node', {
        meshId: ctx.mesh.id,
        nodeId: args.node_id,
        inlineMesh: ctx.mesh,
    });
    return JSON.stringify(result, null, 2);
}

export async function meshRefineNode(
    ctx: MeshContext,
    args: { node_id: string; execute?: boolean; dry_run?: boolean },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    const result = await commandForNode(ctx, node, 'refine_mesh_node', {
        meshId: ctx.mesh.id,
        nodeId: args.node_id,
        ...(args.execute !== undefined ? { execute: args.execute } : {}),
        ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}),
        inlineMesh: ctx.mesh,
    });
    if (result?.success && result.async !== true && result.removeResult?.removed !== false) {
        const idx = ctx.mesh.nodes.findIndex(n => n.id === args.node_id);
        if (idx >= 0) {
            ctx.mesh.nodes.splice(idx, 1);
            ctx.mesh.updatedAt = new Date().toISOString();
        }
    }
    return JSON.stringify(result, null, 2);
}

export async function meshRefineBatch(
    ctx: MeshContext,
    args: { node_ids?: string[]; execute?: boolean; dry_run?: boolean } = {},
): Promise<string> {
    // Refresh so auto-collection and explicit node IDs resolve against the latest
    // mesh membership (siblings may have been created/removed in this MCP session).
    await refreshMeshFromDaemon(ctx);
    const nodeIds = Array.isArray(args.node_ids)
        ? args.node_ids.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())
        : undefined;

    // The batch orchestrator runs on the coordinator daemon that owns the source repo
    // and worktrees. Drive it through the local control-plane transport (the same
    // daemon that hosts these worktree nodes), passing inlineMesh so inline-cache-only
    // clone nodes resolve.
    const result = await ctx.transport.command('batch_refine_mesh_nodes', {
        meshId: ctx.mesh.id,
        ...(nodeIds ? { nodeIds } : {}),
        ...(args.execute !== undefined ? { execute: args.execute } : {}),
        ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}),
        inlineMesh: ctx.mesh,
    });

    // On a successful synchronous execute, prune merged/skipped nodes from the local
    // mesh snapshot so subsequent tool calls don't re-target already-converged worktrees.
    // The execute path is now async (async:true / status:'accepted') — per-node results
    // arrive later via terminal refine events, so there is nothing to prune yet. Only the
    // legacy/synchronous batch result (with inline `results`) is pruned here.
    const payload = unwrapCommandPayload(result) ?? result;
    if (payload?.batch && payload?.dryRun === false && payload?.async !== true && Array.isArray(payload?.results)) {
        for (const outcome of payload.results) {
            if (outcome?.convergence === 'merged_to_main' || outcome?.convergence === 'skipped_patch_equivalent') {
                const idx = ctx.mesh.nodes.findIndex(n => n.id === outcome.nodeId);
                if (idx >= 0) ctx.mesh.nodes.splice(idx, 1);
            }
        }
        ctx.mesh.updatedAt = new Date().toISOString();
    }
    return JSON.stringify(result, null, 2);
}
