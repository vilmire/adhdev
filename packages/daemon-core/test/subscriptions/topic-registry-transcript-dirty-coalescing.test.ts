import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    __getParsedJsonlCacheStatsForTests,
    __resetParsedJsonlCacheForTests,
    executeNativeHistory,
} from '../../src/providers/spec/native-history-executor.js';
import {
    TRANSCRIPT_PTY_DIRTY_THROTTLE_MS,
    __resetTranscriptProjectionForTests,
    configureTranscriptProjection,
    markTranscriptSessionDirty,
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

function makeRegistry(): TopicSubscriptionRegistry {
    const sink: TopicSink = {
        send: () => true,
        isDeliverable: () => true,
        isAlive: () => true,
    };
    return new TopicSubscriptionRegistry(sink, {
        chatTail: {
            isCliSession: () => true,
            scheduleGate: () => true,
            onDebouncedFlush: () => {},
        },
    });
}

describe('PTY transcript dirty trigger coalescing', () => {
    let tmpDir = '';

    afterEach(() => {
        __resetTranscriptProjectionForTests();
        __resetParsedJsonlCacheForTests();
        vi.useRealTimers();
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = '';
    });

    it('coalesces one PTY output burst instead of reparsing the JSONL once per event', async () => {
        vi.useFakeTimers();
        __resetParsedJsonlCacheForTests();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-pty-coalesce-'));
        const sessionId = '8c6cf338-ef5c-4df5-91a5-66c1e2ed4339';
        const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
        fs.writeFileSync(transcriptPath, `${JSON.stringify({ role: 'assistant', content: 'first' })}\n`);
        const nativeHistoryConfig = {
            source: {
                kind: 'jsonl',
                path: transcriptPath,
                session_id_from: 'filename_uuid',
                message_map: { role: '$.role', content: '$.content' },
            },
        } as const;

        let collectorCalls = 0;
        let latestContents: string[] = [];
        const service = configureTranscriptProjection({
            daemonId: () => 'daemon-1',
            writerId: () => 'writer-1',
            publishRevision: async () => {},
            collectObservation: async () => {
                collectorCalls += 1;
                const result = executeNativeHistory(nativeHistoryConfig as any, {
                    agentType: 'test-cli',
                    providerSessionId: sessionId,
                });
                latestContents = result?.messages.map(message => message.content) ?? [];
                return null;
            },
        });
        const registry = makeRegistry();

        const outputEvents = 20;
        for (let i = 0; i < outputEvents; i += 1) {
            registry.markChatOutputActivity('sess-1');
            // PTY data arrives in separate event-loop turns in production; let
            // the current pull settle before delivering the next chunk.
            await flushProjection();
        }

        // Keep the leading pull immediate, then retain one trailing pull for a
        // transcript append that may land after the first PTY byte.
        expect(collectorCalls).toBe(1);
        expect(__getParsedJsonlCacheStatsForTests()).toMatchObject({ fileReads: 1, parsePasses: 1 });
        expect(service?.getCounters().ptyDirtyCoalesced).toBe(outputEvents - 1);
        vi.advanceTimersByTime(TRANSCRIPT_PTY_DIRTY_THROTTLE_MS);
        await flushProjection();
        expect(collectorCalls).toBe(2);
        expect(__getParsedJsonlCacheStatsForTests()).toMatchObject({ hits: 1, fileReads: 1, parsePasses: 1 });

        // A later append is not hidden: the next throttled refresh reparses the
        // changed file and sees both records.
        fs.appendFileSync(transcriptPath, `${JSON.stringify({ role: 'assistant', content: 'second' })}\n`);
        registry.markChatOutputActivity('sess-1');
        await flushProjection();
        expect(collectorCalls).toBe(2);
        vi.advanceTimersByTime(TRANSCRIPT_PTY_DIRTY_THROTTLE_MS);
        await flushProjection();
        expect(collectorCalls).toBe(3);
        expect(__getParsedJsonlCacheStatsForTests()).toMatchObject({ fileReads: 2, parsePasses: 2 });
        expect(latestContents).toEqual(['first', 'second']);

        // Status/finalization/approval hooks call the direct API and bypass the
        // PTY throttle, even while its cooldown timer is armed.
        markTranscriptSessionDirty('sess-1');
        await flushProjection();
        expect(collectorCalls).toBe(4);
        expect(__getParsedJsonlCacheStatsForTests()).toMatchObject({ hits: 2, fileReads: 2, parsePasses: 2 });
    });
});
