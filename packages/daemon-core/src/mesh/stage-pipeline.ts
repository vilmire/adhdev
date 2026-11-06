// Review-in-task: the pure stage reducer (docs/design/2026-11-01-review-in-task.md §3.2, §4.4).
//
//   (plan, state, event) → { state', effects[] }
//
// No I/O, no clock, no turn-ledger writes: the turn ledger stays the single emitter of turn states
// (`npm run check:turn-single-emitter`); the runtime (stage-pipeline-runtime.ts) executes the effects.

import {
    STAGE_SELF_CHECK_MAX_BOUNCES,
    isBlockingSeverity,
    type MeshReviewReport,
    type MeshStageBlockedReason,
    type MeshStageIndependenceUsed,
    type MeshTaskStagePlan,
    type MeshTaskStageState,
} from '@adhdev/mesh-shared';

export type SelfCheckStatus = 'passed' | 'failed' | 'skipped_not_configured' | 'skipped_infra_error' | 'unavailable';

export type StageEvent =
    /** The implementer/reviser's attempt ended `completed` (held by the terminal choke point). */
    | { kind: 'impl_completed'; attemptId?: string; headSha?: string; hasDiff: boolean; at: string }
    | { kind: 'self_check_done'; status: SelfCheckStatus; at: string }
    | { kind: 'review_started'; childTaskId: string; reviewerSessionId?: string; at: string }
    | { kind: 'review_verdict'; childTaskId: string; report: MeshReviewReport; reviewerSessionId?: string; independenceUsed?: MeshStageIndependenceUsed; at: string }
    | { kind: 'reviewer_unavailable'; childTaskId: string; at: string }
    /** The read-lease reviewer changed the parent's checkout: its verdict is void (§11). */
    | { kind: 'reviewer_mutated_source'; childTaskId: string; at: string }
    /** Fail closed: the checkout fingerprint could not be taken, so the read-lease review cannot be verified. */
    | { kind: 'reviewer_integrity_unverifiable'; childTaskId: string; at: string }
    /** The review child could not be created for a lasting reason (e.g. its input evidence is invalid). */
    | { kind: 'review_input_failed'; detail: string; at: string }
    | { kind: 'ceiling'; at: string }
    | { kind: 'decide_revise_once'; at: string }
    | { kind: 'decide_rereview'; at: string };

export type StageEffect =
    | { kind: 'run_self_check' }
    | { kind: 'create_review_child'; round: number; reuseSessionId?: string }
    | { kind: 'send_revision'; reason: 'self_check' | 'review'; round: number }
    | { kind: 'release'; status: 'completed' | 'blocked'; blockedReason?: MeshStageBlockedReason }
    | { kind: 'cancel_review_children' }
    | { kind: 'progress'; text: string };

export interface StageReduction { state: MeshTaskStageState; effects: StageEffect[] }

const clone = (s: MeshTaskStageState): MeshTaskStageState => JSON.parse(JSON.stringify(s));

function maxRounds(plan: MeshTaskStagePlan, state: MeshTaskStageState): number {
    return plan.maxRevisions + (state.extraRevisions ?? 0);
}

function enter(state: MeshTaskStageState, phase: MeshTaskStageState['phase'], at: string): void {
    state.phase = phase;
    state.phaseSince = at;
}

function block(state: MeshTaskStageState, reason: MeshStageBlockedReason, at: string): StageReduction {
    state.blockedReason = reason;
    enter(state, 'done', at);
    return { state, effects: [{ kind: 'cancel_review_children' }, { kind: 'release', status: 'blocked', blockedReason: reason }] };
}

/** Pure transition. Events that do not apply to the current phase are no-ops (idempotent replays). */
export function reduceStage(plan: MeshTaskStagePlan, prev: MeshTaskStageState, event: StageEvent): StageReduction {
    const state = clone(prev);
    const noop: StageReduction = { state: prev, effects: [] };
    if (state.phase === 'done' && event.kind !== 'decide_revise_once' && event.kind !== 'decide_rereview') return noop;

    switch (event.kind) {
        case 'impl_completed': {
            if (state.phase !== 'implementing' && state.phase !== 'revising') return noop;
            if (event.attemptId) {
                if (state.handledAttemptIds?.includes(event.attemptId)) return noop;
                state.handledAttemptIds = [...(state.handledAttemptIds ?? []), event.attemptId].slice(-16);
            }
            if (!event.hasDiff && state.round === 0) {
                // §11: concluded "no change needed" — nothing to review.
                state.selfCheck = undefined;
                enter(state, 'done', event.at);
                return { state, effects: [{ kind: 'release', status: 'completed' }] };
            }
            if (event.headSha) state.stageHeads = [...state.stageHeads, { round: state.round + 1, rootSha: event.headSha }];
            enter(state, 'self_checking', event.at);
            return { state, effects: [{ kind: 'run_self_check' }] };
        }
        case 'self_check_done': {
            if (state.phase !== 'self_checking') return noop;
            if (event.status === 'failed') {
                if (state.selfCheckBounces >= STAGE_SELF_CHECK_MAX_BOUNCES) {
                    state.selfCheck = 'failed';
                    return block(state, 'self_check_failed', event.at);
                }
                state.selfCheckBounces += 1;
                state.selfCheck = 'failed';
                enter(state, 'revising', event.at);
                return { state, effects: [{ kind: 'send_revision', reason: 'self_check', round: state.round }] };
            }
            state.selfCheck = event.status === 'passed' ? 'passed' : event.status;
            state.round += 1;
            enter(state, 'awaiting_review', event.at);
            return { state, effects: [{ kind: 'create_review_child', round: state.round, ...(state.reviewerSessionId ? { reuseSessionId: state.reviewerSessionId } : {}) }] };
        }
        case 'review_started': {
            if (state.phase !== 'awaiting_review') return noop;
            if (event.reviewerSessionId) state.reviewerSessionId = event.reviewerSessionId;
            enter(state, 'reviewing', event.at);
            return { state, effects: [] };
        }
        case 'review_verdict': {
            if (state.phase !== 'reviewing' && state.phase !== 'awaiting_review') return noop;
            const { report } = event;
            if (event.reviewerSessionId) state.reviewerSessionId = event.reviewerSessionId;
            if (event.independenceUsed) state.independenceUsed = event.independenceUsed;
            state.lastVerdict = report.verdict;
            state.reviewerFailures = 0;
            const blocking = report.findings.filter(f => isBlockingSeverity(f.severity));
            const slim = (f: MeshReviewReport['findings'][number]) => ({ id: f.id, severity: f.severity, claim: f.claim });
            if (report.verdict === 'reject_approach') {
                state.openFindings = blocking.map(slim);
                return block(state, 'review_rejected_approach', event.at);
            }
            if (report.verdict === 'approve' || report.verdict === 'approve_with_nits' || blocking.length === 0) {
                state.openFindingIds = [];
                state.openFindings = [];
                state.openNits = report.findings.filter(f => !isBlockingSeverity(f.severity)).map(slim);
                const resolved = (report.priorFindings ?? []).filter(p => p.status === 'resolved' || p.status === 'dispute_accepted').length;
                state.findingsFixed = (state.findingsFixed ?? 0) + resolved;
                enter(state, 'done', event.at);
                return { state, effects: [{ kind: 'release', status: 'completed' }] };
            }
            // changes_requested
            const resolved = (report.priorFindings ?? []).filter(p => p.status === 'resolved' || p.status === 'dispute_accepted').length;
            state.findingsFixed = (state.findingsFixed ?? 0) + resolved;
            state.openFindingIds = blocking.map(f => f.id);
            state.openFindings = blocking.map(slim);
            // Revisions used so far == round - 1; the round-N verdict may trigger revision N only while N <= max.
            if (state.round > maxRounds(plan, state)) return block(state, 'review_unresolved', event.at);
            enter(state, 'revising', event.at);
            return { state, effects: [{ kind: 'send_revision', reason: 'review', round: state.round }] };
        }
        case 'reviewer_unavailable': {
            if (state.phase !== 'reviewing' && state.phase !== 'awaiting_review') return noop;
            state.reviewerFailures = (state.reviewerFailures ?? 0) + 1;
            if (state.reviewerFailures >= 2) return block(state, 'review_unavailable', event.at);
            enter(state, 'awaiting_review', event.at);
            // Another reviewer, same round: never reuse the session that just failed.
            delete state.reviewerSessionId;
            return { state, effects: [{ kind: 'create_review_child', round: state.round }] };
        }
        case 'reviewer_mutated_source': {
            if (state.phase !== 'reviewing' && state.phase !== 'awaiting_review') return noop;
            return block(state, 'reviewer_mutated_source', event.at);
        }
        case 'reviewer_integrity_unverifiable': {
            if (state.phase !== 'reviewing' && state.phase !== 'awaiting_review') return noop;
            return block(state, 'reviewer_integrity_unverifiable', event.at);
        }
        case 'review_input_failed': {
            if (state.phase !== 'reviewing' && state.phase !== 'awaiting_review') return noop;
            const r = block(state, 'review_unavailable', event.at);
            r.state.blockedDetail = event.detail.slice(0, 300);
            return r;
        }
        case 'ceiling': {
            return block(state, 'stage_pipeline_ceiling', event.at);
        }
        case 'decide_revise_once': {
            if (state.phase !== 'done' || !state.blockedReason) return noop;
            state.extraRevisions = (state.extraRevisions ?? 0) + 1;
            delete state.blockedReason;
            delete state.blockedDetail;
            state.released = false;
            enter(state, 'revising', event.at);
            return { state, effects: [{ kind: 'send_revision', reason: 'review', round: state.round }] };
        }
        case 'decide_rereview': {
            if (state.phase !== 'done' || !state.blockedReason) return noop;
            delete state.blockedReason;
            delete state.blockedDetail;
            delete state.reviewerSessionId;
            state.released = false;
            state.reviewerFailures = 0;
            state.round += 1;
            enter(state, 'awaiting_review', event.at);
            return { state, effects: [{ kind: 'create_review_child', round: state.round }] };
        }
        default:
            return noop;
    }
}
