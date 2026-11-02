import { describe, expect, it } from 'vitest';
import { DEFAULT_TURN_POLICY, type TurnPolicy } from '../../src/mesh/turn-ledger/policy.js';
import { dispatch, evd, fakePublisher, ledgerOn, memDb } from './ledger-harness.js';

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
