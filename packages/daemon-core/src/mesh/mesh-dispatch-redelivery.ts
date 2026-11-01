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
import type { ConsumeView } from '../sessions/input-consume-ack.js';

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
    /** Durable consume-ACK journal (design 2026-11-01). Absent = never resend. */
    consume?: { read(messageId: string): ConsumeView | undefined; claimRetry(messageId: string): boolean };
}

export type RedeliverResult = 'probe_requested' | 'not_resent' | 'retry_claimed' | 'already_consumed';

/**
 * `TurnLedgerPorts.redeliver`. This port NEVER re-sends: the one sanctioned
 * resend path is the ledger's H2r reclaim (exact writer stop confirmed, then a
 * requeue under a NEW nonce = a new messageId, bounded by RECLAIM_BUDGET).
 * What the consume-ACK journal adds here: an application-ACKed/consumed input is
 * reported (the probe then moves the attempt on to consumed instead of H2r
 * reclaiming it), and a PROVEN not_consumed input spends its single retry
 * (`claimRetry`, atomic, once per messageId) so the journal, the notice
 * inventory and later callers all see the one resend as taken.
 */
export function redeliverDispatch(request: RedeliverRequest, deps: RedeliverDeps = {}): RedeliverResult {
    const view = request.messageId && deps.consume ? safeRead(deps, request.messageId) : undefined;
    let result: RedeliverResult | undefined;
    if (view?.state === 'consumed') {
        result = 'already_consumed';
    } else if (view?.state === 'not_consumed' && request.messageId && deps.consume) {
        try { if (deps.consume.claimRetry(request.messageId)) result = 'retry_claimed'; } catch { /* fail closed */ }
    }
    let probed = false;
    if (deps.probe) {
        try { deps.probe(request.attemptId); probed = true; } catch (error) {
            LOG.warn('TurnLedger', `redeliver for attempt ${request.attemptId}: probe request failed: ${(error as Error)?.message ?? error}`);
        }
    }
    LOG.info(
        'TurnLedger',
        `redeliver for attempt ${request.attemptId} g${request.generation}${request.taskId ? ` task ${request.taskId}` : ''} on ${request.sessionId}`
        + ` (messageId ${request.messageId ?? 'none'}${result ? `, ${result}` : ''}${view ? `, consume=${view.state}${view.restored ? ' restored' : ''}` : ''}): delivered but not consumed within the consume grace — not re-sending; `
        + (probed ? 'probing its transcript now (H2r reclaims if it stays unconsumed)' : 'no probe port; H2r reclaims if it stays unconsumed'),
    );
    return result ?? (probed ? 'probe_requested' : 'not_resent');
}

function safeRead(deps: RedeliverDeps, messageId: string): ConsumeView | undefined {
    try { return deps.consume!.read(messageId); } catch { return undefined; }
}
