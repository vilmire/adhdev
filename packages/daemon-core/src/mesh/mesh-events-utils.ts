import type { SessionRecoveryContext } from './mesh-ledger.js';

export function readNonEmptyString(value: unknown): string {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
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
    // The ORIGINATING coordinator SESSION (not just its daemon). Carried so a worker's
    // completion event can be routed back to the exact coordinator session that
    // dispatched the work, even when several coordinator sessions share one daemon
    // (the multi-coordinator misroute). Optional + absent on legacy dispatches, in
    // which case routing falls back to the daemon-level anchor (current behaviour).
    meshCoordinatorSessionId?: string;
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
        coordinatorSessionId?: unknown;
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

    // Session-level anchor (multi-coordinator routing): stamp the originating
    // coordinator session id so the completion event can target the exact session.
    // Carried over P2P to remote workers so a remote worker's echo returns it.
    const coordinatorSessionId = readNonEmptyString(meshContext.coordinatorSessionId);
    if (coordinatorSessionId && !readNonEmptyString(settings.meshCoordinatorSessionId)) {
        stamp.meshCoordinatorSessionId = coordinatorSessionId;
    }

    // A dispatch from a coordinator is itself proof of delegation; stamp it when the
    // session is being given any mesh routing context but has no marker yet.
    if ((meshId || nodeId || coordinatorDaemonId || coordinatorSessionId) && settings.launchedByCoordinator !== true) {
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

// Cap for the worker final summary surfaced INLINE into the coordinator's chat
// (buildMeshSystemMessage). Larger than the mirror preview cap because this is the
// coordinator-facing payload that replaces a "go call mesh_read_chat" instruction —
// it should carry enough of the worker's result to act on without a second round-trip,
// while still bounding what is written into the coordinator PTY.
const MESH_COMPLETION_SURFACE_MAX_CHARS = 16000;

/**
 * The worker's final assistant text carried on a completion event — read from
 * `finalSummary` (and the `workerResult.summary` / `result.summary` fallbacks some
 * paths use). Returns '' when the event carries no assistant text (lifecycle events
 * without a summary). Shared by the coordinator chat surface (buildMeshSystemMessage)
 * and the held-event ledger audit record so both read the summary the same way.
 */
export function readMeshCompletionSummary(metadataEvent: Record<string, unknown>): string {
    const workerResult = readWorkerResultMetadata(metadataEvent);
    const resultRecord = readRecord(metadataEvent.result);
    return readNonEmptyString(metadataEvent.finalSummary)
        || readNonEmptyString(workerResult?.summary)
        || readNonEmptyString(workerResult?.finalSummary)
        || readNonEmptyString(resultRecord?.summary)
        || readNonEmptyString(resultRecord?.finalSummary);
}

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
function truncateSurfacedPreview(text: string): string {
    const truncationSuffix = '...[truncated]';
    return text.length > MESH_SURFACED_PREVIEW_MAX_CHARS
        ? `${text.slice(0, MESH_SURFACED_PREVIEW_MAX_CHARS - truncationSuffix.length)}${truncationSuffix}`
        : text;
}

export function resolveMeshSurfacedSessionPreview(
    metadataEvent: Record<string, unknown>,
): { preview: string; role: 'assistant'; receivedAt: number } | undefined {
    // 1) Completion summary — the worker's final assistant text rides a completion event
    //    as finalSummary / workerResult.summary / result.summary.
    const summaryText = readMeshCompletionSummary(metadataEvent);
    if (summaryText) {
        return {
            preview: truncateSurfacedPreview(summaryText),
            role: 'assistant',
            receivedAt: readEventTimestampValue(metadataEvent.timestamp),
        };
    }
    // 2) Status-snapshot fallback — a completion that carried NO summary (and any later
    //    status-sync event) still ships the worker's latest display message on the event as
    //    lastMessagePreview/lastMessageRole/lastMessageAt (computed by getLastDisplayMessage
    //    on the worker, attached in injectMeshSystemMessage and carried over the relay).
    //    Surface it ONLY when it is an assistant reply: a user-role last message means the
    //    turn is still mid-flight (the dispatched task is the only message), and surfacing it
    //    would both re-introduce the "inbox stuck on the user task" bug and clobber a
    //    previously surfaced assistant preview. The web inbox guard renders only an
    //    assistant-role preview anyway, so a user-role one would be inert there.
    const lastPreview = readNonEmptyString(metadataEvent.lastMessagePreview);
    const lastRole = readNonEmptyString(metadataEvent.lastMessageRole);
    if (lastPreview && lastRole === 'assistant') {
        return {
            preview: truncateSurfacedPreview(lastPreview),
            role: 'assistant',
            receivedAt: readEventTimestampValue(metadataEvent.lastMessageAt)
                || readEventTimestampValue(metadataEvent.timestamp),
        };
    }
    return undefined;
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

// The completionDiagnostic "false idle" clause, extracted from the five inline copies
// it used to be duplicated into (the ledger / metadata weak checks and isFalseIdleCompletion).
// True when the worker FSM dropped to idle WITHOUT a confirmed final assistant message for
// the turn — a finalization timeout or a "scheduled fallback" idle. cli-provider-instance
// emits this as completionDiagnostic.blockReason='missing_final_assistant' /
// finalAssistantPresent=false. The diagnostic lives at the same `completionDiagnostic` field
// on both a ledger terminal payload and a live metadata event, so one helper serves both.
export function isMissingFinalAssistantDiagnostic(record: Record<string, unknown> | undefined): boolean {
    const diag = readRecord(record?.completionDiagnostic);
    return diag?.finalAssistantPresent === false || diag?.blockReason === 'missing_final_assistant';
}

// A false-idle completion: the provider dropped to idle WITHOUT a confirmed final assistant
// message (the completionDiagnostic missing-final-assistant signal). This is a strict SUBSET
// of weak-completion evidence — it DELIBERATELY ignores evidenceLevel/reviewRecommended,
// because isGenuineCompletionEvidence (coordinator) gates the truncated-terminal supersession
// on the false-idle distinction alone. Folding evidenceLevel/reviewRecommended in here would
// change that genuine-completion judgement, so keep this narrow.
export function isFalseIdleCompletion(record: Record<string, unknown>): boolean {
    return isMissingFinalAssistantDiagnostic(record);
}

// A completion whose evidence is WEAK: the worker FSM reached idle but the turn's final
// assistant message was never confirmed (missing_final_assistant / finalAssistantPresent=false),
// or the event self-declares insufficient/weak evidence, or a review is recommended. The single
// source of truth that the live metadata path (mesh-events-pending fingerprint, this module's
// system-message builder) AND the ledger-terminal paths (mesh-events-coordinator supersession,
// mesh-events-stale reconcile) all share — the same evidenceLevel / reviewRecommended /
// completionDiagnostic fields appear on a terminal ledger payload and on a live metadata event.
//
// cli-provider-instance emits this on the CANON-C decoupled-immediate path and on a forced
// finalization timeout, and the structural approval-resolution gate (FALSEIDLE-a) can also let
// an unconfirmed approval→idle through. Such a completion is NOT trustworthy terminal evidence:
// a later genuine completion (live path) or a transcript reconcile (fallback path) may supersede
// it, and the coordinator surfaces a verify hint before declaring the task done.
//
// NOTE: this intentionally treats evidenceLevel 'weak' as weak — the ledger variants used to
// omit it, so a producer emitting 'weak' would have had its weak terminal misjudged as
// authoritative (genuine completion could no longer supersede it). Applying it uniformly here
// seals that latent divergence.
export function isWeakCompletionEvidence(record: Record<string, unknown> | undefined): boolean {
    if (!record) return false;
    const evidenceLevel = readNonEmptyString(record.evidenceLevel);
    if (evidenceLevel === 'insufficient' || evidenceLevel === 'weak') return true;
    if (record.reviewRecommended === true) return true;
    return isMissingFinalAssistantDiagnostic(record);
}

// Back-compat alias for the live metadata-event call sites (system-message builder below,
// pending-event fingerprint). Identical to isWeakCompletionEvidence; kept as a named export so
// the metadata-flavoured call sites read naturally.
export function isWeakCompletionMetadata(metadataEvent: Record<string, unknown>): boolean {
    return isWeakCompletionEvidence(metadataEvent);
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
    // (SUMMARY-SCRAPE-FALLBACK, part B) The worker resolved this turn's finalSummary from the
    // PTY screen scrape of a provider whose canonical history is its own transcript, because
    // that transcript had not been written yet. The terminal wraps and scrolls, so the summary
    // may be an arbitrary partial prefix that READS like a finished sentence. Surface it: a
    // coordinator that sees the flag can call mesh_read_chat for the full text instead of
    // acting on half of it. Only ever present when the worker asserted it.
    const summaryMayBeTruncated = completionDiagnostic?.finalSummaryMayBeTruncated === true;
    const parts = [
        readNonEmptyString(event.targetSessionId) ? `session_id=${readNonEmptyString(event.targetSessionId)}` : '',
        readNonEmptyString(event.providerType) ? `provider=${readNonEmptyString(event.providerType)}` : '',
        readNonEmptyString(event.providerSessionId) ? `provider_session_id=${readNonEmptyString(event.providerSessionId)}` : '',
        diagnosticReason ? `completion_diagnostic=${diagnosticReason}` : '',
        finalAssistantPresent ? `final_assistant=${finalAssistantPresent}` : '',
        evidenceLevel && evidenceLevel !== 'sufficient' ? `evidence_level=${evidenceLevel}` : '',
        summaryMayBeTruncated ? 'final_summary=may_be_truncated' : '',
    ].filter(Boolean);
    return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

export function buildMeshSystemMessage(args: {
    event: string;
    nodeLabel: string;
    metadataEvent: Record<string, unknown>;
    recoveryContext?: SessionRecoveryContext | null;
    /**
     * BOOTSTRAP-MSG: true when a queued task targeting this freshly-bootstrapped
     * worktree node is pending/assigned and will be (or has just been) auto-claimed
     * by the post-bootstrap queue re-fire. When set, the worktree_bootstrap_complete
     * message drops the misleading "use mesh_launch_session" advice (which would
     * spawn a DUPLICATE session alongside the auto-claimed one) and tells the
     * coordinator the queue will handle it. Absent/false → no targeted task → keep
     * the manual-launch advice. The caller computes this from the work queue; the
     * builder stays pure so both branches are unit-testable via this flag.
     */
    worktreeHasQueuedTask?: boolean;
}): string {
    const metadata = formatCompletionMetadata(args.metadataEvent);
    if (args.event === 'agent:generating_completed') {
        if (args.metadataEvent.source === 'no_progress_reconciliation') {
            return `[System] ${args.nodeLabel} already has completion evidence${metadata}. The no-progress monitor reconciled the terminal handoff and marked the session complete; wait for the queued completion event/status refresh before doing any manual transcript check.`;
        }
        const reviewRecommended = args.metadataEvent.reviewRecommended === true;
        // FALSEIDLE-b: a weak completion (missing final assistant / finalAssistantPresent=false /
        // insufficient evidence) is not trustworthy terminal evidence even when reviewRecommended
        // is not set. Append an explicit verify hint so the coordinator does not declare the task
        // done off a false idle. Only the weak case is affected — a genuine completion (final
        // assistant confirmed, no weak diagnostic) carries no extra note and is unchanged.
        const weakCompletion = isWeakCompletionMetadata(args.metadataEvent);
        const verifyTextNote = ' Completion evidence is weak — verify via mesh_read_chat or git status before declaring the task done; the worker may still be parked on an approval/modal.';
        // Auto-surface the worker's final summary directly into the coordinator chat so it
        // does not have to call mesh_read_chat just to see the result. The summary IS the
        // worker's final assistant message; embedding it here replaces the previous
        // "go call mesh_read_chat" instruction with the answer itself. This rides the
        // existing (non-modal) coordinator delivery channel — it does not write into a
        // parked harness modal. Falls back to the read_chat instruction only when the event
        // genuinely carries no summary (so behaviour is unchanged for summary-less events).
        const completionSummary = readMeshCompletionSummary(args.metadataEvent);
        if (completionSummary) {
            const truncationSuffix = '\n…[truncated — call mesh_read_chat once for the full transcript]';
            const surfaced = completionSummary.length > MESH_COMPLETION_SURFACE_MAX_CHARS
                ? `${completionSummary.slice(0, MESH_COMPLETION_SURFACE_MAX_CHARS - truncationSuffix.length)}${truncationSuffix}`
                : completionSummary;
            const verifyNote = reviewRecommended
                ? ' Completion evidence is insufficient — verify via git status or provider_session_id before assuming the task is done.'
                : (weakCompletion ? verifyTextNote : '');
            return `[System] ${args.nodeLabel} has completed its task and is now idle${metadata}. Its final summary is included below — read it directly and only call mesh_read_chat if you need the full transcript.${verifyNote}\n\n--- ${args.nodeLabel} final summary ---\n${surfaced}`;
        }
        const reviewNote = reviewRecommended
            ? ' Completion evidence is insufficient — verify via git status or provider_session_id before assuming the task is done. Use mesh_read_chat once if needed, but do not poll repeatedly.'
            : (weakCompletion
                ? `${verifyTextNote} Use mesh_read_chat once if needed, but do not poll repeatedly.`
                : ' Use mesh_read_chat once to review its final progress, but do not poll repeatedly.');
        return `[System] ${args.nodeLabel} has completed its task and is now idle${metadata}. This completion came from the agent status event path;${reviewNote}`;
    }
    if (args.event === 'agent:waiting_approval') {
        return `[System] ${args.nodeLabel} is waiting for approval to proceed${metadata}. You may use mesh_read_chat and mesh_approve to handle it.`;
    }
    if (args.event === 'agent:waiting_choice') {
        // A multi-choice QUESTION (AskUserQuestion) — NOT an approval. It is answered with
        // mesh_answer_question (never mesh_approve). Surface the question text + choices
        // inline so the coordinator can decide without a mesh_read_chat round-trip, and
        // name the correct tool + promptId (mission f1d25e11).
        const prompt = args.metadataEvent.interactivePrompt as
            | { promptId?: unknown; questions?: Array<Record<string, unknown>> }
            | undefined;
        const promptId = readNonEmptyString(args.metadataEvent.promptId)
            || (prompt && readNonEmptyString(prompt.promptId));
        const lines: string[] = [
            `[System] ${args.nodeLabel} is asking a question and is waiting for your answer${metadata}.`,
        ];
        const questions = Array.isArray(prompt?.questions) ? prompt!.questions! : [];
        if (questions.length > 0) {
            for (const q of questions) {
                const header = readNonEmptyString(q.header);
                const question = readNonEmptyString(q.question);
                const multiSelect = q.multiSelect === true;
                if (question) {
                    lines.push(`\n**${header ? `${header}: ` : ''}${question}**${multiSelect ? ' (select one or more)' : ''}`);
                }
                const options = Array.isArray(q.options) ? q.options : [];
                options.forEach((opt, i) => {
                    const record = (opt && typeof opt === 'object') ? opt as Record<string, unknown> : {};
                    const label = readNonEmptyString(record.label);
                    if (!label) return;
                    const description = readNonEmptyString(record.description);
                    lines.push(`  ${i + 1}. ${label}${description ? ` — ${description}` : ''}`);
                });
            }
        } else {
            const modalMessage = readNonEmptyString(args.metadataEvent.modalMessage);
            if (modalMessage) lines.push(`\n${modalMessage}`);
        }
        lines.push(
            `\nAnswer with mesh_answer_question(node_id, session_id${promptId ? `, promptId: "${promptId}"` : ''}, answers). ` +
            `Do NOT use mesh_approve — that only resolves yes/no consent modals, not a question. ` +
            `Use mesh_read_chat once if you need the full context first.`,
        );
        return lines.join('\n');
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
        // MESH-STALL-WATCH (feature 1: STALL detection): the status-agnostic stall
        // watchdog fires this event regardless of the reported status — a worker's
        // raw PTY output was byte-for-byte unchanged past the stall bound. Surface
        // the generalized "output unchanged" wording (with the observed status,
        // stalled duration and taskId as context) and make explicit this is
        // INFORMATIONAL — a quiet/idle worker can trip it; it is NOT a failure or
        // auto-restart. The generating-only StatusMonitor copy keeps its original
        // phrasing.
        if (args.metadataEvent.meshWorkerStall === true) {
            const observedStatus = readNonEmptyString(args.metadataEvent.observedStatus);
            const stalledMs = typeof args.metadataEvent.stalledMs === 'number' ? args.metadataEvent.stalledMs : undefined;
            const stalledSuffix = stalledMs !== undefined ? ` for ${Math.round(stalledMs / 1000)}s` : '';
            const statusSuffix = observedStatus ? ` (observed status: ${observedStatus})` : '';
            return `[System] ${args.nodeLabel}: PTY output unchanged${stalledSuffix}${statusSuffix}${metadata}. This is an informational stall — the worker's screen has been static regardless of its reported status; it may be genuinely idle, waiting, or wedged, so this is NOT a failure or auto-restart. Judge whether to inspect it: wait for pendingCoordinatorEvents/a completion event, or make one bounded mesh_read_chat check if you need to see its current screen, then wait again.`;
        }
        return `[System] ${args.nodeLabel} is still reported as generating after a long interval${metadata}. Wait for pendingCoordinatorEvents or a completion/status event; if the user explicitly asks for status, make one bounded status check and then wait again.`;
    }
    if (args.event === 'worktree_bootstrap_complete') {
        const worktreePath = readNonEmptyString(args.metadataEvent.worktreePath);
        const durationMs = typeof args.metadataEvent.durationMs === 'number' ? args.metadataEvent.durationMs : undefined;
        const prefix = `[System] ${args.nodeLabel} worktree bootstrap completed${worktreePath ? ` at ${worktreePath}` : ''}${durationMs !== undefined ? ` in ${Math.round(durationMs / 1000)}s` : ''}.`;
        // BOOTSTRAP-MSG: a task already targeting this node is auto-claimed by the
        // post-bootstrap queue re-fire (see mesh-event-forwarding worktree_bootstrap_complete
        // handler). Advising mesh_launch_session here would spawn a duplicate session.
        if (args.worktreeHasQueuedTask) {
            return `${prefix} The worktree is ready; a queued task targeting this node will auto-claim it — no manual \`mesh_launch_session\` needed.`;
        }
        return `${prefix} The worktree is ready. If a task is already queued for this worktree, auto-launch will claim it — no action needed. Launch a session manually only if you need one and none exists yet.`;
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
