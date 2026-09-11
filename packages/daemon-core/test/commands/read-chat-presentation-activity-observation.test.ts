import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Activity supply wiring — the transcript OBSERVATION is caller-independent.
 *
 * Regression class: the dashboard activity toggle rendered nothing because
 * every supply lane filtered tool/terminal/thought rows out before they
 * reached the browser. The replica lane's root cause was that the observation
 * was built from the post-filter `visibleMessages`, so its content depended on
 * WHICH caller issued the read (`includeActivity` vs not) — both a revision-
 * churn bug (same transcript, two contents on the same topic) and a data gap
 * (web panes never saw activity rows over the replica).
 *
 * These tests pin the new contract:
 *   1. The read RESULT keeps read_chat's default (prose-only) — the default
 *      behavior of `filterUserFacingChatMessages` consumers is unchanged.
 *   2. The OBSERVATION always carries user-facing + activity rows, whether or
 *      not the caller passed `includeActivity`.
 *   3. Only wire-safe activity kinds (tool/terminal/thought) ride the
 *      observation — rows classified activity solely via meta/source markers
 *      lose those markers on the wire allow-list and would render as prose,
 *      so they stay excluded.
 */
const notifyTranscriptObservation = vi.fn();
vi.mock('../../src/seqscribe/transcript-publisher.js', () => ({
    notifyTranscriptObservation,
}));

const PROSE_AND_ACTIVITY_MESSAGES = [
    { role: 'user', kind: 'standard', content: 'do the thing' },
    { role: 'assistant', kind: 'tool', content: 'Read(file.ts)', senderName: 'Tool' },
    { role: 'assistant', kind: 'thought', content: 'planning…' },
    { role: 'assistant', kind: 'terminal', content: '$ npm test' },
    { role: 'assistant', kind: 'standard', content: 'done' },
];

describe('buildReadChatCommandResult — caller-independent activity observation', () => {
    beforeEach(() => {
        notifyTranscriptObservation.mockClear();
    });

    it('keeps the prose-only default on the read result while the observation carries activity rows', async () => {
        const { buildReadChatCommandResult } = await import('../../src/commands/read-chat-presentation.js');
        const result = buildReadChatCommandResult(
            { status: 'idle', messages: PROSE_AND_ACTIVITY_MESSAGES },
            { sessionId: 'sess-act-1', cliType: 'claude-code' },
        );

        expect(result.success).toBe(true);
        // Default read result: prose only — unchanged consumer contract.
        expect((result as any).messages.map((m: any) => m.content)).toEqual(['do the thing', 'done']);
        // Observation: prose + activity, in order.
        const [, observation] = notifyTranscriptObservation.mock.calls[0]!;
        expect(observation.messages.map((m: any) => m.kind)).toEqual(['standard', 'tool', 'thought', 'terminal', 'standard']);
        expect(observation.coverage.returnedMessageCount).toBe(5);
        expect(observation.coverage.totalMessageCount).toBe(5);
    });

    it('produces the SAME observation content whether or not the caller passed includeActivity (revision consistency)', async () => {
        const { buildReadChatCommandResult } = await import('../../src/commands/read-chat-presentation.js');

        buildReadChatCommandResult(
            { status: 'idle', messages: PROSE_AND_ACTIVITY_MESSAGES },
            { sessionId: 'sess-act-2', cliType: 'claude-code' },
        );
        const withoutOptIn = notifyTranscriptObservation.mock.calls[0]![1];
        notifyTranscriptObservation.mockClear();

        const optInResult = buildReadChatCommandResult(
            { status: 'idle', messages: PROSE_AND_ACTIVITY_MESSAGES },
            { sessionId: 'sess-act-2', cliType: 'claude-code', includeActivity: true },
        );
        const withOptIn = notifyTranscriptObservation.mock.calls[0]![1];

        // The opt-in read result DOES include activity (existing contract)…
        expect((optInResult as any).messages).toHaveLength(5);
        // …and both observations are identical, so the publisher's content-hash
        // dedup sees one content per transcript state, never two alternating ones.
        expect(withOptIn.messages).toEqual(withoutOptIn.messages);
        expect(withOptIn.coverage).toEqual(withoutOptIn.coverage);
    });

    it('excludes meta/source-only activity rows from the observation (their markers do not survive the wire)', async () => {
        const { buildReadChatCommandResult } = await import('../../src/commands/read-chat-presentation.js');
        const messages = [
            { role: 'user', kind: 'standard', content: 'hi' },
            // Classified activity via source marker, but kind is 'standard' —
            // on the wire this row would be indistinguishable from prose.
            { role: 'assistant', kind: 'standard', content: 'tool payload', meta: { source: 'tool_call' } },
            { role: 'assistant', kind: 'tool', content: 'Read(x)', senderName: 'Tool' },
        ];

        const optInResult = buildReadChatCommandResult(
            { status: 'idle', messages },
            { sessionId: 'sess-act-3', cliType: 'claude-code', includeActivity: true },
        );

        // Direct opt-in read still returns it (meta survives the command result)…
        expect((optInResult as any).messages).toHaveLength(3);
        // …but the observation only carries the kind-marked activity row.
        const [, observation] = notifyTranscriptObservation.mock.calls[0]!;
        expect(observation.messages.map((m: any) => m.content)).toEqual(['hi', 'Read(x)']);
    });
});
