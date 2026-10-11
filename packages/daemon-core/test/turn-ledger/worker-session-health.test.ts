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
    it('four generating/idle transitions spanning 30s emit flapping; stable or modal workers do not emit stalled', () => {
        const a = rig().getAttempt('a1')!;
        const emit = vi.fn();
        const monitor = createWorkerSessionHealthMonitor(emit);
        for (let i = 0; i < 5; i++) monitor.transition(a, i % 2 ? 'idle' : 'generating', i % 2 ? 'generating' : 'idle', T0 + i * 15_000);
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit.mock.calls[0][1]).toMatchObject({ signal: 'flapping', transitions: 4, taskId: 't1', nodeId: 'n1', sessionId: 's1' });
        emit.mockClear();
        const stable = createWorkerSessionHealthMonitor(emit);
        stable.observe(a, { presence: 'present', transcript: { ...transcript, activeModal: true } }, T0 + P.stallNoticeMs * 2, P.stallNoticeMs);
        stable.observe(a, { presence: 'present', transcript: { ...transcript, newestActivityAt: T0 + P.stallNoticeMs * 2 } }, T0 + P.stallNoticeMs * 2, P.stallNoticeMs);
        expect(emit).not.toHaveBeenCalled();
    });
});


describe('raw worker observations', () => {
    it('normal short idle edges, repaint bursts and expired cycles produce no alert', () => {
        const a = rig().getAttempt('a1')!;
        const emit = vi.fn();
        const monitor = createWorkerSessionHealthMonitor(emit);
        for (let i = 0; i < 4; i++) monitor.transition(a, i % 2 ? 'idle' : 'generating', i % 2 ? 'generating' : 'idle', T0 + i * 1000);
        expect(emit).not.toHaveBeenCalled();
        monitor.noProgress(a, 180_000, 'idle', T0 + 180_000);
        expect(emit.mock.calls.map(([, event]) => event.signal)).toEqual(['stalled']);
        emit.mockClear();
        monitor.transition(a, 'generating', 'idle', T0 + 6 * 60_000);
        expect(emit).not.toHaveBeenCalled();
        monitor.observe(a, { presence: 'present', status: 'generating', transcript: { ...transcript, newestActivityAt: T0 + 6 * 60_000 } }, T0 + 6 * 60_000 + 1, P.stallNoticeMs);
        expect(emit).not.toHaveBeenCalled();
    });
    it('short idle pulses separated by normal work do not accumulate a flap alert', () => {
        const a = rig().getAttempt('a1')!;
        const emit = vi.fn();
        const monitor = createWorkerSessionHealthMonitor(emit);
        for (let i = 0; i < 4; i++) {
            monitor.transition(a, 'generating', 'idle', T0 + i * 60_000);
            monitor.transition(a, 'idle', 'generating', T0 + i * 60_000 + 1000);
        }
        expect(emit).not.toHaveBeenCalled();
    });
    it('a sustained no_progress is consumed once, preserving identity and observation time', () => {
        const a = rig().getAttempt('a1')!;
        const emit = vi.fn();
        const monitor = createWorkerSessionHealthMonitor(emit);
        monitor.noProgress(a, 1000, 'idle', T0 + 1000);
        expect(emit).not.toHaveBeenCalled();
        monitor.noProgress(a, 180_000, 'idle', T0 + 180_000);
        monitor.noProgress(a, 200_000, 'idle', T0 + 200_000);
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit.mock.calls[0][1]).toMatchObject({ taskId: 't1', nodeId: 'n1', sessionId: 's1', attemptId: 'a1', generation: 0,
            at: T0 + 180_000, quietMs: 180_000, signal: 'stalled', source: 'monitor:no_progress' });
        expect(a.terminal).toBeNull();
        // Output at 210s follows the first alert, so a new 180s quiet episode
        // at 390s can produce a fresh advisory rather than being hidden forever.
        monitor.noProgress(a, 180_000, 'idle', T0 + 390_000);
        expect(emit).toHaveBeenCalledTimes(2);
    });
    it('generation/task changes reset accumulated cycles; stale edges and human waits do not create flapping', () => {
        const a = rig().getAttempt('a1')!;
        const emit = vi.fn();
        const monitor = createWorkerSessionHealthMonitor(emit);
        monitor.transition(a, 'generating', 'idle', T0);
        monitor.transition(a, 'idle', 'generating', T0 + 15_000);
        monitor.transition(a, 'generating', 'idle', T0 + 30_000);
        monitor.transition({ ...a, generation: 1 }, 'idle', 'generating', T0 + 45_000);
        monitor.transition(a, 'idle', 'generating', T0 - 1);
        monitor.transition(a, 'idle', 'waiting_approval', T0 + 40_000);
        monitor.noProgress(a, 360_000, 'waiting_approval', T0 + 400_000);
        expect(emit).not.toHaveBeenCalled();
    });
});
