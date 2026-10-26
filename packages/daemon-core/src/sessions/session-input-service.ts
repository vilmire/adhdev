import { assertMaintenanceAdmission, withMaintenanceAdmission } from '../maintenance/cooperative-gate.js';
import { isTrustedOwnerIngress } from '../commands/command-args.js';
import { evaluateNewWorkHold, formatNewWorkHeldMessage, isRunningWorkContinuation, NEW_WORK_HELD_CODE } from '../maintenance/new-work-hold.js';
import { OutgoingReceiptStore } from './outgoing-receipt-store.js';
import { outgoingInputDigest, type OutgoingReceipt } from '../seqscribe/outgoing-receipt.js';
/**
 * SessionInputService — the ONE path from any origin into a session's input.
 *
 * Wiring-unification Phase D2/D3 (docs/design/2026-09-23-wiring-unification.md
 * §6, §1 RC2). Before this module a message reached a CLI session through
 * two funnels (dashboard `handleSendChat`, mesh `agent_command`) plus four mesh
 * drains, each with its own input normalisation, image branch, `force`-as-
 * interrupt, "queued" reporting and dedupe — five dedupe layers (1.2 s handler
 * window, 300 s mesh submission guard, 60 s engine content hashes, 60 s ack
 * window, web localStorage) and parked bodies with no identity, recovered by
 * exact-text matching (`claimKey`). Every one of those callers now builds an
 * `OutboundMessage` and calls `submit()`:
 *
 *   dashboard `send_chat`   → commands/chat-commands-write.ts (decode → submit)
 *   mesh `agent_command`    → commands/cli-manager.ts agentCommand (→ submit)
 *   `turn.deliver` notices  → the `SessionInputPort` this service implements
 *
 * Inside `submit()`, in order:
 *   1. ONE dedupe, keyed by `messageId`: an in-flight map (a concurrent second
 *      submit awaits the first and gets `duplicate`), a bounded settled map
 *      (delivered/queued outcomes, `DEDUPE_WINDOW_MS`), and the driver FIFO
 *      itself (`hasQueuedSend(messageId)` — a parked body is never parked twice).
 *      Refusals are NOT remembered: nothing was written, so a retry is safe.
 *   2. ONE busy decision — `policy.mode` × the session's status class (A1
 *      `classifySessionStatus`) → a write strategy or a typed refusal. See
 *      `BUSY_DECISION` below; the driver's own `canSendNow()` stays the final
 *      authority on the ordinary write (it parks rather than braids).
 *   3. The write: ordinary (driver write-or-park), the POSIX split write into
 *      the agent's own queue (`send_now`), or stop-key → wait-idle → write
 *      (`interrupt`, stop pressed BEFORE the parked body is claimed).
 *   4. The ack: `recordAcknowledgedUserInput(input, messageId)` exactly once
 *      per message — on its FIRST successful submit, never on a send-now /
 *      interrupt promotion of a body that is already parked (its ack already
 *      rendered the owner's bubble; IMAGE-TRIPLE-BUBBLE ④).
 *
 * A refusal is always a `SubmitOutcome`, never a throw. `turn_started{messageId}`
 * evidence (C-W5) hooks the delivered/queued branch of `writeAndReport`.
 */

import type { OutboundMessage, SendRefusal, SubmitOutcome, SubmitRoute } from '@adhdev/mesh-shared';
import { classifySessionStatus } from '@adhdev/mesh-shared';
import {
    DRAIN_RESERVE_SLACK_MS,
    INTERRUPT_IDLE_TIMEOUT_MS,
    waitForIdleAfterInterrupt,
} from './session-input-interrupt.js';

// ─── Target ────────────────────────────────────────────────────────────────

/** The body the driver writes: built text (images materialized) + paste flag. */
export interface SessionInputBody {
    text: string;
    bracketedPaste?: boolean;
}

/** A parked body taken out of the driver FIFO (see SendSubmitEngine.claimQueuedSend). */
export interface ClaimedSessionInput {
    entry: { messageId: string; text: string; bracketedPaste?: boolean };
    index: number;
}

/**
 * What `submit()` needs from a resolved session. Only `sendMessage` is required
 * — a queue-only target (the coordinator-notice target) simply has no
 * mid-generation / interrupt route, and those policies refuse with
 * `not_supported` / `interrupt_not_implemented` instead of guessing.
 */
export interface SessionInputTarget {
    /** Log label (provider type). */
    label?: string;
    /** Live status spelling; classified through the A1 status vocabulary. */
    getStatus?(options?: { allowParse?: boolean }): { status?: string } | undefined;
    /** Session settings snapshot for active mesh task/attempt binding checks. */
    getSessionSettings?(): Record<string, unknown> | undefined;
    /**
     * Build the driver body from the envelope (materialize images, check the
     * provider's declared input support). Throws with a human-readable message
     * when the provider cannot take this input. Absent → text-only target: the
     * envelope's `textFallback` is the body and any non-text part is refused.
     */
    buildBody?(input: OutboundMessage['input']): SessionInputBody | null;
    /** Ordinary write: now when the driver can take it, else park under `messageId`. */
    sendMessage(
        text: string,
        options?: { bracketedPaste?: boolean; messageId?: string },
    ): Promise<{ status: 'queued'; position?: number } | { status: 'delivered' } | void>;
    /** POSIX split write into the agent's own input queue (driver refuses win32 first). */
    sendMessageDuringGeneration?(text: string, bracketedPaste?: boolean, messageId?: string): { accepted: boolean; reason?: string };
    /** Press the provider's own stop key. */
    interruptTurn?(): Promise<
        | { ok: true; keyName: string; bytes: number; confidence: 'proven' | 'declared' }
        | { ok: false; reason: string; message: string }
    >;
    hasQueuedSend?(messageId: string): boolean;
    claimQueuedSend?(messageId: string): ClaimedSessionInput | null;
    restoreQueuedSend?(claimed: ClaimedSessionInput): void;
    /** SEND-NOW-WRONG-ITEM: hold the driver's autonomous FIFO drain while an interrupt owns the next write. */
    reserveDrain?(ttlMs: number): void;
    releaseDrain?(): void;
    /** TASKBUBBLE-DUP ack; `sourceMessageId` lands on the ack's `meta.sourceMessageId`. */
    observeSendWrite?(messageId: string, observer: (state: 'started' | 'submitted' | 'uncertain') => void): void;
    recordAcknowledgedUserInput?(input: OutboundMessage['input'], sourceMessageId?: string, receipt?: OutgoingReceipt): void;
    /**
     * SUBMIT-UNCONFIRMED-RECLAIM: the driver proved the NEXT write under
     * `messageId` was not taken (see SendSubmitEngine `unconfirmed`).
     */
    observeSubmitUnconfirmed?(messageId: string, observer: (verdict: 'unconfirmed', info: { firstWrittenAt: number }) => boolean | void, confirmConsumption?: (sinceMs: number, opts?: { messageId?: string; expectedText?: string }) => Promise<'consumed' | 'not_consumed' | 'unknown'>): void;
    /** Transcript read used before a recovery re-paste. Unknown/absent is not proof the turn never started. */
    confirmSubmitConsumption?(sinceMs: number, opts?: { messageId?: string; expectedText?: string }): Promise<'consumed' | 'not_consumed' | 'unknown'>;
    /** The instance's half: turn a proven-unconfirmed verdict on its mesh dispatch (first body write at `firstWrittenAt`) into ledger evidence; false = not its dispatch. */
    reportSubmitUnconfirmed?(messageId: string, firstWrittenAt: number): boolean;
    /** True only when `messageId` is the instance's CURRENTLY installed mesh dispatch (same attempt) and it can report a verdict. */
    canReportSubmitVerdict?(messageId: string, attemptRef: string): boolean;
}

/**
 * The one call surface every send origin — and the turn ledger's
 * `turn.deliver` consumer (C2) — targets. `SessionInputService` implements it;
 * callers depend on this interface only. (Moved here from the retired
 * `session-input-port.ts` shim, C-W8.)
 */
export interface SessionInputPort {
    submit(msg: OutboundMessage): Promise<SubmitOutcome>;
}

export interface SessionInputServiceDeps {
    receiptStore?: OutgoingReceiptStore;
    resolveSession(sessionId: string): SessionInputTarget | null | undefined | Promise<SessionInputTarget | null | undefined>;
    clock?: () => number;
    /** Never receives bodies — ids, lengths, reasons only (content boundary). */
    log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
    /** Interrupt wait tuning (tests). */
    interrupt?: { timeoutMs?: number; pollMs?: number; secondPressAfterMs?: number; minBusyDwellMs?: number };
}

/** Trusted daemon preparation runs only after original-input reservation/dedupe.
 * The transformed input builds the native body; receipts and ACKs retain the original. */
export type PrepareSessionInput = () => OutboundMessage['input'] | { refusal: string };

export interface SessionInputService {
    /** turn.deliver metadata only; native ACK survives a queued submit return. */
    submitNotice(msg: OutboundMessage, observe: (state: 'started'|'submitted'|'uncertain') => void): Promise<SubmitOutcome>;
    getReceipts(sessionId: string, ids: readonly string[]): OutgoingReceipt[];
    isReceiptUnverified?(messageId: string): boolean;
    submit(msg: OutboundMessage, prepareInput?: PrepareSessionInput): Promise<SubmitOutcome>;
    /**
     * Withdraw a parked body (dashboard cancel). `removed: false` is the honest
     * answer when the FIFO had already drained it — the caller must not clear
     * its bubble on that.
     */
    withdraw(sessionId: string, messageId: string): Promise<{ removed: boolean; unsupported?: true }>;
    /**
     * LEGACY (one release, D3 cut-compat): the messageId of a body this service
     * parked for `sessionId` whose text is exactly `text`, for a pre-D dashboard
     * that sends send-now / cancel by text only. Logged at DEBUG by the caller.
     */
    findParkedMessageIdByText(sessionId: string, text: string): Promise<string | undefined>;
    /**
     * Whether the driver FIFO still holds `messageId` for `sessionId` (read
     * only). False once the drain wrote it (or it was withdrawn / never parked).
     */
    isParked(sessionId: string, messageId: string): Promise<boolean>;
}

// ─── The busy decision (D3) ──────────────────────────────────────────────────

type StatusClass = 'ready' | 'working' | 'blocked' | 'dead' | 'unknown';
type Strategy = 'write' | 'split_write' | 'interrupt' | { refuse: SendRefusal };

/**
 * `policy.mode` × session status class → strategy. The table IS the spec
 * (pinned cell by cell in test/sessions/session-input-service.test.ts).
 *
 *   `write`       — ordinary driver write; the driver parks it (→ `queued`)
 *                   whenever it cannot take it right now, so `queue` never
 *                   needs its own busy branch.
 *   `split_write` — send_now while a turn is generating: the CLI's own queue.
 *   `interrupt`   — stop key, wait idle, then `write`.
 *
 * `ready` + send_now / interrupt → `write`: there is no turn to jump or stop,
 * and an ordinary turn is strictly better (answered now). `blocked` (a modal is
 * up) refuses both out-of-band modes — a body typed into an approval/choice
 * picker answers it with garbage, and there is no turn to interrupt. `unknown`
 * is treated like `working`: the driver primitives re-check the live FSM state
 * and refuse (`not_generating` / `not_busy`) rather than write blind.
 */
export const BUSY_DECISION: Readonly<Record<OutboundMessage['policy']['mode'], Readonly<Record<StatusClass, Strategy>>>> = {
    queue: { ready: 'write', working: 'write', blocked: 'write', unknown: 'write', dead: { refuse: 'session_exited' } },
    send_now: { ready: 'write', working: 'split_write', blocked: { refuse: 'modal_parked' }, unknown: 'split_write', dead: { refuse: 'session_exited' } },
    interrupt: { ready: 'write', working: 'interrupt', blocked: { refuse: 'modal_parked' }, unknown: 'interrupt', dead: { refuse: 'session_exited' } },
};

/** Settled-outcome memory. Wider than the slowest automatic redelivery source
 *  the deleted 300 s mesh guard was sized against (dispatch-confirm 120 s +
 *  a reconcile tick); a body parked longer than this is still caught by the
 *  driver-FIFO membership check. */
export const DEDUPE_WINDOW_MS = 300_000;
const DEDUPE_MAX_ENTRIES = 5_000;
const PARKED_TEXT_MAX_ENTRIES = 1_000;

const REFUSAL_MESSAGES: Partial<Record<SendRefusal, string>> = {
    platform_unsupported: 'Send now without interrupting is not available on Windows yet.',
    not_supported: 'This session does not support sending while the agent is working.',
    not_generating: 'The agent is not generating right now.',
    send_in_flight: 'A previous message is still being submitted.',
    not_ready: 'The session is not ready to accept input yet.',
    modal_parked: 'The agent is waiting on an approval or a choice; answer it first.',
    session_exited: 'The session has ended, so nothing was sent. Start the session again and resend.',
    no_target: 'No live session to send to.',
    idle_timeout: 'The stop key was sent, but the session did not return to idle in time, so the message was not delivered yet.',
    interrupt_not_implemented: 'This session cannot interrupt a turn. The message stays queued and is delivered when the agent finishes on its own.',
};

function splitWriteRefusal(reason: string | undefined): SendRefusal {
    switch (reason) {
        case 'platform_unsupported':
        case 'not_supported':
        case 'not_generating':
        case 'send_in_flight':
        case 'not_ready':
            return reason;
        default:
            return 'internal_error';
    }
}

function interruptRefusal(reason: string): SendRefusal {
    switch (reason) {
        case 'interrupt_not_implemented': return 'interrupt_not_implemented';
        case 'not_running': return 'session_exited';
        case 'not_busy': return 'not_generating';
        default: return 'interrupt_refused';
    }
}

function classify(target: SessionInputTarget): StatusClass {
    let raw: string | undefined;
    try { raw = target.getStatus?.()?.status; } catch { raw = undefined; }
    // `exited`/`crashed` are adapter spellings outside the A1 vocabulary.
    if (raw === 'exited' || raw === 'crashed') return 'dead';
    return classifySessionStatus(raw);
}

function hasNonTextParts(input: OutboundMessage['input']): boolean {
    return input.parts.some((part) => part.type !== 'text');
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createSessionInputService(deps: SessionInputServiceDeps): SessionInputService {
    const receiptStore = deps.receiptStore ?? new OutgoingReceiptStore();
    const freshOutgoing = new Set<string>();
    const unverifiedReceipts = new Set<string>();
    const outgoingAttempts = new Map<string, OutgoingReceipt>();
    const now = deps.clock ?? Date.now;
    const log = deps.log ?? (() => {});
    const tuning = deps.interrupt ?? {};
    function receiptFailure(messageId: string, error: unknown): void {
        unverifiedReceipts.add(messageId);
        log('warn', `submit(${messageId}) receipt unverified; preserving delivery/dedupe: ${(error as Error)?.message ?? error}`);
    }

    /** messageId → settled delivered/queued outcome + when. */
    const settled = new Map<string, { kind: 'delivered' | 'queued'; at: number; sessionId: string; inputDigest: string }>();
    /** messageId → the first submit's promise while it runs. */
    const inFlight = new Map<string, Promise<SubmitOutcome>>();
    /** messageId → where/what it was parked as (legacy text lookup + withdraw bookkeeping). */
    const parkedText = new Map<string, { sessionId: string; text: string }>();

    function remember(msg: OutboundMessage, kind: 'delivered' | 'queued'): void {
        const messageId = msg.messageId;
        const at = now();
        for (const [id, entry] of settled) {
            if (at - entry.at <= DEDUPE_WINDOW_MS && settled.size < DEDUPE_MAX_ENTRIES) break;
            settled.delete(id);
        }
        settled.delete(messageId);
        settled.set(messageId, { kind, at, sessionId: msg.sessionId, inputDigest: outgoingInputDigest(msg.input) });
    }

    function settledKind(messageId: string): 'delivered' | 'queued' | undefined {
        const entry = settled.get(messageId);
        if (!entry) return undefined;
        if (now() - entry.at > DEDUPE_WINDOW_MS) { settled.delete(messageId); return undefined; }
        return entry.kind;
    }

    function rememberParked(msg: OutboundMessage): void {
        if (parkedText.size >= PARKED_TEXT_MAX_ENTRIES) {
            const oldest = parkedText.keys().next().value;
            if (oldest !== undefined) parkedText.delete(oldest);
        }
        parkedText.set(msg.messageId, { sessionId: msg.sessionId, text: msg.input.textFallback.trim() });
    }

    function refuse(reason: SendRefusal, extra?: { message?: string; restored?: boolean }): SubmitOutcome {
        const message = extra?.message ?? REFUSAL_MESSAGES[reason];
        return {
            kind: 'refused',
            reason,
            ...(message ? { message } : {}),
            ...(extra?.restored !== undefined ? { restored: extra.restored } : {}),
        };
    }

    function ack(target: SessionInputTarget, msg: OutboundMessage): void {
        try {
            target.recordAcknowledgedUserInput?.(msg.input, msg.messageId, receiptStore.get(msg.messageId));
        } catch (e) {
            log('warn', `submit(${msg.messageId}) ack failed: ${(e as Error)?.message ?? e}`);
        }
    }

    /** Resolve the body a fresh (never parked) message is written as. */
    function freshBody(target: SessionInputTarget, msg: OutboundMessage, input = msg.input): SessionInputBody | SubmitOutcome {
        try {
            if (target.buildBody) {
                const body = target.buildBody(input);
                if (body && body.text.trim()) return body;
                return refuse('unsupported_input', { message: 'No input to send.' });
            }
            if (hasNonTextParts(input)) {
                return refuse('unsupported_input', { message: `${target.label || 'This session'} only supports text input.` });
            }
            const text = input.textFallback;
            if (!text || !text.trim()) return refuse('unsupported_input', { message: 'No input to send.' });
            return { text };
        } catch (e) {
            return refuse('unsupported_input', { message: (e as Error)?.message || String(e) });
        }
    }

    /** Ordinary driver write-or-park, then the outcome. */
    async function writeAndReport(
        target: SessionInputTarget,
        msg: OutboundMessage,
        body: SessionInputBody,
        opts: { fresh: boolean; route: SubmitRoute; interrupt?: { keyName: string; confidence: 'proven' | 'declared' } },
        noticeObserver?: (state: 'started'|'submitted'|'uncertain') => void,
    ): Promise<SubmitOutcome> {
        const receipt = outgoingAttempts.get(msg.messageId);
        // SUBMIT-UNCONFIRMED-RECLAIM, MESH DISPATCHES ONLY (review 9719d681
        // R3-1): registering this observer is what opts the write into the
        // driver's verdict machinery (exact composer reads, one re-paste, a
        // quarantined slot on doubt), and only a dispatch with a turn-ledger
        // attempt has an owner that can reclaim it. Every other send (a human's
        // chat, a notice) keeps main's give-up byte for byte. On a proven
        // `unconfirmed` the composer has already been cleared; the instance
        // reports it and the ledger reclaims under a new nonce — a NEW messageId,
        // so this id's settled outcome is kept and it is never re-written.
        // Review f8c79690 R4-2: an attemptId string alone proves nothing — the
        // instance must confirm this messageId IS its installed dispatch (task,
        // nonce and attempt as stamped) and that it can report a verdict.
        let reportable = false;
        try { reportable = !!msg.meshAttemptRef && target.canReportSubmitVerdict?.(msg.messageId, msg.meshAttemptRef) === true; } catch { reportable = false; }
        if (reportable) target.observeSubmitUnconfirmed?.(msg.messageId, (verdict, info) => {
            log('warn', `submit(${msg.messageId}) submit verdict '${verdict}' (proven not taken after one re-paste; the composer was cleared) — reporting it (session ${msg.sessionId})`);
            try { return target.reportSubmitUnconfirmed?.(msg.messageId, info.firstWrittenAt) === true; }
            catch (e) { log('warn', `submit(${msg.messageId}) submit-unconfirmed report failed: ${(e as Error)?.message ?? e}`); return false; }
        }, target.confirmSubmitConsumption ? (sinceMs, opts) => target.confirmSubmitConsumption!(sinceMs, opts) : undefined);
        if (receipt||noticeObserver) target.observeSendWrite?.(msg.messageId, state => {
            if(noticeObserver){try{noticeObserver(state);}catch{/* Persisted intent remains unknown; never retry native input. */}}
            if(!receipt)return;
            try {
                const updated = receiptStore.advance(receipt, state === 'submitted' ? 'submitted' : 'uncertain');
                if (updated) target.recordAcknowledgedUserInput?.(msg.input, msg.messageId, updated);
                if (state !== 'started') outgoingAttempts.delete(msg.messageId);
            }
            catch (error) { receiptFailure(msg.messageId, error); }
        });
        assertMaintenanceAdmission();
        const result = await target.sendMessage(body.text, {
            ...(body.bracketedPaste ? { bracketedPaste: true } : {}),
            messageId: msg.messageId,
        });
        if (opts.fresh) ack(target, msg);
        const detail = opts.interrupt ? { interrupt: opts.interrupt } : {};
        if (result && result.status === 'queued') {
            rememberParked(msg);
            const position = typeof result.position === 'number' && result.position > 0 ? result.position : 1;
            log('info', `submit(${msg.messageId}) ${msg.origin}/${msg.policy.mode} → queued at ${position} (session ${msg.sessionId}, route=${opts.route})`);
            return { kind: 'queued', position, route: opts.route, ...detail };
        }
        log('info', `submit(${msg.messageId}) ${msg.origin}/${msg.policy.mode} → delivered (session ${msg.sessionId}, route=${opts.route}, len=${body.text.length})`);
        return { kind: 'delivered', route: opts.route, ...detail };
    }

    /** send_now while generating: claim (if parked) → split write → restore on refusal. */
    async function splitWrite(target: SessionInputTarget, msg: OutboundMessage, parked: boolean, input = msg.input, noticeObserver?: (state: 'started' | 'submitted' | 'uncertain') => void): Promise<SubmitOutcome> {
        if (typeof target.sendMessageDuringGeneration !== 'function') {
            return refuse('not_supported', { restored: true });
        }
        let body: SessionInputBody;
        let claimed: ClaimedSessionInput | null = null;
        if (parked) {
            // ★ Claim BEFORE writing (SEND-NOW-DOUBLE-SEND): otherwise the CLI
            // queues our copy AND the idle drain later writes the parked one.
            claimed = target.claimQueuedSend?.(msg.messageId) ?? null;
            if (!claimed) return { kind: 'duplicate', of: msg.messageId };
            body = { text: claimed.entry.text, ...(claimed.entry.bracketedPaste ? { bracketedPaste: true } : {}) };
        } else {
            const built = freshBody(target, msg, input);
            if ('kind' in built) return built;
            body = built;
        }
        const receipt = outgoingAttempts.get(msg.messageId);
        if (receipt || noticeObserver) target.observeSendWrite?.(msg.messageId, state => {
            if (noticeObserver) { try { noticeObserver(state); } catch { /* Persisted intent remains unknown; never retry native input. */ } }
            if (!receipt) return;
            try {
                const updated = receiptStore.advance(receipt, state === 'submitted' ? 'submitted' : 'uncertain');
                if (updated) target.recordAcknowledgedUserInput?.(msg.input, msg.messageId, updated);
                if (state !== 'started') outgoingAttempts.delete(msg.messageId);
            } catch (error) { receiptFailure(msg.messageId, error); }
        });
        let outcome: { accepted: boolean; reason?: string };
        try {
            assertMaintenanceAdmission();
            outcome = target.sendMessageDuringGeneration(body.text, body.bracketedPaste, msg.messageId);
        } catch (e) {
            outcome = { accepted: false, reason: `threw:${(e as Error)?.message ?? e}` };
        }
        if (outcome.accepted) {
            if (!parked) ack(target, msg);
            parkedText.delete(msg.messageId);
            log('info', `submit(${msg.messageId}) send_now → agent input queue (session ${msg.sessionId}, promoted=${parked}, len=${body.text.length})`);
            return { kind: 'delivered', route: 'agent_queue' };
        }
        // Refused: nothing was written. Put a claimed body back IN PLACE so the
        // ordinary idle drain still delivers it; skipping this turns a refusal
        // into silent loss behind a bubble that still says "queued".
        let restored = true;
        if (claimed) {
            try {
                if (target.restoreQueuedSend) target.restoreQueuedSend(claimed);
                else await target.sendMessage(claimed.entry.text, { ...(claimed.entry.bracketedPaste ? { bracketedPaste: true } : {}), messageId: msg.messageId });
            } catch (e) {
                restored = false;
                log('error', `submit(${msg.messageId}) FAILED to restore the claimed body after a refused split write: ${(e as Error)?.message ?? e}`);
            }
        }
        const reason = splitWriteRefusal(outcome.reason);
        log('info', `submit(${msg.messageId}) send_now refused ${outcome.reason} (session ${msg.sessionId}, promoted=${parked}, restored=${restored})`);
        return refuse(reason, { restored });
    }

    /**
     * interrupt: stop key → claim → hold drain → wait idle → write.
     *
     * ★ ORDER: the stop key is pressed BEFORE the parked body is claimed. Every
     * refusal of `interruptTurn()` therefore leaves the session untouched — the
     * parked copy keeps its place and its ordinary drain. Only once the stop key
     * HAS been written does this call own the delivery.
     */
    async function interruptThenWrite(target: SessionInputTarget, msg: OutboundMessage, parked: boolean, input = msg.input, noticeObserver?: (state:'started'|'submitted'|'uncertain')=>void): Promise<SubmitOutcome> {
        if (typeof target.interruptTurn !== 'function') return refuse('interrupt_not_implemented');
        let fresh: SessionInputBody | null = null;
        if (!parked) {
            const built = freshBody(target, msg, input);
            if ('kind' in built) return built;
            fresh = built;
        }
        assertMaintenanceAdmission();
        const interrupted = await target.interruptTurn();
        if (!interrupted.ok) {
            log('warn', `submit(${msg.messageId}) interrupt refused: ${interrupted.reason}`);
            return refuse(interruptRefusal(interrupted.reason), { message: interrupted.message, restored: true });
        }
        const claimed = parked ? (target.claimQueuedSend?.(msg.messageId) ?? null) : null;
        if (parked && !claimed) {
            // Unreachable in practice (the drain needs idle, the stop key was
            // just written) — but if it happens the body is already written, so
            // writing it again would be the double send this guard exists for.
            log('warn', `submit(${msg.messageId}) interrupt: parked body drained before claim — not re-sending`);
            return { kind: 'duplicate', of: msg.messageId };
        }
        const body: SessionInputBody = claimed
            ? { text: claimed.entry.text, ...(claimed.entry.bracketedPaste ? { bracketedPaste: true } : {}) }
            : fresh!;
        const timeoutMs = tuning.timeoutMs ?? INTERRUPT_IDLE_TIMEOUT_MS;
        // SEND-NOW-WRONG-ITEM: interrupting drives the machine to idle, and the
        // driver drains on that very frame — an entry queued AHEAD of this one
        // would take the prompt and re-park this body (live 2026-09-11, rc.10).
        target.reserveDrain?.(timeoutMs + DRAIN_RESERVE_SLACK_MS);
        try {
            let terminalStatus: string | null = null;
            const wentIdle = await waitForIdleAfterInterrupt(target, timeoutMs, tuning.pollMs, {
                onTerminalStatus: (status) => { terminalStatus = status; },
                secondPress: interrupted.confidence === 'proven' ? () => { void target.interruptTurn?.(); } : undefined,
                secondPressAfterMs: tuning.secondPressAfterMs,
                minBusyDwellMs: tuning.minBusyDwellMs,
            });
            if (!wentIdle && terminalStatus !== null) {
                log('warn', `submit(${msg.messageId}) session reported '${String(terminalStatus)}' after the stop key — NOT delivered`);
                return refuse('session_exited', { restored: false });
            }
            if (!wentIdle) {
                // The turn is very likely aborted; only the observation timed
                // out. Put a claimed body back so the idle drain still delivers
                // it (and a retry of the same messageId finds it parked).
                let restored = !claimed;
                if (claimed && target.restoreQueuedSend) {
                    try { target.restoreQueuedSend(claimed); restored = true; } catch { restored = false; }
                }
                log('warn', `submit(${msg.messageId}) interrupt sent but no idle within ${timeoutMs}ms (restored=${restored})`);
                return refuse('idle_timeout', { restored });
            }
            return await writeAndReport(target, msg, body, {
                fresh: !parked,
                route: 'interrupt',
                interrupt: { keyName: interrupted.keyName, confidence: interrupted.confidence },
            }, noticeObserver);
        } finally {
            // Release on EVERY exit — the rest of the owner's queue is not this call's to hold.
            target.releaseDrain?.();
        }
    }

    async function run(msg: OutboundMessage, resolveTarget: () => Promise<SessionInputTarget | null | undefined>, prepareInput?: PrepareSessionInput, noticeObserver?: (state:'started'|'submitted'|'uncertain')=>void): Promise<SubmitOutcome> {
        if (settledKind(msg.messageId) === 'delivered') {
            const prior = settled.get(msg.messageId)!;
            if (prior.sessionId !== msg.sessionId || prior.inputDigest !== outgoingInputDigest(msg.input)) throw new Error('Outgoing message identity conflict');
            return { kind: 'duplicate', of: msg.messageId };
        }
        try {
            if (prepareInput || msg.origin === 'dashboard' || receiptStore.hasAcceptance(msg.messageId)) {
                const { receipt, fresh } = receiptStore.accept(msg.messageId, msg.sessionId, msg.input);
                if (fresh) freshOutgoing.add(msg.messageId);
                if (!fresh) {
                    const liveTarget = await resolveTarget();
                    if (msg.policy.mode === 'queue' || receipt.state !== 'accepted' || !liveTarget?.hasQueuedSend?.(msg.messageId)) {
                        return { kind: 'duplicate', of: msg.messageId };
                    }
                }
                outgoingAttempts.set(msg.messageId, receipt);
            }
        } catch (error) {
            if ((error as Error).message === 'Outgoing message identity conflict' || !receiptStore.hasAcceptance(msg.messageId)) throw error;
            receiptFailure(msg.messageId, error);
            return { kind: 'duplicate', of: msg.messageId };
        }

        let target: SessionInputTarget | null | undefined;
        try {
            target = await resolveTarget();
        } catch (e) {
            log('error', `submit(${msg.messageId}) resolveSession threw: ${(e as Error)?.message ?? e}`);
            return refuse('internal_error');
        }
        if (!target) return refuse('no_target');

        const cls = classify(target);
        const parked = target.hasQueuedSend?.(msg.messageId) === true;
        const prior = settledKind(msg.messageId);
        if (msg.policy.mode === 'queue') {
            if (parked || prior) return { kind: 'duplicate', of: msg.messageId };
        } else if (prior && !parked) {
            // Queued earlier and already drained by the driver: it was written.
            return { kind: 'duplicate', of: msg.messageId };
        }

        const strategy = BUSY_DECISION[msg.policy.mode][cls];
        if (typeof strategy === 'object') {
            return refuse(strategy.refuse, parked ? { restored: true } : undefined);
        }
        let input = msg.input;
        // Parked promotions use their already authorized body, never renew consent.
        if (!parked && prepareInput) {
            const prepared = prepareInput();
            if ('refusal' in prepared) return refuse('unsupported_input', { message: prepared.refusal });
            input = prepared;
        }
        if (strategy === 'split_write') return splitWrite(target, msg, parked, input, noticeObserver);
        if (strategy === 'interrupt') return interruptThenWrite(target, msg, parked, input, noticeObserver);

        // write
        if (parked) {
            // send_now / interrupt on a parked body at an idle prompt: nothing to
            // jump or stop — take it out of line and write it now.
            const claimed = target.claimQueuedSend?.(msg.messageId) ?? null;
            if (!claimed) return { kind: 'duplicate', of: msg.messageId };
            return writeAndReport(target, msg, {
                text: claimed.entry.text,
                ...(claimed.entry.bracketedPaste ? { bracketedPaste: true } : {}),
            }, { fresh: false, route: 'pty' }, noticeObserver);
        }
        const body = freshBody(target, msg, input);
        if ('kind' in body) return body;
        return writeAndReport(target, msg, body, { fresh: true, route: 'pty' }, noticeObserver);
    }

    async function runAdmitted(msg: OutboundMessage, prepareInput?: PrepareSessionInput, noticeObserver?: (state:'started'|'submitted'|'uncertain')=>void): Promise<SubmitOutcome> {
        // Resolve once, inside maintenance admission and the message's in-flight
        // ownership. A concurrent notice cannot replace the original resolver or
        // donate its ACK observer while hold admission awaits the target.
        let target: Promise<SessionInputTarget | null | undefined> | undefined;
        const resolveTarget = () => target ??= Promise.resolve().then(() => deps.resolveSession(msg.sessionId));
        const isCoordinatorNotice = Boolean(noticeObserver) || (msg.origin === 'mesh' && msg.messageId.startsWith('notify:'));
        const isVerifiedOwnerChat = isTrustedOwnerIngress(msg) && !msg.meshAttemptRef;
        if (!isCoordinatorNotice && !isVerifiedOwnerChat) {
            const resolvedForHold = await resolveTarget().catch(() => null);
            const settingsForHold = resolvedForHold?.getSessionSettings?.();
            const meshId = typeof settingsForHold?.meshNodeFor === 'string' ? settingsForHold.meshNodeFor
                : typeof settingsForHold?.meshCoordinatorFor === 'string' ? settingsForHold.meshCoordinatorFor : undefined;
            const activeHold = evaluateNewWorkHold({ meshId });
            if (activeHold.held) {
                const isContinuation = isRunningWorkContinuation({
                    sessionId: msg.sessionId,
                    attemptId: msg.meshAttemptRef,
                    taskId: (msg as { meshTaskId?: string }).meshTaskId,
                    isMeshOrCoordinatorFollowUp: msg.origin === 'mesh',
                    sessionSettings: settingsForHold,
                });
                if (!isContinuation) {
                    return refuse(NEW_WORK_HELD_CODE, {
                        message: formatNewWorkHeldMessage({
                            holdId: activeHold.hold.holdId || 'active',
                            revision: activeHold.hold.revision,
                            expiresAt: activeHold.hold.expiresAt || 0,
                            phase: activeHold.hold.phase,
                            reason: activeHold.hold.reason,
                        }, `Outbound session input refused for session '${msg.sessionId}' while new-work hold is active`),
                    });
                }
            }
        }
        return run(msg, resolveTarget, prepareInput, noticeObserver);
    }

    async function submitOwned(msg: OutboundMessage, prepareInput?: PrepareSessionInput, noticeObserver?: (state:'started'|'submitted'|'uncertain')=>void):Promise<SubmitOutcome> {
        if (!msg || typeof msg.messageId !== 'string' || !msg.messageId.trim()) return refuse('internal_error', { message: 'messageId required' });
        if (typeof msg.sessionId !== 'string' || !msg.sessionId.trim()) return refuse('no_target');
        const pending = inFlight.get(msg.messageId);
        if (pending) {
            await pending.catch(() => undefined);
            // Concurrent replay must still match the full original identity.
            try { if (receiptStore.get(msg.messageId)) receiptStore.accept(msg.messageId, msg.sessionId, msg.input); }
            catch (error) {
                if ((error as Error).message === 'Outgoing message identity conflict') return refuse('internal_error', { message: 'Outgoing message identity conflict' });
                receiptFailure(msg.messageId, error);
            }
            return { kind: 'duplicate', of: msg.messageId };
        }
        const promise = withMaintenanceAdmission(() => runAdmitted(msg, prepareInput, noticeObserver)).catch((e): SubmitOutcome => {
            log('error', `submit(${msg.messageId}) threw: ${(e as Error)?.message ?? e}`);
            return refuse('internal_error', { message: (e as Error)?.message || String(e) });
        });
        inFlight.set(msg.messageId, promise);
        try {
            const outcome = await promise;
            // Remember the native disposition BEFORE optional receipt I/O. A
            // journal fault after acceptance cannot turn delivery into refusal.
            if (outcome.kind === 'delivered' || outcome.kind === 'queued') remember(msg, outcome.kind);
            if (outcome.kind === 'delivered') parkedText.delete(msg.messageId);
            try {
                const receipt = outgoingAttempts.get(msg.messageId);
                if (receipt && outcome.kind === 'refused') {
                    const notWritten = freshOutgoing.has(msg.messageId) && receiptStore.get(msg.messageId)?.state === 'accepted'
                        && ['no_target', 'unsupported_input', 'session_exited', 'paused', 'waiting_external'].includes(outcome.reason);
                    receiptStore.advance(receipt, notWritten ? 'failed' : 'uncertain');
                }
                if (receipt && outcome.kind === 'delivered' && receiptStore.get(msg.messageId)?.state === 'accepted') {
                    receiptStore.advance(receipt, 'uncertain');
                }
            } catch (error) { receiptFailure(msg.messageId, error); }
            return outcome;
        } finally {
            inFlight.delete(msg.messageId);
            freshOutgoing.delete(msg.messageId);
        }
    }

    const service:SessionInputService = {
        async submitNotice(msg,observe){
            // Capture the original attempt and session before admission, dedupe
            // or resolveSession can await. A duplicate never supplies an observer
            // to the original write, and late ACKs retain this exact callback.
            return submitOwned({...msg},undefined,observe);
        },
        isReceiptUnverified: messageId => unverifiedReceipts.has(messageId) || receiptStore.isUnverified(messageId),
        getReceipts: (sessionId, ids) => receiptStore.list(sessionId, ids).map(receipt => {
            // A restored write-ahead acceptance has no surviving FIFO/observer
            // authority. Replay explicit uncertainty, never infer delivery or retry.
            return receipt.state === 'accepted' && !outgoingAttempts.has(receipt.messageId)
                ? { ...receipt, state: 'uncertain', proof: 'none', revision: receipt.revision + 1 } : receipt;
        }),
        submit: submitOwned,

        async withdraw(sessionId: string, messageId: string): Promise<{ removed: boolean; unsupported?: true }> {
            let target: SessionInputTarget | null | undefined;
            try { target = await deps.resolveSession(sessionId); } catch { target = null; }
            if (target && typeof target.claimQueuedSend !== 'function') return { removed: false, unsupported: true };
            const claimed = target?.claimQueuedSend?.(messageId) ?? null;
            if (claimed) {
                parkedText.delete(messageId);
                const receipt = receiptStore.get(messageId);
                if (receipt?.sessionId === sessionId) receiptStore.advance(receipt, 'failed');
                // A withdrawn body was never written: forget it so the same
                // messageId can be sent again as a fresh message.
                settled.delete(messageId);
            }
            log('info', `withdraw(${messageId}) session ${sessionId} → ${claimed ? 'removed' : 'not parked'}`);
            return { removed: !!claimed };
        },

        async findParkedMessageIdByText(sessionId: string, text: string): Promise<string | undefined> {
            const wanted = text.trim();
            if (!wanted) return undefined;
            const candidates: string[] = [];
            for (const [messageId, entry] of parkedText) {
                if (entry.sessionId === sessionId && entry.text === wanted) candidates.push(messageId);
            }
            if (candidates.length === 0) return undefined;
            let target: SessionInputTarget | null | undefined;
            try { target = await deps.resolveSession(sessionId); } catch { target = null; }
            // Oldest still-parked copy first — the one the drain would write next.
            return candidates.find((id) => target?.hasQueuedSend?.(id) === true) ?? candidates[candidates.length - 1];
        },

        async isParked(sessionId: string, messageId: string): Promise<boolean> {
            let target: SessionInputTarget | null | undefined;
            try { target = await deps.resolveSession(sessionId); } catch { target = null; }
            return target?.hasQueuedSend?.(messageId) === true;
        },
    };
    return service;
}
