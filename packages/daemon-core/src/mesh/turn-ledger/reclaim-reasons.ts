/** Reclaim causes of a turn (pure helpers, split out of reducer.ts). */
import type { TurnReason } from '@adhdev/mesh-shared';
import type { TurnAttempt } from './types.js';

/**
 * Every reason a reclaim is emitted with (the "reclaims" block of
 * TURN_REASONS). A `mesh_direct` attempt commits `failed` with one of these as
 * its terminal reason — that is how a consumer (the coordinator notice) tells
 * "the direct dispatch never got a turn and nothing will redeliver it" apart
 * from a turn that ran and failed.
 */
export const RECLAIM_TURN_REASONS = [
    'dispatch_refused_session_exited', 'dispatch_refused_no_target', 'dispatch_refused_unsupported_input', 'dispatch_failed',
    'session_exit', 'session_exit_before_turn', 'session_dead', 'hollow_completion',
    'assigned_stranded_dispatch_unconfirmed', 'delivered_not_consumed_redrive', 'delivered_no_turn_deadline',
    'stalled_no_output',
] as const satisfies readonly TurnReason[];

export function isReclaimTurnReason(reason: TurnReason | null | undefined): boolean {
    return !!reason && (RECLAIM_TURN_REASONS as readonly string[]).includes(reason);
}

/**
 * A committed `mesh_direct` attempt whose terminal reason is a reclaim cause:
 * the direct dispatch was not redelivered (see `reclaim`).
 */
export function isUnredeliveredDirectFailure(attempt: Pick<TurnAttempt, 'scope' | 'terminal'> | null | undefined): boolean {
    return !!attempt && attempt.scope === 'mesh_direct' && attempt.terminal?.outcome === 'failed'
        && isReclaimTurnReason(attempt.terminal.reason);
}
