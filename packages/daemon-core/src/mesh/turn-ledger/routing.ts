// ---------------------------------------------------------------------------
// turn-ledger/routing — which local coordinator session takes a notice (C2)
// ---------------------------------------------------------------------------
// Wiring-unification C-W3. PURE: a function of the notice's addressing and a
// snapshot of this daemon's coordinator sessions for the mesh. It replaces the
// routing half of `injectMeshSystemMessage` / `flushPendingForMeshIdleCoordinators`
// / the reconcile tick's strict-session hold (`mesh-reconcile-coordinator-drain.ts`)
// with three answers the deliver consumer acts on:
//
//   deliver — a session to submit to now (idle, not modal-parked);
//   wait    — the right session exists (or should) but is not ready: await the
//             named bus edge, bounded by the entry's `at + deliveryCeilingMs`;
//   none    — no coordinator session for the mesh on this daemon at all: the
//             cursor passes (an MCP-only coordinator reads + acks the notice
//             over IPC, and a CLI coordinator that registers later takes it
//             from the backlog on its `registered` edge).
//
// The hold layers this folds (brief §2.3, bucket a):
//   #2 generating coordinator  → wait `input_ready` (C-W5's `input_state` edge;
//                                 `status` edges until then), escalate at the
//                                 ceiling (120 s — unchanged).
//   #3 modal-parked            → wait `modal_cleared`; never a raw write into a
//                                 modal. At the ceiling a `queue`-mode submit is
//                                 safe (the adapter FIFO drains at the next turn
//                                 boundary, never into the modal).
//   #4 strict-session route    → wait `registered` for the addressed session,
//                                 escalate to any coordinator of the mesh at the
//                                 ceiling (60 → 120 s, stamped in C1).
// ---------------------------------------------------------------------------

import { sessionIdsEquivalent } from '@adhdev/mesh-shared';

/** One live coordinator session of the mesh on this daemon. */
export interface CoordinatorSessionView {
    sessionId: string;
    /** True when the session can take a send right now (raw adapter idle). */
    idle: boolean;
    /** Parked on a human-await modal (approval / AskUserQuestion). */
    modalParked: boolean;
}

export type RouteWait = 'registered' | 'input_ready' | 'modal_cleared';

export type NoticeRoute =
    | { kind: 'deliver'; sessionId: string; escalated: boolean }
    | { kind: 'wait'; sessionId: string | null; waitFor: RouteWait }
    | { kind: 'none' };

export interface RouteNoticeInput {
    /** `turn.notify.targetSessionId` — a specific coordinator session, when the producer knew it. */
    targetSessionId?: string | null;
    coordinators: readonly CoordinatorSessionView[];
    /** True once `now >= entry.at + deliveryCeilingMs`. */
    pastCeiling: boolean;
}

function ready(view: CoordinatorSessionView): boolean {
    return view.idle && !view.modalParked;
}

/** Prefer an idle, non-modal coordinator; stable order otherwise. */
function bestOf(views: readonly CoordinatorSessionView[]): CoordinatorSessionView | null {
    return views.find(ready) ?? views.find((v) => !v.modalParked) ?? views[0] ?? null;
}

/**
 * Route one notice. Deterministic for a given snapshot; the deliver consumer
 * re-evaluates on every edge it wakes on.
 */
export function routeNotice(input: RouteNoticeInput): NoticeRoute {
    const { coordinators, pastCeiling } = input;
    const wanted = input.targetSessionId || null;
    if (wanted) {
        const target = coordinators.find((c) => sessionIdsEquivalent(c.sessionId, wanted));
        if (target) {
            if (ready(target)) return { kind: 'deliver', sessionId: target.sessionId, escalated: false };
            if (!pastCeiling) return { kind: 'wait', sessionId: target.sessionId, waitFor: target.modalParked ? 'modal_cleared' : 'input_ready' };
            // Ceiling on a busy/modal target: an idle sibling takes it now,
            // otherwise the target's own FIFO (queue mode never writes into a modal).
            const sibling = coordinators.find((c) => c !== target && ready(c));
            return { kind: 'deliver', sessionId: sibling?.sessionId ?? target.sessionId, escalated: true };
        }
        // No coordinator session of this mesh lives here at all: the addressed
        // session is an MCP-only coordinator (it reads + acks over IPC) or one
        // that has not launched — never block the mesh's cursor on it.
        if (coordinators.length === 0) return { kind: 'none' };
        // A sibling coordinator exists, so the addressed one is restarting or
        // about to register: wait for it, bounded by the ceiling.
        if (!pastCeiling) return { kind: 'wait', sessionId: wanted, waitFor: 'registered' };
        const escalate = bestOf(coordinators);
        return escalate ? { kind: 'deliver', sessionId: escalate.sessionId, escalated: true } : { kind: 'none' };
    }
    if (coordinators.length === 0) return { kind: 'none' };
    const idle = coordinators.find(ready);
    if (idle) return { kind: 'deliver', sessionId: idle.sessionId, escalated: false };
    if (!pastCeiling) {
        const first = coordinators.find((c) => !c.modalParked);
        return first
            ? { kind: 'wait', sessionId: null, waitFor: 'input_ready' }
            : { kind: 'wait', sessionId: null, waitFor: 'modal_cleared' };
    }
    const escalate = bestOf(coordinators)!;
    return { kind: 'deliver', sessionId: escalate.sessionId, escalated: true };
}
