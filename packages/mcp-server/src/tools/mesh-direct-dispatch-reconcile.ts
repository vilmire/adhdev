/**
 * Direct-dispatch completion reconciliation from transcript evidence —
 * design §4 roster id 6 (`mcp_mesh_status_reconciliation`), §8 unit 8.
 *
 * A pure barrel-preserving extraction out of `mesh-tools-internal.ts`: both
 * symbols are re-exported from there, so every existing importer
 * (`mesh-tools-status`, `mesh-tools-session`, `mesh-tools-queue`) is unchanged.
 * Moved because unit 8 wires the replica hop into this function, and
 * `mesh-tools-internal.ts` is a frozen-baseline file under `check:file-sizes`
 * — the gate's documented remedy is decomposition, not raising the limit.
 *
 * ── What this consumer decides, and why its admission gate is strict ────────
 * It synthesizes a task COMPLETION from the transcript: an irreversible write.
 * The replica hop below therefore refuses tail-only coverage (the trailing-
 * activity veto needs the bubbles that FOLLOW the final assistant message) and
 * requires a snapshot inside the freshness budget (design §5.5). On any
 * decline it falls through to the pre-existing live `read_chat`, and BOTH
 * sources feed the identical downstream parsers — see
 * `mesh-transcript-semantic-read.ts`'s header.
 */

import { hasTrailingToolActivityAfterFinalAssistant } from '@adhdev/daemon-core';
import { readString } from './mesh-tool-shared.js';
import { readTranscriptReplicaForSemanticConsumer } from './mesh-transcript-semantic-read.js';
import type { MeshContext } from './mesh-tools-internal.js';
import {
    commandForNode,
    findNodeSession,
    findOptionalNodeWithRefresh,
    isDirectDispatchLedgerEntry,
    isIdleSessionRecord,
    readFinalAssistantTranscriptEvidence,
    reconcileDirectDispatchCompletionFromTranscript,
    resolveMeshSessionProviderMetadata,
    resolveSemanticReplicaTransport,
    resolveSessionProviderType,
    unwrapCommandPayload,
} from './mesh-tools-internal.js';

export function buildDirectDispatchReconciliationCandidates(directDispatches: any[], ledgerEntries: any[]): any[] {
    const candidates: any[] = [];
    const seenTaskIds = new Set<string>();
    for (const dispatch of directDispatches || []) {
        const taskId = readString(dispatch?.taskId);
        if (!taskId || seenTaskIds.has(taskId)) continue;
        seenTaskIds.add(taskId);
        candidates.push(dispatch);
    }
    for (const entry of ledgerEntries || []) {
        if (!isDirectDispatchLedgerEntry(entry)) continue;
        const taskId = readString(entry.payload?.taskId);
        if (!taskId || seenTaskIds.has(taskId)) continue;
        seenTaskIds.add(taskId);
        candidates.push({
            taskId,
            nodeId: entry.nodeId,
            sessionId: entry.sessionId,
            providerType: entry.providerType || readString(entry.payload?.providerType),
            message: readString(entry.payload?.message),
            dispatchedAt: entry.timestamp,
            via: readString(entry.payload?.via),
        });
    }
    return candidates;
}

export async function reconcileDirectDispatchesFromTranscriptEvidence(
    ctx: MeshContext,
    liveNodes: any[],
    directDispatches: any[],
    ledgerEntries: any[],
): Promise<{ attempted: number; reconciled: number; skipped: number }> {
    let attempted = 0;
    let reconciled = 0;
    let skipped = 0;
    const candidates = buildDirectDispatchReconciliationCandidates(directDispatches, ledgerEntries);
    for (const dispatch of candidates) {
        const taskId = readString(dispatch?.taskId);
        const nodeId = readString(dispatch?.nodeId);
        const sessionId = readString(dispatch?.sessionId);
        if (!taskId || !nodeId || !sessionId) {
            skipped += 1;
            continue;
        }
        const { session } = findNodeSession(liveNodes, nodeId, sessionId);
        // EARLYNOTIFY-GATEBYPASS (e): a single snapshot-idle sample is NOT sufficient to synthesize
        // a completion — a mid-turn poll routinely reads idle for an instant. This idle check only
        // makes the session ELIGIBLE for a transcript read; the actual turn-finality gate is
        // enforced downstream: readFinalAssistantTranscriptEvidence requires a genuine non-empty
        // latest-assistant turn end, and reconcileDirectDispatchCompletionFromTranscript (the
        // guarded daemon path this delegates to) applies the dispatch grace window + stale-summary
        // guard before it will write a terminal. So a coordinator poll cannot force a mid-turn synth.
        if (!session || !isIdleSessionRecord(session)) {
            skipped += 1;
            continue;
        }
        const node = await findOptionalNodeWithRefresh(ctx, nodeId).catch(() => null);
        if (!node) {
            skipped += 1;
            continue;
        }
        const providerType = readString(dispatch?.providerType) || resolveSessionProviderType(session);
        const providerSessionId = readString(session?.providerSessionId)
            || readString(session?.activeChat?.providerSessionId)
            || readString(session?.settings?.providerSessionId)
            || resolveMeshSessionProviderMetadata(ctx, nodeId, sessionId)?.providerSessionId;
        attempted += 1;
        try {
            // ── §8 unit 8: replica hop (design §4 roster id 6) ──────────────
            // `mcp_mesh_status_reconciliation`. The replica returns the SAME
            // read_chat-shaped payload, so every guard below — the trailing-
            // activity veto, readFinalAssistantTranscriptEvidence, and the
            // downstream grace-window/stale-summary gate inside
            // reconcileDirectDispatchCompletionFromTranscript — runs unchanged
            // on either source. That is the design's "기존 evidence parser를
            // 그대로 적용" requirement, and it is why this is a source swap
            // rather than a second synthesis path.
            //
            // Coverage: `tail` is refused. The veto needs the tool/activity
            // bubbles that FOLLOW the final assistant message; a tail window
            // that clipped them would silently turn a mid-turn narration into a
            // synthesized completion — the exact MID-TURN-CAUSAL-ADMISSION
            // regression the veto exists to prevent. Freshness is required
            // because synthesizing a completion writes a terminal (§5.5:
            // irreversible judgements never read a stale snapshot).
            const replicaTransport = resolveSemanticReplicaTransport(ctx, node);
            let payload: any = null;
            if (replicaTransport) {
                const replica = await readTranscriptReplicaForSemanticConsumer(replicaTransport, {
                    consumerId: 'mcp_mesh_status_reconciliation',
                    ownerDaemonId: node.daemonId!,
                    rawSessionId: sessionId,
                    acceptCoverage: ['full', 'current-turn'],
                    requireFresh: true,
                });
                if (replica.payload) payload = replica.payload;
            }
            if (!payload) {
                const readResult = await commandForNode(ctx, node, 'read_chat', {
                    sessionId,
                    targetSessionId: sessionId,
                    workspace: node.workspace,
                    ...(providerType ? { agentType: providerType, providerType } : {}),
                    ...(providerSessionId ? { providerSessionId } : {}),
                    tailLimit: 10,
                });
                payload = unwrapCommandPayload(readResult);
            }
            if (payload?.success === false) continue;
            // MID-TURN-CAUSAL-ADMISSION (rc.16): the latest final-LOOKING assistant bubble
            // followed by trailing tool/terminal activity is interim narration, not a turn
            // end — a single coordinator poll must never promote it to a completion. This is
            // the same veto the reconcile loop's PHASE 4 and the watchdog poll enforce; the
            // MCP process has no live adapter to probe (remote semantics), so the bounded
            // transcript evidence below remains the operative net (fail-open preserved).
            if (hasTrailingToolActivityAfterFinalAssistant(Array.isArray(payload?.messages) ? payload.messages : [])) continue;
            const evidence = readFinalAssistantTranscriptEvidence(payload);
            if (!evidence.finalSummary) continue;
            const result = reconcileDirectDispatchCompletionFromTranscript({
                meshId: ctx.mesh.id,
                nodeId,
                sessionId,
                providerType,
                providerSessionId: readString(payload?.providerSessionId) || providerSessionId,
                taskId,
                finalSummary: evidence.finalSummary,
                transcriptMessageAt: evidence.transcriptMessageAt,
                targetCoordinatorDaemonId: ctx.localDaemonId,
                source: 'mcp_mesh_status_transcript_reconciliation',
            });
            if (result.reconciled) reconciled += 1;
        } catch {
            skipped += 1;
        }
    }
    return { attempted, reconciled, skipped };
}
