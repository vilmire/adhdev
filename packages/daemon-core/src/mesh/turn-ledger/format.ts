// ---------------------------------------------------------------------------
// turn-ledger/format — deliver-time rendering of a `turn.notify`
// ---------------------------------------------------------------------------
// Wiring-unification Phase C-W3 (docs/design/2026-09-23-wiring-unification.md
// §5 C2, C10-1). Today's coordinator-facing text is built at WRITE time and
// baked into the pending-event queue (`buildMeshSystemMessage`,
// `mesh/mesh-events-utils.ts`); this module is the C2 replacement — text is
// rendered at DELIVER time from a `turn_events` row's content-free scalars
// plus a `mesh.<id>.handoff` ref, resolved on the spot by the injected
// `resolveRef`. Precedent for deliver-time rendering already exists
// (`injectPendingIntoCoordinator`, `mesh-reconcile-coordinator-drain.ts:333-349`).
//
// PURE. No imports from `providers/**` (check:boundaries forbids
// `mesh/** -> providers/**`) and no I/O of its own — the handoff lookup and
// the mesh-status-line string are both injected by the caller, so this file
// stays a leaf the same way `mesh-events-utils.ts:buildMeshSystemMessage` is
// today, just relocated to render from ledger scalars instead of a live
// metadataEvent blob.
//
// BYTE-IDENTICAL BY DESIGN. Every existing shape's rendered text must match
// today's templates exactly (see test/turn-ledger/format.test.ts's golden
// tests, which call the legacy builders directly and diff against
// `renderTurnNotify`) so the live coordinator sees no behavior change on
// cutover. `late_completion` and `cancelled` are new shapes with no legacy
// precedent (§C1 R27 / R27a) — their wording is specified fresh, below.
// ---------------------------------------------------------------------------

import type { NotifyKind, SummaryRef } from '@adhdev/mesh-shared';

// ─── injected dependencies ─────────────────────────────────────────────────

/**
 * Resolve a `SummaryRef` to its text. Injected rather than imported so this
 * file never reaches into `seqscribe/**` (the handoff topic reader) or
 * `providers/**` — the boundary gate forbids both from `mesh/**`. Returns
 * `null` when the ref cannot be resolved (not yet replicated, evicted,
 * malformed) — the caller does NOT throw; the renderer falls back to the
 * deterministic pointer line and records the ref in `contentRefsMissing`.
 */
export type ResolveSummaryRef = (ref: SummaryRef) => string | null;

// ─── scalar input (content-free; mirrors a turn_events row / MeshTopicEntry) ─

/** Refusal reasons that reach the coordinator as `dispatch_failed` text. Kept local until turn-ledger/types.ts exports a shared name (C-W2 in flight). */
export type FormatDispatchFailureReason = 'worker_absent' | 'transport_error' | 'spawn_failed' | 'rejected_by_worker' | 'timeout';

/** `agent:stopped` / `session_error` sub-reasons the legacy templates branch on. */
export type FormatStopReason =
    | 'auth_failed' | 'billing_failed' | 'quota_exceeded'
    | 'recovery_context' | 'direct_not_redelivered' | 'plain';

/** Worktree bootstrap outcome. */
export type FormatWorktreeOutcome = 'complete' | 'failed';

/** Refine async job outcome. */
export type FormatRefineOutcome = 'accepted' | 'completed' | 'failed';

/** One AskUserQuestion option (label/description only — no free-form injection beyond what the legacy builder already embeds inline). */
export interface FormatChoiceOption {
    label: string;
    description?: string;
}

/** One AskUserQuestion question block. */
export interface FormatChoiceQuestion {
    header?: string;
    question: string;
    multiSelect?: boolean;
    options: FormatChoiceOption[];
}

/**
 * Per-node failure row for a batch `refine:failed` notice
 * (`mesh-events-utils.ts:568-580`, "BATCH-PER-NODE").
 */
export interface FormatRefineNodeFailure {
    nodeId?: string;
    convergence?: string;
    code?: string;
    stage?: string;
    /** Free text (node-level error) — capped to 200 chars by the legacy template; truncation is applied here too. */
    error?: string;
}

/**
 * Recovery-context scalars (`SessionRecoveryContext`, `mesh-ledger.ts`) minus
 * `lastTaskMessage`, which is content and travels as `refs.prompt` instead of
 * inline text — see `RenderTurnNotifyInput.refs.prompt`.
 */
export interface FormatRecoveryContext {
    consecutiveNodeFailures: number;
    taskAttemptCount: number;
    advice: string;
    retryRecommended: boolean;
}

/**
 * The content-free fields a `turn_events` row / `MeshTopicEntry` carries that
 * `renderTurnNotify` needs to reproduce today's ~15 message shapes. Every
 * field here is an identifier, enum, boolean, number, or timestamp — never
 * free text (free text only ever arrives through `refs`, resolved via
 * `resolveRef`). This mirrors the CLAUDE.md "Server content boundary"
 * allow-list discipline (a `turn.notify` entry is exactly as content-free as
 * a `RoutingSessionEntry`), extended here to the in-process render step.
 */
export interface TurnNotifyScalars {
    taskId?: string;
    attemptId?: string;
    generation?: number;
    sessionId?: string;
    nodeId?: string;
    nodeLabel: string;
    providerType?: string;
    providerSessionId?: string;

    /** `turn_end.strength` / `transcript_final` strength classification. */
    strength?: 'genuine' | 'weak';
    /** Reason enum driving `agent:stopped` branching. */
    stopReason?: FormatStopReason;
    /** `direct_not_redelivered`: the reclaim cause (a closed TurnReason enum value) the direct dispatch failed with. */
    directFailureCause?: string;
    /** Why evidence is weak (mirrors `evidenceLevel`/`reviewRecommended`/`completionDiagnostic` collapse already performed upstream by the reducer). */
    reviewRecommended?: boolean;
    /** `completionDiagnostic.finalAssistantMayBeTruncated` equivalent. */
    summaryMayBeTruncated?: boolean;
    /** True when this is a no-progress-monitor reconciliation rather than a live completion. */
    noProgressReconciled?: boolean;
    /** True when the completion was forced by finalization-timeout with no response. */
    forcedTimeoutNoResponse?: boolean;

    /** Hollow-completion counters (`hollowCompletion.{requeueCount,maxRetries,maxRetriesExhausted}`). */
    hollow?: { requeueCount: number; maxRetries: number; maxRetriesExhausted: boolean };

    /** `dispatch_failed` reason. */
    dispatchFailureReason?: FormatDispatchFailureReason;

    /** Cancellation reason (new shape — no legacy precedent). */
    cancelReason?: string;
    /** `late_completion` — the superseded generation the g−1 summary came from. */
    priorGeneration?: number;

    /** Choice/approval `promptId`. */
    promptId?: string;
    questions?: FormatChoiceQuestion[];

    /** No-progress / stall-watchdog scalars. */
    stalledMs?: number;
    observedStatus?: string;
    meshWorkerStall?: boolean;

    /** Worktree bootstrap scalars. */
    worktreeOutcome?: FormatWorktreeOutcome;
    worktreePath?: string;
    durationMs?: number;
    worktreeHasQueuedTask?: boolean;

    /** Refine async job scalars. */
    refineOutcome?: FormatRefineOutcome;
    jobId?: string;
    refineBranch?: string;
    refineInto?: string;
    validationStatus?: string;
    patchEquivalenceStatus?: string;
    mergeStatus?: string;
    convergenceStatus?: string;
    refineCode?: string;
    refineBlockedReason?: string;
    refineNextStep?: string;
    refineBatch?: boolean;
    refineFailedNodes?: FormatRefineNodeFailure[];

    /** Worker progress note task id (the note text itself is `refs.note`). */
    progressTaskId?: string;

    /** Report-substitution scalars (`shadowedByWorkerReport`). */
    reportTaskId?: string;
    reportOutcome?: string;
    reportHasSummary?: boolean;

    /** Recovery-context scalars minus the content field (`refs.prompt`). */
    recoveryContext?: FormatRecoveryContext;

    timestamps?: { at?: number };

    /**
     * The `formatCompletionMetadata` suffix scalars (`mesh-events-utils.ts:260-288`):
     * a derived, content-free `(session_id=...; provider=...; ...)` parenthetical
     * appended after the lead sentence on every `completed`/`stopped` shape.
     * Kept as its own sub-object rather than flattened, since it is exactly the
     * "diagnostic sidecar", never the message body.
     */
    completionMetadata?: {
        diagnosticReason?: string;
        finalAssistantPresent?: boolean;
        evidenceLevel?: string;
        summaryMayBeTruncated?: boolean;
    };
}

/** Named ref slots a `turn.notify` entry may carry, resolved lazily via `resolveRef`. */
export interface TurnNotifyRefs {
    /** Completion/candidate final summary, or a weak-end summary. */
    summary?: SummaryRef;
    /** `report_completion` verbatim summary (report-substitution shape). */
    report?: SummaryRef;
    /** Worker progress note text. */
    note?: SummaryRef;
    /** Original coordinator/user prompt text (recovery-context "Original task to retry"). */
    prompt?: SummaryRef;
    /** Error/detail text (auth/billing/quota failure detail, worktree bootstrap error, refine job top-level error). */
    error?: SummaryRef;
    /** Last coordinator/user message shown in recovery-context retry advice — alias kept distinct from `prompt` per the deliverable's spec; both resolve through the same lookup. */
    lastTaskMessage?: SummaryRef;
    /** Idle/mission-close notice mission title. */
    missionTitle?: SummaryRef;
}

export interface RenderTurnNotifyInput {
    notify: NotifyKind;
    scalars: TurnNotifyScalars;
    refs: TurnNotifyRefs;
    resolveRef: ResolveSummaryRef;
    /** `buildMeshStatusLineForNotification` output, appended verbatim when present (mirrors `injectPendingIntoCoordinator`'s inject-time append). */
    statusLine?: string | null;
}

export interface RenderTurnNotifyResult {
    text: string;
    kind: NotifyKind;
    /** Refs the renderer needed but `resolveRef` returned `null` for — the caller decides whether to defer delivery (≤ `quietWindowMs`) or ship the pointer line. */
    contentRefsMissing: SummaryRef[];
}

// ─── shared helpers (ported verbatim from mesh-events-utils.ts / worker-report.ts) ─

const MESH_COMPLETION_SURFACE_MAX_CHARS = 16000;
const RECOVERY_PROMPT_TRUNCATE_CHARS = 300;
const REFINE_NODE_ERROR_TRUNCATE_CHARS = 200;

/**
 * Deterministic pointer line for a ref that failed to resolve. Named after
 * the `mesh_task_report` MCP tool per the design doc's C2 note ("delivers
 * with a `mesh_task_report` pointer"), and after the collected-missing-ref
 * bookkeeping in `contentRefsMissing`.
 */
function pointerLine(label: string, taskId: string | undefined): string {
    const taskSuffix = taskId ? ` for task ${taskId}` : '';
    return `[System] ${label} is not yet available${taskSuffix} — call mesh_task_report once it replicates; do not poll repeatedly.`;
}

function resolve(
    ref: SummaryRef | undefined,
    resolveRef: ResolveSummaryRef,
    missing: SummaryRef[],
): string | null {
    if (!ref) return null;
    const text = resolveRef(ref);
    if (text === null) missing.push(ref);
    return text;
}

function truncate(text: string, maxChars: number, suffix: string): string {
    return text.length > maxChars ? `${text.slice(0, maxChars - suffix.length)}${suffix}` : text;
}

/**
 * `mesh-events-utils.ts:260-288`'s `slice(0, N) + '...'` truncation — the
 * suffix is APPENDED after the N-char slice (total length N + suffix.length),
 * unlike `truncate()` above which reserves room for the suffix inside the cap.
 * Kept as a separate helper because the two legacy templates genuinely use
 * different truncation math and this file must reproduce both exactly.
 */
function truncateAppend(text: string, maxChars: number, suffix: string): string {
    return text.length > maxChars ? `${text.slice(0, maxChars)}${suffix}` : text;
}

/**
 * Port of `formatCompletionMetadata` (`mesh-events-utils.ts:260-288`): the
 * derived `(session_id=...; provider=...; ...)` parenthetical appended to the
 * lead sentence on `completed`/`stopped` shapes. Pure function of scalars —
 * no ref resolution, since every field it reads is already content-free.
 */
function formatMetadataSuffix(s: TurnNotifyScalars): string {
    const m = s.completionMetadata;
    const parts = [
        s.sessionId ? `session_id=${s.sessionId}` : '',
        s.providerType ? `provider=${s.providerType}` : '',
        s.providerSessionId ? `provider_session_id=${s.providerSessionId}` : '',
        m?.diagnosticReason ? `completion_diagnostic=${m.diagnosticReason}` : '',
        m?.finalAssistantPresent !== undefined ? `final_assistant=${String(m.finalAssistantPresent)}` : '',
        m?.evidenceLevel && m.evidenceLevel !== 'sufficient' ? `evidence_level=${m.evidenceLevel}` : '',
        m?.summaryMayBeTruncated ? 'final_summary=may_be_truncated' : '',
    ].filter(Boolean);
    return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

function appendStatusLine(text: string, statusLine: string | null | undefined): string {
    return statusLine ? `${text}\n${statusLine}` : text;
}

// ─── per-shape renderers ────────────────────────────────────────────────────

function renderCompleted(input: RenderTurnNotifyInput, missing: SummaryRef[]): string {
    const s = input.scalars;
    const nodeLabel = s.nodeLabel;
    const metadata = formatMetadataSuffix(s);

    if (s.noProgressReconciled) {
        return `[System] ${nodeLabel} already has completion evidence${metadata}. The no-progress monitor reconciled the terminal handoff and marked the session complete; wait for the queued completion event/status refresh before doing any manual transcript check.`;
    }

    if (s.hollow) {
        const { requeueCount, maxRetries, maxRetriesExhausted } = s.hollow;
        if (maxRetriesExhausted) {
            return `[System] ${nodeLabel} returned an empty final response with insufficient evidence${metadata}. The bounded retry was already used (${requeueCount}/${maxRetries}), so the task failed through max_retries_exceeded instead of being recorded as completed. Inspect the provider failure/authentication state before retrying manually.`;
        }
        return `[System] ${nodeLabel} returned an empty final response with insufficient evidence${metadata}. The completion was rejected and the same task was requeued (${requeueCount}/${maxRetries}); it was NOT recorded as completed.`;
    }

    if (s.forcedTimeoutNoResponse) {
        return `[System] ${nodeLabel} was forcibly terminated WITHOUT a response${metadata}: the finalization wait expired with no final assistant answer, so the task was recorded as a forced termination (failed), NOT as a completion. Verify the actual state with mesh_read_chat / git status and re-dispatch the task if the work is still needed.`;
    }

    const weakCompletion = s.strength === 'weak';
    const completionLead = weakCompletion
        ? `[System] ${nodeLabel} reported a possible completion (weak evidence) — awaiting confirmation${metadata}.`
        : `[System] ${nodeLabel} has completed its task and is now idle${metadata}.`;
    const verifyTextNote = ' Completion evidence is weak — verify via mesh_read_chat or git status before declaring the task done; the worker may still be mid-turn or parked on an approval/modal.';

    const completionSummary = resolve(input.refs.summary, input.resolveRef, missing);
    if (completionSummary) {
        const truncationSuffix = '\n…[truncated — call mesh_read_chat once for the full transcript]';
        const surfaced = truncate(completionSummary, MESH_COMPLETION_SURFACE_MAX_CHARS, truncationSuffix);
        const verifyNote = s.reviewRecommended
            ? ' Completion evidence is insufficient — verify via git status or provider_session_id before assuming the task is done.'
            : (weakCompletion ? verifyTextNote : '');
        const summaryLead = weakCompletion
            ? 'Its summary is included below — treat it as a candidate result, not a confirmed final one;'
            : 'Its final summary is included below — read it directly and only call mesh_read_chat if you need the full transcript.';
        return `${completionLead} ${summaryLead}${verifyNote}\n\n--- ${nodeLabel} final summary ---\n${surfaced}`;
    }
    if (input.refs.summary) {
        // A summary ref was declared but did not resolve — fall through to the
        // pointer line instead of silently reverting to the no-summary text,
        // so the coordinator knows to retry rather than assuming there was
        // never a summary. Status-line append happens once, at the top level
        // (renderTurnNotify) — not duplicated here.
        return `${completionLead} ${pointerLine(`${nodeLabel}'s final summary`, s.taskId)}`;
    }

    const reviewNote = s.reviewRecommended
        ? ' Completion evidence is insufficient — verify via git status or provider_session_id before assuming the task is done. Use mesh_read_chat once if needed, but do not poll repeatedly.'
        : (weakCompletion
            ? `${verifyTextNote} Use mesh_read_chat once if needed, but do not poll repeatedly.`
            : ' Use mesh_read_chat once to review its final progress, but do not poll repeatedly.');
    return `${completionLead} This completion came from the agent status event path;${reviewNote}`;
}

function renderApproval(input: RenderTurnNotifyInput): string {
    return `[System] ${input.scalars.nodeLabel} is waiting for approval to proceed. You may use mesh_read_chat and mesh_approve to handle it.`;
}

function renderChoice(input: RenderTurnNotifyInput, missing: SummaryRef[]): string {
    const s = input.scalars;
    const lines: string[] = [`[System] ${s.nodeLabel} is asking a question and is waiting for your answer.`];
    const questions = s.questions ?? [];
    if (questions.length > 0) {
        for (const q of questions) {
            if (q.question) {
                lines.push(`\n**${q.header ? `${q.header}: ` : ''}${q.question}**${q.multiSelect ? ' (select one or more)' : ''}`);
            }
            q.options.forEach((opt, i) => {
                if (!opt.label) return;
                lines.push(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`);
            });
        }
    } else {
        const modalMessage = resolve(input.refs.summary, input.resolveRef, missing);
        if (modalMessage) lines.push(`\n${modalMessage}`);
    }
    lines.push(
        `\nAnswer with mesh_answer_question(node_id, session_id${s.promptId ? `, promptId: "${s.promptId}"` : ''}, answers). `
        + `Do NOT use mesh_approve — that only resolves yes/no consent modals, not a question. `
        + `Use mesh_read_chat once if you need the full context first.`,
    );
    return lines.join('\n');
}

function renderStopped(input: RenderTurnNotifyInput, missing: SummaryRef[]): string {
    const s = input.scalars;
    const nodeLabel = s.nodeLabel;
    const metadata = formatMetadataSuffix(s);

    if (s.stopReason === 'auth_failed' || s.stopReason === 'billing_failed') {
        const kind = s.stopReason === 'billing_failed' ? 'billing/subscription' : 'authentication';
        const detail = resolve(input.refs.error, input.resolveRef, missing) ?? resolve(input.refs.summary, input.resolveRef, missing);
        return `[System] ${nodeLabel} stopped because the provider reported a non-retryable ${kind} failure${metadata}. Automatic recovery was suppressed so the same rejected credential or entitlement does not waste retries.${detail ? ` ${detail}` : ''}`;
    }
    if (s.stopReason === 'quota_exceeded') {
        const detail = resolve(input.refs.error, input.resolveRef, missing) ?? resolve(input.refs.summary, input.resolveRef, missing);
        return `[System] ${nodeLabel} stopped because the provider's usage quota is exhausted${metadata}. This is not a billing or auth problem — it resets automatically at the next window boundary, and ADHDev will resume work on it once quota is available.${detail ? ` ${detail}` : ''}`;
    }
    if (s.stopReason === 'direct_not_redelivered') {
        const cause = s.directFailureCause ? ` (${s.directFailureCause})` : '';
        return `[System] ${nodeLabel}: direct dispatch${s.taskId ? ` of task ${s.taskId}` : ''} failed${cause}${metadata} — the attempt ended without a completion, and a mesh_send_task dispatch is never redelivered automatically. If the work is still needed, send it again with mesh_send_task (or enqueue it); use mesh_read_chat once if you need to inspect the worker first.`;
    }
    if (s.stopReason === 'recovery_context' && s.recoveryContext && s.recoveryContext.consecutiveNodeFailures > 0) {
        const rc = s.recoveryContext;
        const parts = [
            `[System] ${nodeLabel} has stopped unexpectedly${metadata}.`,
            `\n\n**Recovery Context:**`,
            `- Consecutive failures on this node: ${rc.consecutiveNodeFailures}`,
            rc.taskAttemptCount > 0 ? `- This task has been attempted ${rc.taskAttemptCount} time(s)` : '',
            `- Recommendation: ${rc.advice}`,
        ];
        const lastTaskMessage = resolve(input.refs.lastTaskMessage ?? input.refs.prompt, input.resolveRef, missing);
        if (rc.retryRecommended && lastTaskMessage) {
            parts.push(
                `\n\n**Original task to retry:**`,
                `> ${truncateAppend(lastTaskMessage, RECOVERY_PROMPT_TRUNCATE_CHARS, '...')}`,
                `\nTo retry: call \`mesh_launch_session\` for this node, then \`mesh_send_task\` with the original task.`,
            );
        } else if (!rc.retryRecommended) {
            parts.push(`\nDo NOT retry on this node. Consider reassigning to a different node or asking the user for guidance.`);
        }
        return parts.filter(Boolean).join('\n');
    }
    return `[System] ${nodeLabel} has stopped${metadata}. Use mesh_read_chat once if you need to inspect its last output.`;
}

function renderNoProgress(input: RenderTurnNotifyInput): string {
    const s = input.scalars;
    if (s.meshWorkerStall) {
        const stalledSuffix = s.stalledMs !== undefined ? ` for ${Math.round(s.stalledMs / 1000)}s` : '';
        const statusSuffix = s.observedStatus ? ` (observed status: ${s.observedStatus})` : '';
        return `[System] ${s.nodeLabel}: PTY output unchanged${stalledSuffix}${statusSuffix}. This is an informational stall — the worker's screen has been static regardless of its reported status; it may be genuinely idle, waiting, or wedged, so this is NOT a failure or auto-restart. Judge whether to inspect it: wait for pendingCoordinatorEvents/a completion event, or make one bounded mesh_read_chat check if you need to see its current screen, then wait again.`;
    }
    return `[System] ${s.nodeLabel} is still reported as generating after a long interval. Wait for pendingCoordinatorEvents or a completion/status event; if the user explicitly asks for status, make one bounded status check and then wait again.`;
}

function renderProgress(input: RenderTurnNotifyInput, missing: SummaryRef[]): string {
    const s = input.scalars;
    const note = resolve(input.refs.note, input.resolveRef, missing);
    const taskId = s.progressTaskId ?? s.taskId ?? '';
    if (note === null) return pointerLine(`${s.nodeLabel}'s progress note`, taskId);
    return `[System] ${s.nodeLabel} progress on task ${taskId}: ${note.trim()}`
        + ' — this is an informational mid-task update, NOT a completion. The task is still running;'
        + ' do not dispatch it elsewhere and do not poll. Wait for its completion event.';
}

/** Worktree bootstrap complete/failed — both notify kinds fold under `mesh_event` today (no dedicated NotifyKind); dispatched on `scalars.worktreeOutcome`. */
function renderWorktreeBootstrap(input: RenderTurnNotifyInput, missing: SummaryRef[]): string {
    const s = input.scalars;
    if (s.worktreeOutcome === 'failed') {
        const error = resolve(input.refs.error, input.resolveRef, missing);
        return `[System] ${s.nodeLabel} worktree bootstrap failed${error ? `: ${error}` : '.'}. Use \`mesh_retry_node_bootstrap\` to retry or inspect the node state.`;
    }
    const prefix = `[System] ${s.nodeLabel} worktree bootstrap completed${s.worktreePath ? ` at ${s.worktreePath}` : ''}${s.durationMs !== undefined ? ` in ${Math.round(s.durationMs / 1000)}s` : ''}.`;
    if (s.worktreeHasQueuedTask) {
        return `${prefix} The worktree is ready; a queued task targeting this node will auto-claim it — no manual \`mesh_launch_session\` needed.`;
    }
    return `${prefix} The worktree is ready. If a task is already queued for this worktree, auto-launch will claim it — no action needed. Launch a session manually only if you need one and none exists yet.`;
}

/** Refine accepted/completed/failed — folds under `mesh_event`, dispatched on `scalars.refineOutcome`. */
function renderRefine(input: RenderTurnNotifyInput, missing: SummaryRef[]): string {
    const s = input.scalars;
    const nodeLabel = s.nodeLabel;

    if (s.refineOutcome === 'accepted') {
        return `[System] Refinery accepted async job${s.jobId ? ` ${s.jobId}` : ''} for ${nodeLabel}. Completion/failure will be delivered as a terminal refine event; do not poll repeatedly.`;
    }
    if (s.refineOutcome === 'completed') {
        const details = [
            s.jobId ? `job_id=${s.jobId}` : '',
            s.refineBranch && s.refineInto ? `${s.refineBranch}→${s.refineInto}` : '',
            s.validationStatus ? `validation=${s.validationStatus}` : '',
            s.patchEquivalenceStatus ? `patch_equivalence=${s.patchEquivalenceStatus}` : '',
            s.mergeStatus ? `merge=${s.mergeStatus}` : '',
            s.convergenceStatus ? `final_convergence=${s.convergenceStatus}` : '',
        ].filter(Boolean).join('; ');
        const nextStep = s.refineNextStep || 'Continue from the updated mesh state.';
        return `[System] Refinery async job for ${nodeLabel} completed successfully${details ? ` (${details})` : ''}.\nNext step: ${nextStep}`;
    }
    // failed
    const details = [
        s.jobId ? `job_id=${s.jobId}` : '',
        s.refineCode ? `code=${s.refineCode}` : '',
        s.validationStatus ? `validation=${s.validationStatus}` : '',
        s.patchEquivalenceStatus ? `patch_equivalence=${s.patchEquivalenceStatus}` : '',
        s.mergeStatus ? `merge=${s.mergeStatus}` : '',
        s.convergenceStatus ? `convergence=${s.convergenceStatus}` : '',
        s.refineBlockedReason ? `reason=${s.refineBlockedReason}` : '',
    ].filter(Boolean).join('; ');
    const refineError = resolve(input.refs.error, input.resolveRef, missing);
    const parts = [
        `[System] Refinery async job for ${nodeLabel} failed${details ? ` (${details})` : ''}${refineError ? `: ${refineError}` : '.'}`,
        s.refineNextStep ? `Next step: ${s.refineNextStep}` : 'Review the terminal refine event/ledger before retrying.',
    ];
    const failedNodes = s.refineFailedNodes ?? [];
    if (failedNodes.length > 0) {
        parts.push('Per-node failures:');
        for (const entry of failedNodes) {
            const nodeId = entry.nodeId || '(unknown node)';
            const codeStage = [entry.code ? `code=${entry.code}` : '', entry.stage ? `stage=${entry.stage}` : ''].filter(Boolean).join(', ');
            const err = entry.error ? truncateAppend(entry.error, REFINE_NODE_ERROR_TRUNCATE_CHARS, '…') : '';
            parts.push(`- ${nodeId}${entry.convergence ? `: ${entry.convergence}` : ''}${codeStage ? ` (${codeStage})` : ''}${err ? ` — ${err}` : ''}`);
        }
    }
    return parts.join('\n');
}

/** Report-shadowed completion (worker_report supersedes a later PTY-scrape completion). */
function renderReportSubstitution(input: RenderTurnNotifyInput, missing: SummaryRef[]): string {
    const s = input.scalars;
    const taskId = s.reportTaskId ?? s.taskId ?? '';
    const outcome = s.reportOutcome ?? '';
    if (s.reportHasSummary) {
        const summary = resolve(input.refs.report, input.resolveRef, missing);
        if (summary !== null) {
            return `[System] ${s.nodeLabel} reported task ${taskId} as '${outcome}' via report_completion: ${summary}`;
        }
    }
    // No text held (a restart dropped the mirror, or the ref has not resolved
    // yet) — labelled, so the coordinator knows a stronger record exists.
    const scraped = renderCompleted(input, missing);
    return `[System] ${s.nodeLabel} already reported task ${taskId} as '${outcome}' via report_completion; its verbatim summary is no longer held `
        + `on this daemon. Screen-scraped text follows and may be truncated: ${scraped}`;
}

/** New shape (C1 R27a) — no legacy precedent. */
function renderCancelled(input: RenderTurnNotifyInput): string {
    const s = input.scalars;
    const reason = s.cancelReason ? ` (${s.cancelReason})` : '';
    return `[System] ${s.nodeLabel} task ${s.taskId ?? ''} was cancelled${reason}`;
}

/** New shape (C1 R27, owner revision 2026-09-23) — no legacy precedent. */
function renderLateCompletion(input: RenderTurnNotifyInput, missing: SummaryRef[]): string {
    const s = input.scalars;
    const taskId = s.taskId ?? '';
    const priorGen = s.priorGeneration !== undefined ? `g${s.priorGeneration}` : 'a prior generation';
    const lead = `[System] ${s.nodeLabel} reported a late completion for task ${taskId} from a superseded attempt (generation ${priorGen}); the current attempt continues — review the summary below if you want to salvage it`;
    const summary = resolve(input.refs.summary, input.resolveRef, missing);
    if (summary !== null) {
        return `${lead}.\n\n--- superseded attempt summary ---\n${summary}`;
    }
    return `${lead}; ${pointerLine('the superseded summary', taskId)}`;
}

/** `coordinator_ack{outcome:'delivered'|...}` for `approval_resolved` — silent locally, matches today's `return ''` for a co-located coordinator. */
function renderApprovalResolved(): string {
    return '';
}

/**
 * `mesh_event` fallback — the free-form bucket for every other queued-straight
 * producer the brief's §4 table lists as "other" (orphaned pins, auto-launch
 * integrity, dispatch-failed/reclaim, difficulty floor, idle missions,
 * dispatch-blocked, provider signal, parked-task, mission-close-candidate).
 * Dispatched by `scalars` shape rather than a single template because each of
 * those producers has its own wording upstream; this module only owns the
 * dispatch table for the shapes actually verified against source (§4 above +
 * this file's own header). Anything not recognized falls through to a
 * conservative, content-free default rather than silently rendering nothing.
 */
function renderMeshEvent(input: RenderTurnNotifyInput, missing: SummaryRef[]): string {
    const s = input.scalars;
    if (s.worktreeOutcome) return renderWorktreeBootstrap(input, missing);
    if (s.refineOutcome) return renderRefine(input, missing);
    if (s.reportTaskId || s.reportOutcome) return renderReportSubstitution(input, missing);
    if (s.progressTaskId !== undefined) return renderProgress(input, missing);
    // Mission-close / idle-mission notices carry a title as content (missionTitle ref).
    const missionTitle = resolve(input.refs.missionTitle, input.resolveRef, missing);
    if (missionTitle !== null) {
        return `[System] ${s.nodeLabel}: "${missionTitle}"`;
    }
    if (input.refs.missionTitle) {
        return pointerLine('the mission title', s.taskId);
    }
    // Truly unrecognized mesh_event scalars — content-free fallback rather than
    // an empty string, so a coordinator notification is never silently dropped.
    return `[System] ${s.nodeLabel} reported a mesh event${s.taskId ? ` for task ${s.taskId}` : ''}. Use mesh_status or mesh_read_chat once if you need details.`;
}

// ─── dispatch table ─────────────────────────────────────────────────────────

const RENDERERS: Record<NotifyKind, (input: RenderTurnNotifyInput, missing: SummaryRef[]) => string> = {
    completed: renderCompleted,
    failed: (input, missing) => renderStopped(input, missing),
    cancelled: (input) => renderCancelled(input),
    stopped: renderStopped,
    approval: (input) => renderApproval(input),
    choice: renderChoice,
    approval_resolved: () => renderApprovalResolved(),
    candidate: renderCompleted, // weak/candidate shares the completed template's weak branch (strength:'weak')
    no_progress: (input) => renderNoProgress(input),
    progress: renderProgress,
    late_completion: renderLateCompletion,
    mesh_event: renderMeshEvent,
};

/**
 * Render a `turn.notify` entry to the coordinator-facing text, resolving any
 * `refs` on demand via `resolveRef`. Pure and synchronous: `resolveRef` must
 * itself be synchronous (a local `mesh.<id>.handoff` topic read), matching
 * every other renderer in this file and its legacy predecessor
 * (`buildMeshSystemMessage`) — no network/await inside formatting.
 */
export function renderTurnNotify(input: RenderTurnNotifyInput): RenderTurnNotifyResult {
    const missing: SummaryRef[] = [];
    const renderer = RENDERERS[input.notify];
    const rendered = renderer(input, missing);
    const text = input.notify === 'approval_resolved' ? rendered : appendStatusLine(rendered, input.statusLine);
    return { text, kind: input.notify, contentRefsMissing: missing };
}
