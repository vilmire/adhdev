/**
 * mesh-dispatch-redelivery — the turn ledger's `redeliver` port
 * (SUBMIT-UNCONFIRMED-RECLAIM, item ②).
 *
 * The reducer's H2 (`hold_await_consume_redrive`) emits `redeliver` when a
 * dispatch was acknowledged `delivered` but the worker never started a turn
 * within the consume grace. Until this port was wired, H2 only counted
 * `missingPort` and nothing happened.
 *
 * The port PROBES, it never re-sends. A re-send of the same messageId would
 * have to bypass the input service's settled dedupe, and every such design
 * reviewed could run a task twice: an idle worker is no proof the prompt was
 * never taken (a finished turn is idle too), and the driver's own submit state
 * for a dispatch is often `unknown` (review R1). Instead the attempt's delivered
 * probe runs NOW rather than on its next due tick: a transcript that shows the
 * prompt consumed moves the attempt on (turn evidence); otherwise H2 has re-armed
 * the consume hold and H2r reclaims the attempt under a new nonce when it
 * expires. A worker that PROVES its prompt unsent reports
 * `dispatch_failed{submit_unconfirmed}` itself (R24 reclaim, sooner).
 */

import { LOG } from '../logging/logger.js';

/** The ledger's redeliver effect, as `TurnLedgerPorts.redeliver` receives it. */
export interface RedeliverRequest {
    attemptId: string;
    generation: number;
    sessionId: string;
    messageId?: string | null;
    taskId: string | null;
}

export interface RedeliverDeps {
    /** Ask the turn scheduler to probe this attempt on its next wake (late-bound probe port). */
    probe?: (attemptId: string) => void;
}

/** `TurnLedgerPorts.redeliver`: request a probe, never re-send (see the file header). */
export function redeliverDispatch(request: RedeliverRequest, deps: RedeliverDeps = {}): 'probe_requested' | 'not_resent' {
    let probed = false;
    if (deps.probe) {
        try { deps.probe(request.attemptId); probed = true; } catch (error) {
            LOG.warn('TurnLedger', `redeliver for attempt ${request.attemptId}: probe request failed: ${(error as Error)?.message ?? error}`);
        }
    }
    LOG.info(
        'TurnLedger',
        `redeliver for attempt ${request.attemptId} g${request.generation}${request.taskId ? ` task ${request.taskId}` : ''} on ${request.sessionId}`
        + ` (messageId ${request.messageId ?? 'none'}): delivered but not consumed within the consume grace — not re-sending; `
        + (probed ? 'probing its transcript now (H2r reclaims if it stays unconsumed)' : 'no probe port; H2r reclaims if it stays unconsumed'),
    );
    return probed ? 'probe_requested' : 'not_resent';
}
