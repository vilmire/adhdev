/**
 * SessionInputService — the ONE path from any origin into a session's input.
 *
 * Wiring-unification Phase D2/D3 (docs/design/2026-09-23-wiring-unification.md
 * §6, §1 RC2). Before this module a message reached a CLI/ACP session through
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
    /**
     * Build the driver body from the envelope (materialize images, check the
     * provider's declared input support). Throws with a human-readable message
     * when the provider cannot take this input. Absent → text-only target: the
     * envelope's `textFallback` is the body and any non-text part is refused.
     */
    buildBody?(input: OutboundMessage['input']): SessionInputBody | null;
    /** Settle hook run once before a fresh write (hermes-cli first-send wait). */
    beforeWrite?(): Promise<void>;
    /** Ordinary write: now when the driver can take it, else park under `messageId`. */
    sendMessage(
        text: string,
        options?: { bracketedPaste?: boolean; messageId?: string },
    ): Promise<{ status: 'queued'; position?: number } | { status: 'delivered' } | void>;
    /** POSIX split write into the agent's own input queue (driver refuses win32 first). */
    sendMessageDuringGeneration?(text: string, bracketedPaste?: boolean): { accepted: boolean; reason?: string };
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
    /** ACP transport: hand the whole envelope to the agent (it owns its own busy refusal). */
    sendAcp?(input: OutboundMessage['input']): Promise<{ success: boolean; error?: string; status?: string }>;
    /** TASKBUBBLE-DUP ack; `sourceMessageId` lands on the ack's `meta.sourceMessageId`. */
    recordAcknowledgedUserInput?(input: OutboundMessage['input'], sourceMessageId?: string): void;
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
    resolveSession(sessionId: string): SessionInputTarget | null | undefined | Promise<SessionInputTarget | null | undefined>;
    clock?: () => number;
    /** Never receives bodies — ids, lengths, reasons only (content boundary). */
    log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
    /** Interrupt wait tuning (tests). */
    interrupt?: { timeoutMs?: number; pollMs?: number; secondPressAfterMs?: number; minBusyDwellMs?: number };
}

export interface SessionInputService {
    submit(msg: OutboundMessage): Promise<SubmitOutcome>;
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
    const now = deps.clock ?? Date.now;
    const log = deps.log ?? (() => {});
    const tuning = deps.interrupt ?? {};

    /** messageId → settled delivered/queued outcome + when. */
    const settled = new Map<string, { kind: 'delivered' | 'queued'; at: number }>();
    /** messageId → the first submit's promise while it runs. */
    const inFlight = new Map<string, Promise<SubmitOutcome>>();
    /** messageId → where/what it was parked as (legacy text lookup + withdraw bookkeeping). */
    const parkedText = new Map<string, { sessionId: string; text: string }>();

    function remember(messageId: string, kind: 'delivered' | 'queued'): void {
        const at = now();
        for (const [id, entry] of settled) {
            if (at - entry.at <= DEDUPE_WINDOW_MS && settled.size < DEDUPE_MAX_ENTRIES) break;
            settled.delete(id);
        }
        settled.delete(messageId);
        settled.set(messageId, { kind, at });
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
            target.recordAcknowledgedUserInput?.(msg.input, msg.messageId);
        } catch (e) {
            log('warn', `submit(${msg.messageId}) ack failed: ${(e as Error)?.message ?? e}`);
        }
    }

    /** Resolve the body a fresh (never parked) message is written as. */
    function freshBody(target: SessionInputTarget, msg: OutboundMessage): SessionInputBody | SubmitOutcome {
        try {
            if (target.buildBody) {
                const body = target.buildBody(msg.input);
                if (body && body.text.trim()) return body;
                return refuse('unsupported_input', { message: 'No input to send.' });
            }
            if (hasNonTextParts(msg.input)) {
                return refuse('unsupported_input', { message: `${target.label || 'This session'} only supports text input.` });
            }
            const text = msg.input.textFallback;
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
    ): Promise<SubmitOutcome> {
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
    async function splitWrite(target: SessionInputTarget, msg: OutboundMessage, parked: boolean): Promise<SubmitOutcome> {
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
            const built = freshBody(target, msg);
            if ('kind' in built) return built;
            body = built;
        }
        let outcome: { accepted: boolean; reason?: string };
        try {
            outcome = target.sendMessageDuringGeneration(body.text, body.bracketedPaste);
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
    async function interruptThenWrite(target: SessionInputTarget, msg: OutboundMessage, parked: boolean): Promise<SubmitOutcome> {
        if (typeof target.interruptTurn !== 'function') return refuse('interrupt_not_implemented');
        let fresh: SessionInputBody | null = null;
        if (!parked) {
            const built = freshBody(target, msg);
            if ('kind' in built) return built;
            fresh = built;
        }
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
            });
        } finally {
            // Release on EVERY exit — the rest of the owner's queue is not this call's to hold.
            target.releaseDrain?.();
        }
    }

    async function run(msg: OutboundMessage): Promise<SubmitOutcome> {
        if (settledKind(msg.messageId) === 'delivered') return { kind: 'duplicate', of: msg.messageId };

        let target: SessionInputTarget | null | undefined;
        try {
            target = await deps.resolveSession(msg.sessionId);
        } catch (e) {
            log('error', `submit(${msg.messageId}) resolveSession threw: ${(e as Error)?.message ?? e}`);
            return refuse('internal_error');
        }
        if (!target) return refuse('no_target');

        const cls = classify(target);
        // ACP: the agent owns its own busy refusal and has no composer FIFO.
        if (typeof target.sendAcp === 'function') {
            if (cls === 'dead') return refuse('session_exited');
            if (msg.policy.mode === 'interrupt') return refuse('interrupt_not_implemented');
            const checked = freshBody(target, msg);
            if ('kind' in checked) return checked;
            const outcome = await target.sendAcp(msg.input);
            if (!outcome?.success) {
                return refuse('not_ready', { message: outcome?.error || 'ACP send was not acknowledged' });
            }
            log('info', `submit(${msg.messageId}) ${msg.origin} → acp delivered (session ${msg.sessionId})`);
            return { kind: 'delivered', route: 'acp' };
        }

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
        if (strategy === 'split_write') return splitWrite(target, msg, parked);
        if (strategy === 'interrupt') return interruptThenWrite(target, msg, parked);

        // write
        if (parked) {
            // send_now / interrupt on a parked body at an idle prompt: nothing to
            // jump or stop — take it out of line and write it now.
            const claimed = target.claimQueuedSend?.(msg.messageId) ?? null;
            if (!claimed) return { kind: 'duplicate', of: msg.messageId };
            return writeAndReport(target, msg, {
                text: claimed.entry.text,
                ...(claimed.entry.bracketedPaste ? { bracketedPaste: true } : {}),
            }, { fresh: false, route: 'pty' });
        }
        const body = freshBody(target, msg);
        if ('kind' in body) return body;
        await target.beforeWrite?.();
        return writeAndReport(target, msg, body, { fresh: true, route: 'pty' });
    }

    return {
        async submit(msg: OutboundMessage): Promise<SubmitOutcome> {
            if (!msg || typeof msg.messageId !== 'string' || !msg.messageId.trim()) return refuse('internal_error', { message: 'messageId required' });
            if (typeof msg.sessionId !== 'string' || !msg.sessionId.trim()) return refuse('no_target');
            const pending = inFlight.get(msg.messageId);
            if (pending) {
                await pending.catch(() => undefined);
                return { kind: 'duplicate', of: msg.messageId };
            }
            const promise = run(msg).catch((e): SubmitOutcome => {
                log('error', `submit(${msg.messageId}) threw: ${(e as Error)?.message ?? e}`);
                return refuse('internal_error', { message: (e as Error)?.message || String(e) });
            });
            inFlight.set(msg.messageId, promise);
            try {
                const outcome = await promise;
                if (outcome.kind === 'delivered' || outcome.kind === 'queued') remember(msg.messageId, outcome.kind);
                if (outcome.kind === 'delivered') parkedText.delete(msg.messageId);
                return outcome;
            } finally {
                inFlight.delete(msg.messageId);
            }
        },

        async withdraw(sessionId: string, messageId: string): Promise<{ removed: boolean; unsupported?: true }> {
            let target: SessionInputTarget | null | undefined;
            try { target = await deps.resolveSession(sessionId); } catch { target = null; }
            if (target && typeof target.claimQueuedSend !== 'function') return { removed: false, unsupported: true };
            const claimed = target?.claimQueuedSend?.(messageId) ?? null;
            if (claimed) {
                parkedText.delete(messageId);
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
    };
}
