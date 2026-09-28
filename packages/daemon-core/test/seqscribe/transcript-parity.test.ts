import { beforeEach, describe, expect, it } from 'vitest';
import {
    __resetTranscriptParityForTests,
    compareTranscriptChat,
    redactSessionId,
    transcriptParityCounters,
    type TranscriptChatParityExpected,
    type TranscriptParityActual,
} from '../../src/seqscribe/transcript-parity.js';
import { KeyedTranscriptFolder } from '../../src/seqscribe/transcript-keyed-folder.js';
import { FrameDriver, SESSION, observation, ordOf } from './keyed-chat-fixtures.js';

/**
 * Keyed chat parity (design 2026-09-28 §5.5): the frame a publisher built from
 * the legacy read_chat observation vs the same commit folded back from the
 * topic. Built from REAL frames and a REAL folder, so the comparison covers
 * the encode → append-shape → fold round trip, not two hand-made objects.
 */

function roundTrip(texts: string[]): { expected: TranscriptChatParityExpected; actual: TranscriptParityActual } {
    const driver = new FrameDriver();
    const folder = new KeyedTranscriptFolder({ expectedSessionId: SESSION });
    const frame = driver.step(observation(texts.map((text, i) => ({ id: `d.p.${i + 1}`, ord: ordOf(i), text }))))!;
    folder.ingestRows(driver.rowsOf(frame));
    return {
        expected: {
            sessionId: SESSION,
            producerDaemonId: frame.commit.producerDaemonId,
            live: frame.live,
            digest: frame.commit.digest,
            messages: frame.expectedMessages(),
        },
        actual: { status: 'found', view: folder.view()!, commit: folder.lastCommit()! },
    };
}

describe('compareTranscriptChat', () => {
    beforeEach(() => __resetTranscriptParityForTests());

    it('a frame and its fold-back compare clean', () => {
        const { expected, actual } = roundTrip(['a', 'b', 'c']);
        expect(compareTranscriptChat('d:s', expected, actual)).toEqual([]);
        expect(transcriptParityCounters()).toMatchObject({ compared: 1, mismatches: 0, persistentMismatches: 0 });
    });

    it('missing commit gets a one-sweep grace, then persists on recurrence', () => {
        const { expected } = roundTrip(['a']);
        expect(compareTranscriptChat('d:s', expected, { status: 'missing' })[0]!.kind).toBe('missing_complete_revision');
        expect(transcriptParityCounters().persistentMismatches).toBe(0);
        compareTranscriptChat('d:s', expected, { status: 'missing' });
        expect(transcriptParityCounters()).toMatchObject({ persistentMismatches: 1, sessionsRepeated: 1, pendingMissingRevisits: 1 });
    });

    it('a bubble missing from the read-back is missing_message; an unexpected one is extra_message', () => {
        const { expected, actual } = roundTrip(['a', 'b']);
        const live = new Map(expected.live);
        live.set('d.p.99', 1);
        expect(compareTranscriptChat('d:s', { ...expected, live }, actual).map((m) => m.kind)).toEqual(['missing_message']);
        live.delete('d.p.99');
        live.delete('d.p.2');
        expect(compareTranscriptChat('d:s', { ...expected, live }, actual).map((m) => m.kind)).toEqual(['extra_message']);
    });

    it('an older rev in storage than the frame committed is rev_regression', () => {
        const { expected, actual } = roundTrip(['a']);
        const live = new Map([['d.p.1', 5]]);
        expect(compareTranscriptChat('d:s', { ...expected, live }, actual).map((m) => m.kind)).toEqual(['rev_regression']);
    });

    it('field differences report field NAMES only, never values', () => {
        const { expected, actual } = roundTrip(['secret body']);
        const messages = expected.messages.map((m) => ({ ...m, content: 'other body', bubbleState: 'streaming' as const }));
        const [mismatch] = compareTranscriptChat('d:s', { ...expected, messages }, actual);
        expect(mismatch).toMatchObject({ kind: 'field_mismatch', fields: ['bubbleState', 'content'] });
        expect(JSON.stringify(mismatch)).not.toContain('secret');
    });

    it('a digest the commit does not carry is digest_mismatch', () => {
        const { expected, actual } = roundTrip(['a']);
        expect(compareTranscriptChat('d:s', { ...expected, digest: '0'.repeat(64) }, actual).map((m) => m.kind)).toEqual(['digest_mismatch']);
    });

    it('wrong session / wrong owner', () => {
        const { expected, actual } = roundTrip(['a']);
        expect(compareTranscriptChat('d:s', { ...expected, sessionId: 'other' }, actual)[0]!.kind).toBe('wrong_session');
        expect(compareTranscriptChat('d:s', { ...expected, producerDaemonId: 'daemon_mach_elsewhere' }, actual)[0]!.kind).toBe('wrong_owner');
    });

    it('redactSessionId truncates long ids', () => {
        expect(redactSessionId('short')).toBe('short');
        expect(redactSessionId('0123456789abcdef')).toBe('01234567…(16)');
    });
});
