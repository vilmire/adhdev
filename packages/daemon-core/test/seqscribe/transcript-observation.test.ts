import { describe, expect, it } from 'vitest';
import {
    hashTranscriptObservation,
    isEmptyTranscriptObservation,
    stampTranscriptObservation,
    type TranscriptObservation,
} from '../../src/seqscribe/transcript-observation.js';
import { encodeTranscriptSnapshot } from '../../src/seqscribe/transcript-projection.js';

function observation(overrides: Partial<TranscriptObservation> = {}): TranscriptObservation {
    return {
        sessionId: 'sess-1',
        providerType: 'claude-code',
        status: 'idle',
        messages: [{ role: 'assistant', kind: 'standard', content: 'hello' }],
        coverage: { mode: 'full', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
        ...overrides,
    };
}

describe('hashTranscriptObservation — dedup hash excludes identity/revision/observedAt (design §3.4)', () => {
    it('is stable across different producer identity/revision/observedAt for identical content', () => {
        const obs = observation();
        const identityA = { sessionId: 'sess-1', producerDaemonId: 'daemon-a', producerWriterId: 'writer-a', producerEpoch: 'epoch-1', revision: 1 };
        const identityB = { sessionId: 'sess-1', producerDaemonId: 'daemon-b', producerWriterId: 'writer-b', producerEpoch: 'epoch-2', revision: 42 };

        const candidateA = stampTranscriptObservation(obs, identityA, '2026-08-29T00:00:00.000Z');
        const candidateB = stampTranscriptObservation(obs, identityB, '2026-08-29T01:00:00.000Z');

        // The two STAMPED candidates legitimately differ (different revision
        // numbers, different observedAt) — that is expected and is what
        // encodeTranscriptSnapshot below will encode. What must NOT differ is
        // the dedup hash computed over the observation alone.
        expect(encodeTranscriptSnapshot(candidateA).revision).not.toBe(encodeTranscriptSnapshot(candidateB).revision);
        expect(hashTranscriptObservation(obs)).toBe(hashTranscriptObservation(obs));
    });

    it('changes when message content changes', () => {
        const a = observation();
        const b = observation({ messages: [{ role: 'assistant', kind: 'standard', content: 'goodbye' }] });
        expect(hashTranscriptObservation(a)).not.toBe(hashTranscriptObservation(b));
    });

    it('changes when status changes', () => {
        const a = observation({ status: 'idle' });
        const b = observation({ status: 'generating' });
        expect(hashTranscriptObservation(a)).not.toBe(hashTranscriptObservation(b));
    });
});

describe('stampTranscriptObservation', () => {
    it('merges observation + identity + observedAt into an encodable candidate', () => {
        const identity = { sessionId: 'sess-1', producerDaemonId: 'daemon-a', producerWriterId: 'writer-a', producerEpoch: 'epoch-1', revision: 3 };
        const candidate = stampTranscriptObservation(observation(), identity, '2026-08-29T00:00:00.000Z');
        const snapshot = encodeTranscriptSnapshot(candidate);
        expect(snapshot.sessionId).toBe('sess-1');
        expect(snapshot.producerDaemonId).toBe('daemon-a');
        expect(snapshot.revision).toBe(3);
        expect(snapshot.observedAt).toBe('2026-08-29T00:00:00.000Z');
        expect(snapshot.messages).toEqual([{
            role: 'assistant',
            kind: 'standard',
            content: 'hello',
            receivedAt: null,
            timestamp: null,
            turnKey: null,
            // Per-message ordinal; null = UNKNOWN (this fixture supplies none).
            sequence: null,
            bubbleState: null,
            senderName: null,
            toolName: null,
            streaming: null,
        }]);
    });
});

describe('isEmptyTranscriptObservation (design §3.4 empty-guard)', () => {
    it('true for no messages and no modal/prompt/title', () => {
        expect(isEmptyTranscriptObservation(observation({ messages: [] }))).toBe(true);
    });

    it('false when messages are present', () => {
        expect(isEmptyTranscriptObservation(observation())).toBe(false);
    });

    it('false when a modal is staged even with no messages', () => {
        expect(
            isEmptyTranscriptObservation(
                observation({ messages: [], activeModal: { message: 'approve?', buttons: ['yes', 'no'] } }),
            ),
        ).toBe(false);
    });
});
