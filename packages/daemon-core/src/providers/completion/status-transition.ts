/**
 * FSM status-transition tick (Phase 4 of the completion-engine rewrite —
 * verbatim move of CliProviderInstance.detectStatusTransition).
 *
 * This is the daemon's authoritative edge detector: every PTY poll lands here
 * and the status-keyed arms below own turn bookkeeping (generating debounce,
 * busyEpoch continuity, completion arm + settle-window selection), approval /
 * question-picker event emission, startup-grace collapse synthesis, the
 * fsmReadySeen re-arm, and the no-progress monitor loop. Mutable state stays
 * ON THE HOST (the provider instance) and every instance-level helper is
 * dispatched back THROUGH the host so suite stubs (getCompletedFinalizationBlock,
 * maybeAutoApproveStatus, completionFinalAssistantEvidence, ...) remain on the
 * path — identical to the mesh-stall-watchdog / approval-gate / evidence moves.
 *
 * Provenance kept inline: AUTOAPPROVE-FLAP-INBOX-MISSING, ASKUSERQUESTION-NOT-
 * APPROVAL (rc.19), COMPLETION-EARLYNOTIFY, GENERATING-MISSING (win32),
 * FALSE-IDLE (short-gen settle + self-coordinator settle + continuity),
 * SUSPENDED-TURN-IS-A-TURN, NOTIF Defect-2a/B, FALSEIDLE-BGCHILD-a,
 * GENERATING-BOUNDARY R4/R4b/R4c/R4d, MESH-QUESTION-ANSWER-PATH (f1d25e11),
 * INTERACTIVE-QUESTION-EMIT, MESH-STALL-WATCH dedupe, ARCH-REFACTOR R1.
 */

import type { ProviderModule } from '../contracts.js';
import type { ProviderEvent, ProviderErrorReason } from '../provider-instance.js';
import type { StatusMonitor } from '../status-monitor.js';
import { LOG } from '../../logging/logger.js';
import { normalizeProviderSessionId } from '../provider-session-id.js';
import { workingDirBasename } from '../working-dir.js';
import { extractFinalSummaryFromMessages } from '../chat-message-normalization.js';
import { resolveTranscriptAuthorityProfile } from '../transcript-evidence.js';
import { traceMeshEventStage, traceMeshEventDrop } from '../../mesh/mesh-event-trace.js';
import { computeTurnAnchoredDurationMs, hasNonEmptyCliModalButtons } from '../cli-provider-status-helpers.js';
import { formatApprovalRequestMessage } from '../cli-provider-effect-format.js';
import type {
    CompletedDebouncePending,
    CompletionFinalAssistantEvidence,
} from '../cli-provider-instance-types.js';
import {
    NATIVE_HISTORY_MESH_IDLE_SETTLE_MS,
    STARTUP_GRACE_IDLE_COLLAPSE_WINDOW_MS,
} from '../cli-provider-instance-types.js';

/**
 * The surface of CliProviderInstance the transition tick reads/writes. All
 * mutable FSM/turn state stays instance-owned (suites seed and inspect it
 * directly via `(instance as any)`), and helpers dispatch back through the
 * host so instance-level stubs stay on the path.
 */
export interface StatusTransitionHost {
    // Identity / collaborators
    type: string;
    instanceId: string;
    workingDir: string;
    provider: ProviderModule;
    adapter: {
        getStatus(opts: { allowParse: boolean }): any;
        getPartialResponse(): string;
        getScriptParsedStatus(): { messages?: unknown } | null | undefined;
    };
    monitor: StatusMonitor;
    providerSessionId?: string;

    // Mutable FSM/turn state
    lastStatus: string;
    generatingStartedAt: number;
    generatingDebounceTimer: NodeJS.Timeout | null;
    generatingDebouncePending: { chatTitle: string; timestamp: number } | null;
    completedDebounceTimer: NodeJS.Timeout | null;
    completedDebouncePending: CompletedDebouncePending | null;
    busyEpoch: number;
    autoApproveBusy: boolean;
    suppressIdleHistoryReplay: boolean;
    lastApprovalEventFingerprint: string;
    lastInteractivePromptEventKey: string;
    startupGraceCollapseAt: number | null;
    agentReadyEmitted: boolean;
    errorMessage: string | undefined;
    errorReason: ProviderErrorReason | undefined;
    lastCompletionSummary: { content: string; receivedAt: number; sourceTimestampMs?: number } | null;

    // Instance helpers (host-dispatched so suite stubs stay effective)
    stabilizeFlappingApprovalStatus(adapterStatus: any, now?: number): any;
    promoteProviderSessionId(sessionId: string, opts?: { authoritative?: boolean }): void;
    maybeAutoApproveStatus(adapterStatus: any, now?: number): boolean;
    hasAdapterPendingResponse(): boolean;
    fsmTraceOn(): boolean;
    recordFsmTransitionTrace(payload: Record<string, unknown>): void;
    completionTraceOn(): boolean;
    recordCompletionGateTrace(stage: string, payload: Record<string, unknown>): void;
    pushEvent(event: ProviderEvent): void;
    appendRuntimeSystemMessage(content: string, dedupKey: string, receivedAt?: number): void;
    completingTurnTaskId(): string | undefined;
    isAutonomousMeshSession(): boolean;
    isMeshWorkerSession(): boolean;
    meshTraceCtx(event?: string): Record<string, unknown>;
    completionFinalAssistantEvidence(parsedMessages: unknown, turnStartedAt?: number): CompletionFinalAssistantEvidence;
    completionHasFinalAssistantMessage(messages: unknown, turnStartedAt?: number): boolean;
    emitGeneratingCompleted(opts: {
        chatTitle: string;
        duration: number | undefined;
        timestamp: number;
        taskId?: string;
        finalSummary?: string;
        evidenceLevel?: string;
        completionDiagnostic?: Record<string, unknown>;
    }): void;
    markCurrentTurnStartupGraceCollapseSatisfied(): void;
    maybeSynthesizeStartupGraceCollapse(
        chatTitle: string,
        now: number,
        reason: 'startup_grace_fast_collapse' | 'startup_grace_idle_turn_collapse',
    ): boolean;
    scheduleCompletedDebounceFlush(delayMs: number): void;
    emitAgentReadyOnce(chatTitle: string, now: number): void;
    applyProviderResponse(data: any, options: { phase: 'immediate' | 'turn_completed' }): void;
}

export function runStatusTransitionTick(host: StatusTransitionHost): void {
    const now = Date.now();
    // Status-change handling is a hot path: PTY output can fire it many times
    // during long-running CLI sessions. Keep this path on adapter-owned light
    // state only; rich provider parsing is reserved for getState/read_chat.
    // AUTOAPPROVE-FLAP-INBOX-MISSING: stabilize a flap-prone approval BEFORE it feeds
    // maybeAutoApproveStatus / newStatus / the waiting_approval emission branch below,
    // so a momentary busy blip during the flap re-presents the cached modal + status
    // rather than emitting generating (which would corrupt the inbox and tear down the
    // settle gate). No-op for non-mesh/foreground/non-approval frames.
    const adapterStatus = host.stabilizeFlappingApprovalStatus(host.adapter.getStatus({ allowParse: false }), now);
    const adapterProviderSessionId = normalizeProviderSessionId(
        host.provider,
        typeof adapterStatus?.providerSessionId === 'string' ? adapterStatus.providerSessionId : '',
    );
    if (adapterProviderSessionId) {
        host.promoteProviderSessionId(adapterProviderSessionId);
    }
    const parsedStatus = null;
    const rawStatus = adapterStatus.status;
    // ASKUSERQUESTION-NOT-APPROVAL (rc.19 live defect): an AskUserQuestion
    // picker is a modal the claude FSM reports with status 'approval'
    // (statusForState maps ANY modal state to 'approval'), carrying
    // kind='picker'. Left as waiting_approval it emits agent:waiting_approval
    // and lands in the mesh_approve inbox, which cannot answer a multi-choice
    // question (the live rc.19 misroute: mesh_approve "approved" Continue).
    // When the prompt for it was captured (activeInteractivePrompt — the same
    // signal getState() overlays as waiting_choice), this is a QUESTION, not a
    // consent: classify it waiting_choice at the authoritative transition layer
    // so the interactive-prompt arm below emits agent:waiting_choice (promptId +
    // structured options → mesh_answer_question) and the approval arm never
    // fires. A genuine consent modal (kind 'approval' or a kind-less modal from
    // a legacy adapter) keeps waiting_approval even while a prompt is held —
    // approval wins and the two stay mutually exclusive, unchanged. A
    // modal-less waiting_approval frame (FSM approval_resolving right after an
    // answer, while the prompt is still held) also reads as the question — it
    // is the picker draining, not a fresh consent.
    const interactivePrompt = adapterStatus.activeInteractivePrompt ?? null;
    const activeModal = adapterStatus.activeModal ?? null;
    const activeModalKind = activeModal && typeof activeModal.kind === 'string'
        ? activeModal.kind
        : null;
    const isQuestionPicker = rawStatus === 'waiting_approval'
        && !!interactivePrompt
        && (!activeModal || activeModalKind === 'picker');
    const autoApproveActive = host.maybeAutoApproveStatus(adapterStatus, now);
    // During the autoApproveBusy window (2s after firing approval key), the PTY
    // can briefly report 'idle' before the next generating phase starts. Treat that
    // transient idle as 'generating' to suppress a spurious agent:generating_completed
    // push notification. The adapter's status is otherwise authoritative — native
    // transcript shape does NOT override the FSM's busy/idle decision.
    const autoApproveHoldIdle = host.autoApproveBusy && rawStatus === 'idle';
    const newStatus = isQuestionPicker
        ? 'waiting_choice'
        : autoApproveActive || autoApproveHoldIdle ? 'generating' : rawStatus;
    const dirName = workingDirBasename(host.workingDir);
    const chatTitle = `${host.provider.name} · ${dirName}`;
    const partial = host.adapter.getPartialResponse();
    // Liveness fingerprint for the no-progress watchdog. The parsed
    // assistant buffer (`partial`) alone goes static while a tool/build runs
    // — the assistant emits no tokens even though the PTY is actively
    // printing tool output — which made the watchdog false-fire a "stuck"
    // alert mid-turn. Fold in the adapter's raw-activity timestamps so any
    // visible terminal progress (lastScreenChangeAt) or raw PTY byte
    // (lastOutputAt) keeps the fingerprint moving. The watchdog then only
    // survives a genuine stall where nothing at all is happening.
    const progressFingerprint = newStatus === 'generating'
        ? `${`${partial || ''}`.slice(-2000)}::scr=${adapterStatus.lastScreenChangeAt ?? 0}::out=${adapterStatus.lastOutputAt ?? 0}`
        : undefined;

    const previousStatus = host.lastStatus;
    if (newStatus !== host.lastStatus) {
        LOG.info('CLI', `[${host.type}] status: ${host.lastStatus} → ${newStatus}`);
        // COMPLETION-EARLYNOTIFY: snapshot every FSM status transition (the arm/fire/cancel
        // decisions downstream all hang off these edges). Guarded so production pays only a
        // boolean check; payload carries the visibility/auto-approve flags and the continuity
        // clocks (busyEpoch / lastOutputAt / lastScreenChangeAt) that the completion gate reads.
        if (host.fsmTraceOn()) host.recordFsmTransitionTrace({
            from: host.lastStatus,
            to: newStatus,
            rawStatus,
            autoApproveActive,
            autoApproveHoldIdle,
            autoApproveBusy: host.autoApproveBusy,
            hasPending: host.hasAdapterPendingResponse(),
            busyEpoch: host.busyEpoch,
            lastOutputAt: typeof adapterStatus?.lastOutputAt === 'number' ? adapterStatus.lastOutputAt : null,
            lastScreenChangeAt: typeof adapterStatus?.lastScreenChangeAt === 'number' ? adapterStatus.lastScreenChangeAt : null,
        });
        // GENERATING-MISSING (win32 fresh-worktree first-turn): a freshly-launched session
        // is in 'starting' until its startup-grace settles to idle. When the FIRST inject
        // lands inside that grace window, the adapter can report status DIRECTLY
        // starting → generating without an intervening 'idle' frame for
        // detectStatusTransition() to observe. Previously only the idle→generating arm
        // armed the bookkeeping, so a starting→generating frame fell straight through to the
        // bare `host.lastStatus = newStatus` update: generatingStartedAt stayed 0 and no
        // generating_started was queued. The fast turn's generating→idle completion was then
        // suppressed by the startup-blip guard below (generatingStartedAt===0 &&
        // !generatingDebouncePending) — so NO generating_started AND NO generating_completed
        // ever fired and the mesh coordinator never learned the worker went idle.
        //
        // We extend the idle→generating arm to also fire on starting→generating, BUT ONLY
        // when a real turn is in flight. The adapter script can also report 'generating' from
        // pure startup PTY noise (no task dispatched) — antigravity/codex/hermes-cli all
        // exercise that benign starting→generating→idle blip, which must NOT emit a
        // completion (see "startup-phase spurious completion suppression" tests).
        // hasAdapterPendingResponse() is the discriminator: a genuine inject sets the
        // adapter's isWaitingForResponse / currentTurnScope (or leaves a partial response),
        // whereas startup repaint noise leaves all of them empty. So an armed
        // starting→generating means "the worker actually started its first turn", and a
        // bare one stays a suppressed blip via the existing fall-through.
        const startingToGeneratingWithActiveTurn = host.lastStatus === 'starting'
            && newStatus === 'generating'
            && host.hasAdapterPendingResponse();
        if (((host.lastStatus === 'idle' && newStatus === 'generating') || startingToGeneratingWithActiveTurn)) {
            // If a completion event is already pending and the turn has ended
            // (generatingStartedAt===0), the PTY is painting its prompt area
            // after completing. Ignore this blip — do not cancel the pending
            // completion and do not advance lastStatus to generating. (On a true
            // starting→generating the session is fresh: completedDebouncePending is
            // null, so this blip guard is a no-op and we arm normally below.)
            if (host.completedDebouncePending && host.generatingStartedAt === 0) {
                LOG.debug('CLI', `[${host.type}] ignoring post-completion PTY generating blip (generatingStartedAt=0)`);
                return;
            }
            host.suppressIdleHistoryReplay = false;
            // Cancel any pending completed event (multi-step: idle→generating resume)
            if (host.completedDebouncePending) {
                LOG.info('CLI', `[${host.type}] cancelled pending completed (resumed generating) generatingStartedAt=${host.generatingStartedAt} isWaitingForResponse=${!!(host.adapter as any)?.isWaitingForResponse}`);
                if (host.completedDebounceTimer) { clearTimeout(host.completedDebounceTimer); host.completedDebounceTimer = null; }
                host.completedDebouncePending = null;
            }

            if (!host.generatingStartedAt) host.generatingStartedAt = now;
            // A genuinely new turn is underway — drop the previous turn's cached
            // final-summary so the dashboard does not keep showing the old answer
            // as "done" while the new turn generates. Re-populated when this turn
            // completes.
            host.lastCompletionSummary = null;
            // FALSE-IDLE continuity: entering a busy phase invalidates any
            // completedDebouncePending armed earlier in this settle window.
            host.busyEpoch++;
            // Defer the generating_started event — if idle comes back within 3s,
            // the whole started→completed pair was a false positive from PTY noise
            if (host.generatingDebounceTimer) clearTimeout(host.generatingDebounceTimer);
            host.generatingDebouncePending = { chatTitle, timestamp: now };
            host.generatingDebounceTimer = setTimeout(() => {
                if (host.generatingDebouncePending) {
                    host.pushEvent({ event: 'agent:generating_started', ...host.generatingDebouncePending });
                    host.generatingDebouncePending = null;
                }
                host.generatingDebounceTimer = null;
            }, 3000);
        } else if (newStatus === 'waiting_approval'
            && !(previousStatus === 'waiting_choice' && !adapterStatus.activeModal)) {
            // The !(waiting_choice → modal-less waiting_approval) guard: right after an
            // AskUserQuestion answer the FSM drains through approval_resolving (status
            // 'approval', NO modal extract) while the held prompt clears on its own
            // grace. That transient is the picker resolving, NOT a fresh consent — running
            // the approval arm here would emit a spurious agent:waiting_approval with an
            // empty modal and cancel any pending completion. Skip the arm; lastStatus
            // still advances below so the subsequent →generating resume reads normally.
            host.suppressIdleHistoryReplay = false;
            // Flush pending generating_started if debounce still pending
            if (host.generatingDebouncePending) {
                if (host.generatingDebounceTimer) { clearTimeout(host.generatingDebounceTimer); host.generatingDebounceTimer = null; }
                host.pushEvent({ event: 'agent:generating_started', ...host.generatingDebouncePending });
                host.generatingDebouncePending = null;
            }
            // Cancel any pending completed
            if (host.completedDebounceTimer) { clearTimeout(host.completedDebounceTimer); host.completedDebounceTimer = null; }
            host.completedDebouncePending = null;

            if (!host.generatingStartedAt) host.generatingStartedAt = now;
            // FALSE-IDLE continuity: waiting_approval is a busy phase (the agent
            // resumes into it), so bump the epoch too — the completedDebouncePending
            // cancel above covers the currently-armed pending, and the epoch covers
            // a pending that re-arms and flushes across this same valley.
            host.busyEpoch++;
            const modal = adapterStatus.activeModal;
            LOG.info('CLI', `[${host.type}] approval modal: "${modal?.message?.slice(0, 80) ?? 'none'}"`);
            // Include the FSM's approval entry seq, mirroring the auto-approve
            // path (maybeAutoApproveStatus) and resolveModal's sameEntryReResolve
            // guard. Two distinct back-to-back approvals can carry identical
            // message/buttons (very common with claude-cli's "Allow Bash
            // command?"). Without the seq their fingerprints collide and the dedup
            // below silently drops the second waiting_approval event — it is never
            // emitted, so it cannot even land in the pending inbox for a later
            // read_chat reconcile to recover. The seq is bumped by the FSM on every
            // fresh waiting_approval entry, so a new approval always yields a new
            // fingerprint and emits.
            const approvalEntrySeq = typeof adapterStatus?.approvalEntrySeq === 'number'
                ? adapterStatus.approvalEntrySeq
                : 0;
            const approvalFingerprint = JSON.stringify({
                message: typeof modal?.message === 'string' ? modal.message.trim() : '',
                buttons: Array.isArray(modal?.buttons) ? modal.buttons.map((button: unknown) => String(button).trim()) : [],
                seq: approvalEntrySeq,
            });
            // PTY redraws repeat the same modal content; fingerprint dedup prevents duplicate events.
            // Do NOT also gate on lastStatus: consecutive approvals can arrive waiting_approval→waiting_approval
            // (e.g. antigravity-cli resolves one prompt and immediately shows the next) and would be silently dropped.
            if (approvalFingerprint !== host.lastApprovalEventFingerprint) {
                host.lastApprovalEventFingerprint = approvalFingerprint;
                host.appendRuntimeSystemMessage(
                    formatApprovalRequestMessage(modal?.message, modal?.buttons),
                    `approval_request:${now}`,
                    now,
                );
                host.pushEvent({
                    event: 'agent:waiting_approval', chatTitle, timestamp: now,
                    modalMessage: modal?.message,
                    modalButtons: modal?.buttons,
                });
            }
        } else if (newStatus === 'waiting_choice') {
            // SUSPENDED-TURN-IS-A-TURN (post-restart completion wedge): entering
            // waiting_choice means the turn is PARKED on an AskUserQuestion picker
            // mid-flight — the same busy phase the waiting_approval arm above treats
            // a consent modal as. Arm the turn bookkeeping identically so the answer's
            // resume (waiting_choice → generating → idle) completes through the normal
            // completion path below. Without this arm a session that entered
            // waiting_choice WITHOUT a prior idle→generating arm this boot — the
            // post-daemon-restart rebound, where the FSM folds starting→waiting_choice
            // on the still-parked picker — keeps generatingStartedAt===0, so the
            // resume's generating→idle falls into the "startup-phase blip" suppression
            // below and NO completion ever emits: the task wedges 'assigned' forever.
            host.suppressIdleHistoryReplay = false;
            // Flush pending generating_started if debounce still pending
            if (host.generatingDebouncePending) {
                if (host.generatingDebounceTimer) { clearTimeout(host.generatingDebounceTimer); host.generatingDebounceTimer = null; }
                host.pushEvent({ event: 'agent:generating_started', ...host.generatingDebouncePending });
                host.generatingDebouncePending = null;
            }
            // Cancel any pending completed
            if (host.completedDebounceTimer) { clearTimeout(host.completedDebounceTimer); host.completedDebounceTimer = null; }
            host.completedDebouncePending = null;

            if (!host.generatingStartedAt) host.generatingStartedAt = now;
            // FALSE-IDLE continuity: waiting_choice is a busy phase (the agent is
            // parked inside its turn), so bump the epoch exactly like the
            // waiting_approval arm does.
            host.busyEpoch++;
        } else if (newStatus === 'generating' && host.lastStatus === 'waiting_approval') {
            // Approval resolved and the agent resumed work. Defense-in-depth:
            // clear the approval emit fingerprint here too (not only on
            // completion at scheduleCompletedDebounceFlush). A subsequent
            // waiting_approval with the same modal content as the one just
            // resolved would otherwise collide with the stale fingerprint and be
            // dropped. The seq in the fingerprint already separates entries; this
            // reset is a belt-and-suspenders guard for the re-entry case.
            host.lastApprovalEventFingerprint = '';
        } else if (newStatus === 'idle' && (host.lastStatus === 'generating' || host.lastStatus === 'waiting_approval')) {
            const duration = host.generatingStartedAt ? Math.round((now - host.generatingStartedAt) / 1000) : 0;
            // Guard: if generatingStartedAt===0 and no debounce pending, the generating phase
            // was entered from 'starting' state (startup PTY noise), not from a real idle→generating
            // task dispatch. The idle→generating handler is the only code path that sets
            // generatingStartedAt and generatingDebouncePending, so both being absent means no
            // task was ever dispatched. Suppress the spurious completion event and fall through
            // to a simple lastStatus update.
            if (!host.generatingStartedAt && !host.generatingDebouncePending) {
                LOG.debug('CLI', `[${host.type}] suppressed startup-phase generating→idle blip (generatingStartedAt=0, no debounce pending)`);
            } else
            // If debounce still pending (generating lasted < 1s), cancel both UI events.
            // Still emit agent:generating_completed so mesh orchestration can record
            // task_completed for direct dispatches that complete faster than the debounce.
            if (host.generatingDebouncePending) {
                // NOTIF Defect-2a: shortDurationMs is the REPORTED turn duration, so it must be
                // measured from the IMMUTABLE turn start — not generatingStartedAt, which is
                // reset to 0 on every mid-turn waiting_approval/idle blip (see :1864/1885/2397/
                // 2503/2521) and re-armed on the next →generating, so a long turn that blipped
                // would measure only the final 1.5-2.5s sliver. engine.currentTurnStartedAt is
                // stamped once at onTurnStarted and persists past mid-turn blips until the next
                // turn starts, so it captures the true turn length. generatingStartedAt remains
                // the fallback (and the debounce itself stays a pure UI-suppression signal,
                // decoupled from the reported duration).
                const { durationMs: shortDurationMs, anchor: durationAnchor } = computeTurnAnchoredDurationMs(
                    (host.adapter as any)?.currentTurnStartedAt,
                    host.generatingStartedAt,
                    now,
                );
                LOG.info('CLI', `[${host.type}] suppressed short generating (${shortDurationMs}ms, anchor=${durationAnchor})`);
                if (host.generatingDebounceTimer) { clearTimeout(host.generatingDebounceTimer); host.generatingDebounceTimer = null; }
                // Emit completion for mesh task association even though the UI generating
                // started/completed pair is suppressed (too short for visible UI update).
                let shortFinalSummary: string | undefined;
                let shortEvidenceSource: CompletionFinalAssistantEvidence['source'] = 'unavailable';
                try {
                    const parsedMessages = host.adapter?.getScriptParsedStatus()?.messages;
                    const evidence = host.completionFinalAssistantEvidence(parsedMessages);
                    shortEvidenceSource = evidence.source;
                    shortFinalSummary = extractFinalSummaryFromMessages(evidence.messages as any);
                } catch { /* best-effort */ }
                // If a real response is confirmed, retroactively emit started so the chat
                // bubble appears even though the debounce suppressed the original event.
                if (shortFinalSummary) {
                    host.pushEvent({ event: 'agent:generating_started', chatTitle, timestamp: now - shortDurationMs });
                }
                // FALSE-IDLE short-gen settle: snapshot the producing turn's start + taskId NOW,
                // before `generatingStartedAt` is reset below — the settle-arm path (mesh sessions,
                // see the mesh branch further down) needs the same turn anchor the normal
                // completedDebounce branch captures, and generatingStartedAt is the fallback for it.
                const shortEngineTurnStart = typeof (host.adapter as any)?.currentTurnStartedAt === 'number'
                    && Number.isFinite((host.adapter as any).currentTurnStartedAt)
                    ? (host.adapter as any).currentTurnStartedAt as number
                    : 0;
                const shortTurnStartedAt = shortEngineTurnStart || host.generatingStartedAt || 0;
                const shortTaskId = host.completingTurnTaskId();
                host.generatingDebouncePending = null;
                host.generatingStartedAt = 0;
                // FALSE-IDLE short-gen: a short-generating completion with NO transcript
                // backing at all (shortEvidenceSource === 'unavailable': both the screen parse
                // AND the external-native transcript failed to yield a final assistant) is just
                // as unproven as an 'external-native' source that returned no final assistant.
                // Fold 'unavailable' into the missing-evidence predicate so a zero-evidence dip
                // (the mid-turn point-sample that triggered this whole false-idle bug) is treated
                // as weak/held, not fired as a genuine completion. A real shortFinalSummary being
                // present still clears the gate (the !shortFinalSummary guard is unchanged).
                const missingEvidence = (resolveTranscriptAuthorityProfile(host.provider).timing === 'floor'
                    || shortEvidenceSource === 'external-native'
                    || shortEvidenceSource === 'unavailable') && !shortFinalSummary;
                if (missingEvidence) {
                    LOG.warn('CLI', `[${host.type}] short completion missing final assistant evidence (source=${shortEvidenceSource})`);
                }
                if (host.isAutonomousMeshSession()) {
                    // FALSE-IDLE short-gen settle (the core fix): for an autonomously-progressing
                    // mesh session (delegated worker OR self-coordinator), the short-generating
                    // branch was a POINT-SAMPLE — a single idle read from getStatus({allowParse:false})
                    // that fires the completion INLINE with zero continuity backing. When the worker
                    // is merely mid-turn (a sub-3s dip between two tool calls), this synchronously
                    // emitted a false agent:generating_completed the coordinator can never correct.
                    //
                    // Route it through the SAME settle + continuity machinery as the normal
                    // completedDebounce branch: arm completedDebouncePending capturing busyEpochAtArm
                    // and lastOutputAtArm, then scheduleCompletedDebounceFlush(NATIVE_HISTORY_MESH_IDLE_SETTLE_MS)
                    // so flushCompletedDebounceIfFinalized() re-verifies CONTINUOUS idle before emitting.
                    // A busy re-entry (busyEpoch bump) or new PTY output within the settle window —
                    // exactly what happens when the worker resumes its next tool call — CANCELS the
                    // false completion. Genuine completions (real final assistant) still emit at the
                    // end of the (short, 4s) settle window; missingEvidence flows through the
                    // finalization block (missing_final_assistant → CANON-C weak/held) rather than
                    // being frozen as a genuine inline fire.
                    host.completedDebouncePending = {
                        chatTitle,
                        duration: Math.round(shortDurationMs / 1000),
                        timestamp: now,
                        firstObservedAt: now,
                        // Short-gen enters from generating→idle (or waiting_approval→idle); the
                        // completedDebounce finalization gate treats previousStatus for its
                        // approval-resolution / inter-approval-valley handling. lastStatus is the
                        // status we transitioned FROM here.
                        previousStatus: host.lastStatus,
                        ...(shortTaskId ? { taskId: shortTaskId } : {}),
                        ...(shortTurnStartedAt ? { turnStartedAt: shortTurnStartedAt } : {}),
                        // FALSE-IDLE continuity: same arm-time snapshots as the normal branch so the
                        // flush guard can prove continuous idle across the settle window.
                        busyEpochAtArm: host.busyEpoch,
                        ...(typeof adapterStatus?.lastOutputAt === 'number' && Number.isFinite(adapterStatus.lastOutputAt)
                            ? { lastOutputAtArm: adapterStatus.lastOutputAt as number }
                            : {}),
                    };
                    LOG.info('CLI', `[${host.type}] short-generating routed through settle window (${shortDurationMs}ms, source=${shortEvidenceSource}, missingEvidence=${missingEvidence}) — arming completedDebouncePending instead of inline fire`);
                    // EVTTRACE: now traces the settle ARM (not an inline fire) for mesh sessions,
                    // so logs show the short-gen path deferring to continuity re-check.
                    if (host.isMeshWorkerSession()) {
                        traceMeshEventStage('arm', host.meshTraceCtx(), `short-generating settle-arm (source=${shortEvidenceSource}, missingEvidence=${missingEvidence})`);
                    }
                    if (host.completionTraceOn()) host.recordCompletionGateTrace('arm', {
                        branch: 'short_generating',
                        previousStatus: host.lastStatus,
                        turnStartedAt: shortTurnStartedAt || null,
                        busyEpochAtArm: host.busyEpoch,
                        lastOutputAtArm: typeof adapterStatus?.lastOutputAt === 'number' ? adapterStatus.lastOutputAt : null,
                        flushDelay: NATIVE_HISTORY_MESH_IDLE_SETTLE_MS,
                        evidenceSource: shortEvidenceSource,
                        missingEvidence,
                        hasFinalSummary: !!shortFinalSummary,
                    });
                    host.scheduleCompletedDebounceFlush(NATIVE_HISTORY_MESH_IDLE_SETTLE_MS);
                } else if (missingEvidence) {
                    // NON-MESH, missing evidence: suppress the completion event entirely (the
                    // original !hasMeshContext suppression). A genuinely non-mesh session has no
                    // coordinator to notify, and firing a completion with no confirmed final
                    // assistant would just surface an empty/unconfirmed turn. Leave
                    // completedDebouncePending null — the session is now idle with no confirmed
                    // turn, matching the startup-blip suppression semantics. (No EvtTrace: not a
                    // mesh session, so nothing routes to a coordinator.)
                    LOG.info('CLI', `[${host.type}] short completion suppressed: missing final assistant evidence, non-mesh session (source=${shortEvidenceSource})`);
                } else {
                    // NON-MESH interactive fast-path with a CONFIRMED summary: keep the existing
                    // inline fire. The dashboard UX reason for the short path (a fast turn should
                    // surface its completion promptly without a 4s settle) still holds, and a
                    // non-mesh session has no coordinator to be falsely notified — the false-idle
                    // bug being fixed is specifically the mesh worker/coordinator misfire above.
                    host.emitGeneratingCompleted({
                        chatTitle,
                        duration: 0,
                        timestamp: now,
                        finalSummary: shortFinalSummary,
                        completionDiagnostic: {
                            reason: 'short_generating_suppressed',
                            shortDurationMs,
                            finalAssistantEvidenceSource: shortEvidenceSource,
                        },
                    });
                    // A genuine completion was emitted for this turn (and
                    // generatingStartedAt was reset above) — stamp it as
                    // satisfied for the startup-grace collapse synth so a
                    // late idle-stayed poll cannot re-synthesize a weak pair.
                    host.markCurrentTurnStartupGraceCollapseSatisfied();
                }
            } else {
                // Debounce completed, then require the rich transcript path that read_chat
                // uses to show an idle turn whose last user-facing message is assistant.
                host.completedDebouncePending = {
                    chatTitle,
                    duration,
                    timestamp: now,
                    firstObservedAt: now,
                    previousStatus: host.lastStatus,
                    // ARCH-REFACTOR R1: snapshot the completing turn's taskId NOW (sync),
                    // before any follow-up task's flush can start a new turn and move
                    // engine.currentTurnTaskId.
                    ...(host.completingTurnTaskId() ? { taskId: host.completingTurnTaskId() } : {}),
                    // NOTIF Defect-B: snapshot the producing turn's START instant NOW, for the
                    // same reason as taskId — a follow-up turn moves engine.currentTurnStartedAt.
                    // Prefer the engine's per-turn start (set at onTurnStarted, earliest reliable
                    // anchor) and fall back to generatingStartedAt (when generating was observed).
                    ...((() => {
                        const engineTurnStart = typeof (host.adapter as any)?.currentTurnStartedAt === 'number'
                            && Number.isFinite((host.adapter as any).currentTurnStartedAt)
                            ? (host.adapter as any).currentTurnStartedAt as number
                            : 0;
                        const turnStartedAt = engineTurnStart || host.generatingStartedAt || 0;
                        return turnStartedAt ? { turnStartedAt } : {};
                    })()),
                    // FALSE-IDLE continuity: snapshot the busy epoch + raw PTY output
                    // clock at arm time so the flush guard can prove the session stayed
                    // continuously idle (no busy re-entry, no new PTY output) through the
                    // settle window rather than merely reading 'idle' once at flush.
                    busyEpochAtArm: host.busyEpoch,
                    ...(typeof adapterStatus?.lastOutputAt === 'number' && Number.isFinite(adapterStatus.lastOutputAt)
                        ? { lastOutputAtArm: adapterStatus.lastOutputAt as number }
                        : {}),
                };
                const ownsExternalHistory = !!(host.adapter as any)?.chatMessagesOwnedExternally;
                // (FALSEIDLE-BGCHILD-a) Native-history providers flush immediately (the
                // transcript is authoritative). For autonomously-progressing mesh sessions,
                // give the generating→idle transition a short settle window so a background-child
                // false idle (quiet after a backgrounded test/command while the parent turn
                // continues) or an inter-approval auto-approve valley gets caught by the resume
                // guard in flushCompletedDebounceIfFinalized instead of firing an early completion
                // the coordinator can never correct.
                //
                // (FALSE-IDLE self-coordinator settle) The settle window now covers BOTH mesh
                // worker sessions AND the coordinator's own claude-cli session (meshCoordinatorFor):
                // isAutonomousMeshSession(). Previously only isMeshWorkerSession() qualified, so a
                // self-coordinating daemon (worker + coordinator on the same daemon) ran the
                // coordinator's own turn at flushDelay=0 — no settle window at all — and the
                // busyEpoch/lastOutputAt continuity guard, being a flush-time point-check, had no
                // window in which to observe the ~0.5s auto-approve valley. Its mid-turn
                // "next-step" sentence was flushed as finalSummary. A genuinely non-mesh session
                // (neither worker nor self-coordinator) still flushes immediately (delay=0), so
                // no non-mesh behaviour changes; this only ADDS a settle window (strictly
                // stricter — the guard can only ever CANCEL a pending flush, never emit more).
                const meshSettleSession = host.isAutonomousMeshSession();
                const flushDelay = ownsExternalHistory
                    ? (meshSettleSession ? NATIVE_HISTORY_MESH_IDLE_SETTLE_MS : 0)
                    : 3000;
                LOG.debug('CLI', `[${host.type}] set completedDebouncePending duration=${duration}s ownsExternalHistory=${ownsExternalHistory} meshSettle=${meshSettleSession} flushDelay=${flushDelay}ms generatingStartedAt=${host.generatingStartedAt}`);
                if (host.completionTraceOn()) host.recordCompletionGateTrace('arm', {
                    branch: 'normal',
                    previousStatus: host.completedDebouncePending.previousStatus,
                    turnStartedAt: host.completedDebouncePending.turnStartedAt ?? null,
                    busyEpochAtArm: host.completedDebouncePending.busyEpochAtArm ?? null,
                    lastOutputAtArm: host.completedDebouncePending.lastOutputAtArm ?? null,
                    flushDelay,
                    ownsExternalHistory,
                    meshSettle: meshSettleSession,
                });
                host.scheduleCompletedDebounceFlush(flushDelay);
            }
        } else if (newStatus === 'idle' && host.lastStatus === 'starting') {
            host.emitAgentReadyOnce(chatTitle, now);
            // GENERATING-BOUNDARY (R4c): stamp the collapse moment ONCE so the
            // idle-stayed window below is anchored on the startup-grace collapse,
            // not on boot. Set only the first time so a later starting re-entry
            // cannot slide the window forward.
            if (host.startupGraceCollapseAt === null) host.startupGraceCollapseAt = now;
            // GENERATING-BOUNDARY fast-collapse (R4, win32 startup-grace first turn):
            // a turn dispatched into the startup-grace window can START and FINISH while
            // the FSM is still in 'starting'. On a daemon whose claude-cli spec has NOT yet
            // synced the starting→busy edge (the primary cure lives in the spec's
            // idle→busy.from), the FSM never reaches 'busy'/generating, so
            // detectStatusTransition observes starting→idle DIRECTLY with no intervening
            // 'generating' frame. The idle→generating arm — the only path that sets
            // generatingStartedAt and arms the completion — never fired, so the completing
            // turn's agent:generating_completed is never emitted and the mesh coordinator
            // never learns the worker went idle. Synthesize the started+completed pair here.
            //
            // Discriminator (false-positive safe — must NOT fire on a benign boot):
            //   adapter.currentTurnTaskId is set ONLY by onTurnStarted (a real turn STARTED
            //   this boot) and persists past completion, so it cleanly separates the three
            //   non-firing cases — a true idle boot (no turn → null), a queued-pending
            //   first turn that only runs AFTER startup-grace drains the composer (onTurnStarted
            //   not yet called → null; it completes normally later via idle→busy→idle), and a
            //   turn STILL running at the 8s mark (hasAdapterPendingResponse() still true →
            //   excluded so we don't fire a premature mid-turn completion; idle→busy self-
            //   corrects once the FSM reaches idle). We fire only when a turn started AND has
            //   already finished: started-this-boot && !still-in-flight.
            host.maybeSynthesizeStartupGraceCollapse(chatTitle, now, 'startup_grace_fast_collapse');
        } else if (newStatus === 'error') {
            if (host.generatingDebounceTimer) { clearTimeout(host.generatingDebounceTimer); host.generatingDebounceTimer = null; }
            host.generatingDebouncePending = null;
            if (host.completedDebounceTimer) { clearTimeout(host.completedDebounceTimer); host.completedDebounceTimer = null; }
            host.completedDebouncePending = null;
            host.errorMessage = adapterStatus.errorMessage || host.errorMessage;
            host.errorReason = (adapterStatus.errorReason as ProviderErrorReason) || host.errorReason;
            host.pushEvent({
                event: 'agent:stopped',
                chatTitle,
                timestamp: now,
                finalSummary: adapterStatus.errorMessage || adapterStatus.errorReason || 'Provider reported an error',
                completionDiagnostic: {
                    reason: adapterStatus.errorReason || 'provider_error',
                    errorMessage: adapterStatus.errorMessage || undefined,
                },
            });
        } else if (newStatus === 'stopped') {
            // Cancel any pending debounce
            if (host.generatingDebounceTimer) { clearTimeout(host.generatingDebounceTimer); host.generatingDebounceTimer = null; }
            host.generatingDebouncePending = null;
            if (host.completedDebounceTimer) { clearTimeout(host.completedDebounceTimer); host.completedDebounceTimer = null; }
            host.completedDebouncePending = null;
            host.pushEvent({ event: 'agent:stopped', chatTitle, timestamp: now });
        }
        host.lastStatus = newStatus;
    }

    // INTERACTIVE-QUESTION-EMIT: fire a coordinator/push-worthy notification when the
    // session ENTERS an AskUserQuestion / waiting_choice state. This is orthogonal to
    // the status-change block above: an AskUserQuestion prompt is surfaced only as a
    // display-only `waiting_choice` overlay in getState() (mirrored here off
    // adapterStatus.activeInteractivePrompt, the exact signal getState uses), while
    // the raw adapter status stays idle/generating — so none of the status-keyed
    // arms above ever emit an agent:* event for it and the owner gets no web-push.
    //
    // MESH-QUESTION-ANSWER-PATH (mission f1d25e11): this used to REUSE
    // agent:waiting_approval (question as modalMessage, choice labels as modalButtons).
    // That mis-classified a multi-choice QUESTION as an approval — the coordinator saw
    // a task_approval_needed ledger row and tried mesh_approve, which cannot answer a
    // question (it resolves a yes/no modal). We now emit a DISTINCT
    // agent:waiting_choice event carrying the FULL InteractivePrompt payload
    // (promptId + every question's header/question/multiSelect and each option's
    // label/description) so the coordinator can render the choices and answer with the
    // dedicated mesh_answer_question tool. The rich payload survives the cross-machine
    // relay (see buildRelayMetadataEvent) so a REMOTE worker's question reaches the
    // coordinator with its options intact.
    //
    // We keep modalMessage/modalButtons on the event too so the existing server
    // web-push path (which reads those two fields) still fires with no cloud change —
    // but the payload's `interactivePrompt` is the authoritative, structured signal.
    //
    // Edge-triggered: emit exactly once on entry, keyed on promptId + question text,
    // and reset the key when the prompt clears so a fresh prompt re-fires and a later
    // real completion still flows through the idle arm normally. We do NOT emit when
    // the session is in a genuine approval state (newStatus === 'waiting_approval'):
    // that arm already emits agent:waiting_approval. A question (waiting_choice) and a
    // real approval (waiting_approval) therefore NEVER both fire for the same tick —
    // the approval arm wins and this arm yields (owner requirement: the two are
    // mutually exclusive). Note an AskUserQuestion picker no longer reaches this arm
    // as waiting_approval: the isQuestionPicker classification above folds it to
    // waiting_choice, so a picker ALWAYS lands here and a consent NEVER does.
    if (interactivePrompt && newStatus !== 'waiting_approval') {
        const firstQuestion = interactivePrompt.questions?.[0];
        const promptKey = `${interactivePrompt.promptId}::${firstQuestion?.question ?? ''}`;
        if (promptKey !== host.lastInteractivePromptEventKey) {
            host.lastInteractivePromptEventKey = promptKey;
            const modalMessage = firstQuestion
                ? (firstQuestion.header
                    ? `${firstQuestion.header}: ${firstQuestion.question}`
                    : firstQuestion.question)
                : undefined;
            const modalButtons = firstQuestion?.options?.map((option: { label: string }) => option.label);
            host.pushEvent({
                event: 'agent:waiting_choice', chatTitle, timestamp: now,
                // Structured, authoritative payload — the coordinator renders these and
                // answers via mesh_answer_question. Carried whole (all questions, all
                // options) so multi-question / multi-select prompts round-trip fully.
                interactivePrompt,
                promptId: interactivePrompt.promptId,
                multiSelect: firstQuestion?.multiSelect === true,
                // Push-notification-friendly projection (server push path reads these).
                modalMessage,
                modalButtons,
            });
        }
    } else if (!interactivePrompt && host.lastInteractivePromptEventKey) {
        // Prompt answered / gone — reset so the next AskUserQuestion re-fires.
        host.lastInteractivePromptEventKey = '';
    }

    // GENERATING-BOUNDARY idle-stayed collapse (R4b): the starting→idle
    // fast-collapse arm above only fires when the FIRST turn itself drives the
    // starting→idle transition. When the launch settle already drained
    // starting→idle BEFORE the first turn arrives, the session is already 'idle'
    // and a turn that runs+completes inside the startup-grace window — too fast
    // for any poll to observe a 'generating' frame — produces NO status change
    // at all (idle→idle). detectStatusTransition's change block above is skipped
    // entirely, so neither the idle→generating arm nor the starting→idle
    // fast-collapse arm ever runs, and the mesh coordinator never learns the
    // worker went idle (the live rc.403 Probe1 miss). Catch it here: an
    // already-idle poll (no status change), still inside the startup-grace
    // window, where a turn started this boot and has already finished without
    // ever arming generating. The same false-positive-safe discriminators apply
    // (currentTurnTaskId set && !pending && generating never armed), plus a
    // once-per-turn guard since this branch is re-polled while the session sits
    // idle. Normal turns that DO reach 'busy' set generatingStartedAt and are
    // excluded; a queued-pending first turn that only runs after grace falls
    // outside the window and completes normally via idle→busy→idle.
    //
    // R4d (the live rc.405 Probe2 miss): R4c anchored the window on the collapse
    // moment but still measured its END against `now` (the poll/completion time). The
    // helper only fires once the turn has FINISHED (!hasAdapterPendingResponse()), so
    // the first eligible poll happens at completion. When the first turn is dispatched
    // a few seconds after the collapse AND runs for a non-trivial duration, that
    // completion lands PAST the 12s now-anchored window even though the turn was a
    // genuine startup-grace first turn (live: collapse→dispatch +5.2s, turn ~11s →
    // completion at collapse+16.2s > 12s). Anchor the window on when the first turn
    // STARTED (engine.currentTurnStartedAt, set by onTurnStarted) instead: a turn that
    // STARTED within the collapse window is a startup-grace first turn no matter how
    // long it then ran. The now-anchored check is retained as a union so a fast turn
    // (dispatched+completed quickly within 12s of collapse) keeps firing too; both
    // close for a much-later turn, preserving the "don't mislabel a late fast turn"
    // honesty the window exists for.
    const firstTurnStartedAt = typeof (host.adapter as any)?.currentTurnStartedAt === 'number'
        ? (host.adapter as any).currentTurnStartedAt as number
        : 0;
    const collapsedAt = host.startupGraceCollapseAt;
    const turnStartedWithinCollapseWindow = collapsedAt !== null
        && firstTurnStartedAt > 0
        && firstTurnStartedAt >= collapsedAt
        && (firstTurnStartedAt - collapsedAt) < STARTUP_GRACE_IDLE_COLLAPSE_WINDOW_MS;
    const nowWithinCollapseWindow = collapsedAt !== null
        && (now - collapsedAt) < STARTUP_GRACE_IDLE_COLLAPSE_WINDOW_MS;
    if (
        newStatus === 'idle'
        && previousStatus === 'idle'
        && (turnStartedWithinCollapseWindow || nowWithinCollapseWindow)
    ) {
        host.maybeSynthesizeStartupGraceCollapse(chatTitle, now, 'startup_grace_idle_turn_collapse');
    }

    // Re-arm the queue-claim agent:ready on the FSM's first GENUINE ready.
    //
    // The boot-time starting→idle one-shot above is the historical claim
    // trigger, but it is consumed too early for FSM-spec providers whose
    // INITIAL state already reports status 'idle' (e.g. antigravity-cli): the
    // adapter reports idle before maybeMarkReady has fired, so lastStatus
    // advances starting→idle while the prompt is not yet drawn and the worker
    // cannot yet claim. Subsequent state-driven idle frames are idle→idle (no
    // status change), so the one-shot never re-fires and the worker strands its
    // queued task — the coordinator then relaunch-loops every ~90s.
    //
    // The adapter surfaces fsmReadySeen=true exactly when the FSM reaches its
    // first non-initial idle (the prompt is genuinely up). On that signal we
    // emit agent:ready once more. emitAgentReadyOnce is idempotent (guarded by
    // agentReadyEmitted), so providers whose boot one-shot already landed on a
    // real ready (claude-cli / codex-cli / hermes-cli, which use a startup
    // grace and whose initial state is not idle) treat this as a no-op — no
    // double claim, no double task injection.
    if (newStatus === 'idle' && adapterStatus.fsmReadySeen === true && !host.agentReadyEmitted) {
        host.emitAgentReadyOnce(chatTitle, now);
    }

    host.applyProviderResponse(parsedStatus, {
        phase: (newStatus === 'idle' && (previousStatus === 'generating' || previousStatus === 'waiting_approval'))
            ? 'turn_completed'
            : 'immediate',
    });

 // Monitor check (cooldown based notification, IDE/CLI common)
    const agentKey = `${host.type}:cli`;
    // Approval pending is detected from the raw adapter status, not `newStatus`:
    // auto-approve synthesizes `waiting_approval` → 'generating', which would
    // otherwise let the no-progress watchdog accumulate the approval wait.
    const approvalPending = rawStatus === 'waiting_approval';
    const monitorEvents = host.monitor.check(agentKey, newStatus, now, progressFingerprint, approvalPending);
    const monitorParsedStatus: any = parsedStatus;
    for (const me of monitorEvents) {
        if (
            me.type === 'monitor:no_progress'
            && host.completionHasFinalAssistantMessage(monitorParsedStatus?.messages)
            && !host.hasAdapterPendingResponse()
            && !hasNonEmptyCliModalButtons(monitorParsedStatus?.activeModal ?? monitorParsedStatus?.modal)
        ) {
            // EVTTRACE: completion fired (no-progress monitor reconciled to completion).
            if (host.isMeshWorkerSession()) {
                traceMeshEventStage('fired', host.meshTraceCtx(), 'no_progress_monitor_final_summary');
            }
            host.emitGeneratingCompleted({
                chatTitle,
                duration: host.generatingStartedAt ? Math.round((now - host.generatingStartedAt) / 1000) : undefined,
                timestamp: me.timestamp,
                finalSummary: extractFinalSummaryFromMessages(monitorParsedStatus?.messages),
                completionDiagnostic: {
                    providerType: host.type,
                    sessionId: host.instanceId,
                    providerSessionId: host.providerSessionId || null,
                    reconciliationReason: 'no_progress_monitor_final_summary',
                    finalAssistantPresent: true,
                },
            });
            host.generatingStartedAt = 0;
            // Cancel any pending debounce flush — monitor already fired completion.
            if (host.completedDebounceTimer) { clearTimeout(host.completedDebounceTimer); host.completedDebounceTimer = null; }
            host.completedDebouncePending = null;
            continue;
        }
        // MESH-STALL-WATCH dedupe: for a coordinator-spawned mesh worker the
        // status-agnostic stall watchdog (checkMeshWorkerStall) owns the
        // monitor:no_progress alert. The StatusMonitor here fires its OWN
        // generating-only no-progress on the SAME 180s bound, which would
        // double-emit into the task_stalled ledger + coordinator inbox for the
        // one stall. Suppress the StatusMonitor's copy for mesh workers only —
        // the completion-reconciliation branch above (which turns a no-progress
        // WITH final-assistant into a real completion) still runs, so genuine
        // idle-reconciled completions are unaffected. Non-mesh sessions keep the
        // original StatusMonitor behavior untouched.
        if (me.type === 'monitor:no_progress' && host.isMeshWorkerSession()) {
            traceMeshEventDrop('mesh_worker_stall_watchdog_owns_no_progress', host.meshTraceCtx('monitor:no_progress'));
            continue;
        }
        host.pushEvent({ event: me.type, agentKey: me.agentKey, message: me.message, elapsedSec: me.elapsedSec, timestamp: me.timestamp });
    }
}
