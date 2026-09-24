import { describe, expect, it } from 'vitest';
import { TURN_EVIDENCE_KINDS, type TurnEvidence, type TurnEvidenceKind } from '@adhdev/mesh-shared';
import { TRANSITIONS, ruleAdmitsState } from '../../src/mesh/turn-ledger/transitions.js';
import { matchingRules, reduce } from '../../src/mesh/turn-ledger/reducer.js';
import { TURN_STATES, type TurnAttempt, type TurnEffectKind, type TurnHold, type TurnState } from '../../src/mesh/turn-ledger/types.js';
import { NOW, POLICY, REF, ev, expired, makeAttempt, makeHold, variantsFor } from './fixtures.js';

// The transition table is data (design §5 C1, plan §2.3). This suite proves:
//   1. every rule fires from a minimal fixture with the verdict/target the table declares;
//   2. at most one rule matches any (state, kind, guard variant, attempt variant);
//   3. the (state, kind) pairs no rule covers are EXACTLY the enumerated illegal ones,
//      and the reducer rejects them.

const PLAN_IDS = [
    'R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13a', 'R13b', 'R14', 'R15', 'R16',
    'R17', 'R18', 'R19', 'R20', 'R21', 'R22', 'R23', 'R24', 'R25', 'R26', 'R27', 'R28', 'R29', 'R30', 'R31', 'R32', 'R33',
    'R34', 'R35', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7',
];

const DISPATCH_ONLY: TurnEvidenceKind[] = ['dispatch_accepted', 'delivery_refused', 'dispatch_failed', 'duplicate_dispatch_refusal'];
const PRE_TURN_ILLEGAL: TurnEvidenceKind[] = ['dispatch_accepted', 'turn_end', 'transcript_final', 'transcript_activity', 'no_progress', 'liveness', 'git_side_effect'];
const IN_TURN_ILLEGAL: TurnEvidenceKind[] = [...DISPATCH_ONLY, 'suspension_resolved'];
const TERMINAL_ILLEGAL: TurnEvidenceKind[] = [
    'dispatch_accepted', 'delivered', 'delivery_refused', 'dispatch_failed', 'duplicate_dispatch_refusal', 'session_rebound',
    'turn_started', 'suspension', 'suspension_resolved', 'worker_progress', 'transcript_activity', 'liveness', 'git_side_effect',
];

/** Explicitly enumerated illegal (state, kind) pairs in the current lane. */
const ILLEGAL: Record<TurnState, TurnEvidenceKind[]> = {
    accepted: PRE_TURN_ILLEGAL,
    delivered: PRE_TURN_ILLEGAL,
    consumed: IN_TURN_ILLEGAL,
    generating: IN_TURN_ILLEGAL,
    suspended: DISPATCH_ONLY,
    finalizing: IN_TURN_ILLEGAL,
    completed: TERMINAL_ILLEGAL,
    failed: TERMINAL_ILLEGAL,
    cancelled: TERMINAL_ILLEGAL,
};

interface Fixture {
    attempt: TurnAttempt | null;
    holds?: TurnHold[];
    evidence: TurnEvidence;
    state: TurnState | null;
    effects?: TurnEffectKind[];
    generation?: number;
}

const G = (o: Partial<TurnAttempt> = {}) => makeAttempt('generating', o);
const LIVE_IDLE = { modal: false, adapterPending: false, trailingTool: false };
const noRef = { attemptRef: undefined };

const FIRES: Record<string, Fixture> = {
    R1: { attempt: null, evidence: ev('dispatch_accepted', { scope: 'mesh_queue', messageId: 'msg1', meshId: 'm1' }, { ...noRef, taskId: 't1', source: 'dispatch' }), state: 'accepted', effects: ['hold', 'hold'] },
    R0a: { attempt: null, evidence: ev('turn_started', { retro: false }, noRef), state: 'generating', effects: ['bus'] },
    R0b: { attempt: null, evidence: ev('turn_started', { retro: false }), state: null, effects: ['record'] },
    R0: { attempt: null, evidence: ev('liveness', { result: 'alive' }), state: null, effects: ['record'] },
    R27a: { attempt: makeAttempt('delivered'), evidence: ev('turn_end', { strength: 'genuine', summary: REF }, { sessionId: 's0', attemptRef: { attemptId: 'a1', generation: 0 } }), state: 'completed', generation: 1, effects: ['cancel_dispatch', 'commit', 'queue_status', 'graph_advance', 'notify_coordinator', 'release_attempt_ref'] },
    R27: { attempt: G(), evidence: ev('worker_report', { outcome: 'completed', summary: REF, hasHandoffNotes: false }, { sessionId: 's0', attemptRef: { attemptId: 'a1', generation: 0 } }), state: 'generating', effects: ['record', 'notify_coordinator'] },
    R28a: { attempt: G(), evidence: ev('turn_started', { retro: false }, { sessionId: 's0', attemptRef: { attemptId: 'a1', generation: 0 } }), state: 'generating', effects: ['record', 'cancel_dispatch'] },
    R28: { attempt: G(), evidence: ev('liveness', { result: 'dead' }, { attemptRef: { attemptId: 'a1', generation: 0 } }), state: 'generating', effects: ['record'] },
    R2: { attempt: makeAttempt('accepted'), holds: [makeHold('await_delivery')], evidence: ev('delivered', { messageId: 'msg1', outcome: 'delivered', via: 'p2p' }), state: 'delivered', effects: ['release_hold', 'hold', 'hold'] },
    R2a: { attempt: G(), evidence: ev('delivered', { messageId: 'msg1', outcome: 'delivered', via: 'p2p' }), state: 'generating', effects: ['record'] },
    R3: { attempt: makeAttempt('delivered'), evidence: ev('delivery_refused', { messageId: 'msg1', reason: 'session_exited' }), state: 'accepted', generation: 2, effects: ['reclaim', 'cancel_dispatch', 'queue_status', 'hold'] },
    R3a: { attempt: makeAttempt('delivered'), evidence: ev('delivery_refused', { messageId: 'msg1', reason: 'send_in_flight' }), state: 'delivered', effects: ['record'] },
    R24: { attempt: makeAttempt('accepted'), evidence: ev('dispatch_failed', { workerAbsent: true, reason: 'worker_absent' }), state: 'accepted', generation: 2, effects: ['reclaim'] },
    R25: { attempt: makeAttempt('delivered'), evidence: ev('duplicate_dispatch_refusal', { holderSessionId: 's9', holderAttemptId: 'a1' }), state: 'consumed', effects: ['hold'] },
    R25a: { attempt: makeAttempt('delivered'), evidence: ev('duplicate_dispatch_refusal', { holderSessionId: 's9', holderAttemptId: 'a2' }), state: 'delivered', effects: ['record'] },
    R26: { attempt: G(), evidence: ev('session_rebound', { toSessionId: 's2', reason: 'restart' }), state: 'generating' },
    R4: { attempt: makeAttempt('delivered'), holds: [makeHold('await_consume'), makeHold('await_turn')], evidence: ev('turn_started', { retro: false }), state: 'generating', effects: ['release_hold', 'hold', 'bus'] },
    R5: { attempt: makeAttempt('delivered'), evidence: ev('suspension', { modal: 'choice' }), state: 'delivered', effects: ['hold'] },
    R5b: { attempt: makeAttempt('delivered'), holds: [makeHold('suspension_before_consumed')], evidence: ev('suspension_resolved', { resolution: 'approved', via: 'modal_button' }), state: 'delivered', effects: ['release_hold'] },
    R6: { attempt: G(), evidence: ev('suspension', { modal: 'approval' }), state: 'suspended', effects: ['bus', 'notify_coordinator'] },
    R6s: { attempt: makeAttempt('suspended'), evidence: ev('suspension', { modal: 'choice' }), state: 'suspended', effects: ['bus', 'notify_coordinator'] },
    R6d: { attempt: makeAttempt('suspended'), evidence: ev('suspension', { modal: 'approval' }), state: 'suspended', effects: ['record'] },
    R7: { attempt: makeAttempt('suspended'), evidence: ev('suspension_resolved', { resolution: 'approved', via: 'modal_button' }), state: 'generating', effects: ['bus', 'notify_coordinator'] },
    R8: { attempt: makeAttempt('suspended'), evidence: ev('turn_started', { retro: false }), state: 'generating', effects: ['hold', 'bus'] },
    R9: { attempt: G(), evidence: ev('turn_end', { strength: 'genuine', summary: REF }), state: 'completed', effects: ['commit', 'queue_status', 'graph_advance', 'bus', 'notify_coordinator', 'release_attempt_ref'] },
    R10: { attempt: G(), evidence: ev('turn_end', { strength: 'weak' }), state: 'finalizing', effects: ['hold', 'notify_coordinator'] },
    R10a: { attempt: makeAttempt('finalizing'), evidence: ev('turn_end', { strength: 'weak' }), state: 'finalizing', effects: ['record'] },
    R11: { attempt: makeAttempt('finalizing'), evidence: ev('turn_end', { strength: 'genuine' }), state: 'completed', effects: ['commit'] },
    R12: { attempt: makeAttempt('finalizing'), evidence: ev('turn_started', { retro: false }), state: 'generating', effects: ['hold'] },
    R9r: { attempt: G(), evidence: ev('turn_end', { strength: 'genuine', summary: REF, reportExpected: true }), state: 'finalizing', effects: ['hold'] },
    R9d: { attempt: makeAttempt('finalizing'), holds: [makeHold('await_report')], evidence: ev('turn_end', { strength: 'genuine', reportExpected: true }), state: 'finalizing', effects: ['record'] },
    R11d: { attempt: makeAttempt('finalizing'), holds: [makeHold('await_report')], evidence: ev('transcript_final', { selfAttributing: false, nativeRead: true, nativeMarker: { outcome: 'completed' }, live: LIVE_IDLE }), state: 'finalizing', effects: ['record'] },
    R12r: { attempt: makeAttempt('finalizing'), holds: [makeHold('await_report')], evidence: ev('turn_started', { retro: false }), state: 'generating', effects: ['release_hold', 'hold', 'bus', 'record'] },
    R13r: { attempt: makeAttempt('finalizing'), holds: [makeHold('await_report')], evidence: expired('await_report'), state: 'completed', effects: ['commit', 'notify_coordinator'] },
    R13a: { attempt: makeAttempt('finalizing'), holds: [makeHold('weak_candidate')], evidence: expired('weak_candidate'), state: 'completed', effects: ['commit'] },
    R13b: { attempt: G(), evidence: ev('turn_end', { strength: 'weak', afterFinalizationTimeout: true }), state: 'failed', effects: ['commit'] },
    R14: { attempt: G(), evidence: ev('transcript_final', { selfAttributing: false, nativeRead: true, nativeMarker: { outcome: 'completed' }, live: LIVE_IDLE }), state: 'completed', effects: ['commit'] },
    R15: { attempt: G(), evidence: ev('transcript_final', { selfAttributing: false, nativeRead: false, live: LIVE_IDLE, summary: REF }), state: 'finalizing', effects: ['hold', 'notify_coordinator'] },
    R16: { attempt: G(), evidence: ev('turn_end', { strength: 'genuine', live: { ...LIVE_IDLE, trailingTool: true } }), state: 'generating', effects: ['hold'] },
    R16a: { attempt: G(), evidence: ev('transcript_final', { selfAttributing: false, nativeRead: true, live: LIVE_IDLE, summary: REF }), state: 'generating', effects: ['record'] },
    R17: { attempt: G(), evidence: ev('worker_report', { outcome: 'completed', summary: REF, hasHandoffNotes: true }, { source: 'worker_tool' }), state: 'completed', effects: ['commit', 'notify_coordinator'] },
    R17p: { attempt: G(), evidence: ev('worker_progress', { note: REF }, { source: 'worker_tool' }), state: 'generating', effects: ['bus', 'notify_coordinator'] },
    R18: { attempt: makeAttempt('completed', { terminal: { outcome: 'completed', reason: 'worker_reported', source: 'worker_tool', strength: 'tool_report', at: NOW - 5 } }), evidence: ev('transcript_final', { selfAttributing: false, nativeRead: false, live: LIVE_IDLE, summary: REF }), state: 'completed', effects: ['record'] },
    R19: { attempt: makeAttempt('completed'), evidence: ev('turn_end', { strength: 'genuine' }), state: 'completed', effects: ['record'] },
    R34: { attempt: makeAttempt('completed'), evidence: ev('coordinator_ack', { notify: 'completed', outcome: 'delivered' }), state: 'completed' },
    R20: { attempt: G(), evidence: ev('process_exit', { exitCode: 137 }), state: 'accepted', generation: 2, effects: ['reclaim', 'cancel_dispatch'] },
    R20f: { attempt: G(), evidence: ev('process_exit', { exitCode: 1, providerFailure: 'billing_failed' }), state: 'failed', effects: ['commit'] },
    R21: { attempt: G(), evidence: ev('session_error', { reason: 'adapter_error' }), state: 'failed', effects: ['commit'] },
    R22: { attempt: G(), evidence: ev('cancel', { reason: 'operator_cancel' }, { source: 'operator' }), state: 'cancelled', effects: ['cancel_dispatch', 'commit'] },
    R23: { attempt: G(), evidence: ev('operator_status', { status: 'failed', reason: 'refine_terminal' }, { source: 'operator' }), state: 'failed', effects: ['commit'] },
    R29: { attempt: G(), evidence: ev('no_progress', { stalledMs: 200_000, observedStatus: 'idle', finalAssistantPresent: true }), state: 'finalizing', effects: ['hold'] },
    R30: { attempt: G(), evidence: ev('no_progress', { stalledMs: 200_000, observedStatus: 'generating', finalAssistantPresent: false }), state: 'generating', effects: ['notify_coordinator'] },
    R31: { attempt: G(), evidence: ev('liveness', { result: 'dead' }), state: 'accepted', generation: 2, effects: ['reclaim'] },
    R31a: { attempt: G(), evidence: ev('liveness', { result: 'read_failed' }), state: 'generating' },
    R32: { attempt: G(), evidence: ev('liveness', { result: 'alive' }), state: 'generating', effects: ['hold'] },
    R32u: { attempt: G(), evidence: ev('liveness', { result: 'unknown' }), state: 'generating', effects: ['hold'] },
    R33: { attempt: G(), evidence: ev('turn_end', { strength: 'genuine', hollow: true }), state: 'accepted', generation: 2, effects: ['reclaim'] },
    R33f: { attempt: G({ hollowCount: 1 }), evidence: ev('turn_end', { strength: 'genuine', hollow: true }), state: 'failed', effects: ['commit'] },
    R35: { attempt: G(), evidence: ev('git_side_effect', { dirty: false, commitsSinceDispatch: 0, attributable: true }), state: 'generating' },
    H0: { attempt: G(), holds: [makeHold('weak_candidate')], evidence: expired('weak_candidate'), state: 'generating', effects: ['record'] },
    H1: { attempt: makeAttempt('accepted'), holds: [makeHold('await_delivery')], evidence: expired('await_delivery'), state: 'accepted', generation: 2, effects: ['reclaim'] },
    H2: { attempt: makeAttempt('delivered'), holds: [makeHold('await_consume')], evidence: expired('await_consume'), state: 'delivered', effects: ['redeliver', 'hold'] },
    H2r: { attempt: makeAttempt('delivered', { redriveCount: 1 }), holds: [makeHold('await_consume')], evidence: expired('await_consume'), state: 'accepted', generation: 2, effects: ['reclaim'] },
    H3: { attempt: makeAttempt('delivered'), holds: [makeHold('await_turn')], evidence: expired('await_turn'), state: 'accepted', generation: 2, effects: ['reclaim'] },
    H4: { attempt: G(), holds: [makeHold('liveness')], evidence: expired('liveness'), state: 'generating', effects: ['probe', 'hold'] },
    H5: { attempt: G(), holds: [makeHold('hard_ceiling')], evidence: expired('hard_ceiling'), state: 'failed', effects: ['commit'] },
    H6: { attempt: makeAttempt('delivered'), holds: [makeHold('suspension_before_consumed')], evidence: expired('suspension_before_consumed'), state: 'delivered', effects: ['release_hold'] },
    H7: { attempt: G(), holds: [makeHold('live_pending')], evidence: expired('live_pending'), state: 'generating', effects: ['release_hold', 'reevaluate'] },
};

describe('TRANSITIONS table', () => {
    it('has unique ids and carries every plan id (R0–R35, H1–H7)', () => {
        const ids = TRANSITIONS.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of PLAN_IDS) expect(ids).toContain(id);
    });

    it('has a firing fixture for every rule', () => {
        expect(Object.keys(FIRES).sort()).toEqual(TRANSITIONS.map((r) => r.id).sort());
    });

    for (const rule of TRANSITIONS) {
        it(`${rule.id} fires from its minimal fixture`, () => {
            const fx = FIRES[rule.id]!;
            const result = reduce({ attempt: fx.attempt, holds: fx.holds ?? [], evidence: fx.evidence, policy: POLICY, nowMs: NOW });
            expect(result.rule).toBe(rule.id);
            expect(result.verdict).toBe(rule.verdict);
            expect(result.attempt?.state ?? null).toBe(fx.state ?? null);
            if (rule.to !== 'same' && rule.to !== 'outcome') expect(result.attempt?.state).toBe(rule.to);
            if (rule.to === 'same' && fx.attempt) expect(result.attempt?.state).toBe(fx.attempt.state);
            if (rule.verdict === 'recorded') {
                // A recorded verdict never changes the attempt.
                expect(result.attempt).toEqual(fx.attempt);
                // Allowed side channels of a recorded verdict: the audit note, R28a's
                // cancel of a stale session, R27's late_completion notice.
                expect(result.effects.every((e) => e.kind === 'record' || e.kind === 'cancel_dispatch' || e.kind === 'notify_coordinator')).toBe(true);
            }
            if (fx.generation !== undefined) expect(result.attempt?.generation).toBe(fx.generation);
            const kinds = result.effects.map((e) => e.kind);
            for (const k of fx.effects ?? []) expect(kinds).toContain(k);
        });
    }
});

describe('rule matching is unambiguous', () => {
    const attemptVariants = (state: TurnState): TurnAttempt[] => [
        makeAttempt(state),
        makeAttempt(state, { redriveCount: 1, hollowCount: 1, livenessFailStreak: 2, suspension: 'choice', weakSince: NOW + 1 }),
        makeAttempt(state, { scope: 'plain', meshId: null, taskId: null, prevGeneration: null }),
        ...(state === 'completed' ? [makeAttempt(state, { terminal: { outcome: 'completed', reason: 'worker_reported', source: 'worker_tool', strength: 'tool_report', at: NOW } })] : []),
    ];

    it('at most one rule matches any (state, kind, guard variant, attempt variant)', () => {
        const ambiguous: string[] = [];
        let visited = 0;
        const check = (attempt: TurnAttempt | null, evidence: TurnEvidence, holds: TurnHold[], where: string) => {
            visited += 1;
            const matches = matchingRules({ attempt, holds, evidence, policy: POLICY, nowMs: NOW });
            if (matches.length > 1) ambiguous.push(`${where}: ${matches.map((r) => r.id).join(',')}`);
        };
        for (const kind of TURN_EVIDENCE_KINDS) {
            for (const variant of variantsFor(kind)) {
                check(null, variant.evidence, variant.holds, `none/${kind}/${variant.label}`);
                for (const state of TURN_STATES) {
                    for (const [i, attempt] of attemptVariants(state).entries()) {
                        check(attempt, variant.evidence, variant.holds, `${state}#${i}/${kind}/${variant.label}`);
                        // Same evidence one generation back (stale lane).
                        const stale = { ...variant.evidence, sessionId: 's0', attemptRef: { attemptId: 'a1', generation: 0 } } as TurnEvidence;
                        check(attempt, stale, variant.holds, `${state}#${i}/stale/${kind}/${variant.label}`);
                    }
                }
            }
        }
        expect(ambiguous).toEqual([]);
        // 57 evidence variants (all 23 kinds; +6 report-gate variants 2026-09-24) × (1 no-attempt + 28 attempt variants × 2 lanes).
        const variantCount = TURN_EVIDENCE_KINDS.reduce((n, kind) => n + variantsFor(kind).length, 0);
        expect(variantCount).toBe(57);
        expect(visited).toBe(57 * (1 + 28 * 2));
    });
});

describe('illegal (state, kind) pairs', () => {
    const uncovered = (state: TurnState): TurnEvidenceKind[] =>
        TURN_EVIDENCE_KINDS.filter((kind) => !TRANSITIONS.some((r) => r.lane === 'current' && ruleAdmitsState(r.from, state) && r.on.includes(kind)));

    it('the table leaves uncovered exactly the enumerated pairs', () => {
        for (const state of TURN_STATES) {
            expect({ state, kinds: [...uncovered(state)].sort() }).toEqual({ state, kinds: [...ILLEGAL[state]].sort() });
        }
    });

    it('every lane (none/stale) covers every kind', () => {
        for (const lane of ['none', 'stale'] as const) {
            const covered = new Set(TRANSITIONS.filter((r) => r.lane === lane).flatMap((r) => r.on));
            expect(TURN_EVIDENCE_KINDS.filter((k) => !covered.has(k))).toEqual([]);
        }
    });

    it('the reducer rejects every illegal pair and leaves the attempt untouched', () => {
        let count = 0;
        for (const state of TURN_STATES) {
            for (const kind of ILLEGAL[state]) {
                const attempt = makeAttempt(state);
                const variant = variantsFor(kind)[0]!;
                const result = reduce({ attempt, holds: variant.holds, evidence: variant.evidence, policy: POLICY, nowMs: NOW });
                expect({ state, kind, verdict: result.verdict }).toEqual({ state, kind, verdict: 'rejected' });
                expect(result.rejection).toBe(result.attempt && ['completed', 'failed', 'cancelled'].includes(state) ? 'already_terminal' : 'illegal_transition');
                expect(result.attempt).toEqual(attempt);
                count += 1;
            }
        }
        expect(count).toBe(Object.values(ILLEGAL).reduce((n, kinds) => n + kinds.length, 0));
    });
});
