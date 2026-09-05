/**
 * Regression: `TopicSubscriptionRegistry.markChatOutputActivity` must fire the
 * replica lane's transcript dirty trigger, throttled.
 *
 * Background — the defect this pins down. The replica lane has three dirty
 * triggers, and only one of them can fire at streaming rate:
 *
 *   - `status/reporter.ts`  — status transitions only
 *   - `commands/router.ts`  — once, post-chat
 *   - PTY output           — per streamed chunk  ← this file
 *
 * The PTY one was wired, then removed by `172ec64f` in favour of the 3000ms
 * stat poll. That was survivable only while the legacy `session.chat_tail`
 * PUSH still carried the fast path on a 700ms debounce; §8 unit 9 retired
 * legacy and left the poll — first tick discarded, so worst case ~6s — as the
 * only streaming-rate observer. That is the user-visible "chat feels slow".
 *
 * It returns THROTTLED, not raw, because each pull re-encodes the entire
 * snapshot rather than a delta: an unthrottled trigger costs one full reparse
 * per terminal chunk. The publisher's `inFlight` guard does NOT prevent this —
 * it merges concurrent work only, so a serial stream defeats it entirely
 * (see the 'serial chunks' test below, which is the measurement that
 * disproved the "inFlight already coalesces bursts" assumption).
 *
 * Both halves of the throttle are load-bearing:
 *   - leading  — without it, the first token of a reply waits a window
 *   - trailing — without it, the LAST chunk of a burst is never observed,
 *                because providers may append their JSONL record just after
 *                writing the corresponding terminal output. The failure is
 *                silent: the tail of every message quietly goes missing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    TRANSCRIPT_PTY_DIRTY_THROTTLE_MS,
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
        vi.useRealTimers();
    });

    it('pulls on the leading edge, with no timer advance', async () => {
        vi.useFakeTimers();
        const { pulled } = configureRecordingProjection();
        const registry = makeRegistry();

        registry.markChatOutputActivity('sess-1');
        await flushProjection();

        // The whole point: observed immediately, not on the next 3000ms stat tick.
        expect(pulled).toEqual(['sess-1']);
    });

    it('collapses a serial burst into leading + one trailing pull', async () => {
        vi.useFakeTimers();
        const { pulled } = configureRecordingProjection();
        const registry = makeRegistry();

        // Serial, fully-settled chunks — the shape that defeats `inFlight`.
        // Unthrottled this produced one full reparse per chunk (20 → 20).
        for (let i = 0; i < 20; i += 1) {
            registry.markChatOutputActivity('sess-1');
            await flushProjection();
        }
        expect(pulled).toEqual(['sess-1']);

        vi.advanceTimersByTime(TRANSCRIPT_PTY_DIRTY_THROTTLE_MS);
        await flushProjection();
        expect(pulled).toEqual(['sess-1', 'sess-1']);

        // Nothing further without new output.
        vi.advanceTimersByTime(TRANSCRIPT_PTY_DIRTY_THROTTLE_MS * 3);
        await flushProjection();
        expect(pulled).toHaveLength(2);
    });

    it('guarantees a trailing pull even for a single chunk', async () => {
        vi.useFakeTimers();
        const { pulled } = configureRecordingProjection();
        const registry = makeRegistry();

        // One lone chunk. The JSONL record may land after the terminal write,
        // so the trailing pull is mandatory here too — dropping it loses the tail.
        registry.markChatOutputActivity('sess-1');
        await flushProjection();
        expect(pulled).toHaveLength(1);

        vi.advanceTimersByTime(TRANSCRIPT_PTY_DIRTY_THROTTLE_MS);
        await flushProjection();
        expect(pulled).toEqual(['sess-1', 'sess-1']);
    });

    it('pulls again on the next window when output continues', async () => {
        vi.useFakeTimers();
        const { pulled } = configureRecordingProjection();
        const registry = makeRegistry();

        registry.markChatOutputActivity('sess-1');
        await flushProjection();
        expect(pulled).toHaveLength(1);

        // Sustained streaming keeps producing pulls — throttled, never starved.
        for (let window = 0; window < 3; window += 1) {
            registry.markChatOutputActivity('sess-1');
            vi.advanceTimersByTime(TRANSCRIPT_PTY_DIRTY_THROTTLE_MS);
            await flushProjection();
        }
        expect(pulled.length).toBeGreaterThanOrEqual(3);
        expect(pulled.every((s) => s === 'sess-1')).toBe(true);
    });

    it('throttles per session, so one busy session cannot starve another', async () => {
        vi.useFakeTimers();
        const { pulled } = configureRecordingProjection();
        const registry = makeRegistry();

        registry.markChatOutputActivity('sess-a');
        await flushProjection();
        registry.markChatOutputActivity('sess-b');
        await flushProjection();

        // Both get their own leading edge — the throttle window is per session.
        expect(pulled).toEqual(['sess-a', 'sess-b']);
    });

    it('does not fire for non-CLI sessions (the existing chat_tail gate still applies)', async () => {
        vi.useFakeTimers();
        const { pulled } = configureRecordingProjection();
        const registry = makeRegistry({ isCliSession: () => false });

        registry.markChatOutputActivity('sess-1');
        await flushProjection();
        vi.advanceTimersByTime(TRANSCRIPT_PTY_DIRTY_THROTTLE_MS * 2);
        await flushProjection();

        expect(pulled).toEqual([]);
    });

    it('does not fire for an empty sessionId', async () => {
        vi.useFakeTimers();
        const { pulled } = configureRecordingProjection();
        const registry = makeRegistry();

        registry.markChatOutputActivity('');
        await flushProjection();
        vi.advanceTimersByTime(TRANSCRIPT_PTY_DIRTY_THROTTLE_MS * 2);
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

    it('drops pending trailing work when the service is disposed', async () => {
        vi.useFakeTimers();
        const { pulled } = configureRecordingProjection();
        const registry = makeRegistry();

        registry.markChatOutputActivity('sess-1');
        await flushProjection();
        expect(pulled).toHaveLength(1);

        // Disposing must clear the armed trailing timer, not fire it into a
        // service that has been replaced.
        __resetTranscriptProjectionForTests();
        vi.advanceTimersByTime(TRANSCRIPT_PTY_DIRTY_THROTTLE_MS * 2);
        await flushProjection();
        expect(pulled).toHaveLength(1);
    });
});
