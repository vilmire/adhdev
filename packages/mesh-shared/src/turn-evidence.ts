/**
 * turn-evidence — the ONE vocabulary for "what happened to a turn".
 *
 * Wiring-unification Phase C1 (docs/design/2026-09-23-wiring-unification.md §5).
 *
 * Every producer that today decides "done" on its own (completion flush, stall
 * rescue, reconcile synthesis, MCP probes, worker report tools, …) instead
 * submits one of these evidence records to the turn ledger, whose pure reducer
 * is the only authority for a turn's state. Worker daemons and the MCP server
 * build them, so the types live here (a dependency-free leaf).
 *
 * CONTENT-FREE BY CONSTRUCTION
 * ----------------------------
 * Evidence crosses machines (seqscribe `mesh.<id>.events` replication) and must
 * never carry anything a user or an agent wrote. Every field is one of: an
 * identifier, a closed enum, a boolean, a number, or a `SummaryRef` — a pointer
 * `{topic, writer, seq}` to a content-class topic entry (`mesh.<id>.handoff`)
 * where the text actually lives. `TURN_EVIDENCE_FIELD_SPECS` declares the class
 * of every field of every member (the compiler forces it to stay total and
 * exact), the runtime guard validates against it, and a test walks it to prove
 * no free-text field exists.
 */

import { WORKER_BRANCH_STATES, WORKER_REPORT_OUTCOMES, type WorkerBranchState, type WorkerReportOutcome } from './mesh-vocabulary'
import { SESSION_STATUSES, type SessionStatus } from './session-status'
import { SEND_REFUSAL_REASONS, type SendRefusal } from './outbound-message'

// ─── closed vocabularies ─────────────────────────────────────────────────

/** Protocol version stamped on every `mesh.<id>.events` entry written by the turn ledger. */
export const MESH_TOPIC_PROTOCOL_VERSION = 2 as const

export const EVIDENCE_SOURCE_IDS = [
    'fsm_edge', 'short_gen_inline', 'completion_flush_genuine', 'completion_flush_weak',
    'monitor_final_summary', 'pre_cleanup_transcript', 'stall_transcript', 'startup_grace_collapse',
    'acp_prompt_response', 'cdp_state', 'approval_gate', 'modal_button',
    'mesh_stall_watchdog', 'status_monitor', 'pty_exit', 'provider_error',
    'coordinator_probe', 'mcp_probe', 'worker_tool', 'dispatch', 'input_service',
    'operator', 'intentional_cleanup', 'scheduler', 'git_probe', 'session_registry',
] as const
export type EvidenceSourceId = typeof EVIDENCE_SOURCE_IDS[number]

export const TURN_SCOPES = ['mesh_queue', 'mesh_direct', 'plain'] as const
export type TurnScope = typeof TURN_SCOPES[number]

/**
 * Refusals (D1 `SendRefusal`, owned by ./outbound-message) that mean the target
 * can never take this dispatch, so the attempt is reclaimed (R3). Every other
 * refusal is retried by the sender and only recorded.
 */
export const RECLAIMING_SEND_REFUSALS = ['session_exited', 'no_target', 'unsupported_input'] as const satisfies readonly SendRefusal[]
export type ReclaimingSendRefusal = typeof RECLAIMING_SEND_REFUSALS[number]

export const DELIVERY_OUTCOMES = ['delivered', 'queued'] as const
export type DeliveryOutcome = typeof DELIVERY_OUTCOMES[number]
export const DELIVERY_VIAS = ['local', 'p2p'] as const
export type DeliveryVia = typeof DELIVERY_VIAS[number]

export const DISPATCH_FAILURE_REASONS = ['worker_absent', 'transport_error', 'spawn_failed', 'rejected_by_worker', 'timeout'] as const
export type DispatchFailureReason = typeof DISPATCH_FAILURE_REASONS[number]

export const CONSUME_PROFILES = ['default', 'native_source'] as const
export type ConsumeProfile = typeof CONSUME_PROFILES[number]

export const SESSION_REBOUND_REASONS = ['restart', 'live_holder'] as const
export type SessionReboundReason = typeof SESSION_REBOUND_REASONS[number]

export const SUSPENSION_MODALS = ['approval', 'choice'] as const
export type SuspensionModal = typeof SUSPENSION_MODALS[number]
export const SUSPENSION_RESOLUTIONS = ['approved', 'rejected', 'answered'] as const
export type SuspensionResolution = typeof SUSPENSION_RESOLUTIONS[number]
export const SUSPENSION_RESOLUTION_VIAS = ['modal_button', 'auto_approve', 'prompt_answer'] as const
export type SuspensionResolutionVia = typeof SUSPENSION_RESOLUTION_VIAS[number]

export const TURN_END_STRENGTHS = ['genuine', 'weak'] as const
export type TurnEndStrength = typeof TURN_END_STRENGTHS[number]

/** Why a provider-side weak end was released (was free text `blockReason`). */
export const TURN_END_BLOCK_REASONS = [
    'missing_final_assistant', 'finalization_timeout', 'terminal_block_hard_cap', 'decoupled_completion',
] as const
export type TurnEndBlockReason = typeof TURN_END_BLOCK_REASONS[number]

export const NATIVE_TURN_OUTCOMES = ['completed', 'aborted'] as const
export type NativeTurnOutcome = typeof NATIVE_TURN_OUTCOMES[number]

export const LIVENESS_RESULTS = ['alive', 'unknown', 'read_failed', 'dead'] as const
export type LivenessResult = typeof LIVENESS_RESULTS[number]

export const PROVIDER_FAILURES = ['auth_failed', 'billing_failed'] as const
export type ProviderFailure = typeof PROVIDER_FAILURES[number]

/**
 * `daemon_restart` (wiring-unification follow-up, design §5): a boot-time
 * reconciliation observes this for a plain attempt whose session is gone
 * after a restart — the daemon never saw the session's own exit, so it is
 * not `provider_error`/`adapter_error`/etc.; it is the daemon itself
 * reporting "this session no longer exists".
 */
export const SESSION_ERROR_REASONS = ['provider_error', 'adapter_error', 'spawn_failed', 'auth_failed', 'billing_failed', 'unknown', 'daemon_restart'] as const
export type SessionErrorReason = typeof SESSION_ERROR_REASONS[number]

export const CANCEL_REASONS = ['operator_cancel', 'intentional_cleanup', 'task_removed', 'mission_abandoned', 'superseded'] as const
export type CancelReason = typeof CANCEL_REASONS[number]

export const OPERATOR_STATUSES = ['completed', 'failed'] as const
export type OperatorStatus = typeof OPERATOR_STATUSES[number]
export const OPERATOR_STATUS_REASONS = ['operator_update', 'refine_terminal', 'validation_terminal'] as const
export type OperatorStatusReason = typeof OPERATOR_STATUS_REASONS[number]

export const COORDINATOR_ACK_OUTCOMES = ['delivered', 'queued', 'duplicate'] as const
export type CoordinatorAckOutcome = typeof COORDINATOR_ACK_OUTCOMES[number]

/** Observed status as a no-progress monitor saw it (canonical session status or `unknown`). */
export const NO_PROGRESS_OBSERVED_STATUSES = [...SESSION_STATUSES, 'unknown'] as const
export type NoProgressObservedStatus = SessionStatus | 'unknown'

/**
 * Reasons a turn hold exists. Holds are attempt-scoped only (C2: delivery-side
 * waits are consumer deferral on the `turn.deliver` cursor, not hold rows).
 */
export const HOLD_REASONS = [
    'await_delivery', 'await_consume', 'await_turn', 'liveness', 'hard_ceiling',
    'live_pending', 'transcript_quiet', 'weak_candidate', 'suspension_before_consumed',
    // A genuine FSM end of a mesh turn whose worker holds a live worker-MCP bind:
    // the structured report is the primary evidence (design §F2), so the idle edge
    // only opens this hold (R9r) — a report commits (R17), a new busy edge cancels
    // it as a false idle (R12r), expiry commits weak (R13r).
    'await_report',
    // A worker report recorded while the session is still generating (R17g):
    // the report is the verdict, the idle edge is only awaited as corroboration
    // — a turn_end commits the report (R9t), expiry commits it anyway (R13t) so
    // a session whose FSM never shows the idle edge again does not wait for
    // liveness / hard_ceiling.
    'await_end',
] as const
export type HoldReason = typeof HOLD_REASONS[number]

export const TURN_OUTCOMES = ['completed', 'failed', 'cancelled'] as const
export type TurnOutcome = typeof TURN_OUTCOMES[number]

export const COMMIT_STRENGTHS = ['genuine', 'weak', 'tool_report', 'operator'] as const
export type CommitStrength = typeof COMMIT_STRENGTHS[number]

/** Every terminal or reclaim reason the ledger writes. Closed: no free-text reasons. */
export const TURN_REASONS = [
    // commits
    'turn_end', 'weak_end_confirmed', 'transcript_final', 'worker_reported',
    'finalization_timeout_no_response', 'session_error', 'provider_auth_failed', 'provider_billing_failed',
    'operator_cancel', 'intentional_cleanup', 'task_removed', 'mission_abandoned', 'superseded',
    'operator_update', 'refine_terminal', 'validation_terminal',
    'hard_ceiling', 'reclaim_budget_exhausted', 'hollow_max_retries', 'migration_orphan',
    // reclaims (generation + 1)
    'dispatch_refused_session_exited', 'dispatch_refused_no_target', 'dispatch_refused_unsupported_input', 'dispatch_failed',
    'session_exit', 'session_exit_before_turn', 'session_dead', 'hollow_completion',
    'assigned_stranded_dispatch_unconfirmed', 'delivered_not_consumed_redrive', 'delivered_no_turn_deadline',
] as const
export type TurnReason = typeof TURN_REASONS[number]

/**
 * What a `turn.notify` entry tells a coordinator.
 *
 * `late_completion` (C1 R27, owner revision 2026-09-23): a superseded
 * generation finished while the current one was already running; the
 * coordinator decides whether to salvage it (the entry carries the g−1
 * summary as its append `ref`). `mesh_event`: a non-turn coordinator notice
 * (refine terminal, worktree bootstrap, …) whose text lives only in the
 * owner's local `turn_events.payload_json` and is rendered at deliver time.
 */
export const NOTIFY_KINDS = [
    'completed', 'failed', 'cancelled', 'stopped', 'approval', 'choice', 'approval_resolved',
    'candidate', 'no_progress', 'progress', 'late_completion', 'mesh_event',
] as const
export type NotifyKind = typeof NOTIFY_KINDS[number]

// ─── shared shapes ───────────────────────────────────────────────────────

export interface TurnAttemptRef { attemptId: string; generation: number }

/**
 * Pointer to text that lives in a content-class topic entry (`mesh.<id>.handoff`).
 * Text never travels inside evidence; the deliver side renders it from the ref.
 */
export interface SummaryRef { topic: string; writer: string; seq: number }

/** Live-state observations that make a transcript end premature (admission input). */
export interface LiveTurnPending { modal: boolean; adapterPending: boolean; trailingTool: boolean; newestActivityAt?: number }

/** Structural copy of daemon-core's `CoordinatorIdentity` (this package cannot import daemon-core). */
export interface EvidenceCoordinatorIdentity { daemonId: string; coordinatorRunId: string; sessionId?: string }

export interface NativeTurnMarkerRef { outcome: NativeTurnOutcome; turnId?: string }

export interface EvidenceEnvelope {
    /** Stable id of this observation; dedupe key across republish/replication. */
    eventId: string
    /** Producer clock, epoch ms. */
    at: number
    source: EvidenceSourceId
    /** The session that produced / is the subject of the observation. */
    sessionId: string
    attemptRef?: TurnAttemptRef
    /** Only when attemptRef is absent (legacy relay / MCP probe). */
    taskId?: string
    /** Daemon id that observed it. */
    observedBy: string
}

/** Kind-specific bodies. `TurnEvidence = EvidenceEnvelope & TurnEvidenceBody`. */
export type TurnEvidenceBody =
    // ── dispatch / delivery ──
    | { kind: 'dispatch_accepted'; scope: TurnScope; messageId: string; meshId?: string; nodeId?: string; providerType?: string
        attemptNo?: number; dispatchNonce?: number; consumeProfile?: ConsumeProfile; maxTaskRetries?: number
        coordinator?: EvidenceCoordinatorIdentity }
    | { kind: 'delivered'; messageId: string; outcome: DeliveryOutcome; via: DeliveryVia }
    | { kind: 'delivery_refused'; messageId: string; reason: SendRefusal }
    | { kind: 'dispatch_failed'; workerAbsent: boolean; reason: DispatchFailureReason }
    | { kind: 'duplicate_dispatch_refusal'; holderSessionId: string; holderAttemptId?: string }
    | { kind: 'session_rebound'; toSessionId: string; reason: SessionReboundReason }
    // ── worker turn lifecycle ──
    | { kind: 'turn_started'; retro: boolean }
    | { kind: 'suspension'; modal: SuspensionModal; modalKey?: string }
    | { kind: 'suspension_resolved'; resolution: SuspensionResolution; via: SuspensionResolutionVia }
    | { kind: 'turn_end'; strength: TurnEndStrength; afterFinalizationTimeout?: boolean; hollow?: boolean; summary?: SummaryRef
        blockReason?: TurnEndBlockReason; releasedByHardCap?: boolean; nativeOutcome?: NativeTurnOutcome; live?: LiveTurnPending
        /**
         * Stamped (true only) by the WORKER's daemon when the session holds a live
         * worker-MCP session bind, i.e. the worker can call report_completion. The
         * owner then treats a genuine end as a report-awaiting candidate (R9r), not
         * a commit. Absent = no reporting surface = today's genuine-end commit.
         */
        reportExpected?: boolean }
    | { kind: 'transcript_final'; selfAttributing: boolean; nativeRead: boolean; nativeMarker?: NativeTurnMarkerRef
        live: LiveTurnPending; summary?: SummaryRef; messageAt?: number }
    | { kind: 'transcript_activity'; newestActivityAt: number }
    | { kind: 'no_progress'; stalledMs: number; observedStatus: NoProgressObservedStatus; finalAssistantPresent: boolean }
    | { kind: 'liveness'; result: LivenessResult }
    | { kind: 'process_exit'; exitCode: number | null; providerFailure?: ProviderFailure }
    | { kind: 'session_error'; reason: SessionErrorReason }
    // ── worker MCP (F2) ──
    /**
     * `summary` is the handoff-topic pointer when the report's text was published;
     * a report the owner daemon accepted itself carries its text in the evidence
     * row's local envelope instead (never published), so the pointer is optional.
     */
    | { kind: 'worker_report'; outcome: WorkerReportOutcome; summary?: SummaryRef; hasHandoffNotes: boolean
        branchState?: WorkerBranchState; touchedFileCount?: number }
    | { kind: 'worker_progress'; note?: SummaryRef }
    // ── coordinator / operator ──
    | { kind: 'git_side_effect'; dirty: boolean; commitsSinceDispatch: number; attributable: boolean }
    | { kind: 'cancel'; reason: CancelReason }
    | { kind: 'operator_status'; status: OperatorStatus; reason: OperatorStatusReason }
    | { kind: 'coordinator_ack'; notify: NotifyKind; outcome: CoordinatorAckOutcome }
    // ── scheduler-generated ──
    | { kind: 'hold_expired'; holdId: string; reason: HoldReason }

export type TurnEvidence = EvidenceEnvelope & TurnEvidenceBody
export type TurnEvidenceKind = TurnEvidenceBody['kind']
export type TurnEvidenceOf<K extends TurnEvidenceKind> = EvidenceEnvelope & Extract<TurnEvidenceBody, { kind: K }>

// ─── field-class registry (drives the guard and the content-free test) ────

/**
 * The class of every declared field. There is deliberately NO free-text class:
 * `id` strings are length-bounded and whitespace-free, so prose cannot be
 * smuggled through an identifier slot either.
 */
export type EvidenceFieldSpec =
    | { t: 'id'; optional?: true }
    | { t: 'enum'; values: readonly string[]; optional?: true }
    | { t: 'bool'; optional?: true }
    | { t: 'int'; optional?: true; nullable?: true }
    | { t: 'ms'; optional?: true }
    | { t: 'summary_ref'; optional?: true }
    | { t: 'attempt_ref'; optional?: true }
    | { t: 'live'; optional?: true }
    | { t: 'native_marker'; optional?: true }
    | { t: 'coordinator'; optional?: true }

type FieldsOf<K extends TurnEvidenceKind> = Exclude<keyof Extract<TurnEvidenceBody, { kind: K }>, 'kind'>
/** Exact per-kind registry: a missing or extra field fails to compile. */
export type TurnEvidenceFieldSpecs = { readonly [K in TurnEvidenceKind]: { readonly [F in FieldsOf<K>]-?: EvidenceFieldSpec } }

const id = { t: 'id' } as const
const idOpt = { t: 'id', optional: true } as const
const bool = { t: 'bool' } as const
const boolOpt = { t: 'bool', optional: true } as const
const ms = { t: 'ms' } as const
const msOpt = { t: 'ms', optional: true } as const
const intOpt = { t: 'int', optional: true } as const
const en = (values: readonly string[]) => ({ t: 'enum', values }) as const
const enOpt = (values: readonly string[]) => ({ t: 'enum', values, optional: true }) as const

export const EVIDENCE_ENVELOPE_FIELD_SPECS: { readonly [F in keyof EvidenceEnvelope]-?: EvidenceFieldSpec } = {
    eventId: id,
    at: ms,
    source: en(EVIDENCE_SOURCE_IDS),
    sessionId: id,
    attemptRef: { t: 'attempt_ref', optional: true },
    taskId: idOpt,
    observedBy: id,
}

export const TURN_EVIDENCE_FIELD_SPECS: TurnEvidenceFieldSpecs = {
    dispatch_accepted: {
        scope: en(TURN_SCOPES), messageId: id, meshId: idOpt, nodeId: idOpt, providerType: idOpt,
        attemptNo: intOpt, dispatchNonce: intOpt, consumeProfile: enOpt(CONSUME_PROFILES), maxTaskRetries: intOpt,
        coordinator: { t: 'coordinator', optional: true },
    },
    delivered: { messageId: id, outcome: en(DELIVERY_OUTCOMES), via: en(DELIVERY_VIAS) },
    delivery_refused: { messageId: id, reason: en(SEND_REFUSAL_REASONS) },
    dispatch_failed: { workerAbsent: bool, reason: en(DISPATCH_FAILURE_REASONS) },
    duplicate_dispatch_refusal: { holderSessionId: id, holderAttemptId: idOpt },
    session_rebound: { toSessionId: id, reason: en(SESSION_REBOUND_REASONS) },
    turn_started: { retro: bool },
    suspension: { modal: en(SUSPENSION_MODALS), modalKey: idOpt },
    suspension_resolved: { resolution: en(SUSPENSION_RESOLUTIONS), via: en(SUSPENSION_RESOLUTION_VIAS) },
    turn_end: {
        strength: en(TURN_END_STRENGTHS), afterFinalizationTimeout: boolOpt, hollow: boolOpt,
        summary: { t: 'summary_ref', optional: true }, blockReason: enOpt(TURN_END_BLOCK_REASONS),
        releasedByHardCap: boolOpt, nativeOutcome: enOpt(NATIVE_TURN_OUTCOMES), live: { t: 'live', optional: true },
        reportExpected: boolOpt,
    },
    transcript_final: {
        selfAttributing: bool, nativeRead: bool, nativeMarker: { t: 'native_marker', optional: true },
        live: { t: 'live' }, summary: { t: 'summary_ref', optional: true }, messageAt: msOpt,
    },
    transcript_activity: { newestActivityAt: ms },
    no_progress: { stalledMs: ms, observedStatus: en(NO_PROGRESS_OBSERVED_STATUSES), finalAssistantPresent: bool },
    liveness: { result: en(LIVENESS_RESULTS) },
    process_exit: { exitCode: { t: 'int', nullable: true }, providerFailure: enOpt(PROVIDER_FAILURES) },
    session_error: { reason: en(SESSION_ERROR_REASONS) },
    worker_report: {
        outcome: en(WORKER_REPORT_OUTCOMES), summary: { t: 'summary_ref', optional: true }, hasHandoffNotes: bool,
        branchState: enOpt(WORKER_BRANCH_STATES), touchedFileCount: intOpt,
    },
    worker_progress: { note: { t: 'summary_ref', optional: true } },
    git_side_effect: { dirty: bool, commitsSinceDispatch: { t: 'int' }, attributable: bool },
    cancel: { reason: en(CANCEL_REASONS) },
    operator_status: { status: en(OPERATOR_STATUSES), reason: en(OPERATOR_STATUS_REASONS) },
    coordinator_ack: { notify: en(NOTIFY_KINDS), outcome: en(COORDINATOR_ACK_OUTCOMES) },
    hold_expired: { holdId: id, reason: en(HOLD_REASONS) },
}

export const TURN_EVIDENCE_KINDS = Object.keys(TURN_EVIDENCE_FIELD_SPECS) as readonly TurnEvidenceKind[]

/** Evidence kinds that, on their own, can end a turn (the ones R18/R19/R27 reason about). */
export const TERMINAL_CLASS_EVIDENCE_KINDS = [
    'turn_end', 'transcript_final', 'no_progress', 'worker_report', 'session_error', 'process_exit', 'cancel', 'operator_status',
] as const satisfies readonly TurnEvidenceKind[]

// ─── guards ──────────────────────────────────────────────────────────────

/** Identifier shape: 1..256 chars, no whitespace or control characters. */
const IDENTIFIER_RE = /^[^\s\u0000-\u001f\u007f]{1,256}$/

function makeGuard<T extends readonly string[]>(values: T): (value: unknown) => value is T[number] {
    const set: ReadonlySet<string> = new Set(values)
    return (value: unknown): value is T[number] => typeof value === 'string' && set.has(value)
}

export const isEvidenceSourceId = makeGuard(EVIDENCE_SOURCE_IDS)
export const isTurnEvidenceKind = makeGuard(TURN_EVIDENCE_KINDS as readonly TurnEvidenceKind[])
export const isTurnReason = makeGuard(TURN_REASONS)
export const isNotifyKind = makeGuard(NOTIFY_KINDS)
export const isHoldReason = makeGuard(HOLD_REASONS)
export const isTurnOutcome = makeGuard(TURN_OUTCOMES)
export const isCommitStrength = makeGuard(COMMIT_STRENGTHS)

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isEvidenceIdentifier(value: unknown): value is string {
    return typeof value === 'string' && IDENTIFIER_RE.test(value)
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

export function isSummaryRef(value: unknown): value is SummaryRef {
    return isRecord(value)
        && hasOnlyKeys(value, ['topic', 'writer', 'seq'])
        && isEvidenceIdentifier(value.topic)
        && isEvidenceIdentifier(value.writer)
        && Number.isSafeInteger(value.seq) && (value.seq as number) >= 0
}

export function isTurnAttemptRef(value: unknown): value is TurnAttemptRef {
    return isRecord(value)
        && hasOnlyKeys(value, ['attemptId', 'generation'])
        && isEvidenceIdentifier(value.attemptId)
        && Number.isSafeInteger(value.generation) && (value.generation as number) >= 0
}

function isLiveTurnPending(value: unknown): value is LiveTurnPending {
    return isRecord(value)
        && hasOnlyKeys(value, ['modal', 'adapterPending', 'trailingTool', 'newestActivityAt'])
        && typeof value.modal === 'boolean'
        && typeof value.adapterPending === 'boolean'
        && typeof value.trailingTool === 'boolean'
        && (value.newestActivityAt === undefined || isFiniteNumber(value.newestActivityAt))
}

function isNativeMarkerRef(value: unknown): value is NativeTurnMarkerRef {
    return isRecord(value)
        && hasOnlyKeys(value, ['outcome', 'turnId'])
        && (NATIVE_TURN_OUTCOMES as readonly string[]).includes(value.outcome as string)
        && (value.turnId === undefined || isEvidenceIdentifier(value.turnId))
}

function isCoordinatorIdentity(value: unknown): value is EvidenceCoordinatorIdentity {
    return isRecord(value)
        && hasOnlyKeys(value, ['daemonId', 'coordinatorRunId', 'sessionId'])
        && isEvidenceIdentifier(value.daemonId)
        && isEvidenceIdentifier(value.coordinatorRunId)
        && (value.sessionId === undefined || isEvidenceIdentifier(value.sessionId))
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) return false
    }
    return true
}

function fieldMatches(spec: EvidenceFieldSpec, value: unknown): boolean {
    if (value === undefined) return spec.optional === true
    switch (spec.t) {
        case 'id': return isEvidenceIdentifier(value)
        case 'enum': return typeof value === 'string' && spec.values.includes(value)
        case 'bool': return typeof value === 'boolean'
        case 'int': return (value === null && spec.nullable === true) || Number.isSafeInteger(value)
        case 'ms': return isFiniteNumber(value) && value >= 0
        case 'summary_ref': return isSummaryRef(value)
        case 'attempt_ref': return isTurnAttemptRef(value)
        case 'live': return isLiveTurnPending(value)
        case 'native_marker': return isNativeMarkerRef(value)
        case 'coordinator': return isCoordinatorIdentity(value)
    }
}

/**
 * Strict structural guard: known kind, every declared field of the right class,
 * and NO undeclared field (an unknown key is how free text would sneak in).
 */
export function isTurnEvidence(value: unknown): value is TurnEvidence {
    if (!isRecord(value) || !isTurnEvidenceKind(value.kind)) return false
    const bodySpecs = TURN_EVIDENCE_FIELD_SPECS[value.kind] as Record<string, EvidenceFieldSpec>
    const envelopeSpecs = EVIDENCE_ENVELOPE_FIELD_SPECS as Record<string, EvidenceFieldSpec>
    for (const key of Object.keys(value)) {
        if (key === 'kind') continue
        if (!(key in bodySpecs) && !(key in envelopeSpecs)) return false
    }
    for (const [key, spec] of Object.entries(envelopeSpecs)) {
        if (!fieldMatches(spec, value[key])) return false
    }
    for (const [key, spec] of Object.entries(bodySpecs)) {
        if (!fieldMatches(spec, value[key])) return false
    }
    return true
}

export function isTerminalClassEvidenceKind(kind: TurnEvidenceKind): kind is typeof TERMINAL_CLASS_EVIDENCE_KINDS[number] {
    return (TERMINAL_CLASS_EVIDENCE_KINDS as readonly string[]).includes(kind)
}

// ─── mesh.<id>.events topic entries (C2) ─────────────────────────────────

export const TURN_EVIDENCE_FLAGS = ['hollow', 'afterFinalizationTimeout', 'nativeMarker', 'selfAttributing'] as const
export type TurnEvidenceFlag = typeof TURN_EVIDENCE_FLAGS[number]

/** Scalar-only payload for `mesh.record` (the existing allow-list projection's output). */
export type ProjectedScalars = Readonly<Record<string, string | number | boolean | null>>

export const MESH_TOPIC_ENTRY_KINDS = ['turn.evidence', 'turn.committed', 'turn.notify', 'mesh.record'] as const
export type MeshTopicEntryKind = typeof MESH_TOPIC_ENTRY_KINDS[number]

export type MeshTopicEntry = { v: typeof MESH_TOPIC_PROTOCOL_VERSION; eventId: string; at: number } & (
    | { k: 'turn.evidence'; attemptId: string; generation: number; ownerDaemonId: string; taskId?: string; sessionId: string
        ev: TurnEvidenceKind; strength?: TurnEndStrength; flags?: Partial<Record<TurnEvidenceFlag, boolean>>
        /** The full (content-free) evidence, so a foreign `turn.ingest` can re-observe it losslessly. */
        evidence?: TurnEvidence }
    | { k: 'turn.committed'; attemptId: string; generation: number; taskId?: string; outcome: TurnOutcome; strength: CommitStrength; reason: TurnReason }
    | { k: 'turn.notify'; attemptId?: string; notify: NotifyKind; targetDaemonId: string; targetSessionId?: string; taskId?: string }
    | { k: 'mesh.record'; ledgerKind: string; nodeId?: string; sessionId?: string; taskId?: string; payload: ProjectedScalars }
)

export const isMeshTopicEntryKind = makeGuard(MESH_TOPIC_ENTRY_KINDS)

function isOptionalId(value: unknown): boolean {
    return value === undefined || isEvidenceIdentifier(value)
}

function isGeneration(value: unknown): boolean {
    return Number.isSafeInteger(value) && (value as number) >= 0
}

function isProjectedScalars(value: unknown): value is ProjectedScalars {
    if (!isRecord(value)) return false
    for (const v of Object.values(value)) {
        if (!(v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string')) return false
    }
    return true
}

export function isMeshTopicEntry(value: unknown): value is MeshTopicEntry {
    if (!isRecord(value)) return false
    if (value.v !== MESH_TOPIC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.eventId) || !isFiniteNumber(value.at)) return false
    switch (value.k) {
        case 'turn.evidence': {
            if (!isEvidenceIdentifier(value.attemptId) || !isGeneration(value.generation)) return false
            if (!isEvidenceIdentifier(value.ownerDaemonId) || !isEvidenceIdentifier(value.sessionId) || !isOptionalId(value.taskId)) return false
            if (!isTurnEvidenceKind(value.ev)) return false
            if (value.strength !== undefined && !(TURN_END_STRENGTHS as readonly string[]).includes(value.strength as string)) return false
            if (value.flags !== undefined) {
                if (!isRecord(value.flags)) return false
                for (const [flag, on] of Object.entries(value.flags)) {
                    if (!(TURN_EVIDENCE_FLAGS as readonly string[]).includes(flag) || typeof on !== 'boolean') return false
                }
            }
            if (value.evidence !== undefined && !(isTurnEvidence(value.evidence) && value.evidence.kind === value.ev)) return false
            return true
        }
        case 'turn.committed':
            return isEvidenceIdentifier(value.attemptId) && isGeneration(value.generation) && isOptionalId(value.taskId)
                && isTurnOutcome(value.outcome) && isCommitStrength(value.strength) && isTurnReason(value.reason)
        case 'turn.notify':
            return isOptionalId(value.attemptId) && isNotifyKind(value.notify) && isEvidenceIdentifier(value.targetDaemonId)
                && isOptionalId(value.targetSessionId) && isOptionalId(value.taskId)
        case 'mesh.record':
            return isEvidenceIdentifier(value.ledgerKind) && isOptionalId(value.nodeId) && isOptionalId(value.sessionId)
                && isOptionalId(value.taskId) && isProjectedScalars(value.payload)
        default:
            return false
    }
}

/**
 * Project evidence onto its `turn.evidence` topic entry. Pure; the attempt
 * identity comes from the resolved attempt (the evidence may lack attemptRef).
 */
export function projectTurnEvidenceEntry(
    evidence: TurnEvidence,
    attempt: { attemptId: string; generation: number; ownerDaemonId: string },
): Extract<MeshTopicEntry, { k: 'turn.evidence' }> {
    const flags: Partial<Record<TurnEvidenceFlag, boolean>> = {}
    if (evidence.kind === 'turn_end') {
        if (evidence.hollow) flags.hollow = true
        if (evidence.afterFinalizationTimeout) flags.afterFinalizationTimeout = true
    }
    if (evidence.kind === 'transcript_final') {
        if (evidence.nativeMarker) flags.nativeMarker = true
        if (evidence.selfAttributing) flags.selfAttributing = true
    }
    const taskId = evidence.taskId
    return {
        v: MESH_TOPIC_PROTOCOL_VERSION,
        eventId: evidence.eventId,
        at: evidence.at,
        k: 'turn.evidence',
        attemptId: attempt.attemptId,
        generation: attempt.generation,
        ownerDaemonId: attempt.ownerDaemonId,
        ...(taskId ? { taskId } : {}),
        sessionId: evidence.sessionId,
        ev: evidence.kind,
        ...(evidence.kind === 'turn_end' ? { strength: evidence.strength } : {}),
        ...(Object.keys(flags).length > 0 ? { flags } : {}),
        evidence,
    }
}
