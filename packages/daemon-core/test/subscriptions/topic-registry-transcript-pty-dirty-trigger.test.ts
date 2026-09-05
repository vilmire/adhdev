/**
 * Regression: `TopicSubscriptionRegistry.markChatOutputActivity` must fire the
 * replica lane's transcript dirty trigger.
 *
 * Background — the defect this pins down. The replica lane has three dirty
 * triggers, and only one of them can fire at streaming rate:
 *
 *   - `status/reporter.ts`  — status transitions only
 *   - `commands/router.ts`  — once, post-chat
 *   - PTY output           — per streamed chunk  ← this file
 *
 * The PTY one was never wired, even though `markChatOutputActivity`'s own
 * comment asserted the contract ("기존 markChatOutputActivity ... 가
 * TranscriptProjectionService.markDirty(sessionId)를 호출한다"). It was
 * harmless while the legacy `session.chat_tail` PUSH ran in parallel and
 * carried the fast path on a 700ms debounce. §8 unit 9 retired legacy, which
 * left the 3000ms `TRANSCRIPT_STAT_POLL_INTERVAL_MS` stat poll — first tick
 * discarded, so worst case ~6s — as the ONLY streaming-rate observer. That is
 * the user-visible "chat feels slow" report.
 *
 * These tests deliberately use no timers: the point is that the trigger is
 * synchronous with output, not that some interval eventually catches up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
    __resetTranscriptProjectionForTests,
    configureTranscriptProjection,
} from '../../src/seqscribe/transcript-publisher.js';
import {
    TopicSubscriptionRegistry,
    type TopicSink,
} from '../../src/subscriptions/topic-registry.js';

async function flushProjection(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

function makeRegistry(chatTail?: { isCliSession?: (id: string) => boolean }): TopicSubscriptionRegistry {
    const sink: TopicSink = {
        send: () => true,
        isDeliverable: () => true,
        isAlive: () => true,
    };
    return new TopicSubscriptionRegistry(sink, {
        chatTail: {
            isCliSession: chatTail?.isCliSession ?? (() => true),
            scheduleGate: () => true,
            onDebouncedFlush: () => {},
        },
    });
}

/** Records which sessions the projection service was asked to re-collect. */
function configureRecordingProjection(): { pulled: string[] } {
    const pulled: string[] = [];
    configureTranscriptProjection({
        daemonId: () => 'daemon-1',
        writerId: () => 'writer-1',
        publishRevision: async () => {},
        resolveSourcePath: () => null,
        collectObservation: async (sessionId: string) => {
            pulled.push(sessionId);
            return null;
        },
    });
    return { pulled };
}

describe('markChatOutputActivity → replica transcript dirty trigger', () => {
    afterEach(() => {
        __resetTranscriptProjectionForTests();
    });

    it('fires the dirty trigger on PTY output, with no timer advance', async () => {
        const { pulled } = configureRecordingProjection();
        const registry = makeRegistry();

        registry.markChatOutputActivity('sess-1');
        await flushProjection();

        // The whole point: observed immediately, not on the next 3000ms stat tick.
        expect(pulled).toEqual(['sess-1']);
    });

    it('routes each session to its own dirty trigger', async () => {
        const { pulled } = configureRecordingProjection();
        const registry = makeRegistry();

        registry.markChatOutputActivity('sess-a');
        await flushProjection();
        registry.markChatOutputActivity('sess-b');
        await flushProjection();

        expect(pulled).toEqual(['sess-a', 'sess-b']);
    });

    it('does not fire for non-CLI sessions (the existing chat_tail gate still applies)', async () => {
        const { pulled } = configureRecordingProjection();
        const registry = makeRegistry({ isCliSession: () => false });

        registry.markChatOutputActivity('sess-1');
        await flushProjection();

        expect(pulled).toEqual([]);
    });

    it('does not fire for an empty sessionId', async () => {
        const { pulled } = configureRecordingProjection();
        const registry = makeRegistry();

        registry.markChatOutputActivity('');
        await flushProjection();

        expect(pulled).toEqual([]);
    });

    it('is a safe no-op when no projection service is configured', async () => {
        __resetTranscriptProjectionForTests();
        const registry = makeRegistry();

        // Unconfigured is the ordinary case for a daemon with no seqscribe lane;
        // the trigger must not throw there.
        expect(() => registry.markChatOutputActivity('sess-1')).not.toThrow();
        await flushProjection();
    });
});
