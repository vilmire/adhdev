import { beforeEach, describe, expect, it } from 'vitest';
import {
    __resetTranscriptParityForTests,
    compareTranscriptRevision,
    redactSessionId,
    transcriptParityCounters,
} from '../../src/seqscribe/transcript-parity.js';
import { encodeTranscriptSnapshot, type TranscriptSnapshotCandidate } from '../../src/seqscribe/transcript-projection.js';

function candidate(overrides: Partial<TranscriptSnapshotCandidate> = {}): TranscriptSnapshotCandidate {
    return {
        sessionId: 'sess-1',
        providerType: 'claude-code',
        producerDaemonId: 'daemon-a',
        producerWriterId: 'writer-a',
        producerEpoch: 'epoch-1',
        revision: 1,
        observedAt: '2026-08-29T00:00:00.000Z',
        status: 'idle',
        messages: [{ role: 'assistant', kind: 'standard', content: 'hello' }],
        coverage: { mode: 'full', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
        ...overrides,
    };
}

describe('compareTranscriptRevision (design §5.3/§5.4)', () => {
    beforeEach(() => {
        __resetTranscriptParityForTests();
    });

    it('identical expected/actual compares clean', () => {
        const snap = encodeTranscriptSnapshot(candidate());
        const mismatches = compareTranscriptRevision('daemon-a:sess-1', snap, { status: 'found', snapshot: snap });
        expect(mismatches).toEqual([]);
        expect(transcriptParityCounters().mismatches).toBe(0);
        expect(transcriptParityCounters().compared).toBe(1);
    });

    it('missing_complete_revision gets a one-sweep grace, then persists on recurrence (§5.4)', () => {
        const expected = encodeTranscriptSnapshot(candidate());
        const key = 'daemon-a:sess-1';

        const first = compareTranscriptRevision(key, expected, { status: 'missing' });
        expect(first).toEqual([{ kind: 'missing_complete_revision', session: redactSessionId(key) }]);
        expect(transcriptParityCounters().persistentMismatches).toBe(0); // grace: not yet persistent

        const second = compareTranscriptRevision(key, expected, { status: 'missing' });
        expect(second[0]?.kind).toBe('missing_complete_revision');
        expect(transcriptParityCounters().persistentMismatches).toBe(1); // recurrence -> real failure
    });

    it('missing followed by a complete revision clears the pending grace (no false persistence)', () => {
        const expected = encodeTranscriptSnapshot(candidate());
        const key = 'daemon-a:sess-1';

        compareTranscriptRevision(key, expected, { status: 'missing' });
        compareTranscriptRevision(key, expected, { status: 'found', snapshot: expected });
        expect(transcriptParityCounters().persistentMismatches).toBe(0);

        // A LATER miss is a fresh occurrence, not a recurrence of the repaired one.
        compareTranscriptRevision(key, expected, { status: 'missing' });
        expect(transcriptParityCounters().persistentMismatches).toBe(0);
    });

    it('wrong_session counts as persistent immediately, on first observation', () => {
        const expected = encodeTranscriptSnapshot(candidate({ sessionId: 'sess-1' }));
        const actual = encodeTranscriptSnapshot(candidate({ sessionId: 'sess-OTHER' }));
        const mismatches = compareTranscriptRevision('daemon-a:sess-1', expected, { status: 'found', snapshot: actual });
        expect(mismatches[0]?.kind).toBe('wrong_session');
        expect(transcriptParityCounters().persistentMismatches).toBe(1);
    });

    it('wrong_owner tolerates daemonIdsEquivalent variance but rejects a real mismatch', () => {
        const expected = encodeTranscriptSnapshot(candidate({ producerDaemonId: 'mach_abc' }));
        // Same underlying machine under a different-but-equivalent form must NOT
        // be flagged — that is exactly what daemonIdsEquivalent is for.
        const equivalentActual = encodeTranscriptSnapshot(candidate({ producerDaemonId: 'daemon_mach_abc' }));
        expect(compareTranscriptRevision('k1', expected, { status: 'found', snapshot: equivalentActual })).toEqual([]);

        const wrongActual = encodeTranscriptSnapshot(candidate({ producerDaemonId: 'mach_zzz' }));
        const mismatches = compareTranscriptRevision('k2', expected, { status: 'found', snapshot: wrongActual });
        expect(mismatches[0]?.kind).toBe('wrong_owner');
    });

    it('field_mismatch reports the differing field names, never values (§6.1)', () => {
        const expected = encodeTranscriptSnapshot(candidate({ status: 'idle' }));
        const actual = encodeTranscriptSnapshot(candidate({ status: 'generating' }));
        const mismatches = compareTranscriptRevision('k', expected, { status: 'found', snapshot: actual });
        expect(mismatches[0]?.kind).toBe('field_mismatch');
        expect(mismatches[0]?.fields).toContain('status');
        // Never a value — the mismatch record has no field carrying 'idle'/'generating'.
        expect(JSON.stringify(mismatches[0])).not.toContain('generating');
    });

    it('extra_message counts as persistent immediately on message-count divergence', () => {
        const expected = encodeTranscriptSnapshot(candidate());
        const actual = encodeTranscriptSnapshot(
            candidate({
                messages: [
                    { role: 'assistant', kind: 'standard', content: 'hello' },
                    { role: 'assistant', kind: 'standard', content: 'extra' },
                ],
            }),
        );
        const mismatches = compareTranscriptRevision('k', expected, { status: 'found', snapshot: actual });
        expect(mismatches[0]?.kind).toBe('extra_message');
        expect(transcriptParityCounters().persistentMismatches).toBe(1);
    });

    it('digest_mismatch catches a divergence outside the explicitly-diffed fields', () => {
        const expected = encodeTranscriptSnapshot(candidate({ historySessionId: 'hist-a' }));
        const actual = encodeTranscriptSnapshot(candidate({ historySessionId: 'hist-b' }));
        const mismatches = compareTranscriptRevision('k', expected, { status: 'found', snapshot: actual });
        expect(mismatches[0]?.kind).toBe('digest_mismatch');
        expect(transcriptParityCounters().persistentMismatches).toBe(1);
    });

    it('never throws on malformed input', () => {
        const expected = encodeTranscriptSnapshot(candidate());
        expect(() => compareTranscriptRevision('', expected, { status: 'missing' })).not.toThrow();
    });
});

describe('redactSessionId', () => {
    it('truncates long ids and passes short ones through', () => {
        expect(redactSessionId('abc')).toBe('abc');
        expect(redactSessionId('daemon-a:sess-12345678')).toBe('daemon-a…(22)');
    });
});
