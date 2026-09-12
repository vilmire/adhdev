/**
 * SEND-NOW-AGENT-QUEUE: deliver a parked body into a GENERATING session by
 * letting the CLI's OWN input queue take it — no interrupt, no lost turn.
 *
 * ── Why this exists alongside interrupt-and-deliver ───────────────────────
 * `commands/interrupt-and-deliver.ts` is the steering primitive: it presses the
 * provider's stop key, waits for busy→idle, and delivers the body as a genuine
 * new turn. It is correct, and it is unchanged by this module. But it pays a
 * price the owner does not always want: the turn in flight is ABORTED and its
 * work is lost. Pressing "Send now" to add a follow-up thought should not have
 * to kill the answer being written.
 *
 * Several CLIs already solve this themselves. claude-cli holds input typed
 * during a turn in its own queue, shows "Press up to edit queued messages", and
 * answers it as the next turn. That is exactly the semantics the owner wanted,
 * and reaching it needs no interrupt at all — only a write the TUI accepts.
 *
 * ── The write shape is the whole mechanism ────────────────────────────────
 * oss 6cca365b retired `forceSendMessage` after measuring that a body written
 * during generation was never consumed while the caller was told it had been
 * sent. That measurement was correct, and its conclusion was over-general.
 * Re-measured live (2026-09-12, claude-cli v2.1.220, node-pty direct):
 *
 *   ATOMIC  write(`${text}\r`)               → NOT consumed. The exact shape
 *                                              forceSendMessage used.
 *   SPLIT   write(text) … gap … write('\r')  → CONSUMED and queued by the CLI.
 *
 * So the failure belonged to the combined write, not to writing during a turn.
 * The driver primitive this module calls
 * (FsmDriver.sendMessageDuringGeneration) implements only the SPLIT shape, and
 * the atomic shape stays forbidden everywhere.
 *
 * ── Scope, deliberately narrow ────────────────────────────────────────────
 *  • POSIX only. 6cca365b's revert to the atomic write was driven by a win32
 *    ConPTY regression (a delayed lone CR is absorbed as a literal newline
 *    rather than recognised as a submit) which has not been re-measured — no
 *    win32 machine was available. The driver refuses win32 before reading any
 *    state, and this module's callers fall back to their previous behaviour.
 *  • Explicit user intent only. Nothing autonomous reaches here: not the FIFO
 *    drain, not mesh dispatch, not a plain `send_chat`. Only a dashboard
 *    "Send now" press, which carries `sendNow: true`.
 *  • Generating sessions only. At idle the ordinary send is strictly better (a
 *    real turn, answered immediately), and an approval-parked session is not a
 *    composer at all. Both are refused by the driver, not by a guess here.
 *
 * ── Why the body is CLAIMED first ─────────────────────────────────────────
 * Same reason interrupt-and-deliver claims it (SEND-NOW-DOUBLE-SEND): "Send
 * now" is pressed on a bubble that is queued BECAUSE the driver is already
 * holding that exact body in `pendingSends`, and `drainPendingSends()` will
 * write it the moment the turn ends. Without the claim this module becomes a
 * SECOND delivery route for the same text: the CLI queues our copy, the turn
 * ends, the driver drains its copy, and the agent answers the same message
 * twice. The claim makes this call the only thing that can write that body, so
 * `queuedWithAgent: true` means it was sent exactly once.
 *
 * The claim is also what makes failure safe. If the driver refuses the write,
 * the body has been taken out of the FIFO and nothing has been written — so it
 * is put BACK (see restoreOnRefusal below) rather than silently dropped.
 */

import { LOG } from '../logging/logger.js';
import type { QueuedWriteOutcome } from '../providers/spec/fsm-driver.js';

/** The adapter surface this module needs. Structural rather than a class import
 *  so a test double (and an out-of-tree adapter) can satisfy it. */
export interface QueueWritableAdapter {
    cliType: string;
    /** SEND-NOW-AGENT-QUEUE: the split write. Optional — an adapter without it
     *  simply has no mid-generation path, reported as `not_supported`. */
    sendMessageDuringGeneration?(text: string, bracketedPaste?: boolean): QueuedWriteOutcome;
    /** SEND-NOW-DOUBLE-SEND: remove every queued copy of `text` from the driver
     *  FIFO, returning how many were taken. */
    claimQueuedSends?(text: string): number;
    /** Ordinary send, used ONLY to put a claimed body back after a refusal. */
    sendMessage?(text: string, options?: { force?: boolean }): Promise<{ status: 'queued' | 'delivered' } | void>;
}

export type QueuedWriteFailure = {
    ok: false;
    /** Mirrors the driver's refusal so the caller can distinguish "this session
     *  can never do it" (platform_unsupported / not_supported) from "not right
     *  now" (not_generating / send_in_flight). */
    reason: string;
    message: string;
    /** True when the claimed body was successfully returned to the driver FIFO,
     *  so the ordinary idle drain will still deliver it. False means the caller
     *  must keep its own copy visible — nothing holds the body anymore. */
    restored: boolean;
};

export type QueuedWriteSuccess = {
    ok: true;
    /** How many copies were taken out of the driver FIFO before writing. Zero is
     *  normal for a body the dashboard never parked (a direct press on a fresh
     *  message); it is not an error. */
    claimed: number;
};

export type QueuedWriteResult = QueuedWriteSuccess | QueuedWriteFailure;

function describe(reason: string): string {
    switch (reason) {
        case 'platform_unsupported':
            return 'Send now without interrupting is not available on Windows yet.';
        case 'not_supported':
            return 'This session does not support sending while the agent is working.';
        case 'not_generating':
            return 'The agent is not generating right now.';
        case 'send_in_flight':
            return 'A previous message is still being submitted.';
        case 'not_ready':
            return 'The session is not ready to accept input yet.';
        case 'duplicate':
            return 'That message is already being delivered.';
        default:
            return 'The message could not be handed to the agent queue.';
    }
}

/**
 * Hand `text` to the agent's own input queue while it is generating.
 *
 * Returns `ok: true` only when the split write actually reached the PTY. Every
 * failure path reports what was written (nothing) and whether the claimed body
 * was restored, so the caller never has to guess whether a retry would double
 * the message.
 */
export async function sendNowIntoAgentQueue(
    adapter: QueueWritableAdapter,
    text: string,
): Promise<QueuedWriteResult> {
    if (typeof adapter.sendMessageDuringGeneration !== 'function') {
        return {
            ok: false,
            reason: 'not_supported',
            message: describe('not_supported'),
            // Nothing was claimed, so nothing needed restoring: the driver still
            // holds whatever it held before this call.
            restored: true,
        };
    }

    // ★ Claim BEFORE writing. See the double-send note in the module header.
    // A claim of 0 is the ordinary case for an unparked body and is not an error.
    const claimed = typeof adapter.claimQueuedSends === 'function'
        ? adapter.claimQueuedSends(text)
        : 0;

    const outcome = adapter.sendMessageDuringGeneration(text);
    if (outcome.accepted) {
        LOG.info(
            'SendNowQueue',
            `[${adapter.cliType}] handed to agent input queue (len=${text.length}, claimed=${claimed})`,
        );
        return { ok: true, claimed };
    }

    // ── Refused: nothing was written. Put the claimed body back. ─────────────
    // Skipping this would turn a refusal into silent data loss: the dashboard
    // shows the bubble as still queued (correctly — we report failure), but the
    // driver would no longer hold it, so the idle drain that the bubble promises
    // would never fire. The restore goes through the ORDINARY sendMessage, which
    // re-parks it exactly the way the original send did.
    let restored = claimed === 0;
    if (claimed > 0 && typeof adapter.sendMessage === 'function') {
        try {
            await adapter.sendMessage(text);
            restored = true;
        } catch (e) {
            LOG.error(
                'SendNowQueue',
                `[${adapter.cliType}] FAILED to restore ${claimed} claimed send(s) after refusal `
                + `(${outcome.reason}, len=${text.length}): ${(e as Error)?.message}`,
            );
        }
    }

    LOG.info(
        'SendNowQueue',
        `[${adapter.cliType}] mid-generation send refused — ${outcome.reason} `
        + `(len=${text.length}, claimed=${claimed}, restored=${restored})`,
    );
    return {
        ok: false,
        reason: outcome.reason,
        message: describe(outcome.reason),
        restored,
    };
}
