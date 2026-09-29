// The remote leg of a direct dispatch, composed for tests that pin target
// resolution and the relayed send without the turn-ledger bookkeeping around
// them: resolve the target from the coordinator-held runtime, then send on the
// relay route — the two steps dispatchSendTaskDirect (mesh-tools-send-task.ts)
// runs for a node another daemon serves.
import type { LocalMeshNodeEntry } from '@adhdev/daemon-core';
import type { MeshContext } from '../../src/tools/mesh-tools-internal.js';
import { resolveRemoteDispatchTarget, sendDirectAgentTask } from '../../src/tools/mesh-remote-dispatch.js';

export async function dispatchToRemoteNode(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    args: {
        message: string;
        session_id?: string;
        providerType?: string;
        verifiedSession?: any;
        requiredTags?: string[];
        allowQuotaExhausted?: boolean;
        meshContext?: { meshId: string; nodeId?: string; taskId?: string; coordinatorDaemonId?: string };
    },
) {
    const target = await resolveRemoteDispatchTarget(ctx, node, {
        ...(args.session_id !== undefined ? { session_id: args.session_id } : {}),
        ...(args.providerType !== undefined ? { providerType: args.providerType } : {}),
        ...(args.verifiedSession !== undefined ? { verifiedSession: args.verifiedSession } : {}),
        ...(args.requiredTags !== undefined ? { requiredTags: args.requiredTags } : {}),
        ...(args.allowQuotaExhausted !== undefined ? { allowQuotaExhausted: args.allowQuotaExhausted } : {}),
        ...(args.meshContext?.coordinatorDaemonId ? { coordinatorDaemonId: args.meshContext.coordinatorDaemonId } : {}),
    });
    if ('success' in target) return target;
    return sendDirectAgentTask(ctx, node, 'remote', target, {
        message: args.message,
        ...(args.meshContext ? { meshContext: args.meshContext } : {}),
    });
}
