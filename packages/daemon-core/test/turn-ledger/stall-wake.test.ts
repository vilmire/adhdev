import { describe, expect, it } from 'vitest';
import { DEFAULT_TURN_POLICY, type TurnPolicy } from '../../src/mesh/turn-ledger/policy.js';
import { T0, confirmFixtureWriterQuiescence, dispatch, evd, fakePublisher, ledgerOn, memDb, recordingHost, recordingPorts } from './ledger-harness.js';

// A stall is informational until it needs action: below policy.stallWakeMs, or while the provider
// shows a busy status, it is a recorded observation; past it, ONE durable notice per attempt.

function rig(policy: TurnPolicy = DEFAULT_TURN_POLICY) {
    const publisher = fakePublisher('w-dc');
    const ledger = ledgerOn(memDb(), { publisher, policy, selfDaemonId: 'dc' });
    ledger.observe(dispatch());
    ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
    ledger.observe(evd('turn_started', { retro: false }));
    const stalls = async () => {
        await ledger.flushPublish();
        return publisher.entries.filter((e) => e.entry.k === 'turn.notify' && (e.entry as { notify?: string }).notify === 'no_progress');
    };
    const stall = (stalledMs: number, observedStatus: 'idle' | 'generating' | 'unknown', id: string) =>
        ledger.observe(evd('no_progress', { stalledMs, observedStatus, finalAssistantPresent: false }, { eventId: id, source: 'coordinator_probe' }));
    return { ledger, stalls, stall };
}

describe('stall notices wake a coordinator only when they need action', () => {
    it('a 3-minute stall (the old threshold) is recorded as quiet, never published as a notice', async () => {
        const { ledger, stalls, stall } = rig();
        const r = stall(DEFAULT_TURN_POLICY.stallNoticeMs, 'idle', 'np-1');
        expect(r.verdict).toBe('applied');
        expect(await stalls()).toHaveLength(0);
        expect(ledger.getAttempt('a1')!.lastNoProgressNoticeAt).toBeNull();
    });

    it('stays quiet at any age while the provider still shows a busy status', async () => {
        const { stalls, stall } = rig();
        stall(DEFAULT_TURN_POLICY.stallWakeMs * 4, 'generating', 'np-gen');
        expect(await stalls()).toHaveLength(0);
    });

    it('wakes once at the wake threshold and never again for the same attempt', async () => {
        const { ledger, stalls, stall } = rig();
        stall(DEFAULT_TURN_POLICY.stallWakeMs, 'idle', 'np-wake');
        expect(await stalls()).toHaveLength(1);
        const stamped = ledger.getAttempt('a1')!.lastNoProgressNoticeAt;
        expect(stamped).not.toBeNull();
        // Later evidence of the same stall, even after the old 8-minute refire window: no second wake.
        stall(DEFAULT_TURN_POLICY.stallWakeMs + 2 * DEFAULT_TURN_POLICY.livenessDeadlineMs, 'idle', 'np-again');
        stall(DEFAULT_TURN_POLICY.stallWakeMs * 2, 'unknown', 'np-again-2');
        expect(await stalls()).toHaveLength(1);
    });

    it('keeps the env override: a lowered wake threshold pages earlier', async () => {
        const { stalls, stall } = rig({ ...DEFAULT_TURN_POLICY, stallWakeMs: DEFAULT_TURN_POLICY.stallNoticeMs });
        stall(DEFAULT_TURN_POLICY.stallNoticeMs, 'idle', 'np-low');
        expect(await stalls()).toHaveLength(1);
    });
});


// A worker that is generating but produces nothing is reclaimed after policy.stallReclaimMs
// (owner decision: after a bounded time the mesh decides and moves on).
describe('generating with no output → reclaim (stall_ceiling)', () => {
    const MIN = 60_000;
    const RECLAIM = DEFAULT_TURN_POLICY.stallReclaimMs;
    function stallRig(opts: { scope?: 'mesh_queue' | 'mesh_direct'; bg?: () => readonly string[] | undefined } = {}) {
        const clock = { at: T0 };
        const host = recordingHost();
        const ports = recordingPorts();
        const ledger = ledgerOn(memDb(), { now: () => clock.at, host, ports, publisher: fakePublisher('w-dc'), selfDaemonId: 'dc',
            ...(opts.bg ? { inspectBackgroundProcesses: opts.bg } : {}) });
        ledger.observe(dispatch({ scope: opts.scope ?? 'mesh_queue' }));
        ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
        ledger.observe(evd('turn_started', { retro: false }));
        const sweep = () => ledger.sweepExpiredHolds(clock.at);
        const stallHold = () => ledger.store.activeHolds('a1').find((h) => h.reason === 'stall_ceiling');
        return { clock, host, ports, ledger, sweep, stallHold };
    }

    it('arms the hold when the attempt enters generating; liveness alive does not re-arm it, output does', () => {
        const r = stallRig();
        expect(r.stallHold()).toMatchObject({ until: T0 + RECLAIM, onExpire: 'reclaim' });
        r.clock.at = T0 + 10 * MIN;
        r.ledger.observe(evd('liveness', { result: 'alive' }, { at: r.clock.at, source: 'coordinator_probe' }));
        expect(r.stallHold()?.until).toBe(T0 + RECLAIM);
        r.ledger.observe(evd('transcript_activity', { newestActivityAt: r.clock.at }, { at: r.clock.at, source: 'coordinator_probe' }));
        expect(r.stallHold()?.until).toBe(r.clock.at + RECLAIM);
    });

    it('a queue worker silent for stallReclaimMs is reclaimed through the writer stop: requeued as generation + 1 (stalled_no_output)', async () => {
        const r = stallRig();
        r.clock.at = T0 + RECLAIM + 1;
        const swept = r.sweep().find((x) => x.rule === 'H8');
        expect(swept).toBeTruthy();
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'stopping', generation: 0, terminal: null });
        expect(r.ledger.getAttempt('a1')!.data.writerStop?.reason).toBe('stalled_no_output');
        expect(r.ports.calls.some((c) => c.startsWith('cancel:s1'))).toBe(true);
        await confirmFixtureWriterQuiescence(r.ledger);
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'accepted', generation: 1, reclaimCount: 1, terminal: null });
        expect(r.host.calls).toContain('requeue:t1');
        expect(r.stallHold()).toBeUndefined();
    });

    it('output before the bound postpones the reclaim by a full window', () => {
        const r = stallRig();
        r.clock.at = T0 + RECLAIM - 5 * MIN;
        r.ledger.observe(evd('transcript_activity', { newestActivityAt: r.clock.at }, { at: r.clock.at, source: 'coordinator_probe' }));
        r.clock.at = T0 + RECLAIM + 1;
        expect(r.sweep().filter((x) => x.rule === 'H8')).toHaveLength(0);
        expect(r.ledger.getAttempt('a1')?.state).toBe('generating');
        r.clock.at += RECLAIM;
        expect(r.sweep().filter((x) => x.rule === 'H8')).toHaveLength(1);
    });

    it('a parked approval/choice is the owner\'s turn: the hold is dropped while suspended and re-armed on resume', () => {
        const r = stallRig();
        r.ledger.observe(evd('suspension', { modal: 'approval' }, { at: T0 + MIN }));
        expect(r.ledger.getAttempt('a1')?.state).toBe('suspended');
        expect(r.stallHold()).toBeUndefined();
        r.clock.at = T0 + 2 * RECLAIM; // well past the ceiling, still short of the hard ceiling
        expect(r.sweep().filter((x) => x.rule === 'H8')).toHaveLength(0);
        expect(r.ledger.getAttempt('a1')?.state).toBe('suspended');
        r.ledger.observe(evd('suspension_resolved', { resolution: 'approved', via: 'modal_button' }, { at: r.clock.at }));
        expect(r.stallHold()?.until).toBe(r.clock.at + RECLAIM);
    });

    it('a worker holding a live background process is working, not hung: the ceiling re-arms instead of reclaiming', () => {
        let live: readonly string[] | undefined = ['npm'];
        const r = stallRig({ bg: () => live });
        r.clock.at = T0 + RECLAIM + 1;
        const first = r.sweep().find((x) => x.rule === 'H8b');
        expect(first).toBeTruthy();
        expect(r.ledger.getAttempt('a1')?.state).toBe('generating');
        expect(r.stallHold()?.until).toBe(r.clock.at + RECLAIM);
        live = undefined; // the process is gone and nothing else moved
        r.clock.at += RECLAIM + 1;
        expect(r.sweep().filter((x) => x.rule === 'H8')).toHaveLength(1);
        expect(r.ledger.getAttempt('a1')?.state).toBe('stopping');
    });

    it('a direct dispatch ends failed stalled_no_output after the stop (nothing redelivers it); 0 disables the ceiling', async () => {
        const r = stallRig({ scope: 'mesh_direct' });
        r.clock.at = T0 + RECLAIM + 1;
        r.sweep();
        await confirmFixtureWriterQuiescence(r.ledger);
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'failed', terminal: { outcome: 'failed', reason: 'stalled_no_output' } });
        const off = ledgerOn(memDb(), { now: () => T0, publisher: fakePublisher('w-dc'), selfDaemonId: 'dc', policy: { ...DEFAULT_TURN_POLICY, stallReclaimMs: 0 } });
        off.observe(dispatch());
        off.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
        off.observe(evd('turn_started', { retro: false }));
        expect(off.store.activeHolds('a1').some((h) => h.reason === 'stall_ceiling')).toBe(false);
    });
});
