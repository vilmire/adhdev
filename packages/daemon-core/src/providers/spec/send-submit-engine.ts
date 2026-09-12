/**
 * SendSubmitEngine — the send/queue/submit machinery of a spec-driven CLI
 * session, extracted from FsmDriver.
 *
 * ── Why this is its own module ────────────────────────────────────────────
 * `fsm-driver.ts` crossed the 2,400-line file-size gate. This block is the
 * natural seam: everything here answers one question — "this body needs to
 * reach the CLI's composer; when and how is it written?" — and it is almost
 * entirely self-contained. It owns all eleven pieces of send state (the
 * pendingSends FIFO, the in-flight latch, the duplicate-gate hashes, the drain
 * reservation, and every write/submit timer) and borrows only a small read-only
 * view of the driver (see DriverHost).
 *
 * The FSM engine proper keeps what is genuinely its own: which node we are in,
 * how transitions fire, and `currentStatus()` — which this module CONSUMES as a
 * gate but must never compute, because a second opinion about whether the
 * session is idle is exactly the class of bug the SEND-OVERLAP work removed.
 *
 * ★ This was NOT a pure move. The methods are stateful and were rewritten to
 * read host-owned values (`adapter`, `spec`, `opts`, `readySeenOnce`,
 * `lastPtyDataAt`, `currentStateId`, `specTag()`, `currentStatus()`) through
 * `this.host` instead of `this`. Behaviour is unchanged — no gate was widened,
 * no timing constant altered, no ordering rearranged — and the guards that pin
 * this behaviour live in
 * test/providers/spec/driver-send-overlap-gate.test.ts,
 * test/providers/spec/driver-win32-submit.test.ts and
 * test/commands/send-now-agent-queue-split-write.test.ts.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────
 * `snapshotWithScrollback()` stayed on FsmDriver: it is a bare adapter
 * passthrough with no send state, and moving it would have made the host
 * interface wider for nothing.
 */
'use strict';

import { LOG } from '../../logging/logger.js';
import type { CliSpecV4 } from './fsm-types.js';
import type { TerminalAdapter } from './adapter.js';
import {
    WIN32_PTY_WRITE_CHUNK_CHARS,
    WIN32_PTY_WRITE_CHUNK_GAP_MS,
} from '../../cli-adapters/pty-write-chunking.js';
import {
    BRACKETED_PASTE_OPEN,
    BRACKETED_PASTE_CLOSE,
    WIN32_BRACKETED_PASTE_OPEN,
    WIN32_BRACKETED_PASTE_CLOSE,
    WIN32_SOFT_NEWLINE,
    chunkPreservingSurrogates,
    normalizeForEcho,
    resolveSubmitDelayMs,
    resolveWin32SubmitMode,
    shouldUseVerifiedSubmit,
    MID_GENERATION_SUBMIT_MIN_GAP_MS,
    type QueuedWriteOutcome,
} from './submit-policy.js';
import {
    hashSendText,
    DUPLICATE_RESEND_WINDOW_MS,
    SEND_IN_FLIGHT_MAX_MS,
    WIN32_SUBMIT_RESEND_GAP_MS,
    WIN32_SUBMIT_MAX_RESENDS,
    WIN32_SUBMIT_SETTLE_MS,
    WIN32_SUBMIT_SETTLE_POLL_MS,
    WIN32_ECHO_PROBE_CHARS,
    WIN32_ECHO_MAX_WAIT_MS,
} from './submit-policy.js';
import type { SendDisposition } from './submit-policy.js';

// ── send_message serialization (SEND-OVERLAP) ────────────────────────────────
//
// Moved here with the code it describes when this engine was extracted from
// fsm-driver.ts; it is the reason every gate below exists.
//
// Live defect (2026-08-10, antigravity/darwin): one coordinator-side enqueue of a
// ~1.5KB task arrived in the worker transcript as TWO user bubbles 8.5s apart —
// the second one CORRUPTED, missing ~90 chars out of its MIDDLE while head and
// tail survived. That signature is an interleave, not an overflow: a second body
// was written into the composer while the first turn was still being consumed, so
// the two writes braided.
//
// Root cause: handleSendMessage gated only on `readySeenOnce`, a ONE-SHOT latch.
// Once the machine had ever been ready, EVERY later send went straight to the PTY
// without consulting the current FSM state — so a resend landing mid-turn was
// written on top of a `generating` turn. The pre-write duplicate gate that should
// have absorbed the resend (isRecentDuplicateSend in chat-commands-write.ts) has a
// 1.2s window, and the only 60s-window dedup (recordAcknowledgedUserInput) runs
// AFTER the PTY write and merely collapses the display bubble. The observed 8.5s
// gap falls in the hole between the two.
//
// The fix is state-gated serialization, mirroring what the legacy
// provider-cli-adapter already does with pendingOutboundQueue + ptyWriteChain:
// a send that arrives while the machine is busy/approval, or while a previous
// send is still in flight, is QUEUED (never written concurrently) and drained
// when the machine returns to idle.

/**
 * The slice of FsmDriver this engine reads.
 *
 * Deliberately minimal and READ-ONLY apart from the adapter writes: every field
 * here is owned and maintained by the driver, and widening it is how an
 * extracted module quietly grows back into the class it came from. If the
 * engine ever needs to CHANGE driver state, that is a signal the seam is in the
 * wrong place — not a reason to add a setter.
 */
export interface DriverHost {
    /** The PTY/terminal the body is ultimately written to. */
    readonly adapter: TerminalAdapter;
    /** Resolved spec — `send_message` (submit key, delays) is what matters here. */
    readonly spec: CliSpecV4;
    /** Driver options; only `manifestSendDelayMs` is consulted. */
    readonly opts: { manifestSendDelayMs?: number };
    /** True once the machine has reached a ready state at least once. The
     *  first-send gate; never write a body before it. */
    readonly readySeenOnce: boolean;
    /** Wall clock of the last PTY output chunk, for the win32 settle-gate. */
    readonly lastPtyDataAt: number;
    /** Current FSM node id — used only for log context. */
    readonly currentStateId: string;
    /** Log tag identifying the spec/session. */
    specTag(): string;
    /**
     * ★ The authority on whether the session is idle / generating / at an
     * approval modal. The engine GATES on this and must never compute its own
     * answer: two opinions about the same terminal is the SEND-OVERLAP defect.
     */
    currentStatus(): 'idle' | 'generating' | 'approval';
}

export class SendSubmitEngine {
    /** Queued send bodies. `bracketedPaste` rides along so a queued image
     *  prompt keeps its paste-wrapped delivery when drained later. */
    private pendingSends: { text: string; bracketedPaste?: boolean }[] = [];
    /** True while a send is written but the FSM has not yet left idle, i.e. the
     *  composer is mid-submit. Blocks a second send from overwriting the first
     *  before the CLI has consumed it (see handleSendMessage). */
    private sendInFlight = false;
    /** Wall-clock (ms) the in-flight send was written. Bounds sendInFlight so a
     *  send the CLI never visibly consumed cannot wedge the queue forever. */
    private sendInFlightAt = 0;
    /** SEND-NOW-WRONG-ITEM: wall clock until which the autonomous FIFO drain is
     *  suspended, or 0 when it is free to run. See reserveDrain(). */
    private drainReservedUntil = 0;
    /** Content hash → wall-clock of the last PTY write, for the pre-write
     *  duplicate gate (see isDuplicateResend). */
    private recentSendHashes = new Map<string, number>();
    /** Pending queued-send drain timer, tracked so shutdown() can cancel it and
     *  a torn-down driver never writes a queued body into a dead PTY. */
    private pendingSendDrainTimer: ReturnType<typeof setTimeout> | null = null;
    /** SUBMIT-SILENT-FAILURE latch — see lastSubmitUnconfirmed(). */
    private submitUnconfirmed = false;
    /** Most recent win32 body write, for the submit settle-gate. */
    private lastWin32WriteAt = 0;
    private win32SubmitTimer: ReturnType<typeof setTimeout> | null = null;
    private win32WriteTimer: ReturnType<typeof setTimeout> | null = null;
    private plainSubmitTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly host: DriverHost) {}

    /** Number of bodies still parked, for shutdown logging. */
    get queueDepth(): number { return this.pendingSends.length; }

    /** Byte lengths of the parked bodies, for the shutdown discard log. */
    queuedLengths(): number[] { return this.pendingSends.map(s => s.text.length); }

    /** Drop every parked body. Called only from FsmDriver.shutdown(), which logs
     *  the discard loudly first — these bodies were never written. */
    discardQueued(): void { this.pendingSends.length = 0; }

    /** Cancel every armed write/submit timer. Called from FsmDriver.shutdown()
     *  so a torn-down driver never fires a CR into a dead PTY. */
    cancelTimers(): void {
        if (this.win32SubmitTimer) { clearTimeout(this.win32SubmitTimer); this.win32SubmitTimer = null; }
        if (this.win32WriteTimer) { clearTimeout(this.win32WriteTimer); this.win32WriteTimer = null; }
        if (this.plainSubmitTimer) { clearTimeout(this.plainSubmitTimer); this.plainSubmitTimer = null; }
        if (this.pendingSendDrainTimer) { clearTimeout(this.pendingSendDrainTimer); this.pendingSendDrainTimer = null; }
    }

    /** SEND-NOW-AGENT-QUEUE: see ISpecDriver.sendMessageDuringGeneration. */
    sendMessageDuringGeneration(text: string, bracketedPaste?: boolean): QueuedWriteOutcome {
        // ★ win32 first, before any state is read, so the refused platform can
        // never reach a write regardless of what the FSM believes. The delayed
        // lone CR that makes this work on POSIX is the same shape ConPTY absorbs
        // as a literal newline (see writeWin32Body / scheduleVerifiedSubmit), and
        // no win32 machine was available to re-measure it.
        if (process.platform === 'win32') {
            LOG.info('FsmDriver', `[${this.host.specTag()}] mid-generation send refused — win32 split write unverified`);
            return { accepted: false, reason: 'platform_unsupported' };
        }
        if (!this.host.readySeenOnce) return { accepted: false, reason: 'not_ready' };
        // Only a GENERATING session belongs here. At idle the ordinary path is
        // strictly better (a real turn, answered now), and an approval modal is
        // not a composer at all — writing a prompt into it would answer the modal
        // with garbage. `currentStatus()` returns 'approval' for a parked session,
        // so both non-generating cases are refused by this one check.
        if (this.host.currentStatus() !== 'generating') return { accepted: false, reason: 'not_generating' };
        // SEND-OVERLAP still applies. The gate this method bypasses is the IDLE
        // requirement, not the in-flight latch: a body written on top of another
        // body's unconsumed composer line braids the two, which is the same
        // defect whether or not the agent is generating.
        if (this.isSendInFlight()) return { accepted: false, reason: 'send_in_flight' };
        if (this.isDuplicateResend(text)) {
            LOG.info('FsmDriver', `[${this.host.specTag()}] mid-generation send suppressed — duplicate resend (len=${text.length})`);
            return { accepted: false, reason: 'duplicate' };
        }

        LOG.info(
            'FsmDriver',
            `[${this.host.specTag()}] mid-generation split write — agent input queue (len=${text.length})`,
        );
        // ★ The duplicate-gate record is written, but the in-flight latch is NOT
        // taken. `sendInFlight` means "the composer holds a body whose submit the
        // FSM has not yet confirmed by LEAVING idle" — and this session is not at
        // idle and will not become idle on account of this write. Taking the latch
        // would therefore hold it until its SEND_IN_FLIGHT_MAX_MS self-expiry and
        // stall the ordinary FIFO drain for that whole window, blocking the very
        // queue the owner is trying to get ahead of. drainPendingSends' own
        // `status !== 'idle'` gate already prevents a concurrent write here.
        this.recentSendHashes.set(hashSendText(text), Date.now());
        this.actuallySendMessage(text, bracketedPaste, { midGeneration: true });
        return { accepted: true };
    }

    /** SEND-NOW-WRONG-ITEM: see ISpecDriver.reserveDrain. */
    reserveDrain(ttlMs: number): void {
        this.drainReservedUntil = Date.now() + Math.max(0, ttlMs);
        LOG.info(
            'FsmDriver',
            `[${this.host.specTag()}] FIFO drain reserved for ${ttlMs}ms (queued=${this.pendingSends.length})`,
        );
    }

    /** SEND-NOW-WRONG-ITEM: see ISpecDriver.releaseDrain. */
    releaseDrain(): void {
        if (this.drainReservedUntil === 0) return;
        this.drainReservedUntil = 0;
        // The reservation was held across a busy→idle transition, so the frame
        // that would normally have drained is already gone. Drain now rather
        // than waiting for a PTY frame a quiet CLI may never produce — the same
        // hazard drainPendingSends' own call sites document.
        this.drainPendingSends();
    }

    /** True while an out-of-band caller still owns the next write. The TTL is a
     *  self-heal: a caller that dies mid-sequence must not wedge the queue. */
    private isDrainReserved(): boolean {
        if (this.drainReservedUntil === 0) return false;
        if (Date.now() >= this.drainReservedUntil) {
            LOG.warn('FsmDriver', `[${this.host.specTag()}] drain reservation expired — releasing`);
            this.drainReservedUntil = 0;
            return false;
        }
        return true;
    }

    /** SEND-NOW-DOUBLE-SEND: see ISpecDriver.claimQueuedSends. */
    claimQueuedSends(text: string): number {
        const before = this.pendingSends.length;
        if (before === 0) return 0;
        this.pendingSends = this.pendingSends.filter(s => s.text !== text);
        const claimed = before - this.pendingSends.length;
        if (claimed > 0) {
            // Also clear the pre-write duplicate gate for this body. The claimer
            // is about to re-send the SAME text, and isDuplicateResend would
            // otherwise suppress it as a redelivery of the copy we just removed —
            // turning the claim into silent data loss instead of a fix.
            this.recentSendHashes.delete(hashSendText(text));
            LOG.info(
                'FsmDriver',
                `[${this.host.specTag()}] claimed ${claimed} queued send(s) for out-of-band delivery `
                + `(len=${text.length}, remaining=${this.pendingSends.length})`,
            );
        }
        return claimed;
    }

    /**
     * SEND-OVERLAP gate. A send may only go straight to the PTY when the machine
     * is genuinely able to accept one: it has been ready at least once, it is
     * sitting at an idle prompt right now, and no earlier send is still in flight.
     * Anything else is queued and drained by drainPendingSends() when the machine
     * next returns to idle.
     *
     * Before the fix this consulted ONLY `readySeenOnce` — a one-shot latch — so
     * every send after the first ignored the live FSM state and could be written
     * on top of a still-generating turn, braiding the two bodies in the composer
     * (see the SEND-OVERLAP note above the constants).
     */
    handleSendMessage(text: string, bracketedPaste?: boolean): SendDisposition {
        // A resend of text we are already in the middle of delivering is dropped
        // outright rather than queued: queueing it would just submit the same
        // prompt a second time once the turn ends, which is the duplicate-bubble
        // symptom in a slower disguise.
        if (this.isDuplicateResend(text)) {
            LOG.info('FsmDriver', `[${this.host.specTag()}] send suppressed — duplicate resend within ${DUPLICATE_RESEND_WINDOW_MS}ms (len=${text.length})`);
            return { status: 'duplicate' };
        }
        if (!this.canSendNow()) {
            this.pendingSends.push({ text, bracketedPaste });
            const reason = this.sendBlockedReason();
            LOG.info(
                'FsmDriver',
                `[${this.host.specTag()}] send queued — ${reason} (len=${text.length}, queued=${this.pendingSends.length})`,
            );
            return { status: 'queued', queueDepth: this.pendingSends.length, reason };
        }
        this.beginSend(text, bracketedPaste);
        return { status: 'delivered' };
    }

    /** True when a send can be written to the PTY right now. */
    private canSendNow(): boolean {
        if (!this.host.readySeenOnce) return false;
        if (this.isSendInFlight()) return false;
        return this.host.currentStatus() === 'idle';
    }

    /** Human-readable reason a send was queued — logged, never used for control flow. */
    private sendBlockedReason(): string {
        if (!this.host.readySeenOnce) return 'machine not ready yet';
        if (this.isSendInFlight()) return `previous send still in flight (${Date.now() - this.sendInFlightAt}ms)`;
        return `machine is ${this.host.currentStatus()}`;
    }

    /** In-flight latch with its self-expiry applied, so a send the CLI never
     *  visibly consumed cannot wedge the queue permanently. */
    private isSendInFlight(): boolean {
        if (!this.sendInFlight) return false;
        if (Date.now() - this.sendInFlightAt > SEND_IN_FLIGHT_MAX_MS) {
            LOG.warn('FsmDriver', `[${this.host.specTag()}] in-flight send latch expired after ${SEND_IN_FLIGHT_MAX_MS}ms — releasing`);
            this.sendInFlight = false;
            return false;
        }
        return true;
    }

    /**
     * Pre-write duplicate gate. Suppresses a repeat of text that was written to
     * the PTY within DUPLICATE_RESEND_WINDOW_MS *while that text is still being
     * processed* — i.e. a send is in flight or the machine has not returned to
     * idle. A genuine repeat typed at an idle prompt is NOT suppressed: sending
     * "continue" twice in a row is ordinary use, and silently swallowing the
     * second one would be a worse defect than the one being fixed.
     */
    private isDuplicateResend(text: string): boolean {
        const now = Date.now();
        const key = hashSendText(text);
        for (const [candidate, at] of this.recentSendHashes) {
            if (now - at > DUPLICATE_RESEND_WINDOW_MS) this.recentSendHashes.delete(candidate);
        }
        const previous = this.recentSendHashes.get(key);
        if (previous === undefined) return false;
        if (now - previous > DUPLICATE_RESEND_WINDOW_MS) return false;
        // Same text, inside the window. Only a collision with work still in
        // progress is a redelivery; at a settled idle prompt it is a new turn.
        const stillProcessing = this.isSendInFlight()
            || this.host.currentStatus() !== 'idle'
            || this.pendingSends.length > 0;
        return stillProcessing;
    }

    /** Mark a send as in flight, record it for the duplicate gate, and write it. */
    private beginSend(text: string, bracketedPaste?: boolean): void {
        this.sendInFlight = true;
        this.sendInFlightAt = Date.now();
        this.recentSendHashes.set(hashSendText(text), this.sendInFlightAt);
        this.actuallySendMessage(text, bracketedPaste);
    }

    /**
     * Release the in-flight latch and write the next queued send, if the machine
     * can take one. Called from the FSM evaluation loop, so it runs on the same
     * frame the machine reaches idle — the queue never waits for an extra PTY
     * frame that a quiet CLI would never produce (the same hazard maybeMarkReady
     * documents for the very first message).
     */
    drainPendingSends(): void {
        if (!this.host.readySeenOnce) return;
        const status = this.host.currentStatus();
        // Leaving idle is the observable proof the CLI consumed the submit.
        if (this.sendInFlight && status !== 'idle') {
            this.sendInFlight = false;
        }
        if (status !== 'idle') return;
        // SEND-NOW-WRONG-ITEM: an interrupt caller owns the next write. Draining
        // here would hand the idle prompt to whatever else is queued and re-park
        // the body the owner actually pressed — see reserveDrain().
        if (this.isDrainReserved()) {
            LOG.info(
                'FsmDriver',
                `[${this.host.specTag()}] drain held — an out-of-band send owns the next write (queued=${this.pendingSends.length})`,
            );
            return;
        }
        if (this.isSendInFlight()) return;
        if (this.pendingSends.length === 0) return;
        const next = this.pendingSends.shift()!;
        LOG.info('FsmDriver', `[${this.host.specTag()}] draining queued send (len=${next.text.length}, remaining=${this.pendingSends.length})`);
        // Small delay for parity with the ready-gate drain: it lets the prompt
        // frame settle before the body lands.
        if (this.pendingSendDrainTimer) clearTimeout(this.pendingSendDrainTimer);
        this.pendingSendDrainTimer = setTimeout(() => {
            this.pendingSendDrainTimer = null;
            this.beginSend(next.text, next.bracketedPaste);
        }, 50);
        // Hold the latch immediately so a second drain on the very next frame
        // cannot write a second body into the same composer line.
        this.sendInFlight = true;
        this.sendInFlightAt = Date.now();
    }

    /** SUBMIT-SILENT-FAILURE: true when the most recent send exhausted its submit
     *  resend budget without the agent ever leaving the composer. A caller seeing
     *  this should treat an apparent 'generating' status as untrustworthy. */
    lastSubmitUnconfirmed(): boolean {
        return this.submitUnconfirmed;
    }

    /** ENTER-LOSS layer ①: schedule the short-body / perChar submit key through a
     *  tracked timer so the shutdown drain gate can see it and shutdown() can
     *  cancel it instead of letting it fire into a killed PTY. */
    private schedulePlainSubmit(submitKey: string, delayMs: number): void {
        if (this.plainSubmitTimer) clearTimeout(this.plainSubmitTimer);
        this.plainSubmitTimer = setTimeout(() => {
            this.plainSubmitTimer = null;
            this.host.adapter.send_keys(submitKey);
        }, delayMs);
    }

    /** ENTER-LOSS layer ① — see ISpecDriver.hasInFlightSubmit. A submit is in
     *  flight while any of the body-write / CR-hold / CR-resend timers is armed:
     *  the body (or part of it) is in the composer and its submit key has not yet
     *  been confirmed. Deliberately does NOT include `pendingSends` (bodies never
     *  written yet — the composer holds nothing of theirs; they are discarded with
     *  their own loud log by shutdown()) nor `sendInFlight` alone (that latch stays
     *  set until the FSM *leaves* idle, i.e. after a successful CR — waiting on it
     *  would hold shutdown for a whole turn boundary, not a submit). */
    hasInFlightSubmit(): boolean {
        return this.win32SubmitTimer !== null
            || this.win32WriteTimer !== null
            || this.plainSubmitTimer !== null
            || this.pendingSendDrainTimer !== null;
    }

    /** ENTER-LOSS layer ① — see ISpecDriver.whenSubmitDrained. Polling rather
     *  than callback-wiring: the four timers above re-arm each other across
     *  several phases (write → echo-gate → resend net) and a poll is the only
     *  join point that needs no knowledge of which phase is active. */
    whenSubmitDrained(timeoutMs: number): Promise<boolean> {
        if (!this.hasInFlightSubmit()) return Promise.resolve(true);
        const deadline = Date.now() + Math.max(0, timeoutMs);
        return new Promise((resolve) => {
            const poll = (): void => {
                if (!this.hasInFlightSubmit()) { resolve(true); return; }
                if (Date.now() >= deadline) { resolve(false); return; }
                setTimeout(poll, 100);
            };
            setTimeout(poll, 100);
        });
    }


    private actuallySendMessage(text: string, bracketedPaste?: boolean, opts?: { midGeneration?: boolean }): void {
        const sm = this.host.spec.send_message;
        this.submitUnconfirmed = false;
        const perChar = sm.delay_ms_per_char ?? 0;
        const beforeSubmit = resolveSubmitDelayMs(sm.delay_ms_before_submit, text, this.host.opts.manifestSendDelayMs);

        // SEND-NOW-AGENT-QUEUE: a mid-generation write takes the PLAIN split path
        // — body write, timed gap, submit key — and never the echo-verified one,
        // for two reasons that both come from the session being busy:
        //
        //  (a) The echo-gate releases its CR only once the screen has been QUIET
        //      for WIN32_SUBMIT_SETTLE_MS. A generating agent streams output
        //      continuously, so that condition is not merely slow to satisfy —
        //      it is structurally false for the whole turn. The CR would be held
        //      until the WIN32_ECHO_MAX_WAIT_MS (20s) blind-fire backstop, which
        //      for a "Send now" press is indistinguishable from the button doing
        //      nothing.
        //  (b) The verified-resend net re-fires the submit key while the FSM
        //      reads 'idle'. Here it never does, so the net cannot help anyway,
        //      and its SUBMIT-NOT-CONFIRMED error branch would be evaluated
        //      against a status that means something else entirely.
        //
        // The plain path is also exactly the shape that was measured to work:
        // send_keys(text), a >=SUBMIT_DELAY_FLOOR_MS gap, send_keys(submit_key).
        // perChar typing simulation is skipped — it would stretch the body write
        // across the very turn boundary we are racing.
        if (opts?.midGeneration) {
            this.host.adapter.send_keys(text);
            // ★ The CR MUST be a separate, later write. An atomic `text + '\r'`
            // is the retired force-inject shape and is NOT consumed mid-turn
            // (see ISpecDriver.sendMessageDuringGeneration for the A/B).
            // schedulePlainSubmit is used unconditionally — never the
            // `beforeSubmit === 0` immediate branch below — so the gap always
            // exists even if a spec declares no delay.
            this.schedulePlainSubmit(sm.submit_key, Math.max(beforeSubmit, MID_GENERATION_SUBMIT_MIN_GAP_MS));
            return;
        }

        // POSIX-IMAGE-PASTE (multi-image attachment loss): a body carrying
        // materialized image paths is wrapped in a bracketed-paste region when the
        // spec opts in (send_message.posix_bracketed_paste_for_images). Live A/B
        // against claude-cli v2.1.220 (2026-08-26) showed the raw-write path loses
        // every image but the last: the CLI only converts image paths to real
        // attachments when a single input burst clears its ~800-char
        // heuristic-paste threshold, so a short body attaches NONE and a body split
        // across pipe chunks attaches only the burst's tail. The bracketed-paste
        // region routes the whole body through the CLI's real paste handler, which
        // attaches EVERY image path in it (verified: imagePasteIds [1, 2] on the
        // recorded user turn). The echo-gate is skipped for the wrapped body: the
        // composer renders paste chips ([Image #N]) instead of the literal text, so
        // the raw body can never echo and the gate would stall to its blind-fire
        // backstop. The verified-resend net still runs, covering a CR that lands
        // while the CLI's async image ingestion is still in flight.
        const wrapInPaste = process.platform !== 'win32'
            && bracketedPaste === true
            && sm.posix_bracketed_paste_for_images === true;
        if (wrapInPaste) {
            this.host.adapter.send_keys(`${BRACKETED_PASTE_OPEN}${text}${BRACKETED_PASTE_CLOSE}`);
            this.markBodyWrite();
            this.scheduleVerifiedSubmit(sm.submit_key, beforeSubmit, text, { skipEchoGate: true });
            return;
        }

        // win32 ConPTY submit: the text and the submit key (CR) must NOT be
        // combined into one PTY write — Ink-based TUIs (claude-cli) treat a
        // single write that carries text + a trailing CR as a bracketed/multi-line
        // paste and absorb the CR as a literal newline. So we write the text on
        // its own, then resend the submit key on a fixed cadence, VERIFYING after
        // each that the agent actually left the idle composer (status flipped away
        // from 'idle'). This handles the nondeterministic multiline
        // paste-accumulation window where a variable number of CRs is needed; a
        // fixed double-CR fails for multiline (see WIN32_SUBMIT_* above). perChar
        // typing simulation is skipped on win32; correctness of submission wins
        // over the typing visual there.
        if (process.platform === 'win32') {
            this.writeWin32Body(text);
            this.scheduleVerifiedSubmit(sm.submit_key, beforeSubmit, text);
            return;
        }

        // POSIX-ENTER-DROP: a large body takes the same echo-verified submit the
        // win32 path uses. The body itself is written exactly as before (one write,
        // no bracketed paste — POSIX composers do not need it and wrapping would be
        // an unvalidated behaviour change); only the CR is now effect-verified
        // instead of blind-timed. Short bodies keep the original immediate path.
        if (perChar === 0 && shouldUseVerifiedSubmit(text)) {
            this.host.adapter.send_keys(text);
            this.markBodyWrite();
            this.scheduleVerifiedSubmit(sm.submit_key, beforeSubmit, text);
            return;
        }

        if (perChar === 0) {
            this.host.adapter.send_keys(text);
            if (beforeSubmit > 0) this.schedulePlainSubmit(sm.submit_key, beforeSubmit);
            else this.host.adapter.send_keys(sm.submit_key);
            return;
        }
        let i = 0;
        const iv = setInterval(() => {
            if (i >= text.length) {
                clearInterval(iv);
                this.schedulePlainSubmit(sm.submit_key, beforeSubmit);
                return;
            }
            this.host.adapter.send_keys(text[i]);
            i += 1;
        }, perChar);
    }


    /** Record a win32 body write so the settle-gate counts it as input activity
     *  even before the echo arrives. */
    private markBodyWrite(): void {
        this.lastWin32WriteAt = Date.now();
    }

    /** Most recent win32 input activity — a write we issued OR a PTY output chunk
     *  (echo). The submit settle-gate waits for this to go quiet. */
    private lastWin32InputActivityAt(): number {
        return Math.max(this.host.lastPtyDataAt, this.lastWin32WriteAt);
    }

    /**
     * Write the message body to the PTY for win32, paced into bounded chunks. A
     * single unbounded ConPTY write can overflow the input pipe and drop leading
     * bytes; splitting it with a short inter-chunk gap keeps the console input
     * buffer from overflowing. Small bodies still go out in a single write. Each
     * write advances lastWin32WriteAt so the submit settle-gate keeps waiting until
     * the final segment is out and echoed.
     *
     * FIX-B-v2: a body that contains an embedded newline cannot be written raw —
     * on the real win32 Ink/ConPTY composer each '\n' SUBMITS the preceding line as
     * its own entry, truncating the prompt to only the tail fragment. So a
     * newline-bearing body is rewritten so its embedded newlines never submit:
     *   - 'paste' (default): wrap the body in a bracketed-paste (ESC[200~ … ESC[201~)
     *     — the composer takes the whole thing, newlines and all, as pasted text.
     *   - 'soft_newline': replace each embedded newline with a non-submitting
     *     Shift+Enter (CSI-u) so the body is typed as one multi-line entry.
     * The trailing submit CR is NOT written here — it stays separate and is fired
     * later by scheduleVerifiedSubmit (concern (A)). The bracketed-paste markers are
     * written as their own atomic segments (never chunked), so chunking can never
     * split ESC[200~ / ESC[201~ mid-sequence regardless of body length.
     */
    private writeWin32Body(text: string): void {
        if (this.win32WriteTimer) { clearTimeout(this.win32WriteTimer); this.win32WriteTimer = null; }

        const hasNewline = /\r?\n/.test(text);
        const mode = resolveWin32SubmitMode();

        // Build the ordered list of segments to write. Bracketed-paste markers are
        // their OWN segments so chunking only ever splits the body, never a marker.
        let segments: string[];
        if (!hasNewline) {
            // Single-line: unchanged behaviour — just (chunk and) write the body.
            segments = chunkPreservingSurrogates(text, WIN32_PTY_WRITE_CHUNK_CHARS);
        } else if (mode === 'soft_newline') {
            // Rewrite embedded newlines as non-submitting soft-newlines, THEN chunk.
            // The soft-newline sequence (ESC[27;2;13~) contains no '\n', so it is
            // never re-interpreted as a submit, and chunking it like ordinary text is
            // safe (a split mid-sequence is avoided below by chunking the whole
            // rewritten string — see the marker-safety note for paste; for soft_newline
            // the only ESC seq is short and self-contained, so we keep it simple and
            // chunk the rewritten body, accepting that the 1024-char chunk boundary is
            // astronomically unlikely to land inside a 9-byte CSI-u seq — and even if
            // it did, ConPTY reassembles the byte stream, the composer parses the full
            // sequence across the boundary).
            const rewritten = text.split(/\r?\n/).join(WIN32_SOFT_NEWLINE);
            segments = chunkPreservingSurrogates(rewritten, WIN32_PTY_WRITE_CHUNK_CHARS);
        } else {
            // paste: [OPEN marker] [body chunks…] [CLOSE marker]. Markers are atomic
            // segments — never merged with body bytes — so they cannot be split.
            segments = [
                WIN32_BRACKETED_PASTE_OPEN,
                ...chunkPreservingSurrogates(text, WIN32_PTY_WRITE_CHUNK_CHARS),
                WIN32_BRACKETED_PASTE_CLOSE,
            ];
        }

        if (segments.length <= 1) {
            this.markBodyWrite();
            this.host.adapter.send_keys(segments[0] ?? text);
            return;
        }
        let idx = 0;
        const writeNext = (): void => {
            this.win32WriteTimer = null;
            if (idx >= segments.length) return;
            this.markBodyWrite();
            this.host.adapter.send_keys(segments[idx]);
            idx += 1;
            if (idx < segments.length) {
                this.win32WriteTimer = setTimeout(writeNext, WIN32_PTY_WRITE_CHUNK_GAP_MS);
            }
        };
        writeNext();
    }

    /**
     * win32 submit. Two phases:
     *
     *  Phase 1 (echo-gate): hold the first CR until the body text is CONFIRMED in the
     *  composer (its whitespace-collapsed tail appears in the rendered screen) AND the
     *  PTY output is then quiet for WIN32_SUBMIT_SETTLE_MS (the full, possibly multi-KB
     *  / multiline body has finished arriving). This replaces a bare output-quiet
     *  settle: an early write that races claude's boot is buffered, not dropped, so the
     *  screen can go quiet with the body NOT YET in the composer — a quiet-only gate
     *  would then fire a CR into an empty composer (no submit). Waiting on the echo
     *  closes that. Honors an initial minimum delay and a generous WIN32_ECHO_MAX_WAIT_MS
     *  last-resort blind fire so a body that truly never confirms still submits (carried
     *  by phase 2) rather than hanging. A settled session echoes immediately → no delay.
     *
     *  Phase 2 (verified resend — unchanged): send the submit key, wait a gap, and
     *  if the FSM is still 'idle' (the CR was absorbed as a multiline-paste
     *  newline) resend, up to WIN32_SUBMIT_MAX_RESENDS. The first CR always fires
     *  (a stale/edge status never suppresses it); resends are gated on still being
     *  idle and stop the instant the agent leaves idle (submitted → generating /
     *  approval). This preserves the win32 lone-CR-swallow handling.
     */
    private scheduleVerifiedSubmit(submitKey: string, initialDelayMs: number, body: string, opts?: { skipEchoGate?: boolean }): void {
        if (this.win32SubmitTimer) { clearTimeout(this.win32SubmitTimer); this.win32SubmitTimer = null; }
        const startedAt = Date.now();

        // FULL-BODY echo confirmation. A tail-only probe (slice(-N)) was insufficient
        // for multi-line prompts: a multiline body echoes line-by-line, so its TAIL can
        // appear in the composer (and the screen settle) while the HEAD / middle is still
        // arriving. Releasing the first CR on the tail alone then submits a PARTIAL body:
        // the early CR commits whatever has accumulated and the remainder is lost, so only
        // the trailing segment survives (the cross-machine MAGI replica receiving only the
        // prompt's boilerplate suffix). We now require BOTH the head probe AND the tail
        // probe to be present in the echo before releasing the CR.
        //
        // Crucially, the head check runs against snapshotWithScrollback(), NOT the visible
        // viewport: a tall body scrolls its leading lines off-screen (the very reason the
        // original gate used the tail), so the head is only ever observable in the
        // scrollback-inclusive buffer. The tail check stays on the visible snapshot (the
        // cursor / body end is always on screen). Both present ⇒ the whole body, head
        // through tail, has echoed — not just its end with a still-streaming middle.
        // Single-line / short bodies have overlapping head and tail probes and the
        // scrollback buffer is a superset of the viewport, so behaviour is unchanged. The
        // WIN32_ECHO_MAX_WAIT_MS blind-fire backstop below still bounds the wait so a body
        // that never fully confirms cannot hang.
        const normBody = normalizeForEcho(body);
        const headProbe = normBody.slice(0, WIN32_ECHO_PROBE_CHARS);
        const tailProbe = normBody.slice(-WIN32_ECHO_PROBE_CHARS);
        const bodyEchoed = (): boolean => {
            if (!normBody) return true;
            // Tail on the visible viewport (cursor end is always on screen); head on the
            // scrollback-inclusive buffer (leading lines of a tall body scroll off-screen).
            const visible = normalizeForEcho(this.host.adapter.snapshot());
            if (!visible.includes(tailProbe)) return false;
            const full = normalizeForEcho(this.host.adapter.snapshotWithScrollback());
            return full.includes(headProbe);
        };

        const fire = (attempt: number): void => {
            this.win32SubmitTimer = null;
            this.host.adapter.send_keys(submitKey);
            if (attempt + 1 >= WIN32_SUBMIT_MAX_RESENDS) {
                // SUBMIT-SILENT-FAILURE detection. We have spent the entire resend
                // budget and the FSM never left 'idle' — the body is sitting unsent in
                // the composer. This is precisely the state that previously presented
                // to the coordinator as runtimeInputAck:true + status generating + zero
                // assistant output: work that looks in-flight but will never progress.
                // Say so loudly; a silent give-up is what made the live defect cost an
                // owner-side manual Enter to notice.
                if (this.host.currentStatus() === 'idle') {
                    this.submitUnconfirmed = true;
                    LOG.error(
                        'FsmDriver',
                        `[${this.host.specTag()}] SUBMIT NOT CONFIRMED after ${WIN32_SUBMIT_MAX_RESENDS} submit-key attempts ` +
                        `(len=${body.length}, echoed=${bodyEchoed()}, waited=${Date.now() - startedAt}ms). ` +
                        'The message is likely still sitting unsent in the composer — the agent is NOT working on it.',
                    );
                }
                return;
            }
            this.win32SubmitTimer = setTimeout(() => {
                // Left the idle composer → it submitted; stop resending.
                if (this.host.currentStatus() !== 'idle') {
                    this.win32SubmitTimer = null;
                    if (attempt > 0) {
                        LOG.warn('FsmDriver', `[${this.host.specTag()}] submit confirmed only after ${attempt + 1} attempts (len=${body.length})`);
                    }
                    return;
                }
                fire(attempt + 1);
            }, WIN32_SUBMIT_RESEND_GAP_MS);
        };

        // Echo-gate: hold the first CR until the body is CONFIRMED in the composer, not
        // merely until output goes quiet — a quiet screen with a not-yet-arrived body is
        // the exact empty-submit failure this replaces. The body is NOT re-written: on
        // the session-host IPC transport an early write is buffered, not dropped, so it
        // lands once claude's stdin reader wires up (just late on a slow/contended boot);
        // re-writing would risk a duplicated body when several buffered writes drain
        // together. So we simply WAIT for the echo. The hard upper bound only fires a
        // blind CR if the body never confirms at all (resend net carries it), set
        // generously so a slow boot still lands its body first.
        const waitForEcho = (): void => {
            this.win32SubmitTimer = null;
            const now = Date.now();
            const quietFor = now - this.lastWin32InputActivityAt();
            const waited = now - startedAt;
            const settled = quietFor >= WIN32_SUBMIT_SETTLE_MS;
            // skipEchoGate (POSIX bracketed-paste image bodies): the composer renders
            // paste chips instead of the literal body, so the body can never echo —
            // waiting on it would stall to the blind-fire backstop for no gain. The
            // initial delay still applies (first tick fires after initialDelayMs), and
            // the verified-resend net below carries a CR eaten mid-paste.
            // Default: body present in the composer AND output quiet (full body
            // arrived) → submit.
            if (opts?.skipEchoGate ? true : (bodyEchoed() && settled)) { fire(0); return; }
            // Last-resort blind fire so a body that truly never confirms cannot hang.
            if (waited >= WIN32_ECHO_MAX_WAIT_MS) {
                LOG.warn(
                    'FsmDriver',
                    `[${this.host.specTag()}] body never confirmed in composer after ${waited}ms (len=${body.length}) — ` +
                    'firing submit key blind; resend net will verify.',
                );
                fire(0);
                return;
            }
            this.win32SubmitTimer = setTimeout(waitForEcho, WIN32_SUBMIT_SETTLE_POLL_MS);
        };

        if (initialDelayMs > 0) this.win32SubmitTimer = setTimeout(waitForEcho, initialDelayMs);
        else waitForEcho();
    }
}
