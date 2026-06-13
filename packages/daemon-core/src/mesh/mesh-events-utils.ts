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
        if (args.metadataEvent.source === 'long_generating_reconciliation') {
            return `[System] ${args.nodeLabel} already has completion evidence${metadata}. The long-generating monitor reconciled the terminal handoff and marked the session complete; wait for the queued completion event/status refresh before doing any manual transcript check.`;
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
    if (args.event === 'monitor:long_generating') {
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
