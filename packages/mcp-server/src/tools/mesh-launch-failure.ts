// Recoverable session-launch failures: the typed payload and its ledger record
// (read back by mesh_status via latestActiveLaunchFailureFromEntries). Split out
// of mesh-tools-internal.ts; re-exported there.

import type { MeshContext } from './mesh-tools-internal.js';
import type { LocalMeshNodeEntry, MeshLedgerEntry } from '@adhdev/daemon-core';
import { classifyMeshLaunchFailure, buildWorktreeCleanupHint } from './mesh-tools-internal-core.js';
import { recordLocal } from '../ipc/turn-commands.js';

// (compact node-fold helpers moved to ./mesh-compact.ts)


function buildRecoverableLaunchFailure(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    providerType: string | undefined,
    error: unknown,
): Record<string, unknown> {
    const message = error instanceof Error ? error.message : String(error || 'launch failed');
    const classified = classifyMeshLaunchFailure(error);
    const cleanup = buildWorktreeCleanupHint(node);
    return {
        success: false,
        recoverable: classified.recoverable,
        code: classified.code,
        reason: classified.reason,
        transport: classified.transport,
        retryRecommended: classified.retryRecommended,
        nextAction: classified.nextAction,
        ...(classified.noFallbackReason ? { noFallbackReason: classified.noFallbackReason } : {}),
        error: message,
        meshId: ctx.mesh.id,
        nodeId: node.id,
        daemonId: node.daemonId,
        workspace: node.workspace,
        isLocalWorktree: node.isLocalWorktree === true,
        worktreeBranch: node.worktreeBranch,
        clonedFromNodeId: node.clonedFromNodeId,
        ...(providerType ? { resolvedProviderType: providerType } : {}),
        retryHint: `Retry mesh_launch_session(node_id: "${node.id}"${providerType ? `, type: "${providerType}"` : ''}) after daemon mesh transport/P2P is healthy.`,
        ...(cleanup ? { cleanup } : {}),
        nextStepHints: [
            `Retry mesh_launch_session(node_id: "${node.id}"${providerType ? `, type: "${providerType}"` : ''}) after checking daemon/P2P health.`,
            ...(cleanup ? [`Cleanup orphan worktree node with mesh_remove_node(node_id: "${node.id}") if retry is not desired.`] : []),
            'Run mesh_status to see the degraded reason and recovery hints before redispatching work.',
        ],
    };
}

export async function recordRecoverableLaunchFailure(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    providerType: string | undefined,
    error: unknown,
): Promise<Record<string, unknown>> {
    const failure = buildRecoverableLaunchFailure(ctx, node, providerType, error);
    try {
        await recordLocal(ctx.transport, {
            meshId: ctx.mesh.id,
            kind: 'recovery_attempted',
            nodeId: node.id,
            providerType,
            payload: {
                event: 'session_launch_failed',
                ...failure,
            },
        });
    } catch { /* ledger append is best-effort */ }
    return failure;
}

export function latestActiveLaunchFailureFromEntries(entries: MeshLedgerEntry[], nodeId: string): Record<string, unknown> | null {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry.nodeId !== nodeId) continue;
        if (entry.kind === 'session_launched' || entry.kind === 'node_removed') return null;
        if (entry.kind === 'recovery_attempted' && entry.payload?.event === 'session_launch_failed') {
            return { timestamp: entry.timestamp, ...entry.payload };
        }
    }
    return null;
}
