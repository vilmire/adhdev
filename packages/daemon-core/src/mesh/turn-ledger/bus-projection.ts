// ---------------------------------------------------------------------------
// turn-ledger/bus-projection — the ONLY place the turn wire names are made
// ---------------------------------------------------------------------------
// Wiring-unification C1: `agent:generating_completed` / `agent:stopped` are not
// events anyone emits any more — they survive only as WIRE NAMES projected from
// a bus `turn{phase:'committed'}` (the ledger's commit effect). The status
// reporter (C-W5) subscribes to the bus and sends this projection as its
// `status_event`; completion toasts, quota refresh and push all follow the one
// commit, so a turn can no longer be "completed" twice by two producers.
//
// Gate `check:turn-single-emitter` (scripts/check-turn-single-emitter.mjs,
// rule 3) holds every other `event: 'agent:generating_completed'|'agent:stopped'`
// object literal in daemon-core to a ratcheting baseline that reaches zero when
// C-W3/W4/W5 delete the legacy emitters.
// ---------------------------------------------------------------------------

import type { CommitStrength, TurnOutcome } from '@adhdev/mesh-shared';
import type { TurnBusEvent } from './types.js';

export const TURN_WIRE_EVENT_NAMES = ['agent:generating_completed', 'agent:stopped'] as const;
export type TurnWireEventName = typeof TURN_WIRE_EVENT_NAMES[number];

/** Content-free projection of one committed turn onto the status_event wire name. */
export interface TurnWireEvent {
    event: TurnWireEventName;
    sessionId: string;
    attemptId: string;
    generation: number;
    outcome: TurnOutcome;
    strength: CommitStrength;
    timestamp: number;
}

/** completed → generating_completed; failed / cancelled → stopped. */
export function turnWireEventName(outcome: TurnOutcome): TurnWireEventName {
    return outcome === 'completed' ? 'agent:generating_completed' : 'agent:stopped';
}

/**
 * Project a bus turn event onto the wire. Only a `committed` phase has a wire
 * name; every other phase (started/suspended/resumed/progress) returns null —
 * those travel as their own bus kinds (input_state, modal, …).
 */
export function projectTurnWireEvent(event: TurnBusEvent, at: number): TurnWireEvent | null {
    if (event.phase !== 'committed' || !event.outcome || !event.strength) return null;
    return {
        event: turnWireEventName(event.outcome),
        sessionId: event.sessionId,
        attemptId: event.attemptId,
        generation: event.generation,
        outcome: event.outcome,
        strength: event.strength,
        timestamp: at,
    };
}
