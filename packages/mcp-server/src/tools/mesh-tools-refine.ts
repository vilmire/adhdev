// Mesh tool implementations — refine domain.
// Pure move out of mesh-tools.ts (no behavior change). Shared helpers, types, module
// state and dependency re-exports live in ./mesh-tools-internal.ts; mesh-tools.ts is a barrel.

import {
    commandForNode,
    findNodeWithRefresh,
    refreshMeshFromDaemon,
    resolveCoordinatorDaemonId,
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

/**
 * Unified read-only Refinery config helper (MESH-COMPLEXITY-AUDIT Part 8-4).
 * Dispatches on `mode` to the three underlying config operations, each a thin wrapper
 * over its daemon-core low-family refine-config command — internal command API unchanged,
 * zero behavior loss. The former standalone tools (mesh_refine_config_schema /
 * mesh_validate_refine_config / mesh_suggest_refine_config) remain dispatchable as
 * 1-release hidden aliases that forward here with the corresponding mode (see server.ts).
 */
export async function meshRefineConfig(
    ctx: MeshContext,
    args: { mode?: string; node_id?: string; config?: Record<string, unknown> } = {},
): Promise<string> {
    switch (args.mode) {
        case 'schema':
            return meshRefineConfigSchema(ctx);
        case 'validate':
            return meshValidateRefineConfig(ctx, args);
        case 'suggest':
            return meshSuggestRefineConfig(ctx, args);
        default:
            throw new Error(
                `mesh_refine_config: invalid or missing 'mode' (${JSON.stringify(args.mode)}). Expected one of: 'schema' | 'validate' | 'suggest'.`,
            );
    }
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

/**
 * Unified read-only Change Impact config helper (MESH-COMPLEXITY-AUDIT, symmetric to Part 8-4).
 * Dispatches on `mode` to the three underlying change-impact config operations, each a thin
 * wrapper over its daemon-core low-family change-impact command — internal command API
 * unchanged, zero behavior loss. The former standalone tools (mesh_change_impact_config_schema /
 * mesh_validate_change_impact_config / mesh_suggest_change_impact_config) remain dispatchable as
 * 1-release hidden aliases that forward here with the corresponding mode (see server.ts).
 */
export async function meshChangeImpactConfig(
    ctx: MeshContext,
    args: { mode?: string; node_id?: string; config?: Record<string, unknown> } = {},
): Promise<string> {
    switch (args.mode) {
        case 'schema':
            return meshChangeImpactConfigSchema(ctx);
        case 'validate':
            return meshValidateChangeImpactConfig(ctx, args);
        case 'suggest':
            return meshSuggestChangeImpactConfig(ctx, args);
        default:
            throw new Error(
                `mesh_change_impact_config: invalid or missing 'mode' (${JSON.stringify(args.mode)}). Expected one of: 'schema' | 'validate' | 'suggest'.`,
            );
    }
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

/**
 * Re-onboarding of an already-initialized repo. This is NOT a separate write engine
 * — it reuses mesh_init's suggest→validate→gated-write engine with OVERWRITE
 * semantics, plus the current-vs-suggested config echo (result.currentConfig) so the
 * coordinator can present a per-section diff before replacing anything.
 *
 * CONTRACT — reinit must NOT silently drop operator hand-edits: overwrite=true is a
 * wholesale replacement of the existing config, so the coordinator MUST load the
 * current config (returned here in `currentConfig`), present a per-section
 * current-vs-suggested diff, and get EXPLICIT per-section user approval before the
 * write. The default is DRY-RUN (write=false): the first reinit call is a preview
 * that surfaces the diff; only after approval does the coordinator re-invoke with
 * write=true. `overwrite` defaults to true here (that is the whole point of reinit —
 * unlike init, an existing config is the expected case), but with write=false it
 * still writes nothing.
 */
export async function meshReinit(
    ctx: MeshContext,
    args: { node_id?: string; write?: boolean; overwrite?: boolean },
): Promise<string> {
    const node = resolveRefineConfigNode(ctx, args.node_id);
    // overwrite defaults to true for reinit (an existing config is expected); callers
    // can still pass overwrite=false to fall back to existing-wins. write defaults to
    // false (dry-run preview surfacing the diff) exactly like mesh_init.
    const overwrite = args.overwrite !== false;
    const result = await commandForNode(ctx, node, 'mesh_init', {
        workspace: node.workspace,
        inlineMesh: ctx.mesh,
        ...(args.write !== undefined ? { write: args.write } : {}),
        overwrite,
    });
    // Annotate the mode so the coordinator reads this as a reinit (diff-then-approve)
    // rather than a fresh init, without inventing a second write engine.
    const annotated = (result && typeof result === 'object')
        ? {
            ...result,
            mode: 'reinit',
            reinitContract: 'Overwrite replaces existing config wholesale. Present the per-section current-vs-suggested diff (see currentConfig) and get EXPLICIT per-section user approval before re-invoking with write=true. Never silently drop operator hand-edits.',
        }
        : result;
    return JSON.stringify(annotated, null, 2);
}

/**
 * Write `.adhdev/mesh.json` (the repo-committed coordinator prompt + declarative
 * config) from the machine-local mesh entry. Gated WRITE sibling of the draft-only
 * export_mesh_json_config — forwards to the daemon `write_mesh_json_config` command
 * which enforces the same write/overwrite/dry-run contract as mesh_init (dry-run
 * default, existing-wins unless overwrite=true, validate before write). REPO-COMMITTED
 * scope. Resolves the workspace via the same node resolver as mesh_init (non-optional).
 */
export async function meshWriteMeshJsonConfig(
    ctx: MeshContext,
    args: { node_id?: string; write?: boolean; overwrite?: boolean; workspace?: string } = {},
): Promise<string> {
    const node = resolveRefineConfigNode(ctx, args.node_id);
    const result = await commandForNode(ctx, node, 'write_mesh_json_config', {
        meshId: ctx.mesh.id,
        workspace: (typeof args.workspace === 'string' && args.workspace.trim()) ? args.workspace.trim() : node.workspace,
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

    // Return-address stamp (RC32): refine is ASYNC — the accepted/completed/failed
    // events are emitted on the EXECUTING daemon (this node's daemon, remote for a
    // remote worktree) and recovered by THIS coordinator's drain. commandForNode
    // relays a remote node straight to its daemon (transport.meshCommand), bypassing
    // the coordinator daemon's own refine_mesh_node forward-stamp, so the stamp must
    // ride in these args — mirroring the med-family dispatch return-address contract
    // (meshContext.coordinatorDaemonId → resolveCoordinatorDaemonId). Without it the
    // executing daemon falls back to its OWN statusInstanceId, scoping the terminal
    // event to an inbox this coordinator never drains (event trims to held).
    //
    // REFINE-EVENT-SESSION-SCOPED-UNICAST: the daemon anchor alone routes the terminal
    // event to the right MACHINE. When that machine runs more than one coordinator
    // session, `intendedFor` was session-less and identityDeliversTo — which compares
    // sessions only when BOTH sides name one — matched ANY drainer there, so unicast
    // degraded to first-come-first-served and a sibling coordinator consumed this job's
    // result. Send the SESSION half of the return address too; the drainer side already
    // stamps its own session (mesh-tools-internal drainerIdentity), so the pair completes
    // the match. Absent (legacy ctx) → daemon-level delivery, unchanged.
    const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
    const result = await commandForNode(ctx, node, 'refine_mesh_node', {
        meshId: ctx.mesh.id,
        nodeId: args.node_id,
        ...(args.execute !== undefined ? { execute: args.execute } : {}),
        ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}),
        ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
        ...(ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}),
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
    //
    // Return-address stamp (RC32): same contract as meshRefineNode — the async batch
    // terminal event must be scoped to THIS coordinator's daemon id so its drain
    // recovers it; absent, the executing daemon self-fallback stamps its own id and
    // the event is excluded from the coordinator's drain (trims to held).
    // REFINE-EVENT-SESSION-SCOPED-UNICAST: session half of the return address — same
    // contract as meshRefineNode above.
    const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
    const result = await ctx.transport.command('batch_refine_mesh_nodes', {
        meshId: ctx.mesh.id,
        ...(nodeIds ? { nodeIds } : {}),
        ...(args.execute !== undefined ? { execute: args.execute } : {}),
        ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}),
        ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
        ...(ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}),
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
