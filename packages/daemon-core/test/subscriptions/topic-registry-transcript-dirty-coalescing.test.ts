import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __getParsedJsonlCacheStatsForTests, __resetParsedJsonlCacheForTests } from '../../src/providers/spec/native-history-jsonl-cache.js';
import {
    TRANSCRIPT_PTY_DIRTY_THROTTLE_MS,
    TRANSCRIPT_STAT_POLL_INTERVAL_MS,
    __resetTranscriptProjectionForTests,
    configureTranscriptProjection,
    markTranscriptPtyOutputActivity,
    markTranscriptSessionDirty,
    notifyTranscriptObservation,
} from '../../src/seqscribe/transcript-publisher.js';
import { buildTranscriptObservationFromReadChat } from '../../src/commands/transcript-observation-builder.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import { subscribeTranscriptProjection } from '../../src/seqscribe/transcript-bus-subscriber.js';

async function flushProjection(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
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
        // The seed pull and the throttled PTY pulls below read before the file
        // is known; the path is learned from the first observation after this flips.
        let learnPath = false;
        const service = configureTranscriptProjection({
            daemonId: () => 'daemon-1',
            writerId: () => 'writer-1',
            appendChatFrame: async () => {},
            // Production shape: the collector re-enters read_chat, whose choke
            // point pushes the observation NESTED while this pull is in flight,
            // carrying the file the read resolved in its provenance. That is the
            // only way the stat poll learns the path — there is no separate
            // resolver (a second one returned null for every native-reader
            // provider and left the poll dead: 2026-09-30 BATRP incident).
            collectObservation: async (s) => {
                collectorCalls += 1;
                if (s === sessionId && learnPath) {
                    const observation = buildTranscriptObservationFromReadChat({
                        sessionId,
                        providerType: 'test-cli',
                        status: 'idle',
                        providerObservedStatus: 'idle',
                        turn: null,
                        provenance: { transcriptProvenance: { sourcePath: transcriptPath } },
                        messages: [],
                        coverage: { mode: 'full', omittedBefore: false },
                    });
                    if (observation) notifyTranscriptObservation(sessionId, observation);
                }
                return null;
            },
        });
        // B4: stat polling starts/stops from the bus (`registered`/`terminated`), not from the registry.
        const bus = createSessionLifecycleBus({ log: () => {} });
        const sessionRegistry = new SessionRegistry(bus);
        subscribeTranscriptProjection(bus, service);

        // 1. Session register starts the polling loop, but path is not known yet.
        sessionRegistry.register({
            sessionId,
            parentSessionId: null,
            providerType: 'test-cli',
            transport: { type: 'pipe' } as any,
        });

        // Registration warms the session once (first paint: define its chat
        // topic + one seed pull — `warmSession`); that is the only pull here.
        vi.advanceTimersByTime(0);
        await flushProjection();
        expect(collectorCalls).toBe(1);
        collectorCalls = 0;

        // Advance timer before path is known: should do nothing (quietly skip).
        vi.advanceTimersByTime(TRANSCRIPT_STAT_POLL_INTERVAL_MS);
        await flushProjection();
        expect(collectorCalls).toBe(0);

        // 6. PTY output drives the dirty trigger (the chat lane's only
        // streaming-rate trigger), but THROTTLED: a
        // burst inside one window collapses to the leading pull plus one
        // trailing pull. Not 20 — a raw pull per chunk re-encodes the whole
        // snapshot each time. See topic-registry-transcript-pty-dirty-trigger.ts.
        const outputEvents = 20;
        for (let i = 0; i < outputEvents; i += 1) {
            markTranscriptPtyOutputActivity(sessionId);
            await flushProjection();
        }
        expect(collectorCalls).toBe(1); // leading edge only, window still open

        vi.advanceTimersByTime(TRANSCRIPT_PTY_DIRTY_THROTTLE_MS);
        await flushProjection();
        expect(collectorCalls).toBe(2); // + the mandatory trailing pull

        // Window drains: no further pulls without new output.
        vi.advanceTimersByTime(TRANSCRIPT_PTY_DIRTY_THROTTLE_MS * 3);
        await flushProjection();
        expect(collectorCalls).toBe(2);
        collectorCalls = 0;

        // A read learns the path (nested observation during an in-flight pull).
        learnPath = true;
        markTranscriptSessionDirty(sessionId);
        await flushProjection();
        expect(collectorCalls).toBe(1);
        collectorCalls = 0;

        // 1. 파일이 안 변하면 폴링이 돌아도 runPull이 불리지 않는다(첫 틱은 기준선).
        vi.advanceTimersByTime(TRANSCRIPT_STAT_POLL_INTERVAL_MS);
        await flushProjection();
        vi.advanceTimersByTime(TRANSCRIPT_STAT_POLL_INTERVAL_MS);
        await flushProjection();
        expect(collectorCalls).toBe(0); // unchanged

        // 2. 파일이 변하면 다음 폴링에서 불린다.
        // change mtime directly since fakeTimers might make fast appends have same mtime
        fs.appendFileSync(transcriptPath, `${JSON.stringify({ role: 'assistant', content: 'second' })}\n`);
        
        vi.advanceTimersByTime(TRANSCRIPT_STAT_POLL_INTERVAL_MS);
        await flushProjection();
        expect(collectorCalls).toBe(1);

        // 4. 채팅 명령 트리거도 여전히 즉시 동작한다 (markDirty 직접 호출).
        markTranscriptSessionDirty(sessionId);
        await flushProjection();
        expect(collectorCalls).toBe(2);

        // 5. 세션 unregister 시 타이머가 정리된다.
        // We can assert this by checking the active timer count, or by advancing and seeing no crash/stat calls.
        sessionRegistry.terminate(sessionId, 'stop_requested');
        
        // Timer should be cleared. We can verify by deleting the file and advancing timer.
        // If timer was running, it would throw or do something, but it's cleared.
        fs.rmSync(transcriptPath);
        vi.advanceTimersByTime(TRANSCRIPT_STAT_POLL_INTERVAL_MS * 2);
        await flushProjection();
        expect(collectorCalls).toBe(2); // stays 2
    });
});
