import { describe, expect, it } from 'vitest';
import { reduce } from '../../src/mesh/turn-ledger/reducer.js';
import { MAX_SUSPENSION_REMINDERS, SUSPENSION_REMINDER_MS } from '../../src/mesh/turn-ledger/policy.js';
import { NOW, POLICY, ev, makeAttempt } from './fixtures.js';

const parked = (extra: Record<string, unknown> = {}) => makeAttempt('suspended', {
    data: { providerSuspension: { generation: 1, modalKey: 'k', at: NOW - SUSPENSION_REMINDER_MS - 1_000, resolvedAt: null, ...extra } },
});
const tick = (attempt: ReturnType<typeof parked>, at = NOW, status: 'waiting_approval' | 'waiting_choice' | 'idle' = 'waiting_approval') =>
    reduce({ attempt, holds: [], policy: POLICY, nowMs: at,
        evidence: ev('no_progress', { stalledMs: 180_000, observedStatus: status, finalAssistantPresent: false }, { source: 'mesh_stall_watchdog', at }) });
const notifies = (r: ReturnType<typeof tick>) => r.effects.filter((e) => e.kind === 'notify_coordinator');

describe('R30p — bounded reminder for a worker still parked on an approval', () => {
    it('re-notifies once the interval since the last approval notice has passed, stamping the reminder', () => {
        const r = tick(parked());
        expect(r.rule).toBe('R30p');
        expect(notifies(r)).toMatchObject([{ notify: 'approval', attemptId: 'a1' }]);
        expect(r.attempt?.data.providerSuspension).toMatchObject({ reminders: 1, lastReminderAt: NOW });
        expect(r.attempt?.state).toBe('suspended');
    });
    it('a choice suspension is reminded as a choice', () => {
        const r = tick(makeAttempt('suspended', { suspension: 'choice', data: { providerSuspension: { generation: 1, modalKey: null, at: NOW - SUSPENSION_REMINDER_MS, resolvedAt: null } } }));
        expect(notifies(r)).toMatchObject([{ notify: 'choice' }]);
    });
    it('does not remind before the interval, measured from the previous reminder', () => {
        expect(notifies(tick(parked({ at: NOW - 1_000 })))).toHaveLength(0);
        expect(notifies(tick(parked({ reminders: 1, lastReminderAt: NOW - SUSPENSION_REMINDER_MS + 1 })))).toHaveLength(0);
        expect(notifies(tick(parked({ reminders: 1, lastReminderAt: NOW - SUSPENSION_REMINDER_MS })))).toHaveLength(1);
    });
    it('stops after the per-suspension cap', () => {
        expect(notifies(tick(parked({ reminders: MAX_SUSPENSION_REMINDERS, lastReminderAt: NOW - 10 * SUSPENSION_REMINDER_MS })))).toHaveLength(0);
    });
    it('a non-prompt observation or a resolved suspension never reminds (stale_suspension stays the deliver gate)', () => {
        expect(notifies(tick(parked(), NOW, 'idle'))).toHaveLength(0);
        expect(notifies(tick(parked({ resolvedAt: NOW - 5 })))).toHaveLength(0);
    });
    it('a generating attempt is unaffected (R30 stall rules still apply)', () => {
        const r = reduce({ attempt: makeAttempt('generating'), holds: [], policy: POLICY, nowMs: NOW,
            evidence: ev('no_progress', { stalledMs: 1, observedStatus: 'waiting_approval', finalAssistantPresent: false }) });
        expect(r.rule).toBe('R30');
    });
});
