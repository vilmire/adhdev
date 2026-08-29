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
});
