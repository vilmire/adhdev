import { describe, expect, it, vi } from 'vitest';
const notice = vi.hoisted(() => vi.fn());
vi.mock('../../src/mesh/turn-ledger/deliver.js', () => ({ notifyMeshCoordinator: notice }));
import { createWorkerSessionHealthMonitor } from '../../src/mesh/turn-ledger/worker-session-health.js';
import { createTurnScheduler } from '../../src/mesh/turn-ledger/scheduler.js';
import { DEFAULT_TURN_POLICY as P } from '../../src/mesh/turn-ledger/policy.js';
import { T0, dispatch, evd, ledgerOn, memDb } from './ledger-harness.js';
import type { TurnProbeRead } from '../../src/mesh/turn-ledger/probe.js';

function rig() {
    const ledger = ledgerOn(memDb());
    ledger.observe(dispatch({ scope: 'mesh_queue' }));
    ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
    ledger.observe(evd('turn_started', { retro: false }));
    return ledger;
}
const transcript = { providerObservedStatus: 'generating', activeModal: false, selfAttributing: false, trailingActivity: 0, nativeRead: false };

describe('worker session health advisory consumer', () => {
    it('scheduler probes deliver a stalled signal to the coordinator without reclaiming a live generating worker', async () => {
        notice.mockClear();
        const ledger = rig();
        const now = T0 + P.stallNoticeMs + 1000;
        const scheduler = createTurnScheduler({ ledger, now: () => now,
            probe: { locate: () => ({ kind: 'local' }), reader: { read: async () => ({ presence: 'present', status: 'generating' }) } },
        });
        scheduler.requestProbe('a1');
        await scheduler.tick();
        expect(notice).toHaveBeenCalledWith(expect.objectContaining({ meshId: 'm1',
            metadataEvent: expect.objectContaining({ source: 'worker_session_health', signal: 'stalled', attemptId: 'a1', sessionId: 's1' }),
        }));
        expect(ledger.getAttempt('a1')).toMatchObject({ generation: 0, state: 'generating', terminal: null });
        scheduler.requestProbe('a1');
        await scheduler.tick();
        expect(notice).toHaveBeenCalledTimes(1);
        scheduler.stop();
    });
    it('read failure deterioration is emitted once per streak and resets after a successful read', () => {
        const a = rig().getAttempt('a1')!;
        const emit = vi.fn();
        const monitor = createWorkerSessionHealthMonitor(emit);
        const failed: TurnProbeRead = { presence: 'present', transcript: null };
        monitor.observe(a, failed, T0 + 1000, P.stallNoticeMs);
        expect(emit).not.toHaveBeenCalled();
        monitor.observe(a, failed, T0 + 2000, P.stallNoticeMs);
        monitor.observe(a, failed, T0 + 3000, P.stallNoticeMs);
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit.mock.calls[0][1]).toMatchObject({ signal: 'deteriorating', readFailureStreak: 2 });
        monitor.observe(a, { presence: 'present', status: 'generating' }, T0 + 4000, P.stallNoticeMs);
        monitor.observe(a, failed, T0 + 5000, P.stallNoticeMs);
        monitor.observe(a, failed, T0 + 6000, P.stallNoticeMs);
        expect(emit.mock.calls.filter(([, event]) => event.signal === 'deteriorating')).toHaveLength(2);
    });
    it('four transitions within five minutes emit flapping; stable or modal workers do not emit stalled', () => {
        const a = rig().getAttempt('a1')!;
        const emit = vi.fn();
        const monitor = createWorkerSessionHealthMonitor(emit);
        for (let i = 0; i < 6; i++) monitor.observe(a, { presence: i % 2 ? 'unknown' : 'present', status: 'generating' }, T0 + i * 1000, P.stallNoticeMs);
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit.mock.calls[0][1]).toMatchObject({ signal: 'flapping', transitions: 4 });
        emit.mockClear();
        const stable = createWorkerSessionHealthMonitor(emit);
        stable.observe(a, { presence: 'present', transcript: { ...transcript, activeModal: true } }, T0 + P.stallNoticeMs * 2, P.stallNoticeMs);
        stable.observe(a, { presence: 'present', transcript: { ...transcript, newestActivityAt: T0 + P.stallNoticeMs * 2 } }, T0 + P.stallNoticeMs * 2, P.stallNoticeMs);
        expect(emit).not.toHaveBeenCalled();
    });
});
