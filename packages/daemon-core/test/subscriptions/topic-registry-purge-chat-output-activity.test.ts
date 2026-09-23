/**
 * `TopicSubscriptionRegistry.purgeChatOutputActivity` — eager cleanup of a
 * terminated session's chat-output-activity entry (wiring-unification B2
 * item 14 / B residue cleanup).
 *
 * Before this, a terminated session's entry in `chatOutputActiveAt` only
 * dropped out lazily, the next time `getRecentlyOutputActiveChatSessionIds`
 * happened to sweep past its hot-window expiry (default 8s —
 * DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS). Harmless (bounded, self-healing)
 * but wasteful: a session that will never emit output again still counts as
 * "recently active" for up to that window. This registry has no bus access of
 * its own, so the host wires a `terminated` subscriber that calls this method
 * (see the wiring-unification B report's REQUESTED EDIT for host-runtime.ts).
 */
import { describe, expect, it } from 'vitest';
import {
    TopicSubscriptionRegistry,
    type TopicSink,
} from '../../src/subscriptions/topic-registry.js';

function makeRegistry(now: () => number): TopicSubscriptionRegistry {
    const sink: TopicSink = {
        send: () => true,
        isDeliverable: () => true,
        isAlive: () => true,
    };
    return new TopicSubscriptionRegistry(sink, {
        now,
        chatTail: {
            isCliSession: () => true,
            scheduleGate: () => true,
            onDebouncedFlush: () => {},
        },
    });
}

describe('purgeChatOutputActivity', () => {
    it('removes the session immediately — it no longer counts as recently active', () => {
        let clock = 1_000;
        const registry = makeRegistry(() => clock);

        registry.markChatOutputActivity('sess-1');
        expect(registry.getRecentlyOutputActiveChatSessionIds(clock).has('sess-1')).toBe(true);

        registry.purgeChatOutputActivity('sess-1');
        expect(registry.getRecentlyOutputActiveChatSessionIds(clock).has('sess-1')).toBe(false);
    });

    it('does not disturb an unrelated session\'s activity entry', () => {
        let clock = 1_000;
        const registry = makeRegistry(() => clock);

        registry.markChatOutputActivity('sess-1');
        registry.markChatOutputActivity('sess-2');

        registry.purgeChatOutputActivity('sess-1');

        const active = registry.getRecentlyOutputActiveChatSessionIds(clock);
        expect(active.has('sess-1')).toBe(false);
        expect(active.has('sess-2')).toBe(true);
    });

    it('is a no-op for a session with no recorded activity', () => {
        const registry = makeRegistry(() => 1_000);
        expect(() => registry.purgeChatOutputActivity('never-seen')).not.toThrow();
    });
});
