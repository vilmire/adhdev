import { describe, expect, it, vi } from 'vitest';
import { reduce } from '../../src/mesh/turn-ledger/reducer.js';
import { createTurnScheduler } from '../../src/mesh/turn-ledger/scheduler.js';
import { renderNotice } from '../../src/mesh/turn-ledger/deliver.js';
import { NOW, POLICY, REF, ev, expired, makeAttempt, makeHold } from './fixtures.js';
import { T0, dispatch, evd, fakePublisher, ledgerOn, memDb, recordingHost, recordingPorts, rowsOf } from './ledger-harness.js';

// Live incident 2026-10-06 (preview mesh_271444af…, task ec7017b3 on MainPC):
// a claude-cli worker answered ONLY "Login expired · Please run /login". The
// worker's daemon emitted a turn_end (the idle edge), R9r opened await_report,
// and 10 min later the scheduler's hold expiry committed R13r
//   task_completed · reason weak_end_confirmed · strength weak · source scheduler
// — a task that never started reported as completed. The worker daemon now
// stamps `providerFailure: 'auth_failed'` on that turn_end (completion-flush),
// and R9f commits it `failed / provider_auth_failed` instead.

describe('auth-failed turn — never task_completed (reducer)', () => {
    for (const strength of ['genuine', 'weak'] as const) {
        for (const reportExpected of [undefined, true]) {
            it(`generating + ${strength} turn_end${reportExpected ? ' (reportExpected)' : ''} with providerFailure=auth_failed commits failed/provider_auth_failed`, () => {
                const r = reduce({
                    attempt: makeAttempt('generating'), holds: [makeHold('liveness'), makeHold('hard_ceiling')],
                    evidence: ev('turn_end', { strength, summary: REF, providerFailure: 'auth_failed', ...(reportExpected ? { reportExpected } : {}) }),
                    policy: POLICY, nowMs: NOW,
                });
                expect(r.rule).toBe('R9f');
                expect(r.attempt?.state).toBe('failed');
                expect(r.attempt?.terminal).toMatchObject({ outcome: 'failed', reason: 'provider_auth_failed', strength: 'genuine' });
                expect(r.effects).toContainEqual(expect.objectContaining({ kind: 'queue_status', status: 'failed', reason: 'provider_auth_failed' }));
                expect(r.effects).toContainEqual(expect.objectContaining({ kind: 'task_terminal', outcome: 'failed' }));
                expect(r.effects.some((e) => e.kind === 'reclaim')).toBe(false);
                expect(r.effects.some((e) => e.kind === 'hold')).toBe(false);
            });
        }
    }

    it('a finalizing attempt (probe opened a weak candidate first) is failed by the auth turn_end, not left for R13a', () => {
        const r = reduce({
            attempt: makeAttempt('finalizing'), holds: [makeHold('weak_candidate')],
            evidence: ev('turn_end', { strength: 'weak', providerFailure: 'auth_failed' }),
            policy: POLICY, nowMs: NOW,
        });
        expect(r.rule).toBe('R9f');
        expect(r.attempt?.terminal).toMatchObject({ outcome: 'failed', reason: 'provider_auth_failed' });
    });

    it('a hollow-shaped auth turn is failed, not reclaimed back onto the same expired login', () => {
        const r = reduce({
            attempt: makeAttempt('generating'), holds: [],
            evidence: ev('turn_end', { strength: 'genuine', hollow: true, providerFailure: 'auth_failed' }),
            policy: POLICY, nowMs: NOW,
        });
        expect(r.rule).toBe('R9f');
        expect(r.effects.some((e) => e.kind === 'reclaim')).toBe(false);
    });

    it('a previous generation\'s auth-failed end is not adopted as a completion (R27a)', () => {
        const attempt = makeAttempt('delivered', { generation: 1, prevGeneration: { sessionId: 's0', consumed: false }, consumedAt: null });
        const r = reduce({
            attempt, holds: [],
            evidence: ev('turn_end', { strength: 'genuine', summary: REF, providerFailure: 'auth_failed' }, { sessionId: 's0', attemptRef: { attemptId: 'a1', generation: 0 } }),
            policy: POLICY, nowMs: NOW,
        });
        expect(r.rule).not.toBe('R27a');
        expect(r.attempt?.state).toBe('delivered');
    });

    it('control: the same turn_end WITHOUT the stamp still opens await_report and commits completed on expiry (the incident path)', () => {
        const end = reduce({
            attempt: makeAttempt('generating'), holds: [],
            evidence: ev('turn_end', { strength: 'genuine', summary: REF, reportExpected: true }),
            policy: POLICY, nowMs: NOW,
        });
        expect(end.rule).toBe('R9r');
        const exp = reduce({ attempt: end.attempt, holds: [makeHold('await_report')], evidence: expired('await_report'), policy: POLICY, nowMs: NOW });
        expect(exp.attempt?.terminal).toMatchObject({ outcome: 'completed', reason: 'weak_end_confirmed' });
    });
});

describe('auth-failed turn — ledger + scheduler end to end', () => {
    it('task ec7017b3 replay: dispatch → turn_started → auth turn_end → task failed, no task_completed even after every hold window', async () => {
        const db = memDb();
        let now = T0;
        const host = recordingHost();
        const ledger = ledgerOn(db, { now: () => now, ports: recordingPorts(), host, publisher: fakePublisher() });
        const scheduler = createTurnScheduler({ ledger, now: () => now, log: { info: () => {}, warn: () => {}, error: () => {} }, claim: vi.fn() });

        expect(ledger.observe(dispatch({ scope: 'mesh_queue' })).rule).toBe('R1');
        expect(ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'p2p' }, { source: 'dispatch' })).rule).toBe('R2');
        now = T0 + 5_000;
        expect(ledger.observe(evd('turn_started', { retro: false }, { at: now })).rule).toBe('R4');
        now = T0 + 39_000;
        const end = ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true, providerFailure: 'auth_failed' }, {
            source: 'completion_flush_genuine', at: now,
        }), { envelope: { finalSummary: 'Login expired · Please run /login' } });
        expect(end.rule).toBe('R9f');

        // Let every await_report / weak window pass — nothing may flip it to completed.
        for (const step of [POLICY.awaitReportMs, POLICY.hardCeilingMs]) {
            now += step + 1_000;
            await scheduler.tick();
        }
        const attempt = ledger.getAttempt('a1');
        expect(attempt).toMatchObject({ state: 'failed' });
        expect(attempt?.terminal).toMatchObject({ outcome: 'failed', reason: 'provider_auth_failed' });
        expect(host.calls).toContain('terminal:t1:failed');
        expect(host.calls).not.toContain('terminal:t1:completed');

        const notices = rowsOf(db, 'notify', 'a1').map((row) => ({ row, payload: JSON.parse(String(row.payload_json)) }));
        expect(notices.map((n) => n.payload.notify)).not.toContain('completed');
        const failed = notices.find((n) => n.payload.notify === 'failed')!;
        expect(failed).toBeDefined();
        const text = renderNotice({ ledger }, 'm1', failed.payload.entry, ledger.store.getEvent(String(failed.row.event_id))).text;
        expect(text).toContain('non-retryable authentication failure');
    });
});
