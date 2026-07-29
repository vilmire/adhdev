/**
 * MED family — cleanup_worktree_nodes: manual plan/execute surface for the
 * lifecycle-retention Slice 2 worktree-node retention pass.
 *
 * The automatic reconcile phase (mesh-reconcile-loop PHASE 6.5) runs the same
 * logic with executeMode 'auto' (two-tick proof + grace). This wire verb backs
 * the MCP `mesh_cleanup_worktree_nodes` tool:
 *   - dry_run:true (DEFAULT) → read-only, reason-coded per-node plan. Nothing
 *     is recorded or removed; the output is identical in shape to what the
 *     automatic pass plans (dry-run parity).
 *   - dry_run:false → executes every node that passes ALL exclusion checks
 *     right now (executeMode 'manual'). Explicit operator intent bypasses the
 *     two-tick/grace waiting period but NEVER the safety exclusions, never
 *     passes force, and still re-runs the non-destructive precheck immediately
 *     before each removal.
 * Per-node reasons are never hidden: every entry carries its reasonCode (and
 * the precheck/convergence detail) so the caller can see exactly why a node
 * was skipped.
 */
import { runWorktreeNodeRetentionTick, type WorktreeRetentionDeps } from '../../mesh/mesh-worktree-retention.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';

function buildRetentionDeps(ctx: MedFamilyContext): WorktreeRetentionDeps {
    return {
        precheckLocalWorktreeRemovable: args => ctx.precheckLocalWorktreeRemovable(args),
        cleanupLocalWorktreeNode: args => ctx.cleanupLocalWorktreeNode(args),
        getWorktreeForceCleanupConvergence: args => ctx.getWorktreeForceCleanupConvergence(args),
        cleanupMeshSessions: args => ctx.cleanupMeshSessions(args as Parameters<MedFamilyContext['cleanupMeshSessions']>[0]),
        listSessions: async () => {
            try { return await ctx.deps.sessionHostControl?.listSessions() ?? []; } catch { return []; }
        },
        getCachedInlineMesh: meshId => ctx.getCachedInlineMesh(meshId),
        removeInlineMeshNode: (meshId, mesh, nodeId) => ctx.removeInlineMeshNode(meshId, mesh, nodeId),
        invalidateAggregateMeshStatus: meshId => ctx.invalidateAggregateMeshStatus(meshId),
    };
}

export const meshWorktreeRetentionHandlers: Record<string, MedFamilyHandler> = {
    cleanup_worktree_nodes: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        try {
            const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const mesh = meshRecord?.mesh;
            if (!mesh) return { success: false, error: `mesh '${meshId}' not found` };

            const dryRun = args?.dryRun !== false && args?.dry_run !== false;
            const nodeId = typeof args?.nodeId === 'string' && args.nodeId.trim() ? args.nodeId.trim() : undefined;
            const nowMs = Date.now();
            const result = await runWorktreeNodeRetentionTick(buildRetentionDeps(ctx), {
                mesh,
                nowMs,
                // Manual invocations are single-pass: the tickId is unique per
                // call so a repeated dry-run never accumulates a proof, and a
                // manual execute does not need one (executeMode 'manual').
                tickId: `manual-${nowMs}-${Math.random().toString(36).slice(2, 10)}`,
                execute: !dryRun,
                executeMode: 'manual',
                // A dry-run is purely observational — it must NOT advance the
                // durable two-pass proof it reports on.
                recordPasses: !dryRun,
                ...(nodeId ? { onlyNodeId: nodeId } : {}),
            });
            return {
                success: true,
                dryRun: result.dryRun,
                meshId: result.meshId,
                graceMs: result.graceMs,
                entries: result.entries,
                summary: result.summary,
            };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    },
};
