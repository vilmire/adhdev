import { appendLedgerEntry, buildTaskCompletionEvidence, readLedgerEntries } from './mesh-ledger.js';
import type { MeshLedgerKind } from './mesh-ledger.js';
import { updateDirectDispatchStatus, cleanupTerminalDirectDispatches } from './mesh-work-queue.js';
import { markSessionDeliveriesTerminal } from './mesh-delivery-policy.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { readNonEmptyString, readRecord, resolveEventSessionId, readWorkerResultMetadata } from './mesh-events-utils.js';
import { meshNodeIdMatches, type MeshNodeIdentified } from '@adhdev/mesh-shared';

// ---------------------------------------------------------------------------
// Stale direct-dispatch detection & transcript reconciliation
// ---------------------------------------------------------------------------

export function findRecentTerminalLedgerEvidence(args: {
    meshId: string;
    sessionId?: string;
    nodeId?: string;
}): { id: string; kind: MeshLedgerKind; payload: Record<string, unknown>; timestamp: string } | null {
    if (!args.sessionId && !args.nodeId) return null;
    // Tail-limit: 200 entries gives a wide enough window to catch terminal events for active
    // sessions while avoiding a full O(n) scan. If a terminal is older than 200 entries,
    // the MeshRuntimeStore fingerprint dedup will still block duplicate processing downstream.
    const entries = readLedgerEntries(args.meshId, { tail: 200 });
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.kind !== 'task_completed' && entry.kind !== 'task_failed' && entry.kind !== 'task_stalled') continue;
        if (args.sessionId && entry.sessionId === args.sessionId) {
            return { id: entry.id, kind: entry.kind, payload: entry.payload || {}, timestamp: entry.timestamp };
        }
        // Normalized node-id match (P4): a ledger entry may store its node id as `nodeId`
        // (runtime form) or `node_id` (DB column form leaked onto the object). A raw `===`
        // against args.nodeId drops the entry when the entry's stored form differs from the
        // form the caller passes, so a valid terminal completion goes unfound. meshNodeIdMatches
        // normalizes the entry across all 3 forms before comparing. (The entry's typed shape
        // omits the open index signature MeshNodeIdentified declares, hence the cast.)
        if (!args.sessionId && args.nodeId && meshNodeIdMatches(entry as unknown as MeshNodeIdentified, args.nodeId)) {
            return { id: entry.id, kind: entry.kind, payload: entry.payload || {}, timestamp: entry.timestamp };
        }
    }
    return null;
}

// Returns true when a task_dispatched entry for the given session appears AFTER the terminal
// entry (identified by terminalId) in ledger order. Positional (append) order is used rather
// than timestamp comparison because both entries may share the same millisecond.
export function hasDispatchAfterTerminal(meshId: string, sessionId: string, terminalId: string): boolean {
    // 200-entry window matches findRecentTerminalLedgerEvidence for consistency.
    const entries = readLedgerEntries(meshId, { tail: 200 });
    let pastTerminal = false;
    for (const entry of entries) {
        if (!pastTerminal) {
            if (entry.id === terminalId) pastTerminal = true;
            continue;
        }
        if (entry.kind === 'task_dispatched' && entry.sessionId === sessionId) return true;
    }
    return false;
}

export function hasUnterminalDirectDispatchLedgerEntry(meshId: string, sessionId: string): boolean {
    // Some dispatch paths can persist task_dispatched before the direct-dispatch DB row is
    // available. Recover routing from ledger order so coordinator self-targets still emit
    // task_completed and pendingCoordinatorEvents.
    const entries = readLedgerEntries(meshId, { tail: 200 });
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.sessionId !== sessionId) continue;
        if (entry.kind === 'task_completed' || entry.kind === 'task_failed' || entry.kind === 'task_stalled') {
            return false;
        }
        if (entry.kind === 'task_dispatched' && entry.payload?.source === 'direct') {
            return true;
        }
    }
    return false;
}

function findDirectDispatchLedgerEntry(args: {
    meshId: string;
    taskId: string;
    sessionId?: string;
}): { id: string; timestamp: string; nodeId?: string; sessionId?: string; providerType?: string; payload: Record<string, unknown> } | null {
    const entries = readLedgerEntries(args.meshId, { tail: 500 });
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.kind !== 'task_dispatched') continue;
        const payloadTaskId = readNonEmptyString(entry.payload?.taskId);
        if (payloadTaskId !== args.taskId) continue;
        if (args.sessionId && entry.sessionId && entry.sessionId !== args.sessionId) continue;
        return {
            id: entry.id,
            timestamp: entry.timestamp,
            nodeId: entry.nodeId,
            sessionId: entry.sessionId,
            providerType: entry.providerType,
            payload: entry.payload || {},
        };
    }
    return null;
}

function hasTerminalLedgerAfterDispatch(args: {
    meshId: string;
    taskId: string;
    sessionId?: string;
    dispatchEntryId?: string;
    dispatchTimestamp?: string;
}): boolean {
    const entries = readLedgerEntries(args.meshId, { tail: 500 });
    let afterDispatch = !args.dispatchEntryId && !args.dispatchTimestamp;
    const dispatchTime = args.dispatchTimestamp ? new Date(args.dispatchTimestamp).getTime() : Number.NaN;
    for (const entry of entries) {
        if (!afterDispatch) {
            if (args.dispatchEntryId && entry.id === args.dispatchEntryId) {
                afterDispatch = true;
                continue;
            }
            if (!args.dispatchEntryId && Number.isFinite(dispatchTime)) {
                const entryTime = new Date(entry.timestamp).getTime();
                if (Number.isFinite(entryTime) && entryTime >= dispatchTime) afterDispatch = true;
            }
            if (!afterDispatch) continue;
        }
        if (entry.kind !== 'task_completed' && entry.kind !== 'task_failed' && entry.kind !== 'task_stalled') continue;
        const terminalTaskId = readNonEmptyString(entry.payload?.taskId);
        if (terminalTaskId && terminalTaskId === args.taskId) return true;
        if (terminalTaskId && terminalTaskId !== args.taskId) continue;
        if (args.sessionId && entry.sessionId === args.sessionId) return true;
    }
    return false;
}

export function reconcileDirectDispatchCompletionFromTranscript(args: {
    meshId: string;
    nodeId?: string;
    sessionId: string;
    providerType?: string;
    providerSessionId?: string;
    taskId: string;
    finalSummary: string;
    transcriptMessageAt?: string;
    completedAt?: string;
    targetCoordinatorDaemonId?: string;
    source?: string;
}): { reconciled: boolean; kind?: MeshLedgerKind; alreadyTerminal?: boolean; workerResult?: unknown; ledgerEntryId?: string; reason?: string } {
    const finalSummary = readNonEmptyString(args.finalSummary);
    if (!args.meshId || !args.taskId || !args.sessionId || !finalSummary) {
        return { reconciled: false, reason: 'missing_required_completion_evidence' };
    }

    const dispatch = findDirectDispatchLedgerEntry({
        meshId: args.meshId,
        taskId: args.taskId,
        sessionId: args.sessionId,
    });
    if (hasTerminalLedgerAfterDispatch({
        meshId: args.meshId,
        taskId: args.taskId,
        sessionId: args.sessionId,
        dispatchEntryId: dispatch?.id,
        dispatchTimestamp: dispatch?.timestamp,
    })) {
        return { reconciled: false, alreadyTerminal: true, reason: 'terminal_ledger_entry_exists' };
    }

    const nodeId = readNonEmptyString(args.nodeId) || dispatch?.nodeId;
    const providerType = readNonEmptyString(args.providerType) || dispatch?.providerType || readNonEmptyString(dispatch?.payload.providerType);
    const completedAt = args.completedAt || new Date().toISOString();
    const evidence = buildTaskCompletionEvidence({
        event: 'agent:generating_completed',
        nodeId: nodeId || 'unknown',
        sessionId: args.sessionId,
        providerType,
        providerSessionId: readNonEmptyString(args.providerSessionId),
        finalSummary,
        completedAt,
    });
    const workerResult = evidence.workerResult;
    const dispatchTime = dispatch?.timestamp ? new Date(dispatch.timestamp).getTime() : Number.NaN;
    const transcriptTime = args.transcriptMessageAt ? new Date(args.transcriptMessageAt).getTime() : Number.NaN;
    const transcriptAfterDispatch = Number.isFinite(dispatchTime) && Number.isFinite(transcriptTime) && transcriptTime >= dispatchTime;
    if (workerResult.source !== 'final_summary_json' && !transcriptAfterDispatch) {
        return { reconciled: false, reason: 'transcript_not_proven_after_dispatch' };
    }
    const workerFailed = workerResult.status === 'failed' || (workerResult.status !== 'completed' && workerResult.errors.length > 0);
    const kind: MeshLedgerKind = workerFailed ? 'task_failed' : 'task_completed';

    const entry = appendLedgerEntry(args.meshId, {
        kind,
        nodeId: nodeId || undefined,
        sessionId: args.sessionId,
        providerType: providerType || undefined,
        payload: {
            event: 'agent:generating_completed',
            source: args.source || 'direct_task_transcript_reconciliation',
            taskId: args.taskId,
            providerSessionId: readNonEmptyString(args.providerSessionId),
            finalSummary,
            workerResult,
            completionDiagnostic: {
                reason: 'direct_task_transcript_reconciliation',
                dispatchEntryId: dispatch?.id,
                dispatchTimestamp: dispatch?.timestamp,
                transcriptMessageAt: readNonEmptyString(args.transcriptMessageAt),
                transcriptFinalAssistantPresent: true,
            },
            evidence,
        },
    });
    updateDirectDispatchStatus(args.meshId, args.sessionId, kind === 'task_completed' ? 'completed' : 'failed');
    markSessionDeliveriesTerminal(args.meshId, args.sessionId, kind === 'task_completed' ? 'completed' : 'failed');
    setImmediate(() => cleanupTerminalDirectDispatches());
    queuePendingMeshCoordinatorEvent({
        event: kind === 'task_completed' ? 'agent:generating_completed' : 'agent:stopped',
        meshId: args.meshId,
        nodeLabel: nodeId ? `Node '${nodeId}'` : 'Remote agent',
        nodeId: nodeId || undefined,
        metadataEvent: {
            targetSessionId: args.sessionId,
            providerType: providerType || undefined,
            providerSessionId: readNonEmptyString(args.providerSessionId),
            finalSummary,
            taskId: args.taskId,
            workerResult,
            completionDiagnostic: {
                reason: 'direct_task_transcript_reconciliation',
                terminalLedgerKind: kind,
                terminalLedgerId: entry.id,
            },
        },
        coordinatorMessage: undefined,
        queuedAt: Date.now(),
        ...(readNonEmptyString(args.targetCoordinatorDaemonId) ? { targetCoordinatorDaemonId: readNonEmptyString(args.targetCoordinatorDaemonId) } : {}),
    });

    return { reconciled: true, kind, workerResult, ledgerEntryId: entry.id };
}

export function buildNoProgressCompletionReconciliation(args: {
    meshId: string;
    nodeId?: string;
    nodeLabel: string;
    metadataEvent: Record<string, unknown>;
    sourceInstanceId?: string;
}): Record<string, unknown> | null {
    const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
    const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
    const providerType = readNonEmptyString(args.metadataEvent.providerType);
    const providerSessionId = readNonEmptyString(args.metadataEvent.providerSessionId);
    const workerResult = readWorkerResultMetadata(args.metadataEvent);
    const completionDiagnostic = readRecord(args.metadataEvent.completionDiagnostic);
    const finalSummary = readNonEmptyString(args.metadataEvent.finalSummary);
    const status = readNonEmptyString(args.metadataEvent.status).toLowerCase();
    const explicitCompletionEvidence = Boolean(
        finalSummary
        || workerResult
        || completionDiagnostic?.finalAssistantPresent === true
        || status === 'idle'
        || status === 'ready'
        || status === 'completed',
    );
    if (explicitCompletionEvidence) {
        return {
            ...args.metadataEvent,
            targetSessionId: sessionId,
            providerType,
            providerSessionId,
            finalSummary,
            source: 'no_progress_reconciliation',
            reconciledFromEvent: 'monitor:no_progress',
            timestamp: args.metadataEvent.timestamp ?? Date.now(),
            completionDiagnostic: {
                ...(completionDiagnostic || {}),
                reconciliationReason: 'provider_completion_evidence',
            },
        };
    }

    const terminal = findRecentTerminalLedgerEvidence({
        meshId: args.meshId,
        sessionId: sessionId || undefined,
        nodeId: nodeId || undefined,
    });
    if (!terminal) return null;
    return {
        ...args.metadataEvent,
        source: 'no_progress_terminal_ledger_suppression',
        terminalLedgerKind: terminal.kind,
        terminalLedgerAt: terminal.timestamp,
    };
}
