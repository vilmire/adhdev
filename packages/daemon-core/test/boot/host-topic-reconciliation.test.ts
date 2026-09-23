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
            oldestLastFlushedAt: vi.fn((topic: string) => (lastSentAt.has(topic) ? lastSentAt.get(topic)! : null)),
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
        // (oldestLastFlushedAt === 0) — simulating host.modal's flush subscriber
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
        // though oldestLastFlushedAt would return null anyway — this pins that the
        // predicate is gated on hasSubscriptions, not just a null check.
        const { topics } = fakeTopics({ subscribed: new Set(), lastSentAt: new Map() });

        const off = subscribeHostTopicReconciliation(bus, topics as any, { now: nowFn, setIntervalFn: fakeSetInterval, clearIntervalFn: fakeClearInterval });
        bus.emit({ kind: 'mesh_state', at: now, meshId: 'mesh_a' });
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

    // ── Per-topic edge map (P-II-1 follow-up) ──────────────────────────────
    //
    // The live false positive: daemon.metadata / session.modal WARNed every
    // tick even though both were healthy, because the first cut tracked ONE
    // global "newest edge of any watched kind" and judged every topic
    // against it — an edge that does not invalidate a topic (an unrelated
    // command, or a status/registered/terminated/daemon_facts edge that this
    // file never proves flushes a watched topic) still moved the clock and
    // made unrelated topics look stale. These tests pin the fix: each topic
    // is judged only against edges proven (by the subscribers above) to
    // invalidate it.
    const commandExecutedBase = {
        kind: 'command_executed' as const,
        source: 'ipc' as const,
        postChat: false,
        interactionId: 'i1',
        success: true,
        fastFlush: false,
    };

    it('(a) an unrelated command_executed (empty invalidates) after a subscribe does not warn for daemon.metadata or session.modal', () => {
        const bus = createSessionLifecycleBus();
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        const edgeAt = now;
        // Both topics have subscribers and were never sent (0 = "has a
        // subscriber, never sent" per fakeTopics' convention) — if the
        // unrelated edge counted for them (the old global-tracker bug), this
        // would warn once the grace window elapses.
        const { topics } = fakeTopics({
            subscribed: new Set(['daemon.metadata', 'session.modal']),
            lastSentAt: new Map([['daemon.metadata', 0], ['session.modal', 0]]),
        });

        const off = subscribeHostTopicReconciliation(bus, topics as any, { now: nowFn, setIntervalFn: fakeSetInterval, clearIntervalFn: fakeClearInterval });
        // e.g. read_chat / get_status_metadata: invalidates nothing.
        bus.emit({ ...commandExecutedBase, command: 'read_chat', at: edgeAt, invalidates: new Set() });
        now += DEFAULT_HOST_RECONCILE_INTERVAL_MS;
        tick();

        expect(warn).not.toHaveBeenCalled();
        off();
    });

    it('(b) a modal edge with no session.modal flush after the grace WARNs for session.modal only', () => {
        const bus = createSessionLifecycleBus();
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        const edgeAt = now;
        const { topics } = fakeTopics({
            subscribed: new Set(['session.modal', 'daemon.metadata']),
            // session.modal never sent (0 = "has a subscriber, never sent" —
            // distinct from "no subscriber at all", which fakeTopics models as
            // an absent map key -> null); daemon.metadata not sent either, but
            // it has no qualifying edge in this scenario so it must stay silent.
            lastSentAt: new Map([['session.modal', 0]]),
        });

        const off = subscribeHostTopicReconciliation(bus, topics as any, { now: nowFn, setIntervalFn: fakeSetInterval, clearIntervalFn: fakeClearInterval });
        bus.emit({ kind: 'modal', sessionId: 's1', at: edgeAt, modal: null });
        now += DEFAULT_HOST_RECONCILE_INTERVAL_MS;
        tick();

        expect(warn).toHaveBeenCalledTimes(1);
        const [category, message] = warn.mock.calls[0]!;
        expect(category).toBe('HostRuntime');
        expect(message).toContain('session.modal');
        expect(message).not.toContain('daemon.metadata has subscribers');
        expect(message).toMatch(/newest session\.modal edge \(modal\)/);
        off();
    });

    it('(c) a daemon_facts edge with no daemon.metadata flush does not warn — daemon_facts is not a proven edge for any watched topic', () => {
        const bus = createSessionLifecycleBus();
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        const { topics } = fakeTopics({
            subscribed: new Set(['daemon.metadata']),
            lastSentAt: new Map(),
        });

        const off = subscribeHostTopicReconciliation(bus, topics as any, { now: nowFn, setIntervalFn: fakeSetInterval, clearIntervalFn: fakeClearInterval });
        bus.emit({ kind: 'daemon_facts', at: now, cause: 'provider_detection' });
        now += DEFAULT_HOST_RECONCILE_INTERVAL_MS;
        tick();

        expect(warn).not.toHaveBeenCalled();
        off();
    });

    it('(c\') a mesh_state edge with no daemon.metadata flush WARNs for daemon.metadata only', () => {
        const bus = createSessionLifecycleBus();
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        const edgeAt = now;
        const { topics } = fakeTopics({
            subscribed: new Set(['daemon.metadata', 'session.modal']),
            lastSentAt: new Map([['daemon.metadata', 0]]),
        });

        const off = subscribeHostTopicReconciliation(bus, topics as any, { now: nowFn, setIntervalFn: fakeSetInterval, clearIntervalFn: fakeClearInterval });
        bus.emit({ kind: 'mesh_state', at: edgeAt, meshId: 'mesh_a' });
        now += DEFAULT_HOST_RECONCILE_INTERVAL_MS;
        tick();

        expect(warn).toHaveBeenCalledTimes(1);
        const [category, message] = warn.mock.calls[0]!;
        expect(category).toBe('HostRuntime');
        expect(message).toContain('daemon.metadata');
        expect(message).not.toContain('session.modal has subscribers');
        expect(message).toMatch(/newest daemon\.metadata edge \(mesh_state\)/);
        off();
    });

    it('(d) an edge followed by a flush (lastSentAt >= edge) does not warn', () => {
        const bus = createSessionLifecycleBus();
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        const edgeAt = now;
        const { topics } = fakeTopics({
            subscribed: new Set(['daemon.metadata']),
            lastSentAt: new Map([['daemon.metadata', edgeAt + 50]]),
        });

        const off = subscribeHostTopicReconciliation(bus, topics as any, { now: nowFn, setIntervalFn: fakeSetInterval, clearIntervalFn: fakeClearInterval });
        bus.emit({ ...commandExecutedBase, command: 'launch_cli', at: edgeAt, invalidates: new Set(['daemon.metadata']) });
        now += DEFAULT_HOST_RECONCILE_INTERVAL_MS;
        tick();

        expect(warn).not.toHaveBeenCalled();
        off();
    });

    it('command_executed only counts for the topics it names in invalidates (session_host.diagnostics / workspace.git included)', () => {
        const bus = createSessionLifecycleBus();
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        const edgeAt = now;
        const { topics } = fakeTopics({
            subscribed: new Set(['session_host.diagnostics', 'workspace.git', 'daemon.metadata']),
            lastSentAt: new Map([['session_host.diagnostics', 0]]),
        });

        const off = subscribeHostTopicReconciliation(bus, topics as any, { now: nowFn, setIntervalFn: fakeSetInterval, clearIntervalFn: fakeClearInterval });
        bus.emit({ ...commandExecutedBase, command: 'stop_session_host', at: edgeAt, invalidates: new Set(['session_host.diagnostics']) });
        now += DEFAULT_HOST_RECONCILE_INTERVAL_MS;
        tick();

        expect(warn).toHaveBeenCalledTimes(1);
        const [, message] = warn.mock.calls[0]!;
        expect(message).toContain('session_host.diagnostics');
        expect(message).not.toContain('workspace.git has subscribers');
        expect(message).not.toContain('daemon.metadata has subscribers');
        off();
    });

});
