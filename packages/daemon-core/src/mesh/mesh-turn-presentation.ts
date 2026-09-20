/**
 * TURN-PRESENTATION (Stage 6) — the ONE authoritative session/turn presentation
 * contract for every mesh/coordinator-facing execution-status surface.
 *
 * WHY THIS EXISTS: before Stage 6, read_chat, the public adapter/session status,
 * both mesh_status assembly paths, the dashboard snapshot, MCP pending-event
 * surfaces, the stall watchdog and the restart idle-gates each derived execution
 * status independently (PTY point samples, transcript tails, provider FSM state).
 * Those derivations disagreed: a Kimi native transcript mid-turn or a Codex
 * mid-tool settled-prompt sample could read `idle` while the turn was genuinely
 * generating; a provider-idle session whose reducer was `finalizing` could be
 * restarted or completed early.
 *
 * THE CONTRACT:
 *  - For a mesh-owned session with a current turn attempt (Stage 5 ledger), the
 *    reducer projection is AUTHORITATIVE. Provider PTY/native transcript parsers
 *    still contribute message content and evidence proposals, but they MUST NOT
 *    independently override the projected execution state on any surface.
 *  - For a session WITHOUT any mesh attempt (ordinary standalone chat / non-mesh
 *    CLI), the persisted provider FSM status behavior is preserved verbatim
 *    (authority `provider_fsm_fallback`). The selection is keyed on ATTEMPT
 *    EXISTENCE — never on a provider name.
 *  - `idle` is presentation/availability, not a completion writer: a provider-idle
 *    session whose attempt is `finalizing` presents `finalizing` on every surface
 *    until the reducer commits a terminal outcome.
 *  - waiting_approval and waiting_choice are distinct states and surfaces; neither
 *    is inferred from generic idle, and choice is never mapped to approval.
 *
 * SHADOW VALIDATION: when the reducer is authoritative, the legacy presentation is
 * still computed and compared (shadow comparator). Divergences are recorded as
 * bounded, content-free counters (reason/surface/provider/stage — never transcript
 * or prompt text) so the canary gates can measure convergence before legacy
 * fallbacks are retired. Legacy NEVER writes authoritative state.
 */

import { MeshRuntimeStore, type MeshTurnAttemptRow } from './mesh-runtime-store.js';
import {
    isTerminalTurnStage,
    type TurnStage,
    type TurnTerminalOutcome,
} from './mesh-turn-ledger.js';
import { LOG } from '../logging/logger.js';
import { normalizeManagedStatus, type ManagedStatus } from '../status/normalize.js';

// ─── Public contract ─────────────────────────────────────────────────────────

/** Who decided the presented execution status. */
export type TurnPresentationAuthority = 'turn_reducer' | 'provider_fsm_fallback';

/**
 * The surfaces that consume the unified presentation. Kept as an open string
 * union so new surfaces can adopt the contract without a type migration; the
 * well-known names are listed for grep-ability and metrics cardinality control.
 */
export type TurnPresentationSurface =
    | 'read_chat'
    | 'session_status'
    | 'session_modal'
    | 'mesh_status'
    | 'active_work'
    | 'dashboard'
    | 'mcp_pending'
    | 'notification'
    | 'stall_watchdog'
    | 'restart_gate'
    | (string & {});

/**
 * The ONE public session/turn presentation. Derived from the Stage 5
 * `TurnAttemptProjection` when an attempt exists; identity + evidence
 * timestamps always reflect the attempt row, never a point sample.
 */
export interface SessionTurnPresentation {
    authority: TurnPresentationAuthority;
    /** Coarse surface status (ManagedStatus). `finalizing` is first-class. */
    status: ManagedStatus;
    /** The causal stage verbatim (null on provider_fsm_fallback). */
    stage: TurnStage | null;
    terminalOutcome: TurnTerminalOutcome | null;
    terminalReason: string | null;
    meshId: string | null;
    taskId: string | null;
    attemptId: string | null;
    attemptSeq: number | null;
    sessionId: string | null;
    nodeId: string | null;
    providerType: string | null;
    /** Evidence freshness/timestamps from the attempt row (ISO strings). */
    acceptedAt: string | null;
    deliveredAt: string | null;
    consumedAt: string | null;
    terminalAt: string | null;
    updatedAt: string | null;
    /** Age gauges (ms), computed against the resolve-time clock. */
    projectionAgeMs: number | null;
    /** Age of the CURRENT suspended/finalizing stage; null when not in that stage. */
    approvalAgeMs: number | null;
    choiceAgeMs: number | null;
    finalizingAgeMs: number | null;
}

// ─── Stage → surface status mapping (single definition) ─────────────────────

/**
 * Coarse ManagedStatus for a causal stage. `idle` is availability: a COMPLETED
 * attempt is available for the next turn, so it maps to idle — the terminal
 * outcome/reason on the presentation carries the truth. `finalizing` stays
 * visible (never idle) until the reducer commits terminal.
 */
export function turnStageToSurfaceStatus(stage: TurnStage): ManagedStatus {
    switch (stage) {
        case 'accepted':
        case 'delivered':
            return 'starting';
        case 'consumed':
        case 'generating':
            return 'generating';
        case 'waiting_approval':
            return 'waiting_approval';
        case 'waiting_choice':
            return 'waiting_choice';
        case 'finalizing':
            return 'finalizing';
        case 'completed':
            return 'idle';
        case 'failed':
            return 'error';
        case 'cancelled':
            return 'stopped';
    }
}

/**
 * DISPLAY age — clamped at 0 so a slightly-ahead row never surfaces a negative
 * duration on a badge. Safe here precisely because these values are REPORTING
 * only (projectionAgeMs / approvalAgeMs / …); they gate nothing.
 * Decisions must use {@link rawAgeMs} — see the lower-bound note there.
 */
function ageMs(nowMs: number, iso: string | null): number | null {
    const raw = rawAgeMs(nowMs, iso);
    return raw === null ? null : Math.max(0, raw);
}

/**
 * DECISION age — unclamped, so a FUTURE timestamp stays negative and remains
 * visible to the caller as the untrustworthy clock signal it is.
 *
 * CLOCK-LOWER-BOUND (2026-09-21): `updated_at` is foreign (written by whichever
 * process/machine owned the turn), so it can legitimately land ahead of this
 * daemon's clock via node skew, an NTP step, or a replicated row. Clamping such
 * a stamp to 0 tells every staleness gate "this row was written this instant" —
 * the freshest possible reading — which is the exact inversion of what a
 * distrusted clock should produce. Keep the raw value and let each gate state
 * its own lower bound explicitly.
 */
function rawAgeMs(nowMs: number, iso: string | null): number | null {
    if (!iso) return null;
    const ts = Date.parse(iso);
    return Number.isFinite(ts) ? nowMs - ts : null;
}

/**
 * STALE-ATTEMPT-AUTHORITY GATE — max age for an IN-FLIGHT (`generating` /
 * `consumed`) attempt row to keep authority over the provider FSM.
 *
 * WHY: an attempt row can be stranded nonterminal by an ordinary, non-exotic
 * path — the task completes normally, but its `mesh_queue` row is later removed
 * by retention prune. Neither reclaim path can then close it:
 * `reclaimOrphanedTurnAttempts` requires a HIGHER-seq sibling (a lone seq-0 row
 * has none) and `reclaimQueueTerminatedTurnAttempts` requires an EXISTS match
 * against `mesh_queue` (pruned → never matches). Both also run only once at
 * daemon boot, and the stall watchdog re-arms the anchor rather than closing it.
 * With no max-age anywhere, such a row pins its session to `generating` forever
 * on every surface even though PTY/adapter/parser all read `idle`.
 *
 * WHY A GATE AND NOT "DROP STAGE 6 AUTHORITY": the authority itself is load
 * bearing (see the file header) — a Kimi native transcript mid-turn or a Codex
 * mid-tool sample reads `idle` while the turn is genuinely running, and dropping
 * authority would resurrect early completion + early restart of `finalizing`
 * sessions. So authority is kept, and only a row that is demonstrably dead is
 * demoted.
 *
 * WHY 30 MINUTES: the gate must never misjudge a long but healthy turn as dead,
 * because that surfaces a running session as `idle` (and un-blocks the restart
 * gate for it). A reducer-authoritative turn refreshes `updated_at` on every
 * stage write, so a live turn is not silently quiet for this long; a genuinely
 * long agent turn stays well under it. The value is deliberately far above the
 * ~15m floor the defect report proposed — the cost of a late demotion is a
 * stale badge, the cost of an early one is a corrupted in-flight turn.
 *
 * SCOPE: only `generating` and `consumed`. Terminal stages need no gate;
 * `accepted`/`delivered` are covered by the existing redrive/reclaim machinery;
 * `waiting_approval` / `waiting_choice` / `finalizing` are legitimately long-lived
 * by design (a human may not answer an approval for hours) and are excluded.
 */
export const STALE_TURN_ATTEMPT_AUTHORITY_MAX_AGE_MS = 30 * 60 * 1000;

/** Stages subject to the max-age gate above. */
const STALE_GATED_STAGES: ReadonlySet<string> = new Set(['generating', 'consumed']);

/**
 * How far a row's `updated_at` may sit AHEAD of our clock before the row is read
 * as clock-untrustworthy rather than merely fresh. Sized to absorb ordinary
 * same-machine write/read jitter (the row is stamped a moment before we read it)
 * without admitting genuine skew. Matches the ±2s future tolerance
 * mesh-completion-live-gate.ts already applies to untrusted completion evidence.
 */
const FUTURE_UPDATED_AT_SKEW_TOLERANCE_MS = 2_000;

/**
 * True when an attempt row sits in an in-flight stage but has not been written
 * to for longer than {@link STALE_TURN_ATTEMPT_AUTHORITY_MAX_AGE_MS}, i.e. it is
 * an unreachable/stranded anchor rather than a live turn.
 */
export function isStaleTurnAttemptAuthority(row: MeshTurnAttemptRow, nowMs: number): boolean {
    if (!STALE_GATED_STAGES.has(row.stage)) return false;
    const age = rawAgeMs(nowMs, row.updatedAt ?? null);
    if (age === null) return false;
    // CLOCK-LOWER-BOUND (2026-09-21): a NEGATIVE age means `updated_at` is in the
    // future, i.e. the row's clock cannot be reconciled with ours. Read it as
    // stale, not as fresh. Under the previous clamped age this row scored 0 —
    // maximally fresh — so it held `turn_reducer` authority indefinitely and could
    // never be demoted, which in turn fed the stall watchdog a permanently "live"
    // in-flight stage for a session the provider FSM already reads as idle.
    // Tolerate sub-second skew so ordinary same-machine jitter is not a demotion.
    if (age < -FUTURE_UPDATED_AT_SKEW_TOLERANCE_MS) return true;
    return age > STALE_TURN_ATTEMPT_AUTHORITY_MAX_AGE_MS;
}

/** Build the presentation from an attempt row (the reducer-authoritative branch). */
export function presentationFromAttemptRow(row: MeshTurnAttemptRow, nowMs: number = Date.now()): SessionTurnPresentation {
    const stage = row.stage as TurnStage;
    return {
        authority: 'turn_reducer',
        status: turnStageToSurfaceStatus(stage),
        stage,
        terminalOutcome: (row.terminalOutcome as TurnTerminalOutcome | null) ?? null,
        terminalReason: row.terminalReason ?? null,
        meshId: row.meshId,
        taskId: row.taskId,
        attemptId: row.attemptId,
        attemptSeq: row.attemptSeq,
        sessionId: row.sessionId ?? null,
        nodeId: row.nodeId ?? null,
        providerType: row.providerType ?? null,
        acceptedAt: row.acceptedAt ?? null,
        deliveredAt: row.deliveredAt ?? null,
        consumedAt: row.consumedAt ?? null,
        terminalAt: row.terminalAt ?? null,
        updatedAt: row.updatedAt ?? null,
        projectionAgeMs: ageMs(nowMs, row.updatedAt),
        approvalAgeMs: stage === 'waiting_approval' ? ageMs(nowMs, row.updatedAt) : null,
        choiceAgeMs: stage === 'waiting_choice' ? ageMs(nowMs, row.updatedAt) : null,
        finalizingAgeMs: stage === 'finalizing' ? ageMs(nowMs, row.updatedAt) : null,
    };
}

// ─── Authority selector ──────────────────────────────────────────────────────

export interface TurnAuthorityLookup {
    sessionId?: string | null;
    meshId?: string | null;
    taskId?: string | null;
}

/**
 * Resolve the current attempt row for a surface lookup. Explicit (meshId, taskId)
 * wins (task-scoped surfaces: active_work, watchdog, MCP task views); otherwise
 * fall back to the session binding (read_chat / session status / dashboard /
 * restart gate). Returns null when no attempt exists — the ONLY condition under
 * which the provider FSM fallback governs.
 */
export function resolveTurnAttemptRow(lookup: TurnAuthorityLookup): MeshTurnAttemptRow | null {
    try {
        const store = MeshRuntimeStore.getInstance();
        const meshId = typeof lookup.meshId === 'string' && lookup.meshId.trim() ? lookup.meshId.trim() : null;
        const taskId = typeof lookup.taskId === 'string' && lookup.taskId.trim() ? lookup.taskId.trim() : null;
        if (meshId && taskId) {
            const row = store.getCurrentTurnAttempt(meshId, taskId);
            if (row) return row;
        }
        const sessionId = typeof lookup.sessionId === 'string' && lookup.sessionId.trim() ? lookup.sessionId.trim() : null;
        if (sessionId) return store.getLatestTurnAttemptForSession(sessionId);
        return null;
    } catch {
        // Store unavailable (e.g. better-sqlite3 load failure on a clean install):
        // no attempt can be proven → the provider FSM fallback governs.
        return null;
    }
}

export interface ResolveTurnPresentationArgs extends TurnAuthorityLookup {
    /** The status the legacy logic computed for this surface (shadow input). */
    legacyStatus?: string | null;
    providerType?: string | null;
    surface: TurnPresentationSurface;
    nowMs?: number;
}

/**
 * THE authority selector. Explicit and testable: attempt exists → reducer
 * projection is authoritative (and the legacy status is shadow-compared);
 * no attempt → the persisted provider FSM status passes through unchanged.
 */
export function resolveSessionTurnPresentation(args: ResolveTurnPresentationArgs): SessionTurnPresentation {
    const nowMs = args.nowMs ?? Date.now();
    const row = resolveTurnAttemptRow(args);
    // STALE-ATTEMPT-AUTHORITY GATE: a stranded in-flight row (see
    // STALE_TURN_ATTEMPT_AUTHORITY_MAX_AGE_MS) is demoted so the provider FSM —
    // which reads the session's real, idle state — governs the surface again.
    if (row && !isStaleTurnAttemptAuthority(row, nowMs)) {
        const presentation = presentationFromAttemptRow(row, nowMs);
        recordProjectionSource('turn_reducer');
        shadowCompareLegacyVsProjection(args.surface, args.providerType ?? row.providerType, args.legacyStatus, presentation);
        observePresentationAges(presentation);
        return presentation;
    }
    recordProjectionSource('provider_fsm_fallback');
    return {
        authority: 'provider_fsm_fallback',
        status: normalizeManagedStatus(args.legacyStatus),
        stage: null,
        terminalOutcome: null,
        terminalReason: null,
        meshId: null,
        taskId: null,
        attemptId: null,
        attemptSeq: null,
        sessionId: typeof args.sessionId === 'string' ? args.sessionId : null,
        nodeId: null,
        providerType: args.providerType ?? null,
        acceptedAt: null,
        deliveredAt: null,
        consumedAt: null,
        terminalAt: null,
        updatedAt: null,
        projectionAgeMs: null,
        approvalAgeMs: null,
        choiceAgeMs: null,
        finalizingAgeMs: null,
    };
}

// ─── Gates built on the presentation ────────────────────────────────────────

/**
 * Restart/deferred-restart idle gate: does this session block a daemon restart?
 * Mesh-owned work (attempt exists) blocks on the AUTHORITATIVE nonterminal turn
 * state — including finalizing / waiting_approval / waiting_choice — regardless
 * of a transient provider idle sample. Non-mesh sessions keep the legacy
 * sample-based verdict (caller passes its legacy blocking verdict).
 */
export function isRestartBlockingPresentation(presentation: SessionTurnPresentation, legacyBlocking: boolean): boolean {
    if (presentation.authority !== 'turn_reducer') return legacyBlocking;
    return presentation.stage !== null && !isTerminalTurnStage(presentation.stage);
}

// ─── Shadow comparator + bounded observability ──────────────────────────────

/** Bounded metrics — ids, stages, reasons, surfaces, providers; NEVER content. */
export interface TurnPresentationMetrics {
    /** Resolutions by authority source. */
    projectionSource: Record<'turn_reducer' | 'provider_fsm_fallback', number>;
    /** Shadow comparisons where legacy and projection agreed. */
    shadowAgreements: number;
    /**
     * Shadow divergences keyed `reason|surface|provider` (bounded — see
     * MAX_DIVERGENCE_KEYS; overflow folds into `…|__overflow__`). Structured and
     * content-free by construction.
     */
    shadowDivergences: Record<string, number>;
    shadowDivergenceTotal: number;
    /** Max observed age gauges (ms) since process start / test reset. */
    maxProjectionAgeMs: number;
    maxFinalizingAgeMs: number;
    maxApprovalAgeMs: number;
    maxChoiceAgeMs: number;
}

const MAX_DIVERGENCE_KEYS = 200;
const OVERFLOW_KEY = 'overflow|__overflow__|__overflow__';

const presentationMetrics: TurnPresentationMetrics = {
    projectionSource: { turn_reducer: 0, provider_fsm_fallback: 0 },
    shadowAgreements: 0,
    shadowDivergences: {},
    shadowDivergenceTotal: 0,
    maxProjectionAgeMs: 0,
    maxFinalizingAgeMs: 0,
    maxApprovalAgeMs: 0,
    maxChoiceAgeMs: 0,
};

export function getTurnPresentationMetrics(): TurnPresentationMetrics {
    return {
        projectionSource: { ...presentationMetrics.projectionSource },
        shadowAgreements: presentationMetrics.shadowAgreements,
        shadowDivergences: { ...presentationMetrics.shadowDivergences },
        shadowDivergenceTotal: presentationMetrics.shadowDivergenceTotal,
        maxProjectionAgeMs: presentationMetrics.maxProjectionAgeMs,
        maxFinalizingAgeMs: presentationMetrics.maxFinalizingAgeMs,
        maxApprovalAgeMs: presentationMetrics.maxApprovalAgeMs,
        maxChoiceAgeMs: presentationMetrics.maxChoiceAgeMs,
    };
}

export function __resetTurnPresentationMetricsForTests(): void {
    presentationMetrics.projectionSource.turn_reducer = 0;
    presentationMetrics.projectionSource.provider_fsm_fallback = 0;
    presentationMetrics.shadowAgreements = 0;
    presentationMetrics.shadowDivergences = {};
    presentationMetrics.shadowDivergenceTotal = 0;
    presentationMetrics.maxProjectionAgeMs = 0;
    presentationMetrics.maxFinalizingAgeMs = 0;
    presentationMetrics.maxApprovalAgeMs = 0;
    presentationMetrics.maxChoiceAgeMs = 0;
    divergenceLogOnce.clear();
}

function recordProjectionSource(source: 'turn_reducer' | 'provider_fsm_fallback'): void {
    presentationMetrics.projectionSource[source] += 1;
}

function observePresentationAges(p: SessionTurnPresentation): void {
    if (p.projectionAgeMs !== null) presentationMetrics.maxProjectionAgeMs = Math.max(presentationMetrics.maxProjectionAgeMs, p.projectionAgeMs);
    if (p.finalizingAgeMs !== null) presentationMetrics.maxFinalizingAgeMs = Math.max(presentationMetrics.maxFinalizingAgeMs, p.finalizingAgeMs);
    if (p.approvalAgeMs !== null) presentationMetrics.maxApprovalAgeMs = Math.max(presentationMetrics.maxApprovalAgeMs, p.approvalAgeMs);
    if (p.choiceAgeMs !== null) presentationMetrics.maxChoiceAgeMs = Math.max(presentationMetrics.maxChoiceAgeMs, p.choiceAgeMs);
}

/** Typed shadow-divergence reasons (metrics cardinality is bounded by this list). */
export type ShadowDivergenceReason =
    | 'legacy_idle_turn_active'          // legacy idle/availability while the turn is nonterminal
    | 'legacy_busy_turn_terminal'        // legacy working/waiting while the attempt is terminal
    | 'legacy_approval_choice_confusion' // approval vs choice disagreement
    | 'legacy_working_turn_suspended'    // legacy generating while the attempt is parked (approval/choice)
    | 'legacy_working_turn_finalizing'   // legacy generating while the reducer is finalizing
    | 'stage_mismatch_other';

const divergenceLogOnce = new Set<string>();

export function classifyShadowDivergence(legacyStatus: ManagedStatus, presentation: SessionTurnPresentation): ShadowDivergenceReason {
    const stage = presentation.stage;
    const legacyWorking = legacyStatus === 'generating' || legacyStatus === 'starting';
    const legacyWaiting = legacyStatus === 'waiting_approval' || legacyStatus === 'waiting_choice';
    if (stage && isTerminalTurnStage(stage)) {
        return legacyWorking || legacyWaiting ? 'legacy_busy_turn_terminal' : 'stage_mismatch_other';
    }
    if (legacyStatus === 'idle') return 'legacy_idle_turn_active';
    if (stage === 'waiting_approval' || stage === 'waiting_choice') {
        if (legacyWaiting && legacyStatus !== stage) return 'legacy_approval_choice_confusion';
        if (legacyWorking) return 'legacy_working_turn_suspended';
        return 'stage_mismatch_other';
    }
    if (stage === 'finalizing') return legacyWorking ? 'legacy_working_turn_finalizing' : 'stage_mismatch_other';
    return 'stage_mismatch_other';
}

/**
 * The shadow comparator. Runs ONLY when the reducer is authoritative; legacy
 * never writes anything here — it is a read-only convergence measurement.
 */
function shadowCompareLegacyVsProjection(
    surface: TurnPresentationSurface,
    providerType: string | null | undefined,
    legacyStatus: string | null | undefined,
    presentation: SessionTurnPresentation,
): void {
    if (legacyStatus === null || legacyStatus === undefined) return;
    const legacyNorm = normalizeManagedStatus(legacyStatus);
    if (legacyNorm === presentation.status) {
        presentationMetrics.shadowAgreements += 1;
        return;
    }
    const reason = classifyShadowDivergence(legacyNorm, presentation);
    const provider = providerType && providerType.trim() ? providerType.trim() : 'unknown';
    const key = `${reason}|${surface}|${provider}`;
    presentationMetrics.shadowDivergenceTotal += 1;
    if (presentationMetrics.shadowDivergences[key] !== undefined) {
        presentationMetrics.shadowDivergences[key] += 1;
    } else if (Object.keys(presentationMetrics.shadowDivergences).length < MAX_DIVERGENCE_KEYS) {
        presentationMetrics.shadowDivergences[key] = 1;
    } else {
        presentationMetrics.shadowDivergences[OVERFLOW_KEY] = (presentationMetrics.shadowDivergences[OVERFLOW_KEY] ?? 0) + 1;
    }
    // Bounded structured logging: first occurrence per key only. Content-free —
    // ids, stages, statuses, reason; never transcript/prompt text.
    if (!divergenceLogOnce.has(key)) {
        divergenceLogOnce.add(key);
        if (divergenceLogOnce.size > MAX_DIVERGENCE_KEYS) divergenceLogOnce.clear();
        LOG.info('TurnPresentation', `Shadow divergence (${reason}) surface=${surface} provider=${provider} legacy=${legacyNorm} projected=${presentation.status} stage=${presentation.stage ?? 'none'} task=${presentation.taskId ?? 'none'} attempt=${presentation.attemptId ?? 'none'}`);
    }
}
