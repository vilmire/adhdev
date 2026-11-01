// Mesh tool implementations — recovery verbs that only wrap an existing daemon command.
//   mesh_retry_node_bootstrap → `retry_mesh_node_bootstrap` (daemon: med-family/mesh-node-clone.ts)
//   mesh_direct_cancel        → `mesh_direct_cancel`        (daemon: low-family/mesh-direct-cancel.ts)

import { commandForNode, findNodeWithRefresh, isP2pTransportUnavailableError } from './mesh-tools-internal.js';
import type { MeshContext } from './mesh-tools-internal.js';
import { CANCEL_REASONS } from '@adhdev/mesh-shared';


/** Wire args for `retry_mesh_node_bootstrap` (same envelope as `remove_mesh_node`). */
export function buildRetryBootstrapArgs(ctx: MeshContext, nodeId: string): Record<string, unknown> {
    return { meshId: ctx.mesh.id, nodeId, inlineMesh: ctx.mesh };
}

export async function meshRetryNodeBootstrap(
    ctx: MeshContext,
    args: { node_id: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);
    let result: any;
    try {
        result = await commandForNode(ctx, node, 'retry_mesh_node_bootstrap', buildRetryBootstrapArgs(ctx, args.node_id));
    } catch (e: any) {
        return JSON.stringify({
            success: false,
            code: isP2pTransportUnavailableError(e) ? 'p2p_unavailable' : 'mesh_retry_node_bootstrap_failed',
            error: e?.message || String(e),
            recoveryHint: 'Inspect mesh_status for the node\'s worktreeBootstrap state and retry once the reported failure is resolved.',
        }, null, 2);
    }
    return JSON.stringify(result ?? { success: false, error: 'no response from daemon' }, null, 2);
}

/**
 * mesh_direct_cancel — cancel one `mesh_direct` attempt through the turn ledger
 * (cancel evidence → proof-fenced writer stop). Never force-releases a claim:
 * `stopPending:true` means the stop intent is durable but the writer is not yet
 * proven stopped. Queue tasks keep using mesh_queue_cancel.
 */
export async function meshDirectCancel(
    ctx: MeshContext,
    args: { task_id?: string; attempt_id?: string; reason?: string },
): Promise<string> {
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    const attemptId = typeof args.attempt_id === 'string' ? args.attempt_id.trim() : '';
    if (!!taskId === !!attemptId) {
        return JSON.stringify({ success: false, code: 'bad_request', error: 'Provide exactly one of task_id or attempt_id.' });
    }
    if (args.reason !== undefined && !(CANCEL_REASONS as readonly string[]).includes(args.reason)) {
        return JSON.stringify({ success: false, code: 'bad_request', error: `reason must be one of ${CANCEL_REASONS.join(', ')}.` });
    }
    let result: any;
    try {
        result = await ctx.transport.command('mesh_direct_cancel', {
            meshId: ctx.mesh.id,
            ...(taskId ? { taskId } : { attemptId }),
            ...(args.reason ? { reason: args.reason } : {}),
        });
    } catch (e: any) {
        return JSON.stringify({
            success: false,
            code: 'mesh_direct_cancel_failed',
            error: e?.message || String(e),
            recoveryHint: 'The coordinator daemon may predate mesh_direct_cancel (update it), or it is not the attempt owner.',
        }, null, 2);
    }
    const unwrapped = result && typeof result === 'object' && result.result && typeof result.result === 'object' && result.success === undefined
        ? result.result : result;
    const out: Record<string, unknown> = { ...(unwrapped ?? { success: false, error: 'no response from daemon' }) };
    if (out.success === true && out.stopPending === true) {
        out.nextStepHint = 'Stop intent recorded; the writer is not yet proven stopped. Do not force-release the claim — re-run mesh_status/mesh_task_history later to see it settle.';
    }
    return JSON.stringify(out, null, 2);
}
