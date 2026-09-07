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
 *   0. CLAIM — take every queued copy of this body out of the driver's
 *      pendingSends FIFO (adapter.claimQueuedSends). See the double-send note
 *      below; without this the module is a SECOND delivery route for a body the
 *      driver already holds, and its failure reports are not truthful.
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
 * ── SEND-NOW-DOUBLE-SEND: why step 0 exists ───────────────────────────────
 * "Send now" is pressed on a QUEUED bubble — so by construction the driver is
 * already holding that exact body in pendingSends, and drainPendingSends will
 * write it the moment the machine next reaches idle. Interrupting is precisely
 * what makes the machine reach idle. Without step 0 the two routes race, and
 * the failure report is a lie in both directions:
 *
 *   • Measured live (2026-09-07, claude-cli): interrupt written at 02:42:12.688,
 *     idle observed by the FSM at 02:42:21.685 — 9.0s. The 8s ceiling fired
 *     first, so this module returned ok:false/idle_timeout and the dashboard
 *     said "not delivered … still queued; try again". 995ms later the log reads
 *     `draining queued send` and the body WAS submitted. A user who took that
 *     advice sent it twice.
 *   • Even without the timeout, step 3's sendMessage on a body still sitting in
 *     the FIFO trips the driver's isDuplicateResend gate (same text, pendingSends
 *     non-empty ⇒ stillProcessing), which returns `duplicate` → reported as
 *     `delivered`. That "delivery" is the OTHER copy, drained on the driver's
 *     schedule, not this call's write.
 *
 * Claiming the body first collapses both routes into one: after step 0 the only
 * thing that can write that text is this function, so ok:false genuinely means
 * nothing was sent and a retry is safe, and ok:true means this call sent it once.
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
 *
 *  ★ Was 8s on the premise that "claude-cli returns to an idle prompt well under
 *  2s". Live measurement disproved it: 2026-09-07, stop key at 02:42:12.688 →
 *  busy→idle at 02:42:21.685 = 9.0s, because claude-cli does not abandon a tool
 *  call mid-flight — it waits for the running tool to return before redrawing an
 *  idle prompt, and a tool can take arbitrarily long. 15s covers that observed
 *  worst case with headroom. The ceiling is deliberately generous: a slow abort
 *  must not be reported as a failed interrupt (the turn HAS been cancelled by
 *  then — only the observation is late). */
export const INTERRUPT_IDLE_TIMEOUT_MS = 15_000;
/** Poll cadence for the busy→idle observation. */
export const INTERRUPT_IDLE_POLL_MS = 120;
/** How long to wait after the FIRST stop key before pressing it a second time.
 *
 *  Some TUIs (claude-cli measured above) treat one Ctrl-C as "finish the running
 *  tool, then stop" and only abort immediately on a second press. One extra
 *  press shortens the common case without changing the contract — we still wait
 *  for the FSM's own busy→idle, never assume the abort landed.
 *
 *  ★ Gated on confidence==='proven' (see providers/spec/interrupt-capability.ts).
 *  For a provider whose stop key is spec-DECLARED but whose busy→idle effect has
 *  never been observed live, a second unexplained control byte at an unknown TUI
 *  state is a change we have no evidence is safe — those keep the single press. */
export const INTERRUPT_SECOND_PRESS_DELAY_MS = 200;

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
    /** SEND-NOW-DOUBLE-SEND: remove every queued copy of `text` from the driver
     *  FIFO, returning how many were taken. Optional: an adapter without it
     *  simply has no second delivery route to reconcile. */
    claimQueuedSends?(text: string): number;
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
 * `secondPress`, when supplied, is invoked ONCE after `secondPressAfterMs` if
 * the session is still busy by then — the extra stop-key press described at
 * INTERRUPT_SECOND_PRESS_DELAY_MS. It is skipped entirely once idle is observed,
 * so a CLI that stopped on the first press never sees a stray control byte at
 * its idle prompt.
 *
 * Exported for the regression test, which asserts the ORDER of the three steps
 * against a real adapter rather than a stub.
 */
export async function waitForIdleAfterInterrupt(
    adapter: InterruptibleAdapter,
    timeoutMs: number = INTERRUPT_IDLE_TIMEOUT_MS,
    pollMs: number = INTERRUPT_IDLE_POLL_MS,
    options?: { secondPress?: () => void; secondPressAfterMs?: number },
): Promise<boolean> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const secondPressAt = options?.secondPress
        ? startedAt + (options.secondPressAfterMs ?? INTERRUPT_SECOND_PRESS_DELAY_MS)
        : Number.POSITIVE_INFINITY;
    let pressed = false;
    for (;;) {
        const status = readStatus(adapter);
        if (status !== undefined && !BUSY_STATUSES.has(status)) return true;
        const now = Date.now();
        if (now >= deadline) return false;
        if (!pressed && now >= secondPressAt) {
            pressed = true;
            // Still busy after the first press. interruptTurn re-validates
            // capability and 'generating' before writing, so this is a no-op if
            // the session has meanwhile parked on a modal.
            options?.secondPress?.();
        }
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
    options?: { meshTaskId?: string; timeoutMs?: number; pollMs?: number; secondPressAfterMs?: number },
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

    // Step 0 — claim the body. Ordered AFTER interruptTurn deliberately: every
    // rejection above leaves the session untouched, so the queued copy must stay
    // exactly where it was and keep its ordinary drain. From here on the stop key
    // HAS been written and this call owns the delivery.
    const claimed = typeof adapter.claimQueuedSends === 'function'
        ? adapter.claimQueuedSends(text)
        : 0;
    if (claimed > 0) {
        LOG.info('SendNow', `[${adapter.cliType}] claimed ${claimed} queued copy/copies of this body — this call is now its only delivery route`);
    }

    // Step 2 — wait for the FSM to observe busy→idle before writing anything.
    // A provider with a live-proven stop key gets one extra press partway
    // through: see INTERRUPT_SECOND_PRESS_DELAY_MS.
    const wentIdle = await waitForIdleAfterInterrupt(adapter, options?.timeoutMs, options?.pollMs, {
        secondPress: interrupted.confidence === 'proven'
            ? () => { void adapter.interruptTurn?.(); }
            : undefined,
        secondPressAfterMs: options?.secondPressAfterMs,
    });
    if (!wentIdle) {
        // The stop key WAS written, so the turn is very likely already aborted;
        // only the observation timed out. The body was deliberately NOT sent, and
        // step 0 removed the queued copy that would otherwise have been drained
        // behind our back — so "not delivered, retry is safe" is now literally
        // true rather than the half-truth that produced a duplicate send live.
        LOG.warn('SendNow', `[${adapter.cliType}] interrupt sent but session never reported idle within ${options?.timeoutMs ?? INTERRUPT_IDLE_TIMEOUT_MS}ms (claimed=${claimed}, body NOT delivered)`);
        return {
            ok: false,
            reason: 'idle_timeout',
            message: `The stop key was sent to ${adapter.cliType}, but the session did not return to idle in time, so the message was not delivered. `
                + 'Nothing was sent — send it again when the agent settles.',
        };
    }

    // Step 3 — ordinary send. Same call an idle send makes; the driver's own
    // gates still apply and a re-park is reported as queued, not as delivered.
    const sendResult = await adapter.sendMessage(text, options?.meshTaskId ? { meshTaskId: options.meshTaskId } : undefined);
    const queued = sendResult?.status === 'queued';
    LOG.info(
        'SendNow',
        `[${adapter.cliType}] interrupt(${interrupted.keyName}, ${interrupted.confidence}) → idle → ${queued ? 'requeued' : 'delivered'} (claimed=${claimed})`,
    );
    return {
        ok: true,
        delivered: !queued,
        queued,
        keyName: interrupted.keyName,
        confidence: interrupted.confidence,
    };
}
