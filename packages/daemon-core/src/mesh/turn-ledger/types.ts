// ---------------------------------------------------------------------------
// turn-ledger/types — the attempt, hold and effect shapes of the turn ledger
// ---------------------------------------------------------------------------
// Wiring-unification Phase C1 (docs/design/2026-09-23-wiring-unification.md §5).
// The turn ledger is the only "done" authority for every session. This module
// is types only (plus the state vocabulary); the reducer lives in reducer.ts and
// the transition table in transitions.ts. Evidence types come from mesh-shared
// because worker daemons and the MCP server build them.
// ---------------------------------------------------------------------------

import type {
    WorkerReportOutcome,
    CommitStrength,
    ConsumeProfile,
    EvidenceSourceId,
    HoldReason,
    LivenessResult,
    NotifyKind,
    SummaryRef,
    TurnOutcome,
    TurnReason,
    TurnScope,
} from '@adhdev/mesh-shared';

export type { HoldReason, TurnScope } from '@adhdev/mesh-shared';

export const TURN_STATES = [
    'accepted', 'delivered', 'consumed', 'generating', 'suspended', 'finalizing',
    'completed', 'failed', 'cancelled',
] as const;
export type TurnState = typeof TURN_STATES[number];

export const NONTERMINAL_TURN_STATES = ['accepted', 'delivered', 'consumed', 'generating', 'suspended', 'finalizing'] as const;
export type NonterminalTurnState = typeof NONTERMINAL_TURN_STATES[number];
export const TERMINAL_TURN_STATES = ['completed', 'failed', 'cancelled'] as const satisfies readonly TurnOutcome[];
export type TerminalTurnState = typeof TERMINAL_TURN_STATES[number];

export function isTerminalTurnState(state: TurnState): state is TerminalTurnState {
    return (TERMINAL_TURN_STATES as readonly string[]).includes(state);
}

export interface TurnTerminal {
    outcome: TurnOutcome;
    reason: TurnReason;
    source: EvidenceSourceId;
    strength: CommitStrength;
    at: number;
    /** Text pointer carried by the committing evidence (never the text itself). */
    summary?: SummaryRef;
}

/** Content-free annotations stored on the attempt (`data_json`). */
export interface TurnAttemptData {
    gitSideEffect?: { dirty: boolean; commitsSinceDispatch: number; attributable: boolean; at: number };
    /** R12r: how many report-awaiting idle ends the worker resumed from (false idles). Diagnostics only. */
    falseIdleCount?: number;
    /**
     * R17g: the worker report recorded while the session was still generating —
     * content-free (outcome enum, the local evidence id whose envelope holds the
     * text, the handoff pointer when one was published). Scoped to `generation`:
     * a reclaim leaves it behind and the guards ignore it for the new generation.
     */
    report?: { generation: number; outcome: WorkerReportOutcome; eventId: string; at: number; summary?: SummaryRef };
}

export interface TurnAttempt {
    attemptId: string;
    scope: TurnScope;
    meshId: string | null;
    taskId: string | null;
    /** Retry after a terminal failure opens a new row with attemptNo + 1. */
    attemptNo: number;
    sessionId: string;
    nodeId: string | null;
    providerType: string | null;
    /** Daemon that owns this attempt's ledger row (the coordinator's daemon). */
    ownerDaemonId: string;
    /** Bumped by every reclaim; evidence must match it. */
    generation: number;
    /** One-back generation, for R27 (late completion from the superseded run). */
    prevGeneration: { sessionId: string; consumed: boolean } | null;
    dispatchNonce: number | null;
    /** D's OutboundMessage.messageId of the dispatch. */
    messageId: string | null;
    consumeProfile: ConsumeProfile;
    /** Hollow-completion retries allowed before failing (mesh policy maxTaskRetries). */
    maxTaskRetries: number;
    state: TurnState;
    suspension: 'approval' | 'choice' | null;
    redriveCount: number;
    reclaimCount: number;
    hollowCount: number;
    livenessFailStreak: number;
    lastLiveness: LivenessResult | null;
    coordinator: { daemonId: string | null; sessionId: string | null };
    acceptedAt: number;
    deliveredAt: number | null;
    consumedAt: number | null;
    lastActivityAt: number | null;
    weakSince: number | null;
    /** Generation whose `candidate` notice already went out (once per generation). */
    candidateNotifiedGeneration: number | null;
    lastNoProgressNoticeAt: number | null;
    /** `coordinator_ack` of the terminal notification. */
    notifiedAt: number | null;
    terminal: TurnTerminal | null;
    data: TurnAttemptData;
}

export type HoldOnExpire = 'commit' | 'release' | 'escalate' | 'reclaim' | 'redeliver' | 'reevaluate';

export interface TurnHold {
    /** `${attemptId}:${reason}` — one hold per reason per attempt. */
    holdId: string;
    attemptId: string;
    /** Generation the hold belongs to; null = generation-agnostic (hard_ceiling). */
    generation: number | null;
    reason: HoldReason;
    /** Epoch ms; null = released only by evidence (bounded by hard_ceiling). */
    until: number | null;
    onExpire: HoldOnExpire;
    /** Content-free: held evidence id, held modal kind, extension markers. */
    data: Readonly<Record<string, string | number | boolean | null>>;
    createdAt: number;
}

/** SessionLifecycleEvent{kind:'turn'} payload (B1 bus). */
export interface TurnBusEvent {
    kind: 'turn';
    phase: 'started' | 'suspended' | 'resumed' | 'progress' | 'committed';
    sessionId: string;
    attemptId: string;
    generation: number;
    outcome?: TurnOutcome;
    strength?: CommitStrength;
}

export type TurnEffect =
    /** Terminal write: attempt terminal columns + `committed` event row. */
    | { kind: 'commit'; attemptId: string; generation: number; outcome: TurnOutcome; strength: CommitStrength; reason: TurnReason; source: EvidenceSourceId; summary?: SummaryRef }
    /** Publish a `turn.notify` for the attempt's coordinator (mesh scopes only). */
    | { kind: 'notify_coordinator'; attemptId: string; generation: number; notify: NotifyKind; taskId: string | null; coordinatorDaemonId: string | null; coordinatorSessionId: string | null
        /** Text pointer (published as the entry's append `ref`, never inline). */
        summary?: SummaryRef
        /**
         * Local evidence row whose envelope carries this notice's text, when it is
         * not the evidence that produced the notice (a hold-expiry commit renders
         * the text of the end that opened the hold). Local id, never published.
         */
        textEventId?: string }
    | { kind: 'hold'; hold: TurnHold }
    | { kind: 'release_hold'; attemptId: string; reasons: readonly HoldReason[] | '*' }
    /** Generation + 1, state accepted, reclaimCount + 1 (the attempt returned already reflects it). */
    | { kind: 'reclaim'; attemptId: string; fromGeneration: number; toGeneration: number; reason: TurnReason }
    /** Same generation re-submit of the dispatch `messageId` (D's driver dedupes). */
    | { kind: 'redeliver'; attemptId: string; generation: number; messageId: string | null; sessionId: string }
    /**
     * Withdraw a queued prompt / stop a superseded session. `revokeBind` (C1
     * owner revision 2026-09-23): a reclaim or an R27a adoption also revokes
     * that session's worker bind + task tokens, so the cut generation cannot
     * report through the MCP after the cut. The decision is recorded inside
     * the ledger txn; the in-memory revocation runs post-commit.
     */
    | { kind: 'cancel_dispatch'; attemptId: string; generation: number; sessionId: string; messageId?: string | null; revokeBind?: boolean }
    | { kind: 'bus'; event: TurnBusEvent }
    /** Audit-only `turn_events` note (recorded / rejected verdicts). */
    | { kind: 'record'; note: string }
    /** Post-commit: the instance drops its `attemptRef`. */
    | { kind: 'release_attempt_ref'; attemptId: string; sessionId: string }
    /** `mesh_queue` row status — an effect of the ledger, never the reverse. */
    | { kind: 'queue_status'; meshId: string; taskId: string; status: TurnOutcome | 'pending'; reason: TurnReason }
    /** Graph runner steps 2–5 (outputs, graph advance, wake) for a committed task. */
    | { kind: 'graph_advance'; meshId: string; taskId: string; outcome: TurnOutcome }
    /** Scheduler must probe the session now (H4). */
    | { kind: 'probe'; attemptId: string; sessionId: string }
    /** Re-reduce held evidence (R16 hold expiry, H7). */
    | { kind: 'reevaluate'; attemptId: string; evidenceId: string; forceLiveFalse: boolean };

export type TurnEffectKind = TurnEffect['kind'];

export type ReduceVerdict = 'applied' | 'recorded' | 'rejected';

export type ReduceRejection =
    | 'no_attempt'
    | 'attempt_mismatch'
    | 'session_mismatch'
    | 'already_terminal'
    | 'illegal_transition';
