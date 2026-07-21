/**
 * CliStateEngine — CLI provider status state machine
 *
 * Owns all status-transition logic, timer management, and script-driven
 * evaluation. Reads buffer state from the transport and writes to PTY via
 * the transport interface — adapter stays as pure I/O layer.
 */

import { LOG } from '../logging/logger.js';
import {
    buildCliParseInput,
    normalizeCliParsedMessages,
    type TurnParseScope,
} from './provider-cli-parse.js';
import {
    buildCliScreenSnapshot,
    compactPromptText,
    normalizePromptText,
    promptLikelyVisible,
    type CliChatMessage,
    type CliProviderModule,
    type CliSessionStatus,
    type CliTraceEntry,
    type ParsedSession,
} from './provider-cli-shared.js';
import type { CliScriptRunner } from './cli-script-runner.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CliBufferSnapshot {
    accumulatedBuffer: string;
    accumulatedRawBuffer: string;
    recentOutputBuffer: string;
    responseBuffer: string;
    screenText: string;
    parseScreenText: string;
    workingDir: string;
    providerSessionId: string | null;
    runtimeSettings: Record<string, any>;
    isWaitingForResponse: boolean;
    currentTurnScope: TurnParseScope | null;
    lastOutputAt: number;
    lastNonEmptyOutputAt: number;
    lastScreenChangeAt: number;
    lastScreenSnapshot: string;
}

/** What the engine needs from the transport layer */
export interface CliTransportAccess {
    getSnapshot(): CliBufferSnapshot;
    writeRaw(data: string | Buffer): void;
    getApprovalKeyForIndex(buttonIndex: number): string | undefined;
    flushOutboundQueue(): void;
    isAlive(): boolean;
    /** Optional: override script dispatch (used by tests to mock detection) */
    runDetectStatus?(text: string): string | null;
    /** Optional: override script dispatch (used by tests to mock approval) */
    runParseApproval?(tail: string): { message: string; buttons: string[] } | null;
    /** Optional: override full session parse (used by tests to mock parsing) */
    runParseSession?(): ParsedSession | null;
    /** Optional: provider type override — used when tests patch the adapter's cliType */
    cliType?: string;
}

export interface CliStateEngineCallbacks {
    onStatusChange(): void;
    onApplyParsedSession(session: ParsedSession): void;
    onTurnCompleted(): void;
    /**
     * FALSE-IDLE (Fix 2): true when the owning session is inside the post-approval
     * resume grace — an autonomous auto-approving mesh session that resolved a modal
     * within the resume-grace window. The engine cannot decide this on its own (it has
     * no mesh/auto-approve awareness); the instance answers using the SAME
     * `inApprovalResumeGrace` judgment Fix 1 uses, so the two fixes stay in lockstep.
     * Optional: absent ⇒ treated as false (no hysteresis) so any non-instance embedder
     * keeps the pre-fix behavior.
     */
    isInApprovalResumeGrace?(): boolean;
}

interface IdleFinishCandidate {
    armedAt: number;
    lastOutputAt: number;
    lastScreenChangeAt: number;
    responseEpoch: number;
    assistantLength: number;
}

interface SettledEvalContext {
    now: number;
    modal: { message: string; buttons: string[] } | null;
    status: string;
    parsedMessages: CliChatMessage[];
    lastParsedAssistant: CliChatMessage | undefined;
    parsedStatus: string | null;
    prevStatus: string;
    /** snap.lastNonEmptyOutputAt at evaluation time — used to tell a genuinely
     *  fresh modal apart from a stale re-parse of an already-resolved one (see
     *  applyWaitingApproval's isStaleResolvedRepaint guard). */
    lastNonEmptyOutputAt: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const SCRIPT_STATUS_DEBOUNCE_MS = 3000;
const MAX_FINISH_RETRIES = 2;
const FINISH_RETRY_DELAY_MS = 300;
const MAX_TRACE_ENTRIES = 250;
const APPROVAL_EXIT_TIMEOUT_MS = 60_000;
const IDLE_CONFIRMATION_GRACE_MS = 2_000;
// FALSE-IDLE (Fix 2): hard upper bound on how long applyIdle may keep deferring
// finishResponse inside the post-approval resume grace. Mirrors the instance-side
// APPROVAL_RESUME_GRACE_MS (18s) — kept as a local constant since the engine has no
// access to the instance's static. If the turn truly ended right after an approval
// and stays silent this long, we stop suppressing and let the normal idle-finish run,
// so a genuinely-finished turn can never be held past this bound (no infinite defer).
const APPROVAL_RESUME_IDLE_DEFER_CAP_MS = 18_000;

// FALSE-IDLE (screen-quiet gate): the generating→idle transition (both the
// candidate-confirmed finish AND the idleFinish timeout finish) requires the
// VISIBLE TERMINAL SCREEN CONTENT to have been byte-identical for at least this
// long, continuously. `snap.lastScreenChangeAt` is bumped by the adapter every
// time the normalized screen snapshot changes (a spinner frame, streaming
// command output, etc.), so `now - lastScreenChangeAt` is the real screen-diff
// quiet age. A worker that is WAITING on a long-running foreground command
// (e.g. a `curl :3847/health` poll loop) keeps repainting the screen, so its
// quiet age never reaches this threshold and it can never be declared idle.
// This is a NECESSARY gate layered on top of the existing settle conditions —
// it only ever prevents a finish, never forces one. Owner-chosen at 5s (8s felt
// too long). Screen snapshots are read at most every 250ms
// (SCREEN_SNAPSHOT_MIN_INTERVAL_MS), so the granularity is well under 5s.
const SCREEN_QUIET_IDLE_MS = 5_000;

// ─── Engine ────────────────────────────────────────────────────────────────

export class CliStateEngine {
    // ── Status ───────────────────────────────────────
    currentStatus: CliSessionStatus['status'] = 'starting';
    isWaitingForResponse = false;
    currentTurnScope: TurnParseScope | null = null;
    // ARCH-REFACTOR R1 (per-turn task identity): the mesh taskId bound to the most
    // recently STARTED turn. Unlike currentTurnScope (nulled the moment the turn
    // settles, before the completion event is even built), this persists past
    // completion and is only overwritten when the NEXT turn starts. That window is
    // exactly what the completion path needs: when a turn settles to idle, this still
    // holds THAT turn's taskId (the next task's turn cannot have started yet — it is
    // queued in pendingOutbound and only flushed asynchronously after idle), so the
    // completion event carries the correct id instead of the racy session scalar.
    currentTurnTaskId: string | null = null;
    // GENERATING-BOUNDARY (R4d): wall-clock when the most recently STARTED turn began
    // (set by onTurnStarted, persists past completion until the next turn starts).
    // The startup-grace idle-stayed synthesis anchors its window on when the FIRST turn
    // STARTED — not on when it finished — so a turn dispatched a few seconds after the
    // grace collapse and then running for a non-trivial duration is still attributed to
    // the startup collapse even though its COMPLETION lands past a now-anchored window.
    currentTurnStartedAt = 0;
    activeModal: { message: string; buttons: string[] } | null = null;

    // ── Approval ─────────────────────────────────────
    lastApprovalResolvedAt = 0;
    lastResolvedModalMessage = '';
    /**
     * Monotonic counter bumped every time the FSM *enters* waiting_approval
     * with a freshly captured modal (see `applyWaitingApproval`). It is the
     * single discriminator between "the same approval re-observed across TUI
     * paint flaps" and "a genuinely new, distinct approval".
     *
     * The message-equality cooldown below (`lastResolvedModalMessage`) cannot
     * tell these apart on its own: claude-cli routinely presents consecutive
     * approvals whose modal message text is identical (e.g. two back-to-back
     * Bash-command prompts). When that second approval arrived inside
     * `approvalCooldown`, the message-equality guard silently swallowed the
     * key write and the approval stuck forever — fatal under auto-approval.
     *
     * `approvalEntrySeq` increments on every fresh entry; `lastResolvedEntrySeq`
     * records which entry the cooldown belongs to. We only short-circuit the
     * write when we are still resolving *that same* entry — a new entry (new
     * seq) is always a real, distinct approval and must be written.
     */
    approvalEntrySeq = 0;
    // Records which approval entry the last resolveModal() handled. Set unconditionally on
    // every resolveModal (auto-approve fire, dashboard/mesh_approve, dev-cli-debug), so
    // `lastResolvedEntrySeq >= approvalEntrySeq` is positive, ADHDev-side proof that the
    // current/latest approval entry was actually resolved. Exposed via getStatus so the
    // completion finalization gate (FALSEIDLE-a) can require resolution evidence before
    // confirming a waiting_approval→idle transition. Public (read-only by convention).
    lastResolvedEntrySeq = -1;
    /**
     * When the engine previously held a modal but the latest parse failed
     * to extract one, we record the timestamp here and only drop the modal
     * after the configured `approvalCooldown` to avoid flapping between
     * waiting_approval and generating on every Claude TUI redraw — that
     * flapping is what fed auto-approve a fresh modal signature on each
     * paint and made the engine type "1" repeatedly into the prompt.
     */
    modalLostAt = 0;
    private modalLostRecheckTimer: NodeJS.Timeout | null = null;
    private approvalExitTimeout: NodeJS.Timeout | null = null;

    // ── Response tracking ────────────────────────────
    responseEpoch = 0;
    submitPendingUntil = 0;
    responseSettleIgnoreUntil = 0;
    submitRetryUsed = false;
    submitRetryPromptSnippet = '';
    finishRetryCount = 0;
    providerErrorMessage: string | null = null;
    providerErrorReason: string | null = null;

    // ── Timers ───────────────────────────────────────
    private settleTimer: NodeJS.Timeout | null = null;
    private idleTimeout: NodeJS.Timeout | null = null;
    private finishRetryTimer: NodeJS.Timeout | null = null;
    private providerErrorRetryTimer: NodeJS.Timeout | null = null;
    private providerErrorRetryKey = '';

    // ── Debounce ─────────────────────────────────────
    pendingScriptStatus: 'generating' | 'waiting_approval' | null = null;
    pendingScriptStatusSince = 0;
    private pendingScriptStatusTimer: NodeJS.Timeout | null = null;

    // ── Idle candidate ───────────────────────────────
    private idleFinishCandidate: IdleFinishCandidate | null = null;

    // FALSE-IDLE (Fix 2): wall-clock when the current post-approval resume-grace idle
    // defer began, scoped to a responseEpoch. Zero when not deferring. Bounds the defer
    // to APPROVAL_RESUME_IDLE_DEFER_CAP_MS so a turn that genuinely ended right after an
    // approval eventually finishes. Reset whenever a new turn/response starts or completes.
    private approvalResumeDeferSince = 0;
    private approvalResumeDeferEpoch = -1;

    // ── Idle confirmation grace ──────────────────────
    /**
     * `finishResponse` produces the `generating → idle` transition that
     * coordinators interpret as "task complete". Some providers (antigravity-
     * cli observed in the wild) briefly paint a screen that looks like an
     * idle prompt between tool result frames while still actively running,
     * which fired `response_finished` and broke completion semantics.
     * We defer the actual idle transition by IDLE_CONFIRMATION_GRACE_MS and
     * cancel it if the scripted detection re-detects generating during that
     * window — a true completion stays idle for many seconds, so a 2-second
     * grace is sufficient to filter the paint blip.
     */
    private pendingIdleFinishTimer: NodeJS.Timeout | null = null;
    private pendingIdleFinishAt = 0;

    // ── Status history (debug) ───────────────────────
    private statusHistory: { status: string; at: number; trigger?: string }[] = [];
    private traceEntries: CliTraceEntry[] = [];
    private traceSeq = 0;
    private traceSessionId = '';

    constructor(
        private readonly provider: CliProviderModule,
        private readonly runner: CliScriptRunner,
        private readonly transport: CliTransportAccess,
        private readonly callbacks: CliStateEngineCallbacks,
        private readonly timeouts: Required<NonNullable<CliProviderModule['timeouts']>>,
    ) {}

    // ─── Public API ────────────────────────────────────────────────────────

    setStatus(status: CliSessionStatus['status'], trigger?: string): void {
        const prev = this.currentStatus;
        if (prev === status) return;
        // Leaving waiting_approval — cancel any pending modal-lost recheck; it
        // only exists to wake a quiescent PTY still pinned to waiting_approval.
        if (prev === 'waiting_approval' && this.modalLostRecheckTimer) {
            clearTimeout(this.modalLostRecheckTimer);
            this.modalLostRecheckTimer = null;
        }
        this.currentStatus = status;
        this.statusHistory.push({ status, at: Date.now(), trigger });
        if (this.statusHistory.length > 50) this.statusHistory.shift();
        this.recordTrace('status', { previousStatus: prev, trigger: trigger || null });
        LOG.info('CLI', `[${this.provider.type}] status: ${prev} → ${status}${trigger ? ` (${trigger})` : ''}`);
    }

    scheduleSettle(): void {
        if (this.settleTimer) clearTimeout(this.settleTimer);
        const epoch = this.responseEpoch;
        const delay = Math.max(
            this.timeouts.outputSettle,
            this.submitPendingUntil > Date.now()
                ? (this.submitPendingUntil - Date.now()) + this.timeouts.outputSettle
                : 0,
        );
        this.settleTimer = setTimeout(() => {
            this.settleTimer = null;
            if (epoch !== this.responseEpoch) return;
            this.evaluateSettled(this.transport.getSnapshot());
        }, delay);
    }

    /** Called from sendMessage in transport once a turn scope is established. */
    onTurnStarted(turnScope: TurnParseScope): void {
        this.isWaitingForResponse = true;
        this.finishRetryCount = 0;
        this.clearIdleFinishCandidate('send_message');
        this.currentTurnScope = turnScope;
        // ARCH-REFACTOR R1: bind this turn's mesh taskId. A task-less (ad-hoc dashboard)
        // turn carries no taskId → null here, which correctly clears any prior task's id
        // so an ad-hoc turn's completion is never stamped with a stale taskId.
        this.currentTurnTaskId = typeof turnScope.taskId === 'string' && turnScope.taskId.trim()
            ? turnScope.taskId
            : null;
        // R4d: stamp the turn-start moment so the startup-grace idle-stayed synthesis can
        // anchor its window on dispatch time rather than completion time.
        this.currentTurnStartedAt = Date.now();
        this.responseEpoch += 1;
        // (fix: kimi K3 send→idle-looking→generating lag / missed-generating on
        // fast tool turns) For transcriptAuthority:'provider' providers (kimi,
        // and other native-transcript sources), the PTY-scanned parser always
        // returns messages:[] — the provider owns the transcript, not the PTY —
        // so evaluateSettled's shouldHoldGenerating fast-path exception
        // (hasFinalCurrentTurnAssistant) can never release early and
        // recent_activity_hold ends up carrying the ENTIRE "is this turn still
        // generating" signal for these providers regardless of what the spinner
        // script does. That fallback only fires once a settle tick actually
        // runs, which needs PTY output to schedule — for a model that "thinks"
        // silently for many seconds before its first repaint (observed 12-20s
        // for Kimi K3's default "high" effort), the dashboard looks idle for
        // that whole window even though the turn was already accepted. Worse,
        // a turn that fully completes (tool calls + reply) within a single
        // settle debounce window can go straight idle→idle with no visible
        // generating state at all (observed live with a yolo tool-use turn).
        // onTurnStarted is the authoritative "a turn was just submitted" signal
        // — promote to generating immediately instead of waiting on PTY-driven
        // detection. This does not weaken completion detection: applyIdle /
        // finishResponse (authoritative settled evidence) still own the actual
        // idle transition, unchanged. Scoped to transcriptAuthority:'provider'
        // only, so PTY-authoritative providers (whose spinner/settled parsing
        // already drives generating promptly) are unaffected.
        if (this.provider.transcriptAuthority === 'provider' && this.currentStatus !== 'waiting_approval') {
            this.setStatus('generating', 'turn_started');
            this.callbacks.onStatusChange();
        }
    }

    /** Called when PTY exits */
    onPtyExit(): void {
        this.clearAllTimers();
        this.setStatus('stopped', 'pty_exit');
    }

    /** Called when adapter starts up successfully */
    onSpawnReady(): void {
        this.setStatus('starting', 'pty_ready');
        this.traceEntries = [];
        this.traceSeq = 0;
        this.traceSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        this.recordTrace('session_start', { providerType: this.provider.type });
    }

    resolveModal(buttonIndex: number): void {
        const snap = this.transport.getSnapshot();
        const parseApproval = typeof this.transport.runParseApproval === 'function'
            ? (s: CliBufferSnapshot) => this.transport.runParseApproval!(s.recentOutputBuffer.slice(-500))
            : (s: CliBufferSnapshot) => this.runParseApproval(s);
        let modal = this.activeModal ?? parseApproval(snap);

        if (!modal && this.runner.hasParseSession()) {
            try {
                const parsed = this.runParseSession(snap) as any;
                const parsedModal = parsed?.activeModal && Array.isArray(parsed.activeModal.buttons)
                    && parsed.activeModal.buttons.some((b: any) => typeof b === 'string' && b.trim())
                    ? parsed.activeModal : null;
                if (parsed?.status === 'waiting_approval' && parsedModal) {
                    modal = parsedModal;
                    // No modal was held (`this.activeModal` was null above), so a
                    // freshly parsed approval here is a new entry by definition.
                    this.activeModal = parsedModal;
                    this.approvalEntrySeq++;
                    if (this.currentStatus !== 'waiting_approval') {
                        this.setStatus('waiting_approval', 'resolve_modal_parse');
                        this.callbacks.onStatusChange();
                    }
                }
            } catch { /* ignore parse failures */ }
        }

        if (!this.transport.isAlive()) return;
        // (fix) Hard fail-safe: never write an approval key without a concrete
        // modal that has buttons. The previous gate `currentStatus !== 'WA' &&
        // !modal` let resolveModal proceed whenever status was still pinned to
        // waiting_approval, even if parseApproval had returned null. Combined
        // with auto-approve and Claude's modal flapping (status==WA but modal
        // briefly null between paints) this typed "1" into the prompt over and
        // over. Require a real modal with at least one button.
        const buttonsValid = Array.isArray(modal?.buttons)
            && modal.buttons.some((b: any) => typeof b === 'string' && b.trim());
        if (!modal || !buttonsValid) return;

        const currentModalMessage = typeof modal?.message === 'string' ? modal.message.trim() : '';
        const inCooldown = !!this.lastApprovalResolvedAt
            && (Date.now() - this.lastApprovalResolvedAt) < this.timeouts.approvalCooldown;
        // (fix) Suppress the duplicate key-write ONLY when this is the *same*
        // approval entry re-observed across TUI paint flaps — i.e. the FSM has
        // not entered waiting_approval afresh since the last resolve
        // (approvalEntrySeq unchanged). A new entry (bumped seq) is always a
        // distinct approval and must be written, even within the cooldown
        // window and even when its message text matches the previous one.
        //
        // Previously this gated on message equality alone, so consecutive
        // claude-cli approvals that share message text (very common) had the
        // second write swallowed — the approval stuck unresolved despite
        // auto-approval being on.
        const sameEntryReResolve = this.approvalEntrySeq === this.lastResolvedEntrySeq;
        if (inCooldown && sameEntryReResolve && currentModalMessage === this.lastResolvedModalMessage) return;

        this.clearIdleFinishCandidate('resolve_modal');
        this.recordTrace('resolve_modal', { buttonIndex, activeModal: modal, approvalEntrySeq: this.approvalEntrySeq });
        this.activeModal = null;
        this.lastApprovalResolvedAt = Date.now();
        this.lastResolvedModalMessage = currentModalMessage;
        this.lastResolvedEntrySeq = this.approvalEntrySeq;
        this.responseSettleIgnoreUntil = Date.now() + this.timeouts.outputSettle + 400;
        if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
        this.setStatus('generating', 'approval_resolved');
        this.callbacks.onStatusChange();

        const approvalKey = this.transport.getApprovalKeyForIndex(buttonIndex);
        if (approvalKey !== undefined) {
            this.transport.writeRaw(approvalKey);
        } else {
            const DOWN = '\x1B[B';
            const buttonCount = Array.isArray(modal?.buttons) ? modal.buttons.length : 0;
            const clamped = buttonCount > 0
                ? Math.min(Math.max(0, buttonIndex), buttonCount - 1)
                : Math.max(0, buttonIndex);
            this.transport.writeRaw(DOWN.repeat(clamped) + '\r');
        }
    }

    isApprovalRecentlyResolved(): boolean {
        return !!(this.lastApprovalResolvedAt
            && (Date.now() - this.lastApprovalResolvedAt) < this.timeouts.approvalCooldown);
    }

    /**
     * Called from sendMessage before starting a new turn.
     * Clears stale idle response state when the terminal looks idle and no modal is active.
     */
    clearStaleIdleResponseGuard(reason: string, snap: CliBufferSnapshot): boolean {
        const blockingModal = this.activeModal
            ?? (typeof this.transport.runParseApproval === 'function'
                ? this.transport.runParseApproval(snap.recentOutputBuffer.slice(-500))
                : this.runParseApproval(snap));
        const isIdle = (typeof this.transport.runDetectStatus === 'function'
            ? this.transport.runDetectStatus(snap.recentOutputBuffer)
            : this.runDetectStatus(snap)) === 'idle';
        if (!this.isWaitingForResponse || this.currentStatus !== 'idle' || !isIdle || !!blockingModal) {
            return false;
        }
        this.clearAllTimers();
        this.clearIdleFinishCandidate(reason);
        this.isWaitingForResponse = false;
        this.responseSettleIgnoreUntil = 0;
        this.submitRetryUsed = false;
        this.submitRetryPromptSnippet = '';
        this.finishRetryCount = 0;
        this.currentTurnScope = null;
        this.activeModal = null;
        this.recordTrace('stale_idle_response_cleared', { reason });
        this.callbacks.onTurnCompleted();
        return true;
    }

    /**
     * Called from sendMessage before starting a new turn.
     * Clears stale idle response state when the parsed session confirms idle with a final assistant message.
     */
    clearParsedIdleResponseGuard(reason: string, parsedStatus: any, snap: CliBufferSnapshot): boolean {
        const parsedRawStatus = typeof parsedStatus?.status === 'string' ? parsedStatus.status.trim() : '';
        const parsedModal = parsedStatus?.activeModal ?? parsedStatus?.modal ?? null;
        const blockingModal = this.activeModal
            ?? (typeof this.transport.runParseApproval === 'function'
                ? this.transport.runParseApproval(snap.recentOutputBuffer.slice(-500))
                : this.runParseApproval(snap));
        if (
            !this.isWaitingForResponse
            || parsedRawStatus !== 'idle'
            || !!parsedModal
            || !!blockingModal
            || !this.parsedStatusHasFinalAssistantMessage(parsedStatus)
        ) {
            return false;
        }
        this.clearAllTimers();
        this.clearIdleFinishCandidate(reason);
        this.isWaitingForResponse = false;
        this.responseSettleIgnoreUntil = 0;
        this.submitRetryUsed = false;
        this.submitRetryPromptSnippet = '';
        this.finishRetryCount = 0;
        this.currentTurnScope = null;
        this.activeModal = null;
        this.setStatus('idle', reason);
        this.recordTrace('parsed_idle_response_cleared', {
            reason,
            parsedStatus: parsedRawStatus,
            parsedMessageCount: Array.isArray(parsedStatus?.messages) ? parsedStatus.messages.length : 0,
        });
        this.callbacks.onTurnCompleted();
        return true;
    }

    clearAllTimers(): void {
        if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
        if (this.idleTimeout) { clearTimeout(this.idleTimeout); this.idleTimeout = null; }
        if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
        if (this.modalLostRecheckTimer) { clearTimeout(this.modalLostRecheckTimer); this.modalLostRecheckTimer = null; }
        if (this.finishRetryTimer) { clearTimeout(this.finishRetryTimer); this.finishRetryTimer = null; }
        if (this.pendingScriptStatusTimer) { clearTimeout(this.pendingScriptStatusTimer); this.pendingScriptStatusTimer = null; }
        if (this.providerErrorRetryTimer) { clearTimeout(this.providerErrorRetryTimer); this.providerErrorRetryTimer = null; }
        if (this.pendingIdleFinishTimer) { clearTimeout(this.pendingIdleFinishTimer); this.pendingIdleFinishTimer = null; this.pendingIdleFinishAt = 0; }
        this.providerErrorRetryKey = '';
    }

    resetActiveTurnState(): void {
        this.clearAllTimers();
        this.isWaitingForResponse = false;
        this.responseSettleIgnoreUntil = 0;
        this.submitRetryUsed = false;
        this.submitRetryPromptSnippet = '';
        this.finishRetryCount = 0;
        this.currentTurnScope = null;
        this.activeModal = null;
        this.pendingScriptStatus = null;
        this.pendingScriptStatusSince = 0;
        this.approvalResumeDeferSince = 0;
        this.approvalResumeDeferEpoch = -1;
    }

    clearIdleFinishCandidate(reason: string): void {
        if (!this.idleFinishCandidate) return;
        this.recordTrace('idle_candidate_reset', { reason, candidate: this.idleFinishCandidate });
        this.idleFinishCandidate = null;
    }

    /**
     * Poll-driven static-idle confirm (D4). A hosted CLI session (e.g. a fresh
     * antigravity coordinator) whose boot banner drove the FSM into 'generating'
     * can then sit at a STATIC ready prompt emitting no further PTY output. Every
     * output-driven busy→idle re-eval (handleOutput/resolveStartupState/settle)
     * is starved because there is no new output, and the startup-settle loop has
     * hard-stopped past spawnAt+10s — so currentStatus stays frozen at generating
     * and the dashboard disables Send. This is the ONE path that can release that
     * wedge from the read-only status poll.
     *
     * Safety: this must NEVER flip a real generating turn to idle. The gate is
     * done by the caller (getStatus) reusing resolveStartupState's proven
     * predicates: no recent PTY output for a grace window, runDetectStatus of the
     * current screen === 'idle', and no active/parsed modal. Here we add the
     * final structural guard: there must be NO active turn scope. A live user
     * turn always carries a currentTurnScope (set in onTurnStarted), so this only
     * releases the boot-banner wedge and the post-turn static-idle case, both of
     * which have already had their scope nulled. Returns true when it transitioned.
     */
    confirmPollStaticIdle(reason: string): boolean {
        if (this.currentStatus !== 'generating') return false;
        if (this.currentTurnScope || this.activeModal) return false;
        this.clearAllTimers();
        this.clearIdleFinishCandidate(reason);
        this.isWaitingForResponse = false;
        this.responseSettleIgnoreUntil = 0;
        this.submitRetryUsed = false;
        this.submitRetryPromptSnippet = '';
        this.finishRetryCount = 0;
        this.currentTurnScope = null;
        this.activeModal = null;
        this.setStatus('idle', reason);
        this.recordTrace('poll_static_idle_confirmed', { reason });
        return true;
    }

    hasActionableApproval(startupModal?: { message: string; buttons: string[] } | null): boolean {
        return !!(startupModal ?? this.activeModal);
    }

    getTraceEntries(): CliTraceEntry[] { return this.traceEntries; }
    getStatusHistory(): { status: string; at: number; trigger?: string }[] { return this.statusHistory; }
    getTraceSessionId(): string { return this.traceSessionId; }

    /** Record a trace entry from the transport layer (e.g. output events in debug mode). */
    recordExternalTrace(type: string, payload: Record<string, any> = {}): void {
        this.recordTrace(type, payload);
    }

    // ─── Script dispatch (builds inputs from snapshot) ──────────────────────

    runDetectStatus(snap: CliBufferSnapshot): string | null {
        const tail = snap.recentOutputBuffer.slice(-500);
        return this.runner.detectStatus({
            tail,
            screenText: snap.screenText,
            rawBuffer: snap.accumulatedRawBuffer,
            isWaitingForResponse: snap.isWaitingForResponse,
            screen: buildCliScreenSnapshot(snap.screenText),
            tailScreen: buildCliScreenSnapshot(tail),
        });
    }

    runParseApproval(snap: CliBufferSnapshot): { message: string; buttons: string[] } | null {
        const tail = snap.recentOutputBuffer.slice(-500);
        const buffer = snap.screenText || snap.accumulatedBuffer;
        return this.runner.parseApproval({
            buffer,
            screenText: snap.screenText,
            rawBuffer: snap.accumulatedRawBuffer,
            tail,
            screen: buildCliScreenSnapshot(snap.screenText),
            bufferScreen: buildCliScreenSnapshot(buffer),
            tailScreen: buildCliScreenSnapshot(tail),
        });
    }

    runParseSession(snap: CliBufferSnapshot): ParsedSession | null {
        // Allow transport to override session parsing (enables test mocking)
        if (typeof this.transport.runParseSession === 'function') {
            const session = this.transport.runParseSession();
            if (session && typeof session === 'object') {
                this.callbacks.onApplyParsedSession(session);
            }
            return session;
        }
        const tail = snap.recentOutputBuffer.slice(-500);
        const input = buildCliParseInput({
            accumulatedBuffer: snap.accumulatedBuffer,
            accumulatedRawBuffer: snap.accumulatedRawBuffer,
            recentOutputBuffer: snap.recentOutputBuffer,
            terminalScreenText: snap.parseScreenText,
            workingDir: snap.workingDir,
            providerSessionId: snap.providerSessionId || undefined,
            historySessionId: snap.providerSessionId || undefined,
            baseMessages: [],
            partialResponse: snap.responseBuffer,
            isWaitingForResponse: snap.isWaitingForResponse,
            scope: snap.currentTurnScope,
            runtimeSettings: snap.runtimeSettings,
        });
        const session = this.runner.parseSession({
            ...input,
            tail,
            tailScreen: buildCliScreenSnapshot(tail),
        });
        if (session && typeof session === 'object') {
            this.callbacks.onApplyParsedSession(session);
        }
        return session;
    }

    // ─── Core evaluation loop ───────────────────────────────────────────────

    evaluateSettled(snap: CliBufferSnapshot): void {
        const now = Date.now();
        if (this.submitPendingUntil > now || this.responseSettleIgnoreUntil > now) {
            const delayTime = Math.max(this.submitPendingUntil - now, this.responseSettleIgnoreUntil - now) + 50;
            if (this.settleTimer) clearTimeout(this.settleTimer);
            this.settleTimer = setTimeout(() => {
                this.settleTimer = null;
                this.evaluateSettled(this.transport.getSnapshot());
            }, delayTime);
            return;
        }

        if (!this.isWaitingForResponse && !this.currentTurnScope && !this.activeModal && !this.runner.parseErrorMessage) {
            const tail = snap.recentOutputBuffer;
            const modal = this.runParseApproval(snap);
            const lightweightStatus = this.runner.hasDetectStatus() ? this.runDetectStatus(snap) : null;
            if (!modal && lightweightStatus === 'idle' && this.currentStatus === 'idle') return;
        }

        const session = this.runParseSession(snap);
        if (!session) return;

        const { status, messages } = session;
        const modal = (session as any).activeModal ?? session.modal ?? null;
        const parsedStatus = (session as any).parsedStatus ?? null;
        const parsedMessages = normalizeCliParsedMessages(messages, {
            scope: null,
            lastOutputAt: snap.lastOutputAt,
        });

        if (this.maybeCommitVisibleIdleTranscript(session, parsedMessages, snap)) return;

        const lastParsedAssistant = [...parsedMessages].reverse().find((m) => m.role === 'assistant');

        if (
            this.currentTurnScope
            && !lastParsedAssistant
            && !this.submitRetryUsed
            && this.transport.isAlive()
            && !this.hasActionableApproval()
            && promptLikelyVisible(snap.screenText, normalizePromptText(this.submitRetryPromptSnippet || this.currentTurnScope?.prompt || ''))
            && !this.hasMeaningfulResponseBuffer(snap, normalizePromptText(this.submitRetryPromptSnippet || this.currentTurnScope?.prompt || ''))
        ) {
            this.submitRetryUsed = true;
            this.responseSettleIgnoreUntil = Date.now() + this.timeouts.outputSettle + 400;
            LOG.info('CLI', `[${this.provider.type}] Retrying submit key from settled parser (no assistant yet)`);
            this.transport.writeRaw('\r');
            if (this.settleTimer) clearTimeout(this.settleTimer);
            this.settleTimer = setTimeout(() => {
                this.settleTimer = null;
                this.evaluateSettled(this.transport.getSnapshot());
            }, this.timeouts.outputSettle + 150);
            return;
        }

        if (!status) return;

        const prevStatus = this.currentStatus;
        const ctx: SettledEvalContext = {
            now, modal, status, parsedMessages, lastParsedAssistant, parsedStatus: parsedStatus || null, prevStatus,
            lastNonEmptyOutputAt: snap.lastNonEmptyOutputAt,
        };

        if (!this.applyPendingScriptStatusDebounce(ctx)) return;

        const recentInteractiveActivity = this.hasRecentInteractiveActivity(snap, now);
        LOG.debug(
            'CLI',
            `[${this.provider.type}] settled diagnostics prompt=${JSON.stringify(this.currentTurnScope?.prompt || '').slice(0, 140)} status=${String(status || '')} parsedStatus=${String(parsedStatus || '')} parsedMsgCount=${parsedMessages.length} lastParsedAssistant=${JSON.stringify((lastParsedAssistant?.content || '').slice(0, 120)).slice(0, 160)} responseBuffer=${JSON.stringify((snap.responseBuffer || '').slice(0, 160)).slice(0, 220)} recentActivity=${recentInteractiveActivity}`
        );

        // recent_activity_hold protects an in-flight user turn from a false
        // idle blip. It must NOT fire during startup — when the adapter has
        // no currentTurnScope, there is no user turn to protect; the recent
        // activity is just the CLI painting its welcome screen. Firing here
        // produced the startup status flip the user reported
        // (generating → idle → generating → idle within the first few seconds
        // of claude-cli launch).
        //
        // When isWaitingForResponse=true and a currentTurnScope is alive, a
        // PTY quiet period (>statusActivityHold ms without output) does NOT
        // mean the response is done — claude-cli regularly pauses 2s+ between
        // chunks during parsing/generation. recentInteractiveActivity going
        // false during such a pause was the root cause of false-idle
        // regressions. We hold generating whenever an active response turn is
        // in flight (unconditionally, not just when there was recent output).
        // The real completion gate is applyIdle's idleFinishCandidate +
        // idleFinish timeout, which requires stable quiet AND a parsed
        // assistant message.
        //
        // Fast-path exception: only release the hold if the parser shows a
        // *current-turn* final standard assistant after the last user message,
        // and it is not still streaming. Using !!lastParsedAssistant was too
        // broad — it matched previous-turn assistant messages and caused
        // false-idle between the first assistant text chunk and the first
        // tool call (the agent outputs text, then immediately begins tool use;
        // the gap between them hit this fast path and committed idle).
        const hasFinalCurrentTurnAssistant = (() => {
            if (parsedStatus !== 'idle') return false;
            const msgs: any[] = Array.isArray(parsedMessages) ? parsedMessages : [];
            let lastUserIdx = -1;
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i]?.role === 'user') { lastUserIdx = i; break; }
            }
            // No user message visible: fall back to any non-streaming standard assistant.
            const searchSlice = lastUserIdx >= 0 ? msgs.slice(lastUserIdx + 1) : msgs;
            return searchSlice.some((m: any) => {
                if (!m || m.role !== 'assistant') return false;
                if (typeof m.content !== 'string' || !m.content.trim()) return false;
                const kind = typeof m.kind === 'string' && m.kind.trim() ? m.kind.trim() : 'standard';
                return kind === 'standard' && m.meta?.streaming !== true;
            });
        })();
        const shouldHoldGenerating = status === 'idle'
            && this.isWaitingForResponse
            && !!this.currentTurnScope
            && !modal
            && !hasFinalCurrentTurnAssistant;

        if (shouldHoldGenerating) { this.applyHoldGenerating(ctx); return; }
        if (status === 'error') {
            if (this.maybeScheduleProviderErrorRetry(ctx, session, snap)) return;
            this.applyError(ctx, session);
            return;
        }
        if (status === 'waiting_approval') { this.applyWaitingApproval(ctx); return; }
        if (status === 'generating') { this.applyGenerating(ctx); return; }
        if (status === 'idle') { this.applyIdle(ctx, snap, now); }
    }

    // ─── State transitions ──────────────────────────────────────────────────

    private applyPendingScriptStatusDebounce(ctx: SettledEvalContext): boolean {
        const { now, status, prevStatus } = ctx;
        const shouldDebounce = prevStatus === 'idle' && !this.isWaitingForResponse
            && !this.currentTurnScope && (status === 'generating' || status === 'waiting_approval');

        if (!shouldDebounce) {
            this.pendingScriptStatus = null;
            this.pendingScriptStatusSince = 0;
            if (this.pendingScriptStatusTimer) { clearTimeout(this.pendingScriptStatusTimer); this.pendingScriptStatusTimer = null; }
            return true;
        }

        const armPending = (delayMs: number) => {
            if (this.pendingScriptStatusTimer) clearTimeout(this.pendingScriptStatusTimer);
            this.pendingScriptStatusTimer = setTimeout(() => {
                this.pendingScriptStatusTimer = null;
                this.evaluateSettled(this.transport.getSnapshot());
            }, delayMs);
        };

        if (this.pendingScriptStatus !== status) {
            this.pendingScriptStatus = status as 'generating' | 'waiting_approval';
            this.pendingScriptStatusSince = now;
            armPending(SCRIPT_STATUS_DEBOUNCE_MS);
            return false;
        }
        const elapsed = now - this.pendingScriptStatusSince;
        if (elapsed < SCRIPT_STATUS_DEBOUNCE_MS) { armPending(SCRIPT_STATUS_DEBOUNCE_MS - elapsed); return false; }
        return true;
    }

    private applyHoldGenerating(ctx: SettledEvalContext): void {
        this.clearIdleFinishCandidate('hold_generating_recent_activity');
        this.setStatus('generating', 'recent_activity_hold');
        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        this.idleTimeout = setTimeout(() => {
            if (this.isWaitingForResponse && !this.hasActionableApproval()) {
                if (this.shouldDeferIdleTimeoutFinish()) return;
                // FALSE-IDLE (screen-quiet gate): a recent_activity_hold worker still
                // repainting (spinner + streaming command output) must NOT be finished
                // by this timeout. Re-arm and re-evaluate until the screen is quiet.
                if (!this.hasScreenBeenQuietForIdle(Date.now())) {
                    this.evaluateSettled(this.transport.getSnapshot());
                    return;
                }
                this.finishResponse();
            }
        }, this.timeouts.generatingIdle);
        this.callbacks.onStatusChange();
    }

    private applyWaitingApproval(ctx: SettledEvalContext): void {
        const { modal } = ctx;
        this.clearIdleFinishCandidate('waiting_approval');
        const inCooldown = this.lastApprovalResolvedAt
            && (Date.now() - this.lastApprovalResolvedAt) < this.timeouts.approvalCooldown;
        if (inCooldown && !modal) {
            if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
            this.activeModal = null;
            const reason = inCooldown ? 'approval_cooldown_non_actionable' : 'approval_prompt_gone_non_actionable';
            if (this.isWaitingForResponse) {
                this.setStatus('idle', reason);
                if (this.idleTimeout) clearTimeout(this.idleTimeout);
                this.idleTimeout = setTimeout(() => {
                    if (this.isWaitingForResponse && !this.hasActionableApproval()) {
                        if (this.shouldDeferIdleTimeoutFinish()) return;
                        // FALSE-IDLE (screen-quiet gate): do not finish while the screen
                        // is still repainting (see applyHoldGenerating).
                        if (!this.hasScreenBeenQuietForIdle(Date.now())) {
                            this.evaluateSettled(this.transport.getSnapshot());
                            return;
                        }
                        this.finishResponse();
                    }
                }, this.timeouts.generatingIdle);
            } else {
                this.setStatus('idle', reason);
            }
            this.callbacks.onStatusChange();
            return;
        }
        // (fix) A *real* modal with valid buttons surfacing during the cooldown
        // window is a genuinely new approval, not a trailing repaint of the one
        // we just resolved — resolveModal cleared activeModal and flipped status
        // to generating, so detectStatus only re-reports waiting_approval with a
        // concrete modal when the CLI actually presents the next prompt.
        // Previously this case fell through BOTH the `inCooldown && !modal`
        // branch above and the `!inCooldown` branch below, so the FSM silently
        // ignored the second approval — leaving it stuck unresolved under
        // auto-approval. Capture it like any fresh entry (the modal-message
        // cooldown still de-dupes the same approval inside resolveModal, now
        // keyed on approvalEntrySeq). The `!modal` flap case stays gated by
        // cooldown above; only an actionable new modal breaks through here.
        if (!inCooldown || modal) {
            if (!modal) {
                LOG.warn('CLI', `[${this.provider.type}] detectStatus=waiting_approval but parseApproval returned null; ignoring`);
                // (fix) If we previously surfaced waiting_approval but the
                // modal extraction is now failing, eventually drop the modal
                // and fall back to generating so the dashboard doesn't show
                // a "waiting" badge with no buttons. BUT defer the transition
                // for a hysteresis window — Claude TUI re-renders parts of
                // the approval frame multiple times per second and the
                // intermediate parses occasionally lose buttons for a single
                // pass. Flapping the engine status WA → generating → WA →
                // generating between paints fed auto-approve a fresh modal
                // signature each time, which typed the approval key
                // ("1") into the prompt repeatedly. Wait for the modal to
                // stay gone for `approvalCooldown` before clearing.
                //
                // (fix: kimi approve-resolve-stuck) The recovery used to require
                // `this.activeModal` to be non-null. But a provider can be pinned
                // to `waiting_approval` with `activeModal === null`: kimi's
                // questionPattern (`run.*command`) false-positive-matches the
                // user's echoed prompt ("✨ Run the shell command: …"), so
                // detectStatus reports `waiting_approval` from the question cue
                // alone while parseApproval extracts zero buttons (→ null modal,
                // never captured). After the real approval resolves and kimi goes
                // quiet, no further PTY output arrives, so this is the LAST
                // settled evaluation — with the old `&& this.activeModal` guard it
                // bare-returned and the FSM latched `waiting_approval` forever
                // (the approval appears never to resolve). Recover whenever we are
                // pinned to waiting_approval with no actionable modal, captured or
                // not, and arm a re-check so a quiescent PTY still gets one more
                // evaluation pass to reach the hysteresis deadline.
                if (this.currentStatus === 'waiting_approval') {
                    const lostAt = this.modalLostAt || Date.now();
                    if (!this.modalLostAt) this.modalLostAt = lostAt;
                    if (Date.now() - lostAt >= this.timeouts.approvalCooldown) {
                        this.activeModal = null;
                        this.modalLostAt = 0;
                        this.setStatus('generating', 'approval_lost_modal');
                        this.callbacks.onStatusChange();
                    } else {
                        // Not yet past the hysteresis window. The PTY may be
                        // quiescent (kimi emits nothing once idle), so schedule an
                        // explicit re-evaluation — otherwise no settle tick ever
                        // fires again and the recovery above is never reached.
                        this.armModalLostRecheck();
                    }
                }
                return;
            }
            // (fix: kimi stale-approval re-latch, observed live on kimi-code
            // v0.28.1/K3) A freshly-*parsed* modal is not proof the CLI is
            // presenting it right now — parseApproval scans an accumulated
            // raw-output window (recentOutputBuffer / window-around-question
            // scope), which can still contain the text of an approval that was
            // ALREADY resolved a moment ago and re-surface it on the very next
            // settle pass, even though resolveModal() already wrote the key and
            // cleared activeModal. Reproduced live: after approving a tool call,
            // the FSM re-latched `waiting_approval` on the identical
            // already-answered question with NO further PTY output ever
            // arriving afterward — nothing left to trigger a later
            // re-evaluation, so the dashboard stayed wedged on "waiting for
            // approval" until the 5-minute maxResponse watchdog forced a recheck.
            //
            // Reject a recapture only when ALL of: (a) this is the first capture
            // since the last resolve (`!this.activeModal` — a genuinely repeated
            // approval re-enters this branch too, since resolveModal always
            // nulls activeModal), (b) the message text matches the one we just
            // resolved, AND (c) no genuinely new PTY output has arrived since
            // the resolve. (c) is the load-bearing condition — deliberately NOT
            // time-bounded. A live standalone repro (kimi-code v0.28.1/K3) showed
            // the stale-buffer window can outlast an arbitrary cooldown by a wide
            // margin (observed 30s+, tied to K3's "high" effort settle timing),
            // so gating this on approvalCooldown let the guard's protection
            // expire before the stale content actually cleared and the FSM
            // re-latched anyway. Output freshness alone is both necessary and
            // sufficient regardless of elapsed time: it only stops rejecting once
            // fresh output genuinely arrives, and it keeps consecutive-approvals-
            // with-identical-text (e.g. two back-to-back "Allow Bash command?"
            // prompts) working correctly, since a real follow-up approval
            // necessarily requires the CLI to have produced fresh output first
            // (running the previous tool, then asking again) — lastNonEmptyOutputAt
            // always advances past lastApprovalResolvedAt for any genuinely new
            // approval, regardless of shared message text or how much time passed.
            const normalizedMessage = typeof modal.message === 'string' ? modal.message.trim() : '';
            const isStaleResolvedRepaint = !this.activeModal
                && this.lastApprovalResolvedAt > 0
                && normalizedMessage.length > 0
                && normalizedMessage === this.lastResolvedModalMessage
                && ctx.lastNonEmptyOutputAt <= this.lastApprovalResolvedAt;
            if (isStaleResolvedRepaint) {
                LOG.debug('CLI', `[${this.provider.type}] ignoring stale re-parsed approval matching the just-resolved modal (no new output since resolve)`);
                return;
            }
            this.modalLostAt = 0;
            this.isWaitingForResponse = true;
            this.setStatus('waiting_approval', 'script_detect');
            // (fix) Don't overwrite an already-captured modal with a fresh
            // re-parse on every evaluate — Claude TUI redraws option labels
            // partially between paints (e.g. "Yes, and don't ask again for ..."
            // is wider than the row and ships with a different trailing
            // string each paint), which made the dashboard flap the modal
            // signature continuously. Keep the first stable modal whose
            // button count matches the latest parse; only swap when the
            // shape clearly changed (different number of buttons → different
            // approval).
            const prev = this.activeModal;
            const prevBtnCount = Array.isArray(prev?.buttons) ? prev!.buttons.length : 0;
            const nextBtnCount = Array.isArray(modal.buttons) ? modal.buttons.length : 0;
            if (!prev || prevBtnCount !== nextBtnCount) {
                this.activeModal = modal;
                // A fresh modal was captured (none held, or the button shape
                // changed). This is a distinct approval entry — bump the seq so
                // resolveModal's message-equality cooldown does not mistake it
                // for a flap-repaint of the previously resolved approval.
                this.approvalEntrySeq++;
                this.callbacks.onStatusChange();
            }
            if (this.idleTimeout) clearTimeout(this.idleTimeout);
            this.armApprovalExitTimeout();
        }
    }

    private applyGenerating(ctx: SettledEvalContext): void {
        const { modal, parsedMessages, lastParsedAssistant, parsedStatus, prevStatus } = ctx;
        const noActiveTurn = !this.currentTurnScope;
        // If the turn is already complete (isWaitingForResponse=false, no scope,
        // no modal), PTY generating blips are just the CLI repainting its prompt.
        // Check BEFORE cancelling the pending idle-finish timer — we don't want
        // to cancel a scheduled idle transition just because the CLI blinked.
        if (!this.isWaitingForResponse && noActiveTurn && !modal) return;
        this.clearIdleFinishCandidate('generating');
        // Cancel any pending grace-window idle transition. We have fresh
        // evidence the provider is still generating; the previous
        // finishResponse() was a paint blip, not a real completion.
        this.cancelPendingIdleFinish('generating_signal_returned');
        const snap = this.transport.getSnapshot();
        const effectiveScreenText = snap.screenText || snap.accumulatedBuffer;
        const looksIdleChrome = /(^|\n)\s*[❯›>]\s*(?:\n|$)/m.test(effectiveScreenText);
        const parsedShowsLiveProgress = parsedStatus === 'generating' && !!lastParsedAssistant;
        if (prevStatus === 'idle' && !this.isWaitingForResponse && noActiveTurn && !modal && looksIdleChrome && !parsedShowsLiveProgress) return;
        if (prevStatus === 'waiting_approval') {
            if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
            this.activeModal = null;
            this.lastApprovalResolvedAt = Date.now();
        }
        if (!this.isWaitingForResponse) { this.isWaitingForResponse = true; }
        this.setStatus('generating', 'script_detect');
        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        this.idleTimeout = setTimeout(() => {
            if (this.isWaitingForResponse) {
                if (this.shouldDeferIdleTimeoutFinish()) return;
                // FALSE-IDLE (screen-quiet gate): the generating→idle timeout must NOT
                // finish while the visible screen is still changing (spinner + streaming
                // command output). This is the primary false-idle path — a worker WAITING
                // on a long-running foreground command sits in generating with a live,
                // repainting screen. Re-evaluate until the screen has been quiet >= 5s.
                if (!this.hasScreenBeenQuietForIdle(Date.now())) {
                    this.evaluateSettled(this.transport.getSnapshot());
                    return;
                }
                this.finishResponse();
            }
        }, this.timeouts.generatingIdle);
        this.callbacks.onStatusChange();
    }

    private applyError(ctx: SettledEvalContext, session: ParsedSession): void {
        this.clearIdleFinishCandidate('provider_error');
        this.clearAllTimers();
        this.isWaitingForResponse = false;
        this.responseSettleIgnoreUntil = 0;
        this.submitRetryUsed = false;
        this.submitRetryPromptSnippet = '';
        this.finishRetryCount = 0;
        this.currentTurnScope = null;
        this.activeModal = null;
        this.providerErrorMessage = typeof session.errorMessage === 'string' && session.errorMessage.trim()
            ? session.errorMessage.trim() : 'Provider reported an error';
        this.providerErrorReason = typeof session.errorReason === 'string' && session.errorReason.trim()
            ? session.errorReason.trim() : 'provider_error';
        this.setStatus('error', this.providerErrorReason);
        this.callbacks.onStatusChange();
    }

    private maybeScheduleProviderErrorRetry(ctx: SettledEvalContext, session: ParsedSession, snap: CliBufferSnapshot): boolean {
        const retryPrompt = typeof (session as any).retryPrompt === 'string' ? String((session as any).retryPrompt).trim() : '';
        const retryDelayMs = typeof (session as any).retryDelayMs === 'number' ? Number((session as any).retryDelayMs) : NaN;
        if (!retryPrompt || !Number.isFinite(retryDelayMs) || retryDelayMs < 0 || !this.transport.isAlive()) return false;

        const retryAttempt = typeof (session as any).retryAttempt === 'number' ? Number((session as any).retryAttempt) : 0;
        const errorReason = typeof session.errorReason === 'string' && session.errorReason.trim() ? session.errorReason.trim() : 'provider_error';
        const retryKey = `${errorReason}:${retryAttempt}:${retryPrompt}`;
        if (this.providerErrorRetryTimer && this.providerErrorRetryKey === retryKey) return true;

        if (this.providerErrorRetryTimer) clearTimeout(this.providerErrorRetryTimer);
        this.providerErrorRetryKey = retryKey;
        this.clearIdleFinishCandidate('provider_error_retry');
        if (this.idleTimeout) { clearTimeout(this.idleTimeout); this.idleTimeout = null; }
        if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
        this.providerErrorMessage = typeof session.errorMessage === 'string' && session.errorMessage.trim()
            ? session.errorMessage.trim() : 'Provider reported an error';
        this.providerErrorReason = errorReason;
        this.activeModal = null;
        this.responseSettleIgnoreUntil = Date.now() + retryDelayMs + this.timeouts.outputSettle + 400;
        this.setStatus('generating', 'provider_error_retry_scheduled');
        this.callbacks.onStatusChange();

        this.providerErrorRetryTimer = setTimeout(() => {
            this.providerErrorRetryTimer = null;
            this.providerErrorRetryKey = '';
            if (!this.transport.isAlive()) return;
            this.responseSettleIgnoreUntil = Date.now() + this.timeouts.outputSettle + 400;
            this.submitRetryUsed = false;
            this.transport.writeRaw(`${retryPrompt}\r`);
            if (this.settleTimer) clearTimeout(this.settleTimer);
            this.settleTimer = setTimeout(() => {
                this.settleTimer = null;
                this.evaluateSettled(this.transport.getSnapshot());
            }, this.timeouts.outputSettle + 150);
        }, retryDelayMs);
        return true;
    }

    private applyIdle(ctx: SettledEvalContext, snap: CliBufferSnapshot, now: number): void {
        const { modal, lastParsedAssistant, prevStatus } = ctx;
        if (prevStatus === 'waiting_approval') {
            if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
            this.activeModal = null;
            this.lastApprovalResolvedAt = Date.now();
            this.setStatus('idle', 'approval_prompt_gone_script_idle');
        }
        if (!this.isWaitingForResponse) {
            if (prevStatus !== 'idle') {
                this.clearIdleFinishCandidate('idle_without_response');
                this.setStatus('idle', 'script_detect');
                this.callbacks.onStatusChange();
            }
            return;
        }
        const quietForMs = snap.lastNonEmptyOutputAt ? (now - snap.lastNonEmptyOutputAt) : Number.MAX_SAFE_INTEGER;
        const screenStableMs = snap.lastScreenChangeAt ? (now - snap.lastScreenChangeAt) : 0;
        const hasAssistantTurn = !!lastParsedAssistant;
        const assistantLength = (lastParsedAssistant as any)?.content?.length || 0;
        const idleFinishConfirmMs = this.timeouts.idleFinishConfirm;
        const idleQuietThresholdMs = Math.max(idleFinishConfirmMs, this.timeouts.outputSettle);
        // FALSE-IDLE (screen-quiet gate): NECESSARY condition — the visible screen
        // content must have been byte-identical for >= SCREEN_QUIET_IDLE_MS. A worker
        // still repainting (spinner frame, streaming command output) resets
        // lastScreenChangeAt on every change, so its quiet age never reaches the
        // threshold and it can never arm/confirm idle. Layered on top of the existing
        // conditions — it only ever prevents a finish, never forces one.
        const screenQuietForIdle = screenStableMs >= SCREEN_QUIET_IDLE_MS;
        const idleReady = !modal && hasAssistantTurn && quietForMs >= idleQuietThresholdMs
            && screenStableMs >= idleFinishConfirmMs && screenQuietForIdle;
        const candidate = this.idleFinishCandidate;
        const candidateQuiet = !!candidate && candidate.responseEpoch === this.responseEpoch
            && candidate.lastOutputAt === snap.lastOutputAt
            && candidate.lastScreenChangeAt === snap.lastScreenChangeAt
            && assistantLength >= candidate.assistantLength
            && (now - candidate.armedAt) >= idleFinishConfirmMs;

        // FALSE-IDLE (Fix 2) FSM-level hysteresis: an autonomous auto-approving mesh
        // worker that just auto-resolved an approval resumes the same turn and falls
        // briefly silent (the inter-approval quiet valley) before the next tool/approval.
        // resetActiveTurnState tearing the turn down in that valley is the root cause the
        // downstream Fix 1 / hasAdapterPendingResponse gates then inherit as "turn closed".
        // Suppress the idle declaration here — at the FSM level — while inside the
        // post-approval resume grace, so the turn scope is NOT torn down mid-flight.
        // Bounded by APPROVAL_RESUME_IDLE_DEFER_CAP_MS: if the turn genuinely ended right
        // after an approval and stays silent past the cap, we stop deferring and let the
        // normal idle-finish run. Re-arm the idle timeout so we re-evaluate after the
        // quiet grows (either the worker resumes → this path releases, or the cap lapses
        // → finish). Scoped through the instance callback so a plain/interactive turn with
        // no autonomous auto-approve is never affected.
        if (this.shouldDeferIdleForApprovalResume(now)) {
            this.clearIdleFinishCandidate('approval_resume_grace_defer');
            if (this.idleTimeout) clearTimeout(this.idleTimeout);
            this.idleTimeout = setTimeout(() => {
                if (this.isWaitingForResponse) this.evaluateSettled(this.transport.getSnapshot());
            }, this.timeouts.idleFinish);
            return;
        }

        if (idleReady && candidateQuiet) {
            this.clearIdleFinishCandidate('finish_response');
            if (this.idleTimeout) clearTimeout(this.idleTimeout);
            this.finishResponse();
            return;
        }

        if (idleReady) {
            if (!candidate) { this.armIdleFinishCandidate(snap, assistantLength); return; }
        } else {
            this.clearIdleFinishCandidate('idle_not_ready');
        }

        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        this.idleTimeout = setTimeout(() => {
            if (this.isWaitingForResponse && !this.hasActionableApproval()) {
                if (this.shouldDeferIdleForApprovalResume(Date.now())) {
                    this.idleTimeout = setTimeout(() => {
                        if (this.isWaitingForResponse) this.evaluateSettled(this.transport.getSnapshot());
                    }, this.timeouts.idleFinish);
                    return;
                }
                if (this.shouldDeferIdleTimeoutFinish()) return;
                // FALSE-IDLE (screen-quiet gate): the idleFinish timeout must NOT
                // finish while the visible screen is still changing. A worker
                // WAITING on a long-running foreground command keeps repainting the
                // screen (spinner + streaming output), so lastScreenChangeAt stays
                // fresh and the quiet age never reaches SCREEN_QUIET_IDLE_MS. Re-arm
                // and re-evaluate instead of emitting a weak/false completion.
                if (!this.hasScreenBeenQuietForIdle(Date.now())) {
                    if (this.idleTimeout) clearTimeout(this.idleTimeout);
                    this.idleTimeout = setTimeout(() => {
                        if (this.isWaitingForResponse) this.evaluateSettled(this.transport.getSnapshot());
                    }, this.timeouts.idleFinish);
                    return;
                }
                const parsed = this.runParseSession(this.transport.getSnapshot());
                if (this.shouldDeferFinishForTranscript(parsed)) {
                    this.rescheduleTranscriptFinishCheck('transcript_idle_timeout_not_final');
                    return;
                }
                this.clearIdleFinishCandidate('idle_timeout_finish');
                this.finishResponse();
            }
        }, this.timeouts.idleFinish);
    }

    /**
     * FALSE-IDLE (screen-quiet gate): has the visible terminal screen content been
     * byte-identical for at least SCREEN_QUIET_IDLE_MS continuously?
     *
     * `lastScreenChangeAt` is bumped by the adapter every time the normalized screen
     * snapshot changes (spinner frame, streaming command output, etc.), so
     * `now - lastScreenChangeAt` is the real screen-diff quiet age. Reads the LIVE
     * transport snapshot so the deferred idleFinish timeout re-checks current screen
     * state, not the stale snapshot from when the timer was armed. A never-changed
     * screen (lastScreenChangeAt === 0) is treated as quiet.
     */
    private hasScreenBeenQuietForIdle(now: number): boolean {
        const lastChange = this.transport.getSnapshot().lastScreenChangeAt;
        if (!lastChange) return true;
        return (now - lastChange) >= SCREEN_QUIET_IDLE_MS;
    }

    /**
     * FALSE-IDLE (Fix 2): should applyIdle suppress the idle/finish for the current
     * turn because we are inside the post-approval resume grace?
     *
     * True only when: (a) the owning instance reports it is an autonomous auto-approving
     * mesh session that resolved a modal within the resume-grace window
     * (isInApprovalResumeGrace callback — the SAME judgment Fix 1 uses), AND (b) the defer
     * for THIS response epoch has not yet exceeded APPROVAL_RESUME_IDLE_DEFER_CAP_MS.
     * The cap guarantees no infinite defer: a turn that genuinely ended right after an
     * approval and stays silent past the cap stops being suppressed and finishes normally.
     * The per-epoch anchor means a fresh turn/response restarts the clock.
     */
    private shouldDeferIdleForApprovalResume(now: number): boolean {
        if (typeof this.callbacks.isInApprovalResumeGrace !== 'function') { this.clearApprovalResumeDefer(); return false; }
        let inGrace = false;
        try { inGrace = this.callbacks.isInApprovalResumeGrace() === true; } catch { inGrace = false; }
        // Probe says the session is no longer in the post-approval resume grace — reset the
        // cap clock so a LATER approval-resume valley in this same response starts fresh.
        if (!inGrace) { this.clearApprovalResumeDefer(); return false; }
        if (this.approvalResumeDeferEpoch !== this.responseEpoch || this.approvalResumeDeferSince === 0) {
            // First defer for this response — start the cap clock. Note: the clock is only
            // reset by clearApprovalResumeDefer (probe false, turn teardown), NOT by a
            // cap-release below — so once the cap trips it STAYS released for the whole
            // grace episode (no arm/clear cycle can restart the 18s and defer forever).
            this.approvalResumeDeferEpoch = this.responseEpoch;
            this.approvalResumeDeferSince = now;
            return true;
        }
        if ((now - this.approvalResumeDeferSince) >= APPROVAL_RESUME_IDLE_DEFER_CAP_MS) {
            // Cap reached: stop suppressing so the normal idle-finish can run. Deliberately
            // does NOT clear the clock — leaving deferSince set keeps this branch returning
            // false on every subsequent call until the probe drops (clearApprovalResumeDefer)
            // or the turn ends (resetActiveTurnState), preventing an infinite re-defer.
            return false;
        }
        return true;
    }

    private clearApprovalResumeDefer(): void {
        this.approvalResumeDeferSince = 0;
        this.approvalResumeDeferEpoch = -1;
    }

    finishResponse(): void {
        if (this.submitPendingUntil > Date.now()) return;
        if (this.responseSettleIgnoreUntil > Date.now()) return;
        const snap = this.transport.getSnapshot();
        const parsedBeforeFinish = this.runParseSession(snap);
        if (this.shouldDeferFinishForTranscript(parsedBeforeFinish)) {
            this.rescheduleTranscriptFinishCheck('transcript_finish_not_final');
            return;
        }
        this.clearIdleFinishCandidate('finish_response_enter');
        const commitResult = this.commitCurrentTranscript(snap);
        if (this.shouldRetryFinishResponse(snap, commitResult)) {
            this.finishRetryCount += 1;
            if (this.finishRetryTimer) clearTimeout(this.finishRetryTimer);
            this.finishRetryTimer = setTimeout(() => {
                this.finishRetryTimer = null;
                if (this.isWaitingForResponse && !this.hasActionableApproval()) this.finishResponse();
            }, FINISH_RETRY_DELAY_MS);
            return;
        }
        this.resetActiveTurnState();
        this.callbacks.onTurnCompleted();
        // Defer the actual `generating → idle` transition by a short grace
        // window. If applyGenerating fires again before the grace expires —
        // antigravity's tool-result paint blips do this — cancelPendingIdle
        // Finish() drops the pending transition and we stay generating.
        this.scheduleIdleFinish('response_finished');
        this.transport.flushOutboundQueue();
    }

    private scheduleIdleFinish(reason: string): void {
        // If we are already deferring, replace the schedule so the most
        // recent finishResponse "wins". Reasons accumulate via the trigger.
        if (this.pendingIdleFinishTimer) clearTimeout(this.pendingIdleFinishTimer);
        this.pendingIdleFinishAt = Date.now() + IDLE_CONFIRMATION_GRACE_MS;
        this.pendingIdleFinishTimer = setTimeout(() => {
            this.pendingIdleFinishTimer = null;
            this.pendingIdleFinishAt = 0;
            // If a new user turn started during the grace window, we owe
            // generating semantics to that turn — do not retroactively idle.
            if (this.isWaitingForResponse) return;
            // The timer firing without a cancelPendingIdleFinish call means
            // no fresh applyGenerating happened during the grace window;
            // the previous fake-blip is over. Commit the idle.
            //
            // Note: the previous "currentStatus === 'generating' → return"
            // guard caused stuck-generating sessions — finishResponse leaves
            // currentStatus='generating' on purpose (so the dashboard keeps
            // the spinner during the 2s grace), and then the timer fired
            // without cancellation but refused to commit because the very
            // status we are about to transition out of was still set.
            // Re-checking currentStatus there meant idle was unreachable.
            this.setStatus('idle', reason);
            this.callbacks.onStatusChange();
        }, IDLE_CONFIRMATION_GRACE_MS);
    }

    private cancelPendingIdleFinish(reason: string): void {
        if (!this.pendingIdleFinishTimer) return;
        clearTimeout(this.pendingIdleFinishTimer);
        this.pendingIdleFinishTimer = null;
        this.pendingIdleFinishAt = 0;
        this.recordTrace('idle_finish_cancelled', { trigger: reason });
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    /**
     * Schedule one more settled evaluation while pinned to `waiting_approval`
     * with no actionable modal. The settled FSM normally only re-runs on new
     * PTY output; a provider whose modal cue lingers in a form detectStatus
     * still matches (e.g. kimi's questionPattern hitting the user echo) but
     * whose PTY has gone quiet would never get another evaluation, latching
     * `waiting_approval` forever. This timer guarantees the modal-lost recovery
     * in `applyWaitingApproval` is reached even against a silent PTY. It is a
     * no-op once the FSM leaves `waiting_approval` (the re-evaluation itself
     * takes the recovery branch and clears the state).
     */
    private armModalLostRecheck(): void {
        if (this.modalLostRecheckTimer) return;
        this.modalLostRecheckTimer = setTimeout(() => {
            this.modalLostRecheckTimer = null;
            if (this.currentStatus !== 'waiting_approval') return;
            this.evaluateSettled(this.transport.getSnapshot());
        }, this.timeouts.approvalCooldown);
    }

    private armApprovalExitTimeout(): void {
        if (this.approvalExitTimeout) clearTimeout(this.approvalExitTimeout);
        this.approvalExitTimeout = setTimeout(() => {
            if (!this.hasActionableApproval()) return;
            const snap = this.transport.getSnapshot();
            const modal = typeof this.transport.runParseApproval === 'function'
                ? this.transport.runParseApproval(snap.recentOutputBuffer.slice(-500))
                : this.runParseApproval(snap);
            const detectStatus = typeof this.transport.runDetectStatus === 'function'
                ? this.transport.runDetectStatus(snap.recentOutputBuffer)
                : this.runDetectStatus(snap);
            const stillWaiting = detectStatus === 'waiting_approval' || !!modal;
            if (stillWaiting) {
                if (!modal) {
                    LOG.warn('CLI', `[${this.provider.type}] approval timeout: no actionable modal; keeping fail-closed`);
                    this.activeModal = null;
                    this.callbacks.onStatusChange();
                    this.armApprovalExitTimeout();
                    return;
                }
                this.activeModal = modal;
                this.callbacks.onStatusChange();
                this.armApprovalExitTimeout();
                return;
            }
            LOG.warn('CLI', `[${this.provider.type}] Approval timeout — auto-clearing`);
            this.activeModal = null;
            this.lastApprovalResolvedAt = Date.now();
            this.setStatus('idle', 'approval_timeout');
            this.callbacks.onStatusChange();
        }, APPROVAL_EXIT_TIMEOUT_MS);
    }

    private armIdleFinishCandidate(snap: CliBufferSnapshot, assistantLength: number): void {
        const now = Date.now();
        this.idleFinishCandidate = {
            armedAt: now,
            lastOutputAt: snap.lastOutputAt,
            lastScreenChangeAt: snap.lastScreenChangeAt,
            responseEpoch: this.responseEpoch,
            assistantLength,
        };
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => {
            this.settleTimer = null;
            this.evaluateSettled(this.transport.getSnapshot());
        }, this.timeouts.idleFinishConfirm);
    }

    private shouldDeferIdleTimeoutFinish(): boolean {
        if (!this.isWaitingForResponse || this.hasActionableApproval()) return false;
        const snap = this.transport.getSnapshot();
        const detectFn = typeof this.transport.runDetectStatus === 'function'
            ? () => this.transport.runDetectStatus!(snap.recentOutputBuffer)
            : () => this.runDetectStatus(snap);
        // Only a POSITIVE `generating` verdict from the live detector defers the
        // finish. A null verdict is "no cue matched", NOT "still generating" — for
        // a provider whose only idle cue is a composer placeholder (opencode's
        // `Ask anything`) that can momentarily fall out of the captured frame while
        // the TUI redraws its status chip, detectStatus returns null under the
        // manifest's `onNoMatch: preserve-last` policy. Collapsing that null to
        // `this.currentStatus` (which is `generating` while the hold is armed) made
        // the finish defer on EVERY tick, so the completion never fired and the
        // session wedged in `generating` forever even though its assistant reply had
        // already landed in native-history. Treat null as "no evidence to defer" and
        // let the idle-finish proceed; a real in-flight turn still re-reports a
        // positive `generating` here and defers as before.
        const latestStatus = detectFn();
        if (latestStatus === 'generating') {
            this.evaluateSettled(snap);
            return true;
        }
        return false;
    }

    private hasRecentInteractiveActivity(snap: CliBufferSnapshot, now: number): boolean {
        const quietForMs = snap.lastNonEmptyOutputAt ? (now - snap.lastNonEmptyOutputAt) : Number.MAX_SAFE_INTEGER;
        const screenStableMs = snap.lastScreenChangeAt ? (now - snap.lastScreenChangeAt) : Number.MAX_SAFE_INTEGER;
        return quietForMs < this.timeouts.statusActivityHold || screenStableMs < this.timeouts.statusActivityHold;
    }

    private hasMeaningfulResponseBuffer(snap: CliBufferSnapshot, normalizedPromptSnippet: string): boolean {
        const raw = String(snap.responseBuffer || '').trim();
        if (!raw) return false;
        const normalizedPrompt = compactPromptText(normalizedPromptSnippet);
        if (!normalizedPrompt) return true;
        const normalizedBuffer = compactPromptText(raw);
        if (!normalizedBuffer) return false;
        if (normalizedBuffer === normalizedPrompt) return false;
        if (normalizedBuffer.startsWith(normalizedPrompt)) {
            const remainder = normalizedBuffer.slice(normalizedPrompt.length)
                .replace(/[─═\-]+/g, '')
                .replace(/⏵⏵accepteditson\([^)]*\)/gi, '')
                .replace(/esctointerrupt/gi, '')
                .replace(/❯/g, '')
                .replace(/^[\s\-–—:;,.!/?]+/, '')
                .trim();
            return remainder.length > 0;
        }
        return true;
    }

    private shouldDeferFinishForTranscript(parsed: any): boolean {
        // Honor only the explicit manifest opt-in. We used to also hard-code
        // codex-cli here, but that left codex sessions wedged in `generating`
        // whenever the PTY parser or native transcript missed the final
        // assistant line — a much more common failure mode than the original
        // background-tool race this was meant to guard against. If a provider
        // really needs the gate, the manifest can set
        // `requiresFinalAssistantBeforeIdle: true`.
        const requiresFinalAssistant = !!this.provider.requiresFinalAssistantBeforeIdle;
        if (!requiresFinalAssistant) return false;
        if (!this.isWaitingForResponse || !this.currentTurnScope || this.hasActionableApproval()) return false;
        const parsedStatus = typeof parsed?.status === 'string' ? parsed.status.trim() : '';
        if (parsedStatus !== 'idle') return true;
        if (parsed?.activeModal || parsed?.modal) return true;
        // For providers that own their history externally (e.g. SpecCliAdapter
        // reading native JSONL), parsed.messages only reflects PTY-visible
        // content which may include previous-turn assistant messages. Gate on
        // whether the *current turn* has a final assistant: find the last user
        // in parsed.messages, and check there is an assistant after it.
        // If no user found at all (e.g. PTY hid it), defer — the native-history
        // completion gate in cli-provider-instance will confirm via JSONL read.
        // For providers that own their history externally (e.g. SpecCliAdapter
        // reading native JSONL), parsed.messages may include previous-turn
        // assistant messages. Only an assistant that appears *after* the last
        // user message counts as evidence the current turn finished.
        const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
        let lastUserIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]?.role === 'user') { lastUserIdx = i; break; }
        }
        if (lastUserIdx < 0) {
            // No user message visible in PTY parser. Two sub-cases:
            // (a) messages is non-empty — some content was parsed but no user
            //     line was found. Use the any-assistant fallback.
            // (b) messages is empty — the provider owns history externally
            //     (e.g. SpecCliAdapter always returns []) and PTY gives us
            //     nothing to judge. Do NOT defer here: deferring with empty
            //     messages causes an infinite reschedule loop because
            //     parsedStatusHasFinalStandardAssistantMessage also returns
            //     false on empty input. Let cli-provider-instance's native-
            //     history gate handle this case.
            if (messages.length === 0) return false;
            return !this.parsedStatusHasFinalStandardAssistantMessage(parsed);
        }
        // Check for a final standard assistant after the last user
        const hasCurrentTurnAssistant = messages.slice(lastUserIdx + 1).some((m: any) => {
            if (!m || m.role !== 'assistant') return false;
            if (typeof m.content !== 'string' || !m.content.trim()) return false;
            const kind = typeof m.kind === 'string' && m.kind.trim() ? m.kind.trim() : 'standard';
            return kind === 'standard' && m.meta?.streaming !== true;
        });
        return !hasCurrentTurnAssistant;
    }

    private rescheduleTranscriptFinishCheck(reason: string): void {
        this.clearIdleFinishCandidate(reason);
        this.setStatus('generating', reason);
        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        this.idleTimeout = setTimeout(() => {
            if (!this.isWaitingForResponse || this.hasActionableApproval()) return;
            this.evaluateSettled(this.transport.getSnapshot());
        }, this.timeouts.idleFinishConfirm);
        this.recordTrace('transcript_finish_deferred', { reason });
    }

    private shouldRetryFinishResponse(snap: CliBufferSnapshot, commitResult: { hasAssistant: boolean; assistantContent: string }): boolean {
        if (!this.currentTurnScope) return false;
        if (this.hasActionableApproval()) return false;
        if (this.finishRetryCount >= MAX_FINISH_RETRIES) return false;
        if (commitResult.hasAssistant && commitResult.assistantContent.trim()) return false;
        if (this.runDetectStatus(snap) !== 'idle') return false;
        const now = Date.now();
        const quietForMs = snap.lastNonEmptyOutputAt ? (now - snap.lastNonEmptyOutputAt) : Number.MAX_SAFE_INTEGER;
        const screenStableMs = snap.lastScreenChangeAt ? (now - snap.lastScreenChangeAt) : 0;
        return quietForMs < 1200 || screenStableMs < 1200 || !commitResult.hasAssistant;
    }

    private commitCurrentTranscript(snap: CliBufferSnapshot): { hasAssistant: boolean; assistantContent: string } {
        const parsed = this.runParseSession(snap);
        if (parsed && Array.isArray(parsed.messages)) {
            const parsedMessages = normalizeCliParsedMessages(parsed.messages, { scope: null, lastOutputAt: snap.lastOutputAt });
            const lastAssistant = [...parsedMessages].reverse().find((m) => m.role === 'assistant');
            if (lastAssistant) return { hasAssistant: true, assistantContent: lastAssistant.content || '' };
        }
        return { hasAssistant: false, assistantContent: '' };
    }

    private maybeCommitVisibleIdleTranscript(session: ParsedSession, parsedMessages: CliChatMessage[], snap: CliBufferSnapshot): boolean {
        if (!this.provider.allowInputDuringGeneration) return false;
        if (!session || session.status !== 'idle' || !this.isWaitingForResponse || !this.currentTurnScope || this.activeModal || session.modal) return false;
        const visibleAssistant = [...parsedMessages].reverse().find((m) => m.role === 'assistant' && String(m.content || '').trim());
        if (!visibleAssistant) return false;
        this.resetActiveTurnState();
        this.callbacks.onTurnCompleted();
        this.setStatus('idle', 'script_idle_commit');
        this.callbacks.onStatusChange();
        this.transport.flushOutboundQueue();
        return true;
    }

    private parsedStatusHasFinalAssistantMessage(parsed: any): boolean {
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const last = [...messages].reverse().find((m: any) => {
            if (!m || m.role !== 'assistant') return false;
            return typeof m.content === 'string' && m.content.trim().length > 0;
        });
        return !!last;
    }

    private parsedStatusHasFinalStandardAssistantMessage(parsed: any): boolean {
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const last = [...messages].reverse().find((m: any) => {
            if (!m || m.role !== 'assistant') return false;
            if (typeof m.content !== 'string' || !m.content.trim()) return false;
            const kind = typeof m.kind === 'string' && m.kind.trim() ? m.kind.trim() : 'standard';
            return kind === 'standard' && m.meta?.streaming !== true;
        });
        return !!last;
    }

    private recordTrace(type: string, payload: Record<string, any> = {}): void {
        const entry: CliTraceEntry = {
            id: ++this.traceSeq,
            at: Date.now(),
            type,
            status: this.currentStatus,
            isWaitingForResponse: this.isWaitingForResponse,
            activeModal: this.activeModal ? { message: this.activeModal.message, buttons: [...this.activeModal.buttons] } : null,
            payload,
        };
        this.traceEntries.push(entry);
        if (this.traceEntries.length > MAX_TRACE_ENTRIES) {
            this.traceEntries.splice(0, this.traceEntries.length - MAX_TRACE_ENTRIES);
        }
    }
}
