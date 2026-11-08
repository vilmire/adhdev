import { describe, expect, it, vi } from 'vitest';
import { createNoticeConsumeWatch } from '../../src/mesh/turn-ledger/notice-consume-watch.js';
import type { ConsumeView } from '../../src/sessions/input-consume-ack.js';

const view = (state: ConsumeView['state']): ConsumeView => ({ messageId: 'm', sessionId: 's', state, evidence: null, retries: 0, restored: false, revision: 1, updatedAt: 1 });
function harness(state: ConsumeView['state'] | undefined, parked = false) {
    const timers: Array<() => void> = [];
    const release = vi.fn(() => true);
    const forget = vi.fn();
    const w = createNoticeConsumeWatch({
        settle: async () => (state ? view(state) : undefined), forget, release, stillParked: () => parked,
        setTimer: (fn) => { timers.push(fn); return {}; },
    });
    return { w, timers, release, forget };
}
const input = { messageId: 'notify:m1:w:7', sessionId: 's', claimEventIds: ['delivered:m1:w:7', 'delivered:m1:w:8'], notify: 'approval' as const };

describe('notice consume watch — unconfirmed approval notices are redelivered once', () => {
    it('releases every claim and forgets the dedupe when the write was never confirmed', async () => {
        const h = harness('submitted');
        h.w.watch(input);
        expect(h.timers).toHaveLength(1);
        expect(await h.w.check(input)).toBe('released');
        expect(h.forget).toHaveBeenCalledWith('notify:m1:w:7');
        expect(h.release.mock.calls.map((c) => c[0])).toEqual(['delivered:m1:w:7', 'delivered:m1:w:8']);
    });
    it('never touches a consumed notice', async () => {
        const h = harness('consumed');
        expect(await h.w.check(input)).toBe('consumed');
        expect(h.release).not.toHaveBeenCalled();
        expect(h.forget).not.toHaveBeenCalled();
    });
    it('leaves a notice still parked in the driver FIFO alone', async () => {
        expect(await harness('queued').w.check(input)).toBe('parked');
        const h = harness('written', true);
        expect(await h.w.check(input)).toBe('parked');
        expect(h.release).not.toHaveBeenCalled();
    });
    it('retries a message at most once and ignores non-action kinds', async () => {
        const h = harness(undefined);
        await h.w.check(input);
        h.w.watch(input);
        expect(h.timers).toHaveLength(0);
        h.w.watch({ ...input, messageId: 'notify:m1:w:9', notify: 'progress' });
        expect(h.timers).toHaveLength(0);
    });
});

describe('notice consume watch — a turn after the write counts as consumed', () => {
    it('does not release a notice whose session took a turn after it was typed, even if the journal reads unknown', async () => {
        const timers: Array<() => void> = [];
        const release = vi.fn(() => true);
        const turned = vi.fn((_s: string, since: number) => since > 0);
        const w = createNoticeConsumeWatch({
            settle: async () => view('unknown'), forget: vi.fn(), release, stillParked: () => false, sessionTurnedSince: turned,
            setTimer: (fn) => { timers.push(fn); return {}; },
        });
        w.watch(input);
        timers[0]!();
        await new Promise((r) => setTimeout(r, 0));
        expect(turned).toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
    });
});
