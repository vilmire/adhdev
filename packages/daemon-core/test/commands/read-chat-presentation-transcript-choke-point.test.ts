import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * §8 unit 2 — asserts the choke point (design §5.2) is actually wired into
 * `buildReadChatCommandResult`'s real code path, not merely that the helper
 * function compiles in isolation. Revert the `notifyTranscriptObservation`
 * call in read-chat-presentation.ts and this test goes red — that is the
 * fixture-enters-the-real-path evidence the task requires.
 */
const notifyTranscriptObservation = vi.fn();
vi.mock('../../src/seqscribe/transcript-publisher.js', () => ({
    notifyTranscriptObservation,
}));

describe('buildReadChatCommandResult — transcript observation choke point (design §5.2)', () => {
    beforeEach(() => {
        notifyTranscriptObservation.mockClear();
    });

    it('notifies the transcript publisher with the FULL message set, before tail slicing', async () => {
        const { buildReadChatCommandResult } = await import('../../src/commands/read-chat-presentation.js');
        const messages = Array.from({ length: 10 }, (_, i) => ({
            role: 'assistant',
            kind: 'standard',
            content: `msg-${i}`,
        }));
        const payload = { status: 'idle', messages };
        const args = { sessionId: 'sess-choke-1', cliType: 'claude-code', tailLimit: 3 };

        const result = buildReadChatCommandResult(payload, args);

        expect(result.success).toBe(true);
        // The RETURNED messages respect the request's tailLimit...
        expect((result as any).messages).toHaveLength(3);
        // ...but the transcript observation the choke point built carries the
        // FULL untailed set, per design §5.2 ("tail slicing 전에").
        expect(notifyTranscriptObservation).toHaveBeenCalledTimes(1);
        const [sessionId, observation] = notifyTranscriptObservation.mock.calls[0]!;
        expect(sessionId).toBe('sess-choke-1');
        expect(observation.messages).toHaveLength(10);
        expect(observation.coverage.mode).toBe('full');
    });

    it('never breaks read_chat even if the observation builder throws', async () => {
        notifyTranscriptObservation.mockImplementationOnce(() => {
            throw new Error('publisher blew up');
        });
        const { buildReadChatCommandResult } = await import('../../src/commands/read-chat-presentation.js');
        const payload = { status: 'idle', messages: [{ role: 'assistant', kind: 'standard', content: 'hi' }] };
        const args = { sessionId: 'sess-choke-2', cliType: 'claude-code' };

        const result = buildReadChatCommandResult(payload, args);
        expect(result.success).toBe(true);
    });

    it('does not notify when there is no resolvable session id', async () => {
        const { buildReadChatCommandResult } = await import('../../src/commands/read-chat-presentation.js');
        const payload = { status: 'idle', messages: [] };
        const result = buildReadChatCommandResult(payload, {});
        expect(result.success).toBe(true);
        expect(notifyTranscriptObservation).not.toHaveBeenCalled();
    });

    /**
     * Regression: the transcript projection's own collector
     * (boot/daemon-lifecycle.ts) re-enters read_chat with ONLY
     * `{ targetSessionId }` — no cliType/providerType/agentType. When the
     * provider hint was resolved from `args` alone, providerType came out `''`,
     * `buildTranscriptObservationFromReadChat` returned null, and the choke
     * point published nothing — silently, because it is fire-and-forget.
     *
     * Live symptom this reproduces: a native-history session (PTY bubbles
     * suppressed as a content source, so the internal pull is the ONLY thing
     * feeding the replica lane) streamed ~19 assistant messages and published
     * zero transcript revisions.
     *
     * Revert `resolveReadChatProviderHint` in read-chat-presentation.ts back to
     * the args-only form and every case below goes red.
     */
    describe('provider hint resolution for callers that pass only a session id', () => {
        const messages = [{ role: 'assistant', kind: 'standard', content: 'mid-turn text' }];

        it('notifies using the payload-resolved provider (internal collector arg shape)', async () => {
            const { buildReadChatCommandResult } = await import('../../src/commands/read-chat-presentation.js');
            const payload = {
                status: 'generating',
                messages,
                debugReadChat: { provider: 'claude-cli' },
            };

            const result = buildReadChatCommandResult(payload, { targetSessionId: 'sess-native-1' });

            expect(result.success).toBe(true);
            expect(notifyTranscriptObservation).toHaveBeenCalledTimes(1);
            const [sessionId, observation] = notifyTranscriptObservation.mock.calls[0]!;
            expect(sessionId).toBe('sess-native-1');
            expect(observation.providerType).toBe('claude-cli');
            expect(observation.messages).toHaveLength(1);
        });

        it('falls back to the session registry when the payload carries no provider', async () => {
            const { buildReadChatCommandResult } = await import('../../src/commands/read-chat-presentation.js');
            const helpers = {
                ctx: { sessionRegistry: { get: (id: string) => (id === 'sess-native-2' ? { providerType: 'claude-cli' } : undefined) } },
            } as any;

            const result = buildReadChatCommandResult({ status: 'generating', messages }, { targetSessionId: 'sess-native-2' }, helpers);

            expect(result.success).toBe(true);
            expect(notifyTranscriptObservation).toHaveBeenCalledTimes(1);
            expect(notifyTranscriptObservation.mock.calls[0]![1].providerType).toBe('claude-cli');
        });

        it('falls back to the current session when neither payload nor registry resolves', async () => {
            const { buildReadChatCommandResult } = await import('../../src/commands/read-chat-presentation.js');
            const helpers = { currentSession: { providerType: 'claude-cli' } } as any;

            const result = buildReadChatCommandResult({ status: 'generating', messages }, { targetSessionId: 'sess-native-3' }, helpers);

            expect(result.success).toBe(true);
            expect(notifyTranscriptObservation).toHaveBeenCalledTimes(1);
            expect(notifyTranscriptObservation.mock.calls[0]![1].providerType).toBe('claude-cli');
        });

        it('still lets an explicit arg win over the payload', async () => {
            const { buildReadChatCommandResult } = await import('../../src/commands/read-chat-presentation.js');
            const payload = { status: 'idle', messages, debugReadChat: { provider: 'claude-cli' } };

            buildReadChatCommandResult(payload, { targetSessionId: 'sess-native-4', agentType: 'codex-cli' });

            expect(notifyTranscriptObservation.mock.calls[0]![1].providerType).toBe('codex-cli');
        });
    });
});
