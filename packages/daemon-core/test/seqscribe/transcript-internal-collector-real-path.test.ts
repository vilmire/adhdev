import { afterEach, describe, expect, it } from 'vitest';
import {
    configureTranscriptProjection,
    __resetTranscriptProjectionForTests,
} from '../../src/seqscribe/transcript-publisher.js';
import { buildReadChatCommandResult } from '../../src/commands/read-chat-presentation.js';

/**
 * REAL-PATH regression for the replica lane's streaming refresh.
 *
 * Nothing here is stubbed on the path under test: a real
 * `TranscriptProjectionService` is configured, its `collectObservation` is the
 * genuine "re-enter read_chat and let the choke point push" shape used by
 * `boot/daemon-lifecycle.ts`, and the assertion is that a revision is actually
 * published — not merely that some inner function was called.
 *
 * The defect this pins: the internal collector re-enters `read_chat` with ONLY
 * `{ targetSessionId }`. When `buildReadChatCommandResult` resolved the
 * provider hint from `args` alone, providerType came out `''`,
 * `buildTranscriptObservationFromReadChat` returned null, and the choke point
 * pushed nothing. `runPull` then found `collected === null` (by design — the
 * collector returns null and relies on the nested push), bumped only
 * `sourcePending`, and settled. No publish, no revision, and no log line.
 *
 * Live symptom: a claude-cli session on `native-history` — where PTY bubbles
 * are suppressed as a *content* source, so this internal pull is the only
 * thing feeding the lane — streamed assistant text while publishing zero
 * revisions. The dashboard passes `agentType`, which is why external reads
 * masked it.
 *
 * Injection check: revert `resolveReadChatProviderHint` in
 * read-chat-presentation.ts to the args-only form and the first test goes red
 * with zero published revisions.
 */

interface Published {
    sessionId: string;
    revision: number;
}

function setup(readChatMessages: () => Array<Record<string, unknown>>) {
    const published: Published[] = [];
    const service = configureTranscriptProjection({
        daemonId: () => 'daemon_test',
        writerId: () => 'writer_test',
        epoch: 'epoch_test',
        // The genuine collector shape: re-enter read_chat, return null, and
        // rely on the choke point's nested push.
        collectObservation: async (sessionId: string) => {
            buildReadChatCommandResult(
                {
                    status: 'generating',
                    messages: readChatMessages(),
                    // What a real cli-like read emits — the resolved adapter type.
                    debugReadChat: { provider: 'claude-cli' },
                    messageSource: {
                        selected: 'native-history',
                        coverage: { ptyMessagesSuppressed: true },
                    },
                },
                { targetSessionId: sessionId },
            );
            return null;
        },
        publishRevision: async (sessionId, encoded) => {
            published.push({ sessionId, revision: encoded.begin.revision });
        },
    } as any);
    return { service: service!, published };
}

afterEach(() => {
    __resetTranscriptProjectionForTests();
});

const msg = (text: string) => ({ role: 'assistant', kind: 'standard', content: text });

async function settle() {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

describe('native-history session — internal collector publishes transcript revisions (real path)', () => {
    it('publishes a revision when a PTY-triggered pull re-enters read_chat with only a session id', async () => {
        const { service, published } = setup(() => [msg('mid-turn 1')]);

        service.markDirty('sess-native-real', 'pty_output');
        await settle();

        expect(published).toHaveLength(1);
        expect(published[0]!.sessionId).toBe('sess-native-real');
        expect(published[0]!.revision).toBe(1);
        expect(service.getCounters().published).toBe(1);
    });

    it('keeps publishing as intermediate assistant messages accumulate mid-turn', async () => {
        const messages = [msg('mid-turn 1')];
        const { service, published } = setup(() => messages.slice());

        service.markDirty('sess-native-growth', 'pty_output');
        await settle();
        messages.push(msg('mid-turn 2'));
        service.markDirty('sess-native-growth', 'pty_output');
        await settle();
        messages.push(msg('mid-turn 3'));
        service.markDirty('sess-native-growth', 'pty_output');
        await settle();

        expect(published.map((p) => p.revision)).toEqual([1, 2, 3]);
    });

    it('content dedup still absorbs a no-change re-read (no revision inflation)', async () => {
        const { service, published } = setup(() => [msg('unchanged')]);

        service.markDirty('sess-native-dedup', 'pty_output');
        await settle();
        expect(published).toHaveLength(1);

        for (let i = 0; i < 5; i++) {
            service.markDirty('sess-native-dedup', 'pty_output');
            await settle();
        }

        expect(published).toHaveLength(1);
        expect(service.getCounters().deduped).toBe(5);
    });
});
