import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TURN_POLICY } from '../../src/mesh/turn-ledger/policy.js';
import { createTurnScheduler } from '../../src/mesh/turn-ledger/scheduler.js';
import { redeliverDispatch } from '../../src/mesh/mesh-dispatch-redelivery.js';
import { LOG } from '../../src/logging/logger.js';
import { T0, dispatch, evd, fakePublisher, ledgerOn, memDb, recordingHost, recordingPorts } from '../turn-ledger/ledger-harness.js';

// SUBMIT-UNCONFIRMED-RECLAIM ②: the turn ledger's `redeliver` port is wired
// (H2 is no longer a silent missingPort). It NEVER re-sends — an idle worker is
// no proof its prompt was never taken, and the driver's state for it is often
// `unknown` (review R1: a re-send there runs the task twice). It requests the
// attempt's delivered probe now; H2r reclaims if it stays unconsumed.

describe('turn-ledger redeliver port (H2)', () => {
    it('H2 reaches the port, which probes the attempt and re-sends nothing; H2r still reclaims', async () => {
        const db = memDb();
        let now = T0;
        const ports = recordingPorts();
        const baseCancel = ports.cancelDispatch;
        ports.cancelDispatch = (r) => { baseCancel?.(r); return { ...r, success: true, quiescent: true, incarnation: 'fixture-native-writer' }; };
        const resent: unknown[] = [];
        const probed: string[] = [];
        ports.redeliver = (e) => { resent.push(redeliverDispatch(e, { probe: (id) => probed.push(id) })); };
        const host = recordingHost();
        const ledger = ledgerOn(db, { now: () => now, ports, host, publisher: fakePublisher() });
        const scheduler = createTurnScheduler({ ledger, now: () => now, log: { info: () => {}, warn: () => {}, error: () => {} }, claim: vi.fn() });
        const info = vi.spyOn(LOG, 'info');
        try {
            ledger.observe(dispatch({ scope: 'mesh_queue' }));
            ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'dispatch' }));
            now += DEFAULT_TURN_POLICY.consumeGraceMs + 1;
            await scheduler.tick();
            expect(resent).toEqual(['probe_requested']);
            expect(probed).toEqual(['a1']);
            expect(info.mock.calls.some(([, m]) => String(m).includes('not re-sending'))).toBe(true);
            now += DEFAULT_TURN_POLICY.consumeGraceMs + 1;
            await scheduler.tick();
            expect(ledger.getAttempt('a1')).toMatchObject({ state: 'accepted', generation: 1 });
            expect(host.calls).toContain('requeue:t1');
        } finally {
            info.mockRestore();
        }
    });

    it('without a probe port it still re-sends nothing', () => {
        expect(redeliverDispatch({ attemptId: 'a9', generation: 0, sessionId: 's9', taskId: null })).toBe('not_resent');
    });

    it('a probe request that throws is contained', () => {
        expect(redeliverDispatch({ attemptId: 'a9', generation: 0, sessionId: 's9', taskId: null }, { probe: () => { throw new Error('boom'); } })).toBe('not_resent');
    });
});
