import type { SessionRecoveryContext } from './mesh-ledger.js';

export function readNonEmptyString(value: unknown): string {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

// A single daemon is identified three ways across the system: the raw machineId
// (`mach_X`, what loadConfig().machineId returns and what the core forwarder uses as
// localDaemonId), the cloud daemon id (`daemon_mach_X`), and the standalone daemon id
// (`standalone_mach_X`, the runtime instanceId the MCP coordinator reports as
// ctx.localDaemonId). Worker envelope stamps (meshCoordinatorDaemonId) and coordinator
// drains use the prefixed forms, while the forwarder compares against the raw id — so a
// naive `===` treats the same daemon as remote and breaks both coordinator matching and
// the R3 direct-delivered dedup. Canonicalize to the raw id before comparing.
export function canonicalDaemonId(value: unknown): string {
    const id = readNonEmptyString(value);
    if (!id) return '';
    return id.replace(/^(?:daemon|standalone)_/, '');
}

export function sameDaemonId(a: unknown, b: unknown): boolean {
    const ca = canonicalDaemonId(a);
    const cb = canonicalDaemonId(b);
    return ca !== '' && ca === cb;
}

/**
 * The relay-safety metadata a worker session must carry so that its completion /
 * generating events route back to the coordinator proactively (without waiting for
 * a mesh_read_chat reconcile). meshCoordinatorDaemonId is the routing anchor the
 * core forwarder (injectMeshSystemMessage) keys on to pick a remote coordinator
 * target; meshNodeFor/meshNodeId identify the worker, and launchedByCoordinator is
 * the delegation proof. See resolveWorkerDelegateRouting().
 */
export interface MeshWorkerRelayStamp {
    meshNodeFor?: string;
    meshNodeId?: string;
    meshCoordinatorDaemonId?: string;
    launchedByCoordinator?: boolean;
}

/**
 * Build the relay-safety stamp from a dispatch's meshContext, only including fields
 * the session does not already carry. Returns undefined when there is nothing new to
 * stamp, so callers can skip a no-op updateSettings() write.
 *
 * This closes the remote-session relay gap: a worker session reached by a dispatch
 * that carries coordinatorDaemonId (mesh_send_task / queue assignment over P2P) gets
 * the coordinator anchor persisted onto its settings at dispatch time, even if it was
 * not launched via mesh_launch_session. Without the stamp the forwarder cannot resolve
 * a remote coordinator and the completion event sits in the pending queue until a
 * read_chat-triggered reconcile drains it.
 */
export function buildMeshWorkerRelayStamp(
    currentSettings: Record<string, unknown> | undefined,
    meshContext: {
        meshId?: unknown;
        nodeId?: unknown;
        coordinatorDaemonId?: unknown;
    } | undefined,
): MeshWorkerRelayStamp | undefined {
    if (!meshContext) return undefined;
    const settings = currentSettings && typeof currentSettings === 'object' ? currentSettings : {};
    const stamp: MeshWorkerRelayStamp = {};

    const meshId = readNonEmptyString(meshContext.meshId);
    if (meshId && !readNonEmptyString(settings.meshNodeFor)) stamp.meshNodeFor = meshId;

    const nodeId = readNonEmptyString(meshContext.nodeId);
    if (nodeId && !readNonEmptyString(settings.meshNodeId)) stamp.meshNodeId = nodeId;

    const coordinatorDaemonId = readNonEmptyString(meshContext.coordinatorDaemonId);
    if (coordinatorDaemonId && !readNonEmptyString(settings.meshCoordinatorDaemonId)) {
        stamp.meshCoordinatorDaemonId = coordinatorDaemonId;
    }

    // A dispatch from a coordinator is itself proof of delegation; stamp it when the
    // session is being given any mesh routing context but has no marker yet.
    if ((meshId || nodeId || coordinatorDaemonId) && settings.launchedByCoordinator !== true) {
        stamp.launchedByCoordinator = true;
    }

    return Object.keys(stamp).length > 0 ? stamp : undefined;
}

export function resolveEventSessionId(event: Record<string, unknown>, fallback?: unknown): string {
    return readNonEmptyString(event.targetSessionId)
        || readNonEmptyString(event.sessionId)
        || readNonEmptyString(event.instanceId)
        || readNonEmptyString(fallback);
}

export function readRefineJobId(event: { metadataEvent?: Record<string, unknown> } | Record<string, unknown>): string {
    const metadata = readRecord((event as any).metadataEvent) || event as Record<string, unknown>;
    const result = readRecord(metadata.result);
    const refineJob = readRecord(result?.refineJob);
    return readNonEmptyString(metadata.jobId) || readNonEmptyString(refineJob?.jobId);
}

export function readWorkerResultMetadata(event: Record<string, unknown>): Record<string, unknown> | undefined {
    return readRecord(event.workerResult) || readRecord(event.meshWorkerResult) || readRecord(event.structuredResult);
}

const MESH_SURFACED_PREVIEW_MAX_CHARS = 512;

/**
 * A coordinator that surfaces a REMOTE worker's mesh session has no local instance for
 * it, so the status snapshot's getLastDisplayMessage has nothing to read and the only
 * preview the coordinator-mirrored copy could ever carry comes from the worker's
 * completion event. The worker's latest assistant reply rides on that event as
 * `finalSummary` (and as `workerResult.summary` / `result.summary` on some paths).
 *
 * This resolves that assistant text into a preview the coordinator can stamp onto its
 * mirror entry so the mobile inbox shows the worker's latest assistant response instead
 * of being stuck on the first dispatched user task (which is the only message the
 * coordinator-side transcript ever holds). Returns undefined when the event carries no
 * assistant text — non-completion lifecycle events (generating_started / ready without a
 * summary) must NOT clobber a previously surfaced preview.
 */
export function resolveMeshSurfacedSessionPreview(
    metadataEvent: Record<string, unknown>,
): { preview: string; role: 'assistant'; receivedAt: number } | undefined {
    const workerResult = readWorkerResultMetadata(metadataEvent);
    const resultRecord = readRecord(metadataEvent.result);
    const summaryText = readNonEmptyString(metadataEvent.finalSummary)
        || readNonEmptyString(workerResult?.summary)
        || readNonEmptyString(workerResult?.finalSummary)
        || readNonEmptyString(resultRecord?.summary)
        || readNonEmptyString(resultRecord?.finalSummary);
    if (!summaryText) return undefined;
    const truncationSuffix = '...[truncated]';
    const preview = summaryText.length > MESH_SURFACED_PREVIEW_MAX_CHARS
        ? `${summaryText.slice(0, MESH_SURFACED_PREVIEW_MAX_CHARS - truncationSuffix.length)}${truncationSuffix}`
        : summaryText;
    const timestamp = readEventTimestampValue(metadataEvent.timestamp);
    return { preview, role: 'assistant', receivedAt: timestamp };
}

function readEventTimestampValue(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
        const dateMs = Date.parse(value);
        if (Number.isFinite(dateMs)) return dateMs;
    }
    return 0;
}

function formatCompletionMetadata(event: Record<string, unknown>): string {
    const completionDiagnostic = event.completionDiagnostic && typeof event.completionDiagnostic === 'object'
        ? event.completionDiagnostic as Record<string, unknown>
        : null;
    const diagnosticReason = completionDiagnostic
        ? readNonEmptyString(completionDiagnostic.blockReason) || 'present'
        : '';
    const finalAssistantPresent = typeof completionDiagnostic?.finalAssistantPresent === 'boolean'
        ? String(completionDiagnostic.finalAssistantPresent)
        : '';
    const evidenceLevel = readNonEmptyString(event.evidenceLevel);
    const parts = [
        readNonEmptyString(event.targetSessionId) ? `session_id=${readNonEmptyString(event.targetSessionId)}` : '',
        readNonEmptyString(event.providerType) ? `provider=${readNonEmptyString(event.providerType)}` : '',
        readNonEmptyString(event.providerSessionId) ? `provider_session_id=${readNonEmptyString(event.providerSessionId)}` : '',
        diagnosticReason ? `completion_diagnostic=${diagnosticReason}` : '',
        finalAssistantPresent ? `final_assistant=${finalAssistantPresent}` : '',
        evidenceLevel && evidenceLevel !== 'sufficient' ? `evidence_level=${evidenceLevel}` : '',
    ].filter(Boolean);
    return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

export function buildMeshSystemMessage(args: {
    event: string;
    nodeLabel: string;
    metadataEvent: Record<string, unknown>;
    recoveryContext?: SessionRecoveryContext | null;
}): string {
    const metadata = formatCompletionMetadata(args.metadataEvent);
    if (args.event === 'agent:generating_completed') {
        if (args.metadataEvent.source === 'no_progress_reconciliation') {
            return `[System] ${args.nodeLabel} already has completion evidence${metadata}. The no-progress monitor reconciled the terminal handoff and marked the session complete; wait for the queued completion event/status refresh before doing any manual transcript check.`;
        }
        const reviewNote = args.metadataEvent.reviewRecommended === true
            ? ' Completion evidence is insufficient — verify via git status or provider_session_id before assuming the task is done. Use mesh_read_chat once if needed, but do not poll repeatedly.'
            : ' Use mesh_read_chat once to review its final progress, but do not poll repeatedly.';
        return `[System] ${args.nodeLabel} has completed its task and is now idle${metadata}. This completion came from the agent status event path;${reviewNote}`;
    }
    if (args.event === 'agent:waiting_approval') {
        return `[System] ${args.nodeLabel} is waiting for approval to proceed${metadata}. You may use mesh_read_chat and mesh_approve to handle it.`;
    }
    if (args.event === 'agent:stopped') {
        const rc = args.recoveryContext;
        if (rc && rc.consecutiveNodeFailures > 0) {
            const parts = [
                `[System] ${args.nodeLabel} has stopped unexpectedly${metadata}.`,
                `\n\n**Recovery Context:**`,
                `- Consecutive failures on this node: ${rc.consecutiveNodeFailures}`,
                rc.taskAttemptCount > 0 ? `- This task has been attempted ${rc.taskAttemptCount} time(s)` : '',
                `- Recommendation: ${rc.advice}`,
            ];
            if (rc.retryRecommended && rc.lastTaskMessage) {
                parts.push(
                    `\n\n**Original task to retry:**`,
                    `> ${rc.lastTaskMessage.length > 300 ? rc.lastTaskMessage.slice(0, 300) + '...' : rc.lastTaskMessage}`,
                    `\nTo retry: call \`mesh_launch_session\` for this node, then \`mesh_send_task\` with the original task.`,
                );
            } else if (!rc.retryRecommended) {
                parts.push(
                    `\nDo NOT retry on this node. Consider reassigning to a different node or asking the user for guidance.`,
                );
            }
            return parts.filter(Boolean).join('\n');
        }
        return `[System] ${args.nodeLabel} has stopped${metadata}. Use mesh_read_chat once if you need to inspect its last output.`;
    }
    if (args.event === 'monitor:no_progress') {
        return `[System] ${args.nodeLabel} is still reported as generating after a long interval${metadata}. Wait for pendingCoordinatorEvents or a completion/status event; if the user explicitly asks for status, make one bounded status check and then wait again.`;
    }
    if (args.event === 'worktree_bootstrap_complete') {
        const worktreePath = readNonEmptyString(args.metadataEvent.worktreePath);
        const durationMs = typeof args.metadataEvent.durationMs === 'number' ? args.metadataEvent.durationMs : undefined;
        return `[System] ${args.nodeLabel} worktree bootstrap completed${worktreePath ? ` at ${worktreePath}` : ''}${durationMs !== undefined ? ` in ${Math.round(durationMs / 1000)}s` : ''}. The worktree is ready — use \`mesh_launch_session\` to start an agent.`;
    }
    if (args.event === 'worktree_bootstrap_failed') {
        const error = readNonEmptyString(args.metadataEvent.error);
        return `[System] ${args.nodeLabel} worktree bootstrap failed${error ? `: ${error}` : '.'}. Use \`mesh_retry_node_bootstrap\` to retry or inspect the node state.`;
    }
    if (args.event === 'refine:accepted') {
        const jobId = readRefineJobId({ metadataEvent: args.metadataEvent });
        return `[System] Refinery accepted async job${jobId ? ` ${jobId}` : ''} for ${args.nodeLabel}. Completion/failure will be delivered as a terminal refine event; do not poll repeatedly.`;
    }
    if (args.event === 'refine:completed') {
        const jobId = readRefineJobId({ metadataEvent: args.metadataEvent });
        const result = readRecord(args.metadataEvent.result);
        const validationSummary = readRecord(result?.validationSummary);
        const patchEquivalence = readRecord(result?.patchEquivalence);
        const finalConvergence = readRecord(result?.finalBranchConvergenceState);
        const validationStatus = readNonEmptyString(validationSummary?.status);
        const patchStatus = readNonEmptyString(patchEquivalence?.status)
            || (patchEquivalence?.equivalent === true ? 'passed' : '');
        const into = readNonEmptyString(result?.into);
        const branch = readNonEmptyString(result?.branch);
        const mergeStatus = result?.merged === true ? 'merged' : readNonEmptyString(finalConvergence?.status);
        const convergenceStatus = readNonEmptyString(finalConvergence?.status);
        const nextStep = readNonEmptyString(result?.nextStep)
            || readNonEmptyString(finalConvergence?.nextStep)
            || 'Continue from the updated mesh state.';
        const details = [
            jobId ? `job_id=${jobId}` : '',
            branch && into ? `${branch}→${into}` : '',
            validationStatus ? `validation=${validationStatus}` : '',
            patchStatus ? `patch_equivalence=${patchStatus}` : '',
            mergeStatus ? `merge=${mergeStatus}` : '',
            convergenceStatus ? `final_convergence=${convergenceStatus}` : '',
        ].filter(Boolean).join('; ');
        return `[System] Refinery async job for ${args.nodeLabel} completed successfully${details ? ` (${details})` : ''}.\nNext step: ${nextStep}`;
    }
    if (args.event === 'refine:failed') {
        const jobId = readRefineJobId({ metadataEvent: args.metadataEvent });
        const result = readRecord(args.metadataEvent.result);
        const validationSummary = readRecord(result?.validationSummary);
        const patchEquivalence = readRecord(result?.patchEquivalence);
        const finalConvergence = readRecord(result?.finalBranchConvergenceState);
        const code = readNonEmptyString(result?.code);
        const error = readNonEmptyString(result?.error);
        const validationStatus = readNonEmptyString(validationSummary?.status);
        const patchStatus = readNonEmptyString(patchEquivalence?.status)
            || (patchEquivalence?.equivalent === true ? 'passed' : '');
        const mergeStatus = result?.merged === true
            ? 'merged'
            : finalConvergence?.merged === false
                ? 'not_merged'
                : '';
        const convergenceStatus = readNonEmptyString(result?.convergenceStatus)
            || readNonEmptyString(finalConvergence?.status);
        const blockedReason = readNonEmptyString(result?.blockedReason);
        const nextStep = readNonEmptyString(result?.nextStep) || readNonEmptyString(finalConvergence?.nextStep);
        const details = [
            jobId ? `job_id=${jobId}` : '',
            code ? `code=${code}` : '',
            validationStatus ? `validation=${validationStatus}` : '',
            patchStatus ? `patch_equivalence=${patchStatus}` : '',
            mergeStatus ? `merge=${mergeStatus}` : '',
            convergenceStatus ? `convergence=${convergenceStatus}` : '',
            blockedReason ? `reason=${blockedReason}` : '',
        ].filter(Boolean).join('; ');
        const parts = [
            `[System] Refinery async job for ${args.nodeLabel} failed${details ? ` (${details})` : ''}${error ? `: ${error}` : '.'}`,
            nextStep ? `Next step: ${nextStep}` : 'Review the terminal refine event/ledger before retrying.',
        ];
        return parts.join('\n');
    }
    return '';
}
