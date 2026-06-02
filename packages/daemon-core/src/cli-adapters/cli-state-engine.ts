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
}

// ─── Constants ─────────────────────────────────────────────────────────────

const SCRIPT_STATUS_DEBOUNCE_MS = 3000;
const MAX_FINISH_RETRIES = 2;
const FINISH_RETRY_DELAY_MS = 300;
const MAX_TRACE_ENTRIES = 250;
const APPROVAL_EXIT_TIMEOUT_MS = 60_000;
const IDLE_CONFIRMATION_GRACE_MS = 2_000;

// ─── Engine ────────────────────────────────────────────────────────────────

export class CliStateEngine {
    // ── Status ───────────────────────────────────────
    currentStatus: CliSessionStatus['status'] = 'starting';
    isWaitingForResponse = false;
    currentTurnScope: TurnParseScope | null = null;
    activeModal: { message: string; buttons: string[] } | null = null;

    // ── Approval ─────────────────────────────────────
    lastApprovalResolvedAt = 0;
    lastResolvedModalMessage = '';
    /**
     * When the engine previously held a modal but the latest parse failed
     * to extract one, we record the timestamp here and only drop the modal
     * after the configured `approvalCooldown` to avoid flapping between
     * waiting_approval and generating on every Claude TUI redraw — that
     * flapping is what fed auto-approve a fresh modal signature on each
     * paint and made the engine type "1" repeatedly into the prompt.
     */
    modalLostAt = 0;
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
        this.responseEpoch += 1;
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
                    this.activeModal = parsedModal;
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
        if (inCooldown && currentModalMessage === this.lastResolvedModalMessage) return;

        this.clearIdleFinishCandidate('resolve_modal');
        this.recordTrace('resolve_modal', { buttonIndex, activeModal: modal });
        this.activeModal = null;
        this.lastApprovalResolvedAt = Date.now();
        this.lastResolvedModalMessage = currentModalMessage;
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
    }

    clearIdleFinishCandidate(reason: string): void {
        if (!this.idleFinishCandidate) return;
        this.recordTrace('idle_candidate_reset', { reason, candidate: this.idleFinishCandidate });
        this.idleFinishCandidate = null;
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
        const ctx: SettledEvalContext = { now, modal, status, parsedMessages, lastParsedAssistant, parsedStatus: parsedStatus || null, prevStatus };

        if (!this.applyPendingScriptStatusDebounce(ctx)) return;

        const recentInteractiveActivity = this.hasRecentInteractiveActivity(snap, now);
        LOG.debug(
            'CLI',
            `[${this.provider.type}] settled diagnostics prompt=${JSON.stringify(this.currentTurnScope?.prompt || '').slice(0, 140)} status=${String(status || '')} parsedStatus=${String(parsedStatus || '')} parsedMsgCount=${parsedMessages.length} lastParsedAssistant=${JSON.stringify((lastParsedAssistant?.content || '').slice(0, 120)).slice(0, 160)} responseBuffer=${JSON.stringify((snap.responseBuffer || '').slice(0, 160)).slice(0, 220)}`
        );

        // recent_activity_hold protects an in-flight user turn from a false
        // idle blip. It must NOT fire during startup — when the adapter has
        // no currentTurnScope, there is no user turn to protect; the recent
        // activity is just the CLI painting its welcome screen. Firing here
        // produced the startup status flip the user reported
        // (generating → idle → generating → idle within the first few seconds
        // of claude-cli launch).
        const shouldHoldGenerating = status === 'idle'
            && this.isWaitingForResponse
            && !!this.currentTurnScope
            && !modal
            && recentInteractiveActivity
            && !(parsedStatus === 'idle' && !!lastParsedAssistant);

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
                        this.finishResponse();
                    }
                }, this.timeouts.generatingIdle);
            } else {
                this.setStatus('idle', reason);
            }
            this.callbacks.onStatusChange();
            return;
        }
        if (!inCooldown) {
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
                if (this.currentStatus === 'waiting_approval' && this.activeModal) {
                    const lostAt = this.modalLostAt || Date.now();
                    if (!this.modalLostAt) this.modalLostAt = lostAt;
                    if (Date.now() - lostAt >= this.timeouts.approvalCooldown) {
                        this.activeModal = null;
                        this.modalLostAt = 0;
                        this.setStatus('generating', 'approval_lost_modal');
                        this.callbacks.onStatusChange();
                    }
                }
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
                this.callbacks.onStatusChange();
            }
            if (this.idleTimeout) clearTimeout(this.idleTimeout);
            this.armApprovalExitTimeout();
        }
    }

    private applyGenerating(ctx: SettledEvalContext): void {
        const { modal, parsedMessages, lastParsedAssistant, parsedStatus, prevStatus } = ctx;
        this.clearIdleFinishCandidate('generating');
        // Cancel any pending grace-window idle transition. We have fresh
        // evidence the provider is still generating; the previous
        // finishResponse() was a paint blip, not a real completion.
        this.cancelPendingIdleFinish('generating_signal_returned');
        const snap = this.transport.getSnapshot();
        const effectiveScreenText = snap.screenText || snap.accumulatedBuffer;
        const noActiveTurn = !this.currentTurnScope;
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
        const idleReady = !modal && hasAssistantTurn && quietForMs >= idleQuietThresholdMs && screenStableMs >= idleFinishConfirmMs;
        const candidate = this.idleFinishCandidate;
        const candidateQuiet = !!candidate && candidate.responseEpoch === this.responseEpoch
            && candidate.lastOutputAt === snap.lastOutputAt
            && candidate.lastScreenChangeAt === snap.lastScreenChangeAt
            && assistantLength >= candidate.assistantLength
            && (now - candidate.armedAt) >= idleFinishConfirmMs;

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
                if (this.shouldDeferIdleTimeoutFinish()) return;
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
        const latestStatus = detectFn() || this.currentStatus;
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
        // Support both explicit flag and legacy codex-cli type check
        // Also check transport.cliType to support tests that patch adapter.cliType directly
        const effectiveType = this.transport.cliType ?? this.provider.type;
        const requiresFinalAssistant = !!this.provider.requiresFinalAssistantBeforeIdle
            || effectiveType === 'codex-cli';
        if (!requiresFinalAssistant) return false;
        if (!this.isWaitingForResponse || !this.currentTurnScope || this.hasActionableApproval()) return false;
        const parsedStatus = typeof parsed?.status === 'string' ? parsed.status.trim() : '';
        if (parsedStatus !== 'idle') return true;
        if (parsed?.activeModal || parsed?.modal) return true;
        return !this.parsedStatusHasFinalStandardAssistantMessage(parsed);
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
