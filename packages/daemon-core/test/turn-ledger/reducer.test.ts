import { describe, expect, it } from 'vitest';
import type { TurnEvidence } from '@adhdev/mesh-shared';
import { classifyLane, expireHolds, isUnredeliveredDirectFailure, reduce, type ReduceInput, type ReduceResult } from '../../src/mesh/turn-ledger/reducer.js';
import { MAX_REDRIVES_PER_GENERATION, RECLAIM_BUDGET, endProbeGraceMs } from '../../src/mesh/turn-ledger/policy.js';
import { TRANSITIONS } from '../../src/mesh/turn-ledger/transitions.js';
import type { TurnAttempt, TurnHold } from '../../src/mesh/turn-ledger/types.js';
import { NOW, POLICY, REF, ev, expired, makeAttempt, makeHold } from './fixtures.js';

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

    it('R27a: g has not started — a genuine g−1 completion is adopted: g is cut, g−1 committed, one notice', () => {
        const late = ev('turn_end', { strength: 'genuine', summary: REF }, { sessionId: 's0', attemptRef: { attemptId: 'a1', generation: 0 } });
        const result = step(attempt, late);
        expect(result.rule).toBe('R27a');
        expect(result.verdict).toBe('applied');
        // Generation is monotonic: the adoption commits under g, rebinding to the g−1 session.
        expect(result.attempt).toMatchObject({ state: 'completed', generation: 1, sessionId: 's0' });
        expect(result.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'genuine', reason: 'turn_end', summary: REF });
        expect(result.effects[0]).toEqual({ kind: 'cancel_dispatch', attemptId: 'a1', generation: 1, sessionId: 's1', messageId: 'msg1', revokeBind: true });
        expect(result.effects.filter((e) => e.kind === 'notify_coordinator')).toEqual([
            { kind: 'notify_coordinator', attemptId: 'a1', generation: 1, notify: 'completed', taskId: 't1', coordinatorDaemonId: 'dc', coordinatorSessionId: 'coord', summary: REF },
        ]);
        expect(result.effects.filter((e) => e.kind === 'commit')).toHaveLength(1);
    });

    it('R27a adopts a g−1 worker report with its own outcome', () => {
        const report = ev('worker_report', { outcome: 'blocked', summary: REF, hasHandoffNotes: false }, { sessionId: 's0', attemptRef: undefined, source: 'worker_tool' });
        expect(classifyLane(attempt, report)).toEqual({ lane: 'stale', effectiveGeneration: 0 });
        const result = step(attempt, report);
        expect(result.rule).toBe('R27a');
        expect(result.attempt?.terminal).toMatchObject({ outcome: 'failed', strength: 'tool_report', reason: 'worker_reported' });
    });

    it('R27: g already running — the g−1 completion is recorded and a late_completion notice names g−1 with its summary', () => {
        const running = makeAttempt('generating', { generation: 1, prevGeneration: { sessionId: 's0', consumed: true } });
        const late = ev('turn_end', { strength: 'genuine', summary: REF }, { sessionId: 's0', attemptRef: { attemptId: 'a1', generation: 0 } });
        const result = step(running, late);
        expect(result.rule).toBe('R27');
        expect(result.verdict).toBe('recorded');
        expect(result.attempt).toEqual(running);
        expect(result.effects).toEqual([
            { kind: 'record', note: 'late_completion_prev_generation' },
            { kind: 'notify_coordinator', attemptId: 'a1', generation: 0, notify: 'late_completion', taskId: 't1', coordinatorDaemonId: 'dc', coordinatorSessionId: 'coord', summary: REF },
        ]);
        // Never auto-adopted while g runs: no commit, no cancel of g.
        expect(result.effects.some((e) => e.kind === 'commit' || e.kind === 'cancel_dispatch')).toBe(false);
    });

    it('R27 also applies once g is terminal (still recorded + noticed, never re-committed)', () => {
        const done = makeAttempt('completed', { generation: 1, prevGeneration: { sessionId: 's0', consumed: true } });
        const late = ev('worker_report', { outcome: 'completed', summary: REF, hasHandoffNotes: false }, { sessionId: 's0', attemptRef: { attemptId: 'a1', generation: 0 }, source: 'worker_tool' });
        const result = step(done, late);
        expect(result.rule).toBe('R27');
        expect(result.attempt).toEqual(done);
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
    // After the idle edge (finalizing) the report commits at once (R17). While
    // the session is still generating it is recorded and awaits the idle edge
    // (R17g → R9t/R13t, 2026-09-25) — see "report before the idle edge" below.
    it('worker_report after the idle edge commits tool_report and notifies at once; later turn_end/transcript_final are recorded with no second notice', () => {
        const start = makeAttempt('finalizing');
        const reported = step(start, ev('worker_report', { outcome: 'completed', summary: REF, hasHandoffNotes: true }, { source: 'worker_tool' }));
        expect(reported.rule).toBe('R17');
        expect(reported.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported', summary: REF });
        expect(reported.effects.filter((e) => e.kind === 'notify_coordinator')).toEqual([
            { kind: 'notify_coordinator', attemptId: 'a1', generation: 1, notify: 'completed', taskId: 't1', coordinatorDaemonId: 'dc', coordinatorSessionId: 'coord', summary: REF },
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
        const r = step(makeAttempt('finalizing'), ev('worker_report', { outcome: 'blocked', summary: REF, hasHandoffNotes: false }, { source: 'worker_tool' }));
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

    it('reclaim cuts g−1 first: cancel_dispatch of the old session with a worker-bind revoke, even from accepted', () => {
        for (const state of ['accepted', 'delivered', 'generating'] as const) {
            const evidence = state === 'accepted'
                ? ev('dispatch_failed', { workerAbsent: false, reason: 'transport_error' })
                : ev('process_exit', { exitCode: 1 });
            const r = step(makeAttempt(state), evidence);
            expect({ state, cancel: r.effects.find((e) => e.kind === 'cancel_dispatch') }).toEqual({
                state, cancel: { kind: 'cancel_dispatch', attemptId: 'a1', generation: 1, sessionId: 's1', messageId: 'msg1', revokeBind: true },
            });
        }
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
        expect(r.effects.some((e) => e.kind === 'notify_coordinator' || e.kind === 'queue_status' || e.kind === 'task_terminal')).toBe(false);
    });
});

describe('mesh_direct reclaim → failed at once (nothing redelivers a direct dispatch)', () => {
    // Every rule whose effects contain a `reclaim` template, with an evidence +
    // start state that selects it. The coverage check below fails when a new
    // reclaim rule is added to TRANSITIONS without a case here.
    type Trigger = { rule: string; state: TurnAttempt['state']; evidence: TurnEvidence; holds: TurnHold[]; cause: string; overrides?: Partial<TurnAttempt> };
    const TRIGGERS: Trigger[] = [
        { rule: 'R3', state: 'accepted', evidence: ev('delivery_refused', { messageId: 'msg1', reason: 'session_exited' }), holds: [makeHold('await_delivery', { onExpire: 'reclaim' }), makeHold('hard_ceiling')], cause: 'dispatch_refused_session_exited' },
        { rule: 'R24', state: 'accepted', evidence: ev('dispatch_failed', { workerAbsent: true, reason: 'worker_absent' }), holds: [makeHold('await_delivery', { onExpire: 'reclaim' }), makeHold('hard_ceiling')], cause: 'dispatch_failed' },
        { rule: 'R33', state: 'generating', evidence: ev('turn_end', { strength: 'genuine', hollow: true }), holds: [makeHold('liveness'), makeHold('hard_ceiling')], cause: 'hollow_completion', overrides: { maxTaskRetries: 3 } },
        { rule: 'R20', state: 'generating', evidence: ev('process_exit', { exitCode: 137 }), holds: [makeHold('liveness'), makeHold('hard_ceiling')], cause: 'session_exit' },
        { rule: 'R20', state: 'delivered', evidence: ev('process_exit', { exitCode: 1 }), holds: [makeHold('await_consume'), makeHold('await_turn'), makeHold('hard_ceiling')], cause: 'session_exit_before_turn' },
        { rule: 'R31', state: 'generating', evidence: ev('liveness', { result: 'dead' }), holds: [makeHold('liveness'), makeHold('hard_ceiling')], cause: 'session_dead' },
        { rule: 'H1', state: 'accepted', evidence: expired('await_delivery'), holds: [makeHold('await_delivery', { onExpire: 'reclaim' }), makeHold('hard_ceiling')], cause: 'assigned_stranded_dispatch_unconfirmed' },
        { rule: 'H2r', state: 'delivered', evidence: expired('await_consume'), holds: [makeHold('await_consume', { onExpire: 'redeliver' }), makeHold('await_turn'), makeHold('hard_ceiling')], cause: 'delivered_not_consumed_redrive', overrides: { redriveCount: MAX_REDRIVES_PER_GENERATION } },
        { rule: 'H3', state: 'delivered', evidence: expired('await_turn'), holds: [makeHold('await_consume'), makeHold('await_turn', { onExpire: 'reclaim' }), makeHold('hard_ceiling')], cause: 'delivered_no_turn_deadline' },
    ];

    it('covers every reclaim rule in TRANSITIONS', () => {
        const reclaimRules = TRANSITIONS.filter((r) => r.effects.some((e) => e.e === 'reclaim')).map((r) => r.id).sort();
        expect([...new Set(TRIGGERS.map((t) => t.rule))].sort()).toEqual(reclaimRules);
    });

    for (const t of TRIGGERS) {
        it(`${t.rule} (${t.cause}): terminal failed with the cause, holds released, queue row failed, one notice — no re-arm`, () => {
            const attempt = makeAttempt(t.state, { scope: 'mesh_direct', ...t.overrides });
            const r = step(attempt, t.evidence, t.holds);
            expect(r.rule).toBe(t.rule);
            expect(r.verdict).toBe('applied');
            expect(r.attempt).toMatchObject({ state: 'failed', generation: 1, reclaimCount: 0 });
            expect(r.attempt?.terminal).toMatchObject({ outcome: 'failed', strength: 'genuine', reason: t.cause });
            expect(isUnredeliveredDirectFailure(r.attempt)).toBe(true);
            expect(r.holds).toEqual([]);
            expect(r.effects).toContainEqual({ kind: 'release_hold', attemptId: 'a1', reasons: '*' });
            expect(r.effects.filter((e) => e.kind === 'queue_status')).toEqual([{ kind: 'queue_status', meshId: 'm1', taskId: 't1', status: 'failed', reason: t.cause }]);
            expect(r.effects.filter((e) => e.kind === 'task_terminal')).toEqual([{ kind: 'task_terminal', meshId: 'm1', taskId: 't1', outcome: 'failed' }]);
            expect(r.effects.filter((e) => e.kind === 'notify_coordinator')).toEqual([
                { kind: 'notify_coordinator', attemptId: 'a1', generation: 1, notify: 'failed', taskId: 't1', coordinatorDaemonId: 'dc', coordinatorSessionId: 'coord' },
            ]);
            expect(r.effects.filter((e) => e.kind === 'commit')).toHaveLength(1);
            // Not re-armed: no reclaim effect, no new hold, never `pending`.
            expect(r.effects.some((e) => e.kind === 'reclaim' || e.kind === 'hold')).toBe(false);
            expect(r.effects.some((e) => e.kind === 'queue_status' && e.status === 'pending')).toBe(false);
            // The session is cut exactly as a reclaim would have cut it.
            expect(r.effects.filter((e) => e.kind === 'cancel_dispatch')).toEqual([
                { kind: 'cancel_dispatch', attemptId: 'a1', generation: 1, sessionId: 's1', messageId: 'msg1', revokeBind: true },
            ]);
        });
    }

    it('an accepted direct attempt still naming the already-cut session emits no second cut', () => {
        const attempt = makeAttempt('accepted', { scope: 'mesh_direct', sessionId: 's0', prevGeneration: { sessionId: 's0', consumed: false } });
        const r = step(attempt, ev('dispatch_failed', { workerAbsent: false, reason: 'transport_error' }, { sessionId: 's0' }), [makeHold('await_delivery'), makeHold('hard_ceiling')]);
        expect(r.attempt?.terminal?.reason).toBe('dispatch_failed');
        expect(r.effects.some((e) => e.kind === 'cancel_dispatch')).toBe(false);
    });

    it('the reclaim budget is not consulted for a direct attempt (fails with the cause, not reclaim_budget_exhausted)', () => {
        const r = step(makeAttempt('accepted', { scope: 'mesh_direct', reclaimCount: RECLAIM_BUDGET }), ev('dispatch_failed', { workerAbsent: true, reason: 'worker_absent' }));
        expect(r.attempt?.terminal?.reason).toBe('dispatch_failed');
    });

    it('regression guard: the same triggers on a mesh_queue attempt still reclaim (g+1, accepted, pending, await_delivery re-armed)', () => {
        for (const t of TRIGGERS) {
            const r = step(makeAttempt(t.state, { scope: 'mesh_queue', ...t.overrides }), t.evidence, t.holds);
            expect({ rule: r.rule, state: r.attempt?.state, generation: r.attempt?.generation }).toEqual({ rule: t.rule, state: 'accepted', generation: 2 });
            expect(r.effects).toContainEqual({ kind: 'reclaim', attemptId: 'a1', fromGeneration: 1, toGeneration: 2, reason: t.cause });
            expect(r.effects).toContainEqual({ kind: 'queue_status', meshId: 'm1', taskId: 't1', status: 'pending', reason: t.cause });
            expect(r.effects.some((e) => e.kind === 'commit' || e.kind === 'notify_coordinator')).toBe(false);
            expect(r.holds.map((h) => h.reason).sort()).toEqual(['await_delivery', 'hard_ceiling']);
            expect(isUnredeliveredDirectFailure(r.attempt)).toBe(false);
        }
    });

    it('R2 redrive (same session, same generation) is untouched for a direct attempt', () => {
        const attempt = makeAttempt('delivered', { scope: 'mesh_direct' });
        const r = step(attempt, expired('await_consume'), [makeHold('await_consume', { onExpire: 'redeliver' }), makeHold('await_turn'), makeHold('hard_ceiling')]);
        expect(r.rule).toBe('H2');
        expect(r.attempt).toMatchObject({ state: 'delivered', generation: 1, redriveCount: 1 });
        expect(r.effects).toContainEqual({ kind: 'redeliver', attemptId: 'a1', generation: 1, messageId: 'msg1', sessionId: 's1' });
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
        const alive = step(weak.attempt, ev('liveness', { result: 'alive' }), weak.holds);
        const done = step(alive.attempt, expiry!, alive.holds);
        expect(done.rule).toBe('R13a');
        expect(done.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'weak', reason: 'weak_end_confirmed' });

        const resumed = step(weak.attempt, ev('transcript_activity', { newestActivityAt: NOW + 10 }), weak.holds);
        expect(resumed.rule).toBe('R12');
        expect(resumed.holds.some((h) => h.reason === 'weak_candidate')).toBe(false);
    });

    // 2026-10-08 preview, task 205e5dfa: the worker (antigravity-cli) ran `sleep 150`
    // in the background and ended its reply; its daemon's completion gate held the
    // turn_end (background_task_active), but the owner's transcript probe read the
    // reply as a weak final → R15 → R13a committed weak 12 s later, 84 s into the
    // task, and the worker's real report landed late against a terminal attempt.
    describe('R15p — a weak final the owner scraped on a mesh attempt awaits the report', () => {
        const scrape = (at = NOW) => ev('transcript_final', { selfAttributing: false, nativeRead: false, live: LIVE_IDLE, summary: REF }, { source: 'coordinator_probe', at, eventId: `probe-${at}` });

        it('opens an await_report hold, not a 12 s weak_candidate', () => {
            const r = step(makeAttempt('generating'), scrape());
            expect(r.rule).toBe('R15p');
            expect(r.attempt?.state).toBe('finalizing');
            expect(r.attempt?.terminal).toBeNull();
            expect(r.holds.map((h) => h.reason)).not.toContain('weak_candidate');
            const hold = r.holds.find((h) => h.reason === 'await_report');
            expect(hold).toMatchObject({ until: NOW + POLICY.awaitReportMs, onExpire: 'commit' });
            expect(r.effects.some((e) => e.kind === 'commit')).toBe(false);
        });

        it('the incident sequence: repeat scrape is recorded, the worker resumes (R12r), reports (R17g) and ends (R9t) — one genuine-report commit', () => {
            const opened = step(makeAttempt('generating'), scrape());
            const again = step(opened.attempt, scrape(NOW + 8_000), opened.holds, NOW + 8_000);
            expect(again.rule).toBe('R10a');
            expect(again.attempt?.terminal).toBeNull();
            const resumed = step(again.attempt, ev('turn_started', { retro: false }, { at: NOW + 100_000 }), again.holds, NOW + 100_000);
            expect(resumed.rule).toBe('R12r');
            expect(resumed.attempt?.state).toBe('generating');
            const reported = step(resumed.attempt, ev('worker_report', { outcome: 'completed', summary: REF, hasHandoffNotes: false }, { source: 'worker_tool', at: NOW + 102_000 }), resumed.holds, NOW + 102_000);
            expect(reported.rule).toBe('R17g');
            const ended = step(reported.attempt, ev('turn_end', { strength: 'genuine', reportExpected: true }, { at: NOW + 106_000 }), reported.holds, NOW + 106_000);
            expect(ended.rule).toBe('R9t');
            expect(ended.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported' });
        });

        it('a report while awaiting commits at once (R17); the worker daemon\'s own genuine end commits (R11); expiry commits weak (R13r)', () => {
            const opened = step(makeAttempt('generating'), scrape());
            expect(step(opened.attempt, ev('worker_report', { outcome: 'completed', summary: REF, hasHandoffNotes: false }, { source: 'worker_tool' }), opened.holds).rule).toBe('R17');
            expect(step(opened.attempt, ev('turn_end', { strength: 'genuine' }), opened.holds).rule).toBe('R11');
            const [expiry] = expireHolds(opened.holds.filter((h) => h.reason === 'await_report'), NOW + POLICY.awaitReportMs, { observedBy: 'dc', sessionIdFor: () => 's1' });
            const alive = step(opened.attempt, ev('liveness', { result: 'alive' }, { at: NOW + POLICY.awaitReportMs }), opened.holds, NOW + POLICY.awaitReportMs);
            const done = step(alive.attempt, expiry!, alive.holds, NOW + POLICY.awaitReportMs);
            expect(done.rule).toBe('R13r');
            expect(done.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'weak', reason: 'weak_end_confirmed' });
        });

        it('worker-side weak finals and plain attempts keep R15', () => {
            const workerSide = ev('transcript_final', { selfAttributing: false, nativeRead: false, live: LIVE_IDLE, summary: REF }, { source: 'monitor_final_summary' });
            expect(step(makeAttempt('generating'), workerSide).rule).toBe('R15');
            expect(step(makeAttempt('generating', { scope: 'plain' }), scrape()).rule).toBe('R15');
        });
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

// Live rc.40 run 5 (2026-09-24): a claude-cli worker told to `sleep 240` showed an
// idle screen 16 s into the turn; R9 committed the mesh attempt genuine 37 s after
// dispatch while the worker ran for 4 more minutes. The worker's daemon now stamps
// `reportExpected` on a turn_end of a session holding a live worker-MCP bind; the
// owner waits for the report (R9r) instead of committing on the idle edge.
describe('report gate — a report-capable worker\'s idle end awaits its report (R9r/R12r/R13r)', () => {
    const REPORT_REF = { topic: 'mesh.m1.handoff', writer: 'w2', seq: 9 };
    const idleEnd = (at = NOW) => ev('turn_end', { strength: 'genuine', summary: REF, reportExpected: true }, { at, eventId: `ev-turn_end-${at}` });

    it('(a) turn_end without a report opens an await_report hold — not committed; a report during the hold commits with the report\'s summary', () => {
        const held = step(makeAttempt('generating'), idleEnd());
        expect(held.rule).toBe('R9r');
        expect(held.attempt?.state).toBe('finalizing');
        expect(held.attempt?.terminal).toBeNull();
        expect(held.effects.some((e) => e.kind === 'commit' || e.kind === 'notify_coordinator')).toBe(false);
        const hold = held.holds.find((h) => h.reason === 'await_report');
        expect(hold).toMatchObject({ until: NOW + POLICY.awaitReportMs, onExpire: 'commit', generation: 1 });
        expect(hold?.data).toMatchObject({ textEventId: `ev-turn_end-${NOW}`, summaryTopic: REF.topic, summaryWriter: REF.writer, summarySeq: REF.seq });

        const report = ev('worker_report', { outcome: 'completed', summary: REPORT_REF, hasHandoffNotes: true }, { source: 'worker_tool', at: NOW + 60_000 });
        const done = step(held.attempt, report, held.holds, NOW + 60_000);
        expect(done.rule).toBe('R17');
        expect(done.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported', summary: REPORT_REF });
        expect(done.holds).toEqual([]);
        expect(done.effects.filter((e) => e.kind === 'notify_coordinator')).toEqual([
            expect.objectContaining({ notify: 'completed', summary: REPORT_REF }),
        ]);
        // A second idle end after the report is recorded, never a second notice (R18).
        const after = step(done.attempt, idleEnd(NOW + 70_000), done.holds);
        expect(after.rule).toBe('R18');
    });

    it('(b) a busy edge during the hold cancels the candidate: back to generating, hold released, falseIdleCount counted', () => {
        const held = step(makeAttempt('generating'), idleEnd());
        const resumed = step(held.attempt, ev('turn_started', { retro: false }, { at: NOW + 231_000 }), held.holds, NOW + 5_000);
        expect(resumed.rule).toBe('R12r');
        expect(resumed.attempt).toMatchObject({ state: 'generating', weakSince: null, terminal: null });
        expect(resumed.attempt?.data.falseIdleCount).toBe(1);
        expect(resumed.holds.some((h) => h.reason === 'await_report')).toBe(false);
        expect(resumed.effects).toContainEqual({ kind: 'record', note: 'false_idle_worker_resumed' });
        expect(resumed.effects.some((e) => e.kind === 'commit' || e.kind === 'notify_coordinator')).toBe(false);
        // The second idle re-arms the gate; a second resume counts again.
        const again = step(resumed.attempt, idleEnd(NOW + 251_000), resumed.holds, NOW + 6_000);
        expect(again.rule).toBe('R9r');
        const twice = step(again.attempt, ev('transcript_activity', { newestActivityAt: NOW + 260_000 }), again.holds, NOW + 7_000);
        expect(twice.rule).toBe('R12r');
        expect(twice.attempt?.data.falseIdleCount).toBe(2);
    });

    it('(c) hold expiry with no report commits weak (weak_end_confirmed) carrying the idle end\'s text', () => {
        const held = step(makeAttempt('generating'), idleEnd());
        const [expiry] = expireHolds(held.holds.filter((h) => h.reason === 'await_report').map((h) => ({ ...h, until: NOW + POLICY.awaitReportMs })), NOW + POLICY.awaitReportMs, { observedBy: 'dc', sessionIdFor: () => 's1' });
        const alive = step(held.attempt, ev('liveness', { result: 'alive' }, { at: NOW + POLICY.awaitReportMs }), held.holds, NOW + POLICY.awaitReportMs);
        const done = step(alive.attempt, expiry!, alive.holds, NOW + POLICY.awaitReportMs);
        expect(done.rule).toBe('R13r');
        expect(done.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'weak', reason: 'weak_end_confirmed', summary: REF });
        expect(done.effects.filter((e) => e.kind === 'notify_coordinator')).toEqual([
            expect.objectContaining({ notify: 'completed', summary: REF, textEventId: `ev-turn_end-${NOW}` }),
        ]);
    });

    it('(c\') a duplicate idle end or a strong probe final inside the hold is recorded, never committed', () => {
        const held = step(makeAttempt('generating'), idleEnd());
        expect(step(held.attempt, idleEnd(NOW + 1_000), held.holds).rule).toBe('R9d');
        const final = ev('transcript_final', { selfAttributing: false, nativeRead: true, nativeMarker: { outcome: 'completed' }, live: LIVE_IDLE }, { source: 'coordinator_probe', at: NOW + 2_000 });
        const probed = step(held.attempt, final, held.holds);
        expect(probed.rule).toBe('R11d');
        expect(probed.attempt?.terminal).toBeNull();
    });

    it('(d) no worker MCP bound (no reportExpected) — genuine on turn_end exactly as before (R9)', () => {
        const done = step(makeAttempt('generating'), ev('turn_end', { strength: 'genuine', summary: REF }));
        expect(done.rule).toBe('R9');
        expect(done.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'genuine', reason: 'turn_end', summary: REF });
        expect(done.holds).toEqual([]);
    });

    it('(d\') a plain attempt never awaits a report, even when stamped', () => {
        const plain = makeAttempt('generating', { scope: 'plain', meshId: null, taskId: null, prevGeneration: null });
        expect(step(plain, idleEnd()).rule).toBe('R9');
    });

    it('a suspension inside the hold releases it (the worker is plainly not done)', () => {
        const held = step(makeAttempt('generating'), idleEnd());
        const modal = step(held.attempt, ev('suspension', { modal: 'approval' }, { at: NOW + 1_000 }), held.holds);
        expect(modal.rule).toBe('R6');
        expect(modal.holds.some((h) => h.reason === 'await_report')).toBe(false);
    });
});

// 2026-10-13: a worker's over-limit report was refused, the worker died, the owner's
// liveness probe answered `unknown`, and the await_report timer ran out — the old
// R13r committed task_completed / weak_end_confirmed for a dead worker. A timer is
// not proof of completion: with liveness unconfirmed the expiry re-probes and re-arms
// once (R13u); only a confirming probe lets the weak commit through, and a second
// unconfirmed expiry fails the attempt with a typed reason (R13x) — never completed.
describe('unconfirmed liveness — a weak end / report-await expiry never mints completed from a timer (R13u/R13x)', () => {
    const idleEnd = (at = NOW) => ev('turn_end', { strength: 'genuine', summary: REF, reportExpected: true }, { at, eventId: `ev-turn_end-${at}` });
    const expire = (holds: readonly TurnHold[], reason: 'await_report' | 'weak_candidate', at: number) =>
        expireHolds(holds.filter((h) => h.reason === reason).map((h) => ({ ...h, until: at })), at, { observedBy: 'dc', sessionIdFor: () => 's1' })[0]!;
    const GRACE = endProbeGraceMs(POLICY);

    function heldWithLiveness(result: 'unknown' | 'read_failed') {
        const held = step(makeAttempt('generating'), idleEnd());
        expect(held.rule).toBe('R9r');
        const probed = step(held.attempt, ev('liveness', { result }, { at: NOW + 1_000 }), held.holds, NOW + 1_000);
        expect(probed.attempt?.lastLiveness).toBe(result);
        expect(probed.attempt?.terminal).toBeNull();
        return probed;
    }

    it('await_report expiry with liveness unknown defers: no commit, the same hold re-armed (text kept) and a fresh probe', () => {
        const probed = heldWithLiveness('unknown');
        const at = NOW + POLICY.awaitReportMs;
        const deferred = step(probed.attempt, expire(probed.holds, 'await_report', at), probed.holds, at);
        expect(deferred.rule).toBe('R13u');
        expect(deferred.attempt?.state).toBe('finalizing');
        expect(deferred.attempt?.terminal).toBeNull();
        expect(deferred.effects.some((e) => e.kind === 'commit' || e.kind === 'notify_coordinator')).toBe(false);
        expect(deferred.effects.some((e) => e.kind === 'probe')).toBe(true);
        expect(deferred.attempt?.data.unconfirmedEndDeferral).toEqual({ generation: 1, count: 1, requestedAt: at });
        const rearmed = deferred.holds.find((h) => h.reason === 'await_report');
        expect(rearmed).toMatchObject({ until: at + GRACE, onExpire: 'commit', generation: 1 });
        expect(rearmed?.data).toMatchObject({ textEventId: `ev-turn_end-${NOW}` });
    });

    it('a confirming alive probe inside the grace lets the next expiry commit weak exactly as before (R32 → R13r), text preserved', () => {
        const probed = heldWithLiveness('unknown');
        const at = NOW + POLICY.awaitReportMs;
        const deferred = step(probed.attempt, expire(probed.holds, 'await_report', at), probed.holds, at);
        const alive = step(deferred.attempt, ev('liveness', { result: 'alive' }, { at: at + 1_000 }), deferred.holds, at + 1_000);
        expect(alive.attempt?.lastLiveness).toBe('alive');
        const done = step(alive.attempt, expire(alive.holds, 'await_report', at + GRACE), alive.holds, at + GRACE);
        expect(done.rule).toBe('R13r');
        expect(done.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'weak', reason: 'weak_end_confirmed', summary: REF });
        expect(done.effects.filter((e) => e.kind === 'notify_coordinator')).toEqual([
            expect.objectContaining({ notify: 'completed', summary: REF, textEventId: `ev-turn_end-${NOW}` }),
        ]);
    });

    it('a second expiry still unconfirmed fails the attempt with weak_end_liveness_unconfirmed — never completed', () => {
        const probed = heldWithLiveness('unknown');
        const at = NOW + POLICY.awaitReportMs;
        const deferred = step(probed.attempt, expire(probed.holds, 'await_report', at), probed.holds, at);
        const stillUnknown = step(deferred.attempt, ev('liveness', { result: 'unknown' }, { at: at + 1_000 }), deferred.holds, at + 1_000);
        const failed = step(stillUnknown.attempt, expire(stillUnknown.holds, 'await_report', at + GRACE), stillUnknown.holds, at + GRACE);
        expect(failed.rule).toBe('R13x');
        expect(failed.attempt?.state).toBe('failed');
        expect(failed.attempt?.terminal).toMatchObject({ outcome: 'failed', strength: 'weak', reason: 'weak_end_liveness_unconfirmed' });
        expect(failed.effects.some((e) => e.kind === 'commit' && e.outcome === 'completed')).toBe(false);
    });

    it('a dead verdict reclaims (R31) — the expiry never gets to commit', () => {
        const probed = heldWithLiveness('unknown');
        const dead = step(probed.attempt, ev('liveness', { result: 'dead' }, { at: NOW + 2_000 }), probed.holds, NOW + 2_000);
        expect(dead.rule).toBe('R31');
        expect(dead.attempt?.terminal).toBeNull();
        expect(dead.effects.some((e) => e.kind === 'commit')).toBe(false);
    });

    it('a weak_candidate with read_failed liveness follows the same defer → fail path (R13u → R13x)', () => {
        const weak = step(makeAttempt('generating'), ev('turn_end', { strength: 'weak' }));
        expect(weak.attempt?.state).toBe('finalizing');
        const probed = step(weak.attempt, ev('liveness', { result: 'read_failed' }, { at: NOW + 1_000 }), weak.holds, NOW + 1_000);
        expect(probed.attempt?.lastLiveness).toBe('read_failed');
        const at = NOW + 20_000;
        const deferred = step(probed.attempt, expire(probed.holds, 'weak_candidate', at), probed.holds, at);
        expect(deferred.rule).toBe('R13u');
        expect(deferred.attempt?.terminal).toBeNull();
        const fresh = step(deferred.attempt, ev('liveness', { result: 'read_failed', probeStartedAtMs: at + 1 }, { at: at + 1 }), deferred.holds, at + 1);
        const failed = step(fresh.attempt, expire(fresh.holds, 'weak_candidate', at + GRACE), fresh.holds, at + GRACE);
        expect(failed.rule).toBe('R13x');
        expect(failed.attempt?.terminal).toMatchObject({ outcome: 'failed', reason: 'weak_end_liveness_unconfirmed' });
    });

    it('a (corrected) worker report inside the re-armed window still commits tool_report (R17)', () => {
        const probed = heldWithLiveness('unknown');
        const at = NOW + POLICY.awaitReportMs;
        const deferred = step(probed.attempt, expire(probed.holds, 'await_report', at), probed.holds, at);
        const reported = step(deferred.attempt, ev('worker_report', { outcome: 'completed', summary: REF, hasHandoffNotes: false }, { source: 'worker_tool', at: at + 2_000 }), deferred.holds, at + 2_000);
        expect(reported.rule).toBe('R17');
        expect(reported.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported' });
        expect(reported.holds).toEqual([]);
    });


    it('stale alive cannot complete; no new probe result has an explicit bounded timeout', () => {
        const held = step(makeAttempt('generating'), idleEnd());
        const alive = step(held.attempt, ev('liveness', { result: 'alive' }), held.holds);
        const at = NOW + POLICY.awaitReportMs;
        const deferred = step(alive.attempt, expire(alive.holds, 'await_report', at), alive.holds, at);
        expect(deferred.rule).toBe('R13u');
        const failed = step(deferred.attempt, expire(deferred.holds, 'await_report', at + GRACE), deferred.holds, at + GRACE);
        expect(failed.rule).toBe('R13z');
        expect(failed.attempt?.terminal).toMatchObject({ outcome: 'failed', reason: 'weak_end_probe_unobserved' });
    });

    it('a slow read begun before the new request is not fresh even if it finishes during grace', () => {
        const held = heldWithLiveness('unknown');
        const at = NOW + POLICY.awaitReportMs;
        const deferred = step(held.attempt, expire(held.holds, 'await_report', at), held.holds, at);
        const late = step(deferred.attempt, ev('liveness', { result: 'alive', probeStartedAtMs: at - 1 }, { at: at + 1 }), deferred.holds, at + 1);
        expect(step(late.attempt, expire(late.holds, 'await_report', at + GRACE), late.holds, at + GRACE).rule).toBe('R13z');
    });

    it('a persisted old deferral without a request timestamp gets the new full probe budget', () => {
        const held = heldWithLiveness('unknown');
        const at = NOW + POLICY.awaitReportMs;
        const legacy = { ...held.attempt!, data: { ...held.attempt!.data, unconfirmedEndDeferral: { generation: 1, count: 1 } } };
        const deferred = step(legacy, expire(held.holds, 'await_report', at), held.holds, at);
        expect(deferred.rule).toBe('R13u');
        expect(deferred.attempt?.data.unconfirmedEndDeferral).toEqual({ generation: 1, count: 1, requestedAt: at });
        expect(deferred.holds.find(h => h.reason === 'await_report')?.until).toBe(at + GRACE);
    });
    it('a never-probed attempt must request a probe before any weak completion', () => {
        const held = step(makeAttempt('generating'), idleEnd());
        expect(held.attempt?.lastLiveness ?? null).toBeNull();
        const at = NOW + POLICY.awaitReportMs;
        expect(step(held.attempt, expire(held.holds, 'await_report', at), held.holds, at).rule).toBe('R13u');
    });
});


describe('session rebound cuts weak-completion liveness', () => {
    it.each(['await_report', 'weak_candidate'] as const)('%s cannot use s1 liveness after rebinding to s2; a fresh s2 probe can complete', (reason) => {
        const hold = makeHold(reason, { until: NOW + 20 });
        const alive = step(makeAttempt('finalizing'), ev('liveness', { result: 'alive', probeStartedAtMs: NOW - 10 }, { at: NOW - 10 }), [hold], NOW - 10);
        const rebound = step(alive.attempt, ev('session_rebound', { toSessionId: 's2', reason: 'restart' }), alive.holds);
        expect(rebound.rule).toBe('R26');
        expect(rebound.attempt?.lastLiveness).toBeNull();
        const late = step(rebound.attempt, ev('liveness', { result: 'dead', probeStartedAtMs: NOW - 1 }, { sessionId: 's1', at: NOW + 1 }), rebound.holds, NOW + 1);
        expect(late.verdict).toBe('rejected');
        expect(late.effects.some(e => e.kind === 'reclaim' || e.kind === 'commit')).toBe(false);
        // A re-labelled read or cached sample from before the cut also cannot count.
        for (const evidence of [
            ev('liveness', { result: 'alive', probeStartedAtMs: NOW - 1 }, { sessionId: 's2', at: NOW + 1 }),
            ev('liveness', { result: 'alive', probeStartedAtMs: NOW + 1 }, { sessionId: 's2', at: NOW - 1 }),
        ]) expect(step(rebound.attempt, evidence, rebound.holds, NOW + 1).verdict).toBe('rejected');
        const expiry = (at: number) => ev('hold_expired', { holdId: hold.holdId, reason }, { sessionId: 's2', at, source: 'scheduler' });
        const deferred = step(rebound.attempt, expiry(NOW + 20), rebound.holds, NOW + 20);
        expect(deferred.rule).toBe('R13u');
        expect(deferred.attempt?.terminal).toBeNull();
        const until = NOW + 20 + endProbeGraceMs(POLICY);
        expect(step(deferred.attempt, expiry(until), deferred.holds, until).rule).toBe('R13z');
        const fresh = step(deferred.attempt, ev('liveness', { result: 'alive', probeStartedAtMs: until - 1 }, { sessionId: 's2', at: until - 1 }), deferred.holds, until - 1);
        const completed = step(fresh.attempt, expiry(until), fresh.holds, until);
        expect(completed.rule).toBe(reason === 'await_report' ? 'R13r' : 'R13a');
        expect(completed.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'weak' });
    });

    it('a fresh dead verdict for the replacement session still reclaims through R31', () => {
        const rebound = step(makeAttempt('generating'), ev('session_rebound', { toSessionId: 's2', reason: 'restart' }));
        const dead = step(rebound.attempt, ev('liveness', { result: 'dead', probeStartedAtMs: NOW + 1 }, { sessionId: 's2', at: NOW + 1 }), rebound.holds, NOW + 1);
        expect(dead.rule).toBe('R31');
        expect(dead.effects.some(e => e.kind === 'reclaim')).toBe(true);
        expect(dead.attempt?.generation).toBe(2);
    });

    it('rebind preserves the accepted report and fixed correction deadline', () => {
        const attempt = makeAttempt('generating', { data: {
            report: { generation: 1, outcome: 'completed', eventId: 'accepted-report', at: NOW - 10 },
            reportCorrection: { generation: 1, until: NOW + 100 },
        } });
        const rebound = step(attempt, ev('session_rebound', { toSessionId: 's2', reason: 'restart' }));
        expect(rebound.attempt?.data.report).toEqual(attempt.data.report);
        expect(rebound.attempt?.data.reportCorrection).toEqual(attempt.data.reportCorrection);
        const completed = step(rebound.attempt, ev('turn_end', { strength: 'genuine' }, { sessionId: 's2' }), rebound.holds);
        expect(completed.rule).toBe('R9t');
        expect(completed.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report' });
    });
});
