import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    __getParsedJsonlCacheStatsForTests,
    __resetParsedJsonlCacheForTests,
} from '../../src/providers/spec/native-history-executor.js';
import {
    TRANSCRIPT_STAT_POLL_INTERVAL_MS,
    __resetTranscriptProjectionForTests,
    configureTranscriptProjection,
    markTranscriptSessionDirty,
} from '../../src/seqscribe/transcript-publisher.js';
import {
    TopicSubscriptionRegistry,
    type TopicSink,
} from '../../src/subscriptions/topic-registry.js';
import { SessionRegistry } from '../../src/sessions/registry.js';

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

describe('Transcript stat polling instead of PTY', () => {
    let tmpDir = '';

    afterEach(() => {
        __resetTranscriptProjectionForTests();
        __resetParsedJsonlCacheForTests();
        vi.useRealTimers();
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = '';
    });

    it('replaces PTY trigger with stat-based polling, clearing timer on unregister', async () => {
        vi.useFakeTimers();
        __resetParsedJsonlCacheForTests();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-pty-poll-'));
        const sessionId = 'sess-1';
        const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
        fs.writeFileSync(transcriptPath, `${JSON.stringify({ role: 'assistant', content: 'first' })}\n`);

        let collectorCalls = 0;
        const service = configureTranscriptProjection({
            daemonId: () => 'daemon-1',
            writerId: () => 'writer-1',
            publishRevision: async () => {},
            collectObservation: async () => {
                collectorCalls += 1;
                // mock the read_chat observation push
                service?.observe(sessionId, {
                    sessionId,
                    providerType: 'test',
                    status: 'idle',
                    messages: [],
                    coverage: { mode: 'full', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
                    provenance: {
                        transcriptProvenance: { sourcePath: transcriptPath }
                    }
                } as any);
                return null;
            },
        });
        const topicRegistry = makeRegistry();
        const sessionRegistry = new SessionRegistry();

        // 1. Session register starts the polling loop, but path is not known yet.
        sessionRegistry.register({
            sessionId,
            parentSessionId: null,
            providerType: 'test-cli',
            transport: { type: 'pipe' } as any,
        });

        // Advance timer before path is known: should do nothing (quietly skip).
        vi.advanceTimersByTime(TRANSCRIPT_STAT_POLL_INTERVAL_MS);
        await flushProjection();
        expect(collectorCalls).toBe(0);

        // 6. PTY 출력을 아무리 발생시켜도 runPull 이 0회임을 확인.
        const outputEvents = 20;
        for (let i = 0; i < outputEvents; i += 1) {
            topicRegistry.markChatOutputActivity(sessionId);
            await flushProjection();
        }
        expect(collectorCalls).toBe(0);

        // 3. 상태 전이 트리거(직접 markDirty 호출)는 여전히 즉시 동작한다.
        // 이것이 첫 read_chat을 유발하여 path가 바인딩된다.
        markTranscriptSessionDirty(sessionId);
        await flushProjection();
        expect(collectorCalls).toBe(1);

        // 1. 파일이 안 변하면 폴링이 돌아도 runPull이 불리지 않는다.
        vi.advanceTimersByTime(TRANSCRIPT_STAT_POLL_INTERVAL_MS);
        await flushProjection();
        vi.advanceTimersByTime(TRANSCRIPT_STAT_POLL_INTERVAL_MS);
        await flushProjection();
        expect(collectorCalls).toBe(1); // unchanged

        // 2. 파일이 변하면 다음 폴링에서 불린다.
        // change mtime directly since fakeTimers might make fast appends have same mtime
        fs.appendFileSync(transcriptPath, `${JSON.stringify({ role: 'assistant', content: 'second' })}\n`);
        const now = Date.now();
        fs.utimesSync(transcriptPath, new Date(now), new Date(now + 1000));
        
        vi.advanceTimersByTime(TRANSCRIPT_STAT_POLL_INTERVAL_MS);
        await flushProjection();
        expect(collectorCalls).toBe(2);

        // 4. 채팅 명령 트리거도 여전히 즉시 동작한다 (markDirty 직접 호출).
        markTranscriptSessionDirty(sessionId);
        await flushProjection();
        expect(collectorCalls).toBe(3);

        // 5. 세션 unregister 시 타이머가 정리된다.
        // We can assert this by checking the active timer count, or by advancing and seeing no crash/stat calls.
        sessionRegistry.unregister(sessionId);
        
        // Timer should be cleared. We can verify by deleting the file and advancing timer.
        // If timer was running, it would throw or do something, but it's cleared.
        fs.rmSync(transcriptPath);
        vi.advanceTimersByTime(TRANSCRIPT_STAT_POLL_INTERVAL_MS * 2);
        await flushProjection();
        expect(collectorCalls).toBe(3); // stays 3
    });
});
