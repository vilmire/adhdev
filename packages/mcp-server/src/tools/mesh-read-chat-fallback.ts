// mesh_read_chat recovery paths: the removed-node recovery payload and the
// ledger-cached preview served when the owning daemon cannot be read. Split out
// of mesh-tools-internal.ts.

import type { MeshContext } from './mesh-tools-internal.js';
import { ledgerQuery } from '../ipc/turn-commands.js';
import { compactChatPayload } from './chat-compact.js';
import { resolveMeshSurfacedSessionPreview, type LocalMeshNodeEntry, classifyP2pRelayFailure } from '@adhdev/daemon-core';
import { classifyReadChatTransportCause } from './mesh-tools-internal-core.js';
import { buildCoordinatorP2pRelayFailure } from './mesh-remote-dispatch.js';
import { readString } from '@adhdev/mesh-shared';

export async function buildMissingNodeReadChatRecovery(ctx: MeshContext, args: { node_id: string; session_id: string; provider_session_id?: string; tail?: number; compact?: boolean }): Promise<Record<string, unknown>> {
    const { entries } = await ledgerQuery(ctx.transport, { meshId: ctx.mesh.id, tail: 300 });
    const relatedEntries = entries.filter(entry => entry.nodeId === args.node_id || entry.sessionId === args.session_id);
    const completedEntries = relatedEntries.filter(entry => entry.kind === 'task_completed');
    const lastDispatch = [...relatedEntries].reverse().find(entry => entry.kind === 'task_dispatched');
    const lastTerminal = [...relatedEntries].reverse().find(entry => entry.kind === 'task_completed' || entry.kind === 'task_failed' || entry.kind === 'task_stalled');
    const lastRemoved = [...relatedEntries].reverse().find(entry => entry.kind === 'node_removed');
    const lastLaunch = [...relatedEntries].reverse().find(entry => entry.kind === 'session_launched');
    const providerSessionId = args.provider_session_id
        || readString(lastTerminal?.payload?.providerSessionId)
        || readString(lastLaunch?.payload?.providerSessionId)
        || readString(lastDispatch?.payload?.providerSessionId);
    const finalSummary = readString(lastTerminal?.payload?.finalSummary)
        || readString(lastTerminal?.payload?.compactSummary)
        || readString(lastTerminal?.payload?.summary);
    const ledger = {
        taskCompletedFound: completedEntries.length > 0,
        nodeRemovedFound: !!lastRemoved,
        providerType: lastTerminal?.providerType || lastLaunch?.providerType || lastDispatch?.providerType,
        providerSessionId,
        nodeRemovedAt: lastRemoved?.timestamp,
        sessionCleanupMode: readString(lastRemoved?.payload?.sessionCleanupMode),
        readDebugLocator: readString(lastTerminal?.payload?.readDebugLocator) || readString(lastTerminal?.payload?.debugBundlePath),
    };

    if (finalSummary) {
        if (args.compact === true) {
            return {
                ...compactChatPayload({
                    success: true,
                    status: 'idle',
                    providerSessionId,
                    summary: finalSummary,
                    messages: [{ role: 'assistant', content: finalSummary, isHistorical: true }],
                }, {
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    limit: args.tail ?? 10,
                }),
                recoveredFromLedger: true,
                ledger,
            };
        }
        return {
            success: true,
            compact: false,
            recoveredFromLedger: true,
            nodeId: args.node_id,
            sessionId: args.session_id,
            summary: finalSummary,
            ledger,
            messages: [{ role: 'assistant', content: finalSummary, isHistorical: true }],
        };
    }

    return {
        success: false,
        recoverable: true,
        code: 'mesh_removed_node_transcript_unavailable',
        error: `Node '${args.node_id}' is not a current member of mesh '${ctx.mesh.name}'.`,
        nodeId: args.node_id,
        sessionId: args.session_id,
        providerSessionId,
        reason: 'node_not_in_current_mesh_snapshot',
        ledger,
        completedSessionSeenInLedger: ledger.taskCompletedFound,
        lastDispatch: lastDispatch ? {
            timestamp: lastDispatch.timestamp,
            sessionId: lastDispatch.sessionId,
            providerType: lastDispatch.providerType,
            taskId: typeof lastDispatch.payload?.taskId === 'string' ? lastDispatch.payload.taskId : undefined,
            messagePreview: typeof lastDispatch.payload?.message === 'string' ? lastDispatch.payload.message.slice(0, 500) : undefined,
        } : null,
        lastTerminalEvent: lastTerminal ? {
            kind: lastTerminal.kind,
            timestamp: lastTerminal.timestamp,
            sessionId: lastTerminal.sessionId,
            providerType: lastTerminal.providerType,
            taskId: typeof lastTerminal.payload?.taskId === 'string' ? lastTerminal.payload.taskId : undefined,
            payload: lastTerminal.payload,
        } : null,
        nextSteps: [
            providerSessionId
                ? `Retry mesh_read_chat with provider_session_id='${providerSessionId}' on a current live node for the same daemon if one exists.`
                : 'If the node UI shows a provider transcript id, retry mesh_read_chat/mesh_read_debug with provider_session_id.',
            'Use mesh_read_debug with the provider_session_id or daemon-side debug bundle locator if available.',
            'Check mesh_task_history for task_completed and node_removed entries before redispatching; do not resend solely because transcript recovery failed.',
            'If this node was removed with stop_and_delete, the runtime transcript may be gone; rely on the ledger summary/locator or ask the operator for the saved UI output.',
        ],
        recoveryHints: [
            'The worktree/node may have been removed or the mesh snapshot may be stale after task completion.',
            'If you have a provider_session_id, retry mesh_read_chat with that value while targeting a live node for the same daemon if available.',
            'Use mesh_read_debug with provider_session_id, or inspect the daemon/session-host history locator if the transcript has already been archived.',
            'Avoid redispatching the same task solely because read_chat could not recover the transcript; check task_history and git status first.',
        ],
    };
}

/**
 * The coordinator already holds the worker's latest assistant text from the completion /
 * status events it surfaced into the ledger (finalSummary / workerResult.summary — the
 * same fields resolveMeshSurfacedSessionPreview reads off a live event, and the same
 * data the mobile inbox is fed). When the live P2P read_chat path is unavailable this
 * resolves that cached preview so mesh_read_chat can degrade to a stale-but-present
 * summary instead of a hard 30s timeout. Scans the most recent matching ledger entry for
 * the node+session.
 */
async function resolveCachedMeshSessionPreviewFromLedger(
    ctx: MeshContext,
    nodeId: string,
    sessionId: string,
): Promise<{ preview: string; role: 'assistant'; receivedAt: number; ledgerKind: string; timestamp: string } | undefined> {
    let entries: Awaited<ReturnType<typeof ledgerQuery>>['entries'] = [];
    try { entries = (await ledgerQuery(ctx.transport, { meshId: ctx.mesh.id, tail: 200 })).entries; } catch { return undefined; }
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        const payload = entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
            ? entry.payload as Record<string, unknown>
            : {};
        const entryNodeId = readString(entry.nodeId) || readString(payload.nodeId) || readString(payload.meshNodeId);
        if (entryNodeId && entryNodeId !== nodeId) continue;
        const entrySessionId = readString(entry.sessionId)
            || readString(payload.targetSessionId)
            || readString(payload.sessionId)
            || readString(payload.instanceId);
        if (entrySessionId !== sessionId) continue;
        // Prefer a nested metadataEvent when present, else read the entry payload itself
        // (task_completed / task_failed entries carry finalSummary + workerResult inline).
        const metadataEvent = payload.metadataEvent && typeof payload.metadataEvent === 'object' && !Array.isArray(payload.metadataEvent)
            ? payload.metadataEvent as Record<string, unknown>
            : payload;
        const preview = resolveMeshSurfacedSessionPreview(metadataEvent);
        if (preview) {
            return { ...preview, ledgerKind: entry.kind, timestamp: entry.timestamp };
        }
    }
    return undefined;
}

/**
 * mesh_read_chat fallback for a REMOTE P2P read that failed at the transport layer.
 *
 * Rather than hard-failing on a 30s P2P timeout to a saturated/unreachable worker, surface the
 * cached coordinator-side summary (the same finalSummary/lastMessagePreview the mobile
 * dashboard renders). This is a READ/meta-plane degrade — status & preview already flow
 * over the WS/event plane — NOT a data-plane command WS fallback (which stays P2P-only
 * by policy). The full transcript still requires a live P2P read_chat; the fallback is
 * explicitly a stale point-in-time summary only.
 */
export async function buildMeshReadChatCacheFallback(
    ctx: MeshContext,
    args: { node_id: string; session_id: string },
    node: LocalMeshNodeEntry,
    error: unknown,
): Promise<string> {
    const classification = classifyP2pRelayFailure(error, { command: 'read_chat', targetDaemonId: node.daemonId });
    const cause = classifyReadChatTransportCause(error);
    const errorMessage = error instanceof Error ? error.message : String(error ?? '');
    const causeNote = cause === 'not_connected'
        ? 'the worker daemon is not currently connected over P2P (no live channel)'
        : 'the worker daemon is connected but saturated — it acknowledged the request but did not return the transcript within the deadline';

    const cached = await resolveCachedMeshSessionPreviewFromLedger(ctx, args.node_id, args.session_id);
    if (cached) {
        return JSON.stringify({
            success: true,
            source: 'coordinator_cache_fallback',
            fallback: true,
            nodeId: args.node_id,
            sessionId: args.session_id,
            transport: 'p2p',
            transportFailure: {
                code: classification.code,
                reason: classification.reason,
                cause,
                error: errorMessage,
            },
            advisory: `Live transcript unavailable (${causeNote}). Showing the cached coordinator-side summary surfaced from the worker's last completion/status event — a stale point-in-time summary, NOT the live transcript. The full transcript requires a live P2P read_chat once the peer is reachable.`,
            fullTranscriptRequiresP2p: true,
            summary: cached.preview,
            messages: [{
                role: cached.role,
                content: cached.preview,
                cached: true,
                ...(cached.receivedAt ? { receivedAt: cached.receivedAt } : {}),
            }],
            cachedPreview: {
                role: cached.role,
                ledgerKind: cached.ledgerKind,
                ledgerTimestamp: cached.timestamp,
                ...(cached.receivedAt ? { receivedAt: cached.receivedAt } : {}),
            },
        }, null, 2);
    }

    // No cached summary either — return the structured relay failure with a clear reason,
    // and make explicit that even a fallback summary is unavailable.
    const failure = buildCoordinatorP2pRelayFailure(error, {
        command: 'read_chat',
        targetDaemonId: node.daemonId,
        nodeId: args.node_id,
        sessionId: args.session_id,
    });
    return JSON.stringify({
        ...failure,
        cause,
        cachedSummaryAvailable: false,
        fullTranscriptRequiresP2p: true,
        advisory: `Live transcript unavailable (${causeNote}) and no cached coordinator-side summary exists for this session yet (no completion/status event has been surfaced). The full transcript requires a live P2P read_chat once the peer is reachable.`,
    }, null, 2);
}
