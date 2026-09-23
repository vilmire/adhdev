/**
 * subscribeHostTopicReconciliation — the WARN-only safety net that replaced
 * both hosts' 2-2.5s "always re-flush every push topic" `setInterval`
 * (wiring-unification P-II item 1, design §7f).
 *
 * It must NEVER call flushNow/invalidate — that would silently reinstate a
 * second delivery path. It only compares each watched topic's oldest
 * `lastSentAt` against the newest bus edge and WARNs when a topic with live
 * subscribers has gone stale for longer than the grace window.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import { LOG } from '../../src/logging/logger.js';
import {
    subscribeHostTopicReconciliation,
    DEFAULT_HOST_RECONCILE_INTERVAL_MS,
} from '../../src/boot/host-subscribers.js';

function fakeTopics(overrides: {
    subscribed?: Set<string>;
    lastSentAt?: Map<string, number>;
} = {}) {
    const subscribed = overrides.subscribed ?? new Set<string>();
    const lastSentAt = overrides.lastSentAt ?? new Map<string, number>();
    const flushNow = vi.fn();
    const invalidate = vi.fn();
    return {
        flushNow,
        invalidate,
        topics: {
            hasSubscriptions: vi.fn((topic: string) => subscribed.has(topic)),
            oldestLastSentAt: vi.fn((topic: string) => (lastSentAt.has(topic) ? lastSentAt.get(topic)! : null)),
            flushNow,
            invalidate,
        },
    };
}

describe('subscribeHostTopicReconciliation', () => {
    let now = 0;
    const nowFn = () => now;
    let timers: Array<{ fn: () => void; ms: number }>;

    const fakeSetInterval = ((fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return { fn, ms } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval;
    const fakeClearInterval = vi.fn() as unknown as typeof clearInterval;

    beforeEach(() => {
        now = 1_000_000;
        timers = [];
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function tick() {
        for (const t of timers) t.fn();
    }

    it('never flushes: a healthy run with no subscribers produces no WARN and never calls flushNow/invalidate', () => {
        const bus = createSessionLifecycleBus();
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        const { topics, flushNow, invalidate } = fakeTopics();

        const off = subscribeHostTopicReconciliation(bus, topics as any, { now: nowFn, setIntervalFn: fakeSetInterval, clearIntervalFn: fakeClearInterval });
        now += DEFAULT_HOST_RECONCILE_INTERVAL_MS * 3;
        tick();

        expect(warn).not.toHaveBeenCalled();
        expect(flushNow).not.toHaveBeenCalled();
        expect(invalidate).not.toHaveBeenCalled();
        off();
    });

    it('healthy run: a topic with subscribers that WAS flushed shortly after the newest edge produces no WARN', () => {
        const bus = createSessionLifecycleBus();
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        const edgeAt = now;
        const { topics } = fakeTopics({
            subscribed: new Set(['session.modal']),
            // Flushed 1s after the edge (as if the event-driven host.modal
            // subscriber ran normally) — comfortably inside the grace window.
            lastSentAt: new Map([['session.modal', edgeAt + 1000]]),
        });

        const off = subscribeHostTopicReconciliation(bus, topics as any, { now: nowFn, setIntervalFn: fakeSetInterval, clearIntervalFn: fakeClearInterval });
        bus.emit({ kind: 'modal', sessionId: 's1', at: edgeAt, modal: null });
        now += DEFAULT_HOST_RECONCILE_INTERVAL_MS;
        tick();

        expect(warn).not.toHaveBeenCalled();
        off();
    });

    it('fault injection: a silently-broken bus subscriber (topic never flushed since a bus edge) WARNs within one cycle, naming the topic and the age', () => {
        const bus = createSessionLifecycleBus();
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        // session.modal has a live subscriber, but nothing was ever sent to it
        // (oldestLastSentAt === 0) — simulating host.modal's flush subscriber
        // silently no-op'ing (doesn't throw, just doesn't act).
        const { topics } = fakeTopics({
            subscribed: new Set(['session.modal']),
            lastSentAt: new Map([['session.modal', 0]]),
        });

        const off = subscribeHostTopicReconciliation(bus, topics as any, { now: nowFn, setIntervalFn: fakeSetInterval, clearIntervalFn: fakeClearInterval });
        bus.emit({ kind: 'modal', sessionId: 's1', at: now, modal: null });
        now += DEFAULT_HOST_RECONCILE_INTERVAL_MS;
        tick();

        expect(warn).toHaveBeenCalledTimes(1);
        const [category, message] = warn.mock.calls[0]!;
        expect(category).toBe('HostRuntime');
        expect(message).toContain('session.modal');
        expect(message).toMatch(/no flush since \d+ms ago/);
        off();
    });

    it('only reports topics that actually have subscribers', () => {
        const bus = createSessionLifecycleBus();
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        // machine.runtime has no subscribers at all (hasSubscriptions=false) even
        // though oldestLastSentAt would return null anyway — this pins that the
        // predicate is gated on hasSubscriptions, not just a null check.
        const { topics } = fakeTopics({ subscribed: new Set(), lastSentAt: new Map() });

        const off = subscribeHostTopicReconciliation(bus, topics as any, { now: nowFn, setIntervalFn: fakeSetInterval, clearIntervalFn: fakeClearInterval });
        bus.emit({ kind: 'status', sessionId: 's1', at: now, providerType: 'claude-cli', prev: 'idle', next: 'generating', cause: 'fsm_state' });
        now += DEFAULT_HOST_RECONCILE_INTERVAL_MS;
        tick();

        expect(warn).not.toHaveBeenCalled();
        off();
    });

    it('off() detaches the bus listener and clears the interval', () => {
        const bus = createSessionLifecycleBus();
        const { topics } = fakeTopics();
        const off = subscribeHostTopicReconciliation(bus, topics as any, { now: nowFn, setIntervalFn: fakeSetInterval, clearIntervalFn: fakeClearInterval });
        off();
        expect(fakeClearInterval).toHaveBeenCalled();
        // Bus emits after off() must not throw (listener detached).
        expect(() => bus.emit({ kind: 'daemon_facts', at: now, cause: 'command' })).not.toThrow();
    });
});
