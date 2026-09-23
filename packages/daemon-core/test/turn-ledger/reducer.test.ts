import { describe, expect, it } from 'vitest';
import type { TurnEvidence } from '@adhdev/mesh-shared';
import { classifyLane, expireHolds, reduce, type ReduceInput, type ReduceResult } from '../../src/mesh/turn-ledger/reducer.js';
import { RECLAIM_BUDGET } from '../../src/mesh/turn-ledger/policy.js';
import type { TurnAttempt, TurnHold } from '../../src/mesh/turn-ledger/types.js';
import { NOW, POLICY, REF, ev, makeAttempt, makeHold } from './fixtures.js';

const step = (attempt: TurnAttempt | null, evidence: TurnEvidence, holds: readonly TurnHold[] = [], nowMs = NOW): ReduceResult =>
    reduce({ attempt, holds, evidence, policy: POLICY, nowMs });

const LIVE_IDLE = { modal: false, adapterPending: false, trailingTool: false };

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const v of Object.values(value as object)) deepFreeze(v);
        Object.freeze(value);
    }
    return value;
}

describe('generation rule — older/other-generation evidence is recorded, never applied', () => {
    const attempt = makeAttempt('delivered', { generation: 1, prevGeneration: { sessionId: 's0', consumed: false }, consumedAt: null });

    it('a genuine completion from generation g−1 is recorded as late_completion_prev_generation (owner-narrowed R27)', () => {
        const late = ev('turn_end', { strength: 'genuine', summary: REF }, { sessionId: 's0', attemptRef: { attemptId: 'a1', generation: 0 } });
        const result = step(attempt, late);
        expect(result.rule).toBe('R27');
        expect(result.verdict).toBe('recorded');
        expect(result.attempt).toEqual(attempt);
        expect(result.effects).toEqual([{ kind: 'record', note: 'late_completion_prev_generation' }]);
        // Narrowed: no commit, no cancel of the redispatched run.
        expect(result.effects.some((e) => e.kind === 'commit' || e.kind === 'cancel_dispatch')).toBe(false);
    });

    it('the same late completion without attemptRef is resolved to g−1 by its session', () => {
        const late = ev('worker_report', { outcome: 'completed', summary: REF, hasHandoffNotes: false }, { sessionId: 's0', attemptRef: undefined, source: 'worker_tool' });
        expect(classifyLane(attempt, late)).toEqual({ lane: 'stale', effectiveGeneration: 0 });
        expect(step(attempt, late).rule).toBe('R27');
    });

    it('any other stale-generation evidence is recorded (R28), including a newer generation', () => {
        for (const generation of [0, 2]) {
            const e = ev('process_exit', { exitCode: 1 }, { attemptRef: { attemptId: 'a1', generation } });
            const result = step(attempt, e);
            expect({ generation, rule: result.rule, verdict: result.verdict }).toEqual({ generation, rule: 'R28', verdict: 'recorded' });
            expect(result.attempt).toEqual(attempt);
        }
    });

    it('a stale turn_started from a distinct session is recorded and its session cancelled (R28a)', () => {
        const result = step(attempt, ev('turn_started', { retro: false }, { sessionId: 's0', attemptRef: { attemptId: 'a1', generation: 0 } }));
        expect(result.rule).toBe('R28a');
        expect(result.effects).toContainEqual({ kind: 'cancel_dispatch', attemptId: 'a1', generation: 0, sessionId: 's0' });
        expect(result.attempt).toEqual(attempt);
    });

    it('a stale hold (hold generation ≠ attempt generation) is recorded', () => {
        const hold = makeHold('await_consume', { generation: 0 });
        const result = step(attempt, ev('hold_expired', { holdId: hold.holdId, reason: 'await_consume' }, { attemptRef: undefined }), [hold]);
        expect(result.rule).toBe('R28');
    });

    it('evidence from an unrelated session or attempt is rejected', () => {
        expect(step(attempt, ev('turn_started', { retro: false }, { sessionId: 'sX', attemptRef: undefined })).rejection).toBe('session_mismatch');
        expect(step(attempt, ev('turn_started', { retro: false }, { sessionId: 'sX' })).rejection).toBe('session_mismatch');
        expect(step(attempt, ev('turn_started', { retro: false }, { attemptRef: { attemptId: 'a9', generation: 1 } })).rejection).toBe('attempt_mismatch');
    });

    it('the current generation still applies', () => {
        expect(step(attempt, ev('turn_started', { retro: false })).attempt?.state).toBe('generating');
    });
});

describe('F2 — the worker report is primary; a later scrape adds nothing', () => {
    it('worker_report commits tool_report and notifies at once; later turn_end/transcript_final are recorded with no second notice', () => {
        const start = makeAttempt('generating');
        const reported = step(start, ev('worker_report', { outcome: 'completed', summary: REF, hasHandoffNotes: true }, { source: 'worker_tool' }));
        expect(reported.rule).toBe('R17');
        expect(reported.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported', summary: REF });
        expect(reported.effects.filter((e) => e.kind === 'notify_coordinator')).toEqual([
            { kind: 'notify_coordinator', attemptId: 'a1', generation: 1, notify: 'completed', taskId: 't1', coordinatorDaemonId: 'dc', coordinatorSessionId: 'coord' },
        ]);

        for (const scrape of [
            ev('turn_end', { strength: 'genuine', summary: REF }, { eventId: 'scrape-1' }),
            ev('transcript_final', { selfAttributing: false, nativeRead: false, live: LIVE_IDLE, summary: REF }, { eventId: 'scrape-2', source: 'coordinator_probe' }),
            ev('no_progress', { stalledMs: 1, observedStatus: 'idle', finalAssistantPresent: true }, { eventId: 'scrape-3' }),
        ]) {
            const later = step(reported.attempt, scrape, reported.holds);
            expect({ kind: scrape.kind, rule: later.rule, verdict: later.verdict }).toEqual({ kind: scrape.kind, rule: 'R18', verdict: 'recorded' });
            expect(later.effects).toEqual([{ kind: 'record', note: 'after_report' }]);
            expect(later.attempt).toEqual(reported.attempt);
        }
    });

    it('a blocked report commits failed', () => {
        const r = step(makeAttempt('generating'), ev('worker_report', { outcome: 'blocked', summary: REF, hasHandoffNotes: false }, { source: 'worker_tool' }));
        expect(r.attempt?.terminal?.outcome).toBe('failed');
    });

    it('a scrape-committed terminal records a later duplicate (R19 duplicate vs already_terminal)', () => {
        const done = step(makeAttempt('generating'), ev('turn_end', { strength: 'genuine' })).attempt;
        expect(step(done, ev('turn_end', { strength: 'genuine' }, { eventId: 'x' })).effects).toEqual([{ kind: 'record', note: 'duplicate' }]);
        expect(step(done, ev('session_error', { reason: 'provider_error' })).effects).toEqual([{ kind: 'record', note: 'already_terminal' }]);
    });
});

describe('reclaim', () => {
    it(`allows ${RECLAIM_BUDGET} reclaims, then the next reclaim fails the attempt`, () => {
        let attempt: TurnAttempt | null = makeAttempt('accepted', { generation: 0, prevGeneration: null });
        let holds: TurnHold[] = [];
        for (let i = 0; i < RECLAIM_BUDGET; i += 1) {
            const hold = makeHold('await_delivery', { generation: attempt!.generation });
            const r = step(attempt, ev('hold_expired', { holdId: hold.holdId, reason: 'await_delivery' }, { attemptRef: { attemptId: 'a1', generation: attempt!.generation }, eventId: `h${i}` }), [hold]);
            expect(r.rule).toBe('H1');
            attempt = r.attempt;
            holds = r.holds;
            expect(attempt).toMatchObject({ state: 'accepted', generation: i + 1, reclaimCount: i + 1 });
            // The re-armed await_delivery hold belongs to the new generation.
            expect(holds.map((h) => [h.reason, h.generation])).toEqual([['await_delivery', i + 1]]);
        }
        const last = step(attempt, ev('hold_expired', { holdId: holds[0]!.holdId, reason: 'await_delivery' }, { attemptRef: { attemptId: 'a1', generation: attempt!.generation } }), holds);
        expect(last.attempt?.state).toBe('failed');
        expect(last.attempt?.terminal?.reason).toBe('reclaim_budget_exhausted');
        expect(last.holds).toEqual([]);
        expect(last.effects.map((e) => e.kind)).toContain('queue_status');
    });

    it('process_exit mid-turn reclaims (session_exit) and keeps the hard ceiling; before the turn it is session_exit_before_turn', () => {
        const ceiling = makeHold('hard_ceiling');
        const mid = step(makeAttempt('generating'), ev('process_exit', { exitCode: 137 }), [ceiling, makeHold('liveness')]);
        expect(mid.effects).toContainEqual({ kind: 'reclaim', attemptId: 'a1', fromGeneration: 1, toGeneration: 2, reason: 'session_exit' });
        expect(mid.attempt?.prevGeneration).toEqual({ sessionId: 's1', consumed: true });
        expect(mid.holds.map((h) => h.reason).sort()).toEqual(['await_delivery', 'hard_ceiling']);
        const early = step(makeAttempt('delivered'), ev('process_exit', { exitCode: 1 }));
        expect(early.effects).toContainEqual(expect.objectContaining({ kind: 'reclaim', reason: 'session_exit_before_turn' }));
    });

    it('process_exit with a provider failure fails without reclaim', () => {
        const r = step(makeAttempt('generating'), ev('process_exit', { exitCode: 1, providerFailure: 'auth_failed' }));
        expect(r.attempt?.terminal?.reason).toBe('provider_auth_failed');
        expect(r.effects.some((e) => e.kind === 'reclaim')).toBe(false);
    });

    it('a plain attempt cannot be reclaimed: the reclaim becomes a failure with no mesh effects', () => {
        const opened = step(null, ev('turn_started', { retro: false }, { attemptRef: undefined }));
        expect(opened.attempt?.scope).toBe('plain');
        const r = step(opened.attempt, ev('process_exit', { exitCode: 9 }, { attemptRef: undefined }), opened.holds);
        expect(r.attempt?.state).toBe('failed');
        expect(r.effects.some((e) => e.kind === 'notify_coordinator' || e.kind === 'queue_status' || e.kind === 'graph_advance')).toBe(false);
    });
});

describe('holds', () => {
    it('expireHolds turns due holds into hold_expired evidence in deadline order', () => {
        const holds = [
            makeHold('liveness', { until: NOW - 5 }),
            makeHold('hard_ceiling', { until: NOW - 50 }),
            makeHold('await_turn', { until: NOW + 1 }),
            makeHold('suspension_before_consumed', { until: null }),
        ];
        const out = expireHolds(holds, NOW, { observedBy: 'dc', sessionIdFor: () => 's1' });
        expect(out.map((e) => e.reason)).toEqual(['hard_ceiling', 'liveness']);
        expect(out[0]).toEqual({
            eventId: `hold_expired:a1:hard_ceiling:${NOW - 50}`, at: NOW, source: 'scheduler', sessionId: 's1', observedBy: 'dc',
            kind: 'hold_expired', holdId: 'a1:hard_ceiling', reason: 'hard_ceiling',
        });
        expect(out[1]!.attemptRef).toEqual({ attemptId: 'a1', generation: 1 });
    });

    it('an expired weak_candidate commits a weak completion (R13a); new activity first cancels it (R12)', () => {
        const weak = step(makeAttempt('generating'), ev('turn_end', { strength: 'weak' }));
        expect(weak.attempt?.state).toBe('finalizing');
        const [expiry] = expireHolds(weak.holds.map((h) => ({ ...h, until: NOW })), NOW, { observedBy: 'dc', sessionIdFor: () => 's1' });
        const done = step(weak.attempt, expiry!, weak.holds);
        expect(done.rule).toBe('R13a');
        expect(done.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'weak', reason: 'weak_end_confirmed' });

        const resumed = step(weak.attempt, ev('transcript_activity', { newestActivityAt: NOW + 10 }), weak.holds);
        expect(resumed.rule).toBe('R12');
        expect(resumed.holds.some((h) => h.reason === 'weak_candidate')).toBe(false);
    });

    it('the candidate notice goes out once per generation', () => {
        const weak = step(makeAttempt('generating'), ev('turn_end', { strength: 'weak' }));
        const resumed = step(weak.attempt, ev('turn_started', { retro: false }, { at: NOW + 10 }), weak.holds);
        const again = step(resumed.attempt, ev('turn_end', { strength: 'weak' }, { at: NOW + 20 }), resumed.holds);
        expect(weak.effects.filter((e) => e.kind === 'notify_coordinator')).toHaveLength(1);
        expect(again.effects.filter((e) => e.kind === 'notify_coordinator')).toHaveLength(0);
    });

    it('a suspension before consumption is held and applied when the turn starts (R5 → R4)', () => {
        const held = step(makeAttempt('delivered'), ev('suspension', { modal: 'choice' }));
        const started = step(held.attempt, ev('turn_started', { retro: false }), held.holds);
        expect(started.attempt).toMatchObject({ state: 'suspended', suspension: 'choice' });
        expect(started.effects).toContainEqual(expect.objectContaining({ kind: 'notify_coordinator', notify: 'choice' }));
        expect(started.holds.some((h) => h.reason === 'suspension_before_consumed')).toBe(false);
    });

    it('a live-pending transcript is held and its expiry asks for a re-evaluation of that evidence (R16 → H7)', () => {
        const pending = ev('transcript_final', { selfAttributing: false, nativeRead: false, live: { ...LIVE_IDLE, adapterPending: true }, summary: REF }, { eventId: 'probe-7' });
        const held = step(makeAttempt('generating'), pending);
        expect(held.holds).toEqual([expect.objectContaining({ reason: 'live_pending', onExpire: 'reevaluate', until: NOW + 12_000, data: { evidenceId: 'probe-7', decline: 'session_not_idle' } })]);
        const [expiry] = expireHolds(held.holds, NOW + 12_000, { observedBy: 'dc', sessionIdFor: () => 's1' });
        const re = step(held.attempt, expiry!, held.holds, NOW + 12_000);
        expect(re.effects).toContainEqual({ kind: 'reevaluate', attemptId: 'a1', evidenceId: 'probe-7', forceLiveFalse: true });
    });
});

describe('determinism and purity', () => {
    it('same input → same output, and the input is not mutated', () => {
        const inputs: ReduceInput[] = [
            { attempt: makeAttempt('generating'), holds: [makeHold('liveness'), makeHold('hard_ceiling')], evidence: ev('process_exit', { exitCode: 1 }), policy: POLICY, nowMs: NOW },
            { attempt: makeAttempt('delivered'), holds: [makeHold('await_consume')], evidence: ev('hold_expired', { holdId: 'a1:await_consume', reason: 'await_consume' }), policy: POLICY, nowMs: NOW },
            { attempt: null, holds: [], evidence: ev('dispatch_accepted', { scope: 'mesh_direct', messageId: 'm' }, { attemptRef: undefined }), policy: POLICY, nowMs: NOW },
            { attempt: makeAttempt('generating'), holds: [], evidence: ev('worker_report', { outcome: 'completed', summary: REF, hasHandoffNotes: false }), policy: POLICY, nowMs: NOW },
        ];
        for (const input of inputs) {
            const snapshot = structuredClone(input);
            deepFreeze(input);
            const a = reduce(input);
            const b = reduce(input);
            expect(a).toEqual(b);
            expect(input).toEqual(snapshot);
        }
    });
});
