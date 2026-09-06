/**
 * SEND-NOW: interrupt the turn in flight, then deliver a parked message as a
 * genuine new turn.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 * The dashboard's "Send now" affordance (the button inside a queued chat
 * bubble) has exactly one honest implementation. Writing the body into a
 * generating PTY is NOT it: the bytes sit in the TUI's input buffer, the LLM
 * never reads them, and the caller still gets a success signal. That is the
 * measured data-loss defect that retired force-inject in oss 6cca365b — see
 * the header of providers/spec/interrupt-capability.ts. This module must never
 * grow a path that writes message bytes while the session is generating.
 *
 * The supported sequence is:
 *
 *   1. INTERRUPT — press the provider's OWN stop key, resolved from the spec
 *      that session actually loaded (SpecCliAdapter.interruptTurn). The turn in
 *      flight is aborted and LOST; that is inherent to steering, not a defect.
 *   2. WAIT for the FSM to observe busy→idle. The interrupt is a PTY write, so
 *      it is asynchronous by nature: returning before idle would hand the body
 *      to sendMessage() while canSendNow() is still false, which parks it in
 *      the driver FIFO again — the exact state the user pressed the button to
 *      leave.
 *   3. DELIVER via the ordinary adapter.sendMessage(). No force flag, no
 *      special write path. If the session somehow re-enters busy between the
 *      poll and the send, the driver's own queue gates (readySeenOnce,
 *      isSendInFlight, idle) park it and we report `queued` honestly rather
 *      than claiming a delivery that did not happen.
 *
 * ── What this module deliberately does NOT do ─────────────────────────────
 * It does not bypass the modal park guard (cli-provider-instance.isModalParked)
 * or the driver's send gates, because it does not have its own write path at
 * all — step 3 is the same call an ordinary send makes. A session parked on an
 * approval modal reports status 'waiting_approval', not 'generating', so
 * interruptTurn() refuses it with reason 'not_busy' before anything is written.
 */

import { LOG } from '../logging/logger.js';

/** How long to wait for the FSM to observe busy→idle after the stop key lands.
 *  Measured: claude-cli returns to an idle prompt well under 2s; the ceiling is
 *  generous because a slow abort must not be reported as a failed interrupt
 *  (the turn HAS been cancelled by then — only the observation is late). */
export const INTERRUPT_IDLE_TIMEOUT_MS = 8_000;
/** Poll cadence for the busy→idle observation. */
export const INTERRUPT_IDLE_POLL_MS = 120;

/** Statuses that mean the session is not free to accept a new turn. */
const BUSY_STATUSES = new Set(['generating', 'starting', 'waiting_approval', 'waiting_choice']);

export type InterruptAndDeliverOutcome =
    | {
          ok: true;
          /** Whether the parked body was actually written to the PTY, or parked
           *  again in the driver FIFO. Reported verbatim to the dashboard. */
          delivered: boolean;
          queued: boolean;
          /** Stop key that was pressed, for logs/telemetry. */
          keyName: string;
          /** 'declared' means the stop key is spec-declared but the busy→idle
           *  effect has not been observed live for this provider. Surfaced so
           *  the operator is not shown an unverified interrupt as a sure thing. */
          confidence: 'proven' | 'declared';
      }
    | {
          ok: false;
          /** Machine-readable cause. 'idle_timeout' means the stop key WAS
           *  written but the session never reported idle — the turn is likely
           *  aborted, the body was not sent, and a retry is safe. */
          reason: string;
          message: string;
      };

/** The adapter surface this helper needs. Structural, so both the spec adapter
 *  and any test double satisfy it without importing the concrete class. */
export interface InterruptibleAdapter {
    cliType: string;
    getStatus(options?: { allowParse?: boolean }): { status?: string } | undefined;
    sendMessage(text: string, options?: { force?: boolean; meshTaskId?: string }): Promise<{ status: 'queued' | 'delivered' } | void>;
    interruptTurn?(): Promise<
        | { ok: true; keyName: string; bytes: number; confidence: 'proven' | 'declared' }
        | { ok: false; reason: string; message: string }
    >;
}

function readStatus(adapter: InterruptibleAdapter): string | undefined {
    try {
        return adapter.getStatus()?.status;
    } catch {
        return undefined;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait for the adapter to leave every busy status. Resolves true on the first
 * observed non-busy status, false on timeout.
 *
 * Exported for the regression test, which asserts the ORDER of the three steps
 * against a real adapter rather than a stub.
 */
export async function waitForIdleAfterInterrupt(
    adapter: InterruptibleAdapter,
    timeoutMs: number = INTERRUPT_IDLE_TIMEOUT_MS,
    pollMs: number = INTERRUPT_IDLE_POLL_MS,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const status = readStatus(adapter);
        if (status !== undefined && !BUSY_STATUSES.has(status)) return true;
        if (Date.now() >= deadline) return false;
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
}

/**
 * Interrupt the in-flight turn and then deliver `text` as a new turn.
 *
 * Never writes `text` while the session is generating: the send is issued only
 * after busy→idle is observed, and even then it goes through the ordinary
 * sendMessage() gates.
 */
export async function interruptAndDeliver(
    adapter: InterruptibleAdapter,
    text: string,
    options?: { meshTaskId?: string; timeoutMs?: number; pollMs?: number },
): Promise<InterruptAndDeliverOutcome> {
    if (typeof adapter.interruptTurn !== 'function') {
        return {
            ok: false,
            reason: 'interrupt_not_implemented',
            message: `Provider '${adapter.cliType}' runs on an adapter that cannot interrupt a turn. `
                + 'The message stays queued and will be delivered when the agent finishes on its own.',
        };
    }

    // Step 1 — press the provider's own stop key. Capability (does a stop key
    // exist, is it non-empty, is the session actually generating) is validated
    // inside interruptTurn BEFORE any byte is written, so an unsupported
    // provider fails here rather than reporting a write that did nothing.
    const interrupted = await adapter.interruptTurn();
    if (!interrupted.ok) {
        LOG.warn('SendNow', `[${adapter.cliType}] interrupt refused: ${interrupted.reason}`);
        return { ok: false, reason: interrupted.reason, message: interrupted.message };
    }

    // Step 2 — wait for the FSM to observe busy→idle before writing anything.
    const wentIdle = await waitForIdleAfterInterrupt(adapter, options?.timeoutMs, options?.pollMs);
    if (!wentIdle) {
        // The stop key WAS written, so the turn is very likely already aborted;
        // only the observation timed out. The body was deliberately NOT sent —
        // reporting this honestly lets the caller keep the bubble queued rather
        // than showing a delivery that never happened.
        LOG.warn('SendNow', `[${adapter.cliType}] interrupt sent but session never reported idle within ${options?.timeoutMs ?? INTERRUPT_IDLE_TIMEOUT_MS}ms`);
        return {
            ok: false,
            reason: 'idle_timeout',
            message: `The stop key was sent to ${adapter.cliType}, but the session did not return to idle in time, so the message was not delivered. `
                + 'It is still queued; try again in a moment.',
        };
    }

    // Step 3 — ordinary send. Same call an idle send makes; the driver's own
    // gates still apply and a re-park is reported as queued, not as delivered.
    const sendResult = await adapter.sendMessage(text, options?.meshTaskId ? { meshTaskId: options.meshTaskId } : undefined);
    const queued = sendResult?.status === 'queued';
    LOG.info(
        'SendNow',
        `[${adapter.cliType}] interrupt(${interrupted.keyName}, ${interrupted.confidence}) → idle → ${queued ? 'requeued' : 'delivered'}`,
    );
    return {
        ok: true,
        delivered: !queued,
        queued,
        keyName: interrupted.keyName,
        confidence: interrupted.confidence,
    };
}
